/**
 * A tiny change bus for Macro Enhanced data. Writers announce what changed and
 * the UI refreshes the affected panel on the next frame. No DOM, no Neconyan
 * imports: the macro packs can call this from anywhere, including Node tests.
 *
 * Kinds:
 * - `values`: stored chat values, chat variables, counters.
 * - `macros`: custom macro definitions in any scope.
 * - `pronouns`: saved persona or character pronouns, or a chat override.
 * - `chat`: the open chat or character changed.
 * - `settings`: a setting this extension owns changed.
 */
const listeners = new Set();

/**
 * @param {(kind: string) => void} listener
 * @returns {() => void} Unsubscribe.
 */
export function onMacroDataChanged(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * @param {string} [kind]
 */
export function notifyMacroDataChanged(kind = 'values') {
    for (const listener of [...listeners]) {
        try {
            listener(kind);
        } catch (error) {
            console.error('[MacroEnhanced] data change listener failed', error);
        }
    }
}
