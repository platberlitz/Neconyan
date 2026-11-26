/**
 * Fields Scratchpad may change, shared by the proposal reader and undo. It
 * imports nothing, so undo can check a saved record without loading the app.
 */
export const AGENT_FIELDS = Object.freeze(['name', 'description', 'prompt']);
export const REGEX_FIELDS = Object.freeze(['scriptName', 'findRegex', 'replaceString']);
export const CSS_SNIPPET_FIELDS = Object.freeze(['name', 'content']);
export const PERSONA_UNDO_FIELDS = Object.freeze(['name', 'description', 'title']);
export const PERSONA_NOTE_UNDO_FIELDS = Object.freeze(['name', 'description', 'avatar']);

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isUnsafeUndoKey(key) {
    return UNSAFE_KEYS.has(String(key));
}

export function isAllowedUndoField(allowed, field) {
    return typeof field === 'string' && !isUnsafeUndoKey(field) && Array.isArray(allowed) && allowed.includes(field);
}
