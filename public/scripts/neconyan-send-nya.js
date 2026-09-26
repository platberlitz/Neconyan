import { isIOSWebKitPlatform } from './mobile-send-button.js';

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

export function popNya(x, y, { reduced = reducedMotion.matches, random = Math.random } = {}) {
    if (activePops >= MAX_ACTIVE_POPS) return null;
    const pop = document.createElement('span');
    // Safari touch/client coordinates follow the visible viewport, while a
    // body-level fixed element uses the layout viewport behind the keyboard.
    const viewport = isIOSWebKitPlatform(window.navigator) ? window.visualViewport : null;
    const position = () => {
        pop.style.left = `${x + (viewport?.offsetLeft || 0)}px`;
        pop.style.top = `${y + (viewport?.offsetTop || 0)}px`;
    };
    pop.className = 'neconyan-send-nya';
    pop.textContent = SOUNDS[Math.floor(random() * SOUNDS.length)];
    pop.setAttribute('aria-hidden', 'true');
    Object.assign(pop.style, {
        position: 'fixed',
        zIndex: '2147483000',
        pointerEvents: 'none',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        font: '400 20px/1 var(--sb-font-display, var(--mainFontFamily, sans-serif))',
        color: 'var(--neco-ginger, var(--sb-accent, var(--SmartThemeQuoteColor)))',
        textShadow: '0 0 2px var(--neco-surface, var(--SmartThemeBlurTintColor)), 0 1px 3px var(--neco-surface, var(--SmartThemeBlurTintColor))',
        transform: 'translate(-50%, -100%)',
        opacity: '0',
    });
    position();
    viewport?.addEventListener('scroll', position);
    viewport?.addEventListener('resize', position);
    document.body.append(pop);
    activePops += 1;

    const drift = Math.round((random() - 0.5) * 36);
    const tilt = Math.round((random() - 0.5) * 24);
    const frames = reduced
        ? [{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }]
        : [
            { opacity: 0, transform: 'translate(-50%, -60%) scale(0.6) rotate(0deg)' },
            { opacity: 1, transform: `translate(-50%, -110%) scale(1.15) rotate(${tilt / 2}deg)`, offset: 0.18 },
            { opacity: 1, transform: `translate(calc(-50% + ${drift / 2}px), -200%) scale(1) rotate(${tilt}deg)`, offset: 0.6 },
            { opacity: 0, transform: `translate(calc(-50% + ${drift}px), -320%) scale(0.95) rotate(${tilt}deg)` },
        ];
    let done = false;
    let cleanupTimer;
    const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(cleanupTimer);
        viewport?.removeEventListener('scroll', position);
        viewport?.removeEventListener('resize', position);
        activePops -= 1;
        pop.remove();
    };
    // Sending can occupy the main thread. Start both clocks at the next paint so
    // the fallback cannot remove the pop before its animation becomes visible.
    window.requestAnimationFrame(() => {
        position();
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
    if (target && button.contains(target)) popNya(event.clientX, event.clientY);
}

function onClick(event) {
    if (!event.isTrusted || event.detail !== 0) return;
    const button = event.target.closest?.(SEND_NYA_SELECTOR);
    if (!button) return;
    const rect = button.getBoundingClientRect();
    popNya(rect.left + rect.width / 2, rect.top + rect.height / 2);
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
        if (target && button.contains(target)) popNya(touch.clientX, touch.clientY);
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
