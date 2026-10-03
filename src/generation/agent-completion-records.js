import { readArtifact } from '../jobs/artifacts.js';
import { roleplayError, roleplayHash } from '../roleplay-store.js';
import { selectRoleplayPromptRecords } from './roleplay-prompt.js';
import { applyAutomaticCompanionNoteCleanup } from './companion-note-cleanup.js';

const failure = () => roleplayError('ROLEPLAY_AGENT_RECOVERY', 'The saved Agent completion does not match this reply.', 409);

function proof(directories, job, name, expected) {
    const value = readArtifact(directories, job.id, name);
    const { hash, ...data } = value ?? {};
    if (typeof expected !== 'string' || hash !== expected || hash !== roleplayHash(data)) throw failure();
    return data;
}

/** Only the saved native post-pass may change tracker metadata or replace a continued message. */
export function applyAgentCompletionRecords(directories, job, records, output, baselineRecords = records) {
    const { request, source, effect } = job.intent;
    if (!output?.agentProof) {
        if (request?.worldInfo?.agents || output?.continuedText !== undefined) throw failure();
        return;
    }
    if (!request?.worldInfo?.agents) throw failure();
    const admitted = output.agentProof;
    const pre = proof(directories, job, 'roleplay-agents-pre', admitted.pre);
    const base = proof(directories, job, 'roleplay-agent-output-base', admitted.base);
    const intercepted = proof(directories, job, 'roleplay-agent-intercepts:post-main-generation', admitted.intercepts);
    const post = proof(directories, job, 'roleplay-agent-post', admitted.post);
    const companions = proof(directories, job, 'roleplay-companions', admitted.companions);
    const selected = selectRoleplayPromptRecords(baselineRecords, source, effect);
    const generationType = request.worldInfo.global.trigger;
    if (pre.intentHash !== roleplayHash(job.intent) || pre.policyHash !== roleplayHash(request.worldInfo.agents)
        || base.intentHash !== pre.intentHash || base.recordsHash !== roleplayHash(selected) || typeof base.value !== 'string'
        || intercepted.identity !== roleplayHash({ intent: job.intent, timing: 'post-main-generation', format: 'text', value: base.value })
        || post.identity !== roleplayHash({ intent: job.intent, records: selected, value: intercepted.value, generationType })) throw failure();
    if (companions.identity !== roleplayHash({ intent: job.intent, records: selected,
        value: request.worldInfo.agents.concurrentCompanions ? post.baseline : post.text, generationType, effect })
        || !companions.results || typeof companions.results !== 'object' || Array.isArray(companions.results)
        || !Array.isArray(companions.completed) || !companions.resultHashes) throw failure();
    for (const id of companions.completed) {
        const saved = proof(directories, job, `roleplay-companion:${id}`, companions.resultHashes[id]);
        if (saved.agentId !== id || roleplayHash(saved.record) !== roleplayHash(companions.results[id])) throw failure();
    }
    const message = output.message ?? output.messages?.[0] ?? output;
    if (roleplayHash(message.extra?.inChatAgentCompanionResults ?? {}) !== roleplayHash(companions.results)) throw failure();
    const text = effect === 'continue' ? output.continuedText : message.mes ?? output.text;
    if (typeof text !== 'string' || text !== post.text || Buffer.byteLength(text) > 256 * 1024) throw failure();
    for (const [key, value] of Object.entries(post.extra ?? {})) {
        if (roleplayHash(message.extra?.[key] ?? null) !== roleplayHash(value)) throw failure();
    }
    const metadata = records[0].chat_metadata ??= {};
    const changes = post.metadata ?? {};
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw failure();
    const variables = changes.variables ?? {};
    for (const [key, value] of Object.entries(changes)) {
        if (key === 'variables') continue;
        if (!/^agent_[A-Za-z0-9_.-]+$/.test(key) || (value !== null && typeof value !== 'string') || variables[key] !== value) throw failure();
        if (value === null) delete metadata[key];
        else metadata[key] = value;
    }
    for (const [key, value] of Object.entries(variables)) {
        if (!Object.hasOwn(changes, key) || changes[key] !== value) throw failure();
        metadata.variables ??= {};
        if (value === null) delete metadata.variables[key];
        else metadata.variables[key] = value;
    }
    if (effect !== 'alternative') {
        const messages = records.slice(1);
        const index = effect === 'append' ? messages.length : effect === 'replace' ? source.range.start : source.message.index;
        // Notes in the replaced range cannot count towards the delivered chat's retention limit.
        if (effect === 'replace') messages.splice(index, source.range.count, ...output.messages);
        messages[index] = { ...messages[index], ...message,
            extra: { ...messages[index]?.extra, ...message.extra }, swipe_info: undefined };
        const completed = Object.fromEntries(companions.completed.map(id => [id, companions.results[id]]));
        applyAutomaticCompanionNoteCleanup(messages, request.worldInfo.agents.companionAutoCleanup, completed, index);
    }
}
