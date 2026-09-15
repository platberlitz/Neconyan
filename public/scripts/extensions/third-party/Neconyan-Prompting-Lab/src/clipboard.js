/**
 * A clipboard for prompt modules, shared by every tab. Copying a prompt here
 * lets it be pasted into whichever preset draft is being edited, so a prompt
 * can travel between presets without retyping. Nothing leaves the page: this
 * is not the system clipboard.
 */

let held = null;
const listeners = new Set();

function notify() {
    for (const listener of [...listeners]) {
        try {
            listener(held);
        } catch {
            // One broken listener must not stop the others.
        }
    }
}

/**
 * @param {object} prompt a prompt-module object, cloned on the way in
 * @param {string} sourceName where it was copied from, for display
 */
export function copyPrompt(prompt, sourceName = '') {
    if (!prompt || typeof prompt !== 'object') {
        return;
    }
    held = {
        prompt: structuredClone(prompt),
        sourceName: String(sourceName ?? ''),
        copiedAt: new Date().toISOString(),
    };
    notify();
}

/** @returns {{prompt: object, sourceName: string, copiedAt: string}|null} */
export function readClipboard() {
    return held ? structuredClone(held) : null;
}

export function clearClipboard() {
    held = null;
    notify();
}

/** Calls back on every copy and clear. Returns an unsubscribe function. */
export function onClipboardChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
