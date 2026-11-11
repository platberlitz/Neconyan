const replacements = new Set(['roleplay.swipe', 'roleplay.correct', 'guided.swipe', 'guided.regenerate', 'guided.correction']);
const sources = new WeakMap();
const reserves = new Map();

function hasFollowingMessage(row) {
    for (let sibling = row?.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
        if (sibling.dataset?.roleplayReplacement !== undefined) continue;
        if (sibling.id === 'neconyan-roleplay-preview'
            || sibling.classList?.contains?.('mes')
            || sibling.hasAttribute?.('mesid')) {
            return true;
        }
    }
    return false;
}

/**
 * Empty the old reply and its Companion notes on screen at once, as a browser-side swipe does. The row
 * shrinks with them: holding its old height left a blank page. Display only: the saved chat is untouched,
 * and the returned function puts the old reply back unless something else has redrawn the message meanwhile.
 */
function blankReply(row) {
    const text = row.querySelector?.('.mes_text');
    if (!text) return () => {};
    const kept = [...text.childNodes];
    const placeholder = document.createTextNode('...');
    text.replaceChildren(placeholder);
    const hidden = [...row.querySelectorAll('.mes_reasoning_details, .mes_timer, .tokenCounterDisplay')]
        .filter(node => !node.hidden);
    for (const node of hidden) node.hidden = true;
    // The notes belong to the reply being replaced. Their stylesheet sets a display, so the hidden
    // attribute would not hide them: take them out and put them back where they were.
    const notes = [...row.querySelectorAll('.ica--companion-ledger')]
        .map(node => ({ node, parent: node.parentNode, next: node.nextSibling }));
    for (const { node } of notes) node.remove();
    return () => {
        for (const node of hidden) node.hidden = false;
        if (!row.querySelector('.ica--companion-ledger')) {
            for (const { node, parent, next } of notes) parent?.insertBefore(node, next?.parentNode === parent ? next : null);
        }
        if (text.childNodes.length === 1 && text.firstChild === placeholder) text.replaceChildren(...kept);
    };
}

/**
 * Release a reserved `min-height` on one row, or every active reserve when no row is supplied.
 * @param {Element|null} [row]
 * @param {{restoreStyle?: boolean}} [options]
 * @returns {string|undefined}
 */
export function releaseRoleplayReplacementReserve(row = null, { restoreStyle = true } = {}) {
    if (!row) {
        for (const state of [...reserves.values()]) state.release({ restoreStyle });
        return undefined;
    }
    const state = reserves.get(row);
    if (!state) return undefined;
    return state.release({ restoreStyle });
}

/**
 * Hold a shrinking `min-height` reserve on a replacement preview or saved row until scrolling up,
 * row removal, chat replacement or a newer message releases it without jumping visible content.
 * @param {Element & {style: CSSStyleDeclaration}} row
 * @param {Element & {scrollTop?: number, scrollHeight?: number, clientHeight?: number}} chat
 * @param {number} initialHeight
 * @param {{previousMinHeight?: string, onUserScroll?: (() => void)|null}} [options]
 * @returns {() => void}
 */
export function holdRoleplayReplacementReserve(row, chat, initialHeight, { previousMinHeight = '', onUserScroll = null } = {}) {
    if (!row?.style || !chat || !(initialHeight > 0.5)) {
        if (row?.style) row.style.minHeight = previousMinHeight;
        return () => {};
    }
    for (const [existingRow, existingState] of [...reserves.entries()]) {
        if (existingRow === row || existingState.chat === chat) existingState.release();
    }
    if (hasFollowingMessage(row)) {
        row.style.minHeight = previousMinHeight;
        return () => {};
    }

    let reserved = initialHeight;
    const previousFlexShrink = row.style.flexShrink ?? '';
    const marginBottom = Number.parseFloat(globalThis.getComputedStyle?.(row)?.marginBottom) || 0;
    let lastScrollTop = typeof chat.scrollTop === 'number' ? chat.scrollTop : 0;
    let observer = null;
    row.style.flexShrink = '0';
    row.style.minHeight = `${reserved}px`;

    const release = ({ restoreStyle = true } = {}) => {
        if (!reserves.delete(row)) return previousMinHeight;
        chat.removeEventListener?.('scroll', onScroll);
        observer?.disconnect();
        observer = null;
        if (restoreStyle && row.style) {
            row.style.minHeight = previousMinHeight;
            row.style.flexShrink = previousFlexShrink;
        }
        return previousMinHeight;
    };

    const shrink = ({ allowScrollRelease = false } = {}) => {
        if (!reserves.has(row)) return;
        if (row.isConnected === false || (row.parentElement && row.parentElement !== chat) || hasFollowingMessage(row)) {
            release();
            return;
        }
        const scrollTop = typeof chat.scrollTop === 'number' ? chat.scrollTop : 0;
        const scrolledUp = scrollTop < lastScrollTop - 0.5;
        lastScrollTop = scrollTop;
        if (typeof chat.scrollHeight !== 'number' || typeof chat.clientHeight !== 'number') return;
        const gap = chat.scrollHeight - scrollTop - chat.clientHeight;
        if (gap <= 0.5) return;
        if (allowScrollRelease && scrolledUp) onUserScroll?.();
        const next = Math.max(0, reserved - gap);
        if (next <= 0.5) {
            release();
            return;
        }
        reserved = next;
        row.style.minHeight = `${reserved}px`;
        if ((row.getBoundingClientRect?.().height ?? 0) > reserved + 0.5) release();
    };

    function onScroll() {
        shrink({ allowScrollRelease: true });
    }

    chat.addEventListener?.('scroll', onScroll, { passive: true });
    if (typeof globalThis.MutationObserver === 'function') {
        observer = new globalThis.MutationObserver(() => {
            if (row.isConnected === false || (row.parentElement && row.parentElement !== chat) || hasFollowingMessage(row)) {
                release();
            }
        });
        try {
            observer.observe(chat, { childList: true });
        } catch {
            observer = null;
        }
    }

    reserves.set(row, {
        chat,
        previousMinHeight,
        marginBottom,
        get reserved() { return reserved; },
        syncScrollTop() {
            if (typeof chat.scrollTop === 'number') lastScrollTop = chat.scrollTop;
        },
        shrink,
        release,
    });
    return () => { release(); };
}

/**
 * Carry any remaining height reserve from a replacement preview onto the row that replaces it.
 * @param {Element|null} fromRow
 * @param {(Element & {style?: CSSStyleDeclaration})|null} toRow
 * @param {Element|null} chat
 * @param {{onUserScroll?: (() => void)|null}} [options]
 * @returns {boolean}
 */
export function transferRoleplayReplacementReserve(fromRow, toRow, chat, { onUserScroll = null } = {}) {
    const state = fromRow ? reserves.get(fromRow) : null;
    if (!state) return false;
    const toMargin = toRow ? Number.parseFloat(globalThis.getComputedStyle?.(toRow)?.marginBottom) || 0 : 0;
    const remaining = state.reserved + Math.max(0, state.marginBottom - toMargin);
    state.release();
    if (!toRow?.style || !chat || !(remaining > 0.5)) return false;
    const previousMinHeight = toRow.style.minHeight ?? '';
    holdRoleplayReplacementReserve(toRow, chat, remaining, { previousMinHeight, onUserScroll });
    return reserves.has(toRow);
}

/**
 * Trim or release a row's reserve once its restored scroll position has settled.
 * @param {Element|null} row
 */
export function syncRoleplayReplacementReserve(row) {
    const state = row ? reserves.get(row) : null;
    if (!state) return;
    state.syncScrollTop();
    state.shrink({ allowScrollRelease: false });
    if (reserves.has(row) && (row.getBoundingClientRect?.().height ?? 0) > state.reserved + 0.5) {
        state.release();
    }
}

/**
 * Keep the displayed reply's row, emptied, until its prepared preview can replace it. A row that
 * started above the screen moves to the top of it, and holds only enough height that the chat cannot
 * fall back into older messages.
 */
export function beginRoleplayReplacement(name, messageIndex, isCurrent) {
    if (!replacements.has(name) || !Number.isSafeInteger(messageIndex) || !isCurrent()) return () => {};
    const chat = document.querySelector('#chat');
    if (!chat || chat.querySelector('[data-roleplay-replacement]')) return () => {};
    const original = chat.querySelector(`.mes[mesid="${messageIndex}"]`);
    if (!original) return () => {};
    releaseRoleplayReplacementReserve(original);
    const marker = document.createElement('span');
    marker.hidden = true;
    marker.dataset.roleplayReplacement = String(messageIndex);
    const wasInert = original.inert;
    sources.set(marker, original);
    original.inert = true;
    const measurable = typeof original.getBoundingClientRect === 'function'
        && typeof chat.getBoundingClientRect === 'function' && typeof chat.scrollTop === 'number';
    const oldRect = measurable ? original.getBoundingClientRect() : null;
    const oldTop = oldRect ? oldRect.top - chat.getBoundingClientRect().top : 0;
    const startScrollTop = measurable ? chat.scrollTop : 0;
    const previousMinHeight = original.style?.minHeight ?? '';
    if (oldRect?.height > 0) original.style.minHeight = `${oldRect.height}px`;
    const refill = blankReply(original);
    original.before(marker);
    let landedScrollTop = null;
    if (oldRect?.height > 0) {
        const delta = original.getBoundingClientRect().top - chat.getBoundingClientRect().top - Math.max(0, oldTop);
        if (Math.abs(delta) >= 0.5) chat.scrollTop += delta;
        landedScrollTop = chat.scrollTop;
        const gap = Math.max(0, chat.scrollHeight - chat.scrollTop - chat.clientHeight);
        holdRoleplayReplacementReserve(original, chat, oldRect.height - gap, { previousMinHeight });
    }
    return () => {
        if (!marker.isConnected) return;
        original.inert = wasInert;
        if (isCurrent()) {
            releaseRoleplayReplacementReserve(original);
            refill();
            if (original.isConnected) marker.remove();
            else marker.replaceWith(original);
            // A reader who has not scrolled since goes back to where the old reply was being read.
            if (landedScrollTop !== null && Math.abs(chat.scrollTop - landedScrollTop) < 1) chat.scrollTop = startScrollTop;
        } else {
            original.remove();
            marker.remove();
        }
        sources.delete(marker);
    };
}

/**
 * Swap synchronously with the prepared preview, landing its top at `Math.max(0, oldTop)` and
 * reserving only enough height to prevent bottom clamping.
 * @param {Element|null} marker
 * @param {(Element & {style?: CSSStyleDeclaration})|null} [preview]
 * @param {(Element & {scrollTop?: number, scrollHeight?: number, clientHeight?: number})|null} [chat]
 */
export function commitRoleplayReplacement(marker, preview = null, chat = null) {
    if (!marker?.isConnected) return;
    const original = sources.get(marker);
    if (!original) return;
    if (!original.isConnected || !preview?.style
        || typeof original.getBoundingClientRect !== 'function'
        || typeof chat?.getBoundingClientRect !== 'function') {
        original.remove();
        return;
    }
    const chatTop = chat.getBoundingClientRect().top;
    const originalRect = original.getBoundingClientRect();
    const oldTop = originalRect.top - chatTop;
    const oldHeight = originalRect.height;
    const target = Math.max(0, oldTop);
    const previousMinHeight = preview.style.minHeight ?? '';
    if (oldHeight > 0) preview.style.minHeight = `${oldHeight}px`;
    if (!preview.isConnected) marker.before(preview);
    original.remove();
    if (typeof preview.getBoundingClientRect === 'function' && typeof chat.scrollTop === 'number') {
        const previewTop = preview.getBoundingClientRect().top - chat.getBoundingClientRect().top;
        const delta = previewTop - target;
        if (Math.abs(delta) >= 0.5) chat.scrollTop += delta;
        const landedTop = preview.getBoundingClientRect().top - chat.getBoundingClientRect().top;
        if (target === 0 && landedTop < 0 && chat.scrollTop > 0) {
            chat.scrollTop = Math.max(0, Math.floor(chat.scrollTop) - (Number.isInteger(chat.scrollTop) ? 1 : 0));
        }
    }
    const gap = typeof chat.scrollHeight === 'number' && typeof chat.clientHeight === 'number' && typeof chat.scrollTop === 'number'
        ? Math.max(0, chat.scrollHeight - chat.scrollTop - chat.clientHeight) : 0;
    const reserved = Math.max(0, oldHeight - gap);
    if (reserved > 0.5) holdRoleplayReplacementReserve(preview, chat, reserved, { previousMinHeight });
    else preview.style.minHeight = previousMinHeight;
}
