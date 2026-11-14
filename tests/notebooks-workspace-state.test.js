import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/scripts/notebooks/notes-app.js', import.meta.url), 'utf8');
const functionSource = name => (source.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0] ?? '').replace(/^export /, '');
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const notebooks = [{ id: 'old' }, { id: 'new' }];

function runtime(overrides = {}, functions = ['loadNotebooks', 'selectNotebook', 'onRemoteChange']) {
    const app = { state: { open: true, account: 'owner', notebookId: 'old', notebookSelectionVersion: 0, treeRequestVersion: 0,
        notebookListVersion: 0, notebookListAppliedVersion: 0,
        notebooks, dirty: false, note: null, folder: null, list: { offset: 0 }, search: null, searchQuery: '' } };
    const context = vm.createContext({ app, request: jest.fn(), failed: () => false, flushSave: async () => {},
        writePrefs: jest.fn(), renderEditor: jest.fn(), renderNav: jest.fn(), refreshTree: async () => {},
        refreshTreeSoon: () => {}, ...overrides });
    vm.runInContext(functionSource('notebookCanvasCanLeave') + '\n' + functions.map(functionSource).join('\n'), context);
    return { app, context };
}

describe('Notes workspace selection and delayed responses', () => {
    test('reopening refreshes folders changed while hidden without replacing the unsaved note', async () => {
        const request = jest.fn(route => Promise.resolve(route === '/tree'
            ? { status: 'success', folders: [{ path: 'Inbox' }, { path: 'Plans/Sub' }] }
            : { status: 'success', notes: [], total: 0 }));
        const { app, context } = runtime({ request, NOTES_STYLESHEET: '/notes.css', loadStylesheetAsync: async () => {},
            ensureModules: async () => {}, mountTour: () => {}, accountChanged: () => {}, readPrefs: () => ({}),
            isPhone: () => false, subscribeNotes: () => () => {}, applyLayout: () => {} },
        ['openNotes', 'loadNotebooks', 'selectNotebook', 'refreshTree', 'onRemoteChange']);
        const draft = { id: 'current-note', text: 'My unsaved words' };
        Object.assign(app.state, { built: true, open: false, note: draft, dirty: true, tree: { folders: [{ path: 'Inbox' }] } });
        app.elements = { root: { hidden: true } };
        context.onRemoteChange({ kind: 'folder', notebookId: 'old' });
        expect(request).not.toHaveBeenCalled();

        await context.openNotes({ notebookId: 'old' });

        expect(app.state.tree.folders.map(folder => folder.path)).toEqual(['Inbox', 'Plans/Sub']);
        expect(app.state.note).toBe(draft);
        expect(app.state.note.text).toBe('My unsaved words');
        expect(app.state.dirty).toBe(true);
        expect(app.elements.root.hidden).toBe(false);
    });

    test('a late notebook notification cannot undo selecting the notebook just imported', async () => {
        const notification = deferred();
        const imported = deferred();
        const { app, context } = runtime({ request: jest.fn().mockReturnValueOnce(notification.promise).mockReturnValueOnce(imported.promise) });
        context.onRemoteChange({ kind: 'notebook', notebookId: 'new' });
        const selection = context.loadNotebooks('new');
        imported.resolve({ status: 'success', notebooks });
        await selection;
        expect(app.state.notebookId).toBe('new');
        notification.resolve({ status: 'success', notebooks: [{ id: 'old' }] });
        await settle();
        expect(app.state.notebookId).toBe('new');
        expect(app.state.notebooks.map(item => item.id)).toEqual(['old', 'new']);
    });

    test('a delayed explicit refresh cannot undo a later notebook click', async () => {
        const loaded = deferred();
        const { app, context } = runtime({ request: () => loaded.promise });
        const earlier = context.loadNotebooks('new');
        await context.selectNotebook('old');
        loaded.resolve({ status: 'success', notebooks });
        await earlier;
        expect(app.state.notebookId).toBe('old');
    });

    test('older tree and note-list responses cannot replace the newly selected notebook', async () => {
        const tree = deferred();
        const list = deferred();
        const { app, context } = runtime({ request: (route, body) => {
            if (body.notebookId === 'old') return route === '/tree' ? tree.promise : list.promise;
            return Promise.resolve(route === '/tree' ? { status: 'success', notebookId: 'new' }
                : { status: 'success', notes: [{ id: 'new-note' }], total: 1 });
        } }, ['loadNotebooks', 'selectNotebook', 'refreshTree']);
        const earlier = context.refreshTree();
        await context.selectNotebook('new');
        tree.resolve({ status: 'success', notebookId: 'old' });
        list.resolve({ status: 'success', notes: [{ id: 'old-note' }], total: 1 });
        await earlier;
        expect(app.state.notebookId).toBe('new');
        expect(app.state.tree.notebookId).toBe('new');
        expect(app.state.list.notes.map(note => note.id)).toEqual(['new-note']);
    });

    test('an older search cannot replace matching-query results in another notebook', async () => {
        const oldSearch = deferred();
        const { app, context } = runtime({ request: (_route, body) => body.notebookId === 'old' ? oldSearch.promise
            : Promise.resolve({ status: 'success', notes: [{ id: 'new-match' }] }) }, ['runSearch']);
        const earlier = context.runSearch('rules');
        app.state.notebookId = 'new';
        await context.runSearch('rules');
        oldSearch.resolve({ status: 'success', notes: [{ id: 'old-match' }] });
        await earlier;
        expect(app.state.search.notes.map(note => note.id)).toEqual(['new-match']);
    });
});
