import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../popup.js';
import { buildNoteProposalReview } from '../neconyan-assistant-review.js';
import { newOperationId, notesDownload, notesUpload } from './api.js';
import { button, choiceRow, clear, field, formatTime, h } from './dom.js';
import { formatDiff } from './line-diff.js';
import { NOTE_TEMPLATES, templateById } from './templates.js';

/* Small dialogs used by the Notes workspace. User text is always placed with textContent. */

let fieldCounter = 0;
const fieldId = prefix => `notes-${prefix}-${++fieldCounter}`;

async function dialog(content, options = {}) {
    let popup = null;
    const result = await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', {
        wide: true, ...options, onOpen: opened => { popup = opened; options.onOpen?.(opened); },
    });
    return { ok: result === POPUP_RESULT.AFFIRMATIVE, result, popup };
}

async function askText(message, value = '', okButton = 'Save') {
    const result = await callGenericPopup(h('div', { class: 'notes-dialog' }, h('p', { text: message })), POPUP_TYPE.INPUT, value, { okButton });
    return typeof result === 'string' ? result.trim() : null;
}

async function confirm(message, okButton = 'Yes', cancelButton = 'Not now') {
    const result = await callGenericPopup(h('div', { class: 'notes-dialog' }, h('p', { text: message })), POPUP_TYPE.CONFIRM, '', { okButton, cancelButton });
    return result === POPUP_RESULT.AFFIRMATIVE;
}

/** Opens the system file chooser. Call before any await so the browser keeps the user's tap. */
function pickFile(accept) {
    return new Promise(resolve => {
        const input = h('input', { type: 'file', accept, class: 'notes-hidden-input' });
        input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
        input.addEventListener('cancel', () => resolve(null), { once: true });
        input.click();
    });
}

function textInput(id, value = '', placeholder = '') {
    return h('input', { id, type: 'text', class: 'text_pole notes-input', value, placeholder, autocomplete: 'off' });
}

/* ---------- notebooks and folders ---------- */

export async function newNotebook(app) {
    const name = await askText('Name the new notebook.', '', 'Create notebook');
    if (!name) return;
    const result = await app.request('/create', { operationId: newOperationId('notebook'), name });
    if (app.failed(result, 'The notebook could not be created.')) return;
    await app.loadNotebooks(result.notebook?.id);
}

export async function renameNotebook(app) {
    const current = app.state.notebooks.find(item => item.id === app.state.notebookId);
    const name = await askText('Rename this notebook.', current?.name ?? '', 'Rename');
    if (!name || name === current?.name) return;
    const result = await app.request('/rename', { operationId: newOperationId('rename-notebook'), notebookId: app.state.notebookId, name });
    if (app.failed(result, 'The notebook could not be renamed.')) return;
    await app.loadNotebooks(app.state.notebookId);
}

export async function newFolder(app) {
    const base = app.state.folder ? `${app.state.folder}/` : '';
    const folder = await askText('Folder name. Use / to put it inside another folder.', base, 'Create folder');
    if (!folder) return;
    const result = await app.request('/folders/create', { operationId: newOperationId('folder'), notebookId: app.state.notebookId, folder });
    if (app.failed(result, 'The folder could not be created.')) return;
    await app.refreshTree();
}

export async function renameFolder(app, folder) {
    const to = await askText('New folder name. Links to notes inside it are updated where that is safe.', folder, 'Rename folder');
    if (!to || to === folder) return;
    const result = await app.request('/folders/move', { operationId: newOperationId('folder-move'), notebookId: app.state.notebookId, folder, to });
    if (app.failed(result, 'The folder could not be renamed.')) return;
    if (result.unresolved?.length) app.toast('info', `${result.unresolved.length} link(s) could not be updated safely and were left as they were.`);
    app.state.folder = to;
    await app.refreshTree();
    if (app.state.note) await app.reloadNote();
}

export async function deleteFolder(app, folder) {
    if (!(await confirm(`Remove the empty folder '${folder}'? Folders with notes in them are never removed.`, 'Remove folder'))) return;
    const result = await app.request('/folders/delete', { operationId: newOperationId('folder-delete'), notebookId: app.state.notebookId, folder });
    if (app.failed(result, 'Only empty folders can be removed.')) return;
    app.state.folder = null;
    await app.refreshTree();
}

/* ---------- creating notes ---------- */

export async function newNote(app) {
    const titleId = fieldId('title');
    const title = textInput(titleId, '', 'Untitled');
    let template = 'blank';
    const templates = choiceRow('Start from', NOTE_TEMPLATES.map(item => [item.id, item.label]), template, value => { template = value; });
    const folder = app.state.folder ?? 'Inbox';
    const content = h('div', { class: 'notes-dialog' },
        h('h3', { text: 'New note' }),
        field('Name', title, `It goes in ${folder}. You can rename or move it later.`),
        templates);
    const { ok } = await dialog(content, { okButton: 'Create note', cancelButton: 'Cancel', onOpen: () => title.focus() });
    if (!ok) return;
    const chosen = templateById(template);
    const created = await app.createNote({ folder, title: title.value.trim() || chosen?.title || '', text: chosen?.text ?? '', template });
    if (created) await app.openNote(app.state.notebookId, created.noteId, { pushBack: Boolean(app.state.note) });
}

export async function quickNote(app) {
    const id = fieldId('quick');
    const area = h('textarea', { id, class: 'text_pole notes-input notes-quick-input', rows: '6', placeholder: 'Type the thought. The first line becomes its name.' });
    const content = h('div', { class: 'notes-dialog' }, h('h3', { text: 'Quick note' }), field('Into the Inbox', area));
    const { ok } = await dialog(content, { okButton: 'Save to Inbox', cancelButton: 'Cancel', onOpen: () => area.focus() });
    const text = area.value;
    if (!ok || !text.trim()) return;
    const created = await app.createNote({ folder: 'Inbox', title: '', text });
    if (created) app.toast('success', `Saved to Inbox as '${created.title}'.`);
}

/* ---------- choosing and linking ---------- */

export async function chooseNote(app, message, candidates = []) {
    let chosen = null;
    let popup = null;
    const list = h('ul', { class: 'notes-list' }, ...candidates.map(candidate => h('li', { class: 'notes-list-item' },
        h('button', { type: 'button', class: 'menu_button notes-note-link', onclick: () => { chosen = candidate; popup?.completeAffirmative(); } },
            h('span', { class: 'notes-note-title', text: candidate.title ?? candidate.path }),
            h('span', { class: 'notes-note-meta', text: candidate.path ?? '' })))));
    const content = h('div', { class: 'notes-dialog' }, h('p', { text: message }), list);
    await callGenericPopup(content, POPUP_TYPE.TEXT, '', { wide: true, okButton: 'Cancel', onOpen: opened => { popup = opened; } });
    return chosen;
}

function linkLabel(note, notes) {
    const stem = note.path.replace(/\.md$/i, '');
    const name = stem.replace(/^.*\//, '');
    const duplicate = notes.filter(other => other.path.replace(/\.md$/i, '').replace(/^.*\//, '').toLocaleLowerCase() === name.toLocaleLowerCase()).length > 1;
    return duplicate ? stem : name;
}

export async function linkPicker(app) {
    const id = fieldId('link');
    const search = textInput(id, '', 'Search note names');
    const results = h('ul', { class: 'notes-list notes-link-results' });
    let popup = null;
    let found = [];
    const insert = note => {
        const label = linkLabel(note, found);
        popup?.completeCancelled();
        app.insertText(`[[${label}]]`);
    };
    const refresh = async () => {
        const response = await app.request('/suggest', { notebookId: app.state.notebookId, query: search.value });
        if (response.status !== 'success') return;
        found = response.notes ?? [];
        clear(results);
        if (!found.length) results.append(h('li', { class: 'notes-hint', text: search.value ? 'No note has that name. Type [[Name]] in the note to link to a note you will create later.' : 'No notes yet.' }));
        for (const note of found) {
            results.append(h('li', { class: 'notes-list-item' }, h('button', { type: 'button', class: 'menu_button notes-note-link', onclick: () => insert(note) },
                h('span', { class: 'notes-note-title', text: note.title }), h('span', { class: 'notes-note-meta', text: note.path }))));
        }
    };
    let timer = 0;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 200); });
    const content = h('div', { class: 'notes-dialog' }, h('h3', { text: 'Link to a note' }), field('Note', search), results);
    void refresh();
    await callGenericPopup(content, POPUP_TYPE.TEXT, '', { wide: true, okButton: 'Close', onOpen: opened => { popup = opened; search.focus(); } });
}

export async function uploadAttachment(app) {
    const picked = pickFile('image/*,.pdf,.txt,.csv,.json,.mp3,.ogg,.wav,.m4a,.mp4,.webm,.svg');
    const file = await picked;
    if (!file) return;
    if (!app.state.note) return;
    app.toast('info', `Uploading ${file.name}...`);
    const result = await notesUpload('/attachments/upload', { operationId: newOperationId('attach'), notebookId: app.state.notebookId, name: file.name, folder: 'attachments' }, file);
    if (app.failed(result, 'The file could not be added.')) return;
    const notePath = app.state.note.folder ? app.state.note.folder.split('/').map(() => '..').join('/') + '/' : '';
    const markdown = notePath ? result.markdown.replace(/\]\(/, `](${notePath}`) : result.markdown;
    app.insertText(markdown);
}

/* ---------- trash ---------- */

export async function trash(app) {
    const result = await app.request('/trash/list', { notebookId: app.state.notebookId });
    if (app.failed(result)) return;
    let popup = null;
    const items = result.trash ?? [];
    const list = h('ul', { class: 'notes-list' });
    const content = h('div', { class: 'notes-dialog' },
        h('h3', { text: 'Trash' }),
        h('p', { class: 'notes-hint', text: 'Deleted notes wait here until you restore them or delete them for good. Published lore is never removed with a note.' }),
        list);
    if (!items.length) list.append(h('li', { class: 'notes-hint', text: 'Trash is empty.' }));
    for (const item of items) {
        const row = h('li', { class: 'notes-list-item notes-trash-item' },
            h('span', { class: 'notes-note-title', text: item.title ?? item.path }),
            h('span', { class: 'notes-note-meta', text: `${item.path} - deleted ${formatTime(item.deletedAt)}${item.origin === 'external' ? ' outside Neconyan' : ''}` }),
            h('div', { class: 'notes-wrap' },
                button('Restore', async () => {
                    const restored = await app.request('/trash/restore', { operationId: newOperationId('restore'), notebookId: app.state.notebookId, trashId: item.id });
                    if (app.failed(restored, 'The note could not be restored.')) return;
                    popup?.completeCancelled();
                    await app.refreshTree();
                    if (restored.restoredAs ?? restored.noteId) await app.openNote(app.state.notebookId, restored.restoredAs ?? restored.noteId);
                }, { icon: 'fa-rotate-left' }),
                button('Delete forever', async () => {
                    if (!(await confirm(`Delete '${item.title ?? item.path}' for good? Its saved history is removed too. Backups made outside Neconyan may still contain it.`, 'Delete forever'))) return;
                    const removed = await app.request('/trash/delete', { operationId: newOperationId('purge'), notebookId: app.state.notebookId, trashId: item.id, confirm: 'delete-permanently' });
                    if (app.failed(removed, 'The note could not be deleted.')) return;
                    row.remove();
                    await app.refreshTree();
                }, { icon: 'fa-trash', className: 'notes-danger' })));
        list.append(row);
    }
    await callGenericPopup(content, POPUP_TYPE.TEXT, '', { wide: true, okButton: 'Close', onOpen: opened => { popup = opened; } });
}

/* ---------- assistant proposals ---------- */

export async function reviewProposal(app, proposalId) {
    const detail = await app.request('/assistant/proposal', { proposalId, full: true });
    if (app.failed(detail)) return null;
    if (detail.state !== 'waiting') {
        app.toast('info', `That change is already ${detail.state}.`);
        return detail;
    }
    const review = buildNoteProposalReview({ summary: detail.summary, diff: formatDiff(detail.before ?? '', detail.after ?? '') });
    const result = await callGenericPopup(review, POPUP_TYPE.CONFIRM, '', { wide: true, large: true, okButton: 'Save change', cancelButton: 'Not now', customButtons: ['Decline'] });
    const decision = result === POPUP_RESULT.AFFIRMATIVE ? 'allow' : result === 2 ? 'deny' : null;
    if (!decision) return detail;
    const decided = await app.request('/assistant/decide', { proposalId, proposalHash: detail.proposalHash, decision });
    if (app.failed(decided, 'The change could not be saved. It may be out of date; ask the assistant to try again.')) return null;
    app.toast(decision === 'allow' ? 'success' : 'info', decision === 'allow' ? (decided.message ?? 'Saved.') : 'Declined. Nothing was saved.');
    await app.refreshTree();
    if (decision === 'allow' && decided.noteId && decided.noteId === app.state.note?.id) await app.reloadNote();
    return decided;
}

export async function proposals(app) {
    const result = await app.request('/assistant/proposals', { notebookId: app.state.notebookId, state: 'waiting' });
    if (app.failed(result)) return;
    let popup = null;
    const list = h('ul', { class: 'notes-list' });
    const items = result.proposals ?? [];
    if (!items.length) list.append(h('li', { class: 'notes-hint', text: 'No assistant changes are waiting for you.' }));
    for (const item of items) {
        list.append(h('li', { class: 'notes-list-item' },
            h('span', { class: 'notes-note-title', text: item.summary?.label ?? 'Assistant change' }),
            h('span', { class: 'notes-note-meta', text: `Not saved yet - asked ${formatTime(item.createdAt)}${item.summary?.affectsLiveLore ? ' - changes live lore' : ''}` }),
            button('Review', async () => { popup?.completeCancelled(); await reviewProposal(app, item.id); }, { icon: 'fa-eye' })));
    }
    const content = h('div', { class: 'notes-dialog' }, h('h3', { text: 'Assistant changes' }),
        h('p', { class: 'notes-hint', text: 'Changes an assistant asked to make. Nothing here is saved until you choose Save change.' }), list);
    await callGenericPopup(content, POPUP_TYPE.TEXT, '', { wide: true, okButton: 'Close', onOpen: opened => { popup = opened; } });
}

/* ---------- import and export ---------- */

function stageSummary(stage) {
    const rows = [
        h('p', { text: `${stage.notes?.length ?? 0} note(s) and ${stage.attachments?.length ?? 0} file(s) are ready to import.` }),
        h('p', { class: 'notes-hint', text: 'Imported notes start private: assistants cannot read them and they are not used in chats until you allow it.' }),
    ];
    if (stage.renamed?.length) rows.push(h('p', { text: `Renamed to avoid clashes: ${stage.renamed.map(item => `${item.from} -> ${item.to}`).join(', ')}` }));
    if (stage.excluded?.length) {
        rows.push(h('p', { text: 'Left out:' }), h('ul', { class: 'notes-plain-list' },
            ...stage.excluded.slice(0, 50).map(item => h('li', { text: `${item.path} (${item.reason.replaceAll('-', ' ')})` }))));
        if (stage.excluded.length > 50) rows.push(h('p', { text: `...and ${stage.excluded.length - 50} more.` }));
    }
    return rows;
}

export async function importNotes(app) {
    const picked = pickFile('.zip,.md,.markdown,application/zip,text/markdown');
    const file = await picked;
    if (!file) return;
    app.toast('info', `Checking ${file.name}...`);
    const staged = await notesUpload('/import/stage', {}, file);
    if (app.failed(staged, 'That file could not be imported.')) return;
    const stage = staged.stage;
    const nameId = fieldId('import-name');
    const name = textInput(nameId, stage.name ?? 'Imported notes');
    const content = h('div', { class: 'notes-dialog' }, h('h3', { text: 'Import notes' }), ...stageSummary(stage),
        field('New notebook name', name, 'Import as new notebook keeps everything you already have untouched.'));
    const { ok, result } = await dialog(content, { okButton: 'Import as new notebook', cancelButton: 'Cancel', customButtons: app.state.notebookId ? ['Compare with this notebook'] : [] });
    if (ok) {
        const committed = await app.request('/import/commit', { operationId: newOperationId('import'), stageId: stage.stageId, name: name.value.trim() || stage.name });
        if (app.failed(committed, 'The import did not finish.')) return;
        app.toast('success', `Imported ${committed.imported?.notes ?? 0} note(s) into '${committed.notebook?.name}'.`);
        await app.loadNotebooks(committed.notebook?.id);
        return;
    }
    if (result !== 2) {
        await app.request('/import/cancel', { stageId: stage.stageId });
        return;
    }
    await compareImport(app, stage);
}

async function compareImport(app, stage) {
    const compared = await app.request('/import/compare', { stageId: stage.stageId, notebookId: app.state.notebookId });
    if (app.failed(compared)) return;
    const notes = compared.stage?.notes ?? compared.notes ?? [];
    const chosen = new Set();
    const list = h('ul', { class: 'notes-plain-list' });
    for (const note of notes) {
        const state = note.match?.state ?? 'new';
        const box = h('input', { type: 'checkbox', disabled: state === 'same' });
        box.addEventListener('change', () => (box.checked ? chosen.add(note.path) : chosen.delete(note.path)));
        list.append(h('li', {}, h('label', { class: 'notes-check' }, box,
            h('span', { text: `${note.path} - ${state === 'same' ? 'already the same' : state === 'changed' ? 'differs from your copy' : 'new'}` }))));
    }
    const content = h('div', { class: 'notes-dialog' }, h('h3', { text: 'Update from import' }),
        h('p', { class: 'notes-hint', text: 'Tick the notes to take from the file. Your current version is kept in each note\'s history.' }), list);
    const { ok } = await dialog(content, { okButton: 'Update ticked notes', cancelButton: 'Cancel' });
    if (!ok || !chosen.size) {
        await app.request('/import/cancel', { stageId: stage.stageId });
        return;
    }
    const updated = await app.request('/import/update', { operationId: newOperationId('import-update'), stageId: stage.stageId, notebookId: app.state.notebookId, paths: [...chosen] });
    if (app.failed(updated)) return;
    const conflicts = (updated.results ?? []).filter(item => item.status === 'conflict').length;
    app.toast(conflicts ? 'warning' : 'success', conflicts ? `${conflicts} note(s) changed since the comparison and were left alone.` : 'Notes updated.');
    await app.refreshTree();
    if (app.state.note) await app.reloadNote();
}

export async function exportNotebook(app) {
    let download;
    try {
        download = await notesDownload('/export', { notebookId: app.state.notebookId });
    } catch {
        download = { status: 'failure' };
    }
    if (download.status !== 'success') {
        app.failed(download, 'The notebook could not be exported.');
        return;
    }
    const url = URL.createObjectURL(download.blob);
    const link = h('a', { href: url, download: download.filename || 'notebook.zip', class: 'notes-hidden-input' });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    app.toast('success', 'Exported as plain Markdown files. Open the unzipped folder as a vault in Obsidian if you like.');
}

/* ---------- diagnostics ---------- */

export async function diagnostics(app) {
    const result = await app.request('/diagnostics', { notebookId: app.state.notebookId });
    if (app.failed(result)) return;
    const content = h('div', { class: 'notes-dialog' }, h('h3', { text: 'Check notebook' }),
        h('ul', { class: 'notes-plain-list' },
            h('li', { text: `Notes: ${result.noteCount ?? 0}` }),
            h('li', { text: `Files: ${result.attachmentCount ?? 0}` }),
            h('li', { text: `Skipped files: ${result.skipped?.length ?? 0}` }),
            h('li', { text: `Lore links needing attention: ${result.unresolvedBindings?.length ?? 0}` }),
            h('li', { text: `Assistant changes waiting: ${result.waitingProposals ?? 0}` }),
            h('li', { text: `Assistant changes that failed: ${result.failedProposals ?? 0}` })),
        ...(result.skipped?.length ? [h('ul', { class: 'notes-plain-list' }, ...result.skipped.slice(0, 30).map(item => h('li', { text: `${item.path}: ${item.reason}` })))] : []),
        h('p', { class: 'notes-hint', text: 'Rebuilding the index rereads every note from disk. It never deletes notes, history or settings.' }));
    const { ok } = await dialog(content, { okButton: 'Rebuild index', cancelButton: 'Close' });
    if (!ok) return;
    const rebuilt = await app.request('/reindex', { notebookId: app.state.notebookId });
    if (app.failed(rebuilt)) return;
    app.toast('success', 'Index rebuilt.');
    await app.refreshTree();
}

/* ---------- chat capture ---------- */

export async function captureFromChat(app, capture) {
    if (!capture?.text?.trim()) {
        app.toast('warning', 'There is no text to save.');
        return;
    }
    let mode = 'new';
    let target = null;
    const titleId = fieldId('capture-title');
    const title = textInput(titleId, capture.title ?? '', 'Saved from chat');
    const searchId = fieldId('capture-search');
    const search = textInput(searchId, '', 'Search note names');
    const results = h('ul', { class: 'notes-list notes-link-results' });
    const picked = h('p', { class: 'notes-hint', text: 'No note chosen yet.' });
    const newBox = h('div', {}, field('Name', title, 'The note goes in your Inbox.'));
    const existingBox = h('div', { hidden: true }, field('Add to', search), picked, results);
    const refresh = async () => {
        const response = await app.request('/suggest', { notebookId: app.state.notebookId, query: search.value });
        clear(results);
        for (const note of response.notes ?? []) {
            results.append(h('li', { class: 'notes-list-item' }, h('button', { type: 'button', class: 'menu_button notes-note-link', onclick: () => { target = note; picked.textContent = `Adding to: ${note.title}`; } },
                h('span', { class: 'notes-note-title', text: note.title }), h('span', { class: 'notes-note-meta', text: note.path }))));
        }
    };
    let timer = 0;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 200); });
    const modes = choiceRow('Save to', [['new', 'New note'], ['existing', 'Existing note']], mode, value => {
        mode = value;
        newBox.hidden = value !== 'new';
        existingBox.hidden = value !== 'existing';
        if (value === 'existing') void refresh();
    });
    const preview = h('blockquote', { class: 'notes-capture-preview', text: capture.text.length > 1200 ? `${capture.text.slice(0, 1200)}...` : capture.text });
    const notebook = app.state.notebooks.find(item => item.id === app.state.notebookId);
    const content = h('div', { class: 'notes-dialog' }, h('h3', { text: 'Save to note' }),
        h('p', { class: 'notes-hint', text: `The exact passage is copied into ${notebook?.name ?? 'your notebook'} with a note of where it came from. It stays even if the message changes later.` }),
        preview, modes, newBox, existingBox);
    const { ok } = await dialog(content, { okButton: 'Save', cancelButton: 'Cancel' });
    if (!ok) return;
    const body = { operationId: newOperationId('capture'), notebookId: app.state.notebookId, text: capture.text, source: capture.source ?? {} };
    if (mode === 'existing') {
        if (!target) {
            app.toast('warning', 'Choose a note to add the passage to.');
            return;
        }
        Object.assign(body, { noteId: target.id, expectedRevision: target.revision });
    } else {
        Object.assign(body, { folder: 'Inbox', title: title.value.trim() });
    }
    const result = await app.request('/notes/capture', body);
    if (app.failed(result, 'The passage could not be saved.')) return;
    app.toast('success', `Saved to '${result.title ?? target?.title ?? 'note'}'.`);
    await app.refreshTree();
    if (result.noteId) await app.openNote(app.state.notebookId, result.noteId);
}

