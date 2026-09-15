/**
 * The only three functions in this extension allowed to put dynamic data into the DOM.
 *
 * Invariant I4. Everything a card site returns is written by a stranger, and
 * Neconyan runs with `helmet({ contentSecurityPolicy: false })`
 * (src/server-main.js:109), so there is no CSP backstop — these checks are the
 * only defence. There is no innerHTML, insertAdjacentHTML or $().html() anywhere
 * under client/; `tests/render-safety.test.js` enforces that.
 */

import { PLUGIN_BASE } from './constants.js';
import { THUMB_SIZES } from '../shared/schema.js';

/**
 * Writes untrusted text. Cannot create elements, however hostile the input.
 * @param {Element | null | undefined} element
 * @param {unknown} value
 */
export function setText(element, value) {
    if (!element) {
        return;
    }
    element.textContent = value === null || value === undefined ? '' : String(value);
}

/**
 * True only for a same-origin plugin path, or an https URL whose hostname is an
 * EXACT member of allowedHosts.
 *
 * Exact match matters: a suffix test like `host.endsWith('botbooru.com')` also
 * accepts `evil-botbooru.com`, and a `includes()` test also accepts
 * `botbooru.com.evil.tld`. Neither is acceptable.
 *
 * @param {unknown} raw
 * @param {readonly string[]} allowedHosts
 * @returns {boolean}
 */
export function isAllowedImageUrl(raw, allowedHosts) {
    return isAllowedProxyThumbnailUrl(raw) || isAllowedUpstreamUrl(raw, allowedHosts);
}

/**
 * Validates the one same-origin URL an image may use. Parsing before comparing
 * pathname closes dot-segment and percent-encoded traversal escapes.
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isAllowedProxyThumbnailUrl(raw) {
    if (typeof raw !== 'string' || raw === '') {
        return false;
    }

    let url;
    try {
        url = new URL(raw, window.location.origin);
    } catch {
        return false;
    }

    if (url.origin !== window.location.origin || url.pathname !== `${PLUGIN_BASE}/thumb` || url.hash !== '') {
        return false;
    }

    const expected = ['source', 'ref', 'size'];
    const entries = [...url.searchParams.entries()];
    if (entries.length !== expected.length || entries.some(([key]) => !expected.includes(key))) {
        return false;
    }
    if (expected.some((key) => url.searchParams.getAll(key).length !== 1)) {
        return false;
    }

    const source = url.searchParams.get('source');
    const ref = url.searchParams.get('ref');
    const size = url.searchParams.get('size');
    return /^[a-z0-9-]{1,64}$/.test(source ?? '')
        && typeof ref === 'string'
        && ref.length > 0
        && ref.length <= 2048
        && THUMB_SIZES.includes(size);
}

/**
 * The same check without the same-origin exemption: an https URL on one of the
 * source's own hosts, and nothing else.
 *
 * Used before the browser fetches a source directly on the server's behalf.
 * There the plugin's own path is not a valid answer, so accepting it would be a
 * hole rather than a convenience.
 *
 * @param {unknown} raw
 * @param {readonly string[]} allowedHosts
 * @returns {boolean}
 */
export function isAllowedUpstreamUrl(raw, allowedHosts) {
    if (typeof raw !== 'string' || raw === '') {
        return false;
    }

    let url;
    try {
        url = new URL(raw, window.location.origin);
    } catch {
        return false;
    }

    // Rejects javascript:, data:, blob:, file: and plain http:.
    if (url.protocol !== 'https:') {
        return false;
    }
    if ((url.port !== '' && url.port !== '443') || url.username !== '' || url.password !== '') {
        return false;
    }

    if (!Array.isArray(allowedHosts)) {
        return false;
    }

    return allowedHosts.includes(url.hostname.toLowerCase());
}

/**
 * Points an <img> at a URL, or clears it if the URL fails the check.
 * @param {HTMLImageElement | null | undefined} img
 * @param {unknown} url
 * @param {readonly string[]} allowedHosts
 * @returns {boolean} whether the source was accepted
 */
export function setImgSafe(img, url, allowedHosts) {
    if (!img) {
        return false;
    }

    if (!isAllowedImageUrl(url, allowedHosts)) {
        img.removeAttribute('src');
        return false;
    }

    // Set before src so they apply to the request itself.
    img.referrerPolicy = 'no-referrer';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = String(url);
    return true;
}

/**
 * Points an <a> at a URL, or disables it if the URL fails the check.
 * @param {HTMLAnchorElement | null | undefined} anchor
 * @param {unknown} url
 * @param {readonly string[]} allowedHosts
 * @returns {boolean} whether the link was accepted
 */
export function setLinkSafe(anchor, url, allowedHosts) {
    if (!anchor) {
        return false;
    }

    if (!isAllowedUpstreamUrl(url, allowedHosts)) {
        anchor.removeAttribute('href');
        anchor.setAttribute('aria-disabled', 'true');
        return false;
    }

    anchor.rel = 'noopener noreferrer nofollow';
    anchor.target = '_blank';
    anchor.referrerPolicy = 'no-referrer';
    anchor.removeAttribute('aria-disabled');
    anchor.href = String(url);
    return true;
}

/**
 * Creates an element with an optional class and text. Text goes through
 * textContent, never innerHTML.
 * @param {string} tag
 * @param {string} [className]
 * @param {unknown} [text]
 */
export function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        setText(node, text);
    }
    return node;
}
