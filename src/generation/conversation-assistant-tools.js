import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { attachOwnedChild, getJob, releaseChildJobs, setJobResume, updateJob } from '../jobs/store.js';
import { roleplayError, roleplayHash } from '../roleplay-store.js';
import { captureConversationAssistantSource } from './conversation-assistant-source.js';
import { captureAssistantToolRequest, admitAssistantToolJob } from './assistant-tool-jobs.js';
import { readNativeMediaJobResult } from './media-jobs.js';
import { ASSISTANT_TOOL_NAMES, nativeToolDefinitions } from './native-tool-definitions.js';
import { normaliseRoleplayToolCalls } from './roleplay-tool-calls.js';

const invalid = message => roleplayError('CONVERSATION_ASSISTANT_TOOLS', message, 409);
const stopped = new Set(['failed', 'interrupted', 'conflict', 'cancelled']);
const MAX_ROUNDS = 8;

function savedStep(context, key, identity) {
    const saved = readArtifact(context.directories, context.job.id, key);
    if (saved === undefined) return null;
    const { hash, ...record } = saved;
    if (hash !== roleplayHash(record) || record.identity !== identity) throw invalid('The saved Conversation tool step changed.');
    return record.value;
}

function saveStep(context, key, identity, value) {
    const record = { identity, value };
    writeArtifact(context.directories, context.job.id, key, { ...record, hash: roleplayHash(record) });
    return value;
}

/** Each tool is a retained child job. Waiting for approval never occupies a provider slot. */
export async function generateConversationAssistantReply(context, snapshot, options, generate) {
    const base = { owner: context.owner, directories: context.directories };
    const account = snapshot.assistantTools.account;
    const parentIntentHash = roleplayHash(context.job.intent);
    const history = [];
    let totalCalls = 0;
    for (let round = 0; round <= MAX_ROUNDS; round += 1) {
        context.signal.throwIfAborted();
        const identity = roleplayHash({ parentIntentHash, snapshot, history, round });
        const responseKey = `assistant-response:${round}`;
        let response = savedStep(context, responseKey, identity);
        if (!response) {
            captureConversationAssistantSource(context, snapshot);
            setJobResume(context.directories, context.job.id, 'assistant-tools');
            response = await generate({ ...options, messages: [...options.messages, ...history],
                functionTools: round < MAX_ROUNDS ? nativeToolDefinitions(ASSISTANT_TOOL_NAMES) : [],
                generationType: 'normal', stepNamespace: `conversation-assistant:${round}` });
            saveStep(context, responseKey, identity, response);
        }
        const calls = normaliseRoleplayToolCalls(response, ASSISTANT_TOOL_NAMES);
        if (!calls.length) return response;
        totalCalls += calls.length;
        if (round === MAX_ROUNDS || totalCalls > 128) throw invalid('The assistant reached the tool-call limit for this reply.');
        const results = [];
        // Sequential admission permits several calls to the same saved resource
        // without reserving conflicting edits or accepting stale read results.
        for (const [index, call] of calls.entries()) {
            const key = `assistant-child:${round}:${index}`;
            const childIdentity = roleplayHash({ identity, response, call, index });
            let accepted = savedStep(context, key, childIdentity);
            if (!accepted) {
                const source = captureConversationAssistantSource(context, snapshot);
                const request = captureAssistantToolRequest(base, account, source, {
                    avatar: snapshot.speaker.avatar, name: call.name, args: call.arguments, callId: call.id,
                });
                accepted = saveStep(context, key, childIdentity, { source, request,
                    operationKey: `conversation-assistant:${context.job.id}:${round}:${index}` });
            }
            const admission = admitAssistantToolJob(base, account, accepted);
            const child = getJob(context.directories, admission.jobId);
            const intentHash = roleplayHash({ media: { ...account, operationKey: accepted.operationKey },
                source: accepted.source, kind: 'assistant-tool', request: accepted.request, target: accepted.request.target });
            if (!child || roleplayHash(child.intent) !== intentHash) throw invalid('The accepted Conversation tool child is unavailable.');
            attachOwnedChild(context.directories, context.job.id, child.id, { parentIntentHash, childIntentHash: intentHash });
            const result = readNativeMediaJobResult(base, account, { operationKey: accepted.operationKey, jobId: child.id, intentHash });
            if (result === null) {
                if (stopped.has(child.state)) throw invalid('The assistant tool needs recovery before this reply can continue.');
                setJobResume(context.directories, context.job.id, 'assistant-tools');
                releaseChildJobs(context.directories, context.job.id);
                return null;
            }
            if (result.callId !== call.id || result.tool !== call.name) throw invalid('The saved assistant result belongs to a different tool call.');
            results.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result.result ?? { status: result.status }) });
        }
        history.push({ role: 'assistant', content: '', tool_calls: calls.map(call => ({
            id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })) }, ...results);
        if (Buffer.byteLength(JSON.stringify(history)) > 2 * 1024 * 1024) throw invalid('The Conversation assistant tool history is full.');
    }
    throw invalid('The assistant could not finish its reply.');
}

/** Resume only when every accepted child has settled; an uncertain effect needs explicit recovery. */
export function reconcileConversationAssistantTools(directories, job) {
    if (job.state !== 'waiting' || job.stage !== 'children' || job.cancellation?.requested) return false;
    const children = (job.children || []).map(id => getJob(directories, id));
    if (!children.length || children.some(child => !child || child.parentId !== job.id || child.type !== 'media.assistant-tool')) return false;
    if (children.some(child => stopped.has(child.state))) {
        updateJob(directories, job.id, { state: 'interrupted', stage: 'child-needs-recovery', recoverability: 'needs-retry', finishedAt: Date.now() });
    } else if (children.every(child => child.state === 'completed')) {
        updateJob(directories, job.id, { state: 'queued', stage: 'children-completed', finishedAt: null });
    } else return false;
    return true;
}
