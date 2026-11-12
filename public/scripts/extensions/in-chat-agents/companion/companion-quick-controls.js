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
const activeCompanionLinkTab = new Map();
const companionLinkSearch = new Map();
const companionLinkSelectedOnly = new Set();

export function isCompanionLinksOpen(scope, agentId) {
    return openLinkPanels.has(`${scope}:${agentId}`);
}

export function setCompanionLinksOpen(scope, agentId, open) {
    const key = `${scope}:${agentId}`;
    if (open) {
        openLinkPanels.add(key);
    } else {
        openLinkPanels.delete(key);
        activeCompanionLinkTab.delete(key);
        companionLinkSearch.delete(key);
        companionLinkSelectedOnly.delete(key);
    }
}

export function getActiveCompanionLinkField(scope, agentId) {
    const field = activeCompanionLinkTab.get(`${scope}:${agentId}`);
    return COMPANION_QUICK_LINKS.some(item => item.field === field)
        ? field
        : COMPANION_QUICK_LINKS[0].field;
}

export function setActiveCompanionLinkField(scope, agentId, field) {
    if (!agentId || !COMPANION_QUICK_LINKS.some(item => item.field === field)) return;
    activeCompanionLinkTab.set(`${scope}:${agentId}`, field);
}

function getOtherCompanions(agent) {
    return getAgents().filter(candidate => candidate.id !== agent.id && isCompanionAgent(candidate))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function isLinked(ids, candidate) {
    return getCompanionReferenceIds(candidate).some(id => ids.has(id));
}

/** Plain summary of a companion's links, such as 'Runs after Plot Compass · Sends notes to 2'. */
export function describeCompanionLinks(agent, companions = getOtherCompanions(agent)) {
    const config = getCompanionConfig(agent);
    const parts = COMPANION_QUICK_LINKS.map(({ field, title }) => {
        const ids = new Set(config[field] ?? []);
        const linked = companions.filter(candidate => isLinked(ids, candidate));
        if (!linked.length) return '';
        return `${title} ${linked.length === 1 ? linked[0].name : linked.length}`;
    }).filter(Boolean);
    if (parts.length) return parts.join(' · ');
    return companions.length ? 'Not connected' : 'No other companions yet';
}

/**
 * Returns a changed copy of a companion for one quick control.
 * @param {object} agent
 * @param {{ kind: 'keep', checked: boolean } | { kind: 'depth', value: string } | { kind: 'insertDepth', value: string } | { kind: 'link', field: string, candidate: object, checked: boolean }} change
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
    } else if (change.kind === 'insertDepth') {
        const value = String(change.value ?? '').trim();
        const depth = Number(value);
        if (!value) {
            config.chatHistoryInsertDepth = null;
        } else if (Number.isInteger(depth) && depth >= 0 && depth <= 99) {
            config.chatHistoryInsertDepth = depth;
            config.chatHistoryPlacement = 'block';
            config.includeInChatHistory = true;
        } else {
            return null;
        }
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
 * Checkbox groups inside the Connections panel. Every companion lists every other companion three
 * times, so a closed panel leaves them out and {@link bindCompanionQuickControls} fills them in when
 * it opens.
 */
export function buildCompanionQuickGroupsHtml(agent, companions = getOtherCompanions(agent), { scope = 'card' } = {}) {
    if (!companions.length) return '<p class="ica--companion-quick-help">Make another agent a companion to connect them.</p>';
    const config = getCompanionConfig(agent);
    const key = `${scope}:${agent?.id ?? ''}`;
    const activeField = getActiveCompanionLinkField(scope, agent?.id);
    const searchQuery = companionLinkSearch.get(key) ?? '';
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const selectedOnly = companionLinkSelectedOnly.has(key);
    const countsByField = new Map(COMPANION_QUICK_LINKS.map(({ field }) => {
        const ids = new Set(config[field] ?? []);
        const count = companions.filter(candidate => isLinked(ids, candidate)).length;
        return [field, count];
    }));
    const tabButtonsHtml = COMPANION_QUICK_LINKS.map(({ field, title }) => {
        const count = countsByField.get(field) ?? 0;
        const active = field === activeField;
        return `<button type="button" class="ica--companion-quick-tab${active ? ' is-active' : ''}${count > 0 ? ' has-links' : ''}" data-quick-tab="${field}" aria-pressed="${active ? 'true' : 'false'}"><span class="ica--companion-quick-tab-label">${title}</span><span class="ica--companion-quick-count">${count}</span></button>`;
    }).join('');
    const tabsHtml = `
        <div class="ica--companion-quick-tabs" role="group" aria-label="Connection type">
            ${tabButtonsHtml}
        </div>`;
    const toolbarHtml = companions.length > 1 ? `
        <div class="ica--companion-quick-toolbar">
            <label class="ica--companion-quick-search">
                <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                <input type="search" class="text_pole" placeholder="Filter companions..." value="${escapeHtml(searchQuery)}" data-quick-search data-role="quick-search" aria-label="Filter companions">
            </label>
            <button type="button" class="ica--companion-quick-filter${selectedOnly ? ' is-active' : ''}" data-quick-selected-only aria-pressed="${selectedOnly ? 'true' : 'false'}" title="Show only connected companions in this tab">
                <span>Connected</span>
            </button>
        </div>` : '';
    const groupsHtml = COMPANION_QUICK_LINKS.map(({ field, title, help }) => {
        const ids = new Set(config[field] ?? []);
        const active = field === activeField;
        const sortedCompanions = [...companions].sort((a, b) => {
            const aLinked = isLinked(ids, a);
            const bLinked = isLinked(ids, b);
            if (aLinked !== bLinked) return aLinked ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        let visibleCount = 0;
        const optionsHtml = sortedCompanions.map(candidate => {
            const linked = isLinked(ids, candidate);
            const matchesQuery = !normalizedQuery || candidate.name.toLowerCase().includes(normalizedQuery);
            const matchesSelected = !selectedOnly || linked;
            const visible = matchesQuery && matchesSelected;
            if (visible) visibleCount += 1;
            return `<label class="checkbox_label ica--companion-quick-option${linked ? ' is-selected' : ''}${visible ? '' : ' displayNone'}" data-candidate-name="${escapeHtml(candidate.name.toLowerCase())}"><input type="checkbox" data-quick-link="${field}" data-candidate-id="${escapeHtml(candidate.id)}"${linked ? ' checked' : ''}><span>${escapeHtml(candidate.name)}</span></label>`;
        }).join('');
        const emptyText = selectedOnly && !normalizedQuery
            ? 'No connected companions in this tab yet.'
            : 'No matching companions.';
        return `
            <fieldset class="ica--companion-quick-group" data-quick-group="${field}"${active ? '' : ' hidden'}>
                <legend>${title}</legend>
                <p class="ica--companion-quick-help">${help}</p>
                <div class="ica--companion-quick-options">
                    ${optionsHtml}
                </div>
                <p class="ica--companion-quick-empty" data-quick-empty${visibleCount === 0 ? '' : ' hidden'}>${emptyText}</p>
            </fieldset>`;
    }).join('');
    return `${tabsHtml}${toolbarHtml}${groupsHtml}`;
}

function applyCompanionQuickFilter(container, scope, agentId) {
    if (!container || !agentId) return;
    const key = `${scope}:${agentId}`;
    const normalizedQuery = (companionLinkSearch.get(key) ?? '').trim().toLowerCase();
    const selectedOnly = companionLinkSelectedOnly.has(key);
    const emptyText = selectedOnly && !normalizedQuery
        ? 'No connected companions in this tab yet.'
        : 'No matching companions.';
    container.querySelectorAll('[data-quick-group]').forEach(group => {
        let visibleCount = 0;
        group.querySelectorAll('.ica--companion-quick-option').forEach(option => {
            const name = option.getAttribute('data-candidate-name') ?? option.textContent?.toLowerCase() ?? '';
            const input = option.querySelector('input[type="checkbox"]');
            const checked = Boolean(input?.checked);
            if (option.classList.contains('is-selected') !== checked) option.classList.toggle('is-selected', checked);
            const matchesQuery = !normalizedQuery || name.includes(normalizedQuery);
            const matchesSelected = !selectedOnly || checked;
            const visible = matchesQuery && matchesSelected;
            // A class, not the hidden attribute: Chrome restyles the whole panel for every
            // hidden change because :has() rules watch it.
            if (option.classList.contains('displayNone') === visible) option.classList.toggle('displayNone', !visible);
            if (visible) visibleCount += 1;
        });
        const emptyEl = group.querySelector('[data-quick-empty]');
        if (emptyEl) {
            if (emptyEl.textContent !== emptyText) emptyEl.textContent = emptyText;
            if (emptyEl.hidden !== visibleCount > 0) emptyEl.hidden = visibleCount > 0;
        }
    });
}

function fillCompanionQuickGroups(details, scope = 'card') {
    const groups = details?.querySelector(':scope > .ica--companion-quick-groups[data-quick-groups-pending]');
    if (!groups) return;
    const agentId = details.closest('[data-companion-quick]')?.getAttribute('data-companion-quick');
    const agent = getAgents().find(item => item.id === agentId);
    if (!agent) return;
    groups.innerHTML = buildCompanionQuickGroupsHtml(agent, getOtherCompanions(agent), { scope });
    groups.removeAttribute('data-quick-groups-pending');
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
    const insertDepth = config.chatHistoryInsertDepth === null || config.chatHistoryInsertDepth === undefined ? '' : String(config.chatHistoryInsertDepth);
    const open = isCompanionLinksOpen(scope, agent.id);
    const summaryText = describeCompanionLinks(agent, companions);
    const isConnected = summaryText !== 'Not connected' && summaryText !== 'No other companions yet';
    const groups = open
        ? `<div class="ica--companion-quick-groups">${buildCompanionQuickGroupsHtml(agent, companions, { scope })}</div>`
        : '<div class="ica--companion-quick-groups" data-quick-groups-pending></div>';
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
                <label class="ica--companion-quick-depth ica--companion-quick-insert" title="Depth Insertion: how many messages up from the newest reply the kept-notes block sits. Setting a depth switches kept notes to one labelled block. Leave blank to use the agent's Position and Depth fields.">
                    <input type="number" class="text_pole" min="0" max="99" step="1" inputmode="numeric" placeholder="Auto" value="${insertDepth}" data-quick-insert-depth aria-label="Depth to insert kept notes for ${name} (blank uses the agent's fields)">
                    <span>at depth</span>
                </label>
            </div>
            <details class="ica--companion-quick-links"${open ? ' open' : ''}${isConnected ? ' data-connected="true"' : ''}>
                <summary><i class="fa-solid fa-link" aria-hidden="true"></i><span>Connections</span><small>${escapeHtml(summaryText)}</small></summary>
                ${groups}
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
    if (target.matches('[data-quick-insert-depth]')) {
        if (!target.checkValidity()) {
            target.reportValidity();
            return null;
        }
        return { kind: 'insertDepth', value: target.value };
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
    if (target.matches('[data-quick-insert-depth]')) return '[data-quick-insert-depth]';
    if (target.matches('[data-quick-search]')) return '[data-quick-search]';
    if (target.matches('[data-quick-selected-only]')) return '[data-quick-selected-only]';
    if (target.matches('[data-quick-tab]')) return `[data-quick-tab="${target.dataset.quickTab}"]`;
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
        if (details.open) fillCompanionQuickGroups(details, scope);
    }, true);
    // Fill the groups before the summary opens the panel, so it never paints empty.
    root.addEventListener('click', event => {
        const summary = event.target instanceof Element ? event.target.closest('.ica--companion-quick-links > summary') : null;
        if (summary) fillCompanionQuickGroups(summary.parentElement, scope);
    }, true);
    root.addEventListener('click', async event => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const tabButton = target.closest('[data-quick-tab]');
        if (tabButton) {
            const container = tabButton.closest('[data-companion-quick]');
            const agentId = container?.getAttribute('data-companion-quick');
            const field = tabButton.getAttribute('data-quick-tab');
            if (!container || !agentId || !field) return;
            setActiveCompanionLinkField(scope, agentId, field);
            container.querySelectorAll('[data-quick-tab]').forEach(btn => {
                const active = btn.getAttribute('data-quick-tab') === field;
                btn.classList.toggle('is-active', active);
                btn.setAttribute('aria-pressed', active ? 'true' : 'false');
            });
            container.querySelectorAll('[data-quick-group]').forEach(group => {
                group.hidden = group.getAttribute('data-quick-group') !== field;
            });
            return;
        }
        const filterButton = target.closest('[data-quick-selected-only]');
        if (filterButton) {
            const container = filterButton.closest('[data-companion-quick]');
            const agentId = container?.getAttribute('data-companion-quick');
            if (!container || !agentId) return;
            const key = `${scope}:${agentId}`;
            const nextActive = !companionLinkSelectedOnly.has(key);
            if (nextActive) companionLinkSelectedOnly.add(key);
            else companionLinkSelectedOnly.delete(key);
            filterButton.classList.toggle('is-active', nextActive);
            filterButton.setAttribute('aria-pressed', nextActive ? 'true' : 'false');
            applyCompanionQuickFilter(container, scope, agentId);
            return;
        }
        const button = target.closest('[data-quick-more]');
        const agentId = button?.closest('[data-companion-quick]')?.getAttribute('data-companion-quick');
        if (!agentId) return;
        await openMore?.(agentId);
    });
    root.addEventListener('input', event => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || !target.matches('[data-quick-search]')) return;
        const container = target.closest('[data-companion-quick]');
        const agentId = container?.getAttribute('data-companion-quick');
        if (!container || !agentId) return;
        event.stopPropagation();
        const key = `${scope}:${agentId}`;
        if (target.value) companionLinkSearch.set(key, target.value);
        else companionLinkSearch.delete(key);
        applyCompanionQuickFilter(container, scope, agentId);
    });
    root.addEventListener('keydown', event => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || !target.matches('[data-quick-search]')) return;
        if (event.key === 'Escape' && target.value) {
            event.preventDefault();
            event.stopPropagation();
            target.value = '';
            const container = target.closest('[data-companion-quick]');
            const agentId = container?.getAttribute('data-companion-quick');
            if (container && agentId) {
                companionLinkSearch.delete(`${scope}:${agentId}`);
                applyCompanionQuickFilter(container, scope, agentId);
            }
        }
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
            if (change?.kind === 'depth' || change?.kind === 'insertDepth') target.reportValidity?.();
            return;
        }
        const selector = getCompanionQuickControlSelector(target);
        const optionsEl = target instanceof Element ? target.closest('.ica--companion-quick-options') : null;
        const savedScrollTop = optionsEl ? optionsEl.scrollTop : 0;
        const activeGroupField = target instanceof Element ? (target.closest('[data-quick-group]')?.getAttribute('data-quick-group') || '') : '';
        container.querySelectorAll('input').forEach(input => { input.disabled = true; });
        try {
            await save(agentId, draft);
        } catch (error) {
            toastr.error(escapeHtml(error?.message || String(error)), 'Could not save the companion');
        } finally {
            container.querySelectorAll('input').forEach(input => { input.disabled = false; });
            const rendered = [...getRoot().querySelectorAll('[data-companion-quick]')]
                .find(element => element.getAttribute('data-companion-quick') === agentId);
            if (rendered && activeGroupField && savedScrollTop > 0) {
                const nextOptionsEl = rendered.querySelector(`[data-quick-group="${activeGroupField}"] .ica--companion-quick-options`);
                if (nextOptionsEl) nextOptionsEl.scrollTop = savedScrollTop;
            }
            const control = selector ? rendered?.querySelector(selector) : null;
            if (control instanceof HTMLElement) control.focus({ preventScroll: true });
        }
    });
}
