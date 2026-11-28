/**
 * Startup state of the agent library, kept free of imports so other extensions can load it
 * by URL (Regex Agent Themes does) without pulling in the whole In-Chat Agents module graph.
 */

/**
 * Raise this whenever a startup migration in `finishAgentLibraryInitialization` is added or
 * fixed without any change to the bundled template files. The stored catalogue revision then
 * stops matching once, so every account runs the startup migrations again.
 */
export const STARTUP_MIGRATION_REVISION = 2;

/**
 * Combines the bundled catalogue revision with the startup migration revision.
 * @param {string} bundledRevision Revision read from templates/revision.json.
 * @returns {string} The value stored per account, or '' when the bundled revision is unknown.
 */
export function composeCatalogueRevision(bundledRevision) {
    const revision = typeof bundledRevision === 'string' ? bundledRevision.trim() : '';
    return revision ? `${revision}:startup-${STARTUP_MIGRATION_REVISION}` : '';
}

let settled = false;
let release = null;
const settledPromise = new Promise(resolve => {
    release = resolve;
});

/** Marks the startup pass as finished, whether or not it succeeded. */
export function markAgentLibraryStartupSettled() {
    if (settled) return;
    settled = true;
    release(true);
}

export function isAgentLibraryStartupSettled() {
    return settled;
}

/**
 * Resolves true once the startup pass (library load and its migrations) has finished, or
 * false when the signal aborts first.
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<boolean>}
 */
export function whenAgentLibraryStartupSettled({ signal } = {}) {
    if (settled) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
        const cancelled = () => resolve(false);
        signal?.addEventListener?.('abort', cancelled, { once: true });
        settledPromise.then(() => {
            signal?.removeEventListener?.('abort', cancelled);
            resolve(true);
        });
    });
}
