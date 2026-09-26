// A 'nya!' pops out of the paw Send button wherever it was pressed, then floats up and fades.
// Pointer events are used because the iOS fast-tap path cancels the click on the send button;
// keyboard presses arrive as trusted clicks with no pointer (detail 0).
export const SEND_NYA_SELECTOR = '#send_but, #sb_conversation_send';
const MAX_ACTIVE_POPS = 8;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const pressed = new Map();
let activePops = 0;

export function popNya(x, y, { reduced = reducedMotion.matches, random = Math.random } = {}) {
    if (activePops >= MAX_ACTIVE_POPS) return null;
    const pop = document.createElement('span');
    pop.className = 'neconyan-send-nya';
    pop.textContent = 'nya!';
    pop.setAttribute('aria-hidden', 'true');
    Object.assign(pop.style, {
        position: 'fixed',
        left: `${x}px`,
        top: `${y}px`,
        zIndex: '2147483000',
        pointerEvents: 'none',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        font: '400 20px/1 var(--sb-font-display, var(--mainFontFamily, sans-serif))',
        color: 'var(--neco-ginger, var(--sb-accent, var(--SmartThemeQuoteColor)))',
        textShadow: '0 0 2px var(--neco-surface, var(--SmartThemeBlurTintColor)), 0 1px 3px var(--neco-surface, var(--SmartThemeBlurTintColor))',
        transform: 'translate(-50%, -100%)',
    });
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
    const finish = () => {
        if (done) return;
        done = true;
        activePops -= 1;
        pop.remove();
    };
    if (typeof pop.animate === 'function') {
        const animation = pop.animate(frames, { duration: reduced ? 700 : 900, easing: 'ease-out', fill: 'forwards' });
        animation.addEventListener('finish', finish);
        animation.addEventListener('cancel', finish);
    }
    setTimeout(finish, 1200);
    return pop;
}

function onPointerDown(event) {
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

document.addEventListener('pointerdown', onPointerDown, true);
document.addEventListener('pointerup', onPointerUp, true);
document.addEventListener('pointercancel', event => pressed.delete(event.pointerId), true);
document.addEventListener('click', onClick, true);
