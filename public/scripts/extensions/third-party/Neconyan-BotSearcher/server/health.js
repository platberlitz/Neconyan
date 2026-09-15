/**
 * Per-source circuit breaker.
 *
 * These APIs are undocumented and change without notice; several of the sites
 * CleanBotBrowser ships are already dead. The goal is that a source going down
 * degrades into "that one is hidden right now" rather than a spinning tab, a
 * pile of timeouts, or a server that keeps hammering an endpoint returning 403.
 *
 * Deliberately lazy: no background timers and no startup fan-out. init() must
 * not do network I/O (the SSRF filter is not installed yet at that point), and
 * the reference deployment is a 1 OCPU box that should not be probing twenty
 * sites on a schedule nobody asked for.
 */

const FAILURES_BEFORE_DOWN = 3;

/** Backoff for repeated failures. */
const COOLDOWN_STEPS_MS = [60_000, 5 * 60_000, 30 * 60_000];

/**
 * Failures that mean "this endpoint is gone", not "this request went badly".
 * One of these is enough on its own.
 */
const HARD_FAILURES = new Set(['dns', 'forbidden', 'not_found', 'host_not_allowed', 'insecure_scheme']);

/**
 * Failures where the site is up but THIS server cannot reach it, so trying from
 * a different network path is worth doing. Deliberately narrow: a timeout is far
 * more likely to be an ordinary blip than a block, and routing every blip through
 * the user's browser would trade their address away for nothing.
 *
 * `forbidden` is the observed case — Chub's Cloudflare answers datacenter ranges
 * with a flat 403 while serving the same request from a home connection.
 */
export const REROUTABLE_FAILURES = Object.freeze(new Set(['forbidden', 'dns']));

/** @type {Map<string, { failures: number, downSince: number|null, cooldownUntil: number, step: number, lastOkAt: number|null, lastKind: string|null }>} */
const health = new Map();

function entry(sourceId) {
    let record = health.get(sourceId);
    if (!record) {
        record = { failures: 0, downSince: null, cooldownUntil: 0, step: 0, lastOkAt: null, lastKind: null };
        health.set(sourceId, record);
    }
    return record;
}

/**
 * Classifies an UpstreamError into something the breaker can act on.
 * @param {any} error
 * @returns {string}
 */
export function classify(error) {
    const code = error?.code;

    if (code === 'http_error') {
        const status = Number(error.detail);
        if (status === 403) {
            return 'forbidden';   // Typically a bot-protection wall, not a blip.
        }
        if (status === 404 || status === 410) {
            return 'not_found';   // The endpoint moved or was withdrawn.
        }
        return 'transient';
    }

    if (code === 'network') {
        const detail = String(error.detail ?? '');
        if (/ENOTFOUND|ERR_NAME_NOT_RESOLVED/i.test(detail)) {
            return 'dns';         // The host no longer resolves at all.
        }
        return 'transient';
    }

    if (HARD_FAILURES.has(code)) {
        return code;
    }

    return 'transient';
}

/**
 * @param {string} sourceId
 */
export function markSuccess(sourceId) {
    const record = entry(sourceId);
    record.failures = 0;
    record.downSince = null;
    record.cooldownUntil = 0;
    record.step = 0;
    record.lastOkAt = Date.now();
    record.lastKind = null;
}

/**
 * @param {string} sourceId
 * @param {any} error
 * @returns {boolean} whether the source is now considered down
 */
export function markFailure(sourceId, error) {
    const record = entry(sourceId);
    const kind = classify(error);

    record.failures += 1;
    record.lastKind = kind;

    const isHard = HARD_FAILURES.has(kind);
    if (isHard || record.failures >= FAILURES_BEFORE_DOWN) {
        record.downSince = record.downSince ?? Date.now();
        const wait = COOLDOWN_STEPS_MS[Math.min(record.step, COOLDOWN_STEPS_MS.length - 1)];
        record.cooldownUntil = Date.now() + wait;
        record.step += 1;
        console.warn(`[BotSearcher] ${sourceId} marked down (${kind}); retrying in ${Math.round(wait / 1000)}s`);
        return true;
    }

    return false;
}

/**
 * True while the source is inside its cooldown. Once the cooldown lapses the
 * next request is allowed through as a probe; if it succeeds the source is
 * healthy again, if it fails the backoff lengthens.
 * @param {string} sourceId
 */
export function isDown(sourceId) {
    const record = health.get(sourceId);
    if (!record || record.downSince === null) {
        return false;
    }
    return Date.now() < record.cooldownUntil;
}

/**
 * @param {string} sourceId
 * @returns {'up' | 'unknown' | 'down'}
 */
export function stateOf(sourceId) {
    if (isDown(sourceId)) {
        return 'down';
    }
    const record = health.get(sourceId);
    if (!record || record.lastOkAt === null) {
        return 'unknown';
    }
    return 'up';
}

/**
 * Why a source last failed, so the UI can say what actually happened instead of
 * defaulting to "not responding". A refused request and a timed-out one need
 * different words and lead to different next actions.
 *
 * @param {string} sourceId
 * @returns {string | null} a `classify()` kind, or null if it has not failed
 */
export function reasonOf(sourceId) {
    return health.get(sourceId)?.lastKind ?? null;
}

/**
 * Clears the cooldown so the next request is attempted immediately. Backs the
 * per-source Retry in the UI.
 * @param {string} sourceId
 */
export function reset(sourceId) {
    const record = health.get(sourceId);
    if (record) {
        record.cooldownUntil = 0;
        record.failures = 0;
        record.downSince = null;
        record.step = 0;
        record.lastKind = null;
    }
}

/** Test seam. */
export function clearAll() {
    health.clear();
}
