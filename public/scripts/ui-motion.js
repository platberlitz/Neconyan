// Short, interruptible motion for user-driven navigation. Nothing awaits these
// effects, and only opacity/translate change, so chat layout and scrolling stay put.
const activeMotions = new Map();
const easeOut = 'cubic-bezier(0.22, 1, 0.36, 1)';
let preferencesBound = false;

export function prefersReducedUiMotion() {
    return document.body?.classList.contains('reduced-motion')
        || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function bindPreferences() {
    if (preferencesBound || !document.body) return;
    preferencesBound = true;
    const settleReducedMotion = () => {
        if (prefersReducedUiMotion()) {
            for (const motion of [...activeMotions.values()]) motion.finish();
        }
    };
    window.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener('change', settleReducedMotion);
    new MutationObserver(settleReducedMotion).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

export function isUiClosing(element) {
    return activeMotions.get(element)?.closing === true;
}

export function finishUiMotion(element) {
    activeMotions.get(element)?.finish();
}

function isVisible(element) {
    return element?.isConnected && element.getClientRects().length > 0
        && getComputedStyle(element).visibility !== 'hidden';
}

function play(element, frames, { duration, closing = false, complete = () => {}, restore = () => {} }) {
    bindPreferences();
    const animation = element.animate(frames, { duration, easing: easeOut, fill: 'both' });
    let settled = false;
    const cancel = () => {
        if (settled) return;
        settled = true;
        activeMotions.delete(element);
        animation.onfinish = null;
        animation.oncancel = null;
        animation.cancel();
        restore();
    };
    const finish = () => {
        if (settled) return;
        cancel();
        complete();
    };
    activeMotions.set(element, { closing, cancel, finish });
    animation.onfinish = finish;
    animation.oncancel = finish;
}

/** Reveal newly rendered content once, never individual streaming tokens. */
export function revealUi(element, { distance = 6, duration = 180 } = {}) {
    if (!element) return;
    finishUiMotion(element);
    if (prefersReducedUiMotion() || !isVisible(element) || typeof element.animate !== 'function') return;
    play(element, [{ opacity: 0, translate: `0 ${distance}px` }, { opacity: 1, translate: '0 0' }], { duration });
}

/**
 * Apply an opening immediately; keep a closing surface painted for 120ms.
 * The caller owns its logical state. Closing content becomes inert immediately,
 * and a subsequent opening cancels the obsolete hide callback.
 */
export function setUiVisibility(element, open, applyVisibility, { distance = 6, animate = true } = {}) {
    if (!element) return;
    const previous = activeMotions.get(element);
    const immediate = !animate || prefersReducedUiMotion() || typeof element.animate !== 'function';
    // Repeated state synchronisation must not cancel an arrival halfway through.
    if (previous && previous.closing === !open && !immediate) {
        if (open) applyVisibility(true);
        return;
    }
    if (immediate) {
        previous?.cancel();
        applyVisibility(open);
        return;
    }
    const visible = isVisible(element);
    const style = previous ? getComputedStyle(element) : null;
    const interrupted = style ? { opacity: style.opacity, translate: style.translate } : null;
    previous?.cancel();

    if (!open && !visible) {
        applyVisibility(open);
        return;
    }
    if (open) {
        applyVisibility(true);
        if (visible && !previous?.closing) return;
        play(element, [interrupted ?? { opacity: 0, translate: `0 ${distance}px` }, { opacity: 1, translate: '0 0' }], { duration: 180 });
    } else {
        const wasInert = element.inert;
        element.inert = true;
        play(element, [interrupted ?? { opacity: 1, translate: '0 0' }, { opacity: 0, translate: `0 ${Math.min(distance, 3)}px` }], {
            duration: 120,
            closing: true,
            restore: () => { element.inert = wasInert; },
            complete: () => applyVisibility(false),
        });
    }
}

/** Match existing jQuery accordions to the same timing and accessibility policy. */
export function getUiSlideOptions() {
    if (window.jQuery) window.jQuery.easing.neconyanEaseOut = progress => 1 - Math.pow(1 - progress, 3);
    return { duration: prefersReducedUiMotion() ? 0 : 180, easing: 'neconyanEaseOut' };
}
