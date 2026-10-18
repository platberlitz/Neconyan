import path from 'node:path';

/**
 * Change-detection identity for a cached summary. A summary is reused only
 * while every field still matches, so a normal append, replacement, rename or
 * import is read again on its next use. `ctimeMs` normally catches a same-size
 * rewrite that restores the modification time. This is not a byte hash: a
 * writer that restored every field could defeat it.
 * @param {import('node:fs').Stats} stat
 * @returns {{dev: number, ino: number, size: number, mtimeMs: number, ctimeMs: number}}
 */
export function fileStatIdentity(stat) {
    return {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
    };
}

/**
 * @param {{dev: number, ino: number, size: number, mtimeMs: number, ctimeMs: number} | undefined} left
 * @param {{dev: number, ino: number, size: number, mtimeMs: number, ctimeMs: number} | undefined} right
 * @returns {boolean}
 */
export function sameFileStatIdentity(left, right) {
    return Boolean(left && right)
        && left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs;
}

/**
 * Resolves a path the way cache keys are compared.
 * @param {string} filePath
 * @returns {string}
 */
export function cachedFilePath(filePath) {
    return path.resolve(filePath);
}

/**
 * Runs at most `limit` tasks at once. Queue order is preserved, so a large
 * listing still finishes in a stable order while reads stay bounded.
 * @param {number} limit
 * @returns {<T>(task: () => Promise<T> | T) => Promise<T>}
 */
export function createLimiter(limit) {
    const workers = Math.max(1, Math.floor(limit));
    let active = 0;
    /** @type {Array<{task: Function, resolve: Function, reject: Function}>} */
    const queue = [];

    const next = () => {
        while (active < workers && queue.length > 0) {
            const entry = queue.shift();
            active++;
            Promise.resolve()
                .then(entry.task)
                .then(entry.resolve, entry.reject)
                .finally(() => {
                    active--;
                    next();
                });
        }
    };

    return function run(task) {
        return new Promise((resolve, reject) => {
            queue.push({ task, resolve, reject });
            next();
        });
    };
}

function estimateBytes(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value));
    } catch {
        return Number.MAX_SAFE_INTEGER;
    }
}

/**
 * A byte-bounded, least-recently-used cache of summaries built from a file.
 * Entries are keyed by an absolute path plus the caller's own option tuple, and
 * are returned only when the caller's fresh stat matches the identity stored
 * with the value. Values cross the cache boundary as structured clones, so a
 * caller can mutate what it receives without changing the cached copy or a
 * later response.
 * @param {{maxBytes?: number, maxEntries?: number}} [options]
 */
export function createFileSummaryCache({ maxBytes = 32 * 1024 * 1024, maxEntries = 4096 } = {}) {
    /** @type {Map<string, {identity: object, value: unknown, bytes: number}>} */
    const entries = new Map();
    let bytes = 0;

    function remove(key) {
        const entry = entries.get(key);
        if (!entry) return;
        entries.delete(key);
        bytes -= entry.bytes;
    }

    function trim() {
        while ((bytes > maxBytes || entries.size > maxEntries) && entries.size > 0) {
            const oldest = entries.keys().next().value;
            if (oldest === undefined) break;
            remove(oldest);
        }
    }

    return {
        /**
         * @param {string} key Absolute path plus the option tuple
         * @param {object} identity Fresh stat identity for the file
         * @returns {unknown | undefined} A private copy, or undefined on a miss
         */
        get(key, identity) {
            const entry = entries.get(key);
            if (!entry || !sameFileStatIdentity(entry.identity, identity)) {
                if (entry) remove(key);
                return undefined;
            }
            // Refresh recency so a hot listing is not evicted by a one-off scan.
            entries.delete(key);
            entries.set(key, entry);
            return structuredClone(entry.value);
        },
        /**
         * @param {string} key Absolute path plus the option tuple
         * @param {object} identity Stat identity the value was built from
         * @param {unknown} value Plain summary data
         * @returns {void}
         */
        set(key, identity, value) {
            remove(key);
            const entryBytes = estimateBytes(value);
            if (entryBytes > maxBytes) {
                // One value larger than the whole budget would evict every useful
                // entry and then itself, so never insert it.
                return;
            }
            const entry = { identity: { ...identity }, value: structuredClone(value), bytes: entryBytes };
            entries.set(key, entry);
            bytes += entry.bytes;
            trim();
        },
        /**
         * Drops everything. Used by focused tests and by callers that know a
         * whole card directory changed.
         * @returns {void}
         */
        clear() {
            entries.clear();
            bytes = 0;
        },
        /** @returns {number} */
        get size() {
            return entries.size;
        },
        /** @returns {number} */
        get byteSize() {
            return bytes;
        },
    };
}
