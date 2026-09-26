import path from 'node:path';
import { registerHandler } from '../jobs/runner.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { readRoleplayFile, roleplayError, roleplayHash, roleplaySettingsHash, withRoleplayAccount } from '../roleplay-store.js';
import { readAgentRecordLocked } from '../in-chat-agent-storage.js';
import { assertRoleplaySourceLocked } from './roleplay-source.js';
import { captureRoleplayWorldInfo, assertRoleplayWorldInfoCurrent } from './world-info.js';
import { captureGenerationBinding } from './profiles.js';
import { savedRoleplayMacroSnapshot } from './roleplay-prompt.js';
import { isNativeCompanion, nativeAgentDefinition } from './agent-definition.js';
import { readRoleplayAgentsLocked } from './roleplay-agents-source.js';
import { prepareRoleplayAgentContributions, runRoleplayAgentPostprocessing } from './roleplay-agent-processing.js';
import { admitNativeMediaJob, withNativeMediaReceipt, finishNativeMediaJob, ensureNativeMediaDirectory,
    mediaDirectoryEvidence, publishNativeMediaFile } from './media-jobs.js';

const fail = message => roleplayError('ROLEPLAY_AGENT_DRAFT_INVALID', message, 409);

/** A composer request owns an exact draft; it never represents an assistant chat append. */
export function captureAgentDraftRequest(base, account, source, { avatar, agentId, draft, draftId = '', revision = '', connection, acknowledgement } = {}) {
    if (typeof agentId !== 'string' || !agentId || typeof draft !== 'string' || !draft.trim() || Buffer.byteLength(draft) > 256 * 1024
        || typeof draftId !== 'string' || draftId.length > 512 || typeof revision !== 'string' || revision.length > 512) throw fail('The Agent draft needs its exact text and identity.');
    const captured = withRoleplayAccount(base, account, lease => {
        assertRoleplaySourceLocked(lease, source);
        if (!source.dependencies?.some(item => item.kind === 'character' && item.locator.avatar === avatar)) throw fail('The draft character is not bound to this chat.');
        const stored = readAgentRecordLocked(lease, 'agent', agentId);
        if (!stored || isNativeCompanion(nativeAgentDefinition(stored.record))) throw fail('Select an inline Agent for the composer draft.');
        const relative = path.relative(base.directories.root, path.join(base.directories.files ?? path.join(base.directories.root, 'user', 'files'), 'agent-drafts')).split(path.sep).join('/');
        if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..')) throw fail('The draft result directory is outside this account.');
        const parts = relative.split('/');
        const parents = parts.map((_, index) => {
            const name = parts.slice(0, index + 1).join('/');
            readRoleplayFile(path.join(base.directories.root, name, '.draft-path-check'), 1, { allowMissingParent: true });
            return { relative: name, before: mediaDirectoryEvidence(path.join(base.directories.root, name)) };
        });
        return { relative, parents, binding: connection ? captureGenerationBinding(base.directories, connection, acknowledgement) : null };
    });
    const worldInfo = captureRoleplayWorldInfo(base, account, source, { avatar, serverPrompt: true, maxContext: 8192, agentContext: true, agentIds: [agentId] });
    const records = withRoleplayAccount(base, account, lease => assertRoleplaySourceLocked(lease, source).records);
    const request = { ...captured, worldInfo, macros: savedRoleplayMacroSnapshot(worldInfo, records),
        agent: { id: agentId, draft, draftId, revision, sourceTextHash: roleplayHash(draft) } };
    if (Buffer.byteLength(JSON.stringify(request)) > 2 * 1024 * 1024) throw fail('The Agent draft context exceeds its saved limit.');
    return request;
}

export function admitAgentDraftJob(base, account, { operationKey, source, request }) {
    if (!request?.worldInfo?.agentContext || !request.agent || roleplayHash(request.worldInfo.source) !== roleplayHash(source)
        || roleplayHash(request.worldInfo.account) !== roleplayHash(account)) throw fail('The Agent draft is not bound to this account and chat.');
    return admitNativeMediaJob(base, account, { operationKey, source, kind: 'agent-draft', request,
        target: { kind: 'agent-draft', id: source.instanceId, branchId: request.worldInfo.avatar } });
}

export async function runAgentDraftJob(context, { generate, beforePublication } = {}) {
    const { job, directories, owner } = context;
    const { source, request, media, kind, target } = job.intent ?? {};
    if (kind !== 'agent-draft' || !request?.agent || !media) throw fail('The accepted Agent draft is missing.');
    const base = { owner, directories }, account = { accountId: media.accountId, dataEpoch: media.dataEpoch };
    const receipt = admitNativeMediaJob(base, account, { operationKey: media.operationKey, source, kind, request, target });
    if (receipt.jobId !== job.id) throw fail('This job does not own the Agent draft.');
    if (receipt.state === 'closed') return { result: receipt.result };
    const assertLocked = lease => {
        context.signal.throwIfAborted();
        const saved = assertRoleplaySourceLocked(lease, source);
        const settings = readRoleplayFile(path.join(directories.root, 'settings.json'), 8 * 1024 * 1024);
        let value;
        try { value = JSON.parse(settings.bytes.toString('utf8')); } catch { throw fail('The saved draft settings are unavailable.'); }
        if (roleplaySettingsHash(value) !== request.worldInfo.settingsHash) throw fail('The saved draft settings changed.');
        readRoleplayAgentsLocked(lease, request.worldInfo.agents);
        return saved;
    };
    const assertCurrent = () => {
        const saved = withRoleplayAccount(base, account, assertLocked);
        assertRoleplayWorldInfoCurrent(base, request.worldInfo);
        return saved;
    };
    for (const parent of request.parents) ensureNativeMediaDirectory(context, parent);
    let output = withNativeMediaReceipt(context, () => readArtifact(directories, job.id, 'agent-draft-output'));
    if (output === undefined) {
        const saved = assertCurrent();
        const options = { base, snapshot: request.worldInfo, records: saved.records, macros: request.macros, binding: request.binding,
            generationType: 'impersonate', assistantName: request.worldInfo.speakerNames.user, assertCurrent, generate };
        prepareRoleplayAgentContributions(context, options);
        const processed = await runRoleplayAgentPostprocessing(context, { ...options, namespace: 'composer', manualAgentIds: [request.agent.id],
            includeDisplayRegex: true, value: request.agent.draft, recordHistory: false });
        const value = { identity: roleplayHash(job.intent), sourceTextHash: request.agent.sourceTextHash, draftId: request.agent.draftId,
            revision: request.agent.revision, original: request.agent.draft, draft: processed.text, processingHash: processed.hash };
        output = { ...value, hash: roleplayHash(value) };
        withNativeMediaReceipt(context, () => writeArtifact(directories, job.id, 'agent-draft-output', output));
    }
    const { hash, ...value } = output ?? {};
    const processed = withNativeMediaReceipt(context, () => readArtifact(directories, job.id, 'roleplay-agent-post:composer'));
    if (hash !== roleplayHash(value) || value.identity !== roleplayHash(job.intent) || value.sourceTextHash !== roleplayHash(request.agent.draft)
        || !processed || processed.hash !== value.processingHash || processed.hash !== roleplayHash(Object.fromEntries(Object.entries(processed).filter(([key]) => key !== 'hash')))
        || processed.text !== value.draft) throw fail('The saved Agent draft result needs recovery.');
    await beforePublication?.(output);
    context.signal.throwIfAborted();
    const relative = `${request.relative}/${roleplayHash([job.id, 'draft'])}.json`;
    const file = publishNativeMediaFile(context, { relative, before: null, bytes: Buffer.from(JSON.stringify(output)), checkLocked: assertLocked });
    return finishNativeMediaJob(context, { kind: 'agent-draft', draftId: value.draftId, revision: value.revision,
        sourceTextHash: value.sourceTextHash, changed: value.draft !== value.original, file,
        url: `/${relative.split('/').map(encodeURIComponent).join('/')}` });
}

registerHandler('media.agent-draft', context => runAgentDraftJob(context));
