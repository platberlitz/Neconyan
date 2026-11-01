import { getChatPickerTitle, matchesChatPickerQuery, resolveChatPickerPlacement } from './chat-picker-model.js';
import { t } from './i18n.js';
import { revealUi, setUiVisibility } from './ui-motion.js';

function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/** A non-modal chat browser. The caller owns listing and safe chat switching. */
export function createChatPicker({ button, onSelect, onRefresh, onOpen }) {
    let state = { key: '', label: '', current: '', entries: [], loading: false, error: false };
    let panel;
    let search;
    let list;
    let status;
    let count;
    let retry;
    let observer;

    function position() {
        if (!panel) return;
        const anchor = button.getBoundingClientRect();
        if (!button.getClientRects().length || button.disabled || anchor.bottom <= 0) {
            close();
            return;
        }
        const view = window.visualViewport;
        const placement = resolveChatPickerPlacement({
            anchor,
            viewport: { top: view?.offsetTop ?? 0, left: view?.offsetLeft ?? 0,
                width: view?.width ?? window.innerWidth, height: view?.height ?? window.innerHeight },
        });
        Object.assign(panel.style, {
            left: `${placement.left}px`, top: `${placement.edgeTop}px`,
            width: `${placement.width}px`, maxHeight: `${placement.maxHeight}px`,
            translate: placement.above ? '0 -100%' : 'none',
        });
    }

    function close({ restoreFocus = false } = {}) {
        if (!panel) return;
        const closing = panel;
        panel = null;
        closing.removeAttribute('id');
        closing.inert = true;
        list.style.overflow = 'hidden';
        setUiVisibility(closing, false, () => closing.remove(), { distance: 0 });
        button.setAttribute('aria-expanded', 'false');
        document.removeEventListener('click', outsideClick);
        document.removeEventListener('focusin', outsideFocus);
        window.removeEventListener('resize', position);
        window.visualViewport?.removeEventListener('resize', position);
        window.visualViewport?.removeEventListener('scroll', position);
        observer?.disconnect();
        if (restoreFocus) button.focus({ preventScroll: true });
    }

    function outsideClick(event) {
        if (!panel?.contains(event.target) && !button.contains(event.target)) close();
    }

    function outsideFocus(event) {
        if (!panel?.contains(event.target) && !button.contains(event.target)) close();
    }

    function render() {
        if (!panel) return;
        const focusedFile = panel.contains(document.activeElement) ? document.activeElement.dataset.chatFile : null;
        const scrollTop = list.scrollTop;
        list.replaceChildren();
        let matches = 0;
        for (const entry of state.entries) {
            const title = getChatPickerTitle(entry.fileName, state.label);
            if (!matchesChatPickerQuery({ ...entry, title }, search.value)) continue;
            matches++;
            const current = entry.fileName === state.current;
            const row = element('button', `sb-chat-picker-row${current ? ' is-current' : ''}`);
            row.type = 'button';
            row.dataset.chatFile = entry.fileName;
            row.title = entry.fileName;
            if (current) row.setAttribute('aria-current', 'true');
            const heading = element('span', 'sb-chat-picker-row-heading');
            const name = element('span', 'sb-chat-picker-row-title', title);
            name.setAttribute('translate', 'no');
            heading.append(name);
            if (current) heading.append(element('span', 'sb-chat-picker-current', t`Current`));
            row.append(heading);
            if (entry.meta) row.append(element('span', 'sb-chat-picker-row-meta', entry.meta));
            if (entry.preview && entry.preview !== 'No preview yet.') {
                const preview = element('span', 'sb-chat-picker-row-preview', entry.preview);
                preview.setAttribute('translate', 'no');
                row.append(preview);
            }
            row.addEventListener('click', () => {
                close({ restoreFocus: true });
                void onSelect(entry.fileName);
            });
            list.append(row);
        }
        count.textContent = search.value.trim() ? `${matches} / ${state.entries.length}` : String(state.entries.length);
        status.textContent = state.error ? t`Chats could not load. Try again.`
            : state.loading ? t`Loading chats...`
                : !matches ? (state.entries.length ? t`No matching chats. Try another search.` : t`No saved chats yet.`) : '';
        status.hidden = !status.textContent;
        retry.hidden = !state.error;
        list.setAttribute('aria-busy', String(state.loading));
        list.scrollTop = scrollTop;
        if (focusedFile) {
            const replacement = [...list.children].find(row => row.dataset.chatFile === focusedFile);
            (replacement ?? search).focus({ preventScroll: true });
        }
        position();
    }

    function keydown(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (search.value) {
                search.value = '';
                render();
            } else close({ restoreFocus: true });
            return;
        }
        const rows = [...list.children];
        const inSearch = event.target === search;
        if (inSearch && event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            rows[0]?.click();
            return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || (inSearch && ['Home', 'End'].includes(event.key))) return;
        if (!rows.length) return;
        event.preventDefault();
        const index = rows.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
            : index < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1)
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        rows[next].focus({ preventScroll: true });
        rows[next].scrollIntoView({ block: 'nearest' });
    }

    function open() {
        if (panel || button.disabled) return;
        onOpen();
        panel = element('section', 'sb-chat-picker');
        panel.id = 'sb-bottom-chat-picker';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', t`Switch chat`);
        const header = element('div', 'sb-chat-picker-header');
        const titles = element('div', 'sb-chat-picker-titles');
        titles.append(element('strong', 'sb-chat-picker-title', t`Switch chat`));
        const owner = element('span', 'sb-chat-picker-owner', state.label);
        owner.setAttribute('translate', 'no');
        titles.append(owner);
        count = element('span', 'sb-chat-picker-count');
        const dismiss = element('button', 'sb-chat-picker-close', t`Close`);
        dismiss.type = 'button';
        dismiss.addEventListener('click', () => close({ restoreFocus: true }));
        header.append(titles, count, dismiss);
        search = element('input', 'sb-chat-picker-search');
        search.type = 'search';
        search.placeholder = t`Search chats`;
        search.setAttribute('aria-label', t`Search chats`);
        search.autocomplete = 'off';
        search.addEventListener('input', render);
        list = element('div', 'sb-chat-picker-list');
        status = element('p', 'sb-chat-picker-status');
        status.setAttribute('role', 'status');
        retry = element('button', 'sb-chat-picker-retry', t`Try again`);
        retry.type = 'button';
        retry.addEventListener('click', () => void onRefresh());
        panel.append(header, search, list, status, retry);
        panel.addEventListener('keydown', keydown);
        document.body.append(panel);
        button.setAttribute('aria-expanded', 'true');
        render();
        revealUi(panel, { distance: 0 });
        const current = list.querySelector('.is-current');
        current?.scrollIntoView({ block: 'nearest' });
        (window.matchMedia('(pointer: coarse)').matches ? current ?? dismiss : search).focus({ preventScroll: true });
        document.addEventListener('click', outsideClick);
        document.addEventListener('focusin', outsideFocus);
        window.addEventListener('resize', position);
        window.visualViewport?.addEventListener('resize', position);
        window.visualViewport?.addEventListener('scroll', position);
        observer = new MutationObserver(position);
        observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        void onRefresh();
    }

    return {
        toggle() { if (panel) close({ restoreFocus: true }); else open(); },
        close,
        update(next) {
            if (next.key !== state.key || next.current !== state.current) close();
            state = next;
            render();
        },
    };
}
