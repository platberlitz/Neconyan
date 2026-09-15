const catMotionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
let catPausedByUser = null;
const CAT_MOVING_SRC = 'img/neconyan-pixel-cat.webp?v=20260913g';
const CAT_RESTING_SRC = 'img/neconyan-pixel-cat-rest.webp?v=20260913g';
const CAT_CONTROL_SELECTOR = '.neconyan-home-actions > button, .neconyan-assistant-open, .neconyan-rail-new, [data-neconyan-cat-control], #rm_button_create, #character_import_button, #create_button_label, #rm_button_back, #world_create_button, #world_import_button, #world_popup_new';
const catPressTimers = new WeakMap();

function pulseCatPress(element) {
    clearTimeout(catPressTimers.get(element));
    element.classList.add('neconyan-cat-pressed');
    catPressTimers.set(element, setTimeout(() => {
        element.classList.remove('neconyan-cat-pressed');
        catPressTimers.delete(element);
    }, 260));
}

// Touch does not consistently activate non-button panels or their decorative ears.
document.addEventListener('pointerdown', event => {
    if (!['touch', 'pen'].includes(event.pointerType) || catMotionPreference.matches || document.body?.classList.contains('reduced-motion')) return;
    const panel = event.target instanceof Element ? event.target.closest('.neconyan-cat-panel, .neconyan-assistant-row, #right-nav-panel .sb-character-editor-identity') : null;
    if (panel) pulseCatPress(panel);
}, { capture: true, passive: true });

// Legacy character controls update every span when their action label changes.
export const NECONYAN_WHISKERS = `<i class="neconyan-whiskers" aria-hidden="true">
    <i class="neconyan-whisker-left" aria-hidden="true"></i>
    <i class="neconyan-whisker-right" aria-hidden="true"></i>
    <img class="neconyan-cat-head" src="img/neconyan/cat-head.webp" width="0" height="0" alt="">
    <img class="neconyan-cat-tail" src="img/neconyan/cat-tail.webp" width="0" height="0" alt="">
</i>`;

function decorateWideControl(control) {
    if (!control?.querySelector) return;
    if (typeof control.textContent === 'string' && !control.textContent.trim()) return;
    if (!control.querySelector('.neconyan-whiskers')) {
        control.insertAdjacentHTML?.('beforeend', NECONYAN_WHISKERS);
    }
    control.classList?.add?.('neconyan-cat-control');
    if (typeof control.addEventListener !== 'function' || control.dataset?.neconyanPressBound === 'true') return;
    control.dataset.neconyanPressBound = 'true';
    control.addEventListener('click', () => pulseCatPress(control));
}

export function decorateNeconyanControls(root = document) {
    if (!root?.querySelectorAll) return;
    for (const control of root.querySelectorAll(CAT_CONTROL_SELECTOR)) decorateWideControl(control);
}

function applyCatMotion(button, cat, paused) {
    const reduced = catMotionPreference.matches || Boolean(document.body?.classList.contains('reduced-motion'));
    const still = paused || reduced;
    button.dataset.paused = String(still);
    button.hidden = reduced;
    cat.src = still ? CAT_RESTING_SRC : CAT_MOVING_SRC;
    cat.alt = still ? 'A resting calico cat' : 'A calico cat blinking, flicking its tail, and tumbling';
    button.textContent = still ? 'Play cat animation' : 'Pause cat animation';
}

export function initializeNeconyanHome(root) {
    decorateNeconyanControls(root);
    if (root !== document) decorateNeconyanControls(document);
    const button = root.querySelector('[data-neconyan-cat-toggle]');
    const cat = root.querySelector('[data-neconyan-cat]');
    if (!(button instanceof HTMLButtonElement) || !(cat instanceof HTMLImageElement)) return;
    applyCatMotion(button, cat, catPausedByUser ?? false);
}

function refreshCatMotion() {
    document.querySelectorAll('.neconyan-home').forEach(initializeNeconyanHome);
}

// The app's media listener must update its body class before Home reads it.
catMotionPreference.addEventListener('change', () => window.requestAnimationFrame(refreshCatMotion));
document.addEventListener('input', event => {
    if (event.target?.id !== 'reduced_motion') return;
    catPausedByUser = null;
    refreshCatMotion();
});

document.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('[data-neconyan-cat-toggle]') : null;
    if (!(button instanceof HTMLButtonElement) || catMotionPreference.matches || document.body?.classList.contains('reduced-motion')) return;
    const cat = button.closest('.neconyan-home-cat')?.querySelector('[data-neconyan-cat]');
    if (!(cat instanceof HTMLImageElement)) return;
    catPausedByUser = button.dataset.paused !== 'true';
    applyCatMotion(button, cat, catPausedByUser);
});
