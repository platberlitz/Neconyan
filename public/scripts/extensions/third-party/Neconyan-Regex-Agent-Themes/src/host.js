/**
 * The entire deep-import surface into Neconyan's bundled In-Chat Agents extension.
 *
 * Everything else in this extension goes through `SillyTavern.getContext()`, which is the
 * fork's supported API. The agent store is not on it, so these three modules have to be
 * imported by path, and that coupling is kept here on purpose.
 *
 * Four rules make that survivable:
 *  1. Absolute URL specifiers, so moving a file inside this extension cannot break them.
 *  2. Dynamic import inside try/catch. A static import of a moved file is an unrecoverable
 *     module-graph failure that would take the whole extension down with it.
 *  3. Only exports actually consumed by this extension are required.
 *  4. Nothing throws. Callers branch on `ok`.
 */

const STORE_URL = '/scripts/extensions/in-chat-agents/agent-store.js';
const SCRIPTS_URL = '/scripts/extensions/in-chat-agents/regex-scripts.js';

const REQUIRED_STORE = ['getAgents', 'saveAgent'];
const REQUIRED_SCRIPTS = ['normalizeRegexScript'];

let state = null;
let loading = null;

function missingExports(module, names) {
    return names.filter(name => module?.[name] === undefined);
}

/**
 * Resolves the adapter once and caches the result.
 * @returns {Promise<{ok: boolean, reason?: string, store?: object, scripts?: object}>}
 */
export async function loadHost() {
    if (state?.ok) {
        return state;
    }
    if (!loading) {
        loading = (async () => {
            try {
                const [store, scripts] = await Promise.all([import(STORE_URL), import(SCRIPTS_URL)]);

                const missing = [
                    ...missingExports(store, REQUIRED_STORE),
                    ...missingExports(scripts, REQUIRED_SCRIPTS),
                ];
                if (missing.length) {
                    return { ok: false, reason: `In-Chat Agents is missing: ${missing.join(', ')}` };
                }

                state = { ok: true, store, scripts };
                return state;
            } catch (error) {
                return { ok: false, reason: `Could not load In-Chat Agents (${error?.message ?? error})` };
            }
        })();
    }
    try {
        return await loading;
    } finally {
        loading = null;
    }
}

export function getContext() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

function sleep(delayMs, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve(false);
            return;
        }
        const done = () => {
            signal?.removeEventListener?.('abort', cancelled);
            resolve(true);
        };
        const cancelled = () => {
            clearTimeout(timer);
            resolve(false);
        };
        const timer = setTimeout(done, delayMs);
        signal?.addEventListener?.('abort', cancelled, { once: true });
    });
}

/**
 * Waits until the agent store has actually loaded its agents. The extension's own boot
 * order does not guarantee In-Chat Agents has finished reading settings.
 */
export async function waitForAgents({ attempts = 20, delayMs = 250, signal } = {}) {
    const host = await loadHost();
    if (!host.ok) {
        return host;
    }

    for (let attempt = 0; attempt < attempts; attempt++) {
        if (signal?.aborted) {
            return { ...host, ok: false, ready: false, cancelled: true, reason: 'cancelled' };
        }
        const agents = host.store.getAgents();
        if (Array.isArray(agents) && agents.length > 0) {
            return { ...host, ready: true };
        }
        if (attempt < attempts - 1 && !await sleep(delayMs, signal)) {
            return { ...host, ok: false, ready: false, cancelled: true, reason: 'cancelled' };
        }
    }

    // There is no authoritative ready signal in the current dependency. Empty-before-load
    // and legitimately empty are indistinguishable, so callers must not prune persisted
    // ownership metadata or run boot writes after this timeout.
    return { ...host, ready: false, timedOut: true };
}

/**
 * Re-renders visible messages whose live script refs point at a changed agent. This reads
 * chat metadata but never rewrites or saves it; off-screen messages resolve the same live
 * cache when Neconyan renders them later.
 */
export async function repaintMessagesForAgents(changes) {
    const context = getContext();
    if (!Array.isArray(context?.chat) || typeof context.updateMessageBlock !== 'function') {
        return { ok: false, matched: 0, repainted: 0, reason: 'message repaint unavailable' };
    }

    const wanted = new Map();
    for (const change of changes ?? []) {
        const agentId = String(change?.agentId ?? '');
        const scriptIds = Array.isArray(change?.scriptIds)
            ? change.scriptIds.map(String).filter(Boolean)
            : [];
        if (!agentId || scriptIds.length === 0) {
            continue;
        }
        const current = wanted.get(agentId) ?? new Set();
        scriptIds.forEach(scriptId => current.add(scriptId));
        wanted.set(agentId, current);
    }
    if (wanted.size === 0) {
        return { ok: true, matched: 0, repainted: 0 };
    }

    const updates = [];
    context.chat.forEach((message, index) => {
        if (!message || message.is_user || message.is_system) {
            return;
        }
        const refs = message.extra?.inChatAgents?.regexScriptRefs;
        const matches = Array.isArray(refs) && refs.some((ref) => {
            const scripts = wanted.get(String(ref?.agentId ?? ''));
            return scripts?.has(String(ref?.scriptId ?? ''));
        });
        if (matches) {
            updates.push({ index, message });
        }
    });

    const results = await Promise.allSettled(
        updates.map(({ index, message }) => context.updateMessageBlock(index, message)),
    );
    const repainted = results.filter(result => result.status === 'fulfilled').length;
    return {
        ok: repainted === results.length,
        matched: updates.length,
        repainted,
        failed: results.length - repainted,
    };
}

/** Test seam: lets the apply tests inject a fake store without touching the DOM. */
export function __setHostForTests(fake) {
    state = fake;
    loading = null;
}
