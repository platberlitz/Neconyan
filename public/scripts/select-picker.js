import { matchesChatPickerQuery, resolveChatPickerPlacement } from './chat-picker-model.js';
import { t } from './i18n.js';
import { revealUi, setUiVisibility } from './ui-motion.js';

const SEARCH_DELAY_MS = 120;
const NAVIGATION_KEYS = new Set(['Escape', 'Enter', 'ArrowDown', 'ArrowUp', 'Home', 'End']);
// Layout utilities the select had in its row, so the button takes its place.
const LAYOUT_CLASSES = ['flex1', 'wide100p'];
const pickers = new WeakMap();
let pickerCount = 0;

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function icon(className) {
    const node = element('i', className);
    node.setAttribute('aria-hidden', 'true');
    return node;
}

// jQuery's .val() and .prop('selected') change the selection without a change event,
// so the setters on this one element report back to the picker.
function watchSetter(target, proto, name, notify) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (!descriptor?.set || Object.prototype.hasOwnProperty.call(target, name)) return;
    Object.defineProperty(target, name, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() { return descriptor.get.call(this); },
        set(value) {
            descriptor.set.call(this, value);
            notify();
        },
    });
}

// Popup content is built before it is added to the page, so look in the select's own tree.
function findLabel(select) {
    if (!select.id) return null;
    const root = select.getRootNode();
    return root.querySelector?.(`label[for="${CSS.escape(select.id)}"]`) ?? null;
}

// The highest layer among the positioned containers holding a node.
function stackLevel(node) {
    let level = 0;
    for (let current = node.parentElement; current && current !== document.body; current = current.parentElement) {
        const style = getComputedStyle(current);
        const value = Number.parseInt(style.zIndex, 10);
        if (style.position !== 'static' && Number.isFinite(value)) level = Math.max(level, value);
    }
    return level;
}

/**
 * @typedef {object} SelectPickerLabels
 * @property {string} title Panel title, and the button's name when the select has no label
 * @property {string} [subtitle] Line under the title
 * @property {string} search Search field placeholder
 * @property {string} [placeholder] Button text while nothing is chosen
 */

/**
 * Shows a native select as a trigger button that opens the chat picker's floating list.
 * The select stays in the page, hidden, and remains the source of truth: code that reads
 * it, sets it or listens for its change event works unchanged. A multiple select gets a
 * list of toggles that stays open while you tick several.
 * @param {HTMLSelectElement} select
 * @param {object} options
 * @param {() => SelectPickerLabels} options.labels
 * @param {string} [options.buttonId]
 * @param {string} [options.panelId]
 * @param {() => void} [options.onOpen]
 * @param {(option: HTMLOptionElement) => string} [options.rowLabel] Row text, the option's label by default
 * @param {(option: HTMLOptionElement) => string} [options.describe] Second line under a row, also searched
 * @param {(option: HTMLOptionElement) => string} [options.selectionLabel] Button text for a chosen option
 * @param {(option: HTMLOptionElement) => void} [options.onToggle] Runs after a row of a multiple select is ticked or unticked
 * @param {boolean} [options.sortByLabel] List rows alphabetically instead of in option order
 * @param {{ label: string, icon: string, visible?: (option: HTMLOptionElement) => boolean, run: (option: HTMLOptionElement) => void }} [options.rowAction]
 *        A second button beside each row; pressing it closes the list first
 */
export function createSelectPicker(select, {
    labels,
    buttonId = '',
    panelId = '',
    onOpen = () => {},
    rowLabel = option => option.label,
    describe = () => '',
    selectionLabel = option => option.label,
    onToggle = () => {},
    sortByLabel = false,
    rowAction = null,
}) {
    if (pickers.has(select)) return pickers.get(select);

    const multiple = select.multiple;
    const baseId = select.id ? `sb-${select.id}-picker` : `sb-select-picker-${++pickerCount}`;
    buttonId ||= `${baseId}-button`;
    panelId ||= baseId;

    const button = element('button', 'sb-select-picker-button');
    button.classList.add(...LAYOUT_CLASSES.filter(name => select.classList.contains(name)));
    button.id = buttonId;
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', panelId);
    const value = element('span', 'sb-select-picker-value');
    value.id = `${buttonId}-value`;
    value.setAttribute('translate', 'no');
    button.append(value, icon('fa-solid fa-chevron-down'));

    const label = findLabel(select);
    if (label) {
        label.id ||= `${buttonId}-label`;
        label.htmlFor = buttonId;
        button.setAttribute('aria-labelledby', `${label.id} ${value.id}`);
    } else {
        button.setAttribute('aria-label', select.getAttribute('aria-label') || labels().title);
    }
    if (select.hasAttribute('aria-describedby')) {
        button.setAttribute('aria-describedby', select.getAttribute('aria-describedby'));
    }

    select.before(button);
    select.hidden = true;
    select.classList.add('sb-select-picker-source');

    /** @type {HTMLElement|null} */
    let panel = null;
    let parts = null;
    let searchTimer = 0;
    let syncQueued = false;
    let resizeObserver = null;
    let classObserver = null;
    /** Rows and row actions, mapped to their option so focus survives a re-render. */
    let controls = new WeakMap();

    function isCurrent(option) {
        // A favourite can be listed twice under different headings; both copies are the current one.
        return option.selected || (!multiple && option.value !== '' && option.value === select.value);
    }

    function chosenOptions() {
        return Array.from(select.selectedOptions).filter(option => !multiple || option.value !== '');
    }

    function sync() {
        syncQueued = false;
        const chosen = chosenOptions();
        const empty = !chosen.length || (!multiple && chosen[0].value === '');
        const text = empty
            ? labels().placeholder || chosen[0]?.label || ''
            : chosen.map(option => selectionLabel(option) || option.label).join(', ');
        if (value.textContent !== text) value.textContent = text;
        button.classList.toggle('is-placeholder', empty);
        button.title = text;
        button.disabled = select.disabled;
        if (panel) render();
    }

    function queueSync() {
        if (syncQueued) return;
        syncQueued = true;
        queueMicrotask(sync);
    }

    function watchOptions() {
        for (const option of select.options) watchSetter(option, HTMLOptionElement.prototype, 'selected', queueSync);
    }

    function viewport() {
        const visual = window.visualViewport;
        return {
            top: visual?.offsetTop ?? 0,
            left: visual?.offsetLeft ?? 0,
            width: visual?.width ?? window.innerWidth,
            height: visual?.height ?? window.innerHeight,
        };
    }

    function position() {
        if (!panel) return;
        const anchor = button.getBoundingClientRect();
        if (!button.getClientRects().length || button.disabled || anchor.bottom <= 0) {
            close();
            return;
        }
        const placement = resolveChatPickerPlacement({
            anchor,
            viewport: viewport(),
            preferredWidth: Math.max(280, Math.min(anchor.width, 520)),
            preferredHeight: 420,
            preferBelow: true,
        });
        Object.assign(panel.style, {
            left: `${placement.left}px`,
            top: `${placement.edgeTop}px`,
            width: `${placement.width}px`,
            maxHeight: `${placement.maxHeight}px`,
            translate: placement.above ? '0 -100%' : 'none',
        });
        if (panel.parentElement === document.body) return;
        // Inside a popup the dialog's backdrop blur makes fixed positions start at the dialog, not the screen.
        const rect = panel.getBoundingClientRect();
        const dx = rect.left - placement.left;
        const dy = (placement.above ? rect.bottom : rect.top) - placement.edgeTop;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            panel.style.left = `${placement.left - dx}px`;
            panel.style.top = `${placement.edgeTop - dy}px`;
        }
    }

    function rows() {
        return parts ? Array.from(parts.list.querySelectorAll('.sb-chat-picker-row:not(:disabled)')) : [];
    }

    function listedOptions() {
        // A ticked list hides its 'nothing chosen' entry and choices that are unavailable right now.
        return Array.from(select.options).filter(option => !option.hidden
            && !(multiple && (option.value === '' || (option.disabled && !option.selected))));
    }

    function renderRow(option, description) {
        const current = isCurrent(option);
        const text = rowLabel(option) || option.label;
        const row = element('button', `sb-chat-picker-row${current ? ' is-current' : ''}`);
        row.type = 'button';
        row.title = text;
        row.disabled = option.disabled && !(multiple && option.selected);
        if (multiple) row.setAttribute('aria-pressed', String(option.selected));
        else if (current) row.setAttribute('aria-current', 'true');
        const heading = element('span', 'sb-chat-picker-row-heading');
        if (multiple) heading.append(icon(`sb-select-picker-check ${option.selected ? 'fa-solid fa-square-check' : 'fa-regular fa-square'}`));
        const name = element('span', 'sb-chat-picker-row-title', text);
        name.setAttribute('translate', 'no');
        heading.append(name);
        if (current && !multiple) heading.append(element('span', 'sb-chat-picker-current', t`Current`));
        row.append(heading);
        if (description) row.append(element('span', 'sb-chat-picker-row-meta', description));
        row.addEventListener('click', () => {
            if (!multiple) return choose(option);
            // Safari does not focus a pressed button; the redraw keeps focus on this row only if it has it.
            row.focus({ preventScroll: true });
            toggleOption(option);
        });
        controls.set(row, { option, kind: 'row' });
        if (!rowAction || rowAction.visible?.(option) === false) return row;

        const action = element('button', 'sb-select-picker-row-action');
        action.type = 'button';
        action.title = `${rowAction.label}: ${text}`;
        action.setAttribute('aria-label', action.title);
        action.append(icon(`fa-solid ${rowAction.icon}`));
        action.addEventListener('click', () => {
            close();
            rowAction.run(option);
        });
        controls.set(action, { option, kind: 'action' });
        const wrap = element('div', 'sb-select-picker-row-wrap');
        wrap.append(row, action);
        return wrap;
    }

    function render() {
        const { list, count, status, search, clear } = parts;
        const active = document.activeElement;
        const focused = active && list.contains(active) ? controls.get(active) : null;
        const focusedIndex = focused ? Array.from(list.querySelectorAll('button')).indexOf(active) : -1;
        const scrollTop = list.scrollTop;
        const options = listedOptions();
        const query = search.value;
        const matches = options
            .map(option => ({ option, description: describe(option) || '' }))
            .filter(({ option, description }) => matchesChatPickerQuery({ title: rowLabel(option) || option.label, preview: description }, query));
        if (sortByLabel) matches.sort((a, b) => (rowLabel(a.option) || a.option.label).localeCompare(rowLabel(b.option) || b.option.label));

        controls = new WeakMap();
        const nodes = [];
        let group = null;
        for (const { option, description } of matches) {
            const parent = !sortByLabel && option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null;
            if (parent !== group) {
                // Options after a group are back at the top level, so a plain divider ends the group.
                const heading = element('div', parent ? 'sb-select-picker-group' : 'sb-select-picker-group is-divider', parent?.label);
                heading.setAttribute('role', parent ? 'heading' : 'separator');
                if (parent) heading.setAttribute('aria-level', '3');
                nodes.push(heading);
                group = parent;
            }
            nodes.push(renderRow(option, description));
        }
        list.replaceChildren(...nodes);

        const total = options.length;
        count.textContent = query.trim() ? `${matches.length} / ${total}` : String(total);
        const emptyEntry = Array.from(select.options).find(option => option.value === '');
        status.textContent = matches.length ? '' : (!query.trim() && multiple && emptyEntry?.label) || t`No matches`;
        status.hidden = !status.textContent;
        if (clear) clear.hidden = !chosenOptions().length;
        list.scrollTop = scrollTop;
        if (focused) {
            const buttons = Array.from(list.querySelectorAll('button'));
            const node = buttons.find(candidate => {
                const entry = controls.get(candidate);
                return entry?.option === focused.option && entry.kind === focused.kind;
            });
            // A row that left the list hands focus to its neighbour, so keys keep working in the panel.
            (node ?? buttons[Math.min(focusedIndex, buttons.length - 1)] ?? search).focus({ preventScroll: true });
        }
        position();
    }

    function dispatchChange() {
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function choose(option) {
        close({ restoreFocus: true });
        if (option.disabled || isCurrent(option) || option.parentElement === null) return;
        select.selectedIndex = option.index;
        dispatchChange();
    }

    function toggleOption(option) {
        if (!option.parentElement || (option.disabled && !option.selected)) return;
        option.selected = !option.selected;
        onToggle(option);
        dispatchChange();
    }

    function clearSelection() {
        const chosen = chosenOptions();
        if (!chosen.length) return;
        for (const option of chosen) option.selected = false;
        dispatchChange();
        parts?.search.focus({ preventScroll: true });
    }

    function outside(event) {
        const target = event.target;
        if (panel && target instanceof Node && !panel.contains(target) && !button.contains(target)) close();
    }

    function scrolled(event) {
        if (panel && !(event.target instanceof Node && panel.contains(event.target))) position();
    }

    function close({ restoreFocus = false } = {}) {
        if (!panel) return;
        const closing = panel;
        const closingList = parts.list;
        panel = null;
        parts = null;
        window.clearTimeout(searchTimer);
        closing.removeAttribute('id');
        closing.inert = true;
        closingList.style.overflow = 'hidden';
        setUiVisibility(closing, false, () => closing.remove(), { distance: 0 });
        button.setAttribute('aria-expanded', 'false');
        document.removeEventListener('click', outside, true);
        document.removeEventListener('focusin', outside);
        document.removeEventListener('scroll', scrolled, true);
        window.removeEventListener('resize', position);
        window.visualViewport?.removeEventListener('resize', position);
        window.visualViewport?.removeEventListener('scroll', position);
        resizeObserver?.disconnect();
        classObserver?.disconnect();
        if (restoreFocus) button.focus({ preventScroll: true });
    }

    function keydown(event) {
        if (!parts) return;
        const { search } = parts;
        if (NAVIGATION_KEYS.has(event.key) && searchTimer) {
            window.clearTimeout(searchTimer);
            searchTimer = 0;
            render();
            if (!parts) return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (event.target === search && search.value) {
                search.value = '';
                render();
            } else {
                close({ restoreFocus: true });
            }
            return;
        }
        if (event.key === 'Enter' && event.target === search && !event.isComposing) {
            event.preventDefault();
            rows()[0]?.click();
            return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        if (event.target === search && (event.key === 'Home' || event.key === 'End')) return;
        const all = rows();
        if (!all.length) return;
        event.preventDefault();
        const index = all.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0
            : event.key === 'End' ? all.length - 1
                : event.key === 'ArrowDown' ? (index + 1) % all.length
                    : index <= 0 ? all.length - 1 : index - 1;
        all[next].focus({ preventScroll: true });
        all[next].scrollIntoView({ block: 'nearest' });
    }

    function open() {
        if (panel || button.disabled) return;
        onOpen();
        const text = labels();
        panel = element('section', `sb-chat-picker sb-select-picker${multiple ? ' is-multiple' : ''}`);
        panel.id = panelId;
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', text.title);
        const header = element('div', 'sb-chat-picker-header');
        const titles = element('div', 'sb-chat-picker-titles');
        titles.append(element('strong', 'sb-chat-picker-title', text.title));
        if (text.subtitle) titles.append(element('span', 'sb-chat-picker-owner', text.subtitle));
        const count = element('span', 'sb-chat-picker-count');
        let clear = null;
        if (multiple) {
            clear = element('button', 'sb-select-picker-clear', t`Clear`);
            clear.type = 'button';
            clear.addEventListener('click', clearSelection);
        }
        const dismiss = element('button', 'sb-chat-picker-close', t`Close`);
        dismiss.type = 'button';
        dismiss.addEventListener('click', () => close({ restoreFocus: true }));
        header.append(titles, count, ...(clear ? [clear] : []), dismiss);
        const search = element('input', 'sb-chat-picker-search');
        search.type = 'search';
        search.placeholder = text.search;
        search.setAttribute('aria-label', text.search);
        search.autocomplete = 'off';
        search.addEventListener('input', () => {
            window.clearTimeout(searchTimer);
            searchTimer = window.setTimeout(() => {
                searchTimer = 0;
                if (panel) render();
            }, SEARCH_DELAY_MS);
        });
        const list = element('div', 'sb-chat-picker-list');
        const status = element('p', 'sb-chat-picker-status');
        status.setAttribute('role', 'status');
        panel.append(header, search, list, status);
        panel.addEventListener('keydown', keydown);
        parts = { list, count, status, search, clear };
        // A popup is a modal dialog: anything outside it cannot be pressed, so the list goes inside.
        (button.closest('dialog') ?? document.body).append(panel);
        // Some sheets, such as the prompt editor on phones, sit above the usual floating layer.
        const level = stackLevel(button);
        if (level >= (Number.parseInt(getComputedStyle(panel).zIndex, 10) || 0)) panel.style.zIndex = String(level + 1);
        button.setAttribute('aria-expanded', 'true');
        render();
        if (!panel) return;
        revealUi(panel, { distance: 0 });
        const current = list.querySelector('.is-current');
        current?.scrollIntoView({ block: 'nearest' });
        (window.matchMedia?.('(pointer: coarse)').matches ? current ?? dismiss : search).focus({ preventScroll: true });
        document.addEventListener('click', outside, true);
        document.addEventListener('focusin', outside);
        document.addEventListener('scroll', scrolled, true);
        window.addEventListener('resize', position);
        window.visualViewport?.addEventListener('resize', position);
        window.visualViewport?.addEventListener('scroll', position);
        resizeObserver = new ResizeObserver(() => position());
        resizeObserver.observe(button);
        classObserver = new MutationObserver(() => position());
        classObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    function toggle() {
        if (panel) close({ restoreFocus: true });
        else open();
    }

    button.addEventListener('click', toggle);
    button.addEventListener('keydown', event => {
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            open();
        }
    });

    watchSetter(select, HTMLSelectElement.prototype, 'value', queueSync);
    watchSetter(select, HTMLSelectElement.prototype, 'selectedIndex', queueSync);
    watchOptions();
    new MutationObserver(() => {
        watchOptions();
        queueSync();
    }).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['selected', 'disabled', 'label', 'hidden'] });
    select.addEventListener('change', queueSync);
    sync();

    const picker = { button, open, close, toggle, sync };
    pickers.set(select, picker);
    return picker;
}
