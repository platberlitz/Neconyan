/**
 * Hooks that add lines after a message sent from the composer, without ever writing them into the message box.
 * This module has no imports, so suites that partially mock script.js keep linking.
 */

/**
 * @typedef {object} ComposerSendContext
 * @property {string} text The composer text about to be sent
 * @property {string} type The generation type the send starts, such as 'normal' or 'continue'
 */

/**
 * @typedef {object} ComposerSendAddition
 * @property {string} text A line to put after the sent message
 * @property {() => void} [onSent] Called once the line is part of the sent message
 */

/** @type {Set<(context: ComposerSendContext) => (ComposerSendAddition|null|undefined)>} */
const hooks = new Set();
/** @type {ComposerSendAddition[]} */
let pending = [];

/**
 * @param {(context: ComposerSendContext) => (ComposerSendAddition|null|undefined)} hook
 * @returns {() => void} Removes the hook again
 */
export function registerComposerSendHook(hook) {
    if (typeof hook !== 'function') {
        return () => {};
    }
    hooks.add(hook);
    return () => hooks.delete(hook);
}

/**
 * Asks every hook what to add after the message the composer is about to send.
 * @param {string} text
 * @param {{ type?: string }} [context]
 */
export function prepareComposerSend(text, { type = 'normal' } = {}) {
    pending = [];
    for (const hook of hooks) {
        try {
            const addition = hook({ text: String(text ?? ''), type });
            if (typeof addition?.text === 'string' && addition.text.trim()) {
                pending.push(addition);
            }
        } catch (error) {
            console.error('A composer send hook failed', error);
        }
    }
}

/**
 * Puts the prepared lines after the message text, once, and tells each hook its line went out.
 * @param {string} text
 * @returns {string}
 */
export function appendComposerSendAdditions(text) {
    const additions = pending;
    pending = [];
    if (additions.length === 0) {
        return text;
    }
    for (const addition of additions) {
        try {
            addition.onSent?.();
        } catch (error) {
            console.error('A composer send hook failed', error);
        }
    }
    return [String(text ?? '').replace(/\s+$/u, ''), ...additions.map(addition => addition.text.trim())]
        .filter(Boolean)
        .join('\n');
}

/** Drops lines prepared for a send that never became a message. */
export function discardComposerSend() {
    pending = [];
}
