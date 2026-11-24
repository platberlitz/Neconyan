const renderedScopes = new WeakMap();
const renderedSources = new WeakMap();
const contentSelector = '.ica--companion-body, .ica--tpanel-agent-body';
const keptControlSelector = 'input[data-role], textarea[data-role], select[data-role], [data-ica-busy]';
const freshControlSelector = 'input[data-role], textarea[data-role], select[data-role], [data-action]';
const focusableSelector = 'input, textarea, button, summary, select';

function controlKey(element) {
    const agent = element.closest('[data-agent-id]')?.dataset.agentId ?? '';
    const entry = element.closest('.ica--tpanel-history-entry')?.dataset.messageIndex ?? '';
    return JSON.stringify([agent, entry, element.tagName, element.dataset.role || element.dataset.action || element.classList[0] || '', element.dataset.plotScope || '']);
}

// Keep edits through a redraw, but refresh an untouched objective when the agent editor saves it.
function reconcilePlotObjective(previous, fresh) {
    if (!['plot-compass-objective', 'plot-compass-enabled'].includes(previous.dataset.role)) return;
    const property = previous.dataset.role === 'plot-compass-enabled' ? 'checked' : 'value';
    const sameAsSaved = previous[property] === fresh[property];
    const untouched = String(previous[property]) === previous.dataset.plotSavedValue;
    if (untouched && !sameAsSaved) previous[property] = fresh[property];
    if (untouched || sameAsSaved) {
        previous.dataset.plotSavedValue = String(fresh[property]);
    }
}

function findWithin(nodes, selector) {
    return nodes.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]);
}

function captureViewState(nodes, sameScope) {
    const active = document.activeElement;
    const focused = nodes.some(node => node.contains(active)) ? active : null;
    const state = {
        sameScope,
        controls: new Map(),
        expanded: new Map(),
        focusKey: focused && controlKey(focused),
        selection: focused && [focused.selectionStart, focused.selectionEnd],
    };
    if (!sameScope) return state;
    for (const control of findWithin(nodes, keptControlSelector)) {
        if (!control.closest(contentSelector)) state.controls.set(controlKey(control), control);
    }
    for (const details of findWithin(nodes, 'details')) {
        if (!details.closest(contentSelector)) state.expanded.set(controlKey(details), details.open);
    }
    return state;
}

function restoreViewState(nodes, state) {
    if (!state.sameScope) return;
    for (const control of findWithin(nodes, freshControlSelector)) {
        const previous = state.controls.get(controlKey(control));
        if (previous && !control.closest(contentSelector)) {
            reconcilePlotObjective(previous, control);
            control.replaceWith(previous);
        }
    }
    for (const details of findWithin(nodes, 'details')) {
        const open = state.expanded.get(controlKey(details));
        if (open !== undefined && !details.closest(contentSelector)) details.open = open;
    }
    if (state.focusKey) {
        const next = findWithin(nodes, focusableSelector).find(control => controlKey(control) === state.focusKey);
        next?.focus({ preventScroll: true });
        if (Number.isInteger(state.selection?.[0]) && typeof next?.setSelectionRange === 'function') {
            next.setSelectionRange(...state.selection);
        }
    }
}

/** Keep live form nodes: pending handlers still own the same inputs and buttons after a refresh. */
export function replaceCompanionView(root, content, isCurrent) {
    const element = root[0];
    if (!element?.querySelectorAll) {
        root.html(content);
        return;
    }

    const sameScope = renderedScopes.get(element)?.() === true;
    const state = captureViewState([...element.children], sameScope);
    if (typeof content === 'string') {
        root.html(content);
    } else {
        root.empty().append(content);
    }
    renderedScopes.set(element, isCurrent);
    restoreViewState([...element.children], state);
}

function describeView(container, listSelector, itemKey) {
    const units = [];
    for (const node of container.children) {
        if (listSelector && node.matches(listSelector)) {
            units.push({ node, key: 'list', list: true });
            for (const item of node.children) {
                units.push({ node: item, key: `item:${item.dataset?.[itemKey] ?? ''}` });
            }
        } else {
            units.push({ node, key: `top:${node.tagName}` });
        }
    }
    return units;
}

/**
 * Like replaceCompanionView, but leaves untouched sections in place. Every new node makes the browser
 * restyle it, and a panel full of themed notes takes a noticeable pause to restyle in full.
 * The top-level children and the children of `listSelector` (keyed by `data-<itemKey>`) are compared
 * with the markup they were drawn from; anything else falls back to a full redraw.
 */
export function patchCompanionView(root, html, isCurrent, { listSelector = '', itemKey = 'agentId' } = {}) {
    const element = root[0];
    const template = element?.querySelectorAll && globalThis.document?.createElement?.('template');
    if (!template?.content) {
        replaceCompanionView(root, html, isCurrent);
        return;
    }

    template.innerHTML = html;
    // Template content belongs to an inert document, which jQuery cannot insert from.
    const owner = element.ownerDocument;
    const content = owner.createDocumentFragment();
    for (const child of [...template.content.childNodes]) content.append(owner.adoptNode(child));
    const next = describeView(content, listSelector, itemKey).map(unit => ({
        ...unit,
        source: unit.list ? unit.node.cloneNode(false).outerHTML : unit.node.outerHTML,
    }));
    const live = describeView(element, listSelector, itemKey).map(unit => ({ ...unit, source: renderedSources.get(unit.node) }));
    const sameScope = renderedScopes.get(element)?.() === true;
    const patchable = sameScope && live.length === next.length && live.every((unit, index) => unit.source !== undefined
        && unit.key === next[index].key
        && (!unit.list || unit.source === next[index].source));

    if (!patchable) {
        replaceCompanionView(root, content, isCurrent);
        for (const unit of next) renderedSources.set(unit.node, unit.source);
        return;
    }

    renderedScopes.set(element, isCurrent);
    const changed = live.flatMap((unit, index) => !unit.list && unit.source !== next[index].source ? [{ previous: unit.node, fresh: next[index] }] : []);
    if (!changed.length) return;
    const state = captureViewState(changed.map(({ previous }) => previous), true);
    const jQuery = globalThis.jQuery;
    for (const { previous, fresh } of changed) {
        if (typeof jQuery === 'function') {
            jQuery(previous).replaceWith(fresh.node);
        } else {
            previous.replaceWith(fresh.node);
        }
        renderedSources.set(fresh.node, fresh.source);
    }
    restoreViewState(changed.map(({ fresh }) => fresh.node), state);
}

export async function runCompanionViewAction(button, action) {
    if (button?.disabled || button?.dataset?.icaBusy) return;
    if (button?.dataset) button.dataset.icaBusy = 'true';
    try {
        await action();
    } finally {
        if (button?.dataset) delete button.dataset.icaBusy;
    }
}
