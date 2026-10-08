import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/scripts/notebooks/notes-app.js', import.meta.url), 'utf8');
const functionSource = name => source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0] ?? '';
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

function runtime(overrides = {}, functions = ['showBanner', 'clearBanner', 'showSaveConflict', 'showDraftConflict', 'saveRecoveryCopy', 'fetchServerText', 'reloadNote']) {
    const rows = [];
    const removed = [];
    const note = { id: 'one', title: 'Original', folder: 'Inbox', revision: 'old', serverText: 'Old words.' };
    const app = { state: { account: 'owner', notebookId: 'book', noteRequestVersion: 0, back: [], note, editorText: 'My draft.', dirty: true, status: 'conflict' },
        elements: { textarea: { value: 'My draft.' }, banner: { append: row => rows.push(row),
            querySelector: selector => ({ remove: () => removed.push(selector) }) } } };
    const h = (tag, attributes = {}, ...children) => ({ tag, attributes, children, append: (...items) => children.push(...items), remove: jest.fn() });
    const context = vm.createContext({ app, h, button: (label, action) => ({ label, action }), request: jest.fn(),
        failed: result => result.status !== 'success', clearDraft: jest.fn(), loadNoteDetail: jest.fn(), renderEditor: jest.fn(),
        lf: text => text, createNote: jest.fn(), openNote: jest.fn(async () => true), compareTexts: jest.fn(), setStatus: jest.fn(), saveNow: jest.fn(),
        readDraft: () => ({ text: 'My draft.' }), formatTime: () => 'Today', onEditorInput: jest.fn(), refreshLiveOutline: jest.fn(), toast: jest.fn(),
        flushSave: async () => true, selectNotebook: jest.fn(), renderNav: jest.fn(), writePrefs: jest.fn(), applyLayout: jest.fn(), isPhone: () => false, clearTimeout, ...overrides });
    if (functions.includes('saveNow')) functions = [...functions, 'saveNote'];
    vm.runInContext(functionSource('notebookCanvasCanLeave') + '\n' + functions.map(functionSource).join('\n'), context);
    const actions = () => rows.at(-1).children[1].children;
    return { app, context, rows, removed, actions };
}

describe('Notes conflict and recovery safety', () => {
    test('a blocked save always keeps its resolution buttons available', () => {
        const { context, actions } = runtime();
        context.showSaveConflict();
        expect(actions().map(action => action.label)).toEqual(['Compare', 'Use server version', 'Save mine as a copy', 'Keep mine']);
    });

    test('the blocking conflict replaces the earlier remote-change notice', () => {
        const { context, removed } = runtime();
        context.showSaveConflict();
        expect(removed).toContain('[data-banner="remote"]');
    });

    test('a failed server read never discards the device draft', async () => {
        const { context, actions } = runtime({ request: async () => ({ status: 'failure' }) });
        context.showSaveConflict();
        await actions().find(action => action.label === 'Use server version').action();
        expect(context.clearDraft).not.toHaveBeenCalled();
        expect(context.loadNoteDetail).not.toHaveBeenCalled();
    });

    test('a delayed reload cannot replace another note', async () => {
        const waiting = deferred();
        const { app, context } = runtime({ request: () => waiting.promise });
        app.state.dirty = false;
        const reload = context.reloadNote();
        app.state.note = { id: 'two', revision: 'two-revision' };
        waiting.resolve({ status: 'success', note: { id: 'one', text: 'Old response.' } });
        await reload;
        expect(context.loadNoteDetail).not.toHaveBeenCalled();
    });

    test('a delayed reload cannot erase typing that started while the read was pending', async () => {
        const waiting = deferred();
        const { app, context } = runtime({ request: () => waiting.promise });
        const reload = context.reloadNote({ discardDraft: true });
        app.state.editorText = 'Later typing.';
        waiting.resolve({ status: 'success', note: { id: 'one', text: 'Server words.' } });
        await reload;
        expect(context.loadNoteDetail).not.toHaveBeenCalled();
        expect(context.clearDraft).not.toHaveBeenCalled();
    });

    test('Keep mine cannot apply a server revision to a different note after a delayed read', async () => {
        const waiting = deferred();
        const { app, context, actions } = runtime({ request: () => waiting.promise });
        context.showSaveConflict();
        const keep = actions().find(action => action.label === 'Keep mine').action();
        app.state.note = { id: 'two', revision: 'two-revision' };
        waiting.resolve({ status: 'success', note: { id: 'one', revision: 'one-new', text: 'Server words.' } });
        await keep;
        expect(app.state.note.revision).toBe('two-revision');
        expect(context.saveNow).not.toHaveBeenCalled();
    });

    test('saving a copy cannot clear or open over a different note chosen during the request', async () => {
        const waiting = deferred();
        const { app, context, actions } = runtime({ createNote: () => waiting.promise });
        context.showSaveConflict();
        const copy = actions().find(action => action.label === 'Save mine as a copy').action();
        app.state.notebookId = 'other-book';
        app.state.note = { id: 'two', revision: 'two-revision' };
        waiting.resolve({ noteId: 'copy' });
        await copy;
        expect(context.clearDraft.mock.calls.some(call => call[2] === 'two')).toBe(false);
        expect(context.openNote).not.toHaveBeenCalled();
    });

    test('Use server version clears only the original draft after a successful read', async () => {
        const result = { status: 'success', note: { id: 'one', text: 'Server words.' } };
        const { context, actions } = runtime({ request: async () => result });
        context.showSaveConflict();
        await actions().find(action => action.label === 'Use server version').action();
        expect(context.clearDraft).toHaveBeenCalledWith('owner', 'book', 'one');
        expect(context.loadNoteDetail).toHaveBeenCalledWith(result);
    });

    test('an automatic reload never replaces an existing unsaved draft', async () => {
        const { context } = runtime({ request: async () => ({ status: 'success', note: { id: 'one', text: 'Server words.' } }) });
        expect(await context.reloadNote()).toBe(false);
        expect(context.loadNoteDetail).not.toHaveBeenCalled();
        expect(context.clearDraft).not.toHaveBeenCalled();
    });

    test('a revision advanced during a pending reload prevents the old response being installed', async () => {
        const waiting = deferred();
        const { app, context } = runtime({ request: () => waiting.promise });
        app.state.dirty = false;
        const reload = context.reloadNote();
        app.state.note.revision = 'newer-own-save';
        waiting.resolve({ status: 'success', note: { id: 'one', revision: 'old', text: 'Old response.' } });
        await reload;
        expect(context.loadNoteDetail).not.toHaveBeenCalled();
    });

    test('a completed copy leaves later typing and its device draft intact', async () => {
        const waiting = deferred();
        const { app, context, actions } = runtime({ createNote: () => waiting.promise, readDraft: () => ({ text: 'Later typing.' }) });
        context.showSaveConflict();
        const copy = actions().find(action => action.label === 'Save mine as a copy').action();
        app.state.editorText = app.elements.textarea.value = 'Later typing.';
        waiting.resolve({ noteId: 'copy' });
        await copy;
        expect(context.clearDraft).not.toHaveBeenCalled();
        expect(context.openNote).not.toHaveBeenCalled();
    });

    test('an unchanged completed copy clears only the copied draft and opens the correct notebook', async () => {
        const { context, actions } = runtime({ createNote: async () => ({ noteId: 'copy' }) });
        context.showSaveConflict();
        await actions().find(action => action.label === 'Save mine as a copy').action();
        expect(context.clearDraft).toHaveBeenCalledWith('owner', 'book', 'one');
        expect(context.openNote).toHaveBeenCalledWith('book', 'copy', { pushBack: true });
    });

    test('copying an older device draft cannot discard a different draft after navigation', async () => {
        const waiting = deferred();
        const { app, context, actions } = runtime({ createNote: () => waiting.promise });
        context.showDraftConflict({ text: 'My draft.', at: 1 });
        const copy = actions().find(action => action.label === 'Save draft as a copy').action();
        app.state.notebookId = 'other-book';
        app.state.note = { id: 'two', revision: 'two-revision' };
        waiting.resolve({ noteId: 'copy' });
        await copy;
        expect(context.clearDraft).not.toHaveBeenCalled();
        expect(context.openNote).not.toHaveBeenCalled();
    });

    test('the latest note click wins even when the earlier read finishes first', async () => {
        const older = deferred(), newer = deferred();
        const request = jest.fn().mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
        const { app, context } = runtime({ request }, ['openNote']);
        app.state.dirty = false;
        context.loadNoteDetail = jest.fn(result => { app.state.note = result.note; });
        const first = context.openNote('book', 'older');
        const second = context.openNote('book', 'newer');
        older.resolve({ status: 'success', note: { id: 'older', text: 'Earlier response.' } });
        expect(await first).toBe(false);
        expect(context.loadNoteDetail).not.toHaveBeenCalled();
        const result = { status: 'success', note: { id: 'newer', text: 'Chosen note.' } };
        newer.resolve(result);
        expect(await second).toBe(true);
        expect(context.loadNoteDetail).toHaveBeenCalledWith(result);
    });

    test('a delayed missing-note response cannot clear a newer chosen note', async () => {
        const older = deferred(), newer = deferred();
        const request = jest.fn().mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
        const { app, context } = runtime({ request }, ['openNote']);
        app.state.dirty = false;
        context.loadNoteDetail = jest.fn(result => { app.state.note = result.note; });
        const first = context.openNote('book', 'missing');
        const second = context.openNote('book', 'newer');
        newer.resolve({ status: 'success', note: { id: 'newer', text: 'Chosen note.' } });
        await second;
        older.resolve({ status: 'not_found' });
        await first;
        expect(app.state.note.id).toBe('newer');
    });

    test('a note opened by recovery cannot replace typing entered while its read is pending', async () => {
        const waiting = deferred();
        const { app, context } = runtime({ request: () => waiting.promise }, ['openNote']);
        app.state.dirty = false;
        const opening = context.openNote('book', 'copy');
        app.state.editorText = app.elements.textarea.value = 'Later typing.';
        app.state.dirty = true;
        waiting.resolve({ status: 'success', note: { id: 'copy', text: 'Earlier copied text.' } });
        expect(await opening).toBe(false);
        expect(context.loadNoteDetail).not.toHaveBeenCalled();
        expect(context.clearDraft).not.toHaveBeenCalled();
    });

    test('a delayed note read cannot load into a different notebook', async () => {
        const waiting = deferred();
        const { app, context } = runtime({ request: () => waiting.promise }, ['openNote']);
        app.state.dirty = false;
        const opening = context.openNote('book', 'old');
        app.state.notebookId = 'other-book';
        waiting.resolve({ status: 'success', note: { id: 'old', text: 'Old notebook text.' } });
        expect(await opening).toBe(false);
        expect(context.loadNoteDetail).not.toHaveBeenCalled();
    });

    test('typing during a conflict keeps automatic saving paused', () => {
        const { app, context } = runtime({ saveDraft: jest.fn(() => ({ ok: true })), maybeSuggest: jest.fn(), scheduleSave: jest.fn(), clearTimeout }, ['onEditorInput']);
        app.state.saveConflict = true;
        context.onEditorInput();
        expect(context.setStatus).toHaveBeenCalledWith('conflict');
        expect(context.scheduleSave).not.toHaveBeenCalled();
        expect(context.refreshLiveOutline).toHaveBeenCalledTimes(1);
    });

    test('typing the old opened text is still a draft after the server version changed', () => {
        const { app, context } = runtime({ saveDraft: jest.fn(() => ({ ok: true })), maybeSuggest: jest.fn(), scheduleSave: jest.fn(), clearTimeout }, ['onEditorInput']);
        app.state.saveConflict = true;
        app.elements.textarea.value = app.state.note.serverText;
        context.onEditorInput();
        expect(app.state.dirty).toBe(true);
        expect(context.clearDraft).not.toHaveBeenCalled();
        expect(context.saveDraft).toHaveBeenCalled();
    });

    test('a storage-error status cannot bypass an unresolved conflict', async () => {
        const request = jest.fn(async () => ({ status: 'success', revision: 'new' }));
        const { app, context } = runtime({ request, clearTimeout, newOperationId: () => 'test-save-operation', reportLoreUpdates: jest.fn() }, ['saveNow']);
        app.state.status = 'error';
        app.state.saveConflict = true;
        expect(await context.saveNow()).toBe(false);
        expect(request).not.toHaveBeenCalled();
    });

    test('a delayed save cannot clear a draft with the same note id in another notebook', async () => {
        const waiting = deferred();
        const { app, context } = runtime({ request: () => waiting.promise, clearTimeout, newOperationId: () => 'test-save-operation', reportLoreUpdates: jest.fn() }, ['saveNow']);
        app.state.status = 'device';
        const saving = context.saveNow();
        app.state.notebookId = 'other-book';
        app.state.note = { id: 'one', revision: 'other-revision', serverText: 'Different note.' };
        waiting.resolve({ status: 'success', revision: 'original-book-saved' });
        expect(await saving).toBe(false);
        expect(context.clearDraft).not.toHaveBeenCalled();
        expect(app.state.dirty).toBe(true);
        expect(app.state.note.revision).toBe('other-revision');
    });

    test('a server reload cannot cancel a later note click whose read is still pending', async () => {
        const waiting = deferred();
        const { app, context } = runtime({ request: () => waiting.promise });
        const reload = context.reloadNote({ discardDraft: true });
        app.state.noteRequestVersion++;
        waiting.resolve({ status: 'success', note: { id: 'one', revision: 'new', text: 'Server words.' } });
        expect(await reload).toBe(false);
        expect(context.clearDraft).not.toHaveBeenCalled();
        expect(context.loadNoteDetail).not.toHaveBeenCalled();
    });

    test('Keep mine cannot apply while a later notebook selection is still pending', async () => {
        const waiting = deferred();
        const { app, context, actions } = runtime({ request: () => waiting.promise });
        context.showSaveConflict();
        const keep = actions().find(action => action.label === 'Keep mine').action();
        app.state.notebookSelectionVersion = 1;
        waiting.resolve({ status: 'success', note: { id: 'one', revision: 'new', text: 'Server words.' } });
        await keep;
        expect(app.state.note.revision).toBe('old');
        expect(context.saveNow).not.toHaveBeenCalled();
    });

    test('a completed copy cannot replace a later note click whose read is still pending', async () => {
        const waiting = deferred();
        const { app, context, actions } = runtime({ createNote: () => waiting.promise });
        context.showSaveConflict();
        const copy = actions().find(action => action.label === 'Save mine as a copy').action();
        app.state.noteRequestVersion++;
        waiting.resolve({ noteId: 'copy' });
        await copy;
        expect(context.openNote).not.toHaveBeenCalled();
        expect(context.clearDraft).not.toHaveBeenCalled();
    });

    test('a pending save cannot clear the draft while a later note click is waiting', async () => {
        const waiting = deferred();
        const { app, context } = runtime({ request: () => waiting.promise, clearTimeout, newOperationId: () => 'test-save-operation', reportLoreUpdates: jest.fn() }, ['saveNow']);
        app.state.status = 'device';
        const saving = context.saveNow();
        app.state.noteRequestVersion++;
        waiting.resolve({ status: 'success', revision: 'saved' });
        expect(await saving).toBe(false);
        expect(context.clearDraft).not.toHaveBeenCalled();
        expect(app.state.dirty).toBe(true);
    });

    test('an explicit save joins the pending autosave without a duplicate request', async () => {
        const waiting = deferred();
        const request = jest.fn(() => waiting.promise);
        const { app, context } = runtime({ request, newOperationId: () => 'save', reportLoreUpdates: jest.fn() }, ['saveNow', 'flushSave']);
        app.state.status = 'device';
        const autosave = context.saveNow();
        const explicitSave = context.flushSave();
        expect(request).toHaveBeenCalledTimes(1);
        waiting.resolve({ status: 'success', revision: 'saved' });
        expect(await autosave).toBe(true);
        expect(await explicitSave).toBe(true);
        expect(app.state.dirty).toBe(false);
        expect(app.state.saving).toBe(false);
    });

    test('a save from the previous account cannot clear the new account save state', async () => {
        const older = deferred(), newer = deferred();
        const request = jest.fn().mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
        const { app, context } = runtime({ request, newOperationId: () => 'save', reportLoreUpdates: jest.fn() }, ['saveNow']);
        app.state.status = 'device';
        const oldSave = context.saveNow();
        app.state.account = 'new-owner';
        app.state.savePromise = null;
        app.state.saving = false;
        app.state.note = { id: 'two', revision: 'new-account-original', serverText: 'New account.' };
        const newSave = context.saveNow();
        older.resolve({ status: 'success', revision: 'old-account-saved' });
        expect(await oldSave).toBe(false);
        expect(app.state.saving).toBe(true);
        expect(app.state.note.revision).toBe('new-account-original');
        newer.resolve({ status: 'success', revision: 'new-account-saved' });
        expect(await newSave).toBe(true);
        expect(app.state.saving).toBe(false);
    });
});
