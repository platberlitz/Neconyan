/**
 * Markup shared by the Companion panel, note cards and floating windows.
 *
 * This module has zero imports so the card and panel renderers can place a
 * host without pulling the widget runtime (or the app's script singletons)
 * into their own imports and tests. The runtime moves one live widget between
 * these hosts.
 */

export const DICE_COMPANION_HOST_ATTRIBUTE = 'data-neco-dice-host';
export const DICE_COMPANION_HOST_SELECTOR = `[${DICE_COMPANION_HOST_ATTRIBUTE}]`;
export const DICE_COMPANION_HOSTS_CHANGED_EVENT = 'neconyan:dice-hosts-changed';
export const DICE_COMPANION_COMPOSER_REQUEST_EVENT = 'neconyan:dice-composer-request';

export function notifyDiceCompanionHostsChanged() {
    const document = globalThis.document;
    if (typeof document?.dispatchEvent !== 'function' || typeof Event !== 'function') {
        return;
    }
    document.dispatchEvent(new Event(DICE_COMPANION_HOSTS_CHANGED_EVENT));
}

/**
 * Lifts the one live widget out before a renderer replaces its host. The widget
 * keeps its DOM, event listeners, input value and focus across the render.
 * @param {Element} root
 * @returns {{ widget: Element, agentId: string, focused: Element|null, selection: number[]|null }|null}
 */
export function captureDiceCompanionWidget(root) {
    const host = root?.querySelector?.(DICE_COMPANION_HOST_SELECTOR);
    const widget = host?.querySelector?.('.neco-dice');
    if (!host || !widget) {
        return null;
    }
    const active = globalThis.document?.activeElement;
    const focused = active && widget.contains?.(active) ? active : null;
    const selection = focused && Number.isInteger(focused.selectionStart) && Number.isInteger(focused.selectionEnd)
        ? [focused.selectionStart, focused.selectionEnd]
        : null;
    widget.remove();
    return { widget, agentId: host.dataset?.necoDiceAgent ?? '', focused, selection };
}

/**
 * Puts the captured widget back into the matching new host before the browser
 * paints, so typing and the phone keyboard stay put.
 * @param {Element} root
 * @param {{ widget: Element, agentId: string, focused: Element|null, selection: number[]|null }|null} captured
 * @returns {boolean}
 */
export function restoreDiceCompanionWidget(root, captured) {
    if (!captured?.widget || typeof root?.querySelectorAll !== 'function') {
        return false;
    }
    const hosts = [...root.querySelectorAll(DICE_COMPANION_HOST_SELECTOR)];
    const host = hosts.find(candidate => (candidate.dataset?.necoDiceAgent ?? '') === captured.agentId)
        ?? (hosts.length === 1 ? hosts[0] : null);
    if (!host) {
        return false;
    }
    host.append(captured.widget);
    if (captured.focused?.isConnected) {
        captured.focused.focus?.({ preventScroll: true });
        if (captured.selection && typeof captured.focused.setSelectionRange === 'function') {
            captured.focused.setSelectionRange(...captured.selection);
        }
    }
    return true;
}

/** Where a local roll can be finished when no widget is on screen. */
export function getDiceRunHint(displayMode = 'panel') {
    if (displayMode === 'card') {
        return 'Open the latest reply to add it to your message or send it.';
    }
    if (displayMode === 'hidden') {
        return 'Choose Panel or Notes under replies in the Dice Roller editor to use the result.';
    }
    return 'Open the Companion panel to add it to your message or send it.';
}

function escapeAttribute(value = '') {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#039;');
}

/**
 * @param {{ agentId: string, surface: 'panel'|'card'|'window', messageIndex?: number, hint?: string }} options
 * @returns {string}
 */
export function buildDiceCompanionHostHtml({ agentId, surface = 'panel', messageIndex = -1, hint = '' } = {}) {
    if (!agentId) {
        return '';
    }

    return `<div class="neco-dice-host" ${DICE_COMPANION_HOST_ATTRIBUTE}="true" data-neco-dice-agent="${escapeAttribute(agentId)}" data-neco-dice-surface="${escapeAttribute(surface)}" data-neco-dice-message-index="${Number.isInteger(messageIndex) ? messageIndex : -1}">${hint ? `<p class="neco-dice-host-hint">${escapeAttribute(hint)}</p>` : ''}</div>`;
}

/**
 * The synthetic card shown under the newest message when the user chooses
 * Notes under replies. Nothing is stored on the message.
 * @param {object} agent
 * @param {{ messageIndex?: number }} [options]
 * @returns {string}
 */
export function buildDiceCompanionCardHtml(agent, { messageIndex = -1 } = {}) {
    if (!agent?.id) {
        return '';
    }

    const icon = String(agent.icon ?? '').trim() || 'fa-dice-d20';
    return `
        <details class="ica--companion-card ica--companion-card--dice" data-agent-id="${escapeAttribute(agent.id)}" open>
            <summary class="ica--companion-summary">
                <span class="ica--companion-title">
                    <i class="fa-solid ${escapeAttribute(icon)}"></i>
                    <span>${escapeAttribute(agent.name || 'Dice Roller')}</span>
                </span>
                <span class="ica--companion-summary-spacer"></span>
                <span class="ica--companion-status">Ready</span>
            </summary>
            <div class="ica--companion-body">
                ${buildDiceCompanionHostHtml({ agentId: agent.id, surface: 'card', messageIndex, hint: 'Roll here, then add the result to your message or send it to the story.' })}
            </div>
        </details>
    `;
}
