// Dependency-free URL checks for Conversation Mode attachments and generated
// images. Stored chat data can be edited or imported, so every URL is checked
// before it reaches an element's src/href or a same-origin fetch.

const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|jpg|webp|gif|avif);base64,[A-Za-z0-9+/=\s]*$/i;
const SAFE_DATA_MEDIA_RE = /^data:(?:image\/(?:png|jpeg|jpg|webp|gif|avif)|video\/(?:mp4|webm|ogg)|audio\/(?:mpeg|mp3|ogg|wav|webm|aac|flac|mp4)|text\/plain);base64,[A-Za-z0-9+/=\s]*$/i;
const FETCHABLE_USER_PREFIXES = ['/user/images/', '/user/files/'];

function getPageOrigin() {
    try {
        return globalThis.location?.origin || '';
    } catch {
        return '';
    }
}

function decodePathSafely(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return null;
    }
}

/**
 * Returns the local /user/... path for a same-origin URL, or '' when the value
 * is not a safe local user media path (no '..', no protocol-relative '//').
 * @param {string} value URL or path
 * @param {readonly string[]} [prefixes] Allowed path prefixes
 * @returns {string}
 */
export function getSafeLocalUserMediaPath(value, prefixes = ['/user/']) {
    let raw = String(value ?? '').trim();
    if (!raw || raw.includes('\\')) {
        return '';
    }

    if (/^https?:\/\//i.test(raw)) {
        const origin = getPageOrigin();
        if (!origin) {
            return '';
        }
        try {
            const parsed = new URL(raw);
            if (parsed.origin !== origin) {
                return '';
            }
            raw = `${parsed.pathname}${parsed.search}`;
        } catch {
            return '';
        }
    }

    if (raw.startsWith('user/')) {
        raw = `/${raw}`;
    }
    if (!raw.startsWith('/') || raw.startsWith('//')) {
        return '';
    }

    const pathPart = raw.split(/[?#]/, 1)[0];
    const decoded = decodePathSafely(pathPart);
    if (decoded === null || decoded.includes('\\') || decoded.startsWith('//')) {
        return '';
    }
    if (decoded.split('/').some(segment => segment === '..' || segment === '.')) {
        return '';
    }
    if (!prefixes.some(prefix => decoded.startsWith(prefix))) {
        return '';
    }

    return raw;
}

/**
 * Checks whether a URL is an http(s) URL on another origin.
 * @param {string} value URL
 * @returns {boolean}
 */
export function isExternalHttpMediaUrl(value) {
    const raw = String(value ?? '').trim();
    if (!/^https?:\/\//i.test(raw)) {
        return false;
    }
    try {
        return new URL(raw).origin !== getPageOrigin();
    } catch {
        return false;
    }
}

/**
 * Returns a URL that is safe to place in an attachment's src/href, or ''.
 * Allows local /user/... paths, base64 raster/media data URLs and same-origin
 * blob: URLs, plus external http(s) only when external media is allowed.
 * javascript:, SVG and HTML data URLs are always rejected.
 * @param {unknown} value URL
 * @param {{ allowExternal?: boolean, kind?: 'image'|'media'|'file' }} [options]
 * @returns {string}
 */
export function getSafeConversationMediaUrl(value, { allowExternal = false, kind = 'image' } = {}) {
    if (typeof value !== 'string') {
        return '';
    }
    const raw = value.trim();
    if (!raw) {
        return '';
    }

    if (/^data:/i.test(raw)) {
        const pattern = kind === 'image' ? SAFE_DATA_IMAGE_RE : SAFE_DATA_MEDIA_RE;
        return pattern.test(raw) ? raw : '';
    }

    if (/^blob:/i.test(raw)) {
        const origin = getPageOrigin();
        return origin && raw.startsWith(`blob:${origin}/`) ? raw : '';
    }

    const local = getSafeLocalUserMediaPath(raw);
    if (local) {
        return local;
    }

    if (allowExternal && isExternalHttpMediaUrl(raw)) {
        return raw;
    }

    return '';
}

/**
 * Returns the local path the browser may fetch for prompt image conversion, or ''.
 * Only /user/images/ and /user/files/ are readable, so stored data cannot point
 * the fetch at API endpoints such as /api/secrets/*.
 * @param {unknown} value URL
 * @returns {string}
 */
export function getFetchableConversationImagePath(value) {
    if (typeof value !== 'string') {
        return '';
    }
    return getSafeLocalUserMediaPath(value, FETCHABLE_USER_PREFIXES);
}

/**
 * Checks whether a data URL is a base64 raster image (never SVG or HTML).
 * @param {unknown} value URL
 * @returns {boolean}
 */
export function isSafeConversationDataImageUrl(value) {
    return typeof value === 'string' && SAFE_DATA_IMAGE_RE.test(value.trim());
}

/**
 * Reads the live power_user settings through the public context, for modules
 * that cannot import power-user.js statically.
 * @returns {object | null}
 */
export function getConversationMediaSettings() {
    try {
        return globalThis.SillyTavern?.getContext?.()?.powerUserSettings ?? null;
    } catch {
        return null;
    }
}

/**
 * Mirrors chats.js isExternalMediaAllowed for the Conversation character
 * without importing chats.js into Conversation's static module graph.
 * @param {{ forbid_external_media?: boolean, external_media_allowed_overrides?: string[], external_media_forbidden_overrides?: string[] } | null | undefined} settings power_user settings
 * @param {string | null | undefined} entityId Character avatar or group id
 * @returns {boolean}
 */
export function isConversationExternalMediaAllowed(settings, entityId) {
    const id = String(entityId ?? '');
    if (id) {
        if (Array.isArray(settings?.external_media_allowed_overrides) && settings.external_media_allowed_overrides.includes(id)) {
            return true;
        }
        if (Array.isArray(settings?.external_media_forbidden_overrides) && settings.external_media_forbidden_overrides.includes(id)) {
            return false;
        }
    }
    return !settings?.forbid_external_media;
}
