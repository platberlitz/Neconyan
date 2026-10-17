import path from 'node:path';
import { inspectRoleplayFile, readRoleplayFile } from '../roleplay-store.js';

// Agent and Companion settings reads keep the protected-file checks that
// readRoleplayFile performs: no symbolic links, exactly one hard link, the
// caller's original size limit, and device/inode confirmation. Parsing is
// reused only when the protected content hash is unchanged.
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 16;
const cache = new Map();
let bytes = 0;

function remove(filename) {
    const cached = cache.get(filename);
    if (!cached) return;
    cache.delete(filename);
    bytes -= cached.bytes;
}

function trim() {
    while (cache.size > MAX_CACHE_ENTRIES || bytes > MAX_CACHE_BYTES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        remove(oldest);
    }
}

/**
 * Parse a protected settings file with the caller's original limit and
 * readRoleplayFile safety checks. A missing file returns null. Damage,
 * symbolic links, hard links and oversized files keep their
 * ROLEPLAY_STORE_DAMAGED error; malformed JSON keeps its parse error.
 */
export function readRoleplaySettingsJson(filename, { limit = 64 * 1024 * 1024 } = {}) {
    const key = path.resolve(filename);
    const inspected = inspectRoleplayFile(key, limit);
    if (!inspected) return null;
    const cached = cache.get(key);
    if (cached && cached.rawHash === inspected.rawHash) {
        cache.delete(key);
        cache.set(key, cached);
        return cached.data;
    }
    const file = readRoleplayFile(key, limit);
    if (!file) return null;
    const data = JSON.parse(file.bytes.toString('utf8'));
    remove(key);
    const entry = { rawHash: file.rawHash, bytes: file.bytes.length, data };
    cache.set(key, entry);
    bytes += entry.bytes;
    trim();
    return data;
}
