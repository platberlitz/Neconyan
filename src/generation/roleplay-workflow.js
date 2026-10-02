import { roleplayError, roleplayHash } from '../roleplay-store.js';
import { assertRoleplaySourceLocked, captureRoleplayStorageSourceLocked } from './roleplay-source.js';
import { captureRoleplayWorldInfo } from './world-info.js';
import { getChatProfileContextLimit, resolveGenerationProfile } from './profiles.js';
import { admitRoleplayJob, previewRoleplayWorkflowEffect, readRoleplayJobResult } from '../roleplay-jobs.js';
import { roleplayNativeHost } from '../endpoints/chats.js';
import { commitSingleChatWriteLocked } from '../roleplay-lifecycle.js';
import { attachOwnedChild, getJob, releaseChildJobs, updateJob } from '../jobs/store.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { saveRoleplayPromptContributions, validateRoleplayToolHistory } from './roleplay-contributions.js';
import { admitBoundModelToolCall, readBoundModelToolResult, releaseBoundModelToolCall } from './roleplay-tool-dispatch.js';
import { admitNativeMediaJob, finishNativeMediaJob, withNativeMediaReceipt } from './media-jobs.js';
import { readRoleplayWorkflowRecords, writeRoleplayWorkflowRecords } from './roleplay-workflow-records.js';
import { captureWorkflowToolLineage } from './roleplay-workflow-lineage.js';
import { captureRoleplaySourceLocked } from './roleplay-source.js';
import { captureRoleplayWorkflowPolicy, decideRoleplayWorkflowCandidate } from './roleplay-workflow-policy.js';
import { captureRoleplayGroupSpeakers } from './roleplay-workflow-groups.js';
import { addWorkflowAlternatives, collectWorkflowAlternatives } from './roleplay-workflow-alternatives.js';
import { captureRoleplayWorkflowCapacity, MAX_WORKFLOW_CHAT_BYTES } from './roleplay-workflow-capacity.js';
import { assertRoleplayNamedWorkflow, ROLEPLAY_WORKFLOW_NAMES, roleplayWorkflowContributions, roleplayWorkflowResultFacts } from './roleplay-workflow-named.js';
import { roleplayEffectTrigger } from './roleplay-prompt.js';
import { registerHandler } from '../jobs/runner.js';

const error = (message, code = 'ROLEPLAY_WORKFLOW_RECOVERY') => roleplayError(code, message, 409);
const CHILD = 'roleplay-workflow-child';
const FINAL = 'roleplay-workflow-final';
const MAX_TURNS = 16;
/** The accepted ceiling for one Roleplay workflow reply, aligned with the execution guard. */
export const MAX_WORKFLOW_TOKENS = 64000;
const childKey = turn => turn === 0 ? CHILD : `${CHILD}:${turn}`;
const historyKey = turn => `roleplay-workflow-history:${turn}`;
const decisionKey = turn => `roleplay-workflow-decision:${turn}`;
const speakerKey = index => `roleplay-workflow-speaker:${index}`;

export function captureRoleplayWorkflowRequest(base, account, source, { avatar, binding, maxTokens = 128,
    effect = 'append', named = null, forcedAvatars, selectedSpeakerAvatar, random, generationId } = {}) {
    if (named) {
        assertRoleplayNamedWorkflow(named);
        effect = named.effect;
    }
    if (named && source.locator.group) throw error('A named workflow answers one speaker, not a group turn.', 'ROLEPLAY_WORKFLOW_INVALID');
    if (!['append', 'continue', 'swipe', 'alternative', 'replace'].includes(effect)
        || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_WORKFLOW_TOKENS || !binding?.fingerprint) {
        throw error('The saved workflow selection is invalid.', 'ROLEPLAY_WORKFLOW_INVALID');
    }
    const contextLimit = getChatProfileContextLimit(base.directories, binding);
    if (!Number.isSafeInteger(contextLimit) || contextLimit <= maxTokens + 128) {
        throw error('The saved workflow model needs a bound context limit.', 'ROLEPLAY_WORKFLOW_INVALID');
    }
    const group = source.locator.group ? captureRoleplayGroupSpeakers(base, account, source,
        { effect, forcedAvatars, selectedSpeakerAvatar, random, generationId }) : null;
    if (group && group.speakers.length > MAX_TURNS) throw error('The saved group needs more bounded speaker turns.', 'ROLEPLAY_WORKFLOW_CAPACITY');
    const selectedAvatar = group?.speakers[0]?.avatar ?? avatar;
    if (source.locator.group ? avatar && avatar !== selectedAvatar : avatar !== source.locator.avatar) {
        throw error('The selected speaker differs from the protected source.', 'ROLEPLAY_WORKFLOW_INVALID');
    }
    const options = { maxContext: contextLimit - maxTokens, trigger: roleplayEffectTrigger(effect),
        promptEffect: effect, serverPrompt: true };
    const speakers = group?.speakers.map(speaker => ({ ...speaker,
        worldInfo: captureRoleplayWorldInfo(base, account, source, { ...options, avatar: speaker.avatar }) }));
    const worldInfo = speakers?.[0]?.worldInfo ?? captureRoleplayWorldInfo(base, account, source, { ...options, avatar: selectedAvatar });
    // Story, Guided and Deep Swipe ask for one specific generation, so only the plain
    // controls capture the automatic policy that keeps a whole turn running.
    const automatic = named && !ROLEPLAY_WORKFLOW_NAMES[named.name].automatic ? null
        : captureRoleplayWorkflowPolicy(base, account, source, worldInfo, { backend: binding.backend === 'text' ? 'text' : 'chat' });
    const companionBytes = Math.max(worldInfo.companionCapacity?.requiredBytes ?? 0,
        ...(speakers?.map(speaker => speaker.worldInfo.companionCapacity?.requiredBytes ?? 0) ?? []));
    const capacity = captureRoleplayWorkflowCapacity(base, account, source, { companionBytes });
    const stream = (!binding.backend || binding.backend === 'chat')
        && resolveGenerationProfile(base.directories, binding).active?.stream_openai === true;
    return { version: 1, avatar: selectedAvatar, effect, binding, maxTokens, worldInfo, stream,
        capacity,
        ...(named ? { named } : {}),
        ...(group ? { group: { ...group, speakers } } : {}),
        ...(automatic ? { automatic } : {}) };
}

export function admitRoleplayWorkflowJob(base, account, { operationKey, source, request }) {
    if (request?.version !== 1 || !['append', 'continue', 'swipe', 'alternative', 'replace'].includes(request.effect)
        || !request.worldInfo || roleplayHash(request.worldInfo.source) !== roleplayHash(source)
        || !request.capacity || request.capacity.hash !== roleplayHash(Object.fromEntries(
        Object.entries(request.capacity).filter(([key]) => key !== 'hash')))
        || request.capacity.version !== 1 || request.capacity.maxTurns !== MAX_TURNS
        || request.capacity.limitBytes !== MAX_WORKFLOW_CHAT_BYTES
        || request.capacity.companionBytes !== Math.max(request.worldInfo.companionCapacity?.requiredBytes ?? 0,
            ...(request.group?.speakers?.map(speaker => speaker.worldInfo?.companionCapacity?.requiredBytes ?? 0) ?? []))
        || request.capacity.sourceHash !== roleplayHash(source)
        || request.capacity.accountId !== account.accountId || request.capacity.dataEpoch !== account.dataEpoch
        || Boolean(request.group) !== Boolean(source.locator.group)
        || request.group && (request.group.sourceHash !== roleplayHash(source)
            || request.group.speakers?.[0]?.avatar !== request.avatar
            || request.group.speakers.length > MAX_TURNS || request.group.speakers.some(speaker => !speaker.worldInfo
                || roleplayHash(speaker.worldInfo.source) !== roleplayHash(source))
            || request.group.hash !== roleplayHash({ version: request.group.version, groupId: request.group.groupId,
                sourceHash: request.group.sourceHash, generationId: request.group.generationId,
                speakers: request.group.speakers.map(({ worldInfo: _worldInfo, ...speaker }) => speaker), strategy: request.group.strategy }))) {
        throw error('The saved workflow request changed before admission.', 'ROLEPLAY_WORKFLOW_INVALID');
    }
    if (roleplayHash(captureRoleplayWorkflowCapacity(base, account, source,
        { companionBytes: request.capacity.companionBytes })) !== roleplayHash(request.capacity)) {
        throw error('The saved workflow chat capacity changed before admission.', 'ROLEPLAY_WORKFLOW_INVALID');
    }
    if (request.named !== undefined) {
        if (request.group) throw error('A named workflow answers one speaker, not a group turn.', 'ROLEPLAY_WORKFLOW_INVALID');
        assertRoleplayNamedWorkflow(request.named, { effect: request.effect });
        if (request.automatic && !ROLEPLAY_WORKFLOW_NAMES[request.named.name].automatic) {
            throw error('This named workflow runs one bounded model turn.', 'ROLEPLAY_WORKFLOW_INVALID');
        }
    }
    return admitNativeMediaJob(base, account, { operationKey, source, kind: 'roleplay-workflow', request,
        target: { kind: 'chat', id: source.instanceId } });
}

function root(context) {
    const job = getJob(context.directories, context.job.id);
    if (!job || job.type !== 'media.roleplay-workflow' || job.owner !== context.owner || job.cancellation?.requested
        || job.intent?.request?.version !== 1 || job.intent?.source?.instanceId !== job.intent?.target?.id) {
        throw error('The saved workflow needs its original account and intent.');
    }
    return job;
}

function childRequest(job, turn = 0, history = [], lineage = null, decision = null, speakerIndex = 0) {
    const request = job.intent.request;
    const speaker = request.group?.speakers[speakerIndex];
    if (request.group && (!speaker || speaker.avatar !== (lineage?.worldInfo?.avatar ?? speaker.worldInfo.avatar))) {
        throw error('The saved group speaker changed.');
    }
    const worldInfo = lineage?.worldInfo ?? speaker?.worldInfo ?? request.worldInfo;
    const candidate = { version: 1, parentJobId: job.id, parentIntentHash: roleplayHash(job.intent) };
    if (turn) Object.assign(candidate, { turn, historyHash: roleplayHash(history) });
    if (lineage) candidate.lineageHash = lineage.hash;
    if (decision) candidate.decisionHash = decision.hash;
    if (request.group) Object.assign(candidate, { groupHash: request.group.hash, speakerIndex });
    return { binding: request.binding, maxTokens: request.maxTokens, serverPrompt: true,
        ...(request.stream !== undefined ? { stream: request.stream } : {}),
        characterName: worldInfo.speakerNames.character, worldInfo, messages: [],
        ...(speaker?.modelOverride ? { modelOverride: speaker.modelOverride } : {}),
        workflowCandidate: candidate };
}

function savedChild(context, job, turn = 0) {
    const data = readArtifact(context.directories, job.id, childKey(turn));
    if (data === undefined) return null;
    const parent = getJob(context.directories, job.id);
    const { hash, ...record } = data;
    if (hash !== roleplayHash(record) || record.parentIntentHash !== roleplayHash(job.intent)
        || !record.jobId || !record.operationKey || !record.requestHash) throw error('The saved workflow child differs from its accepted request.');
    const child = getJob(context.directories, record.jobId);
    if (!parent || parent.owner !== job.owner || roleplayHash(parent.intent) !== roleplayHash(job.intent)
        || parent.cancellation?.requested || !child || child.parentId !== job.id || !parent.children.includes(child.id) || child.owner !== job.owner
        || child.type !== 'roleplay.candidate' || roleplayHash(child.intent.request) !== record.requestHash
        || child.intent.roleplay.operationKey !== record.operationKey) throw error('The saved workflow child needs recovery.');
    return { record, child };
}

function acceptedChild(context, job, turn = 0, history = [], lineage = null, decision = null, speakerIndex = 0) {
    if (turn < 0 || turn >= MAX_TURNS) throw error('The saved workflow needs a bounded model turn.', 'ROLEPLAY_WORKFLOW_CAPACITY');
    if (turn) validateRoleplayToolHistory(history, { allowMedia: false, maxMessages: 8192 });
    const request = childRequest(job, turn, history, lineage, decision, speakerIndex);
    const speaker = job.intent.request.group?.speakers[speakerIndex];
    // A named workflow publishes its saved prompts on every model turn it runs.
    const named = job.intent.request.named ?? null;
    const contributions = roleplayWorkflowContributions(named, { speaker, speakerIndex, history });
    const published = Boolean(turn) || Boolean(speaker) || Boolean(named);
    const source = lineage?.source ?? job.intent.source;
    const existing = savedChild(context, job, turn);
    if (existing) {
        if (existing.record.requestHash !== roleplayHash(request) || roleplayHash(existing.child.intent.source) !== roleplayHash(source)) {
            throw error('The accepted workflow model turn changed.');
        }
        if (published) saveRoleplayPromptContributions({ ...context, job: existing.child }, contributions);
        return existing;
    }
    const account = job.intent.media;
    const base = { owner: context.owner, directories: context.directories };
    const operationKey = `workflow:${job.id}:candidate:${turn}`;
    const admitted = admitRoleplayJob(base, account, { operationKey, source,
        effect: job.intent.request.effect, request, type: 'roleplay.candidate' });
    const child = getJob(context.directories, admitted.jobId);
    attachOwnedChild(context.directories, job.id, admitted.jobId,
        { parentIntentHash: roleplayHash(job.intent), childIntentHash: roleplayHash(child.intent) });
    const record = { parentIntentHash: roleplayHash(job.intent), jobId: admitted.jobId,
        operationKey, requestHash: roleplayHash(request) };
    writeArtifact(context.directories, job.id, childKey(turn), { ...record, hash: roleplayHash(record) });
    if (published) saveRoleplayPromptContributions({ ...context, job: child }, contributions);
    return savedChild(context, job, turn);
}

function selectedCandidate(context, job, child) {
    const base = { owner: context.owner, directories: context.directories };
    const completion = readRoleplayJobResult(base, job.intent.media, { operationKey: child.intent.roleplay.operationKey,
        jobId: child.id, effect: child.intent.effect, source: child.intent.source, request: child.intent.request });
    if (!completion || completion.kind !== 'candidate' || !['text', 'tool-turn'].includes(completion.turnKind)) {
        throw error('The saved workflow candidate has not completed a supported result.');
    }
    const candidate = readArtifact(context.directories, child.id, completion.candidateArtifact);
    const { hash, ...content } = candidate ?? {};
    if (hash !== completion.proofHash || hash !== roleplayHash(content) || content.intentHash !== roleplayHash(child.intent)
        || content.kind !== completion.turnKind || content.kind === 'text' && !content.output
        || content.kind === 'tool-turn' && !content.callsHash) throw error('The saved workflow candidate result changed.');
    return { completion, candidate, child };
}

function candidateText(output) {
    const text = output?.message?.mes ?? output?.messages?.[0]?.mes ?? output?.text;
    if (typeof text !== 'string' || Buffer.byteLength(text) > 256 * 1024) {
        throw error('The saved progressive reply is missing bounded text.');
    }
    return text;
}

function combinedCandidateOutput(previous, current, effect) {
    if (!previous) return current;
    const first = candidateText(previous), second = candidateText(current);
    if (Buffer.byteLength(first + second) > 256 * 1024) throw error('The combined reply exceeds its saved capacity.', 'ROLEPLAY_WORKFLOW_CAPACITY');
    const output = structuredClone(current);
    if (effect === 'append') {
        if (previous.message?.name !== output.message?.name || previous.message?.is_user !== false
            || output.message?.is_user !== false) throw error('The saved speaker changed during a continuation.');
        output.message.mes = first + second;
    } else if (effect === 'replace') {
        if (previous.messages?.length !== 1 || output.messages?.length !== 1
            || previous.messages[0].name !== output.messages[0].name) throw error('The saved replacement speaker changed.');
        output.messages[0].mes = first + second;
    } else {
        output.text = first + second;
        if (effect === 'continue' && previous.continuedText !== undefined) {
            if (typeof previous.continuedText !== 'string' || previous.continuedText.length > 256 * 1024) {
                throw error('The saved continued reply changed.');
            }
            output.continuedText = previous.continuedText + second;
        }
    }
    return output;
}

async function savedTextDecision(context, job, chosen, turn, output, fullText, decide = decideRoleplayWorkflowCandidate) {
    const policy = job.intent.request.automatic;
    if (!policy) return { kind: 'final' };
    const record = { parentIntentHash: roleplayHash(job.intent), childJobId: chosen.child.id,
        candidateHash: chosen.candidate.hash, turn, outputHash: roleplayHash(output) };
    const saved = readArtifact(context.directories, job.id, decisionKey(turn));
    if (saved !== undefined) {
        const { hash, ...content } = saved;
        const selectedText = output?.message?.mes ?? output?.messages?.[0]?.mes ?? output?.continuedText ?? output?.text;
        if (hash !== roleplayHash(content) || Object.entries(record).some(([key, value]) => roleplayHash(content[key]) !== roleplayHash(value))
            || !['swipe', 'continue', 'final'].includes(content.decision?.kind)
            || content.decision.textHash !== roleplayHash(selectedText)) {
            throw error('The saved automatic reply decision changed.');
        }
        return saved;
    }
    const decided = await decide(policy, output, { tokenizer: job.intent.request.worldInfo.tokenizer, fullText });
    const value = { ...record, decision: decided, hash: roleplayHash({ ...record, decision: decided }) };
    writeArtifact(context.directories, job.id, decisionKey(turn), value);
    return value;
}

function rejectedSwipeHistory(history, chosen, decision, turn) {
    if (decision.decision.kind !== 'swipe') throw error('An automatic alternative needs its saved filter decision.');
    const message = chosen.candidate.output.message ?? chosen.candidate.output.messages?.[0];
    const text = message?.mes ?? chosen.candidate.output.continuedText ?? chosen.candidate.output.text;
    if (typeof text !== 'string' || roleplayHash(text) !== decision.decision.textHash) {
        throw error('The rejected reply differs from its saved model result.');
    }
    const result = [...history, { role: 'assistant', content: text },
        { role: 'user', content: 'Generate an alternative reply to the previous response. Keep the selected speaker and existing conversation.' }];
    validateRoleplayToolHistory(result, { allowMedia: false, maxMessages: 8192 });
    if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024 || turn + 1 >= MAX_TURNS) {
        throw error('The automatic alternatives need a reviewed selection.', 'ROLEPLAY_WORKFLOW_CAPACITY');
    }
    return result;
}

function continuedHistory(history, chosen, decision, turn, assembled = chosen.candidate.output) {
    if (decision.decision.kind !== 'continue') throw error('A continuation needs its saved decision.');
    const text = candidateText(chosen.candidate.output);
    if (roleplayHash(candidateText(assembled)) !== decision.decision.textHash) {
        throw error('The continued chunk changed after its decision.');
    }
    const result = [...history, { role: 'assistant', content: text },
        { role: 'user', content: 'Continue the same reply as the same speaker. Do not repeat the saved text.' }];
    validateRoleplayToolHistory(result, { allowMedia: false, maxMessages: 8192 });
    if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024 || turn + 1 >= MAX_TURNS) {
        throw error('The automatic continuation needs a reviewed selection.', 'ROLEPLAY_WORKFLOW_CAPACITY');
    }
    return result;
}

function savedToolHistory(context, job, chosen, turn, priorHistory) {
    const childContext = { ...context, job: chosen.child };
    const calls = readArtifact(context.directories, chosen.child.id, 'roleplay-native-tool-calls');
    if (!calls?.calls?.length || calls.hash !== chosen.candidate.callsHash || calls.calls.length > 32) {
        throw error('The saved workflow tool turn changed.');
    }
    const results = [];
    let latestLineage = null;
    for (const [index, call] of calls.calls.entries()) {
        const key = `roleplay-workflow-tool:${turn}:${index}`;
        const saved = readArtifact(context.directories, job.id, key);
        if (saved === undefined) admitBoundModelToolCall(childContext, index,
            latestLineage ? { lineageIndex: latestLineage.index } : {});
        const pointer = readArtifact(context.directories, chosen.child.id, `roleplay-native-tool-child:${index}`);
        if (!pointer || pointer.hash !== roleplayHash(Object.fromEntries(Object.entries(pointer).filter(([name]) => name !== 'hash')))) {
            throw error('The saved workflow tool pointer changed.');
        }
        const child = getJob(context.directories, pointer.childJobId);
        if (!child) throw error('The accepted workflow tool is missing.');
        attachOwnedChild(context.directories, job.id, child.id,
            { parentIntentHash: roleplayHash(job.intent), childIntentHash: roleplayHash(child.intent) });
        const record = { parentIntentHash: roleplayHash(job.intent), candidateHash: chosen.candidate.hash,
            callsHash: calls.hash, turn, index, toolPointerHash: pointer.hash,
            childJobId: child.id, childIntentHash: roleplayHash(child.intent) };
        if (saved !== undefined && roleplayHash(saved) !== roleplayHash({ ...record, hash: roleplayHash(record) })) {
            throw error('The saved workflow tool ownership changed.');
        }
        if (saved === undefined) writeArtifact(context.directories, job.id, key, { ...record, hash: roleplayHash(record) });
        const result = readBoundModelToolResult(childContext, index);
        if (!result.completed) {
            releaseBoundModelToolCall(childContext, index);
            releaseChildJobs(context.directories, job.id);
            return { waiting: true, childJobId: child.id };
        }
        if (result.childJobId !== child.id || roleplayHash(result.call) !== roleplayHash(call)) {
            throw error('The saved workflow tool result changed.');
        }
        results.push(result);
        const advanced = captureWorkflowToolLineage(context, { parent: job, candidate: chosen, turn, index, calls,
            results, previousSource: latestLineage?.source ?? chosen.child.intent.source });
        if (advanced) latestLineage = advanced;
    }
    const messages = [{ role: 'assistant', content: '', tool_calls: calls.calls.map(call => ({
        id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    })) }, ...results.map(result => ({ role: 'tool', tool_call_id: result.call.id, content: JSON.stringify(result.result) }))];
    const history = [...priorHistory, ...messages];
    validateRoleplayToolHistory(history, { allowMedia: false, maxMessages: 8192 });
    const record = { parentIntentHash: roleplayHash(job.intent), candidateHash: chosen.candidate.hash,
        callsHash: calls.hash, turn, history, resultHashes: results.map(result => roleplayHash(result.result)) };
    if (Buffer.byteLength(JSON.stringify(record)) > 2 * 1024 * 1024) throw error('The saved workflow tool history exceeds its accepted capacity.',
        'ROLEPLAY_WORKFLOW_CAPACITY');
    const saved = readArtifact(context.directories, job.id, historyKey(turn));
    const value = { ...record, hash: roleplayHash(record) };
    if (saved !== undefined && roleplayHash(saved) !== roleplayHash(value)) throw error('The saved workflow tool history changed.');
    if (saved === undefined) writeArtifact(context.directories, job.id, historyKey(turn), value);
    const lineage = captureWorkflowToolLineage(context, { parent: job, candidate: chosen, turn, calls, results,
        previousSource: chosen.child.intent.source }) ?? latestLineage;
    return { history, lineage };
}

function finalPlan(context, job, chosen, { key = FINAL, speakerIndex = null, priorSpeaker = null, alternatives = [] } = {}) {
    const saved = readArtifact(context.directories, job.id, key);
    if (saved !== undefined) {
        const { hash, ...record } = saved;
        if (hash !== roleplayHash(record) || record.parentIntentHash !== roleplayHash(job.intent)
            || record.candidateHash !== chosen.candidate.hash || record.childJobId !== chosen.child.id
            || record.speakerIndex !== (speakerIndex ?? undefined)
            || record.alternativesHash !== (alternatives.length ? roleplayHash(alternatives) : undefined)
            || record.outputHash !== undefined && record.outputHash !== roleplayHash(chosen.output)
            || Boolean(record.named) !== Boolean(job.intent.request.named)) {
            throw error('The saved workflow delivery changed.');
        }
        return record;
    }
    const source = chosen.child.intent.source;
    const before = withNativeMediaReceipt(context, ({ lease }) => {
        const effect = job.intent.request.effect;
        const selected = previewRoleplayWorkflowEffect(lease, { source, effect, output: chosen.output,
            request: chosen.child.intent.request, job: chosen.child });
        const original = assertRoleplaySourceLocked(lease, source, { effect }).records;
        const records = addWorkflowAlternatives(selected, source, effect, chosen.output, original, alternatives);
        const { source: storage } = captureRoleplayStorageSourceLocked(lease, source.locator);
        if (priorSpeaker && (storage.rawHash !== priorSpeaker.result.rawHash
            || storage.instanceId !== priorSpeaker.result.instanceId || storage.revision !== priorSpeaker.result.revision)) {
            throw error('The previous group speaker is not the saved completed chat.');
        }
        return { records, storage, original };
    }, { checkSource: false });
    const named = job.intent.request.named ? roleplayWorkflowResultFacts(job.intent.request.named,
        { before: before.original, after: before.records, messageIndex: source.message?.index ?? source.range?.start ?? null }) : null;
    if (job.intent.request.named && !named) throw error('The saved named workflow result changed.', 'ROLEPLAY_WORKFLOW_INVALID');
    const recordBytes = Buffer.byteLength(before.records.map(record => JSON.stringify(record)).join('\n'));
    if (recordBytes > (job.intent.request.capacity?.limitBytes ?? MAX_WORKFLOW_CHAT_BYTES)) {
        throw error('The finished reply exceeds its protected chat capacity.', 'ROLEPLAY_WORKFLOW_CAPACITY');
    }
    const proof = writeRoleplayWorkflowRecords(context, job.intent.media, before.records, speakerIndex);
    const record = { parentIntentHash: roleplayHash(job.intent), childJobId: chosen.child.id,
        candidateHash: chosen.candidate.hash, recordsHash: proof.recordsHash, recordsDigest: proof.digest,
        storage: before.storage, writeKey: speakerIndex === null ? `workflow:${job.id}:publish` : `workflow:${job.id}:speaker:${speakerIndex}`,
        ...(speakerIndex === null ? {} : { speakerIndex }),
        ...(named ? { named } : {}),
        ...(alternatives.length ? { alternativesHash: roleplayHash(alternatives) } : {}),
        ...(chosen.output !== chosen.candidate.output ? { outputHash: roleplayHash(chosen.output) } : {}),
        ...(roleplayHash(source) !== roleplayHash(job.intent.source) ? { sourceHash: roleplayHash(source) } : {}) };
    const value = { ...record, hash: roleplayHash(record) };
    const previous = readArtifact(context.directories, job.id, key);
    if (previous !== undefined && roleplayHash(previous) !== roleplayHash(value)) throw error('The saved workflow delivery changed.');
    if (previous === undefined) writeArtifact(context.directories, job.id, key, value);
    return record;
}

function publishPlan(context, job, chosen, plan, { effectId = 'final', proof = null } = {}) {
    const saved = readRoleplayWorkflowRecords(context, job.intent.media, proof);
    if (saved.proof.recordsHash !== plan.recordsHash || saved.proof.digest !== plan.recordsDigest) throw error('The saved workflow chat changed.');
    return withNativeMediaReceipt(context, ({ lease, value, save }) => {
        if (context.signal?.aborted || getJob(context.directories, job.id)?.cancellation?.requested) {
            throw error('The saved workflow was cancelled before its protected chat write.');
        }
        const prior = value.effects[effectId];
        if (prior && (prior.candidateHash !== plan.candidateHash || prior.recordsHash !== plan.recordsHash
            || prior.writeKey !== plan.writeKey || !['writing', 'done'].includes(prior.state))) throw error('The saved workflow write differs.');
        if (!prior) {
            assertRoleplaySourceLocked(lease, chosen.child.intent.source, { effect: job.intent.request.effect });
            value.effects[effectId] = { state: 'writing', candidateHash: plan.candidateHash,
                recordsHash: plan.recordsHash, writeKey: plan.writeKey };
            save();
        }
        const result = commitSingleChatWriteLocked(lease, { operationKey: plan.writeKey, mode: 'update',
            sourceKind: 'storage', source: plan.storage, records: saved.records,
            allowShrink: job.intent.request.effect === 'replace', backup: { deferBackup: true } }, roleplayNativeHost);
        if (prior?.state === 'done' && roleplayHash(prior.result) !== roleplayHash(result)) throw error('The saved workflow write changed.');
        value.effects[effectId] = { state: 'done', candidateHash: plan.candidateHash,
            recordsHash: plan.recordsHash, writeKey: plan.writeKey, result };
        save();
        return result;
    }, { checkSource: false });
}

function completedSpeaker(context, job, index, previous = null) {
    const saved = readArtifact(context.directories, job.id, speakerKey(index));
    if (saved === undefined) return null;
    const { hash, ...record } = saved;
    if (hash !== roleplayHash(record) || record.parentIntentHash !== roleplayHash(job.intent) || record.index !== index
        || record.previousHash !== (previous?.hash ?? null) || record.avatar !== job.intent.request.group?.speakers[index]?.avatar
        || !record.result || !record.candidateHash || !record.planHash
        || !Number.isSafeInteger(record.turnEnd) || record.turnEnd <= index || record.turnEnd > MAX_TURNS) {
        throw error('The saved group speaker completion changed.');
    }
    const proof = readRoleplayWorkflowRecords(context, job.intent.media, index);
    const plan = readArtifact(context.directories, job.id, `${FINAL}:${index}`);
    const media = withNativeMediaReceipt(context, ({ value }) => value.effects[`speaker:${index}`], { checkSource: false });
    const { hash: planHash, ...planRecord } = plan ?? {};
    if (proof.proof.recordsHash !== plan?.recordsHash || planHash !== roleplayHash(planRecord)
        || planHash !== record.planHash
        || media?.state !== 'done' || roleplayHash(media.result) !== roleplayHash(record.result)
        || media.candidateHash !== record.candidateHash) throw error('The saved group speaker needs its owned write proof.');
    return saved;
}

function advanceSpeaker(context, job, chosen, index, turnEnd, previous = null, alternatives = []) {
    const prior = completedSpeaker(context, job, index, previous);
    if (prior) return prior;
    const accepted = job.intent.request.group.speakers[index];
    if (chosen.child.intent.request.worldInfo.avatar !== accepted.avatar || chosen.candidate.kind !== 'text') {
        throw error('The saved group speaker differs from its accepted turn.');
    }
    const output = structuredClone(chosen.output ?? chosen.candidate.output);
    const message = output.message ?? output.messages?.[0];
    if (message) {
        message.force_avatar = accepted.avatar;
        message.original_avatar = accepted.avatar;
        message.extra = { ...message.extra, gen_id: job.intent.request.group.generationId };
    } else if (job.intent.request.effect !== 'append') {
        output.extra = { ...output.extra, gen_id: job.intent.request.group.generationId };
    }
    chosen.output = output;
    const plan = finalPlan(context, job, chosen, { key: `${FINAL}:${index}`, speakerIndex: index,
        priorSpeaker: previous, alternatives });
    const result = publishPlan(context, job, chosen, plan, { effectId: `speaker:${index}`, proof: index });
    const record = { parentIntentHash: roleplayHash(job.intent), previousHash: previous?.hash ?? null,
        index, turnEnd, avatar: accepted.avatar, childJobId: chosen.child.id, candidateHash: plan.candidateHash,
        planHash: roleplayHash(plan), result };
    const value = { ...record, hash: roleplayHash(record) };
    const old = readArtifact(context.directories, job.id, speakerKey(index));
    if (old !== undefined && roleplayHash(old) !== roleplayHash(value)) throw error('The saved group speaker changed.');
    if (old === undefined) writeArtifact(context.directories, job.id, speakerKey(index), value);
    return value;
}

async function runGroupWorkflow(context, job, beforePublication, decideCandidate) {
    const speakers = job.intent.request.group.speakers;
    let previous = null;
    const completed = [];
    let turn = 0;
    for (const [index] of speakers.entries()) {
        const prior = completedSpeaker(context, job, index, previous);
        if (prior) {
            completed.push(prior);
            previous = prior;
            turn = prior.turnEnd;
            continue;
        }
        const speakerStart = turn;
        let lineage = index ? nextGroupLineage(context, job, previous, index) : null;
        let history = [];
        let decision = null;
        let progressiveOutput = null;
        let done = null;
        while (turn < MAX_TURNS) {
            const child = acceptedChild(context, job, turn, history, lineage, decision, index).child;
            if (child.state !== 'completed') {
                releaseChildJobs(context.directories, job.id);
                return { waiting: true, childJobId: child.id };
            }
            const chosen = selectedCandidate(context, job, child);
            if (chosen.candidate.kind === 'tool-turn') {
                const handled = savedToolHistory(context, job, chosen, turn, history);
                if (handled.waiting) return handled;
                history = handled.history;
                lineage = handled.lineage ?? lineage;
                turn++;
                continue;
            }
            const assembled = combinedCandidateOutput(progressiveOutput, chosen.candidate.output, job.intent.request.effect);
            decision = await savedTextDecision(context, job, chosen, turn, assembled, candidateText(assembled), decideCandidate);
            chosen.output = assembled;
            if (decision.decision?.kind === 'final' || decision.kind === 'final') {
                const alternatives = collectWorkflowAlternatives(context, job, { start: speakerStart, end: turn,
                    effect: job.intent.request.effect, speakerIndex: index,
                    candidateAt: previousTurn => selectedCandidate(context, job, savedChild(context, job, previousTurn).child) });
                done = advanceSpeaker(context, job, chosen, index, turn + 1, previous, alternatives);
                turn++;
                break;
            }
            if (turn === MAX_TURNS - 1) throw error('The group speaker needs a reviewed selection.', 'ROLEPLAY_WORKFLOW_CAPACITY');
            if (decision.decision.kind === 'swipe') {
                history = rejectedSwipeHistory(history, chosen, decision, turn);
                progressiveOutput = null;
            } else {
                history = continuedHistory(history, chosen, decision, turn, assembled);
                progressiveOutput = assembled;
            }
            turn++;
        }
        if (!done) throw error('The group speaker did not complete a bounded model turn.', 'ROLEPLAY_WORKFLOW_CAPACITY');
        completed.push(done);
        previous = done;
        await beforePublication?.(index);
    }
    const result = { status: 'completed', childJobId: completed.at(-1).childJobId,
        candidateHash: completed.at(-1).candidateHash,
        writeId: completed.at(-1).result.writeId, revision: completed.at(-1).result.revision,
        instanceId: completed.at(-1).result.instanceId, speakers: completed.map(entry => ({
            avatar: entry.avatar, childJobId: entry.childJobId, writeId: entry.result.writeId,
        })) };
    finishNativeMediaJob(context, result, { checkSource: false, checkLocked: (lease, value) => {
        for (const [index, entry] of completed.entries()) {
            const effect = value.effects[`speaker:${index}`];
            if (effect?.state !== 'done' || effect.candidateHash !== entry.candidateHash
                || roleplayHash(effect.result) !== roleplayHash(entry.result)) {
                throw error('A saved group speaker write needs recovery.');
            }
        }
        const last = completed.at(-1).result;
        const current = captureRoleplayStorageSourceLocked(lease, job.intent.source.locator).source;
        if (current.instanceId !== last.instanceId || current.revision !== last.revision || current.rawHash !== last.rawHash) {
            throw error('The group chat no longer matches its last owned speaker write.');
        }
    } });
    return { result };
}

function nextGroupLineage(context, job, previous, index) {
    const next = job.intent.request.group.speakers[index];
    const account = job.intent.media;
    const base = { owner: context.owner, directories: context.directories };
    const key = `roleplay-workflow-group-lineage:${index}`;
    const existing = readArtifact(context.directories, job.id, key);
    if (existing !== undefined) {
        const { hash, ...record } = existing;
        if (hash !== roleplayHash(record) || record.parentIntentHash !== roleplayHash(job.intent)
            || record.previousHash !== previous.hash || record.index !== index || record.worldInfo?.avatar !== next.avatar
            || roleplayHash(record.worldInfo.source) !== roleplayHash(record.source)
            || record.account.accountId !== account.accountId || record.account.dataEpoch !== account.dataEpoch) {
            throw error('The saved group speaker lineage changed.');
        }
        return existing;
    }
    const source = withNativeMediaReceipt(context, ({ lease }) => {
        const storage = captureRoleplayStorageSourceLocked(lease, job.intent.source.locator).source;
        if (storage.rawHash !== previous.result.rawHash || storage.instanceId !== previous.result.instanceId
            || storage.revision !== previous.result.revision) throw error('The group chat does not match its owned previous speaker.');
        const selected = captureRoleplaySourceLocked(lease, { locator: job.intent.source.locator, groupId: job.intent.source.groupId }).source;
        if (roleplayHash(selected.dependencies) !== roleplayHash(job.intent.source.dependencies)) {
            throw error('A group member changed after the accepted speaker selection.');
        }
        return selected;
    }, { checkSource: false });
    const worldInfo = captureRoleplayWorldInfo(base, account, source, { avatar: next.avatar,
        maxContext: job.intent.request.worldInfo.maxContext, tokenizer: job.intent.request.worldInfo.tokenizer,
        trigger: job.intent.request.worldInfo.global.trigger, serverPrompt: true,
        nativeBindingVersion: job.intent.request.worldInfo.nativeBindingVersion });
    const record = { parentIntentHash: roleplayHash(job.intent), previousHash: previous.hash, index,
        source, worldInfo, account: { accountId: account.accountId, dataEpoch: account.dataEpoch } };
    const value = { ...record, hash: roleplayHash(record) };
    writeArtifact(context.directories, job.id, key, value);
    return value;
}

export function recoverWaitingRoleplayWorkflow({ job, directories, owner }) {
    if (job.type !== 'media.roleplay-workflow' || job.state !== 'waiting' || job.stage !== 'children') return;
    const current = getJob(directories, job.id);
    if (!current || current.owner !== owner || current.cancellation?.requested || !current.children.length) return;
    const children = current.children.map(id => getJob(directories, id));
    if (children.some(child => !child || child.parentId !== current.id || child.owner !== owner)) {
        throw error('The workflow lost an attached child.');
    }
    if (children.every(child => child.state === 'completed')) updateJob(directories, current.id, { state: 'queued', stage: 'children-completed' });
    else if (children.some(child => ['failed', 'interrupted', 'conflict', 'cancelled'].includes(child.state))) {
        updateJob(directories, current.id, { state: 'interrupted', stage: 'child-needs-recovery',
            error: { code: 'ROLEPLAY_WORKFLOW_CHILD', message: 'The saved workflow child needs a reviewed recovery.' } });
    }
}

export async function runRoleplayWorkflowJob(context, { beforePublication, beforeCommit, decideCandidate } = {}) {
    const job = root(context);
    const closed = withNativeMediaReceipt(context, ({ value }) => value.state === 'closed' ? value.result : null,
        { checkSource: false });
    if (closed) return { result: closed };
    if (job.intent.request.group) return runGroupWorkflow(context, job, beforePublication, decideCandidate);
    let chosen;
    let history = [];
    let lineage = null;
    let decision = null;
    let progressiveOutput = null;
    let turn = 0;
    for (; turn < MAX_TURNS; turn++) {
        const child = acceptedChild(context, job, turn, history, lineage, decision).child;
        if (child.state !== 'completed') {
            releaseChildJobs(context.directories, job.id);
            return { waiting: true, childJobId: child.id };
        }
        chosen = selectedCandidate(context, job, child);
        if (chosen.candidate.kind === 'text') {
            const assembled = combinedCandidateOutput(progressiveOutput, chosen.candidate.output, job.intent.request.effect);
            decision = await savedTextDecision(context, job, chosen, turn, assembled, candidateText(assembled), decideCandidate);
            chosen.output = assembled;
            if (decision.decision?.kind === 'final' || decision.kind === 'final') break;
            if (turn === MAX_TURNS - 1) throw error('The automatic reply limit needs reviewed recovery.', 'ROLEPLAY_WORKFLOW_CAPACITY');
            if (decision.decision.kind === 'swipe') {
                history = rejectedSwipeHistory(history, chosen, decision, turn);
                progressiveOutput = null;
                chosen = null;
                continue;
            }
            history = continuedHistory(history, chosen, decision, turn, assembled);
            progressiveOutput = assembled;
            chosen = null;
            continue;
        }
        const handled = savedToolHistory(context, job, chosen, turn, history);
        if (handled.waiting) return handled;
        history = handled.history;
        lineage = handled.lineage;
        chosen = null;
    }
    if (!chosen) throw error('The model did not finish within the saved tool turn limit.', 'ROLEPLAY_WORKFLOW_CAPACITY');
    const alternatives = collectWorkflowAlternatives(context, job, { start: 0, end: turn,
        effect: job.intent.request.effect, candidateAt: previousTurn =>
            selectedCandidate(context, job, savedChild(context, job, previousTurn).child) });
    const plan = finalPlan(context, job, chosen, { alternatives });
    await beforeCommit?.();
    const outcome = publishPlan(context, job, chosen, plan);
    await beforePublication?.();
    const result = { status: 'completed', childJobId: chosen.child.id, candidateHash: chosen.candidate.hash,
        writeId: outcome.writeId, revision: outcome.revision, instanceId: outcome.instanceId,
        ...(plan.named ? { named: plan.named } : {}) };
    finishNativeMediaJob(context, result, { checkSource: false,
        checkLocked: (lease, value) => {
            const effect = value.effects.final;
            if (effect?.state !== 'done' || effect.recordsHash !== plan.recordsHash
                || effect.candidateHash !== plan.candidateHash || roleplayHash(effect.result) !== roleplayHash(outcome)) {
                throw error('The saved workflow write needs recovery.');
            }
            const current = captureRoleplayStorageSourceLocked(lease, plan.storage.locator).source;
            if (current.instanceId !== outcome.instanceId || current.revision !== outcome.revision
                || current.rawHash !== outcome.rawHash) throw error('The chat no longer matches its owned workflow write.');
        } });
    return { result };
}

registerHandler('media.roleplay-workflow', runRoleplayWorkflowJob);
