import { matchesChatPickerQuery, resolveChatPickerPlacement } from './chat-picker-model.js';
import { t } from './i18n.js';
import { revealUi, setUiVisibility } from './ui-motion.js';

const SEARCH_DELAY_MS = 120;
const NAVIGATION_KEYS = new Set(['Escape', 'Enter', 'ArrowDown', 'ArrowUp', 'Home', 'End']);
const pickers = new WeakMap();

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
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

/**
 * Shows a native select as a trigger button that opens the chat picker's floating list.
 * The select stays in the page, hidden, and remains the source of truth: code that reads
 * it, sets it or listens for its change event works unchanged.
 * @param {HTMLSelectElement} select
 * @param {object} options
 * @param {string} options.buttonId
 * @param {string} options.panelId
 * @param {() => { title: string, subtitle?: string, search: string }} options.labels
 * @param {() => void} [options.onOpen]
 */
export function createSelectPicker(select, { buttonId, panelId, labels, onOpen = () => {} }) {
    if (pickers.has(select)) return pickers.get(select);

    const button = element('button', 'sb-select-picker-button');
    button.id = buttonId;
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', panelId);
    const value = element('span', 'sb-select-picker-value');
    value.id = `${buttonId}-value`;
    value.setAttribute('translate', 'no');
    const chevron = element('i', 'fa-solid fa-chevron-down');
    chevron.setAttribute('aria-hidden', 'true');
    button.append(value, chevron);

    const label = select.id ? document.querySelector(`label[for="${CSS.escape(select.id)}"]`) : null;
    if (label) {
        label.id ||= `${buttonId}-label`;
        label.htmlFor = buttonId;
        button.setAttribute('aria-labelledby', `${label.id} ${value.id}`);
    } else {
        button.setAttribute('aria-label', select.getAttribute('aria-label') || labels().title);
    }

    select.before(button);
    select.hidden = true;
    select.classList.add('sb-select-picker-source');

    let panel = null;
    let parts = null;
    let searchTimer = 0;
    let syncQueued = false;
    let resizeObserver = null;
    let classObserver = null;

    function sync() {
        syncQueued = false;
        const text = select.selectedOptions[0]?.label ?? '';
        if (value.textContent !== text) value.textContent = text;
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
    }

    function rows() {
        return parts ? Array.from(parts.list.querySelectorAll('.sb-chat-picker-row:not(:disabled)')) : [];
    }

    function render() {
        const { list, count, status, search } = parts;
        const focusedIndex = document.activeElement?.closest?.('.sb-chat-picker-row')?.dataset.index;
        const scrollTop = list.scrollTop;
        const options = Array.from(select.options).filter(option => !option.hidden);
        const query = search.value;
        const matches = options.filter(option => matchesChatPickerQuery({ title: option.label }, query));
        list.replaceChildren(...matches.map(option => {
            const row = element('button', `sb-chat-picker-row${option.selected ? ' is-current' : ''}`);
            row.type = 'button';
            row.dataset.index = String(option.index);
            row.title = option.label;
            row.disabled = option.disabled;
            if (option.selected) row.setAttribute('aria-current', 'true');
            const heading = element('span', 'sb-chat-picker-row-heading');
            const name = element('span', 'sb-chat-picker-row-title', option.label);
            name.setAttribute('translate', 'no');
            heading.append(name);
            if (option.selected) heading.append(element('span', 'sb-chat-picker-current', t`Current`));
            row.append(heading);
            row.addEventListener('click', () => choose(option));
            return row;
        }));
        count.textContent = query.trim() ? `${matches.length} / ${options.length}` : String(options.length);
        status.textContent = matches.length ? '' : t`No matches`;
        status.hidden = !status.textContent;
        list.scrollTop = scrollTop;
        if (focusedIndex !== undefined) list.querySelector(`[data-index="${focusedIndex}"]`)?.focus({ preventScroll: true });
        position();
    }

    function choose(option) {
        close({ restoreFocus: true });
        if (option.disabled || option.selected || option.parentElement === null) return;
        select.selectedIndex = option.index;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
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
        panel = element('section', 'sb-chat-picker sb-select-picker');
        panel.id = panelId;
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', text.title);
        const header = element('div', 'sb-chat-picker-header');
        const titles = element('div', 'sb-chat-picker-titles');
        titles.append(element('strong', 'sb-chat-picker-title', text.title));
        if (text.subtitle) titles.append(element('span', 'sb-chat-picker-owner', text.subtitle));
        const count = element('span', 'sb-chat-picker-count');
        const dismiss = element('button', 'sb-chat-picker-close', t`Close`);
        dismiss.type = 'button';
        dismiss.addEventListener('click', () => close({ restoreFocus: true }));
        header.append(titles, count, dismiss);
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
        parts = { list, count, status, search };
        document.body.append(panel);
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
