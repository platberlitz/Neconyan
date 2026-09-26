export const REASONING_EFFORT_SHORT_LABELS = Object.freeze({
    none: 'None',
    min: 'Min',
    low: 'Low',
    medium: 'Med',
    high: 'High',
    xhigh: 'XHigh',
    max: 'Max',
});

export function getReasoningEffortShortLabel(value) {
    const key = String(value ?? '').trim();
    return REASONING_EFFORT_SHORT_LABELS[key] ?? key;
}

/**
 * Mirrors the data-source gate on the Reasoning Effort row in the connection settings.
 * @param {{ mainApi?: string, source?: string, dataSource?: string }} options
 */
export function isReasoningEffortSupported({ mainApi, source, dataSource } = {}) {
    const currentSource = String(source ?? '').trim();
    if (mainApi !== 'openai' || !currentSource) {
        return false;
    }

    return String(dataSource ?? '')
        .split(',')
        .map(entry => entry.trim())
        .includes(currentSource);
}
