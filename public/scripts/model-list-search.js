import { t } from './i18n.js';

const MAX_ROWS = 50;
const VALUE_CHECK_MS = 400;
const lists = new WeakMap();
const attached = new Set();
let valueTimer = 0;

function watchValues() {
    if (valueTimer) return;
    valueTimer = window.setInterval(() => {
        if (document.visibilityState === 'hidden') return;
        for (const list of attached) {
            if (list.select.value !== list.value) list.syncPressed();
        }
    }, VALUE_CHECK_MS);
}

/**
 * @typedef {object} ModelListOptions
 * @property {(option: { id: string, text: string, element: HTMLOptionElement }) => (string | Node | { 0?: Node } | null | undefined)} [template]
 *   Rich row content; a string falls back to the plain name and ID row.
 * @property {'family' | 'native'} [grouping] 'family' groups by model name; 'native' keeps the select's own groups when it has any.
 * @property {(option: HTMLOptionElement) => boolean} [isPinned] Rows shown first, without a heading.
 * @property {string} [emptyLabel] Show the option with an empty value under this name.
 */

/**
 * Replaces a model select with an always-visible, searchable list of buttons.
 * The select stays in the page, hidden, and keeps the chosen value.
 * @param {HTMLSelectElement} select
 * @param {ModelListOptions} [options]
 */
export function attachModelListSearch(select, options = {}) {
    if (!(select instanceof HTMLSelectElement) || select.multiple || !select.id) return null;
    const existing = lists.get(select);
    if (existing) {
        existing.options = { ...existing.options, ...options };
        existing.render();
        return existing;
    }

    const root = document.createElement('div');
    root.className = 'nn-model-list';
    root.dataset.modelListFor = select.id;

    const row = document.createElement('div');
    row.className = 'nn-model-list-search-row';
    const input = document.createElement('input');
    input.id = `${select.id}_search`;
    input.type = 'search';
    input.className = 'text_pole';
    input.autocomplete = 'off';
    input.placeholder = t`Search by name or model ID…`;
    input.setAttribute('aria-label', t`Search models`);
    input.setAttribute('aria-controls', `${select.id}_results`);
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'menu_button';
    clear.title = t`Clear model search`;
    clear.setAttribute('aria-label', t`Clear model search`);
    clear.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
    row.append(input, clear);

    const status = document.createElement('small');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    const results = document.createElement('div');
    results.id = `${select.id}_results`;
    results.className = 'nn-model-list-results';
    results.dataset.modelResults = '';

    root.append(row, status, results);
    select.after(root);
    select.classList.add('nn-model-list-native');
    select.hidden = true;

    const list = { select, root, input, results, options: { ...options }, value: select.value, render, focus, syncPressed };
    lists.set(select, list);
    attached.add(list);

    function choose(value) {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        render();
    }

    function isListed(option) {
        if (option.disabled) return false;
        if (!option.value && list.options.emptyLabel === undefined) return false;
        const group = option.parentElement;
        return !(group instanceof HTMLOptGroupElement && (group.disabled || group.style.display === 'none'));
    }

    function getText(option) {
        if (!option.value) return list.options.emptyLabel ?? '';
        return option.textContent.trim() || option.value;
    }

    function buildGroups(matches) {
        const pinned = [];
        const favourites = [];
        const rest = [];
        for (const option of matches) {
            if (!option.value || list.options.isPinned?.(option)) pinned.push(option);
            else if (option.dataset.favorite === 'true') favourites.push(option);
            else rest.push(option);
        }

        const groups = [];
        if (pinned.length) groups.push({ label: null, items: pinned });
        if (favourites.length) groups.push({ label: t`Favourites`, items: favourites });
        const native = list.options.grouping === 'native' && rest.some(option => option.parentElement instanceof HTMLOptGroupElement);
        if (native) {
            const byLabel = new Map();
            for (const option of rest) {
                const label = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : '';
                if (!byLabel.has(label)) byLabel.set(label, []);
                byLabel.get(label).push(option);
            }
            for (const [label, items] of byLabel) groups.push({ label: label || t`Other`, items });
        } else if (rest.length) {
            groups.push({ label: favourites.length ? t`Other` : null, items: rest });
        }
        return groups;
    }

    function appendTemplate(label, option) {
        const template = list.options.template;
        if (!template || !option.value) return false;
        let content;
        try {
            content = template({ id: option.value, text: getText(option), element: option });
        } catch {
            return false;
        }
        const node = content instanceof Node ? content : content?.[0];
        if (!(node instanceof Node)) return false;
        label.append(node);
        return true;
    }

    function createRow(option) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'nn-model-list-option';
        button.dataset.modelId = option.value;
        button.setAttribute('aria-pressed', String(select.value === option.value));
        button.disabled = select.disabled;
        const label = document.createElement('span');
        label.className = 'nn-model-list-label';
        if (!appendTemplate(label, option)) {
            const name = document.createElement('span');
            name.textContent = getText(option);
            label.append(name);
            if (option.value && name.textContent !== option.value) {
                const id = document.createElement('small');
                id.textContent = option.value;
                label.append(id);
            }
        }
        button.append(label);
        if (option.dataset.favorite === 'true') {
            const favourite = document.createElement('i');
            favourite.className = 'fa-solid fa-star nn-model-list-favourite';
            favourite.dataset.modelFavourite = '';
            favourite.setAttribute('role', 'img');
            favourite.setAttribute('aria-label', t`Favourite`);
            favourite.title = t`Favourite`;
            button.append(favourite);
        }
        return button;
    }

    function render() {
        list.value = select.value;
        const focusedValue = results.contains(document.activeElement) ? document.activeElement.dataset.modelId : null;
        const terms = input.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const seen = new Set();
        const available = [...select.options].filter(option => {
            if (!isListed(option) || seen.has(option.value)) return false;
            seen.add(option.value);
            return true;
        });
        const matches = available.filter(option => {
            const text = `${option.value} ${getText(option)}`.toLocaleLowerCase();
            return terms.every(term => text.includes(term));
        });
        clear.disabled = !input.value;
        status.textContent = !available.length
            ? t`Connect to load models, or enter a model ID above.`
            : !matches.length
                ? t`No models match. Try another name or model ID.`
                : matches.length > MAX_ROWS
                    ? t`${matches.length} models found. Showing the first 50; search to narrow the list.`
                    : t`${matches.length} of ${available.length} models`;

        const fragment = document.createDocumentFragment();
        let shown = 0;
        for (const group of buildGroups(matches)) {
            if (shown >= MAX_ROWS) break;
            const items = group.items.slice(0, MAX_ROWS - shown);
            if (group.label) {
                const heading = document.createElement('div');
                heading.className = 'nn-model-list-group';
                heading.textContent = group.label;
                fragment.append(heading);
            }
            for (const option of items) fragment.append(createRow(option));
            shown += items.length;
        }
        results.replaceChildren(fragment);
        if (focusedValue !== null && focusedValue !== undefined) {
            results.querySelector(`[data-model-id="${CSS.escape(focusedValue)}"]`)?.focus({ preventScroll: true });
        }
    }

    function syncPressed() {
        list.value = select.value;
        for (const button of getButtons()) {
            button.setAttribute('aria-pressed', String(button.dataset.modelId === select.value));
        }
    }

    function getButtons() {
        return [...results.querySelectorAll('.nn-model-list-option')];
    }

    /** Brings the list into view without opening an on-screen keyboard. */
    function focus() {
        root.scrollIntoView({ block: 'nearest' });
        const target = results.querySelector('[aria-pressed="true"]') ?? getButtons()[0];
        if (target instanceof HTMLElement) {
            target.focus({ preventScroll: true });
            target.scrollIntoView({ block: 'nearest' });
        } else {
            input.focus({ preventScroll: true });
        }
    }

    input.addEventListener('input', () => {
        render();
        results.scrollTop = 0;
    });
    clear.addEventListener('click', () => {
        input.value = '';
        render();
        results.scrollTop = 0;
        input.focus();
    });
    results.addEventListener('click', event => {
        const button = event.target instanceof Element ? event.target.closest('[data-model-id]') : null;
        if (button instanceof HTMLElement && results.contains(button)) choose(button.dataset.modelId ?? '');
    });
    root.addEventListener('keydown', event => {
        if (event.isComposing) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            input.value = '';
            render();
            input.focus();
        } else if (event.target === input && event.key === 'Enter') {
            event.preventDefault();
            if (input.value.trim()) getButtons()[0]?.click();
        } else if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            const buttons = getButtons();
            const current = buttons.indexOf(/** @type {HTMLButtonElement} */ (event.target));
            if (event.target !== input && current < 0) return;
            event.preventDefault();
            const next = current + (event.key === 'ArrowDown' ? 1 : -1);
            if (next < 0) input.focus();
            else buttons[Math.min(next, buttons.length - 1)]?.focus();
        }
    });
    // jQuery's trigger('change') does not reach plain listeners, and .val() fires nothing at all.
    const jQuery = globalThis.jQuery;
    if (typeof jQuery === 'function') jQuery(select).on('change', syncPressed);
    else select.addEventListener('change', syncPressed);
    watchValues();
    new MutationObserver(render).observe(select, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['disabled', 'label', 'data-favorite', 'value', 'style'],
    });
    render();
    return list;
}

/** @param {HTMLSelectElement | null} select */
export function hasModelListSearch(select) {
    return Boolean(select && lists.has(select));
}

/**
 * Scrolls a select's model list into view and focuses its chosen row.
 * @param {HTMLSelectElement | null} select
 * @returns {boolean} Whether the select has a model list.
 */
export function focusModelListSearch(select) {
    const list = select ? lists.get(select) : null;
    list?.focus();
    return Boolean(list);
}

/**
 * Re-renders a select's model list, for changes the list cannot observe (such as a new template source).
 * @param {HTMLSelectElement | null} select
 */
export function refreshModelListSearch(select) {
    const list = select ? lists.get(select) : null;
    list?.render();
}
