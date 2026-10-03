import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, jest, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../public/scripts/notebooks/graph.js', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../public/scripts/notebooks/notes-app.js', import.meta.url), 'utf8');
const noteId = number => `n_${number.toString(16).padStart(16, '0')}`;
const node = (number, title = `Note ${number}`) => ({ id: noteId(number), title, path: `Folder/${title}.md`, tags: [] });
const response = nodes => ({ status: 'success', nodes, edges: [], total: nodes.length, truncated: {} });

function functionSource(text, name) {
    return text.match(new RegExp(`(?:export )?(?:async )?function ${name}\\([^]*?\\n}`, 'm'))[0].replace(/^export /, '');
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function element(tag, attributes = {}, ...children) {
    const result = { tagName: tag.toUpperCase(), attributes, childNodes: children.flat(), dataset: attributes.dataset ?? {}, value: attributes.value ?? '',
        append(...nodes) { this.childNodes.push(...nodes); },
        setAttribute(name, value) { this.attributes[name] = value; },
        querySelectorAll() { return []; },
        get textContent() { return String(attributes.text ?? '') + this.childNodes.map(child => child?.textContent ?? child ?? '').join(''); },
    };
    for (const [key, value] of Object.entries(attributes)) {
        if (key.startsWith('on')) result[key.slice(2)] = value;
        if (key.startsWith('data-')) result.dataset[key.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
    }
    return result;
}

function find(root, predicate) {
    if (predicate(root)) return root;
    for (const child of root.childNodes ?? []) {
        const found = find(child, predicate);
        if (found) return found;
    }
    return null;
}

function fixture(request = jest.fn(async () => response([node(1)]))) {
    const app = { state: { workspaceView: 'graph', account: 'owner', notebookId: 'first-book', workspaceVersion: 1,
        notebookSelectionVersion: 2, noteRequestVersion: 3, layout: 'full' }, request, openNote: jest.fn(), closeNotebookView: jest.fn() };
    const container = element('section');
    const context = vm.createContext({ app, container, NODE_ID: /^n_[a-f\d]{16}$/, h: element,
        clear: target => { target.childNodes = []; }, graphDiagram: () => element('svg'),
        field: (label, control) => element('label', { text: label }, control),
        button: (label, click, options = {}) => element('button', { text: label, onclick: click, 'aria-pressed': options.pressed }),
        matchMedia: () => ({ matches: false }) });
    vm.runInContext(functionSource(source, 'graphScopeCurrent') + '\n' + functionSource(source, 'createGraphView'), context);
    const view = vm.runInContext('createGraphView(app, container)', context);
    return { app, view, container, field: name => find(container, item => item.attributes?.['aria-label'] === name),
        row: number => find(container, item => item.dataset?.graphNote === noteId(number)) };
}

test('all 300 diagram positions are distinct and inside the labelled diagram', () => {
    const context = vm.createContext({ nodes: Array.from({ length: 300 }, (_, index) => node(index + 1)) });
    vm.runInContext(functionSource(source, 'graphCoordinates'), context);
    const positions = [...vm.runInContext('graphCoordinates(nodes)', context).values()];
    expect(new Set(positions.map(point => `${point.x.toFixed(6)}:${point.y.toFixed(6)}`)).size).toBe(300);
    expect(positions.every(point => point.x >= 150 && point.x <= 750 && point.y >= 50 && point.y <= 650)).toBe(true);
});

test('a small notebook is framed around its notes rather than shrinking labels in an empty canvas', () => {
    const context = vm.createContext({ nodes: [node(1), node(2), node(3)],
        svgElement: (tag, attributes = {}, text = '') => element(tag, { ...attributes, text }) });
    vm.runInContext(functionSource(source, 'graphCoordinates') + '\n' + functionSource(source, 'graphDiagram'), context);
    const diagram = vm.runInContext('graphDiagram(nodes, [])', context);
    const bounds = diagram.attributes.viewBox.split(' ').map(Number);
    expect(bounds[2]).toBeLessThanOrEqual(440);
    expect(bounds[3]).toBeLessThanOrEqual(340);
    for (const point of vm.runInContext('graphCoordinates(nodes)', context).values()) {
        expect(point.x).toBeGreaterThan(bounds[0]);
        expect(point.x).toBeLessThan(bounds[0] + bounds[2]);
        expect(point.y + 27).toBeLessThan(bounds[1] + bounds[3]);
    }
});

test('a note control from an older notebook cannot open its id in a newly chosen notebook', async () => {
    const request = jest.fn().mockResolvedValueOnce(response([node(1)])).mockResolvedValueOnce(response([node(2)]));
    const { app, view, row } = fixture(request);
    await view.open();
    const oldControl = row(1);
    app.state.notebookId = 'second-book';
    app.state.workspaceVersion++;
    await view.open();
    oldControl.click();
    expect(app.openNote).not.toHaveBeenCalled();
    row(2).click();
    expect(app.openNote).toHaveBeenCalledWith('second-book', noteId(2), { pushBack: true });
});

test('arriving results keep an unsubmitted filter and its input control intact', async () => {
    const pending = deferred();
    const { view, field } = fixture(jest.fn(() => pending.promise));
    const opening = view.open();
    const folder = field('Graph folder');
    folder.value = 'World/Cities';
    pending.resolve(response([node(1)]));
    await opening;
    expect(field('Graph folder')).toBe(folder);
    expect(field('Graph folder').value).toBe('World/Cities');
});

test('an invalid graph response produces an actionable failure instead of an endless loading message', async () => {
    const { view, container } = fixture(jest.fn(async () => null));
    await view.open();
    expect(container.textContent).toContain('The graph could not be loaded. Try Refresh graph.');
    expect(container.textContent).not.toContain('Loading notebook links');
});

describe('graph request ordering', () => {
    test.each(['account', 'notebookId', 'workspaceView', 'workspaceVersion', 'notebookSelectionVersion', 'noteRequestVersion'])('a changed %s ignores an old result', async key => {
        const pending = deferred();
        const { app, view, container } = fixture(jest.fn(() => pending.promise));
        const opening = view.open();
        app.state[key] = typeof app.state[key] === 'number' ? app.state[key] + 1 : 'different';
        pending.resolve(response([node(1, 'OLD PRIVATE RESULT')]));
        await opening;
        expect(container.textContent).not.toContain('OLD PRIVATE RESULT');
    });

    test('a later refresh wins over an earlier response', async () => {
        const first = deferred();
        const request = jest.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(response([node(2, 'Newer result')]));
        const { view, container } = fixture(request);
        const opening = view.open();
        await view.refresh();
        first.resolve(response([node(1, 'Older result')]));
        await opening;
        expect(container.textContent).toContain('Newer result');
        expect(container.textContent).not.toContain('Older result');
        expect(request.mock.calls.every(([route]) => route === '/graph')).toBe(true);
    });

    test('clearing the view cannot be undone by a delayed reply', async () => {
        const first = deferred();
        const { view, container } = fixture(jest.fn(() => first.promise));
        const opening = view.open();
        view.clear();
        first.resolve(response([node(1)]));
        await opening;
        expect(container.childNodes).toEqual([]);
    });
});

test('opening and closing the graph keep the current source document and save state untouched', () => {
    const saved = { id: noteId(1), revision: 'revision' };
    const app = { state: { note: saved, notebookId: 'first-book', workspaceView: 'graph', workspaceVersion: 3, dirty: true, pending: { operationId: 'saved-operation' } },
        elements: { root: {}, graph: {}, editor: {}, empty: {} }, sourceEditor: { setDocument: jest.fn() } };
    const renderEditor = jest.fn();
    const context = vm.createContext({ app, renderEditor });
    vm.runInContext(functionSource(appSource, 'notebookCanvasCanLeave') + '\n' + functionSource(appSource, 'renderEditor').replace('function renderEditor', 'function actualRenderEditor') + '\n' + functionSource(appSource, 'closeNotebookView'), context);
    vm.runInContext('actualRenderEditor()', context);
    expect(app.sourceEditor.setDocument).not.toHaveBeenCalled();
    vm.runInContext('closeNotebookView()', context);
    expect(app.state.note).toBe(saved);
    expect(app.state.dirty).toBe(true);
    expect(app.state.pending).toEqual({ operationId: 'saved-operation' });
    expect(app.state.workspaceVersion).toBe(4);
    expect(renderEditor).toHaveBeenCalledTimes(1);
});

test.each(['noteRequestVersion', 'notebookSelectionVersion'])('a changed %s during lazy loading cannot open an obsolete graph', async key => {
    const pending = deferred();
    const graphView = { open: jest.fn() };
    const app = { state: { notebookId: 'first-book', account: 'owner', workspaceVersion: 0, notebookSelectionVersion: 0, noteRequestVersion: 0 },
        elements: { graph: element('section') }, sourceEditor: { composing: false } };
    const context = vm.createContext({ app, applyLayout: jest.fn(), renderEditor: jest.fn(), clear: target => { target.childNodes = []; }, h: element,
        button: element, closeNotebookView: jest.fn(), loadGraphModule: () => pending.promise });
    const guard = appSource.includes('function notebookWorkspaceCurrent(') ? functionSource(appSource, 'notebookWorkspaceCurrent') : '';
    vm.runInContext(functionSource(appSource, 'notebookCanvasCanLeave') + '\n' + guard + '\n' + functionSource(appSource, 'openNotebookGraph').replace('await import(\'./graph.js\')', 'await loadGraphModule()'), context);
    const opening = vm.runInContext('openNotebookGraph()', context);
    app.state[key]++;
    pending.resolve({ createGraphView: () => graphView });
    await opening;
    expect(graphView.open).not.toHaveBeenCalled();
});
