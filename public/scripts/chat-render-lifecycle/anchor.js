import { runSettledFrames } from './scheduler.js';

const DEFAULT_MESSAGE_SELECTOR = '.mes[mesid]';

function canReadElementRect(element) {
    return Boolean(element && typeof element.getBoundingClientRect === 'function');
}

function getMessageElements(scrollElement, messageSelector = DEFAULT_MESSAGE_SELECTOR) {
    if (!scrollElement || typeof scrollElement.querySelectorAll !== 'function') {
        return [];
    }

    return Array.from(scrollElement.querySelectorAll(messageSelector));
}

/**
 * Captures the first visible message's viewport-relative offset before DOM mutation.
 * @param {Element} scrollElement Scroll container that owns message elements.
 * @param {object} [options] Options.
 * @param {string} [options.messageSelector] Message selector to anchor against.
 * @param {string} [options.keyAttribute] Attribute that identifies the anchor element.
 * @returns {{messageId: string, offsetTop: number}|null}
 */
export function captureVisibleMessageAnchor(scrollElement, { messageSelector = DEFAULT_MESSAGE_SELECTOR, keyAttribute = 'mesid' } = {}) {
    if (!canReadElementRect(scrollElement)) {
        return null;
    }

    const scrollRect = scrollElement.getBoundingClientRect();
    const anchorElement = getMessageElements(scrollElement, messageSelector).find(message => {
        if (!canReadElementRect(message)) {
            return false;
        }

        const messageRect = message.getBoundingClientRect();
        return messageRect.bottom > scrollRect.top && messageRect.top < scrollRect.bottom;
    });

    if (!anchorElement || typeof anchorElement.getAttribute !== 'function') {
        return null;
    }

    const messageId = anchorElement.getAttribute(keyAttribute);

    if (!messageId) {
        return null;
    }

    return {
        messageId,
        offsetTop: anchorElement.getBoundingClientRect().top - scrollRect.top,
    };
}

/**
 * Finds the element an anchor measures, preferring the requested row and using
 * the fallback row when the replacement has not rendered the primary row yet.
 * @param {Element} scrollElement Scroll container that owns message elements.
 * @param {{messageId: string, offsetTop: number, part?: string, fallback?: {messageId: string, offsetTop: number}|null}} anchor Anchor captured before mutation.
 * @param {string} messageSelector Message selector to anchor against.
 * @param {string} keyAttribute Attribute that identifies the anchor element.
 * @returns {{element: Element, offsetTop: number, part: string|null}|null}
 */
function resolveVisibleMessageAnchor(scrollElement, anchor, messageSelector, keyAttribute) {
    const messages = getMessageElements(scrollElement, messageSelector);
    const findMessage = messageId => messages.find(message => typeof message.getAttribute === 'function'
        && message.getAttribute(keyAttribute) === String(messageId));
    const element = findMessage(anchor.messageId);
    if (canReadElementRect(element)) {
        return { element, offsetTop: anchor.offsetTop, part: typeof anchor.part === 'string' ? anchor.part : null };
    }

    const fallback = anchor.fallback;
    const fallbackElement = fallback ? findMessage(fallback.messageId) : null;
    if (canReadElementRect(fallbackElement)) {
        return { element: fallbackElement, offsetTop: fallback.offsetTop, part: null };
    }

    return null;
}

/**
 * Restores a previously captured message anchor after DOM mutation.
 * @param {Element & {scrollTop: number}} scrollElement Scroll container that owns message elements.
 * @param {{messageId: string, offsetTop: number, part?: string, fallback?: {messageId: string, offsetTop: number}|null}|null} anchor Anchor captured before mutation.
 * @param {object} [options] Options.
 * @param {string} [options.messageSelector] Message selector to anchor against.
 * @param {string} [options.keyAttribute] Attribute that identifies the anchor element.
 * @returns {boolean} Whether an anchor element was found and measured.
 */
export function restoreVisibleMessageAnchor(scrollElement, anchor, { messageSelector = DEFAULT_MESSAGE_SELECTOR, keyAttribute = 'mesid' } = {}) {
    if (!canReadElementRect(scrollElement) || !anchor?.messageId || !Number.isFinite(anchor.offsetTop) || typeof scrollElement.scrollTop !== 'number') {
        return false;
    }

    const resolved = resolveVisibleMessageAnchor(scrollElement, anchor, messageSelector, keyAttribute);
    if (!resolved) {
        return false;
    }

    const partElement = resolved.part && typeof resolved.element.querySelector === 'function'
        ? resolved.element.querySelector(resolved.part)
        : null;
    const measuredElement = canReadElementRect(partElement) ? partElement : resolved.element;
    const scrollRect = scrollElement.getBoundingClientRect();
    const nextOffsetTop = measuredElement.getBoundingClientRect().top - scrollRect.top;
    scrollElement.scrollTop += nextOffsetTop - resolved.offsetTop;
    return true;
}

/**
 * Re-applies anchor restoration over multiple frames while late layout settles.
 * @param {Element & {scrollTop: number}} scrollElement Scroll container that owns message elements.
 * @param {{messageId: string, offsetTop: number}|null} anchor Anchor captured before mutation.
 * @param {object} [options] Options.
 * @param {number} [options.frames=8] Number of animation frames to settle over.
 * @param {(callback: FrameRequestCallback) => number|void} [options.requestAnimationFrameRef] Frame scheduler.
 * @param {() => boolean} [options.isCurrent] Whether this anchor still owns the scroll position.
 * @param {string} [options.messageSelector] Message selector to anchor against.
 * @param {string} [options.keyAttribute] Attribute that identifies the anchor element.
 */
export async function settleVisibleMessageAnchor(scrollElement, anchor, {
    frames = 8,
    requestAnimationFrameRef = globalThis.requestAnimationFrame,
    isCurrent = () => true,
    messageSelector = DEFAULT_MESSAGE_SELECTOR,
    keyAttribute = 'mesid',
} = {}) {
    if (!anchor || typeof requestAnimationFrameRef !== 'function') {
        return;
    }

    await runSettledFrames(() => {
        if (isCurrent()) restoreVisibleMessageAnchor(scrollElement, anchor, { messageSelector, keyAttribute });
    }, {
        frames,
        requestAnimationFrameRef,
    });
}
