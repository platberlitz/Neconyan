import { substituteParams } from '../../../../script.js';
import { normalizeCompanionMacroSyntax } from './companion-shared.js';
import { withReadOnlyVariables } from '../../../variable-read-only.js';

const STATE_CHANGING_MACRO = /{{\s*(?:set|add|inc|dec|delete)(?:global)?var(?:\s*::|\s+)[^}]*}}/gi;

/**
 * Removes macros that write chat or global variables. Displaying or previewing stored
 * text must never change saved state; only the running agent may do that.
 * @param {string} content
 * @returns {string}
 */
export function stripStateChangingMacros(content = '') {
    return String(content ?? '').replace(STATE_CHANGING_MACRO, '');
}

export function resolveCompanionContentMacros(content = '', message = null) {
    return withReadOnlyVariables(() => substituteParams(stripStateChangingMacros(normalizeCompanionMacroSyntax(content)), {
        name2Override: message && !message.is_user ? String(message.name ?? '').trim() || undefined : undefined,
        original: String(message?.mes ?? ''),
    }));
}
