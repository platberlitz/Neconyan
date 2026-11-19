// One-time setup work that changes settings soon after the page opens, such as a new
// account's Agents switching on Memory Shard. A reply the server writes is bound to the
// settings it was sent with, so it waits for this work rather than seeing it land later.
// Kept free of imports so extensions and tests can load it without the core graph.

export const SETTINGS_SETUP_TIMEOUT_MS = 8000;

const SETTINGS_SETUP_TASKS_KEY = '__neconyanSettingsSetupTasks';

/** @returns {Map<string, Promise<void>>} */
function getSettingsSetupTasks() {
    const scope = /** @type {any} */ (globalThis);
    if (!(scope[SETTINGS_SETUP_TASKS_KEY] instanceof Map)) {
        scope[SETTINGS_SETUP_TASKS_KEY] = new Map();
    }
    return scope[SETTINGS_SETUP_TASKS_KEY];
}

/**
 * Registers setup work that will change settings. The task leaves the list once it
 * settles, or once the cap has passed since it was registered, so work that never
 * finishes can only hold the replies sent in the first seconds. A failure is logged.
 * @param {string} name Task name, for diagnostics
 * @param {Promise<unknown>} task Work to wait for
 * @param {{ timeoutMs?: number }} [options]
 */
export function registerSettingsSetupTask(name, task, { timeoutMs = SETTINGS_SETUP_TIMEOUT_MS } = {}) {
    const tasks = getSettingsSetupTasks();
    const key = String(name);
    let timer = null;
    const expiry = new Promise(resolve => {
        timer = setTimeout(() => {
            console.warn(`[Settings] ${key} is still running; replies no longer wait for it.`);
            resolve();
        }, Math.max(0, timeoutMs));
    });
    const finished = Promise.resolve(task).then(() => {}, error => {
        console.warn(`[Settings] ${key} did not finish cleanly.`, error);
    });
    const settled = Promise.race([finished, expiry]).finally(() => {
        clearTimeout(timer);
        if (tasks.get(key) === settled) tasks.delete(key);
    });
    tasks.set(key, settled);
}

/** @returns {string[]} */
export function getPendingSettingsSetupTaskNames() {
    return [...getSettingsSetupTasks().keys()];
}

/**
 * Waits until no setup work is changing settings, or the cap passes.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<boolean>} true when nothing was left pending
 */
export async function waitForSettingsSetup({ timeoutMs = SETTINGS_SETUP_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    // Finishing one task can start another, such as a migration that schedules a save.
    while (getSettingsSetupTasks().size > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        let timer = null;
        const timedOut = new Promise(resolve => {
            timer = setTimeout(() => resolve(true), remaining);
        });
        const expired = await Promise.race([
            Promise.allSettled([...getSettingsSetupTasks().values()]).then(() => false),
            timedOut,
        ]);
        clearTimeout(timer);
        if (expired) return false;
    }
    return true;
}
