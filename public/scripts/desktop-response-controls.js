import { hasChangedAttributeValue } from './util/attribute-mutations.js';

// Keep the original controls and event handlers; restore their exact locations on narrow screens.
const controlSelector = ':scope > :is(.swipe_left, .deep-swipe-left-outer, .swipeRightBlock, .assistant-swipe-arrow)';
const managed = new Map();
let desktop, tablet;
let observer;
let pending = false;

export function normaliseDesktopResponseControls(value) {
    return value === 'below' ? 'below' : 'inside';
}

/** The wrapper's gate: every style from 1001px, and only Tide rows from 769 to 1000px. */
export function managesResponseControls(wide, tablet, row) {
    return wide || tablet && !!row.matches('.nn-tide-layout');
}

function restore(message, state) {
    for (const [control, marker] of state.controls) {
        // A detached reply (a Roleplay replacement preview) is put back later, so check the message, not the page.
        if (message.contains(marker) && state.footer.contains(control)) marker.replaceWith(control);
        else marker.remove();
    }
    state.footer.remove();
    state.spacer?.remove();
    message.classList.remove('nn-response-controls-below', 'nn-ripple-response-controls-inside');
    managed.delete(message);
}

function refresh() {
    pending = false;
    const chat = document.getElementById('chat');
    const wide = desktop.matches, tabletNow = tablet.matches;
    const enabled = (wide || tabletNow) && !document.body.matches('.sbterm, .sbstory');
    const messages = enabled && chat ? [...chat.querySelectorAll('.mes:not(.smallSysMes, [is_system="true"])')]
        .filter(message => managesResponseControls(wide, tabletNow, message) && (message.matches('.last_mes, :has(.deep-swipe-right)') || document.body.classList.contains('swipeAllMessages'))) : [];
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
        // At tablet width Tide is always 'inside': the desktop placement only applies from 1001px.
        const below = wide && document.body.dataset.desktopResponseControls === 'below';
        const rippleInside = !below && document.body.matches('.neconyan.ripplestyle[data-neconyan-chat-mode="roleplay"]:not(.sbterm, .sbstory)');
        if (rippleInside) {
            if (!state.spacer) {
                state.spacer = document.createElement('div');
                state.spacer.className = 'nn-response-controls-spacer';
                state.spacer.setAttribute('aria-hidden', 'true');
                state.spacer.inert = true;
            }
            for (const spacer of block.querySelectorAll(':scope > .nn-response-controls-spacer')) {
                if (spacer !== state.spacer) spacer.remove();
            }
            if (state.spacer.parentNode !== block || state.spacer !== block.lastElementChild) block.append(state.spacer);
        } else state.spacer?.remove();
        if (message.classList.contains('nn-ripple-response-controls-inside') !== rippleInside) {
            message.classList.toggle('nn-ripple-response-controls-inside', rippleInside);
        }
        const parent = below || rippleInside ? message : block;
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
        tablet = window.matchMedia('(min-width: 769px) and (max-width: 1000px)');
        desktop.addEventListener('change', queueRefresh);
        tablet.addEventListener('change', queueRefresh);
        observer = new MutationObserver(records => {
            const relevant = records.filter(record => record.type === 'attributes'
                ? record.target === document.body || record.target.matches?.('#chat .mes')
                : record.target.matches?.('#chat, #chat .mes, #chat .mes_block, #chat .nn-response-controls'));
            if (hasChangedAttributeValue(relevant)) queueRefresh();
        });
        observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-neconyan-chat-mode'], attributeOldValue: true, childList: true, subtree: true });
    }
    queueRefresh();
}
