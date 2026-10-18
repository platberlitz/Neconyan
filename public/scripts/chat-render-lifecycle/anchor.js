import { runSettledFrames } from './scheduler.js';

const DEFAULT_MESSAGE_SELECTOR = '.mes[mesid]';
const DEFAULT_KEY_ATTRIBUTE = 'mesid';
// Below this many rows a full scan is already cheaper than the search setup.
const MIN_BINARY_SEARCH_ROW_COUNT = 24;
// Rows can overlap through negative margins, so confirm the first row above the
// viewport with a short run of earlier rows before trusting the result.
const BACKWARD_CONFIRMATION_ROWS = 2;

function canReadElementRect(element) {
    return Boolean(element && typeof element.getBoundingClientRect === 'function');
}

/**
 * Matches `.mes[mesid]` through the browser's class index instead of selector
 * matching. The attribute filter preserves empty mesid attributes, which the
 * selector also matches. Returns null when the fast API or exact filtering is
 * unavailable so the caller can use the selector.
 */
function getDefaultMessageElements(scrollElement) {
    if (typeof scrollElement.getElementsByClassName !== 'function') {
        return null;
    }

    const elements = scrollElement.getElementsByClassName('mes');
    if (!elements || typeof elements.length !== 'number') {
        return null;
    }

    const messages = [];
    for (let index = 0; index < elements.length; index++) {
        const message = elements[index];
        if (typeof message?.hasAttribute !== 'function') {
            return null;
        }

        if (message.hasAttribute(DEFAULT_KEY_ATTRIBUTE)) {
            messages.push(message);
        }
    }

    return messages;
}

function getMessageElements(scrollElement, messageSelector = DEFAULT_MESSAGE_SELECTOR) {
    if (!scrollElement) {
        return [];
    }

    if (messageSelector === DEFAULT_MESSAGE_SELECTOR) {
        const defaultMessages = getDefaultMessageElements(scrollElement);
        if (defaultMessages) {
            return defaultMessages;
        }
    }

    if (typeof scrollElement.querySelectorAll !== 'function') {
        return [];
    }

    return Array.from(scrollElement.querySelectorAll(messageSelector));
}

function isVisibleMessageRect(rect, scrollRect) {
    return rect.bottom > scrollRect.top && rect.top < scrollRect.bottom;
}

/**
 * Display-none rows report an empty rectangle at the document origin. They can
 * only satisfy the visibility test when the chat itself starts above the window;
 * that case falls back to the exact scan.
 */
function isObviouslyHidden(element) {
    return element?.hidden === true
        || (typeof element?.hasAttribute === 'function' && element.hasAttribute('hidden'))
        || Boolean(element?.classList?.contains?.('displayNone'))
        || element?.style?.display === 'none';
}

/**
 * Rows hidden by a stylesheet that has no matching marker still report an empty
 * rectangle. Requiring zero width and height keeps a rendered zero-height row at
 * the document origin distinct from a hidden row.
 */
function isUnrenderedRect(rect) {
    return rect.top === 0 && rect.bottom === 0 && rect.width === 0 && rect.height === 0;
}

function hasUniformMessageParent(messages) {
    const parent = messages[0]?.parentElement;
    return Boolean(parent) && messages.every(message => message?.parentElement === parent);
}

function findFirstVisibleMessageByScan(messages, scrollRect) {
    for (const message of messages) {
        if (!canReadElementRect(message)) {
            continue;
        }

        const messageRect = message.getBoundingClientRect();
        if (isVisibleMessageRect(messageRect, scrollRect)) {
            return { element: message, rect: messageRect };
        }
    }

    return null;
}

/**
 * Searches rendered rows in document order for the first row ending below the
 * viewport top. Hidden rows are skipped, and a short backward confirmation
 * keeps earlier rows that overlap into the viewport. Geometry is cached only for
 * this call, so the next capture reads fresh layout.
 * @returns {{element: Element, rect: DOMRect}|null} Null means "use the exact scan".
 */
function findFirstVisibleMessageByBinarySearch(messages, scrollRect) {
    if (!Number.isFinite(scrollRect.top) || !Number.isFinite(scrollRect.bottom) || scrollRect.top < 0) {
        return null;
    }

    const rectCache = new Map();
    const readRect = index => {
        if (rectCache.has(index)) {
            return rectCache.get(index);
        }

        const element = messages[index];
        if (!canReadElementRect(element)) {
            rectCache.set(index, null);
            return null;
        }

        const rect = element.getBoundingClientRect();
        rectCache.set(index, rect);
        return rect;
    };

    let low = 0;
    let high = messages.length - 1;
    let candidateIndex = -1;

    while (low <= high) {
        const mid = (low + high) >>> 1;
        let probe = -1;
        let probeRect = null;

        // A hidden row has no usable geometry, so search outward for the nearest
        // rendered row without assuming hidden rows are absent.
        for (let offset = 0; mid - offset >= low || mid + offset <= high; offset++) {
            const left = mid - offset;
            if (left >= low && !isObviouslyHidden(messages[left])) {
                const rect = readRect(left);
                if (rect && !isUnrenderedRect(rect)) {
                    probe = left;
                    probeRect = rect;
                    break;
                }
            }

            const right = mid + offset;
            if (offset > 0 && right <= high && !isObviouslyHidden(messages[right])) {
                const rect = readRect(right);
                if (rect && !isUnrenderedRect(rect)) {
                    probe = right;
                    probeRect = rect;
                    break;
                }
            }
        }

        if (probe < 0 || !probeRect) {
            break;
        }

        if (probeRect.bottom <= scrollRect.top) {
            low = Math.max(mid, probe) + 1;
        } else {
            candidateIndex = probe;
            high = Math.min(mid, probe) - 1;
        }
    }

    if (candidateIndex < 0) {
        return null;
    }

    let anchorIndex = candidateIndex;
    let anchorRect = readRect(candidateIndex);
    let confirmedAbove = 0;

    for (let index = candidateIndex - 1; index >= 0 && confirmedAbove < BACKWARD_CONFIRMATION_ROWS; index--) {
        if (isObviouslyHidden(messages[index])) {
            continue;
        }

        const rect = readRect(index);
        if (!rect || isUnrenderedRect(rect)) {
            continue;
        }

        if (isVisibleMessageRect(rect, scrollRect)) {
            anchorIndex = index;
            anchorRect = rect;
            confirmedAbove = 0;
        } else if (rect.bottom <= scrollRect.top) {
            confirmedAbove += 1;
        }
    }

    return anchorRect && isVisibleMessageRect(anchorRect, scrollRect)
        ? { element: messages[anchorIndex], rect: anchorRect }
        : null;
}

function findFirstVisibleMessage(messages, scrollRect, messageSelector, keyAttribute) {
    const canUseBinarySearch = messageSelector === DEFAULT_MESSAGE_SELECTOR
        && keyAttribute === DEFAULT_KEY_ATTRIBUTE
        && messages.length >= MIN_BINARY_SEARCH_ROW_COUNT
        && hasUniformMessageParent(messages)
        && messages.every(canReadElementRect);

    if (canUseBinarySearch) {
        const found = findFirstVisibleMessageByBinarySearch(messages, scrollRect);
        if (found) {
            return found;
        }
    }

    return findFirstVisibleMessageByScan(messages, scrollRect);
}

/**
 * Captures the first visible message's viewport-relative offset before DOM mutation.
 * @param {Element} scrollElement Scroll container that owns message elements.
 * @param {object} [options] Options.
 * @param {string} [options.messageSelector] Message selector to anchor against.
 * @param {string} [options.keyAttribute] Attribute that identifies the anchor element.
 * @returns {{messageId: string, offsetTop: number}|null}
 */
export function captureVisibleMessageAnchor(scrollElement, { messageSelector = DEFAULT_MESSAGE_SELECTOR, keyAttribute = DEFAULT_KEY_ATTRIBUTE } = {}) {
    if (!canReadElementRect(scrollElement)) {
        return null;
    }

    const scrollRect = scrollElement.getBoundingClientRect();
    const messages = getMessageElements(scrollElement, messageSelector);
    const visible = findFirstVisibleMessage(messages, scrollRect, messageSelector, keyAttribute);

    if (!visible || typeof visible.element.getAttribute !== 'function') {
        return null;
    }

    const messageId = visible.element.getAttribute(keyAttribute);

    if (!messageId) {
        return null;
    }

    return {
        messageId,
        offsetTop: visible.rect.top - scrollRect.top,
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
