import fs from 'node:fs';
import path from 'node:path';

/**
 * Filesystem change-detection identity, not a digest of the file contents.
 * Includes ctime to detect same-size rewrites that restore mtime, plus the inode
 * to detect replacement. Cache reuse requires every recorded field to match.
 */
export function getSettingsFileIdentity(filePath) {
    const stat = fs.statSync(filePath, { bigint: true });
    return Object.freeze({
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeNs: stat.mtimeNs,
        ctimeNs: stat.ctimeNs,
        birthtimeNs: stat.birthtimeNs,
    });
}

export function sameSettingsFileIdentity(left, right) {
    return Boolean(left && right
        && left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs
        && left.birthtimeNs === right.birthtimeNs);
}

function getCacheKey(filePath, handle) {
    // Separate handles never share a parsed snapshot, even if their directory
    // configurations were to point at the same file.
    return `${String(handle || '')}\n${path.resolve(filePath)}`;
}

/*
 * Parsed settings are read-only to this module's callers. The extension-settings
 * endpoint copies the blocks it returns, so an extension mutating its result
 * cannot alter the cached file content. Bounded by source bytes rather than
 * entry count because a single settings file can be several megabytes.
 */
const MAX_CACHED_SETTINGS_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_SETTINGS_ENTRIES = 8;
const parsedSettingsCache = new Map();
let parsedSettingsBytes = 0;

function removeCachedSettings(key) {
    const cached = parsedSettingsCache.get(key);
    if (!cached) return;
    parsedSettingsCache.delete(key);
    parsedSettingsBytes -= cached.bytes;
}

function trimCachedSettings() {
    while (parsedSettingsCache.size > MAX_CACHED_SETTINGS_ENTRIES || parsedSettingsBytes > MAX_CACHED_SETTINGS_BYTES) {
        const oldest = parsedSettingsCache.keys().next().value;
        if (oldest === undefined) break;
        removeCachedSettings(oldest);
    }
}

/**
 * Read and parse a user settings file, reusing the parse only while the file
 * identity is unchanged. Missing and corrupt files keep their read and parse
 * errors. The returned object is shared and must be treated as read-only.
 * @param {string} filePath
 * @param {string} [handle]
 * @returns {any}
 */
export function readParsedSettingsFile(filePath, handle = '') {
    const key = getCacheKey(filePath, handle);
    let identity;
    try {
        identity = getSettingsFileIdentity(filePath);
    } catch (error) {
        removeCachedSettings(key);
        throw error;
    }

    const cached = parsedSettingsCache.get(key);
    if (cached && sameSettingsFileIdentity(cached.identity, identity)) {
        // Refresh recency so a hot settings file is not evicted before its next poll.
        parsedSettingsCache.delete(key);
        parsedSettingsCache.set(key, cached);
        return cached.settings;
    }

    let settings;
    try {
        settings = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        removeCachedSettings(key);
        throw error;
    }
    let currentIdentity = null;
    try {
        currentIdentity = getSettingsFileIdentity(filePath);
    } catch {
        // A file removed or replaced during the read is returned once but not cached.
    }
    if (!currentIdentity || !sameSettingsFileIdentity(identity, currentIdentity) || identity.size > BigInt(MAX_CACHED_SETTINGS_BYTES)) {
        removeCachedSettings(key);
        return settings;
    }

    removeCachedSettings(key);
    const entry = { identity, bytes: Number(identity.size), settings };
    parsedSettingsCache.set(key, entry);
    parsedSettingsBytes += entry.bytes;
    trimCachedSettings();
    return settings;
}

/**
 * Drop a cached parse after this process wrote the file, so the next request
 * cannot observe an old parse even on a filesystem with coarse timestamps.
 */
export function invalidateParsedSettingsFile(filePath, handle = '') {
    removeCachedSettings(getCacheKey(filePath, handle));
}
