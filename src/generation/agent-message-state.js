import { buildRegexScriptRefsForAgent, getRegexScriptRevision } from '../../public/scripts/extensions/in-chat-agents/regex-snapshot-store.js';
import { getTrackerMetadataKey, inspectTrackerState, writeTrackerMetadataValue } from '../../public/scripts/extensions/in-chat-agents/tracker-state.js';
import { isNativeCompanion } from './agent-definition.js';
import { roleplayError } from '../roleplay-store.js';

const text = value => typeof value === 'string' ? value : '';

export function agentMessageExtra(message, key) {
    const selected = message?.swipe_info?.[message.swipe_id ?? 0]?.extra;
    return selected && Object.hasOwn(selected, key) ? selected[key] : message?.extra?.[key];
}

/** Follow the edit chain that actually produced this selected text, including an undone chain. */
export function agentTransformHistory(history, currentText) {
    const result = [];
    let expected = text(currentText);
    for (const entry of [...(Array.isArray(history) ? history : [])].reverse()) {
        if (!entry || typeof entry !== 'object' || text(entry.afterText) !== expected) continue;
        result.unshift(entry);
        expected = text(entry.beforeText);
    }
    return result.slice(-10);
}

export function reconcileAgentTrackerMetadata(agents, records) {
    const changes = {};
    for (const agent of agents) {
        if (isNativeCompanion(agent) || !agent.postProcess.enabled || agent.postProcess.type !== 'extract') continue;
        const key = getTrackerMetadataKey(agent);
        if (!key) continue;
        const candidate = [...records.slice(1)].reverse().filter(record => !record.is_user && !record.is_system)
            .map(record => inspectTrackerState(agent, text(record.mes))).find(state => state.status === 'valid');
        writeTrackerMetadataValue(changes, key, candidate?.value || '');
        if (!candidate) { changes[key] = null; changes.variables ??= {}; changes.variables[key] = null; }
    }
    return changes;
}

/** Refresh only explicitly selected Agents; other native rendering snapshots remain frozen. */
export function mergeAgentRegexSnapshot(message, selected, historyAgents, generationType) {
    const previous = agentMessageExtra(message, 'inChatAgents') ?? {};
    const selectedIds = new Set(selected.map(agent => agent.id));
    const scripts = new Map();
    for (const reference of previous.regexScriptRefs ?? []) {
        if (selectedIds.has(reference.agentId)) continue;
        let script;
        if (Object.hasOwn(previous, 'nativeRegexScripts')) {
            script = previous.nativeRegexScripts?.find(item => item.agentId === reference.agentId && item.script?.id === reference.scriptId)?.script;
            if (!script || getRegexScriptRevision(script) !== reference.revision) throw roleplayError('ROLEPLAY_AGENT_RECOVERY', 'The selected message has an unreadable frozen Agent script.');
        } else script = historyAgents.find(agent => agent.id === reference.agentId)?.regexScripts.find(item => item.id === reference.scriptId);
        if (!script) continue;
        const list = scripts.get(reference.agentId) ?? [];
        list.push(structuredClone(script));
        scripts.set(reference.agentId, list);
    }
    for (const agent of selected) scripts.set(agent.id, structuredClone(agent.regexScripts));
    return { activeAgentIds: [...new Set([...(previous.activeAgentIds ?? []), ...selectedIds])], generationType, edited: true,
        regexScriptRefs: [...scripts].flatMap(([id, list]) => buildRegexScriptRefsForAgent(id, list)),
        nativeRegexScripts: [...scripts].flatMap(([id, list]) => list.map(script => ({ agentId: id, script }))) };
}
