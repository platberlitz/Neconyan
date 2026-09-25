import path from 'node:path';
import { registerHandler } from '../jobs/runner.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { getExistingWorldInfoFilename, isValidWorldInfoData } from '../endpoints/worldinfo.js';
import { readAgentRecordLocked } from '../in-chat-agent-storage.js';
import { authoringEvidence, readAuthoringFileLocked } from '../authoring-store.js';
import { getTool, invokeTool, registerTool } from '../tools/registry.js';
import { readRoleplayFile, roleplayError, roleplayHash, roleplayLease, withRoleplayAccount } from '../roleplay-store.js';
import { canDeleteBook, canReadBook, canWriteBook } from '../../public/scripts/extensions/in-chat-agents/pathfinder/lorebook-policy.js';
import { admitNativeMediaJob, finishNativeMediaJob, withNativeMediaReceipt } from './media-jobs.js';
import { requireJobApproval } from './job-approvals.js';
import { publishNativeAuthoringFile } from './authoring-tool-effects.js';
import { assertRoleplaySourceLocked, readRoleplayEntityLocked } from './roleplay-source.js';
import { captureRoleplayAgents } from './roleplay-agents-source.js';
import { selectSavedRoleplayPersona } from './world-info.js';
import { capturePathfinderSource } from './world-info-pathfinder.js';
import { applyPathfinderBookAction, searchPathfinderBook } from './pathfinder-book-actions.js';

const MAX_BOOK_BYTES = 8 * 1024 * 1024;
const TOOL_NAMES = Object.freeze({
    Pathfinder_Search: 'pathfinder_search', Pathfinder_Remember: 'pathfinder_remember',
    Pathfinder_Update: 'pathfinder_update', Pathfinder_Forget: 'pathfinder_forget',
    Pathfinder_Summarize: 'pathfinder_summarize', Pathfinder_Reorganize: 'pathfinder_reorganize',
    Pathfinder_MergeSplit: 'pathfinder_merge_split',
});
const invalid = message => roleplayError('PATHFINDER_TOOL_SOURCE_CHANGED', message, 409);
const bookFile = (dirs, filename) => path.join(dirs.worlds ?? path.join(dirs.root, 'worlds'), filename);
const isOwner = agent => agent.category === 'tool' && (agent.sourceTemplateId === 'tpl-pathfinder'
    || ['Pawthfinder', 'Pathfinder'].includes(agent.name) || agent.tools?.some(tool => tool.name?.startsWith('Pathfinder_')));

function readSettingsLocked(lease, dirs) {
    const file = readRoleplayFile(path.join(dirs.root, 'settings.json'), 8 * 1024 * 1024);
    if (!file) throw invalid('The saved Pathfinder settings are missing.');
    let settings;
    try { settings = JSON.parse(file.bytes.toString('utf8')); } catch { throw invalid('The saved Pathfinder settings are unreadable.'); }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw invalid('The saved Pathfinder settings are invalid.');
    return { settings, evidence: authoringEvidence(file) };
}

function readableBook(lease, dirs, name, expected = null) {
    const filename = getExistingWorldInfoFilename(dirs, name);
    if (!filename || expected && filename !== expected.filename) throw invalid('The selected lorebook is unavailable.');
    const file = readAuthoringFileLocked(lease, bookFile(dirs, filename), MAX_BOOK_BYTES);
    if (!file) throw invalid('The selected lorebook is missing.');
    let book;
    try { book = JSON.parse(file.bytes.toString('utf8')); } catch { throw invalid('The selected lorebook is unreadable.'); }
    if (!isValidWorldInfoData(book)) throw invalid('The selected lorebook is invalid.');
    const evidence = authoringEvidence(file);
    if (expected && (roleplayHash(evidence) !== roleplayHash(expected.evidence) || roleplayHash(book) !== expected.bookHash)) {
        throw invalid('The selected lorebook changed before the tool action.');
    }
    return { filename, book, evidence, bookHash: roleplayHash(book) };
}

function ownerAndBooks(lease, dirs, source, avatar, settings) {
    const selected = captureRoleplayAgents(lease, settings, { group: Boolean(source.locator.group),
        characterAvatars: source.dependencies.filter(item => item.kind === 'character').map(item => item.locator.avatar) });
    const owners = (selected?.agents ?? []).map(reference => ({ reference, record: readAgentRecordLocked(lease, 'agent', reference.id)?.record }))
        .filter(item => isOwner(item.record)).sort((a, b) => a.reference.order - b.reference.order || a.reference.id.localeCompare(b.reference.id));
    if (!owners.length) throw invalid('No enabled Pathfinder tool Agent owns this action.');
    const { reference, record: agent } = owners[0];
    const saved = assertRoleplaySourceLocked(lease, source);
    const character = readRoleplayEntityLocked(lease, 'character', avatar).data;
    const group = source.locator.group ? readRoleplayEntityLocked(lease, 'group', source.groupId).data : null;
    const members = group ? group.members.map(member => ({ avatar: member,
        card: member === avatar ? character : readRoleplayEntityLocked(lease, 'character', member).data })) : [{ avatar, card: character }];
    const persona = selectSavedRoleplayPersona({ ...settings, ...settings.world_info_settings }, saved, source, avatar, dirs);
    const selection = capturePathfinderSource(dirs, { pathfinder: [{ id: reference.id, revision: reference.revision,
        physical: reference.physical }] }, { chatBook: saved.records[0].chat_metadata?.world_info,
        personaBook: persona.lorebook, members, charLore: settings.world_info_settings?.world_info?.charLore ?? [] });
    return { reference, agent, books: selection.books };
}

/** Read the selected owner using an already held account lease, without browser state. */
export function capturePathfinderToolOwnerLocked(lease, source, avatar) {
    const { scope } = roleplayLease(lease);
    const { settings, evidence } = readSettingsLocked(lease, scope.directories);
    const owner = ownerAndBooks(lease, scope.directories, source, avatar, settings);
    return { ...owner, settingsEvidence: evidence, settingsHash: roleplayHash(settings) };
}

function requiredPermission(name, args) {
    if (name === 'Pathfinder_Search') return 'read';
    if (name === 'Pathfinder_Forget' && (args.hard_delete === true || args.hard_delete === 1
        || typeof args.hard_delete === 'string' && /^(1|true|yes)$/i.test(args.hard_delete.trim()))
        || name === 'Pathfinder_MergeSplit' && args.action === 'merge') return 'delete';
    return 'write';
}

function actionName(name, args) {
    return name === 'Pathfinder_Reorganize' && args.action === 'create_waypoint' ? 'pathfinder_create_waypoint' : TOOL_NAMES[name];
}

/** Bind a specific, physically saved book, tool owner, permission and model-produced arguments before admission. */
export function capturePathfinderToolRequest(base, account, source, { avatar, agentId, name, args, callId } = {}) {
    if (!Object.hasOwn(TOOL_NAMES, name) || typeof agentId !== 'string' || !agentId
        || typeof avatar !== 'string' || !avatar || typeof callId !== 'string' || !callId || callId.length > 256
        || !args || typeof args !== 'object' || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > 1024 * 1024) {
        throw invalid('The Pathfinder tool request is incomplete.');
    }
    return withRoleplayAccount(base, account, lease => {
        const saved = assertRoleplaySourceLocked(lease, source);
        if (!source.dependencies?.some(item => item.kind === 'character' && item.locator.avatar === avatar) || !saved.records.length) {
            throw invalid('The tool Agent must belong to the accepted chat and character.');
        }
        const { settingsEvidence: evidence, settingsHash, reference, agent, books } = capturePathfinderToolOwnerLocked(lease, source, avatar);
        if (reference.id !== agentId) throw invalid('The selected Agent does not own Pathfinder tools.');
        if (!agent.settings?.sidecarEnabled && name !== 'Pathfinder_Summarize') throw invalid('This Pathfinder tool is not enabled.');
        const tool = agent.tools?.find(item => item.name === name);
        if (tool?.enabled === false || tool?.shouldRegister === false || agent.settings?.toolStates?.[name] === false) {
            throw invalid('The selected Pathfinder tool is disabled.');
        }
        const bookName = typeof args.book === 'string' && args.book.trim() ? args.book.trim()
            : books.find(book => requiredPermission(name, args) === 'read' ? canReadBook(book, agent.settings)
                : requiredPermission(name, args) === 'delete' ? canDeleteBook(book, agent.settings) && canWriteBook(book, agent.settings)
                    : canWriteBook(book, agent.settings));
        if (!bookName || !books.includes(bookName)) throw invalid('The selected lorebook is not available to this Agent.');
        const permission = requiredPermission(name, args);
        if (permission === 'read' ? !canReadBook(bookName, agent.settings)
            : permission === 'delete' ? !canDeleteBook(bookName, agent.settings) || !canWriteBook(bookName, agent.settings)
                : !canWriteBook(bookName, agent.settings)) throw invalid('The selected lorebook permission is unavailable.');
        const book = readableBook(lease, base.directories, bookName);
        if (name === 'Pathfinder_Search') {
            const result = searchPathfinderBook(bookName, book.book, book.bookHash, args.node_id ?? '');
            if (Buffer.byteLength(JSON.stringify({ status: 'done', callId, tool: name, result })) > 128 * 1024) {
                throw roleplayError('PATHFINDER_TOOL_CAPACITY', 'The complete search result exceeds its reserved durable result capacity.', 409);
            }
        }
        return { version: 1, avatar, agent: { id: reference.id, rawHash: reference.rawHash, physical: reference.physical,
            revision: reference.revision }, name, args: structuredClone(args), callId, bookName,
        book: { filename: book.filename, evidence: book.evidence, bookHash: book.bookHash },
        settingsEvidence: evidence, settingsHash, permission,
        confirm: agent.settings?.confirmTools?.[name] === true, agentSettingsHash: roleplayHash(agent.settings ?? {}) };
    });
}

export function admitPathfinderToolJob(base, account, { operationKey, source, request }) {
    if (request?.version !== 1 || !Object.hasOwn(TOOL_NAMES, request.name) || !request.bookName || !request.book) {
        throw invalid('The accepted Pathfinder request is incomplete.');
    }
    const approvalReservation = request.confirm && request.name !== 'Pathfinder_Search'
        ? { key: `pathfinder:${request.callId}`, bytes: Buffer.byteLength(JSON.stringify({ tool: request.name,
            arguments: request.args, book: request.bookName, before: request.book.evidence })) + 256 * 1024 } : null;
    return admitNativeMediaJob(base, account, { operationKey, source, kind: 'pathfinder-tool', request,
        target: { kind: 'lorebook', id: request.book.filename }, approvalReservation });
}

function currentToolSource(context, lease, request, { after = null } = {}) {
    const { directories } = context;
    const source = context.job.intent.source;
    assertRoleplaySourceLocked(lease, source);
    const { settings, evidence } = readSettingsLocked(lease, directories);
    if (roleplayHash(evidence) !== roleplayHash(request.settingsEvidence) || roleplayHash(settings) !== request.settingsHash) {
        throw invalid('The selected Pathfinder settings changed.');
    }
    const { reference, agent, books } = ownerAndBooks(lease, directories, source, request.avatar, settings);
    if (reference.id !== request.agent.id || roleplayHash({ id: reference.id, rawHash: reference.rawHash,
        physical: reference.physical, revision: reference.revision }) !== roleplayHash(request.agent)
        || roleplayHash(agent.settings ?? {}) !== request.agentSettingsHash || !books.includes(request.bookName)) {
        throw invalid('The Pathfinder tool Agent or selected lorebook changed.');
    }
    const permission = requiredPermission(request.name, request.args);
    const allowed = permission === 'read' ? canReadBook(request.bookName, agent.settings)
        : permission === 'delete' ? canWriteBook(request.bookName, agent.settings) && canDeleteBook(request.bookName, agent.settings)
            : canWriteBook(request.bookName, agent.settings);
    if (permission !== request.permission || !allowed) throw invalid('The selected Pathfinder permission changed.');
    const file = readAuthoringFileLocked(lease, bookFile(directories, request.book.filename), MAX_BOOK_BYTES);
    const proof = authoringEvidence(file);
    if (roleplayHash(proof) !== roleplayHash(request.book.evidence)
        && (!after || roleplayHash(proof) !== roleplayHash(after))) throw invalid('The selected lorebook changed after admission.');
    return { settings, agent, file };
}

function savedPlan(context, request) {
    const { directories, job } = context;
    const identity = roleplayHash(job.intent);
    const key = 'pathfinder-tool-plan';
    return withNativeMediaReceipt(context, ({ lease }) => {
        let plan = readArtifact(directories, job.id, key);
        if (plan !== undefined) {
            const { hash, ...values } = plan;
            if (hash !== roleplayHash(values) || plan.identity !== identity) throw invalid('The saved Pathfinder tool plan needs recovery.');
            return plan;
        }
        const { file, agent } = currentToolSource(context, lease, request);
        let book;
        try { book = JSON.parse(file.bytes.toString('utf8')); } catch { throw invalid('The accepted lorebook is unreadable.'); }
        const tool = actionName(request.name, request.args);
        const action = request.name === 'Pathfinder_Search'
            ? { result: searchPathfinderBook(request.bookName, book, request.book.bookHash, request.args.node_id ?? ''), changed: false }
            : applyPathfinderBookAction(book, { bookName: request.bookName, tool, args: request.args,
                callId: request.callId, sourceHash: request.book.bookHash,
                settings: agent.settings });
        const values = { identity, name: request.name, sourceHash: request.book.bookHash, bookName: request.bookName,
            changed: action.changed, result: action.result,
            ...(action.changed ? { bytes: JSON.stringify(action.book, null, 4), afterHash: roleplayHash(action.book) } : {}) };
        plan = { ...values, hash: roleplayHash(values) };
        if (Buffer.byteLength(JSON.stringify(plan)) > 10 * 1024 * 1024) throw invalid('The accepted Pathfinder plan is too large.');
        writeArtifact(directories, job.id, key, plan);
        return plan;
    });
}

const registered = new Map(Object.entries(TOOL_NAMES).map(([name, key]) => [name, registerTool({
    name: key, permission: 'pathfinder', mutating: name !== 'Pathfinder_Search',
    validate: args => !args || typeof args !== 'object' || Array.isArray(args) ? 'Pathfinder tool arguments must be an object.' : null,
    run: (_args, { target }) => target.execute(),
})]));

/** A private single-tool step. Stage 8 consumes its saved result before requesting another model turn. */
export async function runPathfinderToolJob(context, { beforePublish } = {}) {
    const { job, directories, signal } = context;
    const { request, media } = job.intent ?? {};
    if (job.type !== 'media.pathfinder-tool' || request?.version !== 1 || !media || !Object.hasOwn(TOOL_NAMES, request.name)) {
        throw invalid('The accepted Pathfinder tool call is invalid.');
    }
    const closed = withNativeMediaReceipt(context, ({ value }) => value.state === 'closed' ? value.result : null, { checkSource: false });
    if (closed) return { result: closed };
    signal.throwIfAborted();
    const plan = savedPlan(context, request);
    if (plan.changed && request.confirm) {
        const reviewed = requireJobApproval(context, { account: { accountId: media.accountId, dataEpoch: media.dataEpoch }, key: `pathfinder:${request.callId}`,
            proposal: { kind: 'pathfinder-lorebook', tool: request.name, arguments: request.args, book: request.bookName,
                beforeHash: request.book.bookHash, afterHash: plan.afterHash, before: request.book.evidence, after: plan.result },
            choices: ['allow', 'deny'], assertSourceLocked: lease => currentToolSource(context, lease, request) });
        if (reviewed.decision === null) return { waiting: true, approval: reviewed };
        if (reviewed.decision === 'deny') return finishNativeMediaJob(context, { status: 'denied', callId: request.callId, tool: request.name });
    }
    if (getTool(TOOL_NAMES[request.name]) !== registered.get(request.name)) throw invalid('The selected Pathfinder tool registration changed.');
    const effectKey = roleplayHash(['tool', request.name, request.callId]);
    const result = await invokeTool(TOOL_NAMES[request.name], request.args, { permissions: ['pathfinder'], signal,
        owner: context.owner, target: { execute: () => {
            if (!plan.changed) return { ...plan.result, effect: null };
            const relative = path.relative(directories.root, bookFile(directories, request.book.filename));
            const after = withNativeMediaReceipt(context, ({ lease, value }) => {
                const staged = value.effects[roleplayHash(['authoring', relative])]?.staged?.after ?? null;
                currentToolSource(context, lease, request, { after: staged });
                return staged;
            });
            const published = publishNativeAuthoringFile(context, { relative, before: request.book.evidence,
                bytes: Buffer.from(plan.bytes), beforePublish,
                checkLocked: (lease, value) => currentToolSource(context, lease, request, {
                    after: value.effects[roleplayHash(['authoring', relative])]?.staged?.after ?? after,
                }) });
            return { ...plan.result, effect: published };
        } }, receipt: receipt => withNativeMediaReceipt(context, ({ value, save }) => {
            const current = value.effects[effectKey];
            if (current && (current.name !== receipt.tool || current.planHash !== plan.hash)) throw invalid('The saved tool call differs from its accepted plan.');
            if (receipt.phase === 'before') {
                if (!current) { value.effects[effectKey] = { name: receipt.tool, planHash: plan.hash, state: 'preparing' }; save(); }
            } else {
                value.effects[effectKey] = { name: receipt.tool, planHash: plan.hash, state: 'done', resultHash: roleplayHash(receipt.effect) };
                save();
            }
        }) });
    const visible = { ...result };
    delete visible.effect;
    if (roleplayHash(visible) !== roleplayHash(plan.result)) throw invalid('The registered tool returned a different result.');
    return finishNativeMediaJob(context, { status: 'done', callId: request.callId, tool: request.name, result: visible });
}

registerHandler('media.pathfinder-tool', context => runPathfinderToolJob(context));
