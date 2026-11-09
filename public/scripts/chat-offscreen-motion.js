// Pauses CSS animations inside chat messages that are scrolled out of view.
// Animated tracker blocks and regex themes loop forever, and a browser keeps
// recalculating every one of them on each frame even when none is on screen.
export const OFFSCREEN_ATTRIBUTE = 'data-nn-offscreen';
// Messages start moving again a little before they scroll into view.
const VIEW_MARGIN = '300px 0px';

export function createOffscreenMotionPauser({
    chat,
    IntersectionObserver: Intersections = globalThis.IntersectionObserver,
    MutationObserver: Mutations = globalThis.MutationObserver,
} = {}) {
    if (!chat || typeof Intersections !== 'function' || typeof Mutations !== 'function') return null;

    const visibility = new Intersections(entries => {
        for (const { target, isIntersecting } of entries) {
            if (isIntersecting === !target.hasAttribute(OFFSCREEN_ATTRIBUTE)) continue;
            target.toggleAttribute(OFFSCREEN_ATTRIBUTE, !isIntersecting);
        }
    }, { rootMargin: VIEW_MARGIN });

    const isMessage = node => node?.nodeType === 1 && node.classList.contains('mes');
    const watch = node => { if (isMessage(node)) visibility.observe(node); };
    const unwatch = node => { if (isMessage(node)) visibility.unobserve(node); };

    const rows = new Mutations(records => {
        for (const record of records) {
            record.removedNodes.forEach(unwatch);
            record.addedNodes.forEach(watch);
        }
    });
    rows.observe(chat, { childList: true });
    for (const message of chat.children) watch(message);

    return {
        destroy() {
            rows.disconnect();
            visibility.disconnect();
            for (const message of chat.querySelectorAll(`:scope > [${OFFSCREEN_ATTRIBUTE}]`)) message.removeAttribute(OFFSCREEN_ATTRIBUTE);
        },
    };
}

if (typeof document !== 'undefined') {
    const start = () => createOffscreenMotionPauser({ chat: document.getElementById('chat') });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
}
