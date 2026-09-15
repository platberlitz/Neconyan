// Shared storage validation and legacy import: no host, filesystem or DOM access.
import { normalizeSettings } from './core.js';
import { normalizeFeed } from './storage.js';

export const MAX_STORE_BYTES = 128 * 1024 * 1024;
export const MAX_FEED_BYTES = 20 * 1024 * 1024;
export const HOST_STORE_NAME = 'hopper-store.json';
export const HOST_PLUGIN_MARKER = 'hopper-server-storage.json';
export const encodedLimit = (limit = MAX_STORE_BYTES) => Math.ceil(limit / 3) * 4 + 1024;

const isRecord = value => value !== null && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const feedPath = value => typeof value === 'string' && /^\/user\/files\/twitterlike-feed(?:-[a-zA-Z0-9_-]+)?\.json$/.test(value);

function fail(status, message) {
    throw Object.assign(new Error(message), { status });
}

function checkJson(value, status = 400, depth = 0, parents = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (depth > 64 || (!Array.isArray(value) && !isRecord(value)) || parents.has(value)) {
        fail(status, 'Meower data must contain only finite, non-cyclic JSON values.');
    }
    parents.add(value);
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value) && keys.length !== value.length + 1) fail(status, 'Meower arrays must not contain missing entries.');
    for (const key of keys) {
        if (Array.isArray(value) && key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
            fail(status, 'Meower data must contain plain JSON properties.');
        }
        if (Array.isArray(value) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
            fail(status, 'Meower arrays must contain only indexed entries.');
        }
        checkJson(descriptor.value, status, depth + 1, parents);
    }
    parents.delete(value);
}

export function sizeOf(value, limit, what) {
    const json = JSON.stringify(value);
    if (new TextEncoder().encode(json).byteLength > limit) fail(413, `${what} is too large to save safely.`);
    return json;
}

// Omitted optional fields may acquire defaults; supplied data must never be silently discarded.
function preserves(source, normal, exact = false) {
    if (Array.isArray(source)) {
        return Array.isArray(normal) && (!exact || Object.getPrototypeOf(source) === Object.getPrototypeOf(normal))
            && source.length === normal.length && source.every((item, index) => preserves(item, normal[index], exact));
    }
    if (isRecord(source)) {
        return isRecord(normal) && (!exact || (Object.getPrototypeOf(source) === Object.getPrototypeOf(normal)
            && Object.keys(source).length === Object.keys(normal).length))
            && Object.keys(source).every(key => Object.hasOwn(normal, key) && preserves(source[key], normal[key], exact));
    }
    return Object.is(source, normal);
}

export function settingsFrom(raw, status = 500) {
    if (raw === undefined) return normalizeSettings();
    checkJson(raw, status);
    if (!isRecord(raw)) fail(status, 'The saved Meower settings are invalid.');
    if (raw.version !== undefined && raw.version !== 1 && raw.version !== 2) {
        fail(status, 'The saved Meower settings format is invalid or newer than this version.');
    }
    if (raw.sessions !== undefined) {
        if (!isRecord(raw.sessions)) fail(status, 'The saved Meower timeline list is invalid.');
        for (const [id, session] of Object.entries(raw.sessions)) {
            if (!id || id.length > 120 || !isRecord(session) || (session.id !== undefined && session.id !== id)) {
                fail(status, 'A saved Meower timeline has an invalid identity.');
            }
            if (session.feedPath !== undefined && (typeof session.feedPath !== 'string' || (session.feedPath && !feedPath(session.feedPath)))) {
                fail(status, 'A saved Meower timeline path is invalid.');
            }
        }
    }
    if (raw.shards !== undefined && (!Array.isArray(raw.shards) || raw.shards.some(value => !feedPath(value)))) {
        fail(status, 'A saved Meower timeline path is invalid.');
    }
    if ((raw.activeSessionId !== undefined && typeof raw.activeSessionId !== 'string')
        || (raw.activeSessionByPersona !== undefined && (!isRecord(raw.activeSessionByPersona)
            || Object.values(raw.activeSessionByPersona).some(value => typeof value !== 'string')))) {
        fail(status, 'The Meower timeline selection is invalid.');
    }
    return normalizeSettings(raw);
}

export function storeFrom(raw, { strict = false, status = 500 } = {}) {
    checkJson(raw, status);
    sizeOf(raw, MAX_STORE_BYTES, 'The Meower store (128 MiB limit)');
    if (!isRecord(raw) || raw.format !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 0
        || !isRecord(raw.settings) || !isRecord(raw.settings.sessions) || !isRecord(raw.feeds)) {
        fail(status, 'The Meower store format or revision is invalid or newer than this version.');
    }
    const settings = settingsFrom(raw.settings, status);
    const ids = Object.keys(settings.sessions);
    if (ids.length !== Object.keys(raw.feeds).length || ids.some(id => !Object.hasOwn(raw.feeds, id))) {
        fail(status, 'The Meower timelines and their saved feeds do not match.');
    }
    // Selection is device-local and may still point at a timeline another device deleted.
    const checkedSettings = { ...raw.settings, activeSessionId: settings.activeSessionId, activeSessionByPersona: settings.activeSessionByPersona };
    if (strict && !preserves(checkedSettings, settings)) fail(status, 'The Meower settings contain invalid or unsupported values.');
    const warnings = [];
    const feeds = Object.fromEntries(ids.map(id => {
        const source = raw.feeds[id];
        sizeOf(source, MAX_FEED_BYTES, 'A Meower timeline (20 MiB limit)');
        if (!isRecord(source) || source.version !== 1) fail(status, 'A saved timeline format is invalid or newer than this version.');
        let feed;
        try {
            feed = normalizeFeed(source);
        } catch (error) {
            fail(status, error.message);
        }
        sizeOf(feed, MAX_FEED_BYTES, 'A Meower timeline (20 MiB limit)');
        if (strict && !preserves(source, feed)) fail(status, 'A Meower timeline contains invalid or unsupported rows. Nothing was saved.');
        if (!preserves(source, feed, true)) warnings.push('Saved timeline rows were repaired for display; the original saved bytes have not been changed.');
        return [id, feed];
    }));
    if (!preserves(raw.settings, settings, true)) warnings.push('Saved Meower settings were normalised for display; the original saved bytes have not been changed.');
    const store = { format: 1, revision: raw.revision, settings, feeds };
    sizeOf(store, MAX_STORE_BYTES, 'The Meower store (128 MiB limit)');
    return { store, warnings: [...new Set(warnings)] };
}

export function parseBytes(bytes, { limit = MAX_STORE_BYTES, base64 = false } = {}) {
    const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
    try {
        if (!(bytes instanceof Uint8Array)) throw new Error('Expected bytes.');
        if (bytes.byteLength > (base64 ? encodedLimit(limit) : limit)) fail(413, 'Saved Meower data exceeds the supported size limit.');
        const text = decode(bytes);
        try {
            const result = JSON.parse(text);
            if (bytes.byteLength > limit) fail(413, 'Saved Meower data exceeds the supported size limit.');
            return result;
        } catch (error) {
            if (error.status) throw error;
            const encoded = text.replace(/\s/g, '');
            if (!base64 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded)) throw error;
            const binary = atob(encoded);
            if (btoa(binary).replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw error;
            if (binary.length > limit) fail(413, 'Saved Meower data exceeds the supported size limit.');
            const decoded = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) decoded[index] = binary.charCodeAt(index);
            return JSON.parse(decode(decoded));
        }
    } catch (error) {
        if (error.status) throw error;
        fail(500, 'Saved Meower data is corrupt or unreadable. Restore the original file before saving.');
    }
}

// Must match the former browser uploader, including its hash for sanitised session ids.
function sessionFileName(session) {
    if (session.id === 'legacy') return 'twitterlike-feed.json';
    const safe = session.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'timeline';
    let hash = 2166136261;
    for (const char of session.id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return `twitterlike-feed-${safe}${safe === session.id ? '' : `-${(hash >>> 0).toString(16).padStart(8, '0')}`}.json`;
}

/** raw is the legacy extension settings. readFile('/user/files/...', byteLimit) returns bytes or null for a missing file. */
export async function migrateLegacy(raw, readFile) {
    const settings = settingsFrom(raw);
    if (raw !== undefined) sizeOf(raw, MAX_STORE_BYTES, 'The Meower store (128 MiB limit)');
    const warnings = [];
    const feeds = [];
    for (const [id, session] of Object.entries(settings.sessions)) {
        const configured = [...new Set([session.feedPath, ...(id === 'legacy' ? settings.shards : [])].filter(Boolean))];
        if (configured.some(value => !feedPath(value))) fail(500, 'A saved Meower timeline path is invalid.');
        const paths = configured.length ? configured : [`/user/files/${sessionFileName(session)}`];
        let combined = { version: 1, posts: [], interactions: [] };
        let loaded = false;
        for (const pointer of paths) {
            const bytes = await readFile(pointer, encodedLimit(MAX_FEED_BYTES));
            if (bytes === null) {
                if (configured.length) fail(500, 'A configured Meower timeline file is missing. Restore it before saving.');
                continue;
            }
            const source = parseBytes(bytes, { limit: MAX_FEED_BYTES, base64: true });
            checkJson(source, 500);
            let feed;
            try {
                feed = normalizeFeed(source);
            } catch (error) {
                fail(500, error.message);
            }
            if (!preserves(source, feed, true)) warnings.push('Legacy timeline rows were repaired for display. The original legacy files will remain unchanged.');
            if (loaded && combined.epoch !== feed.epoch) {
                fail(500, 'Legacy Meower files have conflicting reset markers. Restore matching files before saving.');
            }
            loaded = true;
            combined = {
                version: 1,
                posts: [...combined.posts, ...source.posts],
                interactions: [...combined.interactions, ...source.interactions],
                ...(feed.epoch !== undefined || combined.epoch !== undefined ? { epoch: feed.epoch ?? combined.epoch } : {}),
            };
        }
        // A shard may contain a reply or vote whose post lives in a different shard.
        const repaired = normalizeFeed(combined);
        if (!preserves(combined, repaired, true)) warnings.push('Legacy timeline rows were repaired for display. The original legacy files will remain unchanged.');
        combined = repaired;
        sizeOf(combined, MAX_FEED_BYTES, 'A Meower timeline (20 MiB limit)');
        feeds.push([id, combined]);
    }
    if (raw !== undefined && !preserves(raw, settings, true)) warnings.push('Legacy Meower settings were normalised for display. The original host settings will remain unchanged.');
    const store = { format: 1, revision: 0, settings, feeds: Object.fromEntries(feeds) };
    sizeOf(store, MAX_STORE_BYTES, 'The Meower store (128 MiB limit)');
    return { store, warnings: [...new Set(warnings)] };
}
