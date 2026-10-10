// Short, interruptible motion for user-driven navigation. Nothing awaits these
// effects, and only opacity/translate change, so chat layout and scrolling stay put.
const activeMotions = new Map();
const easeOut = 'cubic-bezier(0.22, 1, 0.36, 1)';
// Edge drawers follow the iOS sheet curve: a quick start that settles gently.
const easeDrawer = 'cubic-bezier(0.32, 0.72, 0, 1)';
export const UI_MOTION_TIMING = Object.freeze({
    revealMs: 240,
    fadeInMs: 220,
    fadeOutMs: 160,
    drawerInMs: 380,
    drawerOutMs: 280,
});
let preferencesBound = false;
// A page follows the control that opened it: down from the top bar, out of the sidebar.
const ORIGIN_EDGES = [['#top-bar', 'top'], ['#neconyan-workspace-rail', 'left']];
// Some controls open their page after an import or a settled state, so the tap stays valid briefly.
const ORIGIN_WINDOW_MS = 1000;
let lastOrigin = null;

function rememberOrigin(event) {
    const target = typeof event.target?.closest === 'function' ? event.target : null;
    const edge = target ? ORIGIN_EDGES.find(([selector]) => target.closest(selector))?.[1] : null;
    lastOrigin = edge ? { edge, at: performance.now() } : null;
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('click', rememberOrigin, true);
}

/**
 * The edge a drawer page travels on. Opening takes the side of the control that was
 * just pressed, or the page's own side; closing returns along the edge it opened from.
 */
export function getUiDrawerEdge(element, open, fallback) {
    if (!element?.dataset) return fallback;
    if (open) {
        const origin = lastOrigin && performance.now() - lastOrigin.at < ORIGIN_WINDOW_MS ? lastOrigin.edge : null;
        lastOrigin = null;
        element.dataset.uiMotionEdge = origin ?? fallback;
    }
    return element.dataset.uiMotionEdge || fallback;
}

/**
 * While a page travels to or from the bar it belongs to, that bar stays in front,
 * so the page emerges from under the top bar or out of the sidebar edge.
 * Returns a function that restores the bar.
 */
function raiseOriginBar(element, edge) {
    if (element.dataset?.uiMotionEdge !== edge) return () => {};
    const bar = document.querySelector(ORIGIN_EDGES.find(([, side]) => side === edge)?.[0] ?? null);
    if (!bar || bar.contains(element)) return () => {};
    let layer = element;
    for (let node = element; node && node !== document.body; node = node.parentElement) {
        if (getComputedStyle(node).zIndex !== 'auto') layer = node;
    }
    const value = bar.style.getPropertyValue('z-index');
    const priority = bar.style.getPropertyPriority('z-index');
    bar.style.setProperty('z-index', String((Number.parseInt(getComputedStyle(layer).zIndex, 10) || 0) + 1), 'important');
    return () => bar.style.setProperty('z-index', value, priority);
}

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
    if (!element?.isConnected) return false;
    // checkVisibility reads styles only; getClientRects forces a full layout
    // right when a drawer starts to move, which costs the first frames on phones.
    if (typeof element.checkVisibility === 'function') {
        return element.checkVisibility({ visibilityProperty: true });
    }
    return element.getClientRects().length > 0
        && getComputedStyle(element).visibility !== 'hidden';
}

function play(element, frames, { duration, easing = easeOut, closing = false, linked = [], complete = () => {}, restore = () => {} }) {
    bindPreferences();
    const options = { duration, easing, fill: 'both' };
    const animation = element.animate(frames, options);
    // Linked parts settle with their surface, so neither can snap back on its own.
    const parts = linked.map(([part, partFrames]) => part.animate(partFrames, options));
    let settled = false;
    let started = false;
    // Safari starts the clock when animate() is called, so the rest of the tap's
    // work is taken out of the motion and a busy frame can skip it entirely.
    // Rewinding on the first frame makes every browser start from the first keyframe.
    const rewind = () => {
        for (const motion of [animation, ...parts]) {
            motion.currentTime = 0;
            if (motion.playState === 'finished') motion.play();
        }
    };
    requestAnimationFrame(() => {
        if (settled) return;
        started = true;
        rewind();
    });
    const cancel = () => {
        if (settled) return;
        settled = true;
        activeMotions.delete(element);
        animation.onfinish = null;
        animation.oncancel = null;
        animation.cancel();
        for (const part of parts) part.cancel();
        restore();
    };
    const finish = () => {
        if (settled) return;
        cancel();
        complete();
    };
    activeMotions.set(element, { closing, cancel, finish });
    animation.onfinish = () => {
        // A hidden page paints no frames, so it would never reach the rewind.
        if (started || document.hidden) finish();
        else rewind();
    };
    animation.oncancel = finish;
}

/** Reveal newly rendered content once, never individual streaming tokens. */
export function revealUi(element, { distance = 6, duration = UI_MOTION_TIMING.revealMs } = {}) {
    if (!element) return;
    // Restarting an arrival that is already under way would blink it back to transparent.
    if (activeMotions.get(element)?.closing === false) return;
    finishUiMotion(element);
    if (prefersReducedUiMotion() || !isVisible(element) || typeof element.animate !== 'function') return;
    const frames = distance
        ? [{ opacity: 0, translate: `0 ${distance}px` }, { opacity: 1, translate: '0 0' }]
        : [{ opacity: 0 }, { opacity: 1 }];
    play(element, frames, { duration });
}

/**
 * Apply an opening immediately; keep a closing surface painted until it has left.
 * The caller owns its logical state. Closing content becomes inert immediately,
 * and a subsequent opening cancels the obsolete hide callback.
 *
 * `edge` slides the surface to and from that side of the screen. With
 * `slideTarget`, the surface itself only fades and that inner element slides,
 * which keeps a full-screen blurred backdrop still while its panel moves.
 * `drawerPace` gives a plain fade, such as a scrim, the timing of the drawer it sits behind.
 */
export function setUiVisibility(element, open, applyVisibility, { distance = 6, animate = true, edge = null, slideTarget = null, drawerPace = false } = {}) {
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
    // Drawers travel back to their own edge. Menus retain the small fade/reveal.
    const slide = { left: '-100% 0', right: '100% 0', top: '0 -100%', bottom: '0 100%' }[edge];
    const part = slide && slideTarget?.isConnected && slideTarget !== element ? slideTarget : null;
    const visible = isVisible(element);
    const surfaceSlide = part ? null : slide;
    // A surface that does not travel keeps its own translate, which may be what positions it.
    const still = !surfaceSlide && (Boolean(part) || !distance);
    const style = previous ? getComputedStyle(element) : null;
    const interrupted = style ? (still ? { opacity: style.opacity } : { opacity: style.opacity, translate: style.translate }) : null;
    const partInterrupted = previous && part ? { translate: getComputedStyle(part).translate } : null;
    previous?.cancel();
    const restFrame = still ? { opacity: 1 } : { opacity: 1, translate: '0 0' };
    const hiddenFrame = surfaceSlide
        ? { opacity: 1, translate: surfaceSlide }
        : still ? { opacity: 0 } : { opacity: 0, translate: `0 ${open ? distance : Math.min(distance, 3)}px` };

    if (!open && !visible) {
        applyVisibility(open);
        return;
    }
    const drawerTiming = Boolean(slide) || drawerPace;
    const easing = drawerTiming ? easeDrawer : easeOut;
    const linked = part
        ? [[part, open ? [partInterrupted ?? { translate: slide }, { translate: '0 0' }] : [partInterrupted ?? { translate: '0 0' }, { translate: slide }]]]
        : [];
    if (open) {
        applyVisibility(true);
        if (visible && !previous?.closing) return;
        play(element, [interrupted ?? hiddenFrame, restFrame], {
            duration: drawerTiming ? UI_MOTION_TIMING.drawerInMs : UI_MOTION_TIMING.fadeInMs,
            easing,
            linked,
            restore: surfaceSlide ? raiseOriginBar(element, edge) : undefined,
        });
    } else {
        const wasInert = element.inert;
        const pointerEvents = element.style.getPropertyValue('pointer-events');
        const pointerPriority = element.style.getPropertyPriority('pointer-events');
        element.inert = true;
        // Inert content still wins the hit test, so a fading surface would swallow taps meant for what lies beneath.
        element.style.setProperty('pointer-events', 'none', 'important');
        const lowerOriginBar = surfaceSlide ? raiseOriginBar(element, edge) : () => {};
        play(element, [interrupted ?? restFrame, hiddenFrame], {
            duration: drawerTiming ? UI_MOTION_TIMING.drawerOutMs : UI_MOTION_TIMING.fadeOutMs,
            easing,
            linked,
            closing: true,
            restore: () => {
                element.inert = wasInert;
                element.style.setProperty('pointer-events', pointerEvents, pointerPriority);
                lowerOriginBar();
            },
            complete: () => applyVisibility(false),
        });
    }
}

/** Match existing jQuery accordions to the same timing and accessibility policy. */
export function getUiSlideOptions() {
    if (window.jQuery) window.jQuery.easing.neconyanEaseOut = progress => 1 - Math.pow(1 - progress, 3);
    return { duration: prefersReducedUiMotion() ? 0 : UI_MOTION_TIMING.fadeInMs, easing: 'neconyanEaseOut' };
}
