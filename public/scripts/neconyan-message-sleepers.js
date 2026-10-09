import { measureEchoMessage, clearEchoMessage, refreshEchoHeader } from './echo-message-layout.js';
// One handler covers existing messages and later history, Conversation and Meower rows.
import { dressAllSleepers, dressSleeper, getSleeperCoat, SLEEPER_COAT_CHANGE_EVENT, SLEEPER_COAT_STORAGE_KEYS } from './neconyan-sleeper-coats.js';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const frames = new Map();
const active = new Map();

// At 96x77 the paws meet the bubble 41px below the image's top. Its tail hangs
// 17px past the side. Measure the bubble rather than guessing from the avatar size.
function sleeperPlacement(message, bubble, isUser) {
    return {
        top: bubble.top - message.top - 41,
        left: isUser ? bubble.right - message.left - 79 : bubble.left - message.left - 17,
    };
}

const pending = new Set();
let placementFrame = 0;
const observedBubbles = new Set();
const bubbleSizes = new ResizeObserver(entries => {
    for (const { target } of entries) queuePlacement(target.closest('.mes'));
});

function queuePlacement(message) {
    if (!message) return;
    pending.add(message);
    if (placementFrame) return;
    placementFrame = requestAnimationFrame(() => {
        placementFrame = 0;
        const measured = [...pending].filter(message => message.isConnected).map(message => {
            const bubble = message.querySelector(':scope > .mes_block');
            if (!bubble) return null;
            const placement = document.body.matches('.flatchat.nnchat:not(.sbterm):not(.sbstory)')
                ? sleeperPlacement(message.getBoundingClientRect(), bubble.getBoundingClientRect(), message.getAttribute('is_user') === 'true') : null;
            return { message, placement };
        });
        pending.clear();
        for (const item of measured) {
            if (!item) continue;
            measureEchoMessage(item.message);
            for (const axis of ['top', 'left']) {
                const key = '--nnchat-sleeper-' + axis;
                if (item.placement) item.message.style.setProperty(key, item.placement[axis] + 'px');
                else item.message.style.removeProperty(key);
            }
        }
    });
}

function watchBubbles() {
    for (const bubble of observedBubbles) {
        if (bubble.isConnected) continue;
        clearEchoMessage(bubble.closest('.mes'));
        bubbleSizes.unobserve(bubble);
        observedBubbles.delete(bubble);
    }
    for (const bubble of document.querySelectorAll('#chat > .mes > :is(.mes_block, .mesAvatarWrapper), #chat > .mes > .mes_block > .nn-response-controls')) {
        if (observedBubbles.has(bubble)) continue;
        observedBubbles.add(bubble);
        bubbleSizes.observe(bubble);
        queuePlacement(bubble.closest('.mes'));
    }
}

function initBubblePlacement() {
    const chat = document.getElementById('chat');
    if (!chat) return;
    watchBubbles();
    new MutationObserver(records => {
        // Streaming text is handled by the size observer; only scan for new or removed bubbles.
        if (records.some(record => record.target === chat || [...record.addedNodes, ...record.removedNodes]
            .some(node => node instanceof HTMLElement && (node.matches('.mes, .mes_block, .nn-response-controls') || node.querySelector('.mes_block'))))) watchBubbles();
    }).observe(chat, { childList: true, subtree: true });
    const refresh = new MutationObserver(() => {
        for (const bubble of observedBubbles) queuePlacement(bubble.closest('.mes'));
    });
    for (const element of [document.body, document.documentElement, document.getElementById('sheld')]) {
        if (element) refresh.observe(element, { attributes: true, attributeFilter: ['class', 'style', 'data-neconyan-chat-mode', 'data-sbtw-mode', 'data-sb-conversation-mode'] });
    }
    window.addEventListener('resize', () => { for (const bubble of observedBubbles) queuePlacement(bubble.closest('.mes')); });
    const stateObserver = new MutationObserver(records => {
        for (const record of records) queuePlacement(record.target.closest('.mes'));
    });
    stateObserver.observe(chat, { subtree: true, attributes: true, attributeFilter: ['open', 'aria-expanded', 'is_system'] });
    for (const event of ['focusin', 'focusout', 'click']) chat.addEventListener(event, e => {
        const row = e.target.closest('.mes');
        if (row) requestAnimationFrame(() => refreshEchoHeader(row));
    });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initBubblePlacement, { once: true });
else initBubblePlacement();

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
    rest(img);
    const src = dressSleeper(img, isUser);
    if (!frames.has(src)) {
        const frame = new Image();
        frame.src = src.replace('.webp', '-twitch.webp');
        frames.set(src, frame.decode().then(() => frame.src).catch(() => {
            frames.delete(src);
            return null;
        }));
    }
    const frame = await frames.get(src);
    if (!frame || !img.isConnected || img.hidden || reducedMotion.matches || img.getAttribute('src') !== src) return;
    rest(img);
    img.src = frame;
    active.set(img, { src, frame, timer: setTimeout(() => rest(img), 240) });
}

document.addEventListener('click', pet, true);
document.addEventListener('keydown', pet, true);
reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) for (const img of active.keys()) rest(img);
});
window.addEventListener('storage', event => {
    if (!Object.values(SLEEPER_COAT_STORAGE_KEYS).includes(event.key)) return;
    dressAllSleepers();
    const role = event.key === SLEEPER_COAT_STORAGE_KEYS.user ? 'user' : 'character';
    document.dispatchEvent(new CustomEvent(SLEEPER_COAT_CHANGE_EVENT, { detail: { role, coat: getSleeperCoat(role) } }));
});
