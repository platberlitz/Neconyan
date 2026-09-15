/**
 * Rate limiting and concurrency caps.
 *
 * Two jobs: keep one user's grid from opening a burst of sockets on a small box
 * (the reference deployment is a 1 OCPU / 6 GB ARM instance shared with other
 * apps), and keep this plugin from looking like an attack to the card sites.
 *
 * rate-limiter-flexible's consume() REJECTS with a RateLimiterRes on limit —
 * not with an Error. An unhandled one would reach Neconyan's
 * unhandledRejection handler and shut the whole server down
 * (src/server-main.js:518-537), so every call site here distinguishes the two.
 */

import { RateLimiterMemory } from 'rate-limiter-flexible';

const limiters = {
    /**
     * Per user, across all sources.
     *
     * Raised from 30 when the query box began searching as the user types. A
     * debounced phrase is a handful of requests rather than one, and a merged
     * search across several sources still costs one point here — the per-source
     * limiter below is what actually protects the sites.
     */
    search: new RateLimiterMemory({ points: 90, duration: 60 }),
    /** Per source, across all users: protects the upstream site and our IP reputation. */
    sourceGlobal: new RateLimiterMemory({ points: 20, duration: 60 }),
    /** Per user: fetching card bytes is the expensive path. */
    card: new RateLimiterMemory({ points: 10, duration: 60 }),
    /** Per profile: password attempts must stay low even when searches are busy. */
    accountLogin: new RateLimiterMemory({ points: 5, duration: 10 * 60 }),
    /** Per profile: each preference change performs both a PATCH and a verification GET. */
    accountMutation: new RateLimiterMemory({ points: 12, duration: 60 }),
    /** Per user: one 24-tile grid fires 24 of these at once. */
    thumbUser: new RateLimiterMemory({ points: 300, duration: 60 }),
    /** Bounds total thumbnail egress even when many users are active. */
    thumbGlobal: new RateLimiterMemory({ points: 600, duration: 60 }),
    /** Stops one upstream from receiving a full-server thumbnail burst. */
    thumbSource: new RateLimiterMemory({ points: 120, duration: 60 }),
};

/**
 * @param {keyof typeof limiters} name
 * @param {string} key
 * @param {{ failClosed?: boolean }} [options]
 * @returns {Promise<{ allowed: true } | { allowed: false, retryAfterSeconds: number }>}
 */
export async function consume(name, key, { failClosed = false } = {}) {
    try {
        await limiters[name].consume(key, 1);
        return { allowed: true };
    } catch (rejection) {
        // Ordinary metadata/search requests can stay available if the limiter
        // fails. Expensive byte egress must fail closed instead.
        if (rejection instanceof Error) {
            console.error('[BotSearcher] rate limiter error:', rejection.message);
            return failClosed
                ? { allowed: false, retryAfterSeconds: 1 }
                : { allowed: true };
        }

        const ms = typeof rejection?.msBeforeNext === 'number' ? rejection.msBeforeNext : 1000;
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(ms / 1000)) };
    }
}

/**
 * In-flight caps, so a burst cannot open many sockets at once.
 *
 * These QUEUE rather than reject. That distinction is the whole point: a grid
 * renders 24 <img> tags at once and the browser opens about six connections
 * immediately. A cap that answered 503 at capacity permanently broke every
 * image past the limit — an <img> does not retry — so most of the grid stayed
 * blank while the server reported no errors at all.
 */
const inFlight = new Map();

/** @type {Map<string, Array<{ resolve: (granted: boolean) => void, timer: NodeJS.Timeout, signal?: AbortSignal, onAbort?: () => void }>>} */
const waiting = new Map();

const CONCURRENCY = Object.freeze({
    source: 2,
    // Bounds process-wide buffered thumbnail memory. A source without a preview
    // endpoint may serve 6 MB images, so this must not be per caller.
    thumbGlobal: 8,
    thumbSource: 2,
    thumbUser: 4,
});

/** Longer than any single thumbnail fetch, short enough not to pile up. */
const DEFAULT_WAIT_MS = 20000;
const MAX_WAITERS_PER_SLOT = 64;

function releaseSlot(slot) {
    const queue = waiting.get(slot);
    if (queue && queue.length > 0) {
        // Hand the slot straight to the next waiter; the count stays the same.
        const next = queue.shift();
        if (queue.length === 0) {
            waiting.delete(slot);
        }
        next.resolve(true);
        return;
    }

    const remaining = (inFlight.get(slot) ?? 1) - 1;
    if (remaining <= 0) {
        inFlight.delete(slot);
    } else {
        inFlight.set(slot, remaining);
    }
}

function makeRelease(slot) {
    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        releaseSlot(slot);
    };
}

/**
 * Waits for a slot rather than refusing one.
 *
 * @param {'source' | 'thumbGlobal' | 'thumbSource' | 'thumbUser'} kind
 * @param {string} key
 * @param {{ timeoutMs?: number, signal?: AbortSignal, maxWaiters?: number }} [options]
 * @returns {Promise<(() => void) | null>} a release function, or null if the wait timed out
 */
export async function acquire(kind, key, {
    timeoutMs = DEFAULT_WAIT_MS,
    signal,
    maxWaiters = MAX_WAITERS_PER_SLOT,
} = {}) {
    if (signal?.aborted) {
        return null;
    }

    const slot = `${kind}:${key}`;
    const current = inFlight.get(slot) ?? 0;

    if (current < CONCURRENCY[kind]) {
        inFlight.set(slot, current + 1);
        return makeRelease(slot);
    }

    const queue = waiting.get(slot);
    if ((queue?.length ?? 0) >= maxWaiters) {
        return null;
    }

    const granted = await new Promise((resolve) => {
        let settled = false;
        const remove = () => {
            const queued = waiting.get(slot);
            if (!queued) {
                return;
            }
            const index = queued.indexOf(entry);
            if (index >= 0) {
                queued.splice(index, 1);
            }
            if (queued.length === 0) {
                waiting.delete(slot);
            }
        };
        const finish = (granted) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(entry.timer);
            entry.signal?.removeEventListener('abort', entry.onAbort);
            remove();
            resolve(granted);
        };
        const entry = {
            resolve: finish,
            timer: setTimeout(() => finish(false), timeoutMs),
            signal,
            onAbort: () => finish(false),
        };
        // Never hold the process open waiting on a queued request.
        entry.timer.unref?.();
        signal?.addEventListener('abort', entry.onAbort, { once: true });

        const pending = waiting.get(slot);
        if (pending) {
            pending.push(entry);
        } else {
            waiting.set(slot, [entry]);
        }
    });

    return granted ? makeRelease(slot) : null;
}

/**
 * Acquires thumbnail limits from narrowest to broadest. A request waiting on a
 * busy source must not occupy one of the process-wide thumbnail slots.
 *
 * @param {string} caller
 * @param {string} source
 * @param {{ timeoutMs?: number, signal?: AbortSignal, maxWaiters?: number }} [options]
 * @returns {Promise<(() => void) | null>}
 */
export async function acquireThumbnail(caller, source, options = {}) {
    const releases = [];
    for (const [kind, key] of [
        ['thumbUser', caller],
        ['thumbSource', source],
        ['thumbGlobal', 'all'],
    ]) {
        const release = await acquire(kind, key, options);
        if (!release) {
            while (releases.length > 0) {
                releases.pop()();
            }
            return null;
        }
        releases.push(release);
    }

    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        while (releases.length > 0) {
            releases.pop()();
        }
    };
}

/**
 * Identifies the caller for per-user limits. request.user is always populated by
 * setUserDataMiddleware (src/users.js), but fall back rather than throw.
 * @param {any} request
 */
export function callerKey(request) {
    const handle = request?.user?.profile?.handle;
    return typeof handle === 'string' && handle !== '' ? handle : 'anonymous';
}
