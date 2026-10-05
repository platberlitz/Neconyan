/* global globalThis */
import fs from 'node:fs';
import vm from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { TextEncoder } from 'node:util';
import { expect, jest, test } from '@jest/globals';
import { CANVAS_LIMITS, changeCanvasDocument, serializeCanvasDocument, validateCanvasDocument } from '../public/scripts/notebooks/canvas-format.js';
import { clearCanvasDraft, readCanvasDraft, saveCanvasDraft } from '../public/scripts/notebooks/canvas-drafts.js';

const source = fs.readFileSync(new URL('../public/scripts/notebooks/canvas.js', import.meta.url), 'utf8');
const dialogs = fs.readFileSync(new URL('../public/scripts/notebooks/canvas-dialogs.js', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../public/scripts/notebooks/notes-app.js', import.meta.url), 'utf8');
const domSource = fs.readFileSync(new URL('../public/scripts/notebooks/dom.js', import.meta.url), 'utf8');
const userTextSource = fs.readFileSync(new URL('../public/scripts/notebooks/user-text.js', import.meta.url), 'utf8');
const functionSource = (text, name) => text.match(new RegExp(`(?:export )?(?:async )?function ${name}\\([^]*?\\n}`, 'm'))[0].replace(/^export /, '');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const account = 'owner';
const notebookId = 'nb_1111111111111111';
const canvasId = 'cv_2222222222222222';
let counter = 0;
const newOperationId = label => `${label}:test:${++counter}`;
const initialDocument = () => ({ future: { opaque: ['keep', 7] }, nodes: [
    { id: 'text', type: 'text', x: 0, y: 0, width: 320, height: 180, text: 'Saved text.', plugin: { keep: true } },
    { id: 'file', type: 'file', x: 360, y: 0, width: 320, height: 180, file: 'Reference.md' },
], edges: [{ id: 'edge', fromNode: 'text', toNode: 'file', plugin: 'keep' }] });

function storage({ fail = false } = {}) {
    const values = new Map();
    const original = globalThis.localStorage;
    globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => {
        if (fail) throw new Error('Storage unavailable.');
        values.set(key, value);
    }, removeItem: key => values.delete(key) };
    return { values, fail: () => { fail = true; }, restore: () => { globalThis.localStorage = original; } };
}

function element(tag, attributes = {}, ...children) {
    const node = { tagName: tag.toUpperCase(), attributes: { ...attributes }, style: {}, dataset: {}, children: [], value: String(attributes.value ?? ''),
        text: attributes.text ?? '', id: attributes.id ?? '', hidden: attributes.hidden ?? false,
        append(...items) { this.children.push(...items.filter(Boolean)); }, replaceChildren(...items) { this.children = items.filter(Boolean); },
        setAttribute(name, value) { this.attributes[name] = String(value); }, getAttribute(name) { return this.attributes[name] ?? null; },
        removeAttribute(name) { delete this.attributes[name]; }, addEventListener(name, callback) { this[name] = callback; },
        get textContent() { return this.text + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); },
        set textContent(text) { this.text = text; this.children = []; },
    };
    for (const [name, value] of Object.entries(attributes)) if (name.startsWith('on')) node[name] = value;
    node.append(...children);
    return node;
}
const find = (node, predicate) => predicate(node) ? node : node.children?.map(child => typeof child === 'string' ? null : find(child, predicate)).find(Boolean);
const buttonNamed = (root, text) => find(root, node => node.tagName === 'BUTTON' && node.textContent === text);
// VM fixtures keep JSON in this test's realm; native cloning is covered by the Node and browser suites.
const cloned = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(cloned)
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloned(item)])) : value;
function changed(document, changes) {
    const original = globalThis.structuredClone;
    globalThis.structuredClone = cloned;
    try { return changeCanvasDocument(cloned(document), cloned(changes)); } finally { globalThis.structuredClone = original; }
}

function fixture() {
    const store = storage();
    let saved = { id: canvasId, path: 'Plan.canvas', title: 'Plan', revision: 'a'.repeat(64), document: initialDocument() };
    const container = element('section');
    const requests = jest.fn(async (route, args) => {
        if (route === '/canvas/list') return { status: 'success', canvases: [{ id: saved.id, path: saved.path }], warnings: [] };
        if (route === '/canvas/read') return { status: 'success', canvas: cloned(saved), preview: { nodes: [{ ...saved.document.nodes[1], label: 'Reference', noteId: 'n_3333333333333333' }], edges: [] } };
        if (route === '/canvas/preview') return { status: 'success', preview: { nodes: [{ ...args.document.nodes[1], label: 'Reference', noteId: 'n_3333333333333333' }], edges: [] } };
        if (route === '/canvas/update') { saved = { ...saved, revision: 'b'.repeat(64), document: cloned(args.document) }; return { status: 'success', revision: saved.revision }; }
        return { status: 'failure', message: 'Not available in this fixture.' };
    });
    const app = { state: { workspaceView: 'canvas', account, notebookId, workspaceVersion: 1, notebookSelectionVersion: 2, noteRequestVersion: 3 },
        isPhone: () => true, request: requests, readPrefs: () => ({}), writePrefs: jest.fn(), toast: jest.fn(), closeNotebookView: jest.fn(), openNote: jest.fn() };
    const editCanvasNode = jest.fn(async (document, node, current, onApply) => {
        if (current()) onApply(changed(document, [{ type: 'update-node', id: node.id, set: { text: 'Device change.' } }]));
    });
    const downloadCanvas = jest.fn();
    let historyPopup = null;
    const popupModule = async () => ({ POPUP_RESULT: { AFFIRMATIVE: 1 }, POPUP_TYPE: { CONFIRM: 1 },
        callGenericPopup: (content, _type, _initial, options) => new Promise(resolve => { historyPopup = { content, options, resolve }; }) });
    const context = vm.createContext({ app, container, h: element, clear: node => node.replaceChildren(), CANVAS_LIMITS, TextEncoder,
        structuredClone: cloned, newOperationId, attachmentUrl: (_book, file) => `/owned/${file}`, formatTime: () => 'Today',
        validateCanvasDocument: value => validateCanvasDocument(cloned(value)),
        changeCanvasDocument: changed,
        saveCanvasDraft: (...args) => saveCanvasDraft(...args.slice(0, 3), cloned(args[3]), args[4]), readCanvasDraft, clearCanvasDraft,
        editCanvasNode, editCanvasEdge: jest.fn(), chooseCanvasNote: jest.fn(), canvasTextPrompt: jest.fn(), downloadCanvas, popupModule, console,
        translate: text => text });
    vm.runInContext(functionSource(domSource, 'button') + '\n' + functionSource(userTextSource, 'userWords') + '\n' + functionSource(userTextSource, 'userPhrase') + '\n'
        + functionSource(source, 'canvasScopeCurrent') + '\n'
        + functionSource(source, 'createCanvasView').replace('await import(\'../popup.js\')', 'await popupModule()'), context);
    const view = vm.runInContext('createCanvasView(app, container)', context);
    const edit = async () => {
        const card = find(container, node => node.attributes['data-canvas-card'] === 'text');
        buttonNamed(card, 'Edit card').onclick();
        await nextTurn();
    };
    return { app, container, requests, view, edit, editCanvasNode, downloadCanvas, store, saved: () => saved, historyPopup: () => historyPopup,
        replaceSaved: value => { saved = value; } };
}

test('canvas device drafts are bounded, owned and revision-labelled without changing the document', () => {
    const store = storage();
    try {
        const document = initialDocument();
        expect(saveCanvasDraft(account, notebookId, canvasId, document, 'a'.repeat(64))).toBe(true);
        expect(readCanvasDraft(account, notebookId, canvasId)?.document).toEqual(document);
        expect(readCanvasDraft('other-owner', notebookId, canvasId)).toBeNull();
        expect(readCanvasDraft(account, 'nb_4444444444444444', canvasId)).toBeNull();
        expect(saveCanvasDraft(account, notebookId, canvasId, { future: '🐱'.repeat(600000) }, 'a'.repeat(64))).toBe(false);
        clearCanvasDraft(account, notebookId, canvasId);
        expect(readCanvasDraft(account, notebookId, canvasId)).toBeNull();
    } finally { store.restore(); }
});

test('malformed drafts and unavailable local storage never become a valid saved copy', () => {
    const store = storage({ fail: true });
    try {
        expect(saveCanvasDraft(account, notebookId, canvasId, initialDocument(), 'a'.repeat(64))).toBe(false);
        store.values.set(`neconyan-canvas-draft:${account}:${notebookId}:${canvasId}`, '{broken');
        expect(readCanvasDraft(account, notebookId, canvasId)).toBeNull();
    } finally { store.restore(); }
});

test('card edits stay on the device until a normal revision-checked explicit save', async () => {
    const f = fixture();
    try {
        await f.view.open();
        await f.edit();
        expect(f.requests.mock.calls.some(([route]) => route === '/canvas/update')).toBe(false);
        expect(readCanvasDraft(account, notebookId, canvasId)?.document.nodes[0].text).toBe('Device change.');
        buttonNamed(f.container, 'Save canvas').onclick();
        await nextTurn();
        const [, args] = f.requests.mock.calls.find(([route]) => route === '/canvas/update');
        expect(args.notebookId).toBe(notebookId);
        expect(args.canvasId).toBe(canvasId);
        expect(args.expectedRevision).toBe('a'.repeat(64));
        expect(args.document.future).toEqual({ opaque: ['keep', 7] });
        expect(args.document.nodes[0].plugin).toEqual({ keep: true });
        expect(readCanvasDraft(account, notebookId, canvasId)).toBeNull();
    } finally { f.store.restore(); }
});

test('same-device matching drafts are restored but stale drafts require an explicit choice', async () => {
    const f = fixture();
    try {
        const draft = initialDocument();
        draft.nodes[0].text = 'Older device draft.';
        saveCanvasDraft(account, notebookId, canvasId, draft, 'c'.repeat(64));
        await f.view.open();
        expect(f.container.textContent).toContain('older canvas draft');
        expect(f.container.textContent).toContain('Saved text.');
        expect(f.requests.mock.calls.some(([route]) => route === '/canvas/update')).toBe(false);
        buttonNamed(f.container, 'Use device draft').onclick();
        await nextTurn();
        expect(f.container.textContent).toContain('Older device draft.');
        expect(readCanvasDraft(account, notebookId, canvasId).baseRevision).toBe('a'.repeat(64));
    } finally { f.store.restore(); }
});

test('a failed Canvas save keeps its operation id for an identical retry and does not clear the device draft', async () => {
    const f = fixture();
    try {
        await f.view.open();
        await f.edit();
        f.requests.mockImplementation(async route => route === '/canvas/update' ? { status: 'failure', message: 'Offline.' } : { status: 'success', canvases: [] });
        buttonNamed(f.container, 'Save canvas').onclick();
        await nextTurn();
        buttonNamed(f.container, 'Save canvas').onclick();
        await nextTurn();
        const saves = f.requests.mock.calls.filter(([route]) => route === '/canvas/update');
        expect(saves).toHaveLength(2);
        expect(saves[0][1].operationId).toBe(saves[1][1].operationId);
        expect(readCanvasDraft(account, notebookId, canvasId)?.document.nodes[0].text).toBe('Device change.');
    } finally { f.store.restore(); }
});

test('stale Canvas writes do not borrow a newer revision, clear a draft or offer a dismiss-only conflict', async () => {
    const f = fixture();
    try {
        await f.view.open();
        await f.edit();
        f.requests.mockImplementation(async route => route === '/canvas/update' ? { status: 'conflict', http: 409 } : { status: 'success', canvases: [] });
        buttonNamed(f.container, 'Save canvas').onclick();
        await nextTurn();
        expect(f.container.textContent).toContain('Nothing was overwritten.');
        expect(buttonNamed(f.container, 'Save canvas').attributes.disabled).toBe(true);
        expect(buttonNamed(f.container, 'Dismiss')).toBeUndefined();
        expect(readCanvasDraft(account, notebookId, canvasId)?.baseRevision).toBe('a'.repeat(64));
    } finally { f.store.restore(); }
});

for (const change of [state => { state.account = 'other'; }, state => { state.notebookId = 'other'; }, state => { state.workspaceView = 'note'; },
    state => { state.workspaceVersion++; }, state => { state.notebookSelectionVersion++; }, state => { state.noteRequestVersion++; }]) {
    test(`a delayed Canvas load cannot replace a later scope: ${change.toString()}`, async () => {
        const f = fixture();
        try {
            const pending = deferred();
            f.requests.mockImplementation(route => route === '/canvas/list' ? pending.promise : Promise.resolve({ status: 'success', canvases: [] }));
            const opening = f.view.open();
            change(f.app.state);
            pending.resolve({ status: 'success', canvases: [{ id: canvasId, path: 'Old.canvas' }] });
            await opening;
            expect(f.container.textContent).not.toContain('Old.canvas');
            expect(f.requests.mock.calls.some(([route]) => route === '/canvas/read')).toBe(false);
        } finally { f.store.restore(); }
    });
}

test('an older preview cannot restore card text or note metadata over a newer local edit', async () => {
    const f = fixture();
    try {
        await f.view.open();
        const older = deferred();
        let count = 0;
        f.requests.mockImplementation(async route => route === '/canvas/preview' ? ++count === 1 ? older.promise
            : { status: 'success', preview: { nodes: [{ id: 'file', label: 'New preview.' }], edges: [] } } : { status: 'success', canvases: [] });
        await f.edit();
        f.editCanvasNode.mockImplementation(async (document, node, current, apply) => {
            if (current()) apply(changed(document, [{ type: 'update-node', id: node.id, set: { text: 'Newest local text.' } }]));
        });
        await f.edit();
        older.resolve({ status: 'success', preview: { nodes: [{ id: 'file', label: 'Stale preview.' }], edges: [] } });
        await nextTurn();
        expect(f.container.textContent).toContain('Newest local text.');
        expect(f.container.textContent).toContain('New preview.');
        expect(f.container.textContent).not.toContain('Stale preview.');
    } finally { f.store.restore(); }
});

test('a pending use-saved read does not replace text edited while it was loading', async () => {
    const f = fixture();
    try {
        await f.view.open();
        await f.edit();
        const pending = deferred();
        f.requests.mockImplementation(async route => route === '/canvas/update' ? { status: 'conflict', http: 409 } : route === '/canvas/read' ? pending.promise : { status: 'success', preview: { nodes: [], edges: [] } });
        buttonNamed(f.container, 'Save canvas').onclick();
        await nextTurn();
        buttonNamed(f.container, 'Use saved canvas').onclick();
        f.editCanvasNode.mockImplementation(async (document, node, current, apply) => {
            if (current()) apply(changed(document, [{ type: 'update-node', id: node.id, set: { text: 'Newer typing.' } }]));
        });
        await f.edit();
        pending.resolve({ status: 'success', canvas: { ...f.saved(), revision: 'd'.repeat(64) }, preview: { nodes: [], edges: [] } });
        await nextTurn();
        expect(readCanvasDraft(account, notebookId, canvasId)?.document.nodes[0].text).toBe('Newer typing.');
        expect(f.container.textContent).toContain('Nothing was overwritten.');
    } finally { f.store.restore(); }
});

test('older gallery replies cannot remove a newly returned Canvas choice', async () => {
    const f = fixture();
    try {
        await f.view.open();
        const older = deferred();
        const newer = deferred();
        let requests = 0;
        f.requests.mockImplementation(() => ++requests === 1 ? older.promise : newer.promise);
        buttonNamed(f.container, 'Refresh files').onclick();
        buttonNamed(f.container, 'Refresh files').onclick();
        newer.resolve({ status: 'success', canvases: [{ id: canvasId, path: 'Latest.canvas' }], warnings: [] });
        await nextTurn();
        older.resolve({ status: 'success', canvases: [{ id: canvasId, path: 'Stale.canvas' }], warnings: [] });
        await nextTurn();
        expect(f.container.textContent).toContain('Latest.canvas');
        expect(f.container.textContent).not.toContain('Stale.canvas');
    } finally { f.store.restore(); }
});

test('editing the saved version cannot silently replace an unresolved older device draft', async () => {
    const f = fixture();
    try {
        const draft = initialDocument();
        draft.nodes[0].text = 'Unresolved older copy.';
        saveCanvasDraft(account, notebookId, canvasId, draft, 'c'.repeat(64));
        await f.view.open();
        await f.edit();
        expect(readCanvasDraft(account, notebookId, canvasId)?.document.nodes[0].text).toBe('Unresolved older copy.');
        expect(f.container.textContent).toContain('older canvas draft');
    } finally { f.store.restore(); }
});

test('a pending Canvas save keeps navigation blocked until its result is handled', async () => {
    const f = fixture();
    try {
        await f.view.open();
        await f.edit();
        const pending = deferred();
        f.requests.mockImplementation(route => route === '/canvas/update' ? pending.promise : Promise.resolve({ status: 'success', canvases: [] }));
        buttonNamed(f.container, 'Save canvas').onclick();
        expect(f.view.canLeave()).toBe(false);
        expect(f.app.toast).toHaveBeenCalledWith('warning', 'The canvas is still saving. Wait for the result before switching.');
        pending.resolve({ status: 'success', revision: 'b'.repeat(64) });
        await nextTurn();
        expect(f.view.canLeave()).toBe(true);
    } finally { f.store.restore(); }
});

test('an old save response cannot release a later account canvas save', async () => {
    const f = fixture();
    try {
        await f.view.open();
        await f.edit();
        const older = deferred();
        const newer = deferred();
        const normal = f.requests.getMockImplementation();
        let saves = 0;
        f.requests.mockImplementation((route, args) => route === '/canvas/update' ? ++saves === 1 ? older.promise : newer.promise : normal(route, args));
        buttonNamed(f.container, 'Save canvas').onclick();
        f.view.clear();
        f.app.state.account = 'new-owner';
        await f.view.open();
        await f.edit();
        buttonNamed(f.container, 'Save canvas').onclick();
        expect(f.view.canLeave()).toBe(false);
        older.resolve({ status: 'success', revision: 'b'.repeat(64) });
        await nextTurn();
        expect(f.view.canLeave()).toBe(false);
        newer.resolve({ status: 'success', revision: 'c'.repeat(64) });
        await nextTurn();
        expect(f.view.canLeave()).toBe(true);
    } finally { f.store.restore(); }
});

test('an old copy response cannot release a later account canvas save', async () => {
    const f = fixture();
    try {
        await f.view.open();
        await f.edit();
        const older = deferred();
        const newer = deferred();
        const normal = f.requests.getMockImplementation();
        f.requests.mockImplementation((route, args) => route === '/canvas/update' ? Promise.resolve({ status: 'conflict', http: 409 }) : normal(route, args));
        buttonNamed(f.container, 'Save canvas').onclick();
        await nextTurn();
        f.requests.mockImplementation((route, args) => route === '/canvas/create' ? older.promise : route === '/canvas/update' ? newer.promise : normal(route, args));
        buttonNamed(f.container, 'Save my canvas as copy').onclick();
        f.view.clear();
        f.app.state.account = 'new-owner';
        await f.view.open();
        await f.edit();
        buttonNamed(f.container, 'Save canvas').onclick();
        older.resolve({ status: 'success', canvasId: 'cv_5555555555555555' });
        await nextTurn();
        expect(f.view.canLeave()).toBe(false);
        newer.resolve({ status: 'success', revision: 'c'.repeat(64) });
        await nextTurn();
        expect(f.view.canLeave()).toBe(true);
    } finally { f.store.restore(); }
});

test('an earlier historical-version reply cannot replace the version chosen later', async () => {
    const f = fixture();
    try {
        await f.view.open();
        const old = deferred();
        const latest = deferred();
        const normal = f.requests.getMockImplementation();
        f.requests.mockImplementation((route, args) => route === '/canvas/history'
            ? Promise.resolve({ status: 'success', history: [{ id: 'old', reason: 'Old choice' }, { id: 'latest', reason: 'Later choice' }] })
            : route === '/canvas/history/read' ? args.historyId === 'old' ? old.promise : latest.promise : normal(route, args));
        buttonNamed(f.container, 'Canvas history').onclick();
        await nextTurn();
        const popup = f.historyPopup();
        const oldRequest = buttonNamed(popup.content, 'Today (Old choice)').onclick();
        const latestRequest = buttonNamed(popup.content, 'Today (Later choice)').onclick();
        const olderDocument = initialDocument();
        olderDocument.nodes[0].text = 'Not the chosen historical version.';
        const latestDocument = initialDocument();
        latestDocument.nodes[0].text = 'The version deliberately chosen later.';
        latest.resolve({ status: 'success', document: latestDocument, text: JSON.stringify(latestDocument) });
        await latestRequest;
        old.resolve({ status: 'success', document: olderDocument, text: JSON.stringify(olderDocument) });
        await oldRequest;
        expect(popup.content.textContent).toContain('The version deliberately chosen later.');
        expect(popup.content.textContent).not.toContain('Not the chosen historical version.');
        expect(popup.options.onClosing({ result: 1 })).toBe(true);
        popup.resolve(1);
        await nextTurn();
        expect(readCanvasDraft(account, notebookId, canvasId).document.nodes[0].text).toBe('The version deliberately chosen later.');
    } finally { f.store.restore(); }
});

test('explicit Use saved still works when this browser cannot store the conflicting draft', async () => {
    const f = fixture();
    try {
        await f.view.open();
        f.store.fail();
        await f.edit();
        const ordinary = f.requests.getMockImplementation();
        f.requests.mockImplementation((route, args) => route === '/canvas/update' ? Promise.resolve({ status: 'conflict', http: 409 }) : ordinary(route, args));
        buttonNamed(f.container, 'Save canvas').onclick();
        await nextTurn();
        buttonNamed(f.container, 'Use saved canvas').onclick();
        await nextTurn();
        expect(f.container.textContent).toContain('Saved text.');
        expect(f.container.textContent).not.toContain('Device change.');
        expect(f.view.canLeave()).toBe(true);
    } finally { f.store.restore(); }
});

test('a pending recovery-copy save also blocks navigation and duplicate copy requests', async () => {
    const f = fixture();
    try {
        await f.view.open();
        await f.edit();
        const pending = deferred();
        f.requests.mockImplementation(route => route === '/canvas/update' ? Promise.resolve({ status: 'conflict', http: 409 }) : pending.promise);
        buttonNamed(f.container, 'Save canvas').onclick();
        await nextTurn();
        buttonNamed(f.container, 'Save my canvas as copy').onclick();
        expect(f.view.canLeave()).toBe(false);
        buttonNamed(f.container, 'Save my canvas as copy').onclick();
        expect(f.requests.mock.calls.filter(([route]) => route === '/canvas/create')).toHaveLength(1);
        pending.resolve({ status: 'failure', message: 'Offline.' });
        await nextTurn();
        expect(f.view.canLeave()).toBe(true);
    } finally { f.store.restore(); }
});

test('an old Canvas header cannot start a query in a newer notebook scope', async () => {
    const f = fixture();
    try {
        await f.view.open();
        const oldRefresh = buttonNamed(f.container, 'Refresh files');
        f.view.clear();
        f.app.state.notebookId = 'nb_4444444444444444';
        await f.view.open();
        const count = f.requests.mock.calls.length;
        oldRefresh.onclick();
        await nextTurn();
        expect(f.requests.mock.calls).toHaveLength(count);
    } finally { f.store.restore(); }
});

test('a canvas with no safe device copy cannot be abandoned by another workspace or note', async () => {
    const state = { workspaceView: 'canvas', account, notebookId, workspaceVersion: 1, notebookSelectionVersion: 0, noteRequestVersion: 0 };
    const app = { state, canvasView: { canLeave: () => false }, elements: {}, sourceEditor: { composing: false } };
    const context = vm.createContext({ app });
    vm.runInContext(['notebookCanvasCanLeave', 'openNote', 'selectNotebook', 'openNotebookGraph', 'openNotebookTable', 'closeNotebookView']
        .map(name => functionSource(appSource, name)).join('\n'), context);
    expect(await context.openNote(notebookId, 'other')).toBe(false);
    expect(await context.selectNotebook('other')).toBe(false);
    expect(await context.openNotebookGraph()).toBe(false);
    expect(await context.openNotebookTable()).toBe(false);
    context.closeNotebookView();
    expect(state.workspaceView).toBe('canvas');
    expect(state.notebookSelectionVersion).toBe(0);
});

test('Canvas node dialogs preserve unknown fields and prevent malformed geometry or late-scope mutation', async () => {
    const document = initialDocument();
    let popup;
    const applied = jest.fn();
    let current = true;
    const context = vm.createContext({ h: element, field: (label, input) => element('label', { text: label }, input),
        changeCanvasDocument: changed,
        callGenericPopup: async (content, _type, _value, options) => { popup = { content, options }; },
        POPUP_RESULT: { AFFIRMATIVE: 1 }, POPUP_TYPE: { CONFIRM: 1 } });
    vm.runInContext(functionSource(dialogs, 'editCanvasNode'), context);
    await context.editCanvasNode(document, document.nodes[0], () => current, applied);
    const x = find(popup.content, node => node.attributes['data-canvas-field'] === 'x');
    x.value = 'not a number';
    expect(popup.options.onClosing({ result: 1 })).toBe(false);
    expect(applied).not.toHaveBeenCalled();
    x.value = '40';
    current = false;
    expect(popup.options.onClosing({ result: 1 })).toBe(false);
    current = true;
    expect(popup.options.onClosing({ result: 1 })).toBe(true);
    expect(applied.mock.calls[0][0].future).toEqual(document.future);
    expect(applied.mock.calls[0][0].nodes[0].plugin).toEqual({ keep: true });
    expect(applied.mock.calls[0][0].nodes[0].x).toBe(40);
});

test('Canvas geometry follows declared sides and retains negative positions', () => {
    const context = vm.createContext({});
    vm.runInContext(functionSource(source, 'canvasBounds') + '\n' + functionSource(source, 'canvasEdgePoint'), context);
    const node = { x: -100, y: -200, width: 320, height: 180 };
    expect(context.canvasBounds([node]).x).toBe(-132);
    expect(context.canvasEdgePoint(node, 'left')).toEqual({ x: -100, y: -110 });
    expect(context.canvasEdgePoint(node, 'top')).toEqual({ x: 60, y: -200 });
});

test('a downloaded Canvas stays within the format limit, including unknown deeply nested data', () => {
    let value = { text: 'Keep this field.' };
    for (let depth = 0; depth < 24; depth++) value = { child: value };
    const document = validateCanvasDocument({ future: Array.from({ length: 1800 }, () => cloned(value)) });
    let output;
    const context = vm.createContext({ Blob: class Blob { constructor(parts) { output = parts.join(''); } },
        URL: { createObjectURL: () => 'blob:owned-test', revokeObjectURL: jest.fn() }, setTimeout: jest.fn(),
        serializeCanvasDocument: document => serializeCanvasDocument(cloned(document)),
        h: () => ({ click: jest.fn() }) });
    vm.runInContext(functionSource(source, 'downloadCanvas'), context);
    context.downloadCanvas(document, 'Plan');
    expect(new TextEncoder().encode(output).length).toBeLessThanOrEqual(CANVAS_LIMITS.bytes);
    expect(JSON.parse(output)).toEqual(document);
});

test('an owner-confirmed download can release an unsafe window draft, but a later edit needs a new copy', async () => {
    const f = fixture();
    try {
        await f.view.open();
        globalThis.localStorage.setItem = () => { throw new Error('No device storage.'); };
        await f.edit();
        expect(f.view.canLeave()).toBe(false);
        expect(f.app.toast).toHaveBeenLastCalledWith('warning', 'Save or download your canvas draft before leaving. This browser could not keep it.');
        const reads = () => f.requests.mock.calls.filter(([route]) => route === '/canvas/read').length;
        const readsBefore = reads();
        buttonNamed(f.container, 'Plan.canvas').onclick();
        expect(f.app.toast).toHaveBeenLastCalledWith('warning', 'Save or download your canvas draft before switching.');
        expect(reads()).toBe(readsBefore);
        buttonNamed(f.container, 'Download canvas').onclick();
        expect(f.downloadCanvas).toHaveBeenCalledTimes(1);
        expect(f.view.canLeave()).toBe(false);
        const confirmed = buttonNamed(f.container, 'I\'ve saved the download');
        expect(confirmed).toBeDefined();
        confirmed.onclick();
        expect(f.view.canLeave()).toBe(true);
        f.editCanvasNode.mockImplementation(async (document, node, current, apply) => {
            if (current()) apply(changed(document, [{ type: 'update-node', id: node.id, set: { text: 'Needs another download.' } }]));
        });
        await f.edit();
        expect(f.view.canLeave()).toBe(false);
        expect(buttonNamed(f.container, 'I\'ve saved the download')).toBeUndefined();
    } finally { f.store.restore(); }
});

for (const changedIntent of ['noteRequestVersion', 'notebookSelectionVersion']) {
    test(`Canvas lazy loading respects a later ${changedIntent}`, async () => {
        const loading = deferred();
        const view = { open: jest.fn(async () => true) };
        const createCanvasView = jest.fn(() => view);
        const app = { state: { workspaceView: 'note', account, notebookId, workspaceVersion: 0,
            notebookSelectionVersion: 0, noteRequestVersion: 0 }, elements: { canvas: element('section') }, sourceEditor: { composing: false } };
        const context = vm.createContext({ app, h: element, clear: node => node.replaceChildren(), moduleReady: loading.promise,
            applyLayout: jest.fn(), renderEditor: jest.fn(), closeNotebookView: jest.fn() });
        vm.runInContext(['notebookCanvasCanLeave', 'notebookWorkspaceCurrent', 'openNotebookCanvas'].map(name => functionSource(appSource, name))
            .join('\n').replace('await import(\'./canvas.js\')', 'await moduleReady'), context);
        const opening = context.openNotebookCanvas();
        app.state[changedIntent]++;
        loading.resolve({ createCanvasView });
        expect(await opening).toBe(false);
        expect(createCanvasView).not.toHaveBeenCalled();
        expect(view.open).not.toHaveBeenCalled();
    });
}

function diagramFixture() {
    let current = true;
    const onMove = jest.fn();
    const onSelect = jest.fn();
    const context = vm.createContext({ document: { createElementNS: (_namespace, name) => element(name) },
        crypto: { randomUUID: () => 'test-uuid' }, DOMPoint: class Point { constructor(x, y) { this.x = x; this.y = y; }
            matrixTransform() { return { x: this.x * 2, y: this.y * 2 }; } } });
    vm.runInContext(['canvasBounds', 'canvasEdgePoint', 'svgElement', 'canvasColor', 'canvasDiagram'].map(name => functionSource(source, name)).join('\n'), context);
    const node = initialDocument().nodes[0];
    const svg = context.canvasDiagram([{ ...node, label: 'Text card' }], [], { move: true, current: () => current, onMove, onSelect });
    svg.getScreenCTM = () => ({ inverse: () => ({}) });
    const group = find(svg, item => item.attributes['data-canvas-node'] === 'text');
    return { svg, group, onMove, onSelect, leave: () => { current = false; } };
}

test('moving a card applies one declared-position change only after pointer completion', () => {
    const f = diagramFixture();
    f.group.pointerdown({ pointerId: 1, button: 0, clientX: 10, clientY: 20, preventDefault: jest.fn() });
    f.group.pointermove({ pointerId: 1, clientX: 35, clientY: 40 });
    expect(f.onMove).not.toHaveBeenCalled();
    f.group.pointerup({ pointerId: 1 });
    expect(f.onMove).toHaveBeenCalledTimes(1);
    expect(f.onMove).toHaveBeenCalledWith('text', 50, 40);
});

test('cancelled or no-longer-current card gestures never apply a position change', () => {
    const f = diagramFixture();
    f.group.pointerdown({ pointerId: 1, button: 0, clientX: 10, clientY: 20, preventDefault: jest.fn() });
    f.group.pointermove({ pointerId: 1, clientX: 35, clientY: 40 });
    f.group.pointercancel();
    f.group.pointerup({ pointerId: 1 });
    expect(f.onMove).not.toHaveBeenCalled();
    f.group.pointerdown({ pointerId: 2, button: 0, clientX: 10, clientY: 20, preventDefault: jest.fn() });
    f.group.pointermove({ pointerId: 2, clientX: 35, clientY: 40 });
    f.leave();
    f.group.pointerup({ pointerId: 2 });
    expect(f.onMove).not.toHaveBeenCalled();
});

test('a phone-sized board keeps card captions readable and separate hit targets at least 44 pixels', () => {
    const context = vm.createContext({ document: { createElementNS: (_namespace, name) => element(name) }, crypto: { randomUUID: () => 'test' } });
    vm.runInContext(['canvasBounds', 'canvasEdgePoint', 'svgElement', 'canvasColor', 'canvasDiagram'].map(name => functionSource(source, name)).join('\n'), context);
    const nodes = [{ ...initialDocument().nodes[0], label: 'A readable card caption' }, { ...initialDocument().nodes[1], label: 'Reference', width: 1, height: 1 }];
    const svg = context.canvasDiagram(nodes, [], { viewportWidth: 320 });
    const viewBox = svg.attributes.viewBox.split(' ').map(Number);
    const pixelsPerUnit = 320 / viewBox[2];
    const caption = find(svg, node => node.tagName === 'TEXT');
    expect(Number.parseFloat(caption.style.fontSize) * pixelsPerUnit).toBeGreaterThanOrEqual(12);
    const hits = svg.children.filter(node => node.attributes['data-canvas-node']).map(group => find(group, node => node.attributes.class === 'notes-canvas-hit'));
    expect(hits).toHaveLength(2);
    for (const hit of hits) {
        expect(Number(hit.attributes.width) * pixelsPerUnit).toBeGreaterThanOrEqual(44);
        expect(Number(hit.attributes.height) * pixelsPerUnit).toBeGreaterThanOrEqual(44);
    }
});

test('a second pointer cancels a card move rather than replacing its original gesture', () => {
    const f = diagramFixture();
    f.group.pointerdown({ pointerId: 1, isPrimary: true, button: 0, clientX: 10, clientY: 20, preventDefault: jest.fn() });
    f.group.pointermove({ pointerId: 1, clientX: 35, clientY: 40 });
    f.group.pointerdown({ pointerId: 2, isPrimary: false, button: 0, clientX: 50, clientY: 50, preventDefault: jest.fn() });
    f.group.pointermove({ pointerId: 2, clientX: 100, clientY: 100 });
    f.group.pointerup({ pointerId: 2 });
    f.group.pointerup({ pointerId: 1 });
    expect(f.onMove).not.toHaveBeenCalled();
});

test('official preset card colours are rendered, not silently replaced by the default border', () => {
    const context = vm.createContext({ document: { createElementNS: (_namespace, name) => element(name) }, crypto: { randomUUID: () => 'test-uuid' } });
    vm.runInContext(['canvasBounds', 'canvasEdgePoint', 'svgElement', 'canvasColor', 'canvasDiagram'].map(name => functionSource(source, name)).join('\n'), context);
    const node = { ...initialDocument().nodes[0], label: 'Preset card', color: '2' };
    const svg = context.canvasDiagram([node], []);
    const rect = find(svg, element => element.tagName === 'RECT' && element.attributes.class !== 'notes-canvas-hit');
    expect(rect.style.stroke).toContain('var(--neco-ginger)');
    expect(node.color).toBe('2');
});

test('the real Notes host exposes its phone-layout helper to the lazy Canvas module', () => {
    const assignment = appSource.match(/Object\.assign\(app, \{[^]*?\n\}\);/)[0];
    const names = assignment.slice(assignment.indexOf('{') + 1, assignment.lastIndexOf('}')).match(/[a-zA-Z_]\w*/g);
    const host = { app: {}, ...Object.fromEntries(names.map(name => [name, () => true])) };
    vm.runInNewContext(assignment, host);
    expect(typeof host.app.isPhone).toBe('function');
    expect(host.app.isPhone()).toBe(true);
});
