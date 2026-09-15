const SETUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isAgentSetupId(value) {
    return typeof value === 'string' && SETUP_ID_PATTERN.test(value);
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeAgentSetupPreset(value) {
    if (!isRecord(value) || !isAgentSetupId(value.id) || typeof value.name !== 'string') return null;
    const name = value.name.trim();
    if (!name || name.length > 120 || !Array.isArray(value.agents)) return null;
    if (value.version !== undefined && value.version !== 1) return null;
    if (value.globalSettings !== undefined && !isRecord(value.globalSettings)) return null;

    const ids = new Set();
    for (const agent of value.agents) {
        if (!isRecord(agent) || typeof agent.id !== 'string' || !agent.id.trim()
            || agent.id !== agent.id.trim() || agent.id.length > 240
            || /[\\/\u0000-\u001f]/.test(agent.id) || ['.', '..'].includes(agent.id) || ids.has(agent.id)) return null;
        ids.add(agent.id);
    }

    // Connections remain references; provider credentials are never read into this snapshot.
    // Agent-defined fields and tool schemas must survive, regardless of their property names.
    return { ...structuredClone(value), name, version: 1, globalSettings: structuredClone(value.globalSettings ?? {}) };
}

export function mergeAgentSetupRecord(current, snapshot) {
    if (!isRecord(current) || !isRecord(snapshot)) return structuredClone(snapshot);
    return Object.fromEntries(Object.keys({ ...current, ...snapshot }).map(key => [
        key,
        Object.hasOwn(snapshot, key) ? mergeAgentSetupRecord(current[key], snapshot[key]) : structuredClone(current[key]),
    ]));
}
