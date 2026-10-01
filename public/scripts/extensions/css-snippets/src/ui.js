import { copyText, download, getFileText } from '../../../utils.js';
import {
    FILTER_KEYS,
    dedupeImportedIds,
    exportFileName,
    isFilteredOut,
    isForChat,
    isForTheme,
    matchesSearch,
    parseImport,
} from './store.js';
import {
    addSnippets,
    createSnippet,
    deleteSnippet,
    exportSnippets,
    getActiveSections,
    getCtx,
    getCurrentContext,
    getSettings,
    hasNoReadableRules,
    listThemeNames,
    makeId,
    persist,
    saveSnippet,
    subscribe,
    tr,
} from './runtime.js';

const TITLE_ID = 'csss_manager_title';
const SAVE_DELAY = 350;

const FILTER_LABELS = Object.freeze({
    disabled: 'Switched off',
    theme: 'Other themes',
    thisTheme: 'This theme',
    global: 'Everywhere',
});

let popup = null;
let openPromise = null;
let root = null;
let unsubscribe = null;
let quiet = 0;
const pendingSaves = new Map();
const state = {
    query: '',
    exportMode: false,
    selected: new Set(),
    openAssignments: new Set(),
    pinnedId: null,
};

function el(tag, attributes = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
        if (value === undefined || value === null || value === false) {
            continue;
        }
        if (key === 'class') {
            node.className = value;
        } else if (key === 'text') {
            node.textContent = value;
        } else if (key === 'dataset') {
            Object.assign(node.dataset, value);
        } else if (key.startsWith('on') && typeof value === 'function') {
            node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (value === true) {
            node.setAttribute(key, '');
        } else {
            node.setAttribute(key, String(value));
        }
    }
    for (const child of [].concat(children)) {
        if (child === null || child === undefined || child === false) {
            continue;
        }
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

function icon(name) {
    return el('i', { class: `fa-solid ${name}`, 'aria-hidden': 'true' });
}

function button(label, iconName, onClick, extra = {}) {
    const { class: className = '', ...rest } = extra;
    return el('button', {
        type: 'button',
        class: `menu_button menu_button_icon csss-button ${className}`.trim(),
        onClick,
        ...rest,
    }, [iconName ? icon(iconName) : null, el('span', { text: label })]);
}

function withQuiet(fn) {
    quiet++;
    try {
        return fn();
    } finally {
        quiet--;
    }
}

function findSnippet(id) {
    return getSettings().snippetList.find(snippet => snippet.id === id);
}

function activeIds() {
    const sections = getActiveSections();
    return new Set([...sections.global, ...sections.theme, ...sections.chat].map(snippet => snippet.id));
}

function chatLabel(kind, value) {
    const ctx = getCtx();
    if (kind === 'group') {
        const group = ctx.groups?.find(item => String(item.id) === String(value));
        return group ? `${tr('Group')}: ${group.name}` : `${tr('Group')}: ${value}`;
    }
    const character = ctx.characters?.find(item => item?.avatar === value);
    return character ? character.name : value;
}

function scopeText(snippet) {
    if (snippet.isDisabled) {
        return tr('Switched off. Nothing from this snippet is applied.');
    }
    if (snippet.isGlobal) {
        return tr('Applies everywhere.');
    }
    const themes = snippet.themeList;
    const chats = [
        ...snippet.charList.map(avatar => chatLabel('char', avatar)),
        ...snippet.groupList.map(id => chatLabel('group', id)),
    ];
    if (themes.length && chats.length) {
        return `${tr('Applies when one of these themes is active in one of these chats.')} ${tr('Themes')}: ${themes.join(', ')}. ${tr('Chats')}: ${chats.join(', ')}.`;
    }
    if (themes.length) {
        return `${tr('Applies with these themes')}: ${themes.join(', ')}.`;
    }
    if (chats.length) {
        return `${tr('Applies in these chats')}: ${chats.join(', ')}.`;
    }
    return tr('Not assigned anywhere yet. Turn on Everywhere, This theme or This chat.');
}

function statusFor(snippet, active) {
    if (snippet.isDisabled) {
        return { state: 'off', label: tr('Off') };
    }
    if (active.has(snippet.id)) {
        return { state: 'live', label: tr('In use here') };
    }
    return { state: 'idle', label: tr('Not used here') };
}

function previewText(content) {
    const line = String(content ?? '').split('\n').map(text => text.trim()).find(Boolean) ?? '';
    return line.length > 90 ? `${line.slice(0, 89)}…` : (line || tr('Empty snippet'));
}

function captureFocus() {
    const active = document.activeElement;
    if (!root || !active || !root.contains(active)) {
        return null;
    }
    return active.dataset?.csssFocus ?? null;
}

function restoreFocus(key) {
    if (!key || !root) {
        return;
    }
    const target = root.querySelector(`[data-csss-focus="${CSS.escape(key)}"]`);
    if (target instanceof HTMLElement) {
        target.focus({ preventScroll: true });
    }
}

function isTypingInManager() {
    const active = document.activeElement;
    return Boolean(root && active && root.contains(active) && active.matches('input[type="text"], input[type="search"], textarea'));
}

function scheduleSave(snippet) {
    clearTimeout(pendingSaves.get(snippet.id));
    pendingSaves.set(snippet.id, setTimeout(() => {
        pendingSaves.delete(snippet.id);
        withQuiet(() => saveSnippet(snippet));
        syncAll();
    }, SAVE_DELAY));
}

function flushSaves() {
    for (const [id, timer] of pendingSaves) {
        clearTimeout(timer);
        const snippet = findSnippet(id);
        if (snippet) {
            withQuiet(() => saveSnippet(snippet));
        }
    }
    pendingSaves.clear();
}

function toggleListEntry(list, value, on) {
    const index = list.indexOf(value);
    if (on && index === -1) {
        list.push(value);
    } else if (!on && index !== -1) {
        list.splice(index, 1);
    }
}

function updateSnippet(snippet, change) {
    change(snippet);
    withQuiet(() => saveSnippet(snippet));
    renderAll();
}

function switchControl({ key, label, title, checked, disabled, onChange, snippet }) {
    const input = el('input', {
        type: 'checkbox',
        class: 'csss-switch-input',
        dataset: { csssFocus: `${snippet.id}:${key}`, csssSwitch: key },
        disabled,
        onChange: event => onChange(event.currentTarget.checked),
    });
    input.checked = checked;
    return el('label', { class: 'checkbox_label csss-switch', title }, [input, el('span', { text: label })]);
}

function buildSwitches(snippet, current) {
    const themeName = current.theme;
    const chatName = current.chatName;
    return el('div', { class: 'csss-switches', role: 'group', 'aria-label': tr('Where this snippet applies') }, [
        switchControl({
            snippet,
            key: 'on',
            label: tr('On'),
            title: tr('Switch this snippet on or off.'),
            checked: !snippet.isDisabled,
            onChange: on => updateSnippet(snippet, item => { item.isDisabled = !on; }),
        }),
        switchControl({
            snippet,
            key: 'global',
            label: tr('Everywhere'),
            title: tr('Apply with every theme and in every chat.'),
            checked: snippet.isGlobal,
            onChange: on => updateSnippet(snippet, item => { item.isGlobal = on; }),
        }),
        switchControl({
            snippet,
            key: 'theme',
            label: tr('This theme'),
            title: themeName ? `${tr('Apply while this theme is active')}: ${themeName}` : tr('No theme is active.'),
            checked: Boolean(themeName) && isForTheme(snippet, themeName),
            disabled: !themeName,
            onChange: on => updateSnippet(snippet, item => toggleListEntry(item.themeList, themeName, on)),
        }),
        switchControl({
            snippet,
            key: 'chat',
            label: tr('This chat'),
            title: current.hasChat ? `${tr('Apply in this chat')}: ${chatName}` : tr('Open a chat to use this.'),
            checked: current.hasChat && isForChat(snippet, current.chat),
            disabled: !current.hasChat,
            onChange: on => updateSnippet(snippet, item => {
                if (current.isGroup) {
                    toggleListEntry(item.groupList, current.chat.groupId, on);
                } else {
                    toggleListEntry(item.charList, current.chat.avatar, on);
                }
            }),
        }),
        switchControl({
            snippet,
            key: 'synced',
            label: tr('Share in this browser'),
            title: tr('Copy this snippet to the other user profiles that use this browser.'),
            checked: snippet.isSynced,
            onChange: on => updateSnippet(snippet, item => { item.isSynced = on; }),
        }),
    ]);
}

function buildAssignments(snippet) {
    const themes = [...new Set([...listThemeNames(), ...snippet.themeList])];
    const chats = [
        ...snippet.charList.map(value => ({ kind: 'char', value })),
        ...snippet.groupList.map(value => ({ kind: 'group', value })),
    ];
    const count = snippet.themeList.length + chats.length;
    const details = el('details', { class: 'csss-assign' });
    details.open = state.openAssignments.has(snippet.id);
    details.addEventListener('toggle', () => {
        if (details.open) {
            state.openAssignments.add(snippet.id);
        } else {
            state.openAssignments.delete(snippet.id);
        }
    });
    const summary = el('summary', {
        class: 'csss-assign-summary',
        dataset: { csssFocus: `${snippet.id}:assign` },
    }, [icon('fa-palette'), el('span', { text: `${tr('Themes and chats')} (${count})` })]);

    const themeList = themes.length
        ? el('div', { class: 'csss-assign-themes' }, themes.map(theme => {
            const input = el('input', {
                type: 'checkbox',
                dataset: { csssFocus: `${snippet.id}:theme:${theme}` },
                onChange: event => updateSnippet(snippet, item => toggleListEntry(item.themeList, theme, event.currentTarget.checked)),
            });
            input.checked = snippet.themeList.includes(theme);
            return el('label', { class: 'checkbox_label csss-assign-item' }, [input, el('span', { text: theme })]);
        }))
        : el('p', { class: 'csss-muted', text: tr('No themes found.') });

    const chatList = chats.length
        ? el('ul', { class: 'csss-assign-chats' }, chats.map(({ kind, value }) => el('li', { class: 'csss-assign-chat' }, [
            el('span', { text: chatLabel(kind, value) }),
            button(tr('Remove'), 'fa-xmark', () => updateSnippet(snippet, item => {
                toggleListEntry(kind === 'group' ? item.groupList : item.charList, value, false);
            }), { class: 'csss-small', dataset: { csssFocus: `${snippet.id}:chat:${kind}:${value}` } }),
        ])))
        : el('p', { class: 'csss-muted', text: tr('No chats assigned. Use This chat while a chat is open.') });

    details.append(
        summary,
        el('div', { class: 'csss-assign-body' }, [
            el('h4', { class: 'csss-assign-heading', text: tr('Themes') }),
            themeList,
            el('h4', { class: 'csss-assign-heading', text: tr('Chats') }),
            chatList,
        ]),
    );
    return details;
}

function moveSnippet(snippet, direction, visible) {
    const list = getSettings().snippetList;
    const position = visible.indexOf(snippet);
    const neighbour = visible[position + direction];
    if (!neighbour) {
        return;
    }
    const from = list.indexOf(snippet);
    const to = list.indexOf(neighbour);
    list[from] = neighbour;
    list[to] = snippet;
    withQuiet(() => persist('list'));
    renderAll();
}

async function confirmDelete(snippet) {
    const ctx = getCtx();
    const name = snippet.name || tr('Untitled snippet');
    const result = await ctx.Popup.show.confirm(
        `${tr('Delete')} ${name}?`,
        tr('This cannot be undone.'),
        { okButton: tr('Delete'), cancelButton: tr('Keep it') },
    );
    if (result !== ctx.POPUP_RESULT.AFFIRMATIVE) {
        restoreFocus(`${snippet.id}:delete`);
        return;
    }
    const visible = visibleSnippets();
    const index = visible.indexOf(snippet);
    const next = visible[index + 1] ?? visible[index - 1];
    clearTimeout(pendingSaves.get(snippet.id));
    pendingSaves.delete(snippet.id);
    state.selected.delete(snippet.id);
    withQuiet(() => deleteSnippet(snippet));
    renderAll();
    restoreFocus(next ? `${next.id}:name` : 'new');
}

function buildCard(snippet, { active, current, visible, index }) {
    const status = statusFor(snippet, active);
    const bodyId = `csss_body_${snippet.id}`;
    const codeId = `csss_code_${snippet.id}`;
    const nameInput = el('input', {
        type: 'text',
        class: 'text_pole csss-name',
        placeholder: tr('Untitled snippet'),
        'aria-label': tr('Snippet name'),
        dataset: { csssFocus: `${snippet.id}:name`, csssField: 'name' },
        onInput: event => {
            snippet.name = event.currentTarget.value;
            scheduleSave(snippet);
        },
    });
    nameInput.value = snippet.name;

    const fold = el('button', {
        type: 'button',
        class: 'menu_button csss-icon-button csss-fold',
        'aria-expanded': String(!snippet.isCollapsed),
        'aria-controls': bodyId,
        'aria-label': snippet.isCollapsed ? tr('Unfold snippet') : tr('Fold snippet'),
        title: snippet.isCollapsed ? tr('Unfold snippet') : tr('Fold snippet'),
        dataset: { csssFocus: `${snippet.id}:fold` },
        onClick: () => {
            snippet.isCollapsed = !snippet.isCollapsed;
            withQuiet(() => persist('settings'));
            renderAll();
        },
    }, [icon(snippet.isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down')]);

    const select = state.exportMode
        ? (() => {
            const input = el('input', {
                type: 'checkbox',
                dataset: { csssFocus: `${snippet.id}:select` },
                onChange: event => {
                    if (event.currentTarget.checked) {
                        state.selected.add(snippet.id);
                    } else {
                        state.selected.delete(snippet.id);
                    }
                    syncExportBar();
                },
            });
            input.checked = state.selected.has(snippet.id);
            return el('label', { class: 'checkbox_label csss-select' }, [input, el('span', { text: tr('Pick') })]);
        })()
        : null;

    const head = el('div', { class: 'csss-card-head' }, [
        fold,
        nameInput,
        el('span', { class: 'csss-status', dataset: { state: status.state, csssStatus: '' }, text: status.label }),
        select,
    ]);

    const preview = el('code', { class: 'csss-preview', dataset: { csssPreview: '' }, text: previewText(snippet.content) });

    const code = el('textarea', {
        id: codeId,
        class: 'text_pole monospace csss-code',
        rows: '8',
        spellcheck: 'false',
        autocapitalize: 'off',
        autocomplete: 'off',
        'aria-label': `${tr('CSS for')} ${snippet.name || tr('Untitled snippet')}`,
        placeholder: tr('Write CSS here, for example: #chat { font-size: 16px; }'),
        dataset: { csssFocus: `${snippet.id}:code`, csssField: 'content' },
    });
    code.value = snippet.content;
    globalThis.jQuery(code).on('input', () => {
        snippet.content = code.value;
        scheduleSave(snippet);
    });

    const warning = el('p', {
        class: 'csss-warning',
        role: 'status',
        dataset: { csssWarning: '' },
        hidden: !hasNoReadableRules(snippet.content),
    }, [icon('fa-triangle-exclamation'), el('span', { text: tr('The browser could not read any rules in this CSS, so nothing from it is applied. Check for a missing { or }.') })]);

    const actions = el('div', { class: 'csss-card-actions' }, [
        button(tr('Move up'), 'fa-arrow-up', () => moveSnippet(snippet, -1, visible), {
            disabled: index === 0,
            dataset: { csssFocus: `${snippet.id}:up` },
        }),
        button(tr('Move down'), 'fa-arrow-down', () => moveSnippet(snippet, 1, visible), {
            disabled: index === visible.length - 1,
            dataset: { csssFocus: `${snippet.id}:down` },
        }),
        button(tr('Bigger editor'), 'fa-maximize', null, {
            class: 'editor_maximize',
            'data-for': codeId,
            'data-tab': 'true',
            title: tr('Edit this CSS in a bigger editor'),
            dataset: { csssFocus: `${snippet.id}:max` },
        }),
        button(tr('Delete'), 'fa-trash-can', () => confirmDelete(snippet), {
            class: 'csss-danger',
            dataset: { csssFocus: `${snippet.id}:delete` },
        }),
    ]);

    const body = el('div', { class: 'csss-card-body', id: bodyId, hidden: snippet.isCollapsed }, [
        buildSwitches(snippet, current),
        el('p', { class: 'csss-scope', dataset: { csssScope: '' }, text: scopeText(snippet) }),
        code,
        warning,
        buildAssignments(snippet),
        actions,
    ]);

    return el('article', {
        class: 'csss-card',
        dataset: { id: snippet.id, state: status.state, collapsed: String(snippet.isCollapsed) },
        'aria-label': snippet.name || tr('Untitled snippet'),
    }, [head, snippet.isCollapsed ? preview : null, body]);
}

function visibleSnippets() {
    const settings = getSettings();
    const { theme } = getCurrentContext();
    return settings.snippetList.filter(snippet => snippet.id === state.pinnedId
        || (!isFilteredOut(snippet, settings.filters, theme) && matchesSearch(snippet, state.query)));
}

function renderContext() {
    const line = root?.querySelector('[data-csss-context]');
    if (!line) {
        return;
    }
    const current = getCurrentContext();
    const theme = current.theme || tr('none');
    const chat = current.hasChat ? current.chatName : tr('no chat open');
    line.textContent = `${tr('Theme')}: ${theme} · ${tr('Chat')}: ${chat}`;
}

function syncExportBar() {
    const bar = root?.querySelector('[data-csss-exportbar]');
    const toggle = root?.querySelector('[data-csss-focus="export"]');
    if (!bar || !toggle) {
        return;
    }
    bar.hidden = !state.exportMode;
    toggle.setAttribute('aria-pressed', String(state.exportMode));
    const ids = new Set(getSettings().snippetList.map(snippet => snippet.id));
    for (const id of [...state.selected]) {
        if (!ids.has(id)) {
            state.selected.delete(id);
        }
    }
    const count = state.selected.size;
    bar.querySelector('[data-csss-selected]').textContent = `${tr('Picked')}: ${count}`;
    for (const action of bar.querySelectorAll('[data-csss-needs-selection]')) {
        action.disabled = count === 0;
    }
}

function syncFoldAll() {
    const foldAll = root?.querySelector('[data-csss-focus="fold-all"]');
    if (!foldAll) {
        return;
    }
    const anyOpen = getSettings().snippetList.some(snippet => !snippet.isCollapsed);
    foldAll.querySelector('span').textContent = anyOpen ? tr('Fold all') : tr('Unfold all');
    foldAll.querySelector('i').className = `fa-solid ${anyOpen ? 'fa-compress' : 'fa-expand'}`;
}

function renderList() {
    const list = root.querySelector('[data-csss-list]');
    const count = root.querySelector('[data-csss-count]');
    const settings = getSettings();
    const visible = visibleSnippets();
    const active = activeIds();
    const current = getCurrentContext();
    list.replaceChildren(...visible.map((snippet, index) => buildCard(snippet, { active, current, visible, index })));
    if (!settings.snippetList.length) {
        list.append(el('p', { class: 'csss-empty', text: tr('No snippets yet. Add one, or paste CSS or a snippet file anywhere in this window to import it.') }));
    } else if (!visible.length) {
        list.append(el('p', { class: 'csss-empty', text: tr('No snippets match. Clear the search or the Hide buttons.') }));
    }
    const liveCount = settings.snippetList.filter(snippet => active.has(snippet.id)).length;
    count.textContent = `${tr('Showing')} ${visible.length} / ${settings.snippetList.length} · ${tr('In use here')}: ${liveCount}`;
}

function renderFilters() {
    const filters = getSettings().filters;
    for (const chip of root.querySelectorAll('[data-csss-filter]')) {
        chip.setAttribute('aria-pressed', String(Boolean(filters[chip.dataset.csssFilter])));
    }
}

function renderAll() {
    if (!root) {
        return;
    }
    const focusKey = captureFocus();
    const scroller = root.querySelector('[data-csss-scroll]');
    const scrollTop = scroller?.scrollTop ?? 0;
    const rootScrollTop = root.scrollTop;
    renderContext();
    renderFilters();
    renderList();
    syncExportBar();
    syncFoldAll();
    if (scroller) {
        scroller.scrollTop = scrollTop;
    }
    root.scrollTop = rootScrollTop;
    restoreFocus(focusKey);
}

/**
 * Updates cards in place without rebuilding them, so typing keeps its caret.
 */
function syncAll() {
    if (!root) {
        return;
    }
    const active = activeIds();
    const current = getCurrentContext();
    const focused = document.activeElement;
    renderContext();
    for (const card of root.querySelectorAll('.csss-card')) {
        const snippet = findSnippet(card.dataset.id);
        if (!snippet) {
            continue;
        }
        const status = statusFor(snippet, active);
        card.dataset.state = status.state;
        const pill = card.querySelector('[data-csss-status]');
        pill.dataset.state = status.state;
        pill.textContent = status.label;
        for (const field of card.querySelectorAll('[data-csss-field]')) {
            const value = snippet[field.dataset.csssField] ?? '';
            if (field !== focused && field.value !== value) {
                field.value = value;
            }
        }
        const switches = {
            on: !snippet.isDisabled,
            global: snippet.isGlobal,
            theme: Boolean(current.theme) && isForTheme(snippet, current.theme),
            chat: current.hasChat && isForChat(snippet, current.chat),
            synced: snippet.isSynced,
        };
        for (const input of card.querySelectorAll('[data-csss-switch]')) {
            input.checked = Boolean(switches[input.dataset.csssSwitch]);
        }
        const scope = card.querySelector('[data-csss-scope]');
        if (scope) {
            scope.textContent = scopeText(snippet);
        }
        const warning = card.querySelector('[data-csss-warning]');
        if (warning) {
            warning.hidden = !hasNoReadableRules(snippet.content);
        }
        const preview = card.querySelector('[data-csss-preview]');
        if (preview) {
            preview.textContent = previewText(snippet.content);
        }
        const code = card.querySelector('.csss-code');
        code?.setAttribute('aria-label', `${tr('CSS for')} ${snippet.name || tr('Untitled snippet')}`);
        card.setAttribute('aria-label', snippet.name || tr('Untitled snippet'));
    }
}

async function importText(text) {
    const settings = getSettings();
    const incoming = dedupeImportedIds(settings.snippetList, parseImport(text, { makeId }), makeId);
    if (!incoming.length) {
        toastr.info(tr('There was nothing to import.'));
        return;
    }
    withQuiet(() => addSnippets(incoming));
    state.pinnedId = incoming[0].id;
    renderAll();
    toastr.success(`${tr('Imported snippets')}: ${incoming.length}`);
}

async function importFiles(files) {
    for (const file of files) {
        try {
            await importText(await getFileText(file));
        } catch (error) {
            console.error('[CSS Snippets] import failed:', error);
            toastr.error(`${tr('Could not import')} ${file.name}`);
        }
    }
}

function selectedSnippets() {
    return getSettings().snippetList.filter(snippet => state.selected.has(snippet.id));
}

function buildShell() {
    const filters = el('div', { class: 'csss-filters', role: 'group', 'aria-labelledby': 'csss_filters_label' }, [
        el('span', { id: 'csss_filters_label', class: 'csss-filters-label', text: tr('Hide') }),
        ...FILTER_KEYS.map(key => el('button', {
            type: 'button',
            class: 'csss-chip',
            'aria-pressed': 'false',
            dataset: { csssFilter: key, csssFocus: `filter:${key}` },
            onClick: () => {
                const settings = getSettings();
                settings.filters[key] = !settings.filters[key];
                withQuiet(() => persist('settings'));
                renderAll();
            },
        }, [el('span', { text: tr(FILTER_LABELS[key]) })])),
    ]);

    const fileInput = el('input', {
        type: 'file',
        class: 'csss-file',
        accept: '.json,.css,.txt,application/json,text/css,text/plain',
        multiple: true,
        hidden: true,
        tabindex: '-1',
        'aria-hidden': 'true',
        onChange: async event => {
            const input = event.currentTarget;
            const files = Array.from(input.files ?? []);
            input.value = '';
            await importFiles(files);
        },
    });

    const search = el('input', {
        type: 'search',
        id: 'csss_search',
        class: 'text_pole csss-search',
        placeholder: tr('Search snippets'),
        autocomplete: 'off',
        'aria-describedby': 'csss_search_hint',
        dataset: { csssFocus: 'search' },
        onInput: event => {
            state.query = event.currentTarget.value;
            state.pinnedId = null;
            renderList();
            syncFoldAll();
        },
    });
    search.value = state.query;

    const exportBar = el('div', { class: 'csss-exportbar', hidden: true, dataset: { csssExportbar: '' } }, [
        el('span', { class: 'csss-exportbar-count', 'aria-live': 'polite', dataset: { csssSelected: '' } }),
        button(tr('Pick all shown'), 'fa-check-double', () => {
            for (const snippet of visibleSnippets()) {
                state.selected.add(snippet.id);
            }
            renderAll();
        }, { dataset: { csssFocus: 'pick-all' } }),
        button(tr('Clear'), 'fa-eraser', () => {
            state.selected.clear();
            renderAll();
        }, { dataset: { csssFocus: 'pick-clear' } }),
        button(tr('Copy'), 'fa-copy', async () => {
            await copyText(exportSnippets(selectedSnippets()));
            toastr.success(`${tr('Copied snippets')}: ${state.selected.size}`);
        }, { dataset: { csssFocus: 'copy', csssNeedsSelection: '' } }),
        button(tr('Download'), 'fa-download', () => {
            download(exportSnippets(selectedSnippets()), exportFileName(), 'application/json');
        }, { dataset: { csssFocus: 'download', csssNeedsSelection: '' } }),
    ]);

    const shell = el('section', { class: 'csss-manager' }, [
        el('header', { class: 'csss-head' }, [
            el('h2', { id: TITLE_ID, class: 'csss-title' }, [icon('fa-list-check'), el('span', { text: tr('CSS Snippets') })]),
            el('p', { class: 'csss-intro', text: tr('Small pieces of CSS you can switch on and off for every theme, one theme, or one chat. When two snippets set the same thing, the lower one wins.') }),
            el('p', { class: 'csss-context', 'aria-live': 'polite', dataset: { csssContext: '' } }),
        ]),
        el('div', { class: 'csss-tools' }, [
            el('div', { class: 'csss-search-row' }, [
                el('label', { class: 'csss-visually-hidden', for: 'csss_search', text: tr('Search snippets') }),
                search,
                el('small', { id: 'csss_search_hint', class: 'csss-muted', text: tr('Searches names, CSS and themes. Start with name:, css: or theme: to search one of them.') }),
            ]),
            el('div', { class: 'csss-actions' }, [
                button(tr('New snippet'), 'fa-plus', () => {
                    const snippet = withQuiet(() => createSnippet({ name: '' }));
                    state.pinnedId = snippet.id;
                    renderAll();
                    restoreFocus(`${snippet.id}:name`);
                }, { class: 'csss-primary', dataset: { csssFocus: 'new' } }),
                button(tr('Import'), 'fa-file-import', () => fileInput.click(), {
                    title: tr('Import a snippet file or a .css file. You can also paste one anywhere in this window.'),
                    dataset: { csssFocus: 'import' },
                }),
                button(tr('Export'), 'fa-file-export', () => {
                    state.exportMode = !state.exportMode;
                    renderAll();
                }, { 'aria-pressed': 'false', dataset: { csssFocus: 'export' } }),
                button(tr('Fold all'), 'fa-compress', () => {
                    const list = getSettings().snippetList;
                    const collapse = list.some(snippet => !snippet.isCollapsed);
                    for (const snippet of list) {
                        snippet.isCollapsed = collapse;
                    }
                    withQuiet(() => persist('settings'));
                    renderAll();
                }, { dataset: { csssFocus: 'fold-all' } }),
            ]),
            filters,
            exportBar,
            fileInput,
        ]),
        el('div', { class: 'csss-scroll', dataset: { csssScroll: '' } }, [
            el('p', { class: 'csss-count', 'aria-live': 'polite', dataset: { csssCount: '' } }),
            el('div', { class: 'csss-list', dataset: { csssList: '' } }),
        ]),
    ]);

    shell.addEventListener('paste', event => {
        const target = /** @type {HTMLElement} */ (event.target);
        if (target?.closest?.('input, textarea, [contenteditable]')) {
            return;
        }
        const text = event.clipboardData?.getData('text') ?? '';
        if (!text.trim()) {
            return;
        }
        event.preventDefault();
        importText(text);
    });

    return shell;
}

function onExternalChange() {
    if (quiet || !root) {
        return;
    }
    if (isTypingInManager()) {
        syncAll();
    } else {
        renderAll();
    }
}

/**
 * @param {HTMLElement} [opener]
 */
export function openManager(opener) {
    if (popup) {
        root?.querySelector('#csss_search')?.focus();
        return openPromise;
    }
    const ctx = getCtx();
    const returnFocus = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    state.exportMode = false;
    state.selected.clear();
    state.pinnedId = null;
    root = buildShell();
    renderAll();
    unsubscribe = subscribe(onExternalChange);

    popup = new ctx.Popup(root, ctx.POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: false,
        okButton: tr('Close'),
    });
    popup.dlg.classList.add('csss-dialog');
    popup.dlg.setAttribute('aria-labelledby', TITLE_ID);

    openPromise = (async () => {
        try {
            await popup.show();
        } finally {
            flushSaves();
            unsubscribe?.();
            unsubscribe = null;
            popup = null;
            root = null;
            openPromise = null;
            if (returnFocus?.isConnected) {
                returnFocus.focus();
            }
        }
    })();
    return openPromise;
}

export async function closeManager() {
    if (!popup) {
        return;
    }
    const pending = openPromise;
    await popup.completeCancelled();
    await pending;
}
