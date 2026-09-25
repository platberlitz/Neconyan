import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { registerHandler } from '../jobs/runner.js';
import { roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { admitRoleplayJob, applyRoleplayJobEffect, readRoleplayJobResult } from '../roleplay-jobs.js';
import { admitNativeMediaJob, finishNativeMediaJob, withNativeMediaReceipt } from './media-jobs.js';
import { assertRoleplaySourceLocked } from './roleplay-source.js';
import { roleplayNativeHost } from '../endpoints/chats.js';
import { getTool, invokeTool, registerTool } from '../tools/registry.js';
import { capturePathfinderToolOwnerLocked } from './pathfinder-tool-jobs.js';
import { preparePathfinderNotebookAction } from './pathfinder-notebook.js';

const fail = message => roleplayError('PATHFINDER_NOTEBOOK_SOURCE_CHANGED', message, 409);
const TOOL = 'pathfinder_notebook';
const DISPLAY_NAME = 'Pathfinder_Notebook';
const registered = registerTool({ name: TOOL, permission: 'pathfinder', mutating: true,
    validate: args => !args || typeof args !== 'object' || Array.isArray(args) ? 'Notebook arguments must be an object.' : null,
    run: (_args, { target }) => target.execute() });

function ownerLocked(lease, source, request) {
    const owner = capturePathfinderToolOwnerLocked(lease, source, request.avatar);
    if (owner.reference.id !== request.agent.id || roleplayHash({ id: owner.reference.id, revision: owner.reference.revision,
        rawHash: owner.reference.rawHash, physical: owner.reference.physical }) !== roleplayHash(request.agent)
        || roleplayHash(owner.agent.settings ?? {}) !== request.agentSettingsHash
        || roleplayHash(owner.settingsEvidence) !== roleplayHash(request.settingsEvidence)
        || owner.settingsHash !== request.settingsHash || roleplayHash(owner.books) !== request.booksHash
        || owner.agent.settings?.sidecarEnabled !== true) throw fail('The saved Pathfinder owner or permission changed.');
    const selected = owner.agent.tools?.find(tool => tool.name === DISPLAY_NAME);
    if (selected?.enabled === false || selected?.shouldRegister === false
        || owner.agent.settings.toolStates?.[DISPLAY_NAME] === false) throw fail('The saved notebook tool is disabled.');
    if (request.notebook.action !== 'read' && !owner.books.length) throw fail('No readable enabled lorebook permits a notebook change.');
    return owner;
}

/** Capture the exact saved chat, owner and notebook operation before accepting a tool call. */
export function capturePathfinderNotebookRequest(base, account, source, { avatar, agentId, args, callId } = {}) {
    if (typeof agentId !== 'string' || !agentId || typeof avatar !== 'string' || !avatar
        || typeof callId !== 'string' || !callId || callId.length > 256 || !args || typeof args !== 'object'
        || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > 1024 * 1024) throw fail('The notebook request is incomplete.');
    return withRoleplayAccount(base, account, lease => {
        const saved = assertRoleplaySourceLocked(lease, source);
        if (source.message || source.range || !source.dependencies?.some(item => item.kind === 'character' && item.locator.avatar === avatar)) {
            throw fail('The notebook needs the exact whole chat and Pathfinder character.');
        }
        const owner = capturePathfinderToolOwnerLocked(lease, source, avatar);
        const notebook = { action: String(args.action ?? '').trim().toLowerCase(),
            key: args.key === undefined ? '' : args.key, content: args.content === undefined ? '' : args.content,
            updatedAt: Date.now() };
        const request = { version: 1, avatar, agent: { id: owner.reference.id, revision: owner.reference.revision,
            rawHash: owner.reference.rawHash, physical: owner.reference.physical }, agentSettingsHash: roleplayHash(owner.agent.settings ?? {}),
        settingsEvidence: owner.settingsEvidence, settingsHash: owner.settingsHash, booksHash: roleplayHash(owner.books),
        callId, notebook };
        if (owner.reference.id !== agentId) throw fail('This Agent does not own Pathfinder tools.');
        ownerLocked(lease, source, request);
        const prepared = preparePathfinderNotebookAction(saved.records, notebook);
        request.expectedAfterHash = prepared.afterHash;
        request.mutating = prepared.changed;
        if (Buffer.byteLength(JSON.stringify(request)) > 2 * 1024 * 1024) throw fail('The notebook request exceeds its saved limit.');
        return request;
    });
}

export function admitPathfinderNotebookJob(base, account, { operationKey, source, request }) {
    if (request?.version !== 1 || request.notebook?.action === undefined || typeof request.expectedAfterHash !== 'string') throw fail('The accepted notebook request is invalid.');
    return request.mutating ? admitRoleplayJob(base, account, { operationKey, source, request, effect: 'notebook',
        type: 'roleplay.notebook', label: 'Update saved Pathfinder notebook' })
        : admitNativeMediaJob(base, account, { operationKey, source, kind: 'pathfinder-notebook', request,
            target: { kind: 'pathfinder-notebook', id: source.instanceId } });
}

function readCurrent(context, base, account, request) {
    return withRoleplayAccount(base, account, lease => {
        const saved = assertRoleplaySourceLocked(lease, context.job.intent.source);
        ownerLocked(lease, context.job.intent.source, request);
        const prepared = preparePathfinderNotebookAction(saved.records, request.notebook);
        if (prepared.afterHash !== request.expectedAfterHash || prepared.changed !== request.mutating) throw fail('The notebook changed after admission.');
        return { prepared, recordsHash: roleplayHash(saved.records) };
    });
}

function savedOutput(context, account, original) {
    const { directories, job } = context;
    return withRoleplayAccount({ owner: context.owner, directories }, account, () => {
        const stored = readArtifact(directories, job.id, 'pathfinder-notebook-output');
        if (stored !== undefined) {
            const { hash, ...value } = stored;
            if (hash !== roleplayHash(value) || value.identity !== roleplayHash(job.intent)
                || value.recordsHash !== original.recordsHash || value.afterHash !== original.prepared.afterHash
                || value.result !== original.prepared.result) throw fail('The saved notebook result needs recovery.');
            return stored;
        }
        const value = { identity: roleplayHash(job.intent), recordsHash: original.recordsHash,
            afterHash: original.prepared.afterHash, result: original.prepared.result };
        const output = { ...value, hash: roleplayHash(value) };
        writeArtifact(directories, job.id, 'pathfinder-notebook-output', output);
        return output;
    });
}

/** The original chat write's permanent receipt settles an interrupted notebook edit exactly once. */
export async function runPathfinderNotebookJob(context, { host = roleplayNativeHost, beforeCompletion } = {}) {
    const { job, directories, signal } = context;
    const { request, source } = job.intent ?? {};
    if (!request || request.version !== 1 || !source || !['roleplay.notebook', 'media.pathfinder-notebook'].includes(job.type)) {
        throw fail('The accepted notebook job is invalid.');
    }
    const base = { owner: context.owner, directories };
    const account = job.intent.roleplay ?? job.intent.media;
    const stamp = { accountId: account?.accountId, dataEpoch: account?.dataEpoch };
    if (!stamp.accountId || !Number.isSafeInteger(stamp.dataEpoch)) throw fail('The notebook account stamp is missing.');
    if (request.mutating) {
        if (job.type !== 'roleplay.notebook') throw fail('A mutating notebook needs an owned chat write.');
        const completed = readRoleplayJobResult(base, stamp, { operationKey: account.operationKey,
            jobId: job.id, effect: 'notebook', source, request });
        if (completed) return { result: { status: 'done', tool: DISPLAY_NAME, callId: request.callId,
            result: request.notebook.action === 'write' ? `📓 Wrote "${request.notebook.key.trim()}" to notebook.`
                : `📓 Deleted: ${request.notebook.key.trim()}`, write: completed } };
    } else {
        if (job.type !== 'media.pathfinder-notebook') throw fail('A read-only notebook cannot write a chat.');
        const closed = withNativeMediaReceipt(context, ({ value }) => value.state === 'closed' ? value.result : null, { checkSource: false });
        if (closed) return { result: closed };
    }
    signal.throwIfAborted();
    const saved = request.mutating ? withRoleplayAccount(base, stamp, () => readArtifact(directories, job.id, 'pathfinder-notebook-output')) : undefined;
    const original = saved === undefined ? readCurrent(context, base, stamp, request) : null;
    const result = request.mutating ? saved ?? savedOutput(context, stamp, original) : original.prepared;
    if (request.mutating && saved) {
        const { hash, ...value } = saved;
        if (hash !== roleplayHash(value) || value.identity !== roleplayHash(job.intent)
            || value.afterHash !== request.expectedAfterHash) throw fail('The saved notebook result needs recovery.');
    }
    await beforeCompletion?.(result);
    signal.throwIfAborted();
    if (getTool(TOOL) !== registered) throw fail('The native notebook registration changed.');
    const response = await invokeTool(TOOL, request.notebook, { permissions: ['pathfinder'], signal, owner: context.owner,
        target: { execute: () => request.mutating
            ? { result: result.result, effect: applyRoleplayJobEffect(base, stamp, { operationKey: account.operationKey, jobId: job.id,
                output: { notebookOutput: result.hash } }, host) }
            : { result: result.result, effect: null } },
        receipt: request.mutating ? receipt => withRoleplayAccount(base, stamp, () => {
            const current = readArtifact(directories, job.id, 'pathfinder-notebook-tool-receipt');
            if (current?.identity !== undefined && current.identity !== roleplayHash(job.intent)) throw fail('The notebook invocation changed.');
            const value = { identity: roleplayHash(job.intent), phase: receipt.phase,
                proof: result.hash, ...(receipt.phase === 'after' ? { effectHash: roleplayHash(receipt.effect) } : {}) };
            writeArtifact(directories, job.id, 'pathfinder-notebook-tool-receipt', { ...value, hash: roleplayHash(value) });
        }) : null });
    if (response.result !== result.result) throw fail('The registered notebook action returned a different result.');
    return request.mutating ? { result: { status: 'done', tool: DISPLAY_NAME, callId: request.callId,
        result: response.result, write: response.effect } }
        : finishNativeMediaJob(context, { status: 'done', tool: DISPLAY_NAME, callId: request.callId, result: response.result });
}

registerHandler('roleplay.notebook', context => runPathfinderNotebookJob(context));
registerHandler('media.pathfinder-notebook', context => runPathfinderNotebookJob(context));
