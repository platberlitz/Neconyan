/**
 * Pure implementations for the chat-variable macros. No Neconyan imports —
 * everything in this file is directly testable under `node --test`.
 */

export const CHAT_VAR_KEY_MAX = 128;
export const CHAT_VAR_VALUE_MAX = 65536;
export const CHAT_VAR_ENTRIES_WARN_AT = 500;

/**
 * Chat-var keys are routinely built from character names at runtime
 * ("satiety_selphie windsong"), so spaces are allowed here. unlike
 * STATE_KEY_PATTERN in state-impl.js, which keys machine-chosen slots.
 */
export const CHAT_VAR_KEY_PATTERN = /^[\w][\w .:'-]{0,127}$/;

/** Trims surrounding whitespace; the engine already trims macro arguments, but
 *  keys also arrive from {{setvar}} round-trips and regex capture groups. */
export function normalizeChatVarKey(key) {
    return String(key ?? '').trim();
}

export function isValidChatVarKey(key) {
    return CHAT_VAR_KEY_PATTERN.test(normalizeChatVarKey(key));
}

/**
 * Every chat var whose key starts with `prefix`, in stable sorted order so a
 * {{foreachChatVar}} block renders the same way twice running (which is what
 * keeps it from breaking prompt caching).
 *
 * @param {Record<string,string>} chatVars
 * @param {string} prefix
 * @returns {{key: string, suffix: string, value: string}[]}
 */
export function chatVarEntries(chatVars, prefix = '') {
    const p = String(prefix ?? '');
    const source = chatVars && typeof chatVars === 'object' ? chatVars : {};
    return Object.keys(source)
        .filter(key => key.startsWith(p))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map(key => ({ key, suffix: key.slice(p.length), value: String(source[key] ?? '') }));
}

/**
 * Mirrors the host's {{addvar}}: numeric addition when both sides are numbers,
 * plain string append otherwise. A missing variable starts at "".
 *
 * @returns {string} The new value.
 */
export function addChatVarValue(current, delta) {
    const currentText = String(current ?? '');
    const deltaText = String(delta ?? '');
    const a = Number(currentText.trim() === '' ? '0' : currentText.trim());
    const b = Number(deltaText.trim());
    if (!Number.isNaN(a) && !Number.isNaN(b) && deltaText.trim() !== '') {
        return String(a + b);
    }
    return currentText + deltaText;
}

/** Clamps a stored value, reporting when it had to be cut. */
export function capChatVarValue(value) {
    const text = String(value ?? '');
    if (text.length <= CHAT_VAR_VALUE_MAX) {
        return { value: text, truncated: false };
    }
    return { value: text.slice(0, CHAT_VAR_VALUE_MAX), truncated: true };
}

/**
 * The three loop variables a {{foreachChatVar}} iteration exposes, given the
 * alias the caller chose. Kept here so the macro and its tests agree on the
 * naming without duplicating the suffixes.
 */
export function loopVarNames(alias) {
    const base = String(alias ?? '').trim();
    return { value: base, key: `${base}_key`, entryValue: `${base}_value` };
}

/**
 * Loop aliases become `{{.alias}}` shorthand reads, which the host lexes with
 * MACRO_VARIABLE_SHORTHAND_PATTERN. a name that fails it silently stays raw
 * text instead of erroring, so the macro rejects it up front.
 */
export const LOOP_ALIAS_PATTERN = /^[a-zA-Z](?:[\w-]*[\w])?$/;

export function isValidLoopAlias(alias) {
    const base = String(alias ?? '').trim();
    // The three loop vars are alias, alias_key and alias_value; all must lex.
    return LOOP_ALIAS_PATTERN.test(base) && LOOP_ALIAS_PATTERN.test(`${base}_value`);
}
