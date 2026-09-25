import { readArtifact } from '../jobs/artifacts.js';
import { roleplayError, roleplayHash } from '../roleplay-store.js';

const fail = () => roleplayError('ROLEPLAY_AGENT_RECOVERY', 'The saved manual Agent result no longer matches its accepted message.');
const EXTRA_KEYS = new Set(['inChatAgents', 'inChatAgentPromptRuns', 'inChatAgentTransformHistory', 'inChatAgentTransformRedo', 'inChatAgentCompanionResults', 'token_count']);

/** The typed manual effect changes one selected message and its explicitly derived tracker state. */
export function applyManualAgentRecords(directories, job, records, output) {
    const { source, request } = job.intent;
    const stored = readArtifact(directories, job.id, 'agent-manual-output');
    const { hash, ...data } = stored ?? {};
    const index = source.message?.index;
    if (!request?.agent || !Number.isSafeInteger(index) || index < 0 || !records[index + 1]
        || hash !== output?.agentOutput || hash !== roleplayHash(data) || data.identity !== roleplayHash(job.intent)
        || data.recordsHash !== roleplayHash(records) || typeof data.text !== 'string' || Buffer.byteLength(data.text) > 256 * 1024
        || !data.extra || typeof data.extra !== 'object' || Array.isArray(data.extra)) throw fail();
    for (const [name, expected] of Object.entries(data.proofs ?? {})) {
        if (!name.startsWith('roleplay-agent-post:manual') && name !== 'roleplay-companions') throw fail();
        const value = readArtifact(directories, job.id, name);
        const { hash: proofHash, ...proof } = value ?? {};
        if (proofHash !== expected || proofHash !== roleplayHash(proof)) throw fail();
    }
    if (Object.keys(data.extra).some(key => !EXTRA_KEYS.has(key))) throw fail();
    const next = structuredClone(records);
    const message = next[index + 1];
    if (['companions', 'repair-companions', 'companion-output'].includes(request.agent.mode) && data.text !== message.mes) throw fail();
    const changed = message.mes !== data.text;
    message.mes = data.text;
    message.extra = { ...message.extra, ...structuredClone(data.extra) };
    if (changed) { delete message.extra.display_text; delete message.extra.server_narration; }
    if (!message.is_user) {
        const selected = message.swipe_id ?? 0;
        if (Array.isArray(message.swipes) && message.swipes.length) {
            if (!Number.isInteger(selected) || selected < 0 || selected >= message.swipes.length) throw fail();
            message.swipes[selected] = message.mes;
        }
        if (Array.isArray(message.swipe_info) && message.swipe_info[selected]) {
            message.swipe_info[selected].extra = { ...message.swipe_info[selected].extra, ...structuredClone(data.extra) };
            if (changed) { delete message.swipe_info[selected].extra.display_text; delete message.swipe_info[selected].extra.server_narration; }
        }
    }
    const metadata = next[0].chat_metadata ??= {}, changes = data.metadata ?? {}, variables = changes.variables ?? {};
    for (const [key, value] of Object.entries(changes)) {
        if (key === 'variables') continue;
        if (!/^agent_[A-Za-z0-9_.-]+$/.test(key) || (value !== null && typeof value !== 'string') || variables[key] !== value) throw fail();
        if (value === null) delete metadata[key]; else metadata[key] = value;
    }
    for (const [key, value] of Object.entries(variables)) {
        if (!Object.hasOwn(changes, key) || changes[key] !== value) throw fail();
        metadata.variables ??= {};
        if (value === null) delete metadata.variables[key]; else metadata.variables[key] = value;
    }
    return next;
}
