import { hasChangedAttributeValue } from './util/attribute-mutations.js';

// Keep the original controls and event handlers; restore their exact locations on narrow screens.
const controlSelector = ':scope > :is(.swipe_left, .deep-swipe-left-outer, .swipeRightBlock, .assistant-swipe-arrow)';
const managed = new Map();
let desktop;
let observer;
let pending = false;

export function normaliseDesktopResponseControls(value) {
    return value === 'below' ? 'below' : 'inside';
}

function restore(message, state) {
    for (const [control, marker] of state.controls) {
        // A detached reply (a Roleplay replacement preview) is put back later, so check the message, not the page.
        if (message.contains(marker) && state.footer.contains(control)) marker.replaceWith(control);
        else marker.remove();
    }
    state.footer.remove();
    message.classList.remove('nn-response-controls-below');
    managed.delete(message);
}

function refresh() {
    pending = false;
    const chat = document.getElementById('chat');
    const enabled = desktop.matches && !document.body.matches('.sbterm, .sbstory');
    const messages = enabled && chat ? [...chat.querySelectorAll('.mes:not(.smallSysMes, [is_system="true"])')]
        .filter(message => message.matches('.last_mes, :has(.deep-swipe-right)') || document.body.classList.contains('swipeAllMessages')) : [];
    const wanted = new Set(messages);
    for (const [message, state] of managed) {
        if (!wanted.has(message) || !state.footer.isConnected) restore(message, state);
    }
    for (const message of messages) {
        const block = message.querySelector(':scope > .mes_block');
        if (!block) continue;
        let state = managed.get(message);
        const controls = [...message.querySelectorAll(controlSelector), ...(state?.footer.querySelectorAll(controlSelector) ?? [])]
            .filter(control => !state?.controls.has(control));
        if (!state && !controls.length) continue;
        if (!state) {
            const footer = document.createElement('div');
            footer.className = 'nn-response-controls';
            state = { footer, controls: new Map() };
            managed.set(message, state);
        }
        for (const control of controls) {
            const marker = document.createComment('response control');
            // Deep Swipe inserts an assistant arrow beside the native right block, which may already be in our footer.
            if (state.footer.contains(control)) {
                const nativeMarker = [...state.controls].find(([node]) => node.matches('.swipeRightBlock'))?.[1];
                if (nativeMarker?.parentNode) nativeMarker.before(marker);
                else block.after(marker);
            } else control.before(marker);
            state.controls.set(control, marker);
            state.footer.append(control);
        }
        // Extensions can replace their own controls while the message stays mounted.
        for (const [control, marker] of state.controls) {
            if (!state.footer.contains(control)) {
                marker.remove();
                state.controls.delete(control);
            }
        }
        const below = document.body.dataset.desktopResponseControls === 'below';
        const parent = below ? message : block;
        if (state.footer.parentNode !== parent || state.footer !== parent.lastElementChild) parent.append(state.footer);
        message.classList.toggle('nn-response-controls-below', below);
    }
}

function queueRefresh() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(refresh);
}

export function applyDesktopResponseControls(value) {
    const position = normaliseDesktopResponseControls(value);
    document.body.dataset.desktopResponseControls = position;
    const select = document.getElementById('desktop_response_controls');
    if (select) select.value = position;
    if (!desktop) {
        desktop = window.matchMedia('(min-width: 1001px)');
        desktop.addEventListener('change', queueRefresh);
        observer = new MutationObserver(records => {
            const relevant = records.filter(record => record.type === 'attributes'
                ? record.target === document.body || record.target.matches?.('#chat .mes')
                : record.target.matches?.('#chat, #chat .mes, #chat .mes_block, #chat .nn-response-controls'));
            if (hasChangedAttributeValue(relevant)) queueRefresh();
        });
        observer.observe(document.body, { attributes: true, attributeFilter: ['class'], attributeOldValue: true, childList: true, subtree: true });
    }
    queueRefresh();
}
