import path from 'node:path';
import { registerHandler } from '../jobs/runner.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { readAuthoringFileLocked, authoringEvidence } from '../authoring-store.js';
import { getTool, invokeTool, registerTool } from '../tools/registry.js';
import { roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { syncLorebookOriginalEntry } from '../../public/scripts/neconyan-lorebook-tools-core.js';
import { assistantAgentCreated } from '../../public/scripts/neconyan-assistant-agent.js';
import { assertAgentWriteCapacityLocked } from '../in-chat-agent-storage.js';
import { ASSISTANT_PREFIX, ASSISTANT_TOOLS, assistantToolMutates, projectAssistantAgent } from './assistant-tool-data.js';
import { applyNoteProposalLocked, checkProposalLocked, proposalIsDirectLocked, proposalSummary } from '../notebooks/assistant.js';
import { notifyNotebookChanged } from '../notebooks/events.js';
import { NotebookError } from '../notebooks/paths.js';
import { captureAssistantToolSourceLocked, readBoundAssistantContextLocked } from './assistant-tool-sources.js';
import { admitNativeMediaJob, finishNativeMediaJob, withNativeMediaReceipt } from './media-jobs.js';
import { publishNativeAuthoringFile } from './authoring-tool-effects.js';
import { requireJobApproval } from './job-approvals.js';
import { planAssistantCharacter, executeApprovedCharacterAction, assertApprovedCharacterEffectLocked } from './assistant-character-actions.js';

const invalid = message => roleplayError('ASSISTANT_TOOL_SOURCE_CHANGED', message, 409);
const EDITABLE_FILE_KINDS = new Set(['lorebook', 'agent', 'preset', 'character', 'notebook']);
const RESULT_LIMIT = 128 * 1024;

/** Bind one selected assistant card, chat, exact input, and every edited resource before work. */
export function captureAssistantToolRequest(base, account, source, { avatar, name, args = {}, callId } = {}) {
    return withRoleplayAccount(base, account, lease => captureAssistantToolSourceLocked(lease, source, { avatar, name, args, callId }));
}

export function admitAssistantToolJob(base, account, { operationKey, source, request }) {
    if (!request?.name || !request.name.startsWith(ASSISTANT_PREFIX)
        || !Object.hasOwn(ASSISTANT_TOOLS, request.name.slice(ASSISTANT_PREFIX.length))
        || !request.assistant || !request.callId || !request.target) throw invalid('The assistant tool request is incomplete.');
    if (request.mutating && !request.response && !EDITABLE_FILE_KINDS.has(request.resource?.kind)) {
        throw invalid('This assistant tool needs a protected native writer before it can be accepted.');
    }
    if (request.resource?.kind === 'notebook' && (!request.proposal || !request.proposalHash)) throw invalid('The notebook change proposal is incomplete.');
    const reviewed = request.proposal
        ? { tool: request.name, arguments: request.args, summary: proposalSummary(request.proposal), proposalHash: request.proposalHash, diff: request.diff ?? '' }
        : { tool: request.name, arguments: request.args, resource: request.resource, before: request.change?.before ?? null };
    const approvalReservation = request.mutating && !request.response ? { key: `assistant:${request.callId}`,
        bytes: Buffer.byteLength(JSON.stringify(reviewed)) + 256 * 1024 } : null;
    return admitNativeMediaJob(base, account, { operationKey, source, request, target: request.target, kind: 'assistant-tool', approvalReservation });
}

function registeredName(request) { return `assistant_${request.tool.replaceAll('-', '_')}`; }
const registered = new Map(Object.entries(ASSISTANT_TOOLS).map(([name, tool]) => [`${ASSISTANT_PREFIX}${name}`, registerTool({
    name: `assistant_${tool.replaceAll('-', '_')}`, permission: 'assistant', mutating: assistantToolMutates(tool),
    validate: args => !args || typeof args !== 'object' || Array.isArray(args) ? 'Assistant tool arguments must be an object.' : null,
    run: (_args, { target }) => target.execute(),
})]));

function verifiedSource(context, request, { after = null, prepared = false } = {}) {
    return withNativeMediaReceipt(context, ({ lease }) => {
        if (!after) {
            const current = captureAssistantToolSourceLocked(lease, context.job.intent.source,
                { avatar: request.avatar, name: request.name, args: request.args, callId: request.callId });
            if (roleplayHash(current) !== roleplayHash(request)) throw invalid('The accepted assistant tool source changed.');
            return;
        }
        const current = readBoundAssistantContextLocked(lease, context.job.intent.source, request.avatar);
        if (roleplayHash(current.assistant) !== roleplayHash(request.assistant)
            || current.settingsHash !== request.settingsHash || roleplayHash(current.settingsEvidence) !== roleplayHash(request.settingsEvidence)) {
            throw invalid('The assistant or its saved account settings changed.');
        }
        const file = readAuthoringFileLocked(lease, path.join(context.directories.root, request.resource.relative), 8 * 1024 * 1024);
        const evidence = roleplayHash(authoringEvidence(file));
        if (evidence !== roleplayHash(after) && !(prepared && evidence === roleplayHash(request.resource.evidence))) throw invalid('The completed assistant edit changed after publication.');
    });
}

function plannedChange(context, request) {
    const { directories, job } = context;
    if (request.resource.kind === 'character') {
        const saved = withNativeMediaReceipt(context, () => readArtifact(directories, job.id, 'assistant-tool-plan'), { checkSource: false });
        if (saved !== undefined) {
            const { hash, ...values } = saved;
            if (hash !== roleplayHash(values) || saved.identity !== roleplayHash(job.intent)
                || saved.requestHash !== roleplayHash(request)) throw invalid('The saved character plan differs from the accepted change.');
            return saved;
        }
        const plan = planAssistantCharacter(context, request);
        withNativeMediaReceipt(context, () => writeArtifact(directories, job.id, 'assistant-tool-plan', plan));
        return plan;
    }
    return withNativeMediaReceipt(context, ({ lease }) => {
        let plan = readArtifact(directories, job.id, 'assistant-tool-plan');
        if (plan !== undefined) {
            const { hash, ...values } = plan;
            if (hash !== roleplayHash(values) || plan.identity !== roleplayHash(job.intent)) throw invalid('The saved assistant edit plan is damaged.');
            return plan;
        }
        const current = captureAssistantToolSourceLocked(lease, job.intent.source,
            { avatar: request.avatar, name: request.name, args: request.args, callId: request.callId });
        if (roleplayHash(current) !== roleplayHash(request)) throw invalid('The assistant edit changed before review.');
        const full = path.join(directories.root, request.resource.relative);
        const file = readAuthoringFileLocked(lease, full, 8 * 1024 * 1024);
        if ((!file && request.tool !== 'create-agent') || roleplayHash(authoringEvidence(file)) !== roleplayHash(request.resource.evidence)) throw invalid('The edited file changed before review.');
        let data;
        try { data = file ? JSON.parse(file.bytes.toString('utf8')) : structuredClone(request.change.agent); } catch { throw invalid('The saved assistant edit target is unreadable.'); }
        let visible;
        if (request.tool === 'create-agent') {
            visible = assistantAgentCreated(data);
        } else if (request.tool === 'edit-lorebook-entry') {
            const entry = Object.values(data.entries ?? {}).find(item => item?.uid === request.change.uid);
            if (!entry || entry.agentBlacklisted || roleplayHash(entry) !== request.change.entryHash) throw invalid('The selected lorebook entry changed.');
            const field = request.change.field === 'title' ? 'comment' : 'content';
            if (String(entry[field] ?? '') !== request.change.before) throw invalid('The selected lorebook field changed.');
            entry[field] = request.change.after;
            syncLorebookOriginalEntry(data, entry.uid);
            visible = { status: 'success', book: request.change.book, uid: entry.uid,
                field: request.change.field, before: request.change.before, after: request.change.after };
        } else if (request.tool === 'edit-agent') {
            if (roleplayHash(projectAssistantAgent(data)[request.change.field]) !== roleplayHash(request.change.before)) throw invalid('The Agent field changed.');
            data[request.change.field] = request.change.after;
            visible = { status: 'success', id: data.id, field: request.change.field,
                before: request.change.before, after: request.change.after };
        } else if (request.tool === 'edit-preset') {
            if (roleplayHash(data[request.change.field]) !== roleplayHash(request.change.before)) throw invalid('The saved model preset field changed.');
            data[request.change.field] = request.change.after;
            visible = { status: 'success', apiId: request.change.apiId, name: request.change.name,
                field: request.change.field, before: request.change.before, after: request.change.after };
        } else throw invalid('The assistant edit is not implemented.');
        if (Buffer.byteLength(JSON.stringify(visible)) > RESULT_LIMIT) throw invalid('The complete assistant edit response exceeds its reserved capacity.');
        const bytes = request.tool === 'edit-lorebook-entry' ? JSON.stringify(data, null, 4) : JSON.stringify(data);
        const values = { identity: roleplayHash(job.intent), requestHash: roleplayHash(request), bytes,
            afterHash: roleplayHash(JSON.parse(bytes)), visible };
        if (Buffer.byteLength(JSON.stringify(values)) > 10 * 1024 * 1024) throw invalid('The assistant edit exceeds its saved plan limit.');
        plan = { ...values, hash: roleplayHash(values) };
        writeArtifact(directories, job.id, 'assistant-tool-plan', plan);
        return plan;
    });
}

const NOTE_FAILURE_STATUS = { 403: 'denied', 404: 'not_found', 409: 'conflict' };

function assertBoundAssistantLocked(lease, context, request) {
    const current = readBoundAssistantContextLocked(lease, context.job.intent.source, request.avatar);
    if (roleplayHash(current.assistant) !== roleplayHash(request.assistant)
        || current.settingsHash !== request.settingsHash || roleplayHash(current.settingsEvidence) !== roleplayHash(request.settingsEvidence)) {
        throw invalid('The accepted assistant or its account settings changed.');
    }
}

/** Notebook changes are reviewed proposals; the notebook service rechecks permission and revision at commit. */
async function runNoteProposalJob(context, request) {
    const { job, signal } = context;
    const account = { accountId: job.intent.media.accountId, dataEpoch: job.intent.media.dataEpoch };
    const effectKey = roleplayHash(['note', request.name, request.callId]);
    const operationId = `native:${roleplayHash([job.id, request.callId]).slice(0, 40)}`;
    const finishFailure = error => {
        if (!(error instanceof NotebookError) || !NOTE_FAILURE_STATUS[error.status]) throw error;
        withNativeMediaReceipt(context, ({ value, save }) => {
            value.effects[effectKey] = { name: registeredName(request), state: 'done', failed: error.code };
            save();
        });
        return finishNativeMediaJob(context, { tool: request.name, callId: request.callId, result: {
            status: NOTE_FAILURE_STATUS[error.status], committed: false, code: error.code,
            message: `${error.message} Nothing was saved.` } });
    };
    let direct = false;
    if (request.direct) {
        try {
            direct = withNativeMediaReceipt(context, ({ lease }) => {
                assertBoundAssistantLocked(lease, context, request);
                return proposalIsDirectLocked(lease, request.proposal);
            });
        } catch (error) { return finishFailure(error); }
    }
    if (!direct) {
        let approval;
        try {
            approval = requireJobApproval(context, { account, key: `assistant:${request.callId}`,
                proposal: { kind: 'neconyan-note-proposal', tool: request.name, arguments: request.args,
                    summary: proposalSummary(request.proposal), proposalHash: request.proposalHash, diff: request.diff ?? '' },
                choices: ['allow', 'deny'],
                assertSourceLocked: lease => {
                    assertBoundAssistantLocked(lease, context, request);
                    checkProposalLocked(lease, request.proposal);
                } });
        } catch (error) { return finishFailure(error); }
        if (approval.decision === null) return { waiting: true, approval };
        if (approval.decision === 'deny') return finishNativeMediaJob(context,
            { tool: request.name, callId: request.callId, result: { status: 'denied', committed: false, message: 'Not saved. The change was declined.' } });
    }
    signal.throwIfAborted();
    if (getTool(registeredName(request)) !== registered.get(request.name)) throw invalid('The selected assistant tool registration changed.');
    let result;
    try {
        result = await invokeTool(registeredName(request), request.args, { permissions: ['assistant'], owner: context.owner, signal,
            target: { execute: () => withNativeMediaReceipt(context, ({ lease }) => {
                assertBoundAssistantLocked(lease, context, request);
                const visible = applyNoteProposalLocked(lease, request.proposal,
                    { operationId, actor: { kind: 'assistant', assistantId: request.assistantId } });
                return { ...visible, effect: { operationId, revision: visible.revision ?? null } };
            }) },
            receipt: receipt => withNativeMediaReceipt(context, ({ value, save }) => {
                if (receipt.phase === 'before') {
                    if (!value.effects[effectKey]) { value.effects[effectKey] = { name: receipt.tool, state: 'preparing' }; save(); }
                } else {
                    value.effects[effectKey] = { name: receipt.tool, state: 'done', resultHash: roleplayHash(receipt.effect ?? null) };
                    save();
                }
            }) });
    } catch (error) { return finishFailure(error); }
    const visible = { ...result };
    delete visible.effect;
    if (visible.committed) {
        notifyNotebookChanged({ owner: context.owner, notebookId: visible.notebookId, noteId: visible.noteId ?? null,
            revision: visible.revision ?? null, kind: request.proposal.operation === 'publish' ? 'lore' : 'note', operationId });
    }
    if (Buffer.byteLength(JSON.stringify(visible)) > RESULT_LIMIT) throw invalid('The notebook result exceeds its reserved capacity.');
    return finishNativeMediaJob(context, { tool: request.name, callId: request.callId, result: visible });
}

/** One durable function-tool result; Stage 8 consumes it before the next model turn. */
export async function runAssistantToolJob(context, { beforePublish, afterCommit, fetchImpl } = {}) {
    const { job, directories, signal } = context;
    const { request } = job.intent ?? {};
    if (job.type !== 'media.assistant-tool' || !request?.tool || !registered.has(request.name)) throw invalid('The assistant tool intent is unavailable.');
    const closed = withNativeMediaReceipt(context, ({ value }) => value.state === 'closed' ? value.result : null, { checkSource: false });
    if (closed) return { result: closed };
    signal.throwIfAborted();
    if (request.response) {
        verifiedSource(context, request);
        return finishNativeMediaJob(context, { tool: request.name, callId: request.callId, result: request.response });
    }
    if (request.proposal) return runNoteProposalJob(context, request);
    const plan = plannedChange(context, request);
    const account = { accountId: job.intent.media.accountId, dataEpoch: job.intent.media.dataEpoch };
    const approval = requireJobApproval(context, { account, key: `assistant:${request.callId}`,
        proposal: { kind: 'neconyan-assistant-edit', tool: request.name, arguments: request.args,
            resource: request.resource, before: request.change.before ?? null,
            afterHash: plan.afterHash }, choices: ['allow', 'deny'],
        assertSourceLocked: lease => {
            const current = captureAssistantToolSourceLocked(lease, job.intent.source,
                { avatar: request.avatar, name: request.name, args: request.args, callId: request.callId });
            if (roleplayHash(current) !== roleplayHash(request)) throw invalid('The assistant edit changed before review.');
        } });
    if (approval.decision === null) return { waiting: true, approval };
    if (approval.decision === 'deny') return finishNativeMediaJob(context,
        { tool: request.name, callId: request.callId, status: 'denied' });
    if (getTool(registeredName(request)) !== registered.get(request.name)) throw invalid('The selected assistant tool registration changed.');
    const relative = request.resource.relative, effectKey = roleplayHash(['authoring', relative]);
    const execute = request.resource.kind === 'character'
        ? () => executeApprovedCharacterAction(context, { request, plan, beforePublish, afterCommit, fetchImpl })
        : () => {
            const effect = withNativeMediaReceipt(context, ({ value }) => value.effects[effectKey] ?? null);
            if (effect?.staged?.after) verifiedSource(context, request, { after: effect.staged.after, prepared: effect.state === 'prepared' });
            else verifiedSource(context, request);
            const published = publishNativeAuthoringFile(context, { relative, before: request.resource.evidence,
                bytes: Buffer.from(plan.bytes), beforePublish, checkLocked: (lease, value) => {
                    const proof = value.effects[effectKey]?.staged?.after ?? null;
                    const current = readBoundAssistantContextLocked(lease, job.intent.source, request.avatar);
                    if (roleplayHash(current.assistant) !== roleplayHash(request.assistant)
                        || current.settingsHash !== request.settingsHash || roleplayHash(current.settingsEvidence) !== roleplayHash(request.settingsEvidence)) {
                        throw invalid('The accepted assistant or its account settings changed.');
                    }
                    const file = readAuthoringFileLocked(lease, path.join(directories.root, relative), 8 * 1024 * 1024);
                    const currentEvidence = authoringEvidence(file);
                    if (roleplayHash(currentEvidence) !== roleplayHash(request.resource.evidence)
                        && (!proof || roleplayHash(currentEvidence) !== roleplayHash(proof))) throw invalid('The edited resource changed outside the accepted write.');
                    if (request.tool === 'create-agent') assertAgentWriteCapacityLocked(lease, 'agent', request.change.agent);
                } });
            return { ...plan.visible, effect: published };
        };
    const result = await invokeTool(registeredName(request), request.args, { permissions: ['assistant'], owner: context.owner, signal,
        target: { execute }, receipt: receipt => withNativeMediaReceipt(context, ({ value, save }) => {
            const key = roleplayHash(['tool', request.name, request.callId]);
            const current = value.effects[key];
            if (current && (current.name !== receipt.tool || current.planHash !== plan.hash)) throw invalid('The saved assistant invocation differs from its accepted plan.');
            if (receipt.phase === 'before') {
                if (!current) { value.effects[key] = { name: receipt.tool, planHash: plan.hash, state: 'preparing' }; save(); }
            } else {
                value.effects[key] = { name: receipt.tool, planHash: plan.hash, state: 'done', resultHash: roleplayHash(receipt.effect) };
                save();
            }
        }, { checkSource: request.resource.kind !== 'character' }) });
    const visible = { ...result };
    delete visible.effect;
    if (roleplayHash(visible) !== roleplayHash(plan.visible)) throw invalid('The registered assistant tool returned a different result.');
    return finishNativeMediaJob(context, { tool: request.name, callId: request.callId, result: visible },
        request.resource.kind === 'character' ? { checkSource: false,
            checkLocked: (lease, value) => assertApprovedCharacterEffectLocked(lease, context, request, plan, value) } : {});
}

registerHandler('media.assistant-tool', context => runAssistantToolJob(context));
