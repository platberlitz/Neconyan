/**
 * Name to offer in the Save dialog: the selected configuration's, when it belongs
 * to the current provider, so saving it again needs no retyping.
 */
export function getConfigurationSaveDefaultName(configurations, { activeId = "", provider = "" } = {}) {
    if (!activeId || !Array.isArray(configurations)) return "";
    const active = configurations.find(entry => entry?.id === activeId);
    if (!active || active.provider !== provider) return "";
    return String(active.name || "");
}

/**
 * Works out what saving under `name` does. Keeping the selected configuration's
 * name overwrites it without asking again; matching any other configuration asks
 * first, so a typed name never replaces a different configuration silently.
 */
export function resolveConfigurationSave(configurations, { name = "", activeId = "", provider = "" } = {}) {
    const entries = Array.isArray(configurations) ? configurations : [];
    const matches = entries
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry?.name === name && entry?.provider === provider);
    const target = matches.find(({ entry }) => activeId && entry.id === activeId) || matches[0];
    if (!target) return { existingIndex: -1, needsConfirm: false };
    return {
        existingIndex: target.index,
        needsConfirm: !activeId || target.entry.id !== activeId,
    };
}
