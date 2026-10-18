/** Parse a numeric field without turning a blank or invalid value into zero. */
export function integerSettingValue(raw, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
    const text = String(raw ?? '').trim();
    if (!text) return null;
    const value = Number(text);
    if (!Number.isFinite(value)) return null;
    return Math.min(max, Math.max(min, Math.round(value)));
}

/** Show exactly what the server saved, including its clamp, if the field is still on screen. */
export function reflectSavedValue(input, value) {
    if (!input?.isConnected) return;
    input.value = String(value);
}

/** A newly created session has no previous id, so its saved settings are still the live ones. */
export function reflectedSettingValue(saved, previous, { sessionId, activeSessionId, succeeded = true }) {
    return succeeded && (!sessionId || activeSessionId === sessionId) ? saved : previous;
}
