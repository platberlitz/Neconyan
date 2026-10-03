import { characters, getCurrentChatId, this_chid } from '../../script.js';
import { selected_group } from '../group-chats.js';
import { getCurrentUserHandle } from '../user.js';
import { accountStorage } from '../util/AccountStorage.js';
import { loadStylesheetAsync } from '../dynamic-styles.js';
import { getAssistantIconSrc } from '../neconyan-assistant-art.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../popup.js';
import { attachmentUrl, newOperationId, notesRequest, subscribeNotes } from './api.js';
import { append, button, clear, debounce, formatTime, h } from './dom.js';
import { clearDraft, readDraft, saveDraft } from './drafts.js';
import { headingOutline, renderNoteInto } from './render.js';
import { formatDiff } from './line-diff.js';

const PREFS_KEY = 'neconyan_notes_prefs';
const NOTES_STYLESHEET = 'css/neconyan-notes.css?v=13';
const TOOL_PAGES_STYLESHEET = 'css/neconyan-tool-pages.css?v=20261003-notes-tour1';
const TOUR_PAGE_KEY = 'notes';
const SAVE_DELAY_MS = 1200;
const MAX_RETRY_MS = 60_000;
const PHONE_QUERY = '(max-width: 768px)';
const STATUS_TEXT = Object.freeze({
    idle: '',
    saved: 'Saved on server',
    saving: 'Saving',
    device: 'Saved on this device only',
    conflict: 'Conflict',
    error: 'Could not save',
});

const lf = text => String(text ?? '').replace(/\r\n?/g, '\n');
const isPhone = () => globalThis.matchMedia?.(PHONE_QUERY).matches === true;
const toast = (kind, message) => globalThis.toastr?.[kind]?.(message);

function readPrefs() {
    try {
        const value = JSON.parse(accountStorage.getItem(PREFS_KEY) ?? '{}');
        return value && typeof value === 'object' ? value : {};
    } catch {
        return {};
    }
}

function writePrefs(patch) {
    try {
        const next = { ...readPrefs(), ...patch };
        const positions = Object.entries(next.positions ?? {}).slice(-50);
        next.positions = Object.fromEntries(positions);
        accountStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
        /* preferences are a convenience; ignore storage failures */
    }
}

/** The chat scope ids used by note context policies, matching the server's roleplay locator. */
export function currentChatScope() {
    const chat = getCurrentChatId();
    if (!chat) return null;
    if (selected_group) return { chat: `group:${chat}`, character: null, label: 'This group chat' };
    const avatar = characters?.[this_chid]?.avatar;
    if (!avatar) return null;
    return { chat: `${avatar}:${chat}`, character: avatar, label: 'This chat', characterName: characters[this_chid].name };
}

const app = {
    state: {
        account: null,
        built: false,
        tourMounted: false,
        open: false,
        notebooks: [],
        importStages: [],
        notebookId: null,
        notebookSelectionVersion: 0,
        noteRequestVersion: 0,
        notebookListVersion: 0,
        notebookListAppliedVersion: 0,
        treeRequestVersion: 0,
        readerRequestVersion: 0,
        tree: null,
        folder: null,
        list: { notes: [], total: 0, offset: 0 },
        searchQuery: '',
        search: null,
        note: null,
        dirty: false,
        saveConflict: false,
        status: 'idle',
        pending: null,
        saving: false,
        retryMs: 0,
        saveTimer: null,
        layout: 'full',
        pane: 'note',
        detailsTab: 'properties',
        view: 'write',
        workspaceView: 'note',
        workspaceVersion: 0,
        back: [],
        unsubscribe: null,
        remoteChanged: false,
    },
    elements: {},
    panels: null,
    editorModule: null,
    sourceEditor: null,
    dialogs: null,
    graphModule: null,
    graphView: null,
    tableModule: null,
    tableView: null,
    canvasModule: null,
    canvasView: null,
};

/* ---------- requests and account guard ---------- */

function accountChanged() {
    const handle = getCurrentUserHandle();
    if (app.state.account && handle !== app.state.account) {
        resetForAccount(handle);
        return true;
    }
    app.state.account = handle;
    return false;
}

function resetForAccount(handle) {
    const { state } = app;
    clearTimeout(state.saveTimer);
    state.notebookSelectionVersion++;
    state.noteRequestVersion++;
    state.treeRequestVersion++;
    state.workspaceVersion++;
    app.graphView?.clear();
    app.tableView?.clear();
    app.canvasView?.clear();
    Object.assign(state, { account: handle, notebooks: [], importStages: [], notebookId: null, tree: null, note: null, dirty: false,
        saveConflict: false, pending: null, saving: false, back: [], search: null, status: 'idle', workspaceView: 'note' });
    if (state.built) {
        renderEditor();
        void loadNotebooks();
    }
}

async function request(route, body = {}) {
    if (accountChanged()) return { status: 'cancelled', message: 'The signed-in account changed.' };
    const account = app.state.account;
    const result = await notesRequest(route, body);
    if (getCurrentUserHandle() !== account) return { status: 'cancelled', message: 'The signed-in account changed.' };
    return result;
}

function failed(result, fallback = 'That did not work.') {
    if (!result || result.status === 'success' || result.status === 'no_change') return false;
    if (result.status !== 'cancelled') toast('error', result.message || fallback);
    return true;
}

/* ---------- shell ---------- */

function buildRoot() {
    const { elements, state } = app;
    elements.status = h('span', { class: 'notes-status', role: 'status', 'aria-live': 'polite' });
    elements.title = h('input', { class: 'text_pole notes-title-input', type: 'text', 'aria-label': 'Note name', maxlength: '160',
        placeholder: 'Untitled', onchange: () => void renameFromTitle() });
    elements.banner = h('div', { class: 'notes-banners' });
    elements.source = h('div', { class: 'notes-source' });
    app.sourceEditor = app.editorModule.createNotesEditor(elements.source, {
        onChange: onEditorInput, onKeyDown: onEditorKeydown, onScroll: debounce(rememberPosition, 400),
        onSelect: rememberPosition, onBlur: hideSuggest, onFolds: rememberFolds,
        onComposition: composing => {
            renderFoldControls();
            if (!composing && app.state.dirty && !app.state.saveConflict) scheduleSave();
        },
    });
    elements.textarea = app.sourceEditor.adapter;
    elements.foldControls = h('div', { class: 'notes-fold-controls' });
    elements.foldSections = h('div', { class: 'notes-fold-sections', hidden: true });
    elements.reader = h('div', { class: 'notes-reader', tabindex: '0', onclick: onReaderClick });
    elements.suggest = h('ul', { class: 'notes-suggest', role: 'listbox', 'aria-label': 'Link suggestions', hidden: true });
    elements.outline = h('div', { class: 'notes-outline' });
    elements.toolbar = buildToolbar();
    elements.viewTabs = h('div', { class: 'notes-choice-group notes-view-tabs', role: 'group', 'aria-label': 'Editor view' });
    elements.editorBody = h('div', { class: 'notes-editor-body' }, elements.source, elements.reader, elements.suggest);
    elements.empty = h('div', { class: 'notes-empty' });
    elements.editor = h('div', { class: 'notes-editor', hidden: true },
        h('div', { class: 'notes-editor-head' }, elements.title, elements.status),
        elements.banner, elements.viewTabs, elements.toolbar, elements.foldControls, elements.foldSections, elements.editorBody);
    elements.graph = h('section', { class: 'notes-graph', 'aria-label': 'Notebook graph', hidden: true });
    elements.propertyTable = h('section', { class: 'notes-table-view', 'aria-label': 'Notebook property table', hidden: true });
    elements.canvas = h('section', { class: 'notes-canvas-view', 'aria-label': 'Notebook planning canvases', hidden: true });
    elements.editorPane = h('section', { class: 'notes-pane notes-pane-editor', 'aria-label': 'Note' }, elements.empty, elements.editor, elements.graph, elements.propertyTable, elements.canvas);
    elements.nav = h('nav', { class: 'notes-pane notes-pane-nav', 'aria-label': 'Notebooks and notes' });
    elements.details = h('aside', { class: 'notes-pane notes-pane-details', 'aria-label': 'Note details' });
    elements.paneTabs = h('div', { class: 'notes-choice-group notes-pane-tabs', role: 'group', 'aria-label': 'Notes sections' });
    elements.back = button('Back', () => void goBack(), { icon: 'fa-arrow-left', className: 'notes-back', title: 'Back to the previous note' });
    elements.layoutButton = button('Beside chat', () => setLayout(state.layout === 'beside' ? 'full' : 'beside'), { icon: 'fa-table-columns', className: 'notes-layout-toggle' });
    elements.close = button('Back to chat', () => hide(), { icon: 'fa-comments', className: 'notes-close' });
    elements.resizer = h('div', { class: 'notes-resizer', role: 'separator', 'aria-orientation': 'vertical', tabindex: '0',
        'aria-label': 'Resize notes panel', onpointerdown: startResize, onkeydown: resizeByKey });
    elements.header = h('header', { class: 'notes-header' },
        h('h2', { class: 'notes-heading' }, h('i', { class: 'fa-solid fa-book-open', 'aria-hidden': 'true' }), h('span', { text: 'Notes' })),
        elements.back, h('span', { class: 'notes-spacer' }),
        elements.layoutButton, elements.close);
    elements.intro = h('div', { class: 'notes-intro' });
    elements.root = h('section', { id: 'neconyan-notes', class: 'notes-app', 'aria-label': 'Notes', hidden: true },
        elements.resizer, elements.header, elements.intro, elements.paneTabs,
        h('div', { class: 'notes-columns' }, elements.nav, elements.editorPane, elements.details));
    document.body.append(elements.root);
    globalThis.matchMedia?.(PHONE_QUERY).addEventListener?.('change', () => applyLayout());
    state.built = true;
}

/** Miso's guided tour lives in the shared tool-tour module; Notes only hosts its introduction strip. */
async function mountTour() {
    const { elements, state } = app;
    if (state.tourMounted || !elements.intro) return;
    state.tourMounted = true;
    try {
        await loadStylesheetAsync(TOOL_PAGES_STYLESHEET, { id: 'deferred-tool-pages-css' }).catch(() => null);
        const tour = await import('../neconyan-tool-tour.js');
        tour.mountToolPage(TOUR_PAGE_KEY, elements.intro, elements.root);
    } catch (error) {
        state.tourMounted = false;
        console.warn('[Neconyan] Notes tour could not be prepared', error);
    }
}

function renderPaneTabs() {
    const { elements, state } = app;
    clear(elements.paneTabs);
    for (const [pane, label, icon] of [['nav', 'Notebooks', 'fa-book'], ['note', 'Note', 'fa-pen-nib'], ['details', 'Details', 'fa-circle-info']]) {
        if (pane === 'details' && state.workspaceView === 'canvas') continue;
        const tab = button(label, () => setPane(pane), { icon, className: 'notes-choice', pressed: state.pane === pane });
        tab.dataset.pane = pane;
        elements.paneTabs.append(tab);
    }
}

function setPane(pane) {
    app.state.pane = pane;
    applyLayout();
    if (pane === 'details') app.panels?.renderDetails(app);
}

function applyLayout() {
    const { elements, state } = app;
    if (!elements.root) return;
    const phone = isPhone();
    const beside = !phone && state.layout === 'beside';
    elements.root.dataset.layout = phone ? 'phone' : state.layout;
    elements.root.dataset.pane = state.pane;
    document.body.classList.toggle('neconyan-notes-beside', state.open && beside);
    document.body.classList.toggle('neconyan-notes-open', state.open);
    elements.layoutButton.hidden = phone;
    const label = elements.layoutButton.querySelector('span');
    if (label) label.textContent = state.layout === 'beside' ? 'Full width' : 'Beside chat';
    elements.layoutButton.setAttribute('aria-label', state.layout === 'beside' ? 'Show notes at full width' : 'Show notes beside the chat');
    elements.resizer.hidden = !beside;
    elements.paneTabs.hidden = !(phone || beside);
    elements.back.hidden = state.back.length === 0;
    renderPaneTabs();
    const width = Number(readPrefs().width) || 440;
    document.body.style.setProperty('--neco-notes-beside-width', `${clampWidth(width)}px`);
}

function clampWidth(width) {
    return Math.max(320, Math.min(width, Math.max(320, (globalThis.innerWidth || 1280) - 360)));
}

function setLayout(layout) {
    app.state.layout = layout === 'beside' ? 'beside' : 'full';
    writePrefs({ layout: app.state.layout });
    applyLayout();
}

function startResize(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    const move = moveEvent => {
        const width = clampWidth((globalThis.innerWidth || 1280) - moveEvent.clientX);
        document.body.style.setProperty('--neco-notes-beside-width', `${width}px`);
    };
    const end = endEvent => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', end);
        target.removeEventListener('pointercancel', end);
        writePrefs({ width: clampWidth((globalThis.innerWidth || 1280) - endEvent.clientX) });
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
}

function resizeByKey(event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const width = clampWidth((Number(readPrefs().width) || 440) + (event.key === 'ArrowLeft' ? 32 : -32));
    writePrefs({ width });
    document.body.style.setProperty('--neco-notes-beside-width', `${width}px`);
}

/* ---------- open / hide ---------- */

async function ensureModules() {
    if (!app.panels) app.panels = await import('./notes-panels.js');
    if (!app.dialogs) app.dialogs = await import('./notes-dialogs.js');
    if (!app.editorModule) app.editorModule = await import('../../notes-editor.js');
}

export async function openNotes(options = {}) {
    const { state } = app;
    await loadStylesheetAsync(NOTES_STYLESHEET, { id: 'neconyan-notes-css' }).catch(() => null);
    await ensureModules();
    if (!state.built) buildRoot();
    void mountTour();
    accountChanged();
    const prefs = readPrefs();
    if (!state.open) state.layout = options.layout ?? (prefs.layout === 'beside' ? 'beside' : 'full');
    if (options.layout) state.layout = options.layout;
    state.open = true;
    app.elements.root.hidden = false;
    if (isPhone()) globalThis.NeconyanShell?.closeWorkspace?.();
    if (!state.unsubscribe) state.unsubscribe = subscribeNotes(onRemoteChange);
    if (!state.notebooks.length) await loadNotebooks(options.notebookId ?? prefs.notebookId);
    else if (options.notebookId && options.notebookId !== state.notebookId) await selectNotebook(options.notebookId);
    const noteId = options.noteId ?? (!state.note ? prefs.noteId : null);
    if (noteId && state.notebookId) await openNote(state.notebookId, noteId, { quiet: !options.noteId });
    state.pane = state.note ? 'note' : 'nav';
    applyLayout();
    renderEditor();
    return app;
}

export function hideNotes() {
    if (!notebookCanvasCanLeave()) return;
    const { state, elements } = app;
    if (!state.open) return;
    if (state.dirty) void flushSave();
    state.open = false;
    if (elements.root) elements.root.hidden = true;
    applyLayout();
}

const hide = hideNotes;

/** Another workspace was chosen in the rail: a full-width Notes view gives way, a side panel stays. */
export function onWorkspaceRoute(route) {
    if (route === 'notes') return;
    if (app.state.open && (app.state.layout === 'full' || isPhone())) hideNotes();
}

/* ---------- notebooks, tree and lists ---------- */

async function loadNotebooks(preferred) {
    const { state } = app;
    const listVersion = ++state.notebookListVersion;
    const selectionVersion = preferred ? ++state.notebookSelectionVersion : state.notebookSelectionVersion;
    const result = await request('/list');
    if (failed(result, 'Notes could not load your notebooks.')) return;
    if (listVersion >= state.notebookListAppliedVersion) {
        state.notebookListAppliedVersion = listVersion;
        state.notebooks = result.notebooks ?? [];
        state.importStages = result.imports ?? [];
    }
    // A background notification or older request never changes a newer user choice.
    if (selectionVersion !== state.notebookSelectionVersion) { renderNav(); return; }
    const chosen = state.notebooks.find(item => item.id === preferred)
        ?? state.notebooks.find(item => item.id === state.notebookId) ?? state.notebooks[0];
    if (chosen?.id === state.notebookId) await refreshTree();
    else if (chosen) await selectNotebook(chosen.id, { selectionVersion });
    else renderNav();
}

async function selectNotebook(notebookId, { selectionVersion = null, noteRequestVersion = null } = {}) {
    if (app.sourceEditor?.composing || !notebookCanvasCanLeave()) return false;
    const { state } = app;
    selectionVersion ??= ++state.notebookSelectionVersion;
    if (noteRequestVersion === null) state.noteRequestVersion = (state.noteRequestVersion ?? 0) + 1;
    else if (noteRequestVersion !== state.noteRequestVersion) return;
    const noteVersion = state.noteRequestVersion;
    if (state.dirty) await flushSave();
    if (selectionVersion !== state.notebookSelectionVersion || noteVersion !== state.noteRequestVersion) return;
    if (state.notebookId !== notebookId) {
        state.workspaceView = 'note';
        state.workspaceVersion++;
        app.graphView?.clear();
        app.tableView?.clear();
        app.canvasView?.clear();
        state.note = null;
        state.folder = null;
        state.search = null;
        state.searchQuery = '';
    }
    state.notebookId = notebookId;
    writePrefs({ notebookId });
    await refreshTree();
    if (selectionVersion !== state.notebookSelectionVersion || state.notebookId !== notebookId || noteVersion !== state.noteRequestVersion) return;
    renderEditor();
}

async function refreshTree() {
    const { state } = app;
    if (!state.notebookId) return;
    const notebookId = state.notebookId;
    const requestVersion = ++state.treeRequestVersion;
    const [tree, list] = await Promise.all([
        request('/tree', { notebookId }),
        request('/notes/list', { notebookId, folder: state.folder, offset: state.list.offset, limit: 200 }),
    ]);
    if (state.notebookId !== notebookId || requestVersion !== state.treeRequestVersion) return;
    if (tree.status === 'not_found') {
        state.notebookId = null;
        return loadNotebooks();
    }
    if (failed(tree) || failed(list)) return;
    state.tree = tree;
    state.list = { notes: list.notes ?? [], total: list.total ?? 0, offset: list.offset ?? 0 };
    if (state.searchQuery) await runSearch(state.searchQuery);
    renderNav();
}

const searchSoon = debounce(query => void runSearch(query), 300);

async function runSearch(query) {
    const { state } = app;
    state.searchQuery = query;
    if (!query.trim()) {
        state.search = null;
        renderNav();
        return;
    }
    const notebookId = state.notebookId;
    const result = await request('/search', { notebookId, query, limit: 50 });
    if (failed(result)) return;
    if (state.searchQuery !== query || state.notebookId !== notebookId) return;
    state.search = result;
    renderNav();
}

function noteButton(summary, extra = null) {
    const current = app.state.note?.id === summary.id;
    return h('li', { class: 'notes-list-item' },
        h('button', { type: 'button', class: `notes-note-link${current ? ' is-current' : ''}`, 'aria-current': current ? 'true' : null,
            onclick: () => void openNote(app.state.notebookId, summary.id, { pushBack: true }) },
        h('span', { class: 'notes-note-title', text: summary.title || 'Untitled' }),
        h('span', { class: 'notes-note-meta', text: [summary.folder || 'Top level', summary.favourite ? 'Favourite' : '', formatTime(summary.updatedAt)].filter(Boolean).join(' · ') }),
        extra));
}

function section(title, ...children) {
    return h('section', { class: 'notes-nav-section' }, h('h3', { class: 'notes-nav-heading', text: title }), ...children);
}

/** Tags a nav section so the tour and styles can find it after the list is rebuilt. */
function keyed(key, node) {
    node.dataset.section = key;
    return node;
}

function renderNav() {
    const { elements, state } = app;
    const nav = elements.nav;
    if (!nav) return;
    const keepFocus = document.activeElement?.classList?.contains('notes-search-input');
    clear(nav);
    const notebookRow = h('div', { class: 'notes-notebook-row', role: 'group', 'aria-label': 'Notebooks' });
    for (const notebook of state.notebooks) {
        notebookRow.append(button(notebook.name, () => void selectNotebook(notebook.id), {
            className: 'notes-choice notes-notebook', pressed: notebook.id === state.notebookId,
            title: `${notebook.name} (${notebook.noteCount} notes${notebook.origin === 'import' ? ', imported' : ''})`,
        }));
    }
    notebookRow.append(button('New notebook', () => void app.dialogs.newNotebook(app), { icon: 'fa-plus', className: 'notes-quiet' }));
    nav.append(keyed('notebooks', section('Notebooks', notebookRow)));
    if (!state.notebookId) {
        nav.append(keyed('empty', h('p', { class: 'notes-hint notes-nav-empty', text: 'Notebooks hold your notes. Make one to start writing.' })));
        return;
    }
    const search = h('input', { type: 'search', class: 'text_pole notes-search-input', placeholder: 'Search titles and text',
        'aria-label': 'Search notes', value: state.searchQuery, oninput: event => searchSoon(event.target.value) });
    nav.append(keyed('create', h('div', { class: 'notes-nav-actions notes-create-row' },
        button('New note', () => void app.dialogs.newNote(app), { icon: 'fa-file-circle-plus', className: 'notes-primary' }),
        button('Quick note', () => void app.dialogs.quickNote(app), { icon: 'fa-bolt' }))),
    keyed('search', h('div', { class: 'notes-search' }, h('i', { class: 'fa-solid fa-magnifying-glass notes-search-icon', 'aria-hidden': 'true' }), search)));
    if (keepFocus) queueMicrotask(() => { search.focus(); search.setSelectionRange(search.value.length, search.value.length); });
    if (state.search) {
        const list = h('ul', { class: 'notes-list' });
        for (const result of state.search.results ?? []) {
            list.append(noteButton(result, result.snippet ? h('span', { class: 'notes-snippet', text: `${result.exact ? '' : 'Close match: '}${result.snippet}` }) : null));
        }
        nav.append(section(`Search results (${state.search.total})`, state.search.total ? list : h('p', { class: 'notes-hint', text: 'Nothing matched. Try fewer words.' })));
        return;
    }
    const tree = state.tree;
    if (tree?.origin === 'import' && tree.policy?.admitted === false) {
        nav.append(h('p', { class: 'notes-notice', text: 'Imported notebook: assistants and chat context cannot use it until you allow that under AI access.' }));
    }
    if (tree?.favourites?.length) {
        const list = h('ul', { class: 'notes-list' }, ...tree.favourites.slice(0, 20).map(note => noteButton(note)));
        nav.append(section('Favourites', list));
    }
    if (tree?.recent?.length && !state.folder) {
        const list = h('ul', { class: 'notes-list' }, ...tree.recent.slice(0, 8).map(note => noteButton(note)));
        nav.append(section('Recent', list));
    }
    const folders = h('div', { class: 'notes-folder-row', role: 'group', 'aria-label': 'Folders' });
    folders.append(button(`All notes (${tree?.noteCount ?? 0})`, () => void chooseFolder(null), { className: 'notes-choice', pressed: state.folder === null }));
    folders.append(button(`Top level (${tree?.rootCount ?? 0})`, () => void chooseFolder(''), { className: 'notes-choice', pressed: state.folder === '' }));
    for (const folder of tree?.folders ?? []) {
        folders.append(button(`${folder.path} (${folder.count})`, () => void chooseFolder(folder.path), { className: 'notes-choice', pressed: state.folder === folder.path }));
    }
    nav.append(keyed('folders', section('Folders', folders, h('div', { class: 'notes-nav-actions' },
        button('New folder', () => void app.dialogs.newFolder(app), { icon: 'fa-folder-plus', className: 'notes-quiet' }),
        state.folder ? button('Rename folder', () => void app.dialogs.renameFolder(app, state.folder), { icon: 'fa-pen', className: 'notes-quiet' }) : null,
        state.folder ? button('Remove empty folder', () => void app.dialogs.deleteFolder(app, state.folder), { icon: 'fa-folder-minus', className: 'notes-quiet' }) : null))));
    const list = h('ul', { class: 'notes-list' }, ...state.list.notes.map(note => noteButton(note)));
    const more = state.list.total > state.list.offset + state.list.notes.length
        ? button('Show more', () => void pageList(200), { className: 'notes-quiet' }) : null;
    const less = state.list.offset > 0 ? button('Show earlier', () => void pageList(-200), { className: 'notes-quiet' }) : null;
    nav.append(keyed('list', section(state.folder === null ? 'All notes' : state.folder || 'Top level',
        state.list.notes.length ? list : h('p', { class: 'notes-hint', text: 'No notes here yet. New note starts one.' }),
        h('div', { class: 'notes-nav-actions' }, less, more))));
    const tool = (label, onClick, icon, className = '') => button(label, onClick, { icon, className: `notes-notebook-tool ${className}`.trim() });
    nav.append(keyed('views', section('Notebook views', h('div', { class: 'notes-notebook-tools' },
        tool('Graph', () => void openNotebookGraph(), 'fa-diagram-project', 'notes-graph-open'),
        tool('Property table', () => void openNotebookTable(), 'fa-table', 'notes-table-open'),
        tool('Canvas', () => void openNotebookCanvas(), 'fa-object-group', 'notes-canvas-open')))));
    nav.append(keyed('tools', section('Notebook', h('div', { class: 'notes-notebook-tools' },
        tool('Obsidian sync', () => void app.dialogs.obsidianSync(app), 'fa-arrows-rotate', 'notes-quiet'),
        tool(`Trash (${tree?.trashCount ?? 0})`, () => void app.dialogs.trash(app), 'fa-trash-can', 'notes-quiet'),
        tool('Assistant changes', () => void app.dialogs.proposals(app), 'fa-wand-magic-sparkles', 'notes-quiet'),
        tool('Import', () => void app.dialogs.importNotes(app), 'fa-file-import', 'notes-quiet'),
        state.importStages.length ? tool('Unfinished imports', () => void app.dialogs.unfinishedImports(app), 'fa-arrow-rotate-right', 'notes-quiet') : null,
        tool('Export', () => void app.dialogs.exportNotebook(app), 'fa-file-export', 'notes-quiet'),
        tool('Rename notebook', () => void app.dialogs.renameNotebook(app), 'fa-pen', 'notes-quiet'),
        tool('Check notebook', () => void app.dialogs.diagnostics(app), 'fa-stethoscope', 'notes-quiet')))));
    if (tree?.skipped?.length) {
        nav.append(h('p', { class: 'notes-notice', text: `${tree.skipped.length} file(s) in this notebook folder were left alone because Notes cannot read them safely.` }));
    }
}

async function chooseFolder(folder) {
    app.state.folder = folder;
    app.state.list.offset = 0;
    await refreshTree();
}

async function pageList(delta) {
    app.state.list.offset = Math.max(0, app.state.list.offset + delta);
    await refreshTree();
}

/* ---------- opening notes ---------- */

function rememberPosition() {
    const { state, elements } = app;
    if (!state.note) return;
    const positions = { ...(readPrefs().positions ?? {}) };
    delete positions[state.note.id];
    positions[state.note.id] = { scroll: elements.textarea.scrollTop, start: elements.textarea.selectionStart, end: elements.textarea.selectionEnd };
    writePrefs({ noteId: state.note.id, notebookId: state.notebookId, positions });
}

async function openNote(notebookId, noteId, { pushBack = false, quiet = false, fragment = null } = {}) {
    if (app.sourceEditor?.composing || !notebookCanvasCanLeave()) return false;
    const { state } = app;
    const account = state.account;
    const noteRequestVersion = state.noteRequestVersion = (state.noteRequestVersion ?? 0) + 1;
    if (state.dirty) {
        const saved = await flushSave();
        if (state.noteRequestVersion !== noteRequestVersion || state.account !== account) return false;
        if (!saved && state.dirty) {
            toast('warning', 'This note still has unsaved changes on this device. They are kept as a draft.');
        }
    }
    if (pushBack && state.note && state.note.id !== noteId) {
        state.back.push({ notebookId: state.notebookId, noteId: state.note.id });
        if (state.back.length > 30) state.back.shift();
    }
    if (notebookId !== state.notebookId) await selectNotebook(notebookId, { noteRequestVersion });
    if (state.noteRequestVersion !== noteRequestVersion || state.account !== account || state.notebookId !== notebookId) return false;
    const fromNote = state.note;
    const revision = fromNote?.revision;
    const editorText = state.editorText;
    const value = app.elements.textarea.value;
    const stale = () => state.noteRequestVersion !== noteRequestVersion || state.account !== account || state.notebookId !== notebookId
        || state.note !== fromNote || fromNote?.revision !== revision || state.editorText !== editorText || app.elements.textarea.value !== value;
    const result = await request('/notes/read', { notebookId, noteId });
    if (stale()) return false;
    if (result.status === 'not_found') {
        if (!quiet) toast('warning', 'That note is not available. It may have been moved to Trash.');
        state.note = null;
        renderEditor();
        return false;
    }
    if (failed(result)) return false;
    if (state.dirty) await flushSave();
    if (stale()) return false;
    loadNoteDetail(result);
    state.workspaceView = 'note';
    state.workspaceVersion = (state.workspaceVersion ?? 0) + 1;
    if (isPhone() || state.layout === 'beside') state.pane = 'note';
    applyLayout();
    renderEditor({ restorePosition: true, fragment });
    renderNav();
    writePrefs({ noteId, notebookId });
    return true;
}

function loadNoteDetail(result) {
    const { state } = app;
    const note = result.note;
    state.note = { id: note.id, notebookId: result.notebookId, revision: note.revision, serverText: note.text, path: note.path,
        folder: note.folder, title: note.title, detail: note, associations: result.associations ?? [], provenance: result.provenance ?? [] };
    state.dirty = false;
    state.saveConflict = false;
    state.pending = null;
    state.remoteChanged = false;
    state.retryMs = 0;
    const draft = readDraft(state.account, state.notebookId, note.id);
    let text = lf(note.text);
    clear(app.elements.banner ?? h('div'));
    if (draft && draft.text !== text) {
        if (draft.baseRevision === note.revision) {
            text = draft.text;
            state.dirty = true;
            queueMicrotask(() => scheduleSave());
            showBanner('draft', 'Restored changes saved on this device. They will be saved to the server now.', []);
        } else {
            queueMicrotask(() => showDraftConflict(draft));
        }
    } else if (draft) {
        clearDraft(state.account, state.notebookId, note.id);
    }
    state.editorText = text;
    setStatus(state.dirty ? 'device' : 'saved');
}

async function reloadNote({ keepView = true, discardDraft = false } = {}) {
    const { state } = app;
    const note = state.note;
    if (!note || app.sourceEditor?.composing || ((state.dirty || state.saveConflict) && !discardDraft)) return false;
    const { account, notebookId, editorText, dirty, noteRequestVersion, notebookSelectionVersion } = state;
    const revision = note.revision;
    const value = app.elements.textarea.value;
    const result = await request('/notes/read', { notebookId, noteId: note.id });
    if (failed(result) || state.note !== note || state.account !== account || state.notebookId !== notebookId
        || state.noteRequestVersion !== noteRequestVersion || state.notebookSelectionVersion !== notebookSelectionVersion
        || note.revision !== revision || state.editorText !== editorText || app.elements.textarea.value !== value || state.dirty !== dirty) return false;
    const view = state.view;
    if (discardDraft) clearDraft(account, notebookId, note.id);
    loadNoteDetail(result);
    if (keepView) state.view = view;
    renderEditor({ restorePosition: true });
    return true;
}

async function goBack() {
    const previous = app.state.back.pop();
    if (!previous) return;
    await openNote(previous.notebookId, previous.noteId, { quiet: true });
}

/* ---------- editor ---------- */

function renderEditor({ restorePosition = false, fragment = null } = {}) {
    const { elements, state } = app;
    elements.editorPane?.classList?.toggle('notes-table-pane', state.workspaceView === 'table' && Boolean(state.notebookId));
    if (!elements.root) return;
    if (elements.root.dataset) elements.root.dataset.workspace = state.workspaceView;
    if (elements.paneTabs) renderPaneTabs();
    if (elements.graph) elements.graph.hidden = state.workspaceView !== 'graph' || !state.notebookId;
    if (elements.propertyTable) elements.propertyTable.hidden = state.workspaceView !== 'table' || !state.notebookId;
    if (elements.canvas) elements.canvas.hidden = state.workspaceView !== 'canvas' || !state.notebookId;
    if (['graph', 'table', 'canvas'].includes(state.workspaceView) && state.notebookId) {
        elements.editor.hidden = true;
        elements.empty.hidden = true;
        return;
    }
    const note = state.note;
    elements.editor.hidden = !note;
    elements.empty.hidden = Boolean(note);
    if (!note) {
        app.sourceEditor?.setDocument('', null, [], { force: true });
        clear(elements.empty);
        append(elements.empty, [
            h('img', { class: 'notes-empty-portrait', src: getAssistantIconSrc('miso'), alt: '', width: '96', height: '96', loading: 'lazy', decoding: 'async' }),
            h('p', { class: 'notes-empty-title', text: state.notebookId ? 'A fresh page, not a whisker on it' : 'Every good story starts with a notebook' }),
            h('p', { class: 'notes-empty-copy', text: 'Notes keeps your ideas, drafts and references, with or without a chat.' }),
            state.notebookId ? h('div', { class: 'notes-nav-actions notes-empty-actions' },
                button('New note', () => void app.dialogs.newNote(app), { icon: 'fa-file-circle-plus', className: 'notes-primary' }),
                button('Quick note', () => void app.dialogs.quickNote(app), { icon: 'fa-bolt' }),
                button('Graph', () => void openNotebookGraph(), { icon: 'fa-diagram-project', className: 'notes-quiet' }),
                button('Property table', () => void openNotebookTable(), { icon: 'fa-table', className: 'notes-quiet' }),
                button('Canvas', () => void openNotebookCanvas(), { icon: 'fa-object-group', className: 'notes-quiet' })) : h('div', { class: 'notes-nav-actions notes-empty-actions' },
                button('New notebook', () => void app.dialogs.newNotebook(app), { icon: 'fa-plus', className: 'notes-primary' })),
        ]);
        app.panels?.renderDetails(app);
        return;
    }
    elements.title.value = note.path.replace(/^.*\//, '').replace(/\.md$/i, '');
    const documentKey = `${state.account}:${state.notebookId}:${note.id}`;
    if (app.sourceEditor) app.sourceEditor.setDocument(state.editorText ?? '', documentKey, noteFolds());
    else if (elements.textarea.value !== state.editorText) elements.textarea.value = state.editorText ?? '';
    clear(elements.viewTabs);
    for (const [view, label, icon] of [['write', 'Write', 'fa-pen'], ['read', 'Read', 'fa-book-open'], ['outline', 'Outline', 'fa-list-ul']]) {
        const tab = button(label, () => setView(view), { icon, className: 'notes-choice', pressed: state.view === view });
        tab.dataset.view = view;
        elements.viewTabs.append(tab);
    }
    elements.toolbar.hidden = state.view !== 'write';
    elements.foldControls.hidden = state.view !== 'write';
    elements.foldSections.hidden = state.view !== 'write' || !state.foldSectionsOpen;
    elements.textarea.hidden = state.view !== 'write';
    elements.reader.hidden = state.view !== 'read';
    elements.outline.hidden = state.view !== 'outline';
    if (!elements.outline.isConnected) elements.editorBody.append(elements.outline);
    if (state.view === 'read') renderReader();
    if (state.view === 'outline') renderOutline();
    renderFoldControls();
    if (restorePosition && state.view === 'write') {
        const position = readPrefs().positions?.[note.id];
        if (position) {
            requestAnimationFrame(() => {
                elements.textarea.scrollTop = Number(position.scroll) || 0;
                const length = elements.textarea.value.length;
                elements.textarea.setSelectionRange(Math.min(position.start ?? 0, length), Math.min(position.end ?? 0, length));
            });
        }
    }
    if (fragment) jumpToHeading(fragment);
    app.panels?.renderDetails(app);
}

function setView(view) {
    app.state.view = view;
    renderEditor();
    if (view === 'write') app.elements.textarea.focus({ preventScroll: true });
}

function notebookWorkspaceCurrent(snapshot, view) {
    const { state } = app;
    return state.workspaceView === view && state.notebookId === snapshot.notebookId && state.account === snapshot.account
        && state.workspaceVersion === snapshot.workspaceVersion && state.notebookSelectionVersion === snapshot.notebookSelectionVersion
        && state.noteRequestVersion === snapshot.noteRequestVersion;
}

function notebookCanvasCanLeave() {
    return app.state.workspaceView !== 'canvas' || app.canvasView?.canLeave() !== false;
}

async function openNotebookGraph() {
    const { state, elements } = app;
    if (!state.notebookId || app.sourceEditor?.composing || !notebookCanvasCanLeave()) return false;
    const snapshot = { notebookId: state.notebookId, account: state.account, workspaceVersion: ++state.workspaceVersion,
        notebookSelectionVersion: state.notebookSelectionVersion, noteRequestVersion: state.noteRequestVersion };
    state.workspaceView = 'graph';
    state.pane = 'note';
    applyLayout();
    renderEditor();
    clear(elements.graph);
    elements.graph.append(h('p', { class: 'notes-hint', role: 'status', text: 'Loading notebook links…' }));
    try {
        app.graphModule ??= await import('./graph.js');
        if (!notebookWorkspaceCurrent(snapshot, 'graph')) return false;
        app.graphView ??= app.graphModule.createGraphView(app, elements.graph);
        await app.graphView.open();
        return notebookWorkspaceCurrent(snapshot, 'graph');
    } catch {
        if (notebookWorkspaceCurrent(snapshot, 'graph')) {
            clear(elements.graph);
            elements.graph.append(h('p', { class: 'notes-notice', text: 'The graph could not be loaded. Go back to notes and try again.' }),
                button('Back to note', closeNotebookView));
        }
        return false;
    }
}

function closeNotebookView() {
    if (!notebookCanvasCanLeave()) return;
    app.state.workspaceView = 'note';
    app.state.workspaceVersion++;
    renderEditor();
}

async function openNotebookTable() {
    const { state, elements } = app;
    if (!state.notebookId || app.sourceEditor?.composing || !notebookCanvasCanLeave()) return false;
    const snapshot = { account: state.account, notebookId: state.notebookId, workspaceVersion: ++state.workspaceVersion,
        notebookSelectionVersion: state.notebookSelectionVersion, noteRequestVersion: state.noteRequestVersion };
    state.workspaceView = 'table';
    state.pane = 'note';
    applyLayout();
    renderEditor();
    clear(elements.propertyTable);
    elements.propertyTable.append(h('p', { class: 'notes-hint', role: 'status', text: 'Loading saved properties…' }));
    try {
        app.tableModule ??= await import('./property-table.js');
        if (!notebookWorkspaceCurrent(snapshot, 'table')) return false;
        app.tableView ??= app.tableModule.createPropertyTableView(app, elements.propertyTable);
        await app.tableView.open();
        return notebookWorkspaceCurrent(snapshot, 'table');
    } catch {
        if (notebookWorkspaceCurrent(snapshot, 'table')) {
            clear(elements.propertyTable);
            elements.propertyTable.append(h('p', { class: 'notes-notice', text: 'The table could not be loaded. Go back to notes and try again.' }),
                button('Back to note', closeNotebookView));
        }
        return false;
    }
}

async function openNotebookCanvas() {
    const { state, elements } = app;
    if (!state.notebookId || app.sourceEditor?.composing || !notebookCanvasCanLeave()) return false;
    const snapshot = { account: state.account, notebookId: state.notebookId, workspaceVersion: ++state.workspaceVersion,
        notebookSelectionVersion: state.notebookSelectionVersion, noteRequestVersion: state.noteRequestVersion };
    state.workspaceView = 'canvas';
    state.pane = 'note';
    applyLayout();
    renderEditor();
    clear(elements.canvas);
    elements.canvas.append(h('p', { class: 'notes-hint', role: 'status', text: 'Loading planning canvases...' }));
    try {
        app.canvasModule ??= await import('./canvas.js');
        if (!notebookWorkspaceCurrent(snapshot, 'canvas')) return false;
        app.canvasView ??= app.canvasModule.createCanvasView(app, elements.canvas);
        await app.canvasView.open();
        return notebookWorkspaceCurrent(snapshot, 'canvas');
    } catch {
        if (notebookWorkspaceCurrent(snapshot, 'canvas')) {
            clear(elements.canvas);
            elements.canvas.append(h('p', { class: 'notes-notice', text: 'Canvases could not be loaded. Go back to notes and try again.' }),
                button('Back to note', closeNotebookView));
        }
        return false;
    }
}

function readerPreviewCurrent(snapshot) {
    const { state, elements } = app;
    return state.view === 'read' && state.note === snapshot.note && state.account === snapshot.account
        && state.notebookId === snapshot.notebookId && elements.textarea.value === snapshot.text
        && state.noteRequestVersion === snapshot.noteRequestVersion && state.notebookSelectionVersion === snapshot.notebookSelectionVersion
        && state.readerRequestVersion === snapshot.readerRequestVersion;
}

async function renderReader() {
    const { elements, state } = app;
    if (!state.note) return;
    const snapshot = { note: state.note, account: state.account, notebookId: state.notebookId, text: elements.textarea.value,
        noteRequestVersion: state.noteRequestVersion, notebookSelectionVersion: state.notebookSelectionVersion, readerRequestVersion: ++state.readerRequestVersion };
    const options = {
        notebookId: state.notebookId,
        noteId: state.note.id,
        notePath: state.note.path,
        attachmentUrl,
        foldedKeys: noteFolds(),
        onFold: keys => {
            if (!readerPreviewCurrent(snapshot)) return;
            app.sourceEditor?.setFolds(keys);
            rememberFolds(keys);
        },
    };
    renderNoteInto(elements.reader, snapshot.text, { ...options, embedLoading: true });
    if (!elements.reader.querySelector('.notes-embed-placeholder')) return;
    let result;
    try {
        result = await request('/embeds', { notebookId: snapshot.notebookId, noteId: snapshot.note.id, text: snapshot.text });
    } catch {
        result = null;
    }
    if (!readerPreviewCurrent(snapshot)) return;
    renderNoteInto(elements.reader, snapshot.text, { ...options, foldedKeys: noteFolds(), embeds: result?.status === 'success' ? result.embeds : [] });
}

function noteFolds() {
    const { state } = app;
    const keys = readPrefs().folds?.[`${state.notebookId}:${state.note?.id}`];
    return Array.isArray(keys) ? keys.slice(0, 5000).filter(key => typeof key === 'string' && /^h_[a-f\d]{16}$/.test(key)) : [];
}

function rememberFolds(keys) {
    const { state } = app;
    if (!state.note || !Array.isArray(keys)) return;
    const folds = { ...readPrefs().folds };
    const key = `${state.notebookId}:${state.note.id}`;
    delete folds[key];
    folds[key] = keys.slice(0, 5000);
    writePrefs({ folds: Object.fromEntries(Object.entries(folds).slice(-50)) });
    renderFoldControls();
}

function renderFoldControls() {
    const { elements, state, sourceEditor } = app;
    if (!elements.foldControls || !sourceEditor || !state.note) return;
    const headings = sourceEditor.headings().filter(heading => heading.to > heading.from);
    clear(elements.foldControls);
    if (!headings.length) {
        elements.foldControls.hidden = true;
        elements.foldSections.hidden = true;
        return;
    }
    const sections = button('Sections', () => {
        state.foldSectionsOpen = !state.foldSectionsOpen;
        elements.foldSections.hidden = !state.foldSectionsOpen;
        renderFoldControls();
    }, { pressed: Boolean(state.foldSectionsOpen) });
    sections.setAttribute('aria-expanded', String(Boolean(state.foldSectionsOpen)));
    const foldAll = button('Fold all', () => sourceEditor.foldAll());
    const showAll = button('Show all', () => sourceEditor.showAll());
    foldAll.disabled = sourceEditor.composing;
    showAll.disabled = sourceEditor.composing;
    append(elements.foldControls, [sections, foldAll, showAll]);
    clear(elements.foldSections);
    if (!state.foldSectionsOpen) return;
    const folded = new Set(sourceEditor.folds());
    const limit = state.foldLimit ?? 100;
    for (const heading of headings.slice(0, limit)) {
        const control = button(`${folded.has(heading.key) ? 'Show' : 'Fold'} ${heading.text || 'Untitled heading'}`, () => sourceEditor.toggle(heading.key));
        control.style.setProperty('--notes-outline-level', String(heading.level - 1));
        control.setAttribute('aria-expanded', String(!folded.has(heading.key)));
        control.disabled = sourceEditor.composing;
        elements.foldSections.append(control);
    }
    if (headings.length > limit) elements.foldSections.append(button('More sections', () => {
        state.foldLimit = limit + 100;
        renderFoldControls();
    }));
}

function renderOutline() {
    const { elements } = app;
    clear(elements.outline);
    const headings = headingOutline(elements.textarea.value);
    if (!headings.length) {
        elements.outline.append(h('p', { class: 'notes-hint', text: 'No headings yet. Lines starting with # become headings.' }));
        return;
    }
    const list = h('ul', { class: 'notes-outline-list' });
    for (const heading of headings) {
        list.append(h('li', { style: `--notes-outline-level:${heading.level - 1}` },
            h('button', { type: 'button', class: 'notes-outline-item', text: heading.text, onclick: () => jumpToOffset(heading.offset) })));
    }
    elements.outline.append(list);
}

function jumpToOffset(offset) {
    if (app.sourceEditor?.composing) return false;
    const { elements } = app;
    app.state.view = 'write';
    renderEditor();
    const textarea = elements.textarea;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(offset, offset);
    if (textarea.scrollToOffset) return textarea.scrollToOffset(offset);
    const before = textarea.value.slice(0, offset).split('\n').length - 1;
    const lineHeight = parseFloat(getComputedStyle(textarea.element ?? textarea).lineHeight) || 22;
    textarea.scrollTop = Math.max(0, before * lineHeight - 40);
}

function jumpToHeading(fragment) {
    const wanted = String(fragment).replace(/^\^/, '').toLocaleLowerCase('und');
    const text = app.elements.textarea.value;
    const block = text.search(new RegExp(`\\^${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
    if (block >= 0) return jumpToOffset(text.lastIndexOf('\n', block) + 1);
    const heading = headingOutline(text).find(item => item.text.toLocaleLowerCase('und') === wanted);
    if (heading) jumpToOffset(heading.offset);
}

function onEditorInput() {
    const { state, elements } = app;
    if (!state.note) return;
    const conflict = state.saveConflict || state.status === 'conflict';
    state.editorText = elements.textarea.value;
    state.dirty = state.editorText !== lf(state.note.serverText) || conflict;
    if (!state.dirty) {
        clearDraft(state.account, state.notebookId, state.note.id);
        if (!state.saving) setStatus('saved');
        return;
    }
    const stored = saveDraft(state.account, state.notebookId, state.note.id, { text: state.editorText, baseRevision: state.note.revision });
    if (!stored.ok) {
        setStatus(conflict ? 'conflict' : 'error');
        showBanner('storage', stored.reason === 'too-large'
            ? 'This note is too large to keep a copy on this device. Keep this tab open until it says Saved on server.'
            : 'This browser would not keep a copy of your changes on this device. Keep this tab open until it says Saved on server.', []);
    } else if (!state.saving) {
        setStatus(conflict ? 'conflict' : 'device');
    }
    maybeSuggest();
    if (conflict) clearTimeout(state.saveTimer);
    else scheduleSave();
}

function scheduleSave(delay = SAVE_DELAY_MS) {
    const { state } = app;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => void saveNow(), delay);
}

/** Saves the editor text; resolves true once the server has the current text. */
async function saveNow() {
    const { state } = app;
    clearTimeout(state.saveTimer);
    const note = state.note;
    if (!note || !state.dirty) return true;
    if (state.saveConflict || state.status === 'conflict') return false;
    if (app.sourceEditor?.composing) {
        scheduleSave();
        return false;
    }
    if (state.saving) {
        scheduleSave(400);
        return false;
    }
    const text = state.editorText;
    const { account, notebookId, noteRequestVersion, notebookSelectionVersion } = state;
    if (!state.pending || state.pending.text !== text || state.pending.noteId !== note.id || state.pending.baseRevision !== note.revision) {
        state.pending = { text, noteId: note.id, baseRevision: note.revision, operationId: newOperationId('save') };
    }
    const pending = state.pending;
    state.saving = true;
    setStatus('saving');
    const result = await request('/notes/update', {
        operationId: pending.operationId, notebookId, noteId: note.id, expectedRevision: pending.baseRevision,
        changes: [{ type: 'replace_all', markdown: text }], reason: 'autosave',
    });
    state.saving = false;
    if (state.note !== note || state.account !== account || state.notebookId !== notebookId
        || state.noteRequestVersion !== noteRequestVersion || state.notebookSelectionVersion !== notebookSelectionVersion) return false;
    if (result.status === 'success' || result.status === 'no_change') {
        state.retryMs = 0;
        state.pending = null;
        note.revision = result.revision ?? note.revision;
        note.serverText = text;
        if (result.path) note.path = result.path;
        state.ownRevisions = [...(state.ownRevisions ?? []).slice(-20), note.revision];
        state.dirty = state.editorText !== text;
        if (!state.dirty) {
            clearDraft(state.account, state.notebookId, note.id);
            setStatus('saved');
        } else {
            saveDraft(state.account, state.notebookId, note.id, { text: state.editorText, baseRevision: note.revision });
            scheduleSave(300);
        }
        reportLoreUpdates(result.loreUpdates);
        if (result.title && result.title !== note.title) {
            note.title = result.title;
            void refreshTree();
        }
        return !state.dirty;
    }
    if (result.status === 'conflict' && result.code === 'NOTE_CONFLICT') {
        state.pending = null;
        setStatus('conflict');
        showSaveConflict();
        return false;
    }
    if (result.status === 'cancelled') return false;
    if (result.network || result.http >= 500 || result.status === 'unavailable') {
        state.retryMs = Math.min(MAX_RETRY_MS, state.retryMs ? state.retryMs * 2 : 2000);
        setStatus('device');
        scheduleSave(state.retryMs);
        return false;
    }
    setStatus('error');
    showBanner('save-error', result.message || 'The server refused this save. Your text is kept on this device.', [
        ['Try again', () => { clearBanner('save-error'); setStatus('device'); void saveNow(); }],
    ]);
    return false;
}

async function flushSave() {
    clearTimeout(app.state.saveTimer);
    return saveNow();
}

function reportLoreUpdates(updates) {
    if (!Array.isArray(updates)) return;
    const updated = updates.filter(item => item.updated).length;
    const review = updates.filter(item => item.status === 'needs_review' || item.status === 'conflict').length;
    if (updated) toast('success', `Lore kept up to date (${updated} entr${updated === 1 ? 'y' : 'ies'}).`);
    if (review) toast('info', 'Linked lore needs a review before it changes. See Details > Lore.');
}

function setStatus(status) {
    const { state, elements } = app;
    if (state.status === status && elements.status?.textContent === STATUS_TEXT[status]) return;
    state.status = status;
    if (!elements.status) return;
    elements.status.textContent = STATUS_TEXT[status] ?? '';
    elements.status.dataset.status = status;
}

/* ---------- banners and conflicts ---------- */

function showBanner(id, message, actions = [], { dismissible = true } = {}) {
    const host = app.elements.banner;
    if (!host) return;
    host.querySelector(`[data-banner="${id}"]`)?.remove();
    const row = h('div', { class: 'notes-banner', dataset: { banner: id }, role: 'alert' }, h('p', { text: message }));
    const buttons = h('div', { class: 'notes-nav-actions notes-wrap' });
    for (const [label, action] of actions) buttons.append(button(label, action, { className: 'notes-quiet' }));
    if (dismissible) buttons.append(button('Dismiss', () => row.remove(), { className: 'notes-quiet' }));
    row.append(buttons);
    host.append(row);
}

function clearBanner(id) {
    app.elements.banner?.querySelector(`[data-banner="${id}"]`)?.remove();
}

async function compareTexts(title, before, after) {
    const body = h('div', { class: 'notes-dialog' },
        h('h3', { text: title }),
        h('p', { class: 'notes-hint', text: 'Lines starting with - are only in the first version; lines starting with + are only in the second.' }),
        h('pre', { class: 'notes-diff', text: formatDiff(lf(before), lf(after)) || '(no differences)' }));
    await callGenericPopup(body, POPUP_TYPE.TEXT, '', { wide: true, large: true, okButton: 'Close' });
}

async function fetchServerText() {
    const { state } = app;
    const note = state.note;
    if (!note) return null;
    const { account, notebookId, noteRequestVersion, notebookSelectionVersion } = state;
    const revision = note.revision;
    const result = await request('/notes/read', { notebookId, noteId: note.id });
    return failed(result) || state.note !== note || state.account !== account || state.notebookId !== notebookId
        || state.noteRequestVersion !== noteRequestVersion || state.notebookSelectionVersion !== notebookSelectionVersion
        || note.revision !== revision ? null : result;
}

async function saveRecoveryCopy(text, suffix, { open = false } = {}) {
    const { state, elements } = app;
    const note = state.note;
    if (!note) return false;
    const { account, notebookId, editorText, noteRequestVersion, notebookSelectionVersion } = state;
    const revision = note.revision;
    const value = elements.textarea.value;
    const created = await createNote({ folder: note.folder, title: `${note.title} (${suffix})`, text });
    if (!created) return false;
    if (state.note !== note || state.account !== account || state.notebookId !== notebookId
        || state.noteRequestVersion !== noteRequestVersion || state.notebookSelectionVersion !== notebookSelectionVersion
        || note.revision !== revision || state.editorText !== editorText || elements.textarea.value !== value) {
        toast('success', 'A separate copy was saved. Your current note was left unchanged.');
        return true;
    }
    if (open && !(await openNote(notebookId, created.noteId, { pushBack: true }))) return true;
    const draft = readDraft(account, notebookId, note.id);
    if (!draft || draft.text === text) clearDraft(account, notebookId, note.id);
    if (!open) {
        clearBanner('draft');
        toast('success', 'A separate copy of the device draft was saved.');
    }
    return true;
}

function showSaveConflict() {
    app.state.saveConflict = true;
    clearTimeout(app.state.saveTimer);
    clearBanner('remote');
    showBanner('conflict', 'This note changed somewhere else since you opened it. Your text is kept on this device. Choose what to keep.', [
        ['Compare', async () => {
            const server = await fetchServerText();
            if (server) await compareTexts('Server version (-) and your version (+)', server.note.text, app.elements.textarea.value);
        }],
        ['Use server version', () => reloadNote({ discardDraft: true })],
        ['Save mine as a copy', () => saveRecoveryCopy(app.elements.textarea.value, 'my copy', { open: true })],
        ['Keep mine', async () => {
            const server = await fetchServerText();
            if (!server) return;
            clearBanner('conflict');
            app.state.note.revision = server.note.revision;
            app.state.note.serverText = server.note.text;
            app.state.saveConflict = false;
            app.state.dirty = app.elements.textarea.value !== lf(server.note.text);
            setStatus(app.state.dirty ? 'device' : 'saved');
            if (app.state.dirty) void saveNow();
            else clearDraft(app.state.account, app.state.notebookId, app.state.note.id);
        }],
    ], { dismissible: false });
}

function showDraftConflict(draft) {
    showBanner('draft', `A draft from ${formatTime(draft.at)} on this device was written against an older version of this note.`, [
        ['Compare', () => void compareTexts('Server version (-) and draft (+)', app.state.note.serverText, draft.text)],
        ['Use draft', () => {
            clearBanner('draft');
            app.elements.textarea.value = draft.text;
            onEditorInput();
        }],
        ['Save draft as a copy', () => saveRecoveryCopy(draft.text, 'draft')],
        ['Discard draft', () => {
            clearDraft(app.state.account, app.state.notebookId, app.state.note.id);
            clearBanner('draft');
        }],
    ]);
}

/* ---------- remote changes ---------- */

const refreshTreeSoon = debounce(() => void refreshTree(), 500);

function onRemoteChange(change) {
    const { state } = app;
    if (!state.open || change.notebookId !== state.notebookId) {
        if (change.kind === 'notebook') void loadNotebooks();
        return;
    }
    refreshTreeSoon();
    if (change.kind === 'policy' || change.kind === 'lore' || change.kind === 'proposal') app.panels?.renderDetails(app);
    const note = state.note;
    if (!note || change.noteId !== note.id || !change.revision || change.revision === note.revision) return;
    if ((state.ownRevisions ?? []).includes(change.revision) || state.saving) return;
    if (state.saveConflict || state.status === 'conflict') {
        showSaveConflict();
        return;
    }
    if (!state.dirty) {
        void reloadNote();
        return;
    }
    state.remoteChanged = true;
    showBanner('remote', 'This note was changed somewhere else while you were editing. Your text is still here.', [
        ['Compare', async () => {
            const server = await fetchServerText();
            if (server) await compareTexts('Server version (-) and your version (+)', server.note.text, app.elements.textarea.value);
        }],
        ['Use server version', () => reloadNote({ discardDraft: true })],
    ]);
}

/* ---------- toolbar ---------- */

function buildToolbar() {
    const actions = [
        ['Heading', 'fa-heading', () => prefixLines('## ')],
        ['Bold', 'fa-bold', () => wrapSelection('**', '**', 'bold text')],
        ['Italic', 'fa-italic', () => wrapSelection('*', '*', 'italic text')],
        ['Strikethrough', 'fa-strikethrough', () => wrapSelection('~~', '~~', 'struck text')],
        ['Bulleted list', 'fa-list-ul', () => prefixLines('- ')],
        ['Numbered list', 'fa-list-ol', () => prefixLines('1. ')],
        ['Task', 'fa-square-check', () => prefixLines('- [ ] ')],
        ['Quote', 'fa-quote-left', () => prefixLines('> ')],
        ['Link to note', 'fa-link', () => void app.dialogs.linkPicker(app)],
        ['Web link', 'fa-globe', () => wrapSelection('[', '](https://)', 'link text')],
        ['Image or file', 'fa-image', () => void app.dialogs.uploadAttachment(app)],
        ['Code', 'fa-code', () => codeAction()],
        ['Table', 'fa-table', () => insertBlock('| Column | Column |\n| --- | --- |\n| | |')],
        ['Divider', 'fa-minus', () => insertBlock('---')],
    ];
    const bar = h('div', { class: 'notes-toolbar', role: 'toolbar', 'aria-label': 'Formatting' });
    for (const [label, icon, action] of actions) {
        bar.append(h('button', { type: 'button', class: 'menu_button notes-tool', title: label, 'aria-label': label,
            onmousedown: event => event.preventDefault(), onclick: action }, h('i', { class: `fa-solid ${icon}`, 'aria-hidden': 'true' })));
    }
    bar.addEventListener('keydown', event => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        const items = [...bar.querySelectorAll('button')];
        const index = items.indexOf(document.activeElement);
        if (index < 0) return;
        event.preventDefault();
        items[(index + (event.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length].focus();
    });
    return bar;
}

/** Replaces the selection through the browser's editing command so native undo keeps working. */
function insertText(text, { select = null } = {}) {
    const textarea = app.elements.textarea;
    textarea.focus({ preventScroll: true });
    const start = textarea.selectionStart;
    if (textarea.insertText) {
        textarea.insertText(text);
        if (select) textarea.setSelectionRange(start + select[0], start + select[1]);
        return;
    }
    let done = false;
    try {
        done = document.execCommand?.('insertText', false, text) === true;
    } catch {
        done = false;
    }
    if (!done) {
        textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (select) textarea.setSelectionRange(start + select[0], start + select[1]);
}

function wrapSelection(before, after, placeholder) {
    const textarea = app.elements.textarea;
    const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
    const inner = selected || placeholder;
    insertText(`${before}${inner}${after}`, { select: [before.length, before.length + inner.length] });
}

function prefixLines(prefix) {
    const textarea = app.elements.textarea;
    const value = textarea.value;
    const start = value.lastIndexOf('\n', textarea.selectionStart - 1) + 1;
    let end = value.indexOf('\n', Math.max(textarea.selectionEnd - (textarea.selectionEnd > textarea.selectionStart ? 1 : 0), start));
    if (end < 0) end = value.length;
    textarea.setSelectionRange(start, end);
    const lines = value.slice(start, end).split('\n');
    const all = lines.every(line => line.startsWith(prefix));
    const next = lines.map(line => all ? line.slice(prefix.length) : `${prefix}${line}`).join('\n');
    insertText(next);
}

function codeAction() {
    const textarea = app.elements.textarea;
    const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
    if (selected.includes('\n') || !selected) insertBlock(`\`\`\`\n${selected || 'code'}\n\`\`\``);
    else wrapSelection('`', '`', 'code');
}

function insertBlock(block) {
    const textarea = app.elements.textarea;
    const before = textarea.value.slice(0, textarea.selectionStart);
    const lead = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    insertText(`${lead}${block}\n`);
}

function onEditorKeydown(event) {
    if (event.isComposing || event.keyCode === 229 || app.sourceEditor?.composing) return;
    if (!app.elements.suggest.hidden) {
        const items = [...app.elements.suggest.querySelectorAll('[role="option"]')];
        const index = items.findIndex(item => item.getAttribute('aria-selected') === 'true');
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const next = items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1) + items.length) % items.length];
            items.forEach(item => item.setAttribute('aria-selected', String(item === next)));
            app.elements.textarea.setAttribute('aria-activedescendant', next?.id ?? '');
            return;
        }
        if ((event.key === 'Enter' || event.key === 'Tab') && index >= 0) {
            event.preventDefault();
            items[index].click();
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            hideSuggest();
            return;
        }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void flushSave();
    }
}

/* ---------- [[ autocomplete ---------- */

const suggestSoon = debounce(query => void fetchSuggestions(query), 180);

function linkQuery() {
    const textarea = app.elements.textarea;
    const caret = textarea.selectionStart;
    if (caret !== textarea.selectionEnd) return null;
    const line = textarea.value.slice(textarea.value.lastIndexOf('\n', caret - 1) + 1, caret);
    const match = /\[\[([^\]\n|#]{0,80})$/.exec(line);
    if (!match || line.slice(0, match.index).endsWith('\\')) return null;
    return { query: match[1], start: caret - match[1].length };
}

function maybeSuggest() {
    const found = linkQuery();
    if (!found) return hideSuggest();
    suggestSoon(found.query);
}

async function fetchSuggestions(query) {
    const found = linkQuery();
    if (!found || found.query !== query) return;
    const result = await request('/suggest', { notebookId: app.state.notebookId, query });
    if (failed(result) || linkQuery()?.query !== query) return;
    showSuggestions(result.notes ?? [], found);
}

export function linkTextFor(note, notes) {
    const stem = note.path.replace(/^.*\//, '').replace(/\.md$/i, '');
    const duplicate = notes.filter(item => item.path.replace(/^.*\//, '').replace(/\.md$/i, '').toLocaleLowerCase('und') === stem.toLocaleLowerCase('und')).length > 1;
    return duplicate ? note.path.replace(/\.md$/i, '') : stem;
}

function showSuggestions(notes, found) {
    const list = app.elements.suggest;
    clear(list);
    if (!notes.length) return hideSuggest();
    notes.slice(0, 8).forEach((note, index) => {
        list.append(h('li', { id: `notes-suggest-${index}`, role: 'option', class: 'notes-suggest-item', 'aria-selected': String(index === 0),
            onmousedown: event => event.preventDefault(),
            onclick: () => {
                const textarea = app.elements.textarea;
                textarea.setSelectionRange(found.start, textarea.selectionStart);
                insertText(`${linkTextFor(note, notes)}]]`);
                hideSuggest();
            } }, h('span', { text: note.title }), h('span', { class: 'notes-note-meta', text: note.folder || 'Top level' })));
    });
    list.hidden = false;
    app.elements.textarea.setAttribute('aria-activedescendant', 'notes-suggest-0');
}

function hideSuggest() {
    if (!app.elements.suggest) return;
    app.elements.suggest.hidden = true;
    app.elements.textarea.removeAttribute('aria-activedescendant');
}

/* ---------- reading view links ---------- */

async function followLink({ target, kind, fragment, fromNoteId }) {
    const { state } = app;
    const notebookId = state.notebookId;
    const note = state.note;
    const noteRequestVersion = state.noteRequestVersion;
    const notebookSelectionVersion = state.notebookSelectionVersion;
    const current = () => state.note === note && state.notebookId === notebookId
        && state.noteRequestVersion === noteRequestVersion && state.notebookSelectionVersion === notebookSelectionVersion;
    const result = await request('/resolve', { notebookId, fromNoteId: kind === 'wiki' ? fromNoteId ?? note?.id : undefined, target, kind });
    if (!current()) return;
    if (failed(result)) return;
    const jump = fragment || result.fragment || null;
    if (result.resolution === 'resolved') {
        if (result.note.id === state.note?.id) return jump && jumpToHeading(jump);
        return openNote(notebookId, result.note.id, { pushBack: true, fragment: jump });
    }
    if (result.resolution === 'ambiguous') {
        const chosen = await app.dialogs.chooseNote(app, `More than one note matches '${target}'. Which one?`, result.candidates);
        if (chosen && current()) await openNote(notebookId, chosen.id, { pushBack: true, fragment: jump });
        return;
    }
    if (result.resolution === 'attachment') {
        globalThis.open(attachmentUrl(state.notebookId, result.path), '_blank', 'noopener');
        return;
    }
    if (result.resolution === 'missing') {
        const name = target.replace(/\.md$/i, '');
        const ok = await callGenericPopup(`There is no note called '${name}' yet. Create it?`, POPUP_TYPE.CONFIRM, '', { okButton: 'Create note', cancelButton: 'Not now' });
        if (ok !== POPUP_RESULT.AFFIRMATIVE || !current()) return;
        const slash = name.lastIndexOf('/');
        const created = await createNote({ folder: slash >= 0 ? name.slice(0, slash) : state.note?.folder ?? 'Inbox', title: slash >= 0 ? name.slice(slash + 1) : name, text: '' });
        if (created) await openNote(state.notebookId, created.noteId, { pushBack: true });
    }
}

function onReaderClick(event) {
    const open = event.target.closest?.('[data-note-open]');
    if (open) {
        event.preventDefault();
        void openNote(app.state.notebookId, open.dataset.noteOpen, { pushBack: true, fragment: open.dataset.wikiFragment });
        return;
    }
    const link = event.target.closest?.('.notes-wikilink');
    if (link) {
        if (!link.hasAttribute('data-wiki-target') && !link.hasAttribute('data-note-path')) return;
        event.preventDefault();
        if (link.dataset.notePath) void followLink({ target: link.dataset.notePath, kind: 'markdown', fragment: link.dataset.wikiFragment });
        else void followLink({ target: [link.dataset.wikiTarget, link.dataset.wikiFragment].filter(Boolean).join('#'), kind: 'wiki', fromNoteId: link.dataset.noteFromId });
        return;
    }
    const external = event.target.closest?.('.notes-external-image');
    if (external) {
        const source = external.dataset.externalSource;
        if (!/^https?:\/\//i.test(source ?? '')) return;
        const image = h('img', { src: source, alt: external.dataset.alt ?? '', loading: 'lazy', referrerpolicy: 'no-referrer' });
        external.replaceWith(image);
        return;
    }
    const heading = event.target.closest?.('[data-heading-target]');
    if (heading) {
        event.preventDefault();
        if (heading.dataset.noteFromId && heading.dataset.noteFromId !== app.state.note?.id) {
            void openNote(app.state.notebookId, heading.dataset.noteFromId, { pushBack: true, fragment: heading.dataset.headingTarget });
        } else jumpToHeading(heading.dataset.headingTarget);
    }
}

/* ---------- shared actions used by panels and dialogs ---------- */

async function createNote({ folder = 'Inbox', title = '', text = '', template = null } = {}) {
    const { state } = app;
    const result = await request('/notes/create', { operationId: newOperationId('create'), notebookId: state.notebookId, folder, title, text, template });
    if (failed(result, 'The note could not be created.')) return null;
    await refreshTree();
    return result;
}

async function renameFromTitle() {
    const { state, elements } = app;
    const note = state.note;
    if (!note) return;
    const title = elements.title.value.trim();
    const current = note.path.replace(/^.*\//, '').replace(/\.md$/i, '');
    if (!title || title === current) {
        elements.title.value = current;
        return;
    }
    if (!(await flushSave())) {
        toast('warning', 'Save the note first, then rename it.');
        elements.title.value = current;
        return;
    }
    await moveNote({ title, folder: note.folder });
}

async function moveNote({ title, folder }) {
    const { state } = app;
    const note = state.note;
    const result = await request('/notes/move', { operationId: newOperationId('move'), notebookId: state.notebookId, noteId: note.id,
        title, folder, expectedRevision: note.revision, updateLinks: true });
    if (failed(result, 'The note could not be renamed.')) {
        app.elements.title.value = note.path.replace(/^.*\//, '').replace(/\.md$/i, '');
        return null;
    }
    if (result.updatedLinks) toast('success', `Updated ${result.updatedLinks} link${result.updatedLinks === 1 ? '' : 's'} in other notes.`);
    if (result.unresolved?.length) toast('info', `${result.unresolved.length} link(s) could not be updated safely and were left as they were.`);
    await reloadNote();
    await refreshTree();
    return result;
}

async function changeNote(changes, reason = 'edit') {
    const { state } = app;
    if (!(await flushSave())) {
        toast('warning', 'Save your typing first; this note has unsaved changes.');
        return null;
    }
    const result = await request('/notes/update', { operationId: newOperationId('edit'), notebookId: state.notebookId, noteId: state.note.id,
        expectedRevision: state.note.revision, changes, reason });
    if (failed(result, 'The change could not be saved.')) return null;
    reportLoreUpdates(result.loreUpdates);
    await reloadNote();
    return result;
}

Object.assign(app, {
    request, failed, toast, isPhone, refreshTree, loadNotebooks, selectNotebook, openNote, reloadNote, flushSave, insertText, setStatus,
    createNote, moveNote, changeNote, compareTexts, showBanner, clearBanner, renderNav, renderEditor, applyLayout, setPane,
    chatScope: currentChatScope, lf, readPrefs, writePrefs, hide: hideNotes, setView, jumpToOffset, closeNotebookView, openNotebookGraph, openNotebookTable, openNotebookCanvas,
});

export function notesApp() {
    return app;
}

/** Opens Notes and starts saving a chat passage, used by the message action. */
export async function captureFromChat(capture) {
    await openNotes({ layout: isPhone() ? undefined : app.state.layout });
    await app.dialogs.captureFromChat(app, capture);
}

globalThis.NeconyanNotes = Object.freeze({ open: openNotes, hide: hideNotes, onRoute: onWorkspaceRoute, captureFromChat });
