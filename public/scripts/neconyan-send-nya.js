// A random cat sound pops out of the paw Send button, then floats up and fades.
// Observe touches before the iOS fast-tap handler consumes them. Do not depend on
// a pointerup or compatibility click surviving that handler's preventDefault().
// Mouse/pen use pointer events; keyboard activation uses trusted clicks (detail 0).
export const SEND_NYA_SELECTOR = '#send_but, #sb_conversation_send';
const SOUNDS = ['nya!', 'mrrp?', 'mrrah', 'mew', 'purr'];
const MAX_ACTIVE_POPS = 8;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const pressed = new Map();
const touched = new Map();
let activePops = 0;

export function popNya(anchor, { reduced = reducedMotion.matches, random = Math.random } = {}) {
    if (activePops >= MAX_ACTIVE_POPS) return null;
    const pop = document.createElement('span');
    pop.className = 'neconyan-send-nya';
    pop.textContent = SOUNDS[Math.floor(random() * SOUNDS.length)];
    pop.setAttribute('aria-hidden', 'true');
    Object.assign(pop.style, {
        position: 'absolute',
        zIndex: '2147483000',
        pointerEvents: 'none',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        font: '400 20px/1 var(--sb-font-display, var(--mainFontFamily, sans-serif))',
        color: 'var(--neco-ginger, var(--sb-accent, var(--SmartThemeQuoteColor)))',
        textShadow: '0 0 2px var(--neco-surface, var(--SmartThemeBlurTintColor)), 0 1px 3px var(--neco-surface, var(--SmartThemeBlurTintColor))',
        transform: 'translateX(50%)',
        opacity: '0',
    });
    // Roleplay hides the paw behind Stop while sending, which would hide a pop
    // inside it too. Host it in the paw's row instead, placed by comparing the
    // paw and the row: both rects share one coordinate system, so whatever the
    // keyboard has done to the viewport cancels out. Measure from the row's
    // right and bottom edges, the end where Stop takes the paw's slot.
    const host = anchor.parentElement || anchor;
    const hostStyle = window.getComputedStyle(host);
    if (hostStyle.position === 'static') host.style.position = 'relative';
    const box = host.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    pop.style.right = `${box.right - (parseFloat(hostStyle.borderRightWidth) || 0) - (rect.left + rect.width / 2)}px`;
    pop.style.bottom = `${box.bottom - (parseFloat(hostStyle.borderBottomWidth) || 0) - rect.top}px`;
    host.append(pop);
    activePops += 1;

    const drift = Math.round((random() - 0.5) * 36);
    const tilt = Math.round((random() - 0.5) * 24);
    const frames = reduced
        ? [{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }]
        : [
            { opacity: 0, transform: 'translateX(50%) translateY(0) scale(0.6) rotate(0deg)' },
            { opacity: 1, transform: `translateX(50%) translateY(-6px) scale(1.15) rotate(${tilt / 2}deg)`, offset: 0.18 },
            { opacity: 1, transform: `translateX(calc(50% + ${drift / 2}px)) translateY(-20px) scale(1) rotate(${tilt}deg)`, offset: 0.6 },
            { opacity: 0, transform: `translateX(calc(50% + ${drift}px)) translateY(-34px) scale(0.95) rotate(${tilt}deg)` },
        ];
    let done = false;
    let cleanupTimer;
    const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(cleanupTimer);
        activePops -= 1;
        pop.remove();
    };
    // Sending can occupy the main thread. Start both clocks at the next paint so
    // the fallback cannot remove the pop before its animation becomes visible.
    window.requestAnimationFrame(() => {
        if (typeof pop.animate === 'function') {
            const animation = pop.animate(frames, { duration: reduced ? 700 : 900, easing: 'ease-out', fill: 'forwards' });
            animation.addEventListener('finish', finish);
            animation.addEventListener('cancel', finish);
        } else {
            pop.style.opacity = '1';
        }
        cleanupTimer = setTimeout(finish, 1200);
    });
    return pop;
}

function onPointerDown(event) {
    if (event.pointerType === 'touch') return;
    const button = event.target.closest?.(SEND_NYA_SELECTOR);
    if (!button || !event.isTrusted || event.button > 0) return;
    pressed.set(event.pointerId, button);
}

function onPointerUp(event) {
    const button = pressed.get(event.pointerId);
    pressed.delete(event.pointerId);
    if (!button || !event.isTrusted) return;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (target && button.contains(target)) popNya(button);
}

function onClick(event) {
    if (!event.isTrusted || event.detail !== 0) return;
    const button = event.target.closest?.(SEND_NYA_SELECTOR);
    if (!button) return;
    popNya(button);
}

function onTouchStart(event) {
    if (!event.isTrusted) return;
    const button = event.target.closest?.(SEND_NYA_SELECTOR);
    if (!button) return;
    for (const touch of event.changedTouches) touched.set(touch.identifier, button);
}

function onTouchEnd(event) {
    for (const touch of event.changedTouches) {
        const button = touched.get(touch.identifier);
        touched.delete(touch.identifier);
        if (!button || !event.isTrusted) continue;
        const target = document.elementFromPoint(touch.clientX, touch.clientY);
        if (target && button.contains(target)) popNya(button);
    }
}

function onTouchCancel(event) {
    for (const touch of event.changedTouches) touched.delete(touch.identifier);
}

document.addEventListener('pointerdown', onPointerDown, true);
document.addEventListener('pointerup', onPointerUp, true);
document.addEventListener('pointercancel', event => pressed.delete(event.pointerId), true);
document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
document.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
document.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: true });
document.addEventListener('click', onClick, true);
