const SAFE_CREATOR_IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/]+=*$/i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Portrait candidates are stored as inline image data URLs. Anything else could make the
 * workspace fetch or display an arbitrary address from a restored backup.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeCreatorImageDataUrl(value) {
    return typeof value === 'string' && value.length <= 8 * 1024 * 1024 && SAFE_CREATOR_IMAGE_DATA_URL.test(value);
}

/**
 * Drafts reject media addresses that point anywhere: URL schemes other than a safe image
 * data URL, absolute paths and protocol-relative addresses.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAcceptableCreatorMediaValue(value) {
    if (typeof value !== 'string') return false;
    const text = value.trim();
    if (URL_SCHEME.test(text) || text.startsWith('/') || text.startsWith('\\')) return isSafeCreatorImageDataUrl(value);
    return true;
}
