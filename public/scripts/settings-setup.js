// One-time setup work that changes settings soon after the page opens, such as a new
// account's Agents switching on Memory Shard. A reply the server writes is bound to the
// settings it was sent with, so it waits for this work rather than seeing it land later.
// Kept free of imports so extensions and tests can load it without the core graph.

export const SETTINGS_SETUP_TIMEOUT_MS = 8000;

const SETTINGS_SETUP_TASKS_KEY = '__neconyanSettingsSetupTasks';

/** @returns {Map<string, { wait: () => Promise<void> }>} */
function getSettingsSetupTasks() {
    const scope = /** @type {any} */ (globalThis);
    if (!(scope[SETTINGS_SETUP_TASKS_KEY] instanceof Map)) {
        scope[SETTINGS_SETUP_TASKS_KEY] = new Map();
    }
    return scope[SETTINGS_SETUP_TASKS_KEY];
}

/**
 * Registers setup work that will change settings. The task leaves the list once it
 * settles, or once the first reply to need it has waited up to the cap. Startup
 * and navigation before Send must not spend that reply's wait budget. A failure is logged.
 * @param {string} name Task name, for diagnostics
 * @param {Promise<unknown>} task Work to wait for
 * @param {{ timeoutMs?: number }} [options]
 */
export function registerSettingsSetupTask(name, task, { timeoutMs = SETTINGS_SETUP_TIMEOUT_MS } = {}) {
    const tasks = getSettingsSetupTasks();
    const key = String(name);
    let timer = null;
    const { promise: expiry, resolve: expire } = Promise.withResolvers();
    const finished = Promise.resolve(task).then(() => {}, error => {
        console.warn(`[Settings] ${key} did not finish cleanly.`, error);
    });
    const settled = Promise.race([finished, expiry]).finally(() => {
        clearTimeout(timer);
        if (tasks.get(key) === entry) tasks.delete(key);
    });
    const entry = {
        wait() {
            timer ??= setTimeout(() => {
                console.warn(`[Settings] ${key} is still running; replies no longer wait for it.`);
                expire();
            }, Math.max(0, timeoutMs));
            return settled;
        },
    };
    tasks.set(key, entry);
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
        const pending = [...getSettingsSetupTasks().values()].map(task => task.wait());
        let timer = null;
        const timedOut = new Promise(resolve => {
            timer = setTimeout(() => resolve(true), remaining);
        });
        const expired = await Promise.race([
            Promise.allSettled(pending).then(() => false),
            timedOut,
        ]);
        clearTimeout(timer);
        if (expired) return false;
    }
    return true;
}
