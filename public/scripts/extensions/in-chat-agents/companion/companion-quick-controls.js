import { escapeHtml } from '../../../utils.js';
import { getAgents, getCompanionConfig, isCompanionAgent } from '../agent-store.js';
import { getCompanionReferenceIds } from './companion-shared.js';

/** Link lists a companion card can change in place, in the order they are shown. */
export const COMPANION_QUICK_LINKS = Object.freeze([
    { field: 'dependencies', title: 'Runs after', help: 'Reads their latest notes first and runs again when they change.', flag: '' },
    { field: 'contextRecipientAgentIds', title: 'Sends notes to', help: 'They get this companion’s latest note as extra context.', flag: 'sendContextToCompanions' },
    { field: 'batchAgentIds', title: 'Shares one request with', help: 'Runs with them in one request when their connections and models match.', flag: 'batch' },
]);

const openLinkPanels = new Set();

export function isCompanionLinksOpen(scope, agentId) {
    return openLinkPanels.has(`${scope}:${agentId}`);
}

export function setCompanionLinksOpen(scope, agentId, open) {
    const key = `${scope}:${agentId}`;
    if (open) openLinkPanels.add(key);
    else openLinkPanels.delete(key);
}

function getOtherCompanions(agent) {
    return getAgents().filter(candidate => candidate.id !== agent.id && isCompanionAgent(candidate))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function isLinked(config, field, candidate) {
    const ids = new Set(config[field] ?? []);
    return getCompanionReferenceIds(candidate).some(id => ids.has(id));
}

/** Plain summary of a companion's links, such as 'Runs after Plot Compass · Sends notes to 2'. */
export function describeCompanionLinks(agent, companions = getOtherCompanions(agent)) {
    const config = getCompanionConfig(agent);
    const parts = COMPANION_QUICK_LINKS.map(({ field, title }) => {
        const linked = companions.filter(candidate => isLinked(config, field, candidate));
        if (!linked.length) return '';
        return `${title} ${linked.length === 1 ? linked[0].name : linked.length}`;
    }).filter(Boolean);
    if (parts.length) return parts.join(' · ');
    return companions.length ? 'Not connected' : 'No other companions yet';
}

/**
 * Returns a changed copy of a companion for one quick control.
 * @param {object} agent
 * @param {{ kind: 'keep', checked: boolean } | { kind: 'depth', value: string } | { kind: 'link', field: string, candidate: object, checked: boolean }} change
 */
export function applyCompanionQuickChange(agent, change) {
    const draft = structuredClone(agent);
    const config = { ...getCompanionConfig(draft) };
    if (change.kind === 'keep') {
        config.includeInChatHistory = Boolean(change.checked);
    } else if (change.kind === 'depth') {
        const value = String(change.value ?? '').trim();
        const count = Number(value);
        if (!value) {
            config.includeAllChatHistory = true;
        } else if (Number.isInteger(count) && count >= 1) {
            config.includeAllChatHistory = false;
            config.chatHistoryDepth = count;
        } else {
            return null;
        }
        config.includeInChatHistory = true;
    } else if (change.kind === 'link') {
        const link = COMPANION_QUICK_LINKS.find(item => item.field === change.field);
        if (!link || !change.candidate) return null;
        const references = new Set(getCompanionReferenceIds(change.candidate));
        const ids = (config[link.field] ?? []).filter(id => !references.has(id));
        if (change.checked) ids.push(change.candidate.id);
        config[link.field] = [...new Set(ids)];
        if (link.flag) config[link.flag] = config[link.field].length > 0;
    } else {
        return null;
    }
    draft.companion = config;
    return draft;
}

/**
 * Keep-in-history switch, notes count and inline connections for one companion.
 * Callers bind the controls with {@link readCompanionQuickChange}.
 */
export function buildCompanionQuickControlsHtml(agent, { scope = 'card' } = {}) {
    if (!agent || !isCompanionAgent(agent)) return '';
    const config = getCompanionConfig(agent);
    const companions = getOtherCompanions(agent);
    const id = escapeHtml(agent.id);
    const name = escapeHtml(agent.name);
    const depth = config.includeAllChatHistory ? '' : String(config.chatHistoryDepth);
    const groups = companions.length
        ? COMPANION_QUICK_LINKS.map(({ field, title, help }) => `
            <fieldset class="ica--companion-quick-group">
                <legend>${title}</legend>
                <p class="ica--companion-quick-help">${help}</p>
                <div class="ica--companion-quick-options">
                    ${companions.map(candidate => `<label class="checkbox_label"><input type="checkbox" data-quick-link="${field}" data-candidate-id="${escapeHtml(candidate.id)}"${isLinked(config, field, candidate) ? ' checked' : ''}><span>${escapeHtml(candidate.name)}</span></label>`).join('')}
                </div>
            </fieldset>`).join('')
        : '<p class="ica--companion-quick-help">Make another agent a companion to connect them.</p>';
    return `
        <div class="ica--companion-quick" data-companion-quick="${id}">
            <div class="ica--companion-quick-history">
                <label class="checkbox_label" title="Saved notes become context for future replies">
                    <input type="checkbox" data-quick-keep${config.includeInChatHistory ? ' checked' : ''}>
                    <span>Keep in chat history</span>
                </label>
                <label class="ica--companion-quick-depth" title="How many recent notes stay in chat history. Leave blank to keep all of them.">
                    <input type="number" class="text_pole" min="1" step="1" inputmode="numeric" placeholder="All" value="${depth}" data-quick-depth aria-label="Notes to keep in chat history for ${name} (blank keeps all)">
                    <span>notes</span>
                </label>
            </div>
            <details class="ica--companion-quick-links"${isCompanionLinksOpen(scope, agent.id) ? ' open' : ''}>
                <summary><i class="fa-solid fa-link" aria-hidden="true"></i><span>Connections</span><small>${escapeHtml(describeCompanionLinks(agent, companions))}</small></summary>
                <div class="ica--companion-quick-groups">${groups}</div>
                ${companions.length ? '<button type="button" class="menu_button ica--companion-quick-more" data-quick-more>More connection options</button>' : ''}
            </details>
        </div>`;
}

/** Turns an input event inside the quick controls into a change for {@link applyCompanionQuickChange}. */
export function readCompanionQuickChange(target) {
    if (!(target instanceof HTMLInputElement)) return null;
    if (target.matches('[data-quick-keep]')) return { kind: 'keep', checked: target.checked };
    if (target.matches('[data-quick-depth]')) {
        if (!target.checkValidity()) {
            target.reportValidity();
            return null;
        }
        return { kind: 'depth', value: target.value };
    }
    if (target.matches('[data-quick-link]')) {
        const candidate = getAgents().find(agent => agent.id === target.dataset.candidateId);
        return candidate ? { kind: 'link', field: target.dataset.quickLink, candidate, checked: target.checked } : null;
    }
    return null;
}

/** CSS selector that finds the same control again after the list re-renders. */
export function getCompanionQuickControlSelector(target) {
    if (target.matches('[data-quick-keep]')) return '[data-quick-keep]';
    if (target.matches('[data-quick-depth]')) return '[data-quick-depth]';
    if (target.matches('[data-quick-link]')) return `[data-quick-link="${target.dataset.quickLink}"][data-candidate-id="${CSS.escape(target.dataset.candidateId)}"]`;
    return '';
}

/**
 * Saves quick-control changes as soon as they are made and keeps focus on the same control after
 * the caller re-renders. `save(agentId, draft)` writes the draft; `openMore(agentId)` opens the
 * full connection options.
 */
export function bindCompanionQuickControls(root, { scope, save, openMore, getRoot = () => root }) {
    if (typeof root?.addEventListener !== 'function' || root.dataset.companionQuickBound === scope) return;
    root.dataset.companionQuickBound = scope;
    root.addEventListener('toggle', event => {
        const details = event.target;
        if (!(details instanceof HTMLDetailsElement) || !details.matches('.ica--companion-quick-links')) return;
        const agentId = details.closest('[data-companion-quick]')?.getAttribute('data-companion-quick');
        if (agentId) setCompanionLinksOpen(scope, agentId, details.open);
    }, true);
    root.addEventListener('click', async event => {
        const button = event.target instanceof Element ? event.target.closest('[data-quick-more]') : null;
        const agentId = button?.closest('[data-companion-quick]')?.getAttribute('data-companion-quick');
        if (!agentId) return;
        await openMore?.(agentId);
    });
    root.addEventListener('change', async event => {
        const target = event.target;
        const container = target instanceof Element ? target.closest('[data-companion-quick]') : null;
        if (!container) return;
        event.stopPropagation();
        const agentId = container.getAttribute('data-companion-quick');
        const agent = getAgents().find(item => item.id === agentId);
        const change = readCompanionQuickChange(target);
        const draft = agent && change ? applyCompanionQuickChange(agent, change) : null;
        if (!draft) {
            if (change?.kind === 'depth') target.reportValidity?.();
            return;
        }
        const selector = getCompanionQuickControlSelector(target);
        container.querySelectorAll('input').forEach(input => { input.disabled = true; });
        try {
            await save(agentId, draft);
        } catch (error) {
            toastr.error(escapeHtml(error?.message || String(error)), 'Could not save the companion');
        } finally {
            container.querySelectorAll('input').forEach(input => { input.disabled = false; });
            const rendered = [...getRoot().querySelectorAll('[data-companion-quick]')]
                .find(element => element.getAttribute('data-companion-quick') === agentId);
            const control = selector ? rendered?.querySelector(selector) : null;
            if (control instanceof HTMLElement) control.focus({ preventScroll: true });
        }
    });
}
