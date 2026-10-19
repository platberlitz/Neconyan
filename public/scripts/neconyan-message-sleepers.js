import { measureEchoMessage, clearEchoMessage, refreshEchoHeader, measureTideMessage, clearTideMessage } from './echo-message-layout.js';
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
// What the last pass wrote on each row, so the row observer can tell its own churn from a change.
const measuredStyles = new WeakMap();
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
            measureTideMessage(item.message);
            for (const axis of ['top', 'left']) {
                const key = '--nnchat-sleeper-' + axis;
                if (item.placement) item.message.style.setProperty(key, item.placement[axis] + 'px');
                else item.message.style.removeProperty(key);
            }
            measuredStyles.set(item.message, { style: item.message.getAttribute('style'), className: item.message.getAttribute('class') });
        }
    });
}

function watchBubbles() {
    for (const bubble of observedBubbles) {
        if (bubble.isConnected) continue;
        clearEchoMessage(bubble.closest('.mes'));
        clearTideMessage(bubble.closest('.mes'));
        bubbleSizes.unobserve(bubble);
        observedBubbles.delete(bubble);
    }
    for (const bubble of document.querySelectorAll('#chat > .mes > :is(.mes_block, .mesAvatarWrapper), #chat > .mes > .mes_block > :is(.mes_text, .nn-response-controls)')) {
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
            .some(node => node instanceof HTMLElement && (node.matches('.mes, .mes_block, .mes_text, .nn-response-controls') || node.querySelector('.mes_block'))))) watchBubbles();
    }).observe(chat, { childList: true, subtree: true });
    const refresh = new MutationObserver(() => {
        // The body class carries the chat style, so a style switch attaches or releases the Tide watch.
        syncTideHeaderWatch();
        for (const bubble of observedBubbles) queuePlacement(bubble.closest('.mes'));
    });
    for (const element of [document.body, document.documentElement, document.getElementById('sheld')]) {
        if (element) refresh.observe(element, { attributes: true, attributeFilter: ['class', 'style', 'data-neconyan-chat-mode', 'data-sbtw-mode', 'data-sb-conversation-mode'] });
    }
    window.addEventListener('resize', () => { for (const bubble of observedBubbles) queuePlacement(bubble.closest('.mes')); });
    // The Tide container is measured from the header's boxes, and a header can change width without
    // resizing an observed bubble: a row gains or loses .last_mes (the extra "delete and add swipe"
    // button appears or goes), a header button is shown or hidden, or the response controls move
    // between placements. Those changes queue the same pass for their row, coalesced with the frame's
    // other placements, and the values this pass wrote itself are skipped so it cannot feed itself.
    // This is a Tide-only watch: it is attached while Tide is the active style and disconnected on a
    // style switch, so every other style behaves exactly as it does without it.
    const tideActive = () => document.body.classList.contains('tidestyle');
    let tideHeaderObserver = null;
    const onTideHeaderTransition = event => {
        if (!tideActive()) return;
        const target = event.target;
        if (target.matches?.('.nn-tide-container, .nn-tide-header-plate, .nn-tide-header-plate *')) return;
        const row = target.matches?.('#chat > .mes') ? target : target.closest?.('#chat > .mes');
        if (!row) return;
        if (target !== row && !target.matches?.('.mes_buttons, .mes_buttons *, .nn-response-controls, .nn-response-controls *')) return;
        queuePlacement(row);
    };
    const syncTideHeaderWatch = () => {
        if (tideActive() && !tideHeaderObserver) {
            tideHeaderObserver = new MutationObserver(records => {
                if (!tideActive()) return;
                for (const record of records) {
                    const target = record.target;
                    const row = target.matches?.('#chat > .mes') ? target : target.closest?.('#chat > .mes');
                    if (!row) continue;
                    if (record.type === 'childList') {
                        // A re-rendered button or control is a header change too. Only the containers
                        // that hold them matter, and never the decoration this pass adds itself.
                        if (!target.matches?.('.mes_buttons, .nn-response-controls')) continue;
                        if (![...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && !node.matches('.nn-tide-header-plate, .nn-tide-container'))) continue;
                        queuePlacement(row);
                        continue;
                    }
                    const written = measuredStyles.get(row);
                    if (target === row && written) {
                        if (record.attributeName === 'style' && written.style === target.getAttribute('style')) continue;
                        if (record.attributeName === 'class' && written.className === target.getAttribute('class')) continue;
                    }
                    if (target !== row && !target.matches?.('.mes_buttons, .mes_buttons *, .nn-response-controls, .nn-response-controls *')) continue;
                    queuePlacement(row);
                }
            });
            tideHeaderObserver.observe(chat, { subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'], childList: true });
            // A header button or control that animates in or out settles after the frame that queued
            // it, so the end of that transition asks for one more pass.
            chat.addEventListener('transitionend', onTideHeaderTransition, true);
        } else if (!tideActive() && tideHeaderObserver) {
            tideHeaderObserver.disconnect();
            tideHeaderObserver = null;
            chat.removeEventListener('transitionend', onTideHeaderTransition, true);
        }
    };
    syncTideHeaderWatch();
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
