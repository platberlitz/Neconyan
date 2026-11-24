// Shortcuts typed at the start of a line that run one of the quick-prompt checks in a single step: /check card, /check preset,
// /check lorebook, /check app, /check prompt and /why <entry>. This file only reads the message; index.js decides what can be checked and sends it.

import { commandLines } from './typed-tools.js';

export const CHECK_TARGETS = Object.freeze(['card', 'preset', 'lorebook', 'app', 'prompt']);
export const SHORTCUT_COMMANDS = Object.freeze(['check', 'why']);

/**
 * Finds the shortcut lines of a message: `/check` and `/why` at the start of a line, outside code blocks.
 * @param {string} text
 * @returns {{ lines: string[], shortcuts: { index: number, command: string, input: string }[] }}
 */
export function findShortcuts(text) {
    const parsed = commandLines(text);
    const shortcuts = parsed.flatMap(({ name, input }, index) => SHORTCUT_COMMANDS.includes(name) ? [{ index, command: name, input: input.trim() }] : []);
    return { lines: parsed.map(item => item.line), shortcuts };
}

/**
 * Reads what a shortcut line asks for. For `/check`, `word` is what followed it ('' when nothing did) and `target` is that word when it
 * names something that can be checked ('' otherwise); `rest` is any text after the word. For `/why`, `name` is the entry typed after it.
 * @param {{ command: string, input: string }} shortcut
 */
export function parseShortcut({ command, input }) {
    if (command === 'why') {
        const name = input.trim();
        return { kind: 'why', name: name.length > 1 && /^(["'])[\s\S]*\1$/.test(name) ? name.slice(1, -1).trim() : name };
    }
    const [, word, rest] = /^(\S*)\s*([\s\S]*)$/.exec(input.trim());
    const lower = word.toLowerCase();
    return { kind: 'check', word, target: CHECK_TARGETS.includes(lower) ? lower : '', rest: rest.trim() };
}

/**
 * Puts the request in place of the shortcut line. Anything typed after `/check <word>` follows the request in its own paragraph.
 * @param {string[]} lines
 * @param {number} index
 * @param {string} request
 * @param {string} [rest]
 */
export function replaceShortcut(lines, index, request, rest = '') {
    return lines.map((line, position) => position === index ? [request, rest].filter(Boolean).join('\n\n') : line).join('\n');
}
