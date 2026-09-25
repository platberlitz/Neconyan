import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { getJob, releaseJob } from '../jobs/store.js';
import { roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { readNativeMediaJobResult } from './media-jobs.js';
import { readRoleplayJobResultByIntentHash } from '../roleplay-jobs.js';
import { assertRoleplaySourceLocked, captureRoleplaySourceLocked } from './roleplay-source.js';
import { assertRoleplayWorldInfoCurrent } from './world-info.js';
import { normaliseRoleplayToolCalls } from './roleplay-tool-calls.js';
import { roleplayPromptContentHash } from './roleplay-prompt-proof.js';
import { captureAssistantToolRequest, admitAssistantToolJob } from './assistant-tool-jobs.js';
import { capturePathfinderToolRequest, admitPathfinderToolJob } from './pathfinder-tool-jobs.js';
import { capturePathfinderNotebookRequest, admitPathfinderNotebookJob } from './pathfinder-notebook-jobs.js';

const invalid = message => roleplayError('ROLEPLAY_TOOL_RECOVERY', message, 409);
const STEP = /^provider:[a-f0-9]{64}$/u;

function bound(context) {
    const { job, directories, owner } = context;
    const { roleplay, request, source } = job.intent ?? {};
    if (!['roleplay.reply', 'roleplay.candidate'].includes(job.type) || job.type === 'roleplay.candidate' && request?.workflowCandidate?.version !== 1
        || !roleplay || !request?.serverPrompt || !request.worldInfo?.tools?.definitions?.length) {
        throw invalid('This Roleplay reply has no accepted native tool definitions.');
    }
    const base = { owner, directories }, account = { accountId: roleplay.accountId, dataEpoch: roleplay.dataEpoch };
    if (roleplayHash(request.worldInfo.account) !== roleplayHash(account)
        || roleplayHash(request.worldInfo.source) !== roleplayHash(source)) throw invalid('The bound tool source differs from the accepted reply.');
    return { base, account, source, request };
}

function advancedToolSource(context, staged, index) {
    const { job, directories, owner } = context;
    const turn = job.intent.request.workflowCandidate?.turn ?? 0;
    const parentId = job.intent.request.workflowCandidate?.parentJobId;
    const parent = getJob(directories, parentId);
    const lineage = readArtifact(directories, parentId, `roleplay-workflow-lineage:${turn}:${index}`);
    const candidate = readArtifact(directories, job.id, 'roleplay-candidate');
    if (!Number.isSafeInteger(index) || index < 0 || index >= staged.calls.length - 1
        || !parent || parent.type !== 'media.roleplay-workflow' || parent.owner !== owner || parent.cancellation?.requested
        || roleplayHash(parent.intent) !== job.intent.request.workflowCandidate.parentIntentHash
        || job.parentId !== parent.id || !parent.children.includes(job.id)
        || !candidate || candidate.hash !== roleplayHash(Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== 'hash')))
        || candidate.callsHash !== staged.hash || lineage?.index !== index || lineage.hash !== roleplayHash(
        Object.fromEntries(Object.entries(lineage).filter(([key]) => key !== 'hash')))
        || lineage.account.accountId !== parent.intent.media.accountId || lineage.account.dataEpoch !== parent.intent.media.dataEpoch) {
        throw invalid('The parent cannot prove this tool source advancement.');
    }
    const verified = [];
    for (let step = 0; step <= index; step++) {
        const pointer = readArtifact(directories, parent.id, `roleplay-workflow-tool:${turn}:${step}`);
        const result = readBoundModelToolResult(context, step);
        if (!pointer || pointer.hash !== roleplayHash(Object.fromEntries(Object.entries(pointer).filter(([key]) => key !== 'hash')))
            || pointer.childJobId !== result.childJobId || pointer.candidateHash !== candidate.hash
            || !result.completed || !parent.children.includes(result.childJobId)) throw invalid('The previous tool result is not owned by this workflow.');
        verified.push({ childJobId: result.childJobId, callId: result.call.id, resultHash: roleplayHash(result.result) });
    }
    const identity = roleplayHash({ parentIntentHash: roleplayHash(parent.intent), candidateHash: candidate.hash,
        callsHash: staged.hash, results: verified });
    if (lineage.identity !== identity) throw invalid('The parent source advancement changed.');
    const base = { owner, directories }, account = { accountId: parent.intent.media.accountId, dataEpoch: parent.intent.media.dataEpoch };
    withRoleplayAccount(base, account, lease => assertRoleplaySourceLocked(lease, lineage.source));
    assertRoleplayWorldInfoCurrent(base, lineage.worldInfo);
    return lineage;
}

/** Stage only the model's actual saved provider response; client tool schemas or invented calls have no authority. */
export function stageBoundModelToolCalls(context, { lineageIndex } = {}) {
    const { base, account, source, request } = bound(context);
    const { job, directories } = context;
    const record = withRoleplayAccount(base, account, lease => {
        if (lineageIndex === undefined) assertRoleplaySourceLocked(lease, source);
        const reference = readArtifact(directories, job.id, 'roleplay-main-provider');
        const prompt = readArtifact(directories, job.id, 'roleplay-prompt');
        const quickReply = request.worldInfo.hookPolicy?.quickReply?.enabled && readArtifact(directories, job.id, 'roleplay-quick-replies');
        if (reference?.intentHash !== roleplayHash(job.intent) || !STEP.test(reference.step)
            || !prompt || reference.promptHash !== prompt.hash
            || prompt.hash !== roleplayPromptContentHash(prompt, request.worldInfo, { quickReply: Boolean(quickReply) })) {
            throw invalid('The saved main provider reference cannot authorise a tool call.');
        }
        const result = readArtifact(directories, job.id, reference.step);
        if (!result || typeof result.text !== 'string') throw invalid('The main provider result was not saved.');
        const allowed = request.worldInfo.tools.definitions.map(item => item.function?.name);
        const calls = normaliseRoleplayToolCalls(result, allowed);
        if (!calls.length) throw invalid('The saved model response contains no function tool calls.');
        const value = { version: 1, intentHash: roleplayHash(job.intent), providerStep: reference.step,
            providerResultHash: roleplayHash(result), promptHash: prompt.hash,
            toolBindingsHash: roleplayHash(request.worldInfo.tools), calls };
        if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024) throw invalid('The complete tool call list exceeds its saved capacity.');
        const saved = readArtifact(directories, job.id, 'roleplay-native-tool-calls');
        if (saved !== undefined) {
            const { hash, ...actual } = saved;
            if (hash !== roleplayHash(actual) || roleplayHash(actual) !== roleplayHash(value)) throw invalid('The saved tool call list changed.');
            return saved;
        }
        const staged = { ...value, hash: roleplayHash(value) };
        writeArtifact(directories, job.id, 'roleplay-native-tool-calls', staged);
        return staged;
    });
    if (lineageIndex === undefined) assertRoleplayWorldInfoCurrent(base, request.worldInfo);
    else advancedToolSource(context, record, lineageIndex);
    return record;
}

/** Accept one exact child call. The Stage 8 coordinator handles parent waiting, child release, and subsequent model turns. */
export function admitBoundModelToolCall(context, index, { lineageIndex } = {}) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= 32) throw invalid('The selected tool call index is invalid.');
    const { base, account, source, request } = bound(context);
    const { job, directories } = context;
    if (lineageIndex !== undefined && lineageIndex >= index) throw invalid('A later tool cannot use its own source as evidence.');
    const staged = stageBoundModelToolCalls(context, { lineageIndex });
    const call = staged.calls[index];
    if (!call) throw invalid('The model did not request this saved tool call.');
    const operationKey = `model-tool:${roleplayHash([job.id, index, call]).slice(0, 48)}`;
    const advanced = lineageIndex === undefined ? null : advancedToolSource(context, staged, lineageIndex);
    const boundSource = advanced?.source ?? source;
    const childSource = call.name === 'Pathfinder_Notebook' ? withRoleplayAccount(base, account, lease => {
        assertRoleplaySourceLocked(lease, boundSource);
        const captured = captureRoleplaySourceLocked(lease, { locator: boundSource.locator, groupId: boundSource.groupId });
        if (captured.changed) throw invalid('The notebook chat needs its protected source confirmed before work.');
        return captured.source;
    }) : boundSource;
    const input = { avatar: (advanced?.worldInfo ?? request.worldInfo).avatar, callId: call.id, args: call.arguments };
    const childRequest = call.name.startsWith('Neconyan_Assistant_')
        ? captureAssistantToolRequest(base, account, childSource, { ...input, name: call.name })
        : call.name === 'Pathfinder_Notebook'
            ? capturePathfinderNotebookRequest(base, account, childSource,
                { ...input, agentId: request.worldInfo.tools.pathfinder?.agentId })
            : capturePathfinderToolRequest(base, account, childSource,
                { ...input, name: call.name, agentId: request.worldInfo.tools.pathfinder?.agentId });
    const admitted = call.name.startsWith('Neconyan_Assistant_')
        ? admitAssistantToolJob(base, account, { operationKey, source: childSource, request: childRequest })
        : call.name === 'Pathfinder_Notebook'
            ? admitPathfinderNotebookJob(base, account, { operationKey, source: childSource, request: childRequest })
            : admitPathfinderToolJob(base, account, { operationKey, source: childSource, request: childRequest });
    const child = getJob(directories, admitted.jobId);
    if (!child || child.owner !== context.owner || child.intent?.request?.callId !== call.id
        || roleplayHash(child.intent.source) !== roleplayHash(childSource)
        || (child.intent.media ?? child.intent.roleplay)?.operationKey !== operationKey) {
        throw invalid('The child tool job does not carry the admitted call.');
    }
    const childReceiptHash = child.intent.roleplay ? roleplayHash({ accountId: account.accountId,
        dataEpoch: account.dataEpoch, intent: { effect: child.intent.effect, source: child.intent.source, request: child.intent.request } })
        : roleplayHash(child.intent);
    const value = { parentIntentHash: roleplayHash(job.intent), callsHash: staged.hash, index, call,
        childJobId: admitted.jobId, childIntentHash: roleplayHash(child.intent), childReceiptHash,
        childSourceHash: roleplayHash(childSource), operationKey,
        ...(child.intent.roleplay && child.intent.request.mutating ? { expectedResult: child.intent.request.notebook.action === 'write'
            ? `📓 Wrote "${child.intent.request.notebook.key.trim()}" to notebook.`
            : `📓 Deleted: ${child.intent.request.notebook.key.trim()}` } : {}) };
    const pointer = { ...value, hash: roleplayHash(value) };
    return withRoleplayAccount(base, account, () => {
        const key = `roleplay-native-tool-child:${index}`;
        const saved = readArtifact(directories, job.id, key);
        if (saved !== undefined && roleplayHash(saved) !== roleplayHash(pointer)) throw invalid('The saved child tool ownership changed.');
        if (saved === undefined) writeArtifact(directories, job.id, key, pointer);
        return { ...pointer, state: admitted.state, created: admitted.created };
    });
}

/** Prove a child's saved completion, even if the ordinary jobs ledger has already pruned it. */
export function readBoundModelToolResult(context, index) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= 32) throw invalid('The selected tool call index is invalid.');
    const { base, account } = bound(context);
    const { job, directories } = context;
    const { staged, pointer, reference, prompt, provider, quickReply } = withRoleplayAccount(base, account, () => {
        const savedReference = readArtifact(directories, job.id, 'roleplay-main-provider');
        return {
            staged: readArtifact(directories, job.id, 'roleplay-native-tool-calls'),
            pointer: readArtifact(directories, job.id, `roleplay-native-tool-child:${index}`),
            reference: savedReference,
            prompt: readArtifact(directories, job.id, 'roleplay-prompt'),
            provider: STEP.test(savedReference?.step) ? readArtifact(directories, job.id, savedReference.step) : null,
            quickReply: job.intent.request.worldInfo.hookPolicy?.quickReply?.enabled
                && readArtifact(directories, job.id, 'roleplay-quick-replies'),
        };
    });
    if (!staged || !pointer || !staged.calls?.[index]) throw invalid('The model tool call or child admission was not saved.');
    const { hash: stagedHash, ...savedCalls } = staged;
    const { hash: pointerHash, ...savedPointer } = pointer;
    if (stagedHash !== roleplayHash(savedCalls) || pointerHash !== roleplayHash(savedPointer)
        || pointer.parentIntentHash !== roleplayHash(job.intent) || pointer.callsHash !== staged.hash
        || pointer.index !== index || roleplayHash(pointer.call) !== roleplayHash(staged.calls[index])
        || staged.toolBindingsHash !== roleplayHash(job.intent.request.worldInfo.tools)
        || !prompt || staged.promptHash !== prompt.hash || reference?.promptHash !== prompt.hash
        || prompt.hash !== roleplayPromptContentHash(prompt, job.intent.request.worldInfo, { quickReply: Boolean(quickReply) })
        || reference?.intentHash !== roleplayHash(job.intent) || staged.providerStep !== reference.step
        || !provider || staged.providerResultHash !== roleplayHash(provider)) {
        throw invalid('The saved child tool ownership changed.');
    }
    const child = getJob(directories, pointer.childJobId);
    if (child && (child.owner !== context.owner || roleplayHash(child.intent) !== pointer.childIntentHash)) {
        throw invalid('The child tool job was replaced.');
    }
    const completion = pointer.call.name === 'Pathfinder_Notebook' && pointer.expectedResult !== undefined
        ? readRoleplayJobResultByIntentHash(base, account, { operationKey: pointer.operationKey,
            jobId: pointer.childJobId, intentHash: pointer.childReceiptHash })
        : readNativeMediaJobResult(base, account, { operationKey: pointer.operationKey,
            jobId: pointer.childJobId, intentHash: pointer.childReceiptHash });
    if (!completion) {
        if (!child) throw invalid('An unfinished tool job was pruned before its result was saved.');
        return { call: pointer.call, childJobId: pointer.childJobId, state: child.state, completed: false };
    }
    const result = pointer.expectedResult === undefined ? completion
        : { status: 'done', tool: pointer.call.name, callId: pointer.call.id, result: pointer.expectedResult, write: completion };
    return { call: pointer.call, childJobId: pointer.childJobId, state: 'completed', completed: true, result };
}

/** The parent releases only the already admitted child; it never creates work from an unbound model call. */
export function releaseBoundModelToolCall(context, index) {
    const result = readBoundModelToolResult(context, index);
    if (result.completed) return result;
    if (context.signal?.aborted || getJob(context.directories, context.job.id)?.cancellation?.requested) {
        throw invalid('The original Roleplay reply was cancelled before the tool could run.');
    }
    const { job } = releaseJob(context.directories, result.childJobId);
    return { ...result, state: job.state };
}
