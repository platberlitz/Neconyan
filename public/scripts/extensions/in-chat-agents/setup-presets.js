const SETUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FILENAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

export const AGENT_STORAGE_LIMITS = Object.freeze({
    agentBytes: 1024 * 1024,
    groupBytes: 8 * 1024 * 1024,
    presetBytes: 8 * 1024 * 1024,
    collectionBytes: 32 * 1024 * 1024,
    agentCount: 512,
    groupCount: 128,
    presetCount: 32,
});

export function isAgentRecordId(value) {
    return typeof value === 'string' && value.length > 0 && value === value.trim()
        && !/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/.test(value)
        && !/[. ]$/.test(value) && !RESERVED_FILENAME.test(value)
        && new TextEncoder().encode(`${value}.json`).length <= 255;
}

export function isAgentSetupId(value) {
    return isAgentRecordId(value) && SETUP_ID_PATTERN.test(value);
}

export function isAgentRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function serializeAgentRecord(value) {
    return JSON.stringify(value, (_key, item) => isAgentRecord(item)
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

function isBoundedData(value, maxBytes) {
    const pending = [[value, 0]];
    let count = 0;
    while (pending.length) {
        const [item, depth] = pending.pop();
        if (++count > 100000 || depth > 64) return false;
        if (item && typeof item === 'object') {
            for (const child of Object.values(item)) pending.push([child, depth + 1]);
        }
    }
    try {
        return new TextEncoder().encode(JSON.stringify(value)).length <= maxBytes;
    } catch {
        return false;
    }
}

export function getAgentRecordError(value, { requireId = true } = {}) {
    if (!isAgentRecord(value)) return 'An agent must be an object.';
    if (!isBoundedData(value, AGENT_STORAGE_LIMITS.agentBytes)) return 'An agent exceeds the 1 MiB or data complexity limit.';
    if ((requireId || value.id !== undefined) && !isAgentRecordId(value.id)) return 'Invalid agent identifier.';
    for (const key of ['injection', 'companion', 'preProcess', 'postProcess', 'conditions', 'settings']) {
        if (value[key] !== undefined && !isAgentRecord(value[key])) return `${key} must be an object.`;
    }
    for (const key of ['name', 'description', 'prompt', 'connectionProfile', 'modelOverride', 'sourceTemplateId']) {
        if (value[key] !== undefined && typeof value[key] !== 'string') return `${key} must be text.`;
    }
    if (value.companion?.feedback !== undefined && !isAgentRecord(value.companion.feedback)) return 'Companion feedback must be an object.';
    for (const [parent, key] of [[value, 'tags'], [value.conditions, 'triggerKeywords'], [value.conditions, 'generationTypes'],
        [value.conditions, 'companionOutputTargetAgentIds'], [value.companion, 'batchAgentIds'],
        [value.companion, 'contextRecipientAgentIds'], [value.companion, 'dependencies']]) {
        if (parent?.[key] !== undefined && (!Array.isArray(parent[key]) || parent[key].length > AGENT_STORAGE_LIMITS.agentCount
            || parent[key].some(item => typeof item !== 'string'))) return `${key} must be a list of at most ${AGENT_STORAGE_LIMITS.agentCount} text values.`;
    }
    for (const key of ['tools', 'regexScripts']) {
        if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length > AGENT_STORAGE_LIMITS.agentCount
            || value[key].some(item => !isAgentRecord(item)))) return `${key} must contain valid objects.`;
    }
    if (value.tools?.some(tool => tool.parameters !== undefined && !isAgentRecord(tool.parameters))) return 'Tool parameters must be an object.';
    return null;
}

export function normalizeAgentGroup(value) {
    if (!isAgentRecord(value) || !isAgentRecordId(value.id) || (value.name !== undefined && typeof value.name !== 'string')) return null;
    if (value.agentTemplateIds !== undefined && (!Array.isArray(value.agentTemplateIds)
        || value.agentTemplateIds.length > AGENT_STORAGE_LIMITS.agentCount || value.agentTemplateIds.some(id => !isAgentRecordId(id)))) return null;
    if (value.customAgents !== undefined && (!Array.isArray(value.customAgents)
        || value.customAgents.length > AGENT_STORAGE_LIMITS.agentCount
        || value.customAgents.some(agent => getAgentRecordError(agent, { requireId: false })))) return null;
    if (!isBoundedData(value, AGENT_STORAGE_LIMITS.groupBytes)) return null;
    return { ...structuredClone(value), name: value.name?.trim() ?? '', description: String(value.description ?? ''),
        agentTemplateIds: value.agentTemplateIds ?? [], customAgents: value.customAgents?.map(agent => ({ ...agent, enabled: false })) ?? [], builtin: false };
}

export function normalizeAgentSetupPreset(value) {
    if (!isAgentRecord(value) || !isAgentSetupId(value.id) || typeof value.name !== 'string') return null;
    const name = value.name.trim();
    if (!name || name.length > 120 || !Array.isArray(value.agents) || value.agents.length > AGENT_STORAGE_LIMITS.agentCount) return null;
    if (value.version !== undefined && value.version !== 1) return null;
    if (value.globalSettings !== undefined && !isAgentRecord(value.globalSettings)) return null;
    if (value.globalSettings?.enabledAgentIdsByChatType !== undefined && !isAgentRecord(value.globalSettings.enabledAgentIdsByChatType)) return null;

    const ids = new Set();
    for (const agent of value.agents) {
        if (getAgentRecordError(agent) || ids.has(agent.id)) return null;
        ids.add(agent.id);
    }
    for (const enabled of Object.values(value.globalSettings?.enabledAgentIdsByChatType ?? {})) {
        if (!Array.isArray(enabled) || enabled.some(id => !ids.has(id))) return null;
    }
    if (!isBoundedData(value, AGENT_STORAGE_LIMITS.presetBytes)) return null;

    // Connections remain references; provider credentials are never read into this snapshot.
    // Agent-defined fields and tool schemas must survive, regardless of their property names.
    return { ...structuredClone(value), name, version: 1, globalSettings: structuredClone(value.globalSettings ?? {}) };
}

export function mergeAgentSetupRecord(current, snapshot) {
    if (!isAgentRecord(current) || !isAgentRecord(snapshot)) return structuredClone(snapshot);
    return Object.fromEntries(Object.keys({ ...current, ...snapshot }).map(key => [
        key,
        Object.hasOwn(snapshot, key) ? mergeAgentSetupRecord(current[key], snapshot[key]) : structuredClone(current[key]),
    ]));
}
