import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../popup.js';
import { newOperationId } from './api.js';
import { append, button, choiceRow, clear, field, formatBytes, formatTime, h } from './dom.js';
import { formatDiff } from './line-diff.js';
import { headingOutline } from './render.js';

const TABS = [['properties', 'Properties'], ['links', 'Links'], ['lore', 'Lore'], ['ai', 'AI access'], ['history', 'History']];
const RESERVED_PROPERTIES = new Set(['title', 'tags', 'tag', 'aliases', 'alias', 'type', 'neconyan_id']);
const LORE_STATUS = {
    unpublished: ['Not published yet', 'Nothing from this note is in the lorebook yet.'],
    in_sync: ['In sync', 'The lore entry matches what you last published.'],
    draft_changed: ['Draft has changes', 'You edited the note since publishing. The lore entry still has the older text.'],
    lore_changed: ['Lore changed separately', 'Someone edited the lore entry directly since you published.'],
    conflict: ['Both changed', 'The note and the lore entry both changed. Choose which text to keep.'],
    source_missing: ['Source missing', 'The note section this came from is gone. The lore entry is unchanged.'],
    selector_unresolved: ['Needs repair', 'The section could not be found exactly once, so nothing will be published until you pick it again.'],
    target_missing: ['Entry missing', 'The lore entry was deleted. It will not be recreated unless you publish again.'],
    failed: ['Needs attention', 'The last publication did not finish. Nothing was overwritten.'],
};
const ORIGIN_LABEL = { user: 'You', assistant: 'Assistant', external: 'Changed outside Neconyan', import: 'Import', lore: 'From lore',
    capture: 'Saved from chat', restore: 'Restore', 'lore-copy': 'Copied from lore' };

let renderToken = 0;

async function dialog(content, options = {}) {
    let popup = null;
    const result = await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', { wide: true, ...options, onOpen: value => { popup = value; } });
    return { ok: result === POPUP_RESULT.AFFIRMATIVE, result, popup };
}

function notice(text, kind = '') {
    return h('p', { class: `notes-notice${kind ? ` notes-notice-${kind}` : ''}`, text });
}

function section(title, ...children) {
    return h('section', { class: 'notes-detail-section' }, h('h3', { class: 'notes-detail-heading', text: title }), ...children);
}

function listText(value) {
    return Array.isArray(value) ? value.join(', ') : value == null ? '' : String(value);
}

function splitList(value) {
    return String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
}

function stemOf(path) {
    return String(path ?? '').replace(/^.*\//, '').replace(/\.md$/i, '');
}

async function refreshWorldInfo(book) {
    try {
        const worldInfo = await import('../world-info.js');
        worldInfo.worldInfoCache?.delete?.(book);
        await worldInfo.reloadEditor?.(book);
    } catch {
        /* The lorebook editor refreshes the next time it opens. */
    }
}

/** Fills the details pane for the open note. Stale async renders are dropped. */
export async function renderDetails(app) {
    const target = app.elements.details;
    if (!target) return;
    const token = ++renderToken;
    const tab = app.state.detailsTab;
    const tabs = h('div', { class: 'notes-detail-tabs notes-choice-group', role: 'group', 'aria-label': 'Note details' });
    for (const [id, label] of TABS) {
        tabs.append(button(label, () => {
            app.state.detailsTab = id;
            void renderDetails(app);
        }, { className: 'notes-choice', pressed: tab === id }));
    }
    const body = h('div', { class: 'notes-detail-body', 'aria-live': 'off' });
    const content = await buildTab(app, tab).catch(error => [notice(error?.message || 'This panel could not be loaded.', 'warning')]);
    if (token !== renderToken) return;
    append(body, content);
    clear(target);
    target.append(tabs, body);
}

async function buildTab(app, tab) {
    if (!app.state.notebookId) return [notice('Choose or create a notebook first.')];
    if (tab === 'ai') return aiPanel(app);
    if (!app.state.note) return [notice('Open a note to see its details.')];
    if (tab === 'links') return linksPanel(app);
    if (tab === 'lore') return lorePanel(app);
    if (tab === 'history') return historyPanel(app);
    return propertiesPanel(app);
}

/* ---------- Properties ---------- */

async function propertiesPanel(app) {
    const { state } = app;
    const note = state.note;
    const detail = note.detail ?? {};
    const properties = detail.properties ?? {};
    const out = [];
    if (detail.propertiesError) {
        out.push(notice(`The properties block at the top of this note could not be read: ${detail.propertiesError}. Your text is untouched; fix it in Write view.`, 'warning'));
    }
    out.push(section('Favourite',
        button(detail.favourite ? 'Remove from favourites' : 'Add to favourites', async () => {
            const result = await app.request('/notes/favourite', { operationId: newOperationId('fav'), notebookId: state.notebookId, noteId: note.id, favourite: !detail.favourite });
            if (app.failed(result)) return;
            await app.reloadNote();
            await app.refreshTree();
        }, { icon: 'fa-star', pressed: Boolean(detail.favourite) })));

    const folderInput = h('input', { id: 'notes-prop-folder', class: 'text_pole notes-input', value: note.folder ?? '', placeholder: 'Top level' });
    out.push(section('Folder', field('Folder', folderInput, 'Moving keeps the note and updates links that point to it.'),
        button('Move', async () => {
            const folder = folderInput.value.trim().replace(/^\/+|\/+$/g, '');
            if (folder === (note.folder ?? '')) return;
            if (!(await app.flushSave())) return app.toast('warning', 'Save the note first, then move it.');
            await app.moveNote({ title: stemOf(note.path), folder });
        }, { icon: 'fa-folder-open' })));

    const tags = h('input', { id: 'notes-prop-tags', class: 'text_pole notes-input', value: listText(properties.tags ?? properties.tag ?? []), placeholder: 'idea, magic' });
    const aliases = h('input', { id: 'notes-prop-aliases', class: 'text_pole notes-input', value: listText(properties.aliases ?? properties.alias ?? []), placeholder: 'Other names' });
    const type = h('input', { id: 'notes-prop-type', class: 'text_pole notes-input', value: listText(properties.type ?? ''), placeholder: 'location, character...' });
    const custom = [];
    const customRows = h('div', { class: 'notes-prop-custom' });
    for (const [key, value] of Object.entries(properties)) {
        if (RESERVED_PROPERTIES.has(key.toLowerCase())) continue;
        const input = h('input', { id: `notes-prop-${custom.length}`, class: 'text_pole notes-input', value: listText(value) });
        custom.push({ key, input, list: Array.isArray(value) });
        customRows.append(field(key, input, Array.isArray(value) ? 'A list: separate items with commas.' : null));
    }
    const newKey = h('input', { id: 'notes-prop-new-key', class: 'text_pole notes-input', placeholder: 'Field name' });
    const newValue = h('input', { id: 'notes-prop-new-value', class: 'text_pole notes-input', placeholder: 'Value' });
    const save = async () => {
        const set = {
            tags: splitList(tags.value).length ? splitList(tags.value) : null,
            aliases: splitList(aliases.value).length ? splitList(aliases.value) : null,
            type: type.value.trim() || null,
        };
        for (const item of custom) {
            const raw = item.input.value.trim();
            set[item.key] = raw === '' ? null : item.list ? splitList(raw) : raw;
        }
        if (newKey.value.trim()) set[newKey.value.trim()] = newValue.value.trim() || null;
        const result = await app.changeNote([{ type: 'properties', set }], 'edit');
        if (result) app.toast('success', 'Properties saved.');
    };
    out.push(section('Properties',
        notice('All optional. They are stored at the top of the note, so other Markdown apps can read them too.'),
        field('Tags', tags, 'Separate tags with commas.'), field('Other names', aliases, 'Links using these names find this note.'), field('Type', type),
        customRows,
        h('div', { class: 'notes-prop-new' }, field('New field', newKey), field('Value', newValue)),
        detail.complexProperties?.length ? notice(`Kept exactly as written (edit in Write view): ${detail.complexProperties.join(', ')}.`) : null,
        button('Save properties', save, { icon: 'fa-floppy-disk', className: 'notes-primary' })));

    if (note.provenance?.length) {
        out.push(section('Where this came from', h('ul', { class: 'notes-plain-list' },
            ...note.provenance.map(item => h('li', { text: item.kind === 'chat'
                ? `Saved from a chat${item.speaker ? ` (${item.speaker})` : ''} on ${formatTime(item.capturedAt ?? item.at)}. The copy here stays even if the message changes.`
                : `${item.kind ?? 'Source'} on ${formatTime(item.at)}` })))));
    }

    const files = await app.request('/attachments/list', { notebookId: state.notebookId });
    if (!app.failed(files) && files.attachments?.length) {
        out.push(section('Files in this notebook', h('ul', { class: 'notes-plain-list' }, ...files.attachments.map(file => h('li', { class: 'notes-file-row' },
            h('span', { text: `${file.name ?? file.path} (${formatBytes(file.size)})${file.references ? `, used by ${file.references} note(s)` : ''}` }),
            button('Remove', async () => {
                const result = await app.request('/attachments/trash', { operationId: newOperationId('att'), notebookId: state.notebookId, path: file.path });
                if (result.code === 'ATTACHMENT_IN_USE') return app.toast('warning', 'That file is still used by a note, so it was kept.');
                if (app.failed(result)) return;
                app.toast('success', 'File moved to the notebook\'s file bin.');
                void renderDetails(app);
            }, { icon: 'fa-trash-can', disabled: Boolean(file.references) }))))));
    }
    return out;
}

/* ---------- Links ---------- */

function jumpTo(app, offset) {
    const textarea = app.elements.textarea;
    app.setView?.('write');
    app.setPane('note');
    textarea.focus();
    textarea.setSelectionRange(offset, offset);
    const line = textarea.value.slice(0, offset).split('\n').length;
    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
    textarea.scrollTop = Math.max(0, (line - 3) * lineHeight);
}

async function linksPanel(app) {
    const { state } = app;
    const note = state.note;
    const out = [];
    const outline = headingOutline(app.elements.textarea?.value ?? '');
    out.push(section('Outline', outline.length
        ? h('ul', { class: 'notes-outline-list' }, ...outline.map(item => h('li', { style: `--notes-outline-level: ${item.level - 1}` },
            button(item.text || '(untitled heading)', () => jumpTo(app, item.offset), { className: 'notes-outline-item notes-quiet' }))))
        : notice('Add headings (start a line with #) to see an outline here.')));

    const links = await app.request('/links', { notebookId: state.notebookId, noteId: note.id });
    if (app.failed(links)) return out;
    const outgoing = links.outgoing ?? [];
    out.push(section('Links from this note', outgoing.length ? h('ul', { class: 'notes-plain-list' }, ...outgoing.map(link => {
        const label = link.label || link.target || link.raw;
        if (link.status === 'resolved') {
            return h('li', {}, button(link.title || label, () => void app.openNote(state.notebookId, link.noteId, { pushBack: true, fragment: link.fragment }),
                { icon: link.embed ? 'fa-paperclip' : 'fa-link', className: 'notes-quiet' }));
        }
        if (link.status === 'ambiguous') {
            return h('li', {}, h('span', { text: `${label}: more than one note matches. ` }), button('Choose', async () => {
                const choice = await app.dialogs.chooseNote(app, `Which note does "${label}" mean?`, link.candidates ?? []);
                if (choice) await app.openNote(state.notebookId, choice.id, { pushBack: true });
            }));
        }
        if (link.status === 'missing') {
            return h('li', { class: 'notes-link-broken' }, h('span', { text: `${label}: no note with this name yet. ` }), button('Create it', async () => {
                const parts = String(link.target ?? label).split('/');
                const title = parts.pop();
                const created = await app.createNote({ folder: parts.length ? parts.join('/') : (note.folder || 'Inbox'), title });
                if (created) await app.openNote(state.notebookId, created.noteId, { pushBack: true });
            }, { icon: 'fa-file-circle-plus' }));
        }
        if (link.status === 'external') return h('li', { text: `Web link: ${link.target ?? label}` });
        if (link.status === 'attachment') return h('li', { text: `File: ${link.path ?? label}` });
        return h('li', { text: label });
    })) : notice('This note does not link to anything yet. Type [[ to link a note.')));

    const backlinks = links.backlinks ?? [];
    out.push(section('Notes that link here', backlinks.length ? h('ul', { class: 'notes-plain-list' }, ...backlinks.map(item => h('li', { class: 'notes-backlink' },
        button(item.title, () => void app.openNote(state.notebookId, item.id, { pushBack: true }), { icon: 'fa-arrow-left-long', className: 'notes-quiet' }),
        ...(item.passages ?? []).slice(0, 3).map(passage => h('blockquote', { class: 'notes-excerpt', text: passage.excerpt })))))
        : notice('No other note links here yet.')));
    return out;
}

/* ---------- Lore ---------- */

async function pickBook(app, message) {
    const books = await app.request('/lore/books', {});
    if (app.failed(books)) return null;
    if (!books.books?.length) {
        app.toast('info', 'There are no lorebooks yet. Create one in Lorebooks first.');
        return null;
    }
    let chosen = null;
    let ref = null;
    const list = h('ul', { class: 'notes-plain-list notes-link-results' });
    for (const name of books.books) {
        list.append(h('li', {}, button(name, () => { chosen = name; ref?.completeAffirmative(); }, { icon: 'fa-book-atlas', className: 'notes-quiet' })));
    }
    await callGenericPopup(h('div', { class: 'notes-dialog' }, h('p', { text: message }), list), POPUP_TYPE.TEXT, '',
        { wide: true, okButton: 'Close', onOpen: value => { ref = value; } });
    return chosen;
}

async function pickEntry(app, book, { allowNew = false } = {}) {
    const entries = await app.request('/lore/entries', { book });
    if (app.failed(entries)) return null;
    let chosen = null;
    let ref = null;
    const list = h('ul', { class: 'notes-plain-list notes-link-results' });
    if (allowNew) list.append(h('li', {}, button('New entry', () => { chosen = { uid: null }; ref?.completeAffirmative(); }, { icon: 'fa-plus', className: 'notes-primary' })));
    for (const entry of entries.entries ?? []) {
        list.append(h('li', {}, button(`${entry.title || `Entry ${entry.uid}`}${entry.disabled ? ' (disabled)' : ''}`, () => {
            chosen = entry;
            ref?.completeAffirmative();
        }, { className: 'notes-quiet' })));
    }
    await callGenericPopup(h('div', { class: 'notes-dialog' }, h('p', { text: `Choose an entry in ${book}.` }), list), POPUP_TYPE.TEXT, '',
        { wide: true, okButton: 'Close', onOpen: value => { ref = value; } });
    return chosen;
}

function selectorChoices(app) {
    const headings = app.state.note.detail?.headings ?? [];
    return [{ label: 'Whole note', selector: { kind: 'note' } },
        ...headings.map(heading => ({ label: `${'  '.repeat(Math.max(0, heading.level - 1))}${heading.text}`,
            selector: heading.blockId ? { kind: 'block', id: heading.blockId } : { kind: 'heading', path: heading.path } }))];
}

async function chooseSelector(app, message) {
    let chosen = null;
    let ref = null;
    const list = h('ul', { class: 'notes-plain-list notes-link-results' });
    for (const choice of selectorChoices(app)) {
        list.append(h('li', {}, button(choice.label, () => { chosen = choice.selector; ref?.completeAffirmative(); }, { className: 'notes-quiet notes-pre' })));
    }
    await callGenericPopup(h('div', { class: 'notes-dialog' }, h('p', { text: message }), list), POPUP_TYPE.TEXT, '',
        { wide: true, okButton: 'Close', onOpen: value => { ref = value; } });
    return chosen;
}

async function publishFlow(app, { selector = null, book = null, uid = undefined, title = '' } = {}) {
    const { state } = app;
    if (!(await app.flushSave())) return app.toast('warning', 'Save the note first, then publish it.');
    selector ??= await chooseSelector(app, 'Which part of this note should become lore? Only that part is published.');
    if (!selector) return;
    book ??= await pickBook(app, 'Publish into which lorebook?');
    if (!book) return;
    if (uid === undefined) {
        const entry = await pickEntry(app, book, { allowNew: true });
        if (!entry) return;
        uid = entry.uid;
    }
    if (uid === null && !title) title = selector.kind === 'note' ? state.note.title : (selector.path?.at(-1) ?? state.note.title);
    const previewResult = await app.request('/lore/preview', { notebookId: state.notebookId, noteId: state.note.id, selector, book, uid, title });
    if (app.failed(previewResult, 'The preview could not be made.')) return;
    const preview = previewResult.preview;
    const view = h('div', { class: 'notes-dialog notes-publish-preview' },
        h('h3', { text: preview.createsEntry ? `Create "${preview.entryTitle}" in ${preview.book}` : `Update "${preview.entryTitle}" in ${preview.book}` }),
        h('p', { text: `From: ${preview.noteTitle}, ${preview.selectorLabel}` }),
        h('p', { class: 'notes-hint', text: 'Exactly this text becomes the entry\'s content:' }),
        h('pre', { class: 'notes-diff', text: preview.after || '(empty)' }),
        preview.before && !preview.createsEntry ? h('details', {}, h('summary', { text: 'Current entry text' }), h('pre', { class: 'notes-diff', text: preview.before })) : null,
        h('p', { text: preview.createsEntry
            ? 'A new entry is made with ordinary settings and no keywords. Add keywords in the lorebook editor when you are ready.'
            : `Kept as they are: ${(preview.preserved ?? []).slice(0, 12).join(', ') || 'all other settings'}.` }),
        notice(`Published is not the same as active. This entry is ${preview.enabled ? 'enabled' : 'disabled'}, and the lorebook is only used in chats where it is switched on. Your note stays a private draft.`));
    const { ok } = await dialog(view, { okButton: 'Publish', cancelButton: 'Not now', large: true });
    if (!ok) return;
    const result = await app.request('/lore/publish', { operationId: newOperationId('publish'), notebookId: state.notebookId, noteId: state.note.id,
        selector, book, uid: preview.uid ?? uid, title, expectedSourceHash: preview.sourceHash, expectedTargetHash: preview.targetHash });
    if (app.failed(result, 'Publishing did not finish. Nothing was overwritten.')) return;
    app.toast('success', `Published to ${result.book}: ${result.entryTitle}`);
    await refreshWorldInfo(result.book);
    void renderDetails(app);
}

async function entryPage(app, book, uid) {
    const read = await app.request('/lore/page/read', { book, uid });
    if (app.failed(read)) return;
    let page = read.page;
    const comment = h('input', { id: 'notes-page-title', class: 'text_pole notes-input', value: page.comment ?? '' });
    const content = h('textarea', { id: 'notes-page-content', class: 'text_pole notes-page-source', value: page.content ?? '', rows: 14, spellcheck: 'true' });
    const status = h('p', { class: 'notes-hint', role: 'status' });
    const save = async () => {
        const result = await app.request('/lore/page/save', { operationId: newOperationId('page'), book, uid, expectedEntryHash: page.entryHash, content: content.value, comment: comment.value });
        if (result.code === 'LORE_TARGET_CHANGED') {
            status.textContent = 'This entry changed elsewhere. Your text is still here; reopen the page to see the newer version.';
            return;
        }
        if (app.failed(result, 'The entry could not be saved.')) return;
        const fresh = await app.request('/lore/page/read', { book, uid });
        if (!app.failed(fresh)) page = fresh.page;
        status.textContent = result.status === 'no_change' ? 'Nothing changed.' : 'Saved to the live lorebook entry.';
        await refreshWorldInfo(book);
    };
    const view = h('div', { class: 'notes-dialog notes-entry-page' },
        h('p', { class: 'notes-live-badge', text: `Live World Info: ${book}` }),
        notice('You are editing the real lorebook entry, not a copy. Keywords and activation settings stay as they are; change them in the lorebook editor.'),
        h('p', { class: 'notes-hint', text: `Keywords: ${(page.keys ?? []).join(', ') || 'none'}. ${page.enabled ? 'Enabled' : 'Disabled'}${page.constant ? ', always on' : ''}.` }),
        field('Entry name', comment), field('Entry text', content), status,
        h('div', { class: 'notes-nav-actions' },
            button('Save entry', save, { icon: 'fa-floppy-disk', className: 'notes-primary' }),
            button('Make a note copy', async () => {
                const copy = await app.request('/lore/page/copy', { operationId: newOperationId('copy'), notebookId: app.state.notebookId, folder: 'Inbox', book, uid });
                if (app.failed(copy)) return;
                app.toast('success', 'Saved a separate note copy. Editing it will not change the lorebook.');
                await app.refreshTree();
                await app.openNote(app.state.notebookId, copy.noteId, { pushBack: true });
            }, { icon: 'fa-copy' }),
            button('Open in lorebook editor', async () => {
                try {
                    const worldInfo = await import('../world-info.js');
                    await worldInfo.openWorldInfoEditor?.(book);
                } catch {
                    app.toast('warning', 'The lorebook editor could not be opened.');
                }
            }, { icon: 'fa-book-atlas' })));
    await callGenericPopup(view, POPUP_TYPE.TEXT, '', { wide: true, large: true, okButton: 'Close' });
}

async function lorePanel(app) {
    const { state } = app;
    const note = state.note;
    const out = [];
    const associations = note.associations ?? [];
    const saveAssociations = async next => {
        const result = await app.request('/notes/associations', { operationId: newOperationId('assoc'), notebookId: state.notebookId, noteId: note.id, associations: next });
        if (app.failed(result)) return;
        await app.reloadNote();
        void renderDetails(app);
    };
    const add = item => {
        if (associations.some(existing => existing.kind === item.kind && existing.id === item.id && existing.uid === item.uid)) return;
        void saveAssociations([...associations, item]);
    };
    const scope = app.chatScope();
    out.push(section('Related to',
        notice('Related items are for finding things. They do not share this note with AI, publish it, or put it into any prompt.'),
        associations.length ? h('ul', { class: 'notes-plain-list' }, ...associations.map((item, index) => h('li', { class: 'notes-file-row' },
            item.kind === 'lore-entry'
                ? button(`Lore entry: ${item.label || item.id}`, () => void entryPage(app, item.id, item.uid), { className: 'notes-quiet' })
                : h('span', { text: `${{ lorebook: 'Lorebook', character: 'Character', chat: 'Chat' }[item.kind] ?? item.kind}: ${item.label || item.id}` }),
            button('Remove', () => void saveAssociations(associations.filter((_, at) => at !== index)), { icon: 'fa-xmark', title: 'Remove this link' }))))
            : null,
        h('div', { class: 'notes-nav-actions notes-wrap' },
            scope ? button('This chat', () => add({ kind: 'chat', id: scope.chat, label: `Chat with ${scope.characterName ?? 'group'}` }), { icon: 'fa-comments' }) : null,
            scope?.character ? button('This character', () => add({ kind: 'character', id: scope.character, label: scope.characterName ?? scope.character }), { icon: 'fa-address-card' }) : null,
            button('A lorebook', async () => {
                const book = await pickBook(app, 'Which lorebook is this note related to?');
                if (book) add({ kind: 'lorebook', id: book, label: book });
            }, { icon: 'fa-book-atlas' }),
            button('A lore entry', async () => {
                const book = await pickBook(app, 'Which lorebook holds the entry?');
                const entry = book ? await pickEntry(app, book) : null;
                if (entry) add({ kind: 'lore-entry', id: book, uid: Number(entry.uid), label: `${entry.title || entry.uid} (${book})` });
            }, { icon: 'fa-bookmark' }))));

    const bindings = await app.request('/lore/bindings', { notebookId: state.notebookId, noteId: note.id });
    const list = app.failed(bindings) ? [] : bindings.bindings ?? [];
    out.push(section('Published as lore',
        notice('Saving this note never changes lore by itself. Choose Use as lore to publish one section or the whole note.'),
        list.length ? h('ul', { class: 'notes-plain-list notes-bindings' }, ...list.map(binding => bindingRow(app, binding))) : null,
        h('div', { class: 'notes-nav-actions notes-wrap' },
            button('Use as lore', () => void publishFlow(app), { icon: 'fa-book-medical', className: 'notes-primary' }),
            button('Open a lore entry as a page', async () => {
                const book = await pickBook(app, 'Open an entry from which lorebook?');
                const entry = book ? await pickEntry(app, book) : null;
                if (entry) await entryPage(app, book, Number(entry.uid));
            }, { icon: 'fa-file-lines' }))));
    return out;
}

function bindingRow(app, binding) {
    const { state } = app;
    const [label, explanation] = LORE_STATUS[binding.status] ?? [binding.status, ''];
    const act = async (route, body, success) => {
        const result = await app.request(route, { operationId: newOperationId('lore'), notebookId: state.notebookId, bindingId: binding.id, ...body });
        if (app.failed(result)) return;
        if (success) app.toast('success', success);
        if (route === '/lore/pull') await app.reloadNote();
        await refreshWorldInfo(binding.book);
        void renderDetails(app);
    };
    const compare = (title, before, after) => void app.compareTexts(title, before ?? '', after ?? '');
    const actions = [];
    const update = () => void publishFlow(app, { selector: binding.selector, book: binding.book, uid: binding.uid, title: binding.entryTitle });
    if (['draft_changed', 'conflict', 'failed'].includes(binding.status)) {
        actions.push(button('Review changes', () => compare('Last published (-) and your draft now (+)', binding.publishedSourceText, binding.sourceText), { icon: 'fa-code-compare' }));
        actions.push(button(binding.status === 'conflict' ? 'Publish my draft' : 'Update lore', update, { icon: 'fa-upload', className: 'notes-primary' }));
    }
    if (['lore_changed', 'conflict'].includes(binding.status)) {
        actions.push(button('See lore edits', () => compare('Last published (-) and the lore entry now (+)', binding.publishedTargetText, binding.loreText), { icon: 'fa-code-compare' }));
        actions.push(button('Copy lore into note', async () => {
            if (!(await app.flushSave())) return app.toast('warning', 'Save the note first.');
            const ok = await dialog(h('p', { text: `Replace "${binding.selectorLabel}" in this note with the lore entry's text? Other sections are not touched, and history keeps the old text.` }),
                { okButton: 'Copy into note', cancelButton: 'Not now' });
            if (ok.ok) await act('/lore/pull', { expectedRevision: state.note.revision, expectedLoreHash: binding.loreHash }, 'The note section now matches the lore entry.');
        }, { icon: 'fa-download' }));
        if (binding.status === 'lore_changed') actions.push(button('Keep lore as it is', () => app.toast('info', 'Nothing was changed. The lore entry keeps its own edits.'), { icon: 'fa-check' }));
    }
    if (['source_missing', 'selector_unresolved'].includes(binding.status)) {
        actions.push(button('Pick the section again', async () => {
            const selector = await chooseSelector(app, 'Which part of this note should this lore entry follow?');
            if (selector) await act('/lore/repair', { selector }, 'Fixed. Review and update lore when ready.');
        }, { icon: 'fa-wrench' }));
    }
    if (binding.status === 'target_missing') actions.push(button('Publish as a new entry', () => void publishFlow(app, { selector: binding.selector, book: binding.book, uid: null, title: binding.entryTitle }), { icon: 'fa-plus' }));
    if (binding.status !== 'target_missing') actions.push(button('Open entry', () => void entryPage(app, binding.book, binding.uid), { icon: 'fa-file-lines' }));
    actions.push(button(binding.policy === 'live' ? 'Stop updating automatically' : 'Keep lore updated when I save', () => void act('/lore/policy', {
        policy: binding.policy === 'live' ? 'manual' : 'live', liveOrigins: ['user'],
    }, binding.policy === 'live' ? 'Lore now updates only when you choose Update lore.' : 'Your own saves now update this entry. Assistant and imported changes still wait for review.'),
    { icon: 'fa-rotate', pressed: binding.policy === 'live' }));
    actions.push(button('Detach', async () => {
        const ok = await dialog(h('p', { text: 'Detach this note from the lore entry? Both keep their current text; they just stop being linked.' }), { okButton: 'Detach', cancelButton: 'Not now' });
        if (ok.ok) await act('/lore/detach', {}, 'Detached. Nothing was deleted.');
    }, { icon: 'fa-link-slash' }));
    return h('li', { class: 'notes-binding', dataset: { status: binding.status } },
        h('p', { class: 'notes-binding-title', text: `${binding.selectorLabel} → ${binding.book}: ${binding.entryTitle ?? `entry ${binding.uid}`}` }),
        h('p', { class: 'notes-binding-status', text: `${label}. ${explanation}` }),
        h('p', { class: 'notes-hint', text: [binding.publishedAt ? `Published ${formatTime(binding.publishedAt)}` : null,
            binding.enabled === false ? 'entry disabled' : binding.enabled ? 'entry enabled' : null,
            binding.policy === 'live' ? 'updates when you save' : 'updates only when you choose'].filter(Boolean).join(', ') }),
        binding.lastError ? notice(`Last attempt: ${binding.lastError.message ?? binding.lastError.code ?? binding.lastError}`, 'warning') : null,
        h('div', { class: 'notes-nav-actions notes-wrap' }, ...actions));
}

/* ---------- AI access ---------- */

async function aiPanel(app) {
    const { state } = app;
    const got = await app.request('/policies/get', { notebookId: state.notebookId });
    if (app.failed(got)) return [notice('AI settings could not be loaded.', 'warning')];
    const policy = got.policy;
    const update = async (patch, message) => {
        const result = await app.request('/policies/update', { notebookId: state.notebookId, expectedRevision: policy.revision, patch });
        if (app.failed(result, 'The setting was not changed.')) return;
        if (message) app.toast('success', message);
        void renderDetails(app);
    };
    const out = [notice('Notes are private by default. Saving a note does not share it with any AI. Each setting below is separate.')];
    if (policy.admitted === false) {
        out.push(section('Imported notebook',
            notice('This notebook was imported, so AI access stays off until you allow it here. Settings inside imported files are never trusted.', 'warning'),
            button('Allow AI settings for this notebook', () => void update({ admitted: true }, 'You can now choose AI settings for this notebook.'), { icon: 'fa-unlock' })));
    } else {
        out.push(section('Assistant access to this notebook',
            choiceRow('Assistants can', [['none', 'Nothing'], ['read', 'Read'], ['edit', 'Read and suggest edits']], policy.configuredAssistant ?? policy.assistant,
                value => void update({ assistant: value })),
            notice('Suggested edits wait for your review before anything is saved.'),
            h('label', { class: 'notes-check' }, h('input', { type: 'checkbox', checked: Boolean(policy.assistantPublish),
                onChange: event => void update({ assistantPublish: event.target.checked }) }), h('span', { text: 'Let assistants suggest publishing to lore (always reviewed)' })),
            h('label', { class: 'notes-check' }, h('input', { type: 'checkbox', checked: Boolean(policy.requestedEdits),
                onChange: event => void update({ requestedEdits: event.target.checked ? { operations: ['create', 'append', 'edit'], hours: 8 } : null }) }),
            h('span', { text: 'Allow assistants to save changes I request, without a review step' })),
            policy.requestedEdits ? notice(`On until ${formatTime(policy.requestedEdits.expiresAt)}. Covers new notes, additions and edits in this notebook only. Publishing lore always needs review.`) : null));
    }
    const note = state.note;
    if (note && policy.admitted !== false) {
        const notePolicy = policy.notes?.[note.id] ?? {};
        out.push(section('This note',
            choiceRow('Assistants can', [['inherit', 'Same as notebook'], ['none', 'Nothing'], ['read', 'Read'], ['edit', 'Suggest edits']], notePolicy.assistant ?? 'inherit',
                value => void update({ notes: { [note.id]: { assistant: value } } })),
            h('div', { class: 'notes-nav-actions notes-wrap' },
                button('Share selected text once', () => void shareOnce(app, 'selection'), { icon: 'fa-highlighter' }),
                button('Share this note once', () => void shareOnce(app, 'note'), { icon: 'fa-share' })),
            notice('Sharing once lets an assistant see only that text for 30 minutes. It does not change the settings above.')));
        out.push(contextSection(app, note, notePolicy.context ?? { mode: 'off', scopes: [] }, update));
    }
    const waiting = await app.request('/assistant/proposals', { notebookId: state.notebookId, state: 'waiting' });
    const proposals = app.failed(waiting) ? [] : waiting.proposals ?? [];
    out.push(section('Assistant changes waiting for you', proposals.length
        ? h('ul', { class: 'notes-plain-list' }, ...proposals.map(item => h('li', { class: 'notes-file-row' },
            h('span', { text: `${item.summary?.label ?? 'Change'} (not saved yet)` }),
            button('Review', async () => { await app.dialogs.reviewProposal(app, item.id); void renderDetails(app); }, { icon: 'fa-eye' }))))
        : notice('Nothing is waiting.')));
    out.push(notice('Turning access off stops future use. It cannot take back text an AI has already been sent, and files on the server are not encrypted.'));
    return out;
}

function contextSection(app, note, context, update) {
    const scope = app.chatScope();
    const scopes = [...(context.scopes ?? [])];
    const has = (kind, id) => scopes.some(item => item.kind === kind && item.id === id);
    const toggle = (kind, id, on) => {
        const next = scopes.filter(item => !(item.kind === kind && item.id === id));
        if (on) next.push({ kind, id });
        return next;
    };
    const setContext = (mode, nextScopes) => {
        if (mode !== 'off' && !nextScopes.length) {
            if (!scope) return app.toast('info', 'Open a chat first, or choose Everywhere.');
            nextScopes = [{ kind: 'chat', id: scope.chat }];
        }
        void update({ notes: { [note.id]: { context: mode === 'off' ? null : { mode, scopes: nextScopes, order: context.order ?? 0 } } } });
    };
    const scopeBox = (label, kind, id) => h('label', { class: 'notes-check' }, h('input', { type: 'checkbox', checked: has(kind, id),
        onChange: event => setContext(context.mode === 'off' ? 'reference' : context.mode, toggle(kind, id, event.target.checked)) }), h('span', { text: label }));
    return section('Use in roleplay replies',
        choiceRow('This note is', [['off', 'Not used'], ['reference', 'Available as reference'], ['pinned', 'Pinned']], context.mode ?? 'off',
            value => setContext(value, scopes)),
        notice(context.mode === 'pinned'
            ? 'The whole note is added to replies in the chosen places. If it does not fit, it is left out and reported, never cut short.'
            : context.mode === 'reference'
                ? 'Matching parts may be added when the chat mentions them, only in the chosen places.'
                : 'Never sent to the roleplay model, memory tools or any other AI.'),
        context.mode !== 'off' ? h('div', { class: 'notes-scope-list' },
            scope ? scopeBox('This chat', 'chat', scope.chat) : null,
            scope?.character ? scopeBox(`This character (${scope.characterName ?? scope.character})`, 'character', scope.character) : null,
            scopeBox('Everywhere', 'global', '*'),
            ...scopes.filter(item => !(scope && ((item.kind === 'chat' && item.id === scope.chat) || (item.kind === 'character' && item.id === scope.character))) && item.kind !== 'global')
                .map(item => scopeBox(`${item.kind}: ${item.id}`, item.kind, item.id))) : null,
        notice('Parts of this note already published as lore reach replies through the lorebook only, never twice.'),
        scope ? button('Preview for this chat', () => void contextPreview(app, scope), { icon: 'fa-magnifying-glass' }) : null);
}

async function contextPreview(app, scope) {
    const [preview, inspect] = await Promise.all([
        app.request('/context/preview', { scope: { chat: scope.chat, character: scope.character, lorebooks: [] }, budgetTokens: 2000, query: '' }),
        app.request('/context/inspect', { chat: scope.chat, limit: 5 }),
    ]);
    if (app.failed(preview)) return;
    const view = h('div', { class: 'notes-dialog' },
        h('p', { text: `Pinned notes for this chat use about ${preview.usedTokens} of ${preview.budgetTokens} tokens (estimated as characters divided by 4). Reference notes are matched against the latest messages when a reply is written.` }),
        preview.items?.length ? h('ul', { class: 'notes-plain-list' }, ...preview.items.map(item => h('li', { text: `${item.title}${item.section ? ` (${item.section})` : ''}: ${item.mode}, about ${item.tokens} tokens` }))) : h('p', { text: 'Nothing pinned would be added right now.' }),
        preview.overflow?.length ? notice(`Left out because they do not fit: ${preview.overflow.map(item => item.title).join(', ')}.`, 'warning') : null,
        preview.withheld?.length ? notice(`Held back because they are linked to lore that needs repair: ${preview.withheld.map(item => item.title).join(', ')}.`) : null,
        preview.excludedBound?.length ? h('p', { class: 'notes-hint', text: `Sent through the lorebook instead: ${preview.excludedBound.map(item => `${item.title} (${item.regions.join(', ')})`).join('; ')}.` }) : null,
        !app.failed(inspect) && inspect.records?.length ? h('details', {}, h('summary', { text: 'Used in recent replies' }),
            h('ul', { class: 'notes-plain-list' }, ...inspect.records.map(record => h('li', { text: `${formatTime(record.at)}: ${(record.items ?? []).map(item => `${item.title} (${item.mode}, revision ${String(item.revision).slice(0, 8)})`).join(', ') || 'no notes'}` }))))
            : null);
    await callGenericPopup(view, POPUP_TYPE.TEXT, '', { wide: true, okButton: 'Close' });
}

async function shareOnce(app, scope) {
    const { state, elements } = app;
    if (!(await app.flushSave())) return app.toast('warning', 'Save the note first.');
    const textarea = elements.textarea;
    const body = { notebookId: state.notebookId, noteId: state.note.id, scope, operations: ['read'], minutes: 30 };
    if (scope === 'selection') {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        if (start === end) return app.toast('info', 'Select some text in the note first.');
        body.selection = { start, end };
        body.operations = ['read', 'edit'];
    }
    const result = await app.request('/assistant/grants/create', body);
    if (app.failed(result, 'Sharing failed.')) return;
    const grant = result.grant;
    const message = `Please read my note "${state.note.title}" with ReadNote (notebookId ${state.notebookId}, noteId ${state.note.id}, grantId ${grant.id}).`;
    const input = document.getElementById('send_textarea');
    if (input) {
        input.value = input.value ? `${input.value}\n${message}` : message;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    app.toast('success', `Shared for 30 minutes. A message for the assistant was ${input ? 'added to the chat box' : 'prepared'}.`);
}

/* ---------- History ---------- */

async function historyPanel(app) {
    const { state } = app;
    const note = state.note;
    const result = await app.request('/notes/history', { notebookId: state.notebookId, noteId: note.id });
    if (app.failed(result)) return [];
    const entries = result.history ?? [];
    return [section('Earlier versions',
        notice('Typing is grouped into one version every few minutes. Assistant edits, restores and changes made outside Neconyan always keep the version before them.'),
        entries.length ? h('ul', { class: 'notes-plain-list notes-history' }, ...entries.map((entry, index) => h('li', { class: 'notes-file-row' },
            h('span', { text: `${formatTime(entry.at)}: ${ORIGIN_LABEL[entry.origin] ?? entry.origin ?? 'You'}${entry.reason && entry.reason !== 'autosave' ? `, ${entry.reason}` : ''}${entry.saves > 1 ? ` (${entry.saves} saves)` : ''}${index === 0 && entry.revision === note.revision ? ', current' : ''}` }),
            index === 0 && entry.revision === note.revision ? null : button('View', () => void viewRevision(app, entry), { icon: 'fa-clock-rotate-left' }))))
            : notice('No earlier versions yet.'))];
}

async function viewRevision(app, entry) {
    const { state } = app;
    const read = await app.request('/notes/history/read', { notebookId: state.notebookId, noteId: state.note.id, historyId: entry.id, full: true });
    if (app.failed(read)) return;
    const current = app.elements.textarea.value;
    const view = h('div', { class: 'notes-dialog' },
        h('p', { text: `Version from ${formatTime(read.at)}. Lines marked - are in the note now; lines marked + are in this version.` }),
        h('pre', { class: 'notes-diff', text: formatDiff(current, read.text ?? '') || '(identical)' }));
    const { ok, result } = await dialog(view, { okButton: 'Restore this version', cancelButton: 'Close', customButtons: ['Restore as a copy'], large: true });
    const asCopy = result === 2;
    if (!ok && !asCopy) return;
    if (!(await app.flushSave())) return app.toast('warning', 'Save the note first.');
    const restored = await app.request('/notes/history/restore', { operationId: newOperationId('restore'), notebookId: state.notebookId, noteId: state.note.id,
        historyId: entry.id, expectedRevision: state.note.revision, asCopy });
    if (restored.code === 'NOTE_CONFLICT') return app.toast('warning', 'The note changed meanwhile. Choose Restore as a copy to keep both.');
    if (app.failed(restored, 'The version could not be restored.')) return;
    if (asCopy) {
        app.toast('success', 'Restored into a separate copy.');
        await app.refreshTree();
        await app.openNote(state.notebookId, restored.noteId, { pushBack: true });
        return;
    }
    app.toast('success', 'Restored. The version before is kept in history too.');
    await app.reloadNote();
    void renderDetails(app);
}
