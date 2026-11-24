/**
 * The 'Share with the assistant' card shown under a Scratchpad reply that asks
 * for more context. Every string goes in through text nodes; the card only
 * calls back into Scratchpad, which saves the switches and sends the reply.
 */
import { t } from '../i18n.js';
import { h } from '../notebooks/dom.js';
import { planShareRequest, SHARE_ITEM_KEYS } from './share-request.js';

function shareLabel(key) {
    switch (key) {
        case 'card': return t`Character cards`;
        case 'persona': return t`Your persona and Scenario Notes`;
        case 'authorsNote': return t`Author's Note`;
        case 'mewmory': return t`Mewmory`;
        case 'lore': return t`Lorebook entries`;
        case 'preset': return t`Current preset`;
        case 'problems': return t`Problem checks`;
        case 'appEvidence': return t`App diagnostics`;
        case 'appSource': return t`Neconyan source code`;
        case 'lastPrompt': return t`Last prompt sent`;
        case 'agents': return t`Agents`;
        case 'regex': return t`Regexes`;
        case 'cssSnippets': return t`CSS Snippets`;
        case 'dialogueColors': return t`Dialogue Colors`;
        case 'hidden': return t`Include hidden messages`;
        default: return t`Recent messages to read`;
    }
}

/** The translated names of what was just shared, in Context tab order, for a toast. */
export function shareItemLabels(keys = [], depth = null) {
    const labels = SHARE_ITEM_KEYS.filter(key => keys.includes(key)).map(shareLabel);
    if (depth !== null) labels.push(`${shareLabel('depth')} (${depth})`);
    return labels.join(', ');
}

function shareHint(key, source) {
    switch (key) {
        case 'mewmory': return t`Reads saved memories from this Roleplay chat on the server. Pinned memories come first, followed by recent ones; unavailable or excluded memories are left out.`;
        case 'lore': return t`Entries are shared when their keywords appear, or when you set them to Always below.`;
        case 'preset': return source?.kind === 'general'
            ? t`Shares the equipped preset for reference only. This doesn't change your preset or the assistant's instructions.`
            : t`Shared as its own section, apart from the cards, persona and lorebooks. Every module is listed in order and marked on or off.`;
        case 'problems': return t`Checks shared cards, presets and lorebooks for likely problems, and shares fuller activation and sampler details.`;
        case 'appEvidence': return t`Shares Neconyan's recent errors, failed model requests and your failed requests and jobs, so the assistant can explain what went wrong. Admins also share server crash reports and error log lines.`;
        case 'appSource': return t`Before replying, the server looks up the parts of Neconyan's own code (public/scripts, public/script.js and src) that match your question and the app diagnostics, read-only. Your config, secrets and data folder are never read, and the assistant can't change Neconyan's code.`;
        case 'lastPrompt': return t`Shares the exact prompt last sent to the model for this chat, with keys, passwords and hidden lorebook entries removed.`;
        case 'agents': return t`Shares the name, description and prompt of every saved Agent, so an assistant can suggest edits to them.`;
        case 'regex': return t`Shares the name, Find pattern and replacement of every global regex script, so an assistant can suggest edits to them.`;
        case 'cssSnippets': return t`Shares the name and CSS of every saved snippet, so an assistant can suggest edits to them.`;
        case 'dialogueColors': return t`Shares the name and colour of every character in the colour table in use, so an assistant can suggest new colours.`;
        case 'hidden': return t`Shares messages that are hidden from the story model in this chat.`;
        default: return '';
    }
}

function title() {
    return h('div', { class: 'scratchpad-share-title' },
        h('i', { class: 'fa-solid fa-share', 'aria-hidden': 'true' }),
        h('span', { text: t`Share with the assistant` }));
}

function button(label, icon, className, onClick, { disabled = false, primary = false } = {}) {
    return h('button', { type: 'button', class: `menu_button scratchpad-button ${className}${primary ? ' menu_button_primary' : ''}`, disabled, onclick: onClick },
        h('i', { class: `fa-solid ${icon}`, 'aria-hidden': 'true' }),
        h('span', { text: label }));
}

function sharedRow(label) {
    return h('div', { class: 'scratchpad-share-item is-shared' },
        h('span', { class: 'scratchpad-share-name', text: label }),
        h('span', { class: 'scratchpad-share-badge', text: t`Already shared` }));
}

function checkRow(key, label, hint, checked) {
    return h('label', { class: 'scratchpad-check scratchpad-share-item' }, h('input', { type: 'checkbox', checked, 'data-share-item': key }),
        h('span', { class: 'scratchpad-share-name', text: label }),
        hint ? h('small', { text: hint }) : null);
}

/**
 * Renders one share request. `options` carries the live source and settings,
 * whether Scratchpad is busy, the keys the user unticked (a Set the card keeps
 * up to date), whether the card was dismissed, and the callbacks that save and
 * send.
 */
export function renderShareRequestCard(part, { source, settings, busy = false, dismissed = false, unticked = new Set(), onToggle = () => {}, onShare = () => {}, onTurnOn = () => {}, onDismiss = () => {} } = {}) {
    if (!part?.request) {
        return h('div', { class: 'scratchpad-share-request is-invalid' }, title(),
            h('p', { class: 'scratchpad-muted', role: 'status', text: t`This share request could not be read, so nothing can be shared from it.` }),
            part?.raw ? h('pre', { class: 'scratchpad-share-raw', 'data-i18n-ignore': '' }, h('code', { text: part.raw.slice(0, 2000) })) : null);
    }
    const { request } = part;
    const reason = request.reason ? h('p', { class: 'scratchpad-share-reason', 'data-i18n-ignore': '', text: request.reason }) : null;
    if (dismissed) {
        return h('section', { class: 'scratchpad-share-request is-dismissed', 'aria-label': t`Share with the assistant` }, title(),
            h('p', { class: 'scratchpad-change-state', role: 'status', text: t`Dismissed` }));
    }
    const plan = planShareRequest(request, source, settings);
    const depthActionable = plan.depth?.state === 'actionable';
    const rows = [
        ...plan.actionable.map(key => checkRow(key, shareLabel(key), shareHint(key, source), !unticked.has(key))),
        depthActionable ? checkRow('depth', shareLabel('depth'), t`Reads the last ${plan.depth.requested} messages instead of ${plan.depth.current}.`, !unticked.has('depth')) : null,
        ...plan.shared.map(key => sharedRow(shareLabel(key))),
        plan.depth?.state === 'shared' ? sharedRow(shareLabel('depth')) : null,
    ].filter(Boolean);
    const unavailable = plan.unavailable.length + (plan.depth?.state === 'unavailable' ? 1 : 0) + (request.ignored || 0);
    const actionable = plan.actionable.length + (depthActionable ? 1 : 0);
    const notes = [
        plan.depth?.state === 'picked' ? h('p', { class: 'scratchpad-muted scratchpad-share-note', text: t`The assistant asked for more recent messages, but your picked messages are shared instead. Clear your picks on the Context tab to share recent messages.` }) : null,
        unavailable ? h('p', { class: 'scratchpad-muted scratchpad-share-note', text: rows.length || plan.depth?.state === 'picked'
            ? t`Some of what the assistant asked for is not available in this Scratchpad mode.`
            : t`What the assistant asked for is not available in this Scratchpad mode.` }) : null,
    ];
    const chosen = () => ({
        keys: plan.actionable.filter(key => !unticked.has(key)),
        depth: depthActionable && !unticked.has('depth') ? plan.depth.requested : null,
    });
    const nothingTicked = () => {
        const { keys, depth } = chosen();
        return !keys.length && depth === null;
    };
    const accept = button(t`Share & continue`, 'fa-paper-plane', 'scratchpad-share-accept', () => onShare(chosen()), { disabled: busy || nothingTicked(), primary: true });
    const only = button(t`Turn on only`, 'fa-toggle-on', 'scratchpad-share-only', () => onTurnOn(chosen()), { disabled: busy || nothingTicked() });
    const toggle = (key, checked) => {
        unticked[checked ? 'delete' : 'add'](key);
        onToggle(key, checked);
        accept.disabled = only.disabled = busy || nothingTicked();
    };
    for (const row of rows) row.querySelector('input[data-share-item]')?.addEventListener('change', event => toggle(event.currentTarget.dataset.shareItem, event.currentTarget.checked));
    const actions = actionable
        ? h('div', { class: 'scratchpad-share-actions' }, accept, only,
            button(t`Not now`, 'fa-xmark', 'scratchpad-share-dismiss', onDismiss, { disabled: busy }))
        : rows.length ? h('p', { class: 'scratchpad-change-state', role: 'status', text: t`Already shared` }) : null;
    return h('section', { class: 'scratchpad-share-request', 'aria-label': t`Share with the assistant` }, title(), reason,
        actionable ? h('p', { class: 'scratchpad-muted scratchpad-share-intro', text: t`Nothing is shared until you choose. You can turn these off again on the Context tab.` }) : null,
        rows.length ? h('div', { class: 'scratchpad-share-items' }, rows) : null,
        notes, actions);
}
