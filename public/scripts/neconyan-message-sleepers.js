// One handler covers existing messages and later history, Conversation and Meower rows.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const frames = new Map();
const active = new Map();

function rest(img) {
    const state = active.get(img);
    if (!state) return;
    clearTimeout(state.timer);
    if (img.src === state.frame) img.src = state.src;
    active.delete(img);
}

async function pet(event) {
    const img = event.target.closest?.('img.neconyan-message-sleeper');
    if (!img || img.hidden || (event.type === 'keydown' && !['Enter', ' '].includes(event.key))) return;
    event.preventDefault();
    event.stopPropagation();
    if (reducedMotion.matches || event.repeat) return;
    const isUser = img.classList.contains('is-user');
    const src = `/img/neconyan/sleeping-${isUser ? 'tiger-right' : 'calico-left'}.webp`;
    if (!frames.has(src)) {
        const frame = new Image();
        frame.src = src.replace('.webp', '-twitch.webp');
        frames.set(src, frame.decode().then(() => frame.src).catch(() => {
            frames.delete(src);
            return null;
        }));
    }
    const frame = await frames.get(src);
    if (!frame || !img.isConnected || img.hidden || reducedMotion.matches || img.classList.contains('is-user') !== isUser) return;
    rest(img);
    img.src = frame;
    active.set(img, { src, frame, timer: setTimeout(() => rest(img), 240) });
}

document.addEventListener('click', pet, true);
document.addEventListener('keydown', pet, true);
reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) for (const img of active.keys()) rest(img);
});
