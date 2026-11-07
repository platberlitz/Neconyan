import { createHash } from 'node:crypto';

/** Completed, validated decision responses only. Request identities are retained as hashes. */
export class DecisionCache {
    constructor({ ttlMs = 24 * 60 * 60 * 1000, maxEntries = 500, maxBytes = 8 * 1024 * 1024, now = Date.now } = {}) {
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
        this.maxBytes = maxBytes;
        this.now = now;
        this.entries = new Map();
        this.bytes = 0;
    }

    key(identity) {
        return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    }

    delete(key) {
        const entry = this.entries.get(key);
        if (entry) this.bytes -= entry.bytes;
        this.entries.delete(key);
    }

    get(key) {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        if (entry.expires <= this.now()) {
            this.delete(key);
            return undefined;
        }
        this.entries.delete(key);
        this.entries.set(key, entry);
        return JSON.parse(entry.json);
    }

    set(key, value) {
        const json = JSON.stringify(value);
        const bytes = Buffer.byteLength(json);
        this.delete(key);
        if (bytes > this.maxBytes || this.maxEntries < 1) return;
        const now = this.now();
        for (const [id, entry] of this.entries) if (entry.expires <= now) this.delete(id);
        while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
            this.delete(this.entries.keys().next().value);
        }
        this.entries.set(key, { json, bytes, expires: now + this.ttlMs });
        this.bytes += bytes;
    }
}

// Shared process-wide bound; separate caller/account identities prevent cross-account reuse.
export const decisionCache = new DecisionCache();
