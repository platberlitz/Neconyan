import { t } from './i18n.js';
import { groupByModelFamily } from './model-family.js';

const lists = new WeakMap();

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
    let rows = new WeakMap();
    let available = [];
    let searchText = new WeakMap();
    let revealOnRender = true;
    let renderedGroups = [];
    let headings = new Map();
    lists.set(select, list);

    // Programmatic .val() calls do not fire a change event. Sync before the
    // first interaction so the highlighted row is always the current value.
    root.addEventListener('focusin', syncPressed);
    root.addEventListener('pointerdown', syncPressed, { passive: true });

    function choose(value) {
        revealOnRender = false;
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        syncPressed();
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
        } else {
            const families = groupByModelFamily(rest, option => option.value);
            // Headings only help when at least one family holds several models.
            if (families.some(group => group.label && group.items.length > 1)) {
                for (const group of families) groups.push({ label: group.label ?? t`Other`, items: group.items });
            } else if (rest.length) {
                groups.push({ label: favourites.length ? t`Other` : null, items: rest });
            }
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
        const cached = rows.get(option);
        if (cached) {
            updatePressed(cached);
            return cached;
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'nn-model-list-option';
        button.dataset.modelId = option.value;
        button.setAttribute('aria-pressed', String(list.value === option.value));
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
        rows.set(option, button);
        return button;
    }

    /**
     * Forgets the rows the given source changes touched, or every row when the
     * changes are unknown. Untouched options keep their buttons.
     * @param {MutationRecord[] | null} changes
     */
    function forgetRows(changes) {
        if (!changes || changes.some(record => record.target === select && record.type === 'attributes')) {
            rows = new WeakMap();
            return;
        }
        for (const record of changes) {
            const target = record.target instanceof Element ? record.target : record.target.parentElement;
            const option = target?.closest('option');
            if (option) rows.delete(option);
        }
    }

    function render({ invalidate = true, changes = null } = {}) {
        const scrollTop = results.scrollTop;
        // A caller can replace options and dispatch input in the same turn,
        // before the observer has delivered those source changes.
        const pending = observer.takeRecords();
        if (pending.length) {
            changes = invalidate && !changes ? null : [...(changes ?? []), ...pending];
            invalidate = true;
        }
        if (invalidate) {
            forgetRows(changes);
            searchText = new WeakMap();
            const seen = new Set();
            // Native option reads and normalisation only change with the source,
            // not with each keystroke in the search field.
            available = [...select.options].filter(option => {
                if (!isListed(option) || seen.has(option.value)) return false;
                seen.add(option.value);
                searchText.set(option, `${option.value} ${getText(option)}`.toLocaleLowerCase());
                return true;
            });
        }
        list.value = select.value;
        const focusedValue = results.contains(document.activeElement) ? document.activeElement.dataset.modelId : null;
        const terms = input.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const matches = available.filter(option => {
            const text = searchText.get(option);
            return terms.every(term => text.includes(term));
        });
        if (clear.disabled !== !input.value) clear.disabled = !input.value;
        const statusText = !available.length
            ? t`Connect to load models, or enter a model ID above.`
            : !matches.length
                ? t`No models match. Try another name or model ID.`
                : t`${matches.length} of ${available.length} models`;
        if (status.textContent !== statusText) status.textContent = statusText;

        const groups = buildGroups(matches);
        // Typing another term can leave exactly the same rows and headings.
        // Keep those nodes attached so focus, selection and observers stay quiet.
        const unchanged = !invalidate && groups.length === renderedGroups.length && groups.every((group, index) => {
            const previous = renderedGroups[index];
            return group.label === previous.label && group.items.length === previous.items.length
                && group.items.every((option, itemIndex) => option === previous.items[itemIndex]);
        });
        if (unchanged) {
            syncPressed();
            return;
        }
        renderedGroups = groups;

        const nodes = [];
        const previousHeadings = headings;
        headings = new Map();
        for (const group of groups) {
            if (group.label) {
                let heading = headings.has(group.label) ? null : previousHeadings.get(group.label);
                if (!heading) {
                    heading = document.createElement('div');
                    heading.className = 'nn-model-list-group';
                    heading.textContent = group.label;
                }
                headings.set(group.label, heading);
                nodes.push(heading);
            }
            for (const option of group.items) nodes.push(createRow(option));
        }
        // Move only the rows that changed: re-adding hundreds of unchanged rows
        // on each keystroke in the model ID field made typing stall.
        const keep = new Set(nodes);
        for (const child of [...results.children]) {
            if (!keep.has(child)) child.remove();
        }
        let cursor = results.firstElementChild;
        for (const node of nodes) {
            if (node === cursor) cursor = cursor.nextElementSibling;
            else results.insertBefore(node, cursor);
        }
        // Rebuilding options temporarily empties the scroller. Restore its
        // position before returning focus to a row, including on touch screens.
        results.scrollTop = scrollTop;
        if (focusedValue !== null && focusedValue !== undefined) {
            results.querySelector(`[data-model-id="${CSS.escape(focusedValue)}"]`)?.focus({ preventScroll: true });
        } else if (invalidate && revealOnRender) {
            revealSelected();
        }
    }

    /** Move only the catalogue, never its containing settings panel. */
    function revealSelected() {
        if (input.value || !results.clientHeight) return;
        const target = results.querySelector('[aria-pressed="true"]');
        if (!target) return;
        const bounds = results.getBoundingClientRect();
        const row = target.getBoundingClientRect();
        if (row.top < bounds.top || row.bottom > bounds.bottom) {
            results.scrollTop += row.top - bounds.top - (results.clientHeight - row.height) / 2;
        }
    }

    function syncPressed() {
        list.value = select.value;
        for (const button of getButtons()) {
            updatePressed(button);
        }
    }

    function updatePressed(button) {
        const pressed = String(button.dataset.modelId === list.value);
        if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
    }

    function getButtons() {
        return [...results.querySelectorAll('.nn-model-list-option')];
    }

    /** Brings the list into view without opening an on-screen keyboard. */
    function focus() {
        revealOnRender = true;
        if (observer.takeRecords().length) render();
        syncPressed();
        revealSelected();
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
        render({ invalidate: false });
        results.scrollTop = 0;
    });
    clear.addEventListener('click', () => {
        input.value = '';
        render({ invalidate: false });
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
            render({ invalidate: false });
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
    // jQuery's trigger('change'/'input') does not reach plain listeners, and
    // .val() fires nothing at all. The explicit sync export covers silent .val()
    // calls; no polling timer is needed.
    const jQuery = globalThis.jQuery;
    if (typeof jQuery === 'function') jQuery(select).on('change input', syncPressed);
    else {
        select.addEventListener('change', syncPressed);
        select.addEventListener('input', syncPressed);
    }
    const observer = new MutationObserver(changes => render({ changes }));
    observer.observe(select, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['disabled', 'label', 'data-favorite', 'value', 'style'],
    });
    // Lists are often built while their backend or Connections is hidden.
    // Centre the saved model once that list is shown, without stealing focus.
    let visible = false;
    const visibilityObserver = new ResizeObserver(() => {
        const nextVisible = results.clientHeight > 0;
        if (nextVisible && !visible) {
            revealOnRender = true;
            syncPressed();
            revealSelected();
        }
        visible = nextVisible;
    });
    visibilityObserver.observe(results);
    render();
    return list;
}

/** @param {HTMLSelectElement | null} select */
export function hasModelListSearch(select) {
    return Boolean(select && lists.has(select));
}

/**
 * Updates the highlighted row after a silent programmatic value change.
 * @param {HTMLSelectElement | null} select
 */
export function syncModelListSearchValue(select) {
    const list = select ? lists.get(select) : null;
    list?.syncPressed();
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
