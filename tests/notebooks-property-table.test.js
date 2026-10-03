import fs from 'node:fs';
import vm from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { expect, jest, test } from '@jest/globals';
import { parsePropertyValue, propertyInput } from '../public/scripts/notebooks/property-values.js';

const source = fs.readFileSync(new URL('../public/scripts/notebooks/property-table.js', import.meta.url), 'utf8');
const dialogSource = fs.readFileSync(new URL('../public/scripts/notebooks/notes-dialogs.js', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../public/scripts/notebooks/notes-app.js', import.meta.url), 'utf8');
const domSource = fs.readFileSync(new URL('../public/scripts/notebooks/dom.js', import.meta.url), 'utf8');
const id = number => `n_${number.toString(16).padStart(16, '0')}`;
const row = (number = 1, title = 'Original row') => ({ id: id(number), title, path: `${title}.md`, revision: 'loaded-revision',
    cells: { score: { kind: 'number', value: 2, display: '2', editable: true } } });
const response = (rows = [row()], overrides = {}) => ({ status: 'success', rows, columns: ['score'], availableColumns: ['score'],
    offset: 0, total: rows.length, nextOffset: null, limited: {}, ...overrides });

function functionSource(text, name) {
    return text.match(new RegExp(`(?:export )?(?:async )?function ${name}\\([^]*?\\n}`, 'm'))[0].replace(/^export /, '');
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function element(tag, attributes = {}, ...children) {
    let text = String(attributes.text ?? '');
    const result = { tagName: tag.toUpperCase(), attributes, childNodes: children.flat(), dataset: {}, value: attributes.value ?? '',
        append(...nodes) { this.childNodes.push(...nodes); },
        setAttribute(name, value) { this.attributes[name] = value; },
        querySelector(selector) { return selector === 'details' ? find(this, node => node.tagName === 'DETAILS') : null; },
        get open() { return this.attributes.open === true; },
        set open(value) { this.attributes.open = Boolean(value); },
        get id() { return this.attributes.id; },
        set id(value) { this.attributes.id = value; },
        get textContent() { return text + this.childNodes.map(child => child?.textContent ?? child ?? '').join(''); },
        set textContent(value) { text = String(value); this.childNodes = []; },
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

const helpers = {
    h: element, clear: target => { target.childNodes = []; },
    button: (label, click, options = {}) => element('button', { ...options, text: label, onclick: click, 'aria-pressed': options.pressed }),
    field: (label, control) => element('label', { text: label }, control), parsePropertyValue, propertyInput,
};

function tableFixture(request = jest.fn(async () => response())) {
    const app = { state: { workspaceView: 'table', account: 'owner', notebookId: 'first-book', workspaceVersion: 1,
        notebookSelectionVersion: 2, noteRequestVersion: 3 }, request, openNote: jest.fn(), toast: jest.fn(),
    refreshTree: jest.fn(), closeNotebookView: jest.fn(), dialogs: { editPropertyCell: jest.fn(async () => true) } };
    const container = element('section');
    const context = vm.createContext({ ...helpers, app, container });
    vm.runInContext(functionSource(domSource, 'button') + '\n' + functionSource(source, 'propertyTableScopeCurrent') + '\n'
        + functionSource(source, 'bindPropertyTableTouchScroll') + '\n' + functionSource(source, 'createPropertyTableView'), context);
    const view = vm.runInContext('createPropertyTableView(app, container)', context);
    const control = label => find(container, item => item.tagName === 'BUTTON' && item.textContent === label);
    const fieldValue = label => find(container, item => item.tagName === 'LABEL' && item.attributes.text === label)?.childNodes[0];
    const cell = () => find(container, item => item.attributes['aria-label'] === 'Edit score for Original row');
    return { app, view, container, control, fieldValue, cell };
}

function dialogFixture(cell = row().cells.score, request = jest.fn(async () => ({ status: 'success' })), isCurrent = () => true) {
    const ending = deferred();
    let content;
    let options;
    let operations = 0;
    const savedRow = { ...row(), notebookId: 'first-book' };
    const currentNote = { id: savedRow.id, revision: 'loaded-revision' };
    const app = { state: { note: currentNote, notebookId: 'first-book', dirty: false, saveConflict: false, saving: false },
        sourceEditor: { composing: false }, request, reloadNote: jest.fn(async () => true) };
    const context = vm.createContext({ ...helpers, app, savedRow, cell, isCurrent, POPUP_RESULT: { AFFIRMATIVE: 1 },
        fieldId: () => 'test-property', newOperationId: () => `property:test:${++operations}`,
        dialog: (node, settings) => { content = node; options = settings; return ending.promise; } });
    vm.runInContext(functionSource(domSource, 'field') + '\n' + functionSource(dialogSource, 'editPropertyCell'), context);
    const finished = vm.runInContext('editPropertyCell(app, savedRow, "score", cell, { isCurrent })', context);
    return { app, savedRow, currentNote, finished, ending, get content() { return content; },
        value: () => find(content, node => node.tagName === 'TEXTAREA'),
        type: label => find(content, node => node.tagName === 'BUTTON' && node.attributes.text === label).click(),
        close: result => options.onClosing({ result }) };
}

test('property values keep explicit types and reject coercion, nesting and excessive editable values', () => {
    expect(parsePropertyValue('text', '002')).toBe('002');
    expect(parsePropertyValue('number', '-2.5e2')).toBe(-250);
    expect(parsePropertyValue('boolean', 'false')).toBe(false);
    expect(parsePropertyValue('list', '["002", 2, false]')).toEqual(['002', 2, false]);
    expect(parsePropertyValue('remove', 'unused')).toBe(null);
    for (const value of ['', 'NaN', 'Infinity', '0x20', '2x']) expect(() => parsePropertyValue('number', value)).toThrow();
    for (const value of ['{}', '[[2]]', '[null]', '[1e999]']) expect(() => parsePropertyValue('list', value)).toThrow();
    expect(() => parsePropertyValue('text', '🐱'.repeat(1100))).toThrow(/4096/);
});

function touchFixture() {
    const listeners = new Map();
    const pane = { scrollTop: 100, scrollHeight: 1000, clientHeight: 400, classList: { contains: jest.fn(() => true) } };
    const rail = { isConnected: true, closest: () => pane, addEventListener: (name, listener) => listeners.set(name, listener) };
    const context = vm.createContext({ rail });
    vm.runInContext(functionSource(source, 'bindPropertyTableTouchScroll') + '\nbindPropertyTableTouchScroll(rail)', context);
    const touch = (name, x, y, count = 1) => {
        const event = { touches: Array.from({ length: count }, (_item, index) => ({ identifier: index, clientX: x, clientY: y })),
            cancelable: true, preventDefault: jest.fn() };
        listeners.get(name)(event);
        return event;
    };
    return { pane, rail, touch };
}

test('vertical table swipes move only the owned table pane, and remain bounded', () => {
    const fixture = touchFixture();
    fixture.touch('touchstart', 100, 200);
    expect(fixture.touch('touchmove', 101, 100).preventDefault).toHaveBeenCalledTimes(1);
    expect(fixture.pane.scrollTop).toBe(200);
    fixture.touch('touchmove', 101, -1000);
    expect(fixture.pane.scrollTop).toBe(600);
    fixture.touch('touchmove', 101, 1000);
    expect(fixture.pane.scrollTop).toBe(0);
});

test('horizontal table swipes and taps retain native handling', () => {
    const fixture = touchFixture();
    fixture.touch('touchstart', 200, 100);
    expect(fixture.touch('touchmove', 197, 102).preventDefault).not.toHaveBeenCalled();
    expect(fixture.touch('touchmove', 100, 101).preventDefault).not.toHaveBeenCalled();
    expect(fixture.pane.scrollTop).toBe(100);
});

test('cancelled, multi-touch and no-longer-table gestures cannot scroll another view', () => {
    const fixture = touchFixture();
    fixture.touch('touchstart', 100, 200);
    fixture.touch('touchcancel', 100, 200, 0);
    fixture.touch('touchmove', 100, 100);
    fixture.touch('touchstart', 100, 200, 2);
    fixture.touch('touchmove', 100, 100);
    fixture.touch('touchstart', 100, 200);
    fixture.pane.classList.contains.mockReturnValue(false);
    fixture.touch('touchmove', 100, 100);
    fixture.pane.classList.contains.mockReturnValue(true);
    fixture.touch('touchstart', 100, 200);
    fixture.rail.isConnected = false;
    fixture.touch('touchmove', 100, 100);
    expect(fixture.pane.scrollTop).toBe(100);
});

test('table inputs remain intact while results arrive, including unsubmitted filters', async () => {
    const pending = deferred();
    const fixture = tableFixture(jest.fn(() => pending.promise));
    const opening = fixture.view.open();
    const input = fixture.fieldValue('Folder');
    input.value = 'World/Cities';
    pending.resolve(response());
    await opening;
    expect(fixture.fieldValue('Folder')).toBe(input);
    expect(input.value).toBe('World/Cities');
});

test('choosing multiple columns keeps the same expanded picker and its controls', async () => {
    const fixture = tableFixture();
    await fixture.view.open();
    const picker = find(fixture.container, node => node.tagName === 'DETAILS');
    const score = fixture.control('score');
    picker.open = true;
    score.click();
    expect(find(fixture.container, node => node.tagName === 'DETAILS')).toBe(picker);
    await nextTurn();
    expect(find(fixture.container, node => node.tagName === 'DETAILS')).toBe(picker);
    expect(picker.open).toBe(true);
    expect(fixture.control('score')).toBe(score);
    expect(score.attributes['aria-pressed']).toBe('false');
});

test('an older successful request cannot erase a newer invalid filter and its explanation', async () => {
    const pending = deferred();
    const fixture = tableFixture(jest.fn(() => pending.promise));
    const opening = fixture.view.open();
    fixture.fieldValue('Filter property').value = 'score';
    fixture.fieldValue('Filter value').value = 'not a number';
    fixture.fieldValue('Filter value type').value = 'number';
    const form = find(fixture.container, node => node.tagName === 'FORM');
    form.submit({ preventDefault() {} });
    expect(fixture.container.textContent).toContain('Enter a finite number');
    pending.resolve(response([row(2, 'OUTDATED RESULT')]));
    await opening;
    expect(fixture.container.textContent).toContain('Enter a finite number');
    expect(fixture.container.textContent).not.toContain('OUTDATED RESULT');
});

test.each(['account', 'notebookId', 'workspaceView', 'workspaceVersion', 'notebookSelectionVersion', 'noteRequestVersion'])('changing %s rejects a delayed property table result', async key => {
    const pending = deferred();
    const fixture = tableFixture(jest.fn(() => pending.promise));
    const opening = fixture.view.open();
    fixture.app.state[key] = typeof fixture.app.state[key] === 'number' ? fixture.app.state[key] + 1 : 'different';
    pending.resolve(response([row(1, 'PRIVATE OLD ROW')]));
    await opening;
    expect(fixture.container.textContent).not.toContain('PRIVATE OLD ROW');
});

test('old note and edit controls cannot act in a later notebook', async () => {
    const fixture = tableFixture(jest.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response([row(2)])));
    await fixture.view.open();
    const oldNote = fixture.control('Original row');
    const oldCell = fixture.cell();
    fixture.app.state.notebookId = 'second-book';
    fixture.app.state.workspaceVersion++;
    await fixture.view.open();
    oldNote.click();
    await oldCell.click();
    expect(fixture.app.openNote).not.toHaveBeenCalled();
    expect(fixture.app.dialogs.editPropertyCell).not.toHaveBeenCalled();
});

test('cell edits carry the displayed revision and refresh only the same table', async () => {
    const fixture = tableFixture();
    await fixture.view.open();
    await fixture.cell().click();
    expect(fixture.app.dialogs.editPropertyCell).toHaveBeenCalledWith(fixture.app, expect.objectContaining({ notebookId: 'first-book', id: id(1), revision: 'loaded-revision' }),
        'score', expect.objectContaining({ kind: 'number', value: 2 }), expect.objectContaining({ isCurrent: expect.any(Function) }));
    expect(fixture.app.refreshTree).toHaveBeenCalledTimes(1);
    expect(fixture.app.request.mock.calls.every(([route]) => route === '/properties/table')).toBe(true);
});

test('cell and note buttons use the native helper with descriptive edit labels and their intended classes', async () => {
    const fixture = tableFixture();
    await fixture.view.open();
    expect(fixture.cell()).not.toBeNull();
    expect(fixture.cell().attributes['aria-label']).toBe('Edit score for Original row');
    expect(fixture.cell().attributes.class).toContain('notes-property-cell');
    expect(fixture.control('Original row').attributes.class).toContain('notes-table-note');
});

test('server pagination preserves exact offsets and the previous page', async () => {
    const fixture = tableFixture(jest.fn().mockResolvedValueOnce(response([row()], { total: 51, nextOffset: 1 }))
        .mockResolvedValueOnce(response([row(2)], { total: 51, offset: 1, nextOffset: 2 })).mockResolvedValueOnce(response()));
    await fixture.view.open();
    fixture.control('Next page').click();
    await nextTurn();
    fixture.control('Previous page').click();
    await nextTurn();
    expect(fixture.app.request.mock.calls.map(([, body]) => body.offset)).toEqual([0, 1, 0]);
});

test('a property modal uses the loaded revision, preserves types and writes only ordinary property changes', async () => {
    const fixture = dialogFixture();
    fixture.value().value = '3.5';
    expect(await fixture.close(1)).toBe(true);
    expect(fixture.app.request).toHaveBeenCalledWith('/notes/update', { operationId: 'property:test:1', notebookId: 'first-book', noteId: id(1),
        expectedRevision: 'loaded-revision', changes: [{ type: 'properties', set: { score: 3.5 } }], reason: 'edit' });
    fixture.ending.resolve({ ok: true });
    expect(await fixture.finished).toBe(true);
});

test('the native property field has a useful label without an object printed as a hint', async () => {
    const fixture = dialogFixture();
    expect(fixture.content.textContent).not.toContain('[object Object]');
    expect(fixture.value().id).toBe('test-property');
    fixture.ending.resolve({ ok: false });
    await fixture.finished;
});

test('invalid and stale values remain in the modal and never acquire a refreshed revision', async () => {
    const fixture = dialogFixture(undefined, jest.fn(async () => ({ status: 'conflict', code: 'NOTE_CONFLICT' })));
    fixture.value().value = 'not a number';
    expect(await fixture.close(1)).toBe(false);
    expect(fixture.app.request).not.toHaveBeenCalled();
    fixture.value().value = '5';
    expect(await fixture.close(1)).toBe(false);
    expect(fixture.value().value).toBe('5');
    expect(fixture.content.textContent).toContain('Nothing was overwritten');
    expect(fixture.app.request.mock.calls[0][1].expectedRevision).toBe('loaded-revision');
    fixture.ending.resolve({ ok: false });
    expect(await fixture.finished).toBe(false);
});

test('identical failed retries reuse their operation, but a changed value gets a new one', async () => {
    const fixture = dialogFixture(undefined, jest.fn(async () => ({ status: 'failure' })));
    fixture.value().value = '5';
    await fixture.close(1);
    await fixture.close(1);
    fixture.value().value = '6';
    await fixture.close(1);
    expect(fixture.app.request.mock.calls.map(([, body]) => body.operationId)).toEqual(['property:test:1', 'property:test:1', 'property:test:2']);
    expect(fixture.app.request.mock.calls.every(([, body]) => body.expectedRevision === 'loaded-revision')).toBe(true);
    fixture.ending.resolve({ ok: false });
    await fixture.finished;
});

test('a second save or cancel cannot close an in-flight property operation', async () => {
    const pending = deferred();
    const fixture = dialogFixture(undefined, jest.fn(() => pending.promise));
    fixture.value().value = '5';
    const saving = fixture.close(1);
    expect(await fixture.close(1)).toBe(false);
    expect(await fixture.close(0)).toBe(false);
    expect(fixture.app.request).toHaveBeenCalledTimes(1);
    pending.resolve({ status: 'success' });
    expect(await saving).toBe(true);
    fixture.ending.resolve({ ok: true });
    await fixture.finished;
});

test.each(['dirty', 'saveConflict', 'saving'])('the table cannot replace a current note with %s state', async key => {
    const fixture = dialogFixture();
    fixture.app.state[key] = true;
    fixture.value().value = '5';
    expect(await fixture.close(1)).toBe(false);
    expect(fixture.app.request).not.toHaveBeenCalled();
    fixture.ending.resolve({ ok: false });
    await fixture.finished;
});

test('a successful older cell operation cannot reload a later chosen note', async () => {
    const pending = deferred();
    let current = true;
    const fixture = dialogFixture(undefined, jest.fn(() => pending.promise), () => current);
    fixture.value().value = '5';
    const saving = fixture.close(1);
    current = false;
    fixture.app.state.note = { id: id(2) };
    pending.resolve({ status: 'success' });
    expect(await saving).toBe(true);
    expect(fixture.app.reloadNote).not.toHaveBeenCalled();
    fixture.ending.resolve({ ok: true });
    await fixture.finished;
});

test('composition and a changed table scope cannot write through an old property dialog', async () => {
    const composing = dialogFixture();
    composing.app.sourceEditor.composing = true;
    composing.value().value = '7';
    expect(await composing.close(1)).toBe(false);
    expect(composing.app.request).not.toHaveBeenCalled();
    composing.ending.resolve({ ok: false });
    await composing.finished;
    const changed = dialogFixture(undefined, undefined, () => false);
    changed.value().value = '7';
    expect(await changed.close(1)).toBe(false);
    expect(changed.app.request).not.toHaveBeenCalled();
    expect(changed.content.textContent).toContain('The table changed');
    changed.ending.resolve({ ok: false });
    await changed.finished;
});

test('a late successful cell save cannot refresh a different notebook', async () => {
    const pending = deferred();
    const fixture = tableFixture();
    fixture.app.dialogs.editPropertyCell.mockImplementationOnce(() => pending.promise);
    await fixture.view.open();
    const editing = fixture.cell().click();
    fixture.app.state.notebookId = 'second-book';
    fixture.app.state.workspaceVersion++;
    pending.resolve(true);
    await editing;
    expect(fixture.app.refreshTree).not.toHaveBeenCalled();
    expect(fixture.app.request).toHaveBeenCalledTimes(1);
});

test.each(['noteRequestVersion', 'notebookSelectionVersion'])('lazy table loading cannot override a newer %s intent', async key => {
    const pending = deferred();
    const tableView = { open: jest.fn() };
    const app = { state: { notebookId: 'first-book', account: 'owner', workspaceVersion: 0, notebookSelectionVersion: 0, noteRequestVersion: 0 },
        elements: { propertyTable: element('section') }, sourceEditor: { composing: false } };
    const context = vm.createContext({ ...helpers, app, applyLayout: jest.fn(), renderEditor: jest.fn(), closeNotebookView: jest.fn(), loadTableModule: () => pending.promise });
    vm.runInContext(functionSource(appSource, 'notebookCanvasCanLeave') + '\n' + functionSource(appSource, 'notebookWorkspaceCurrent') + '\n' + functionSource(appSource, 'openNotebookTable')
        .replace('await import(\'./property-table.js\')', 'await loadTableModule()'), context);
    const opening = vm.runInContext('openNotebookTable()', context);
    app.state[key]++;
    pending.resolve({ createPropertyTableView: () => tableView });
    await opening;
    expect(tableView.open).not.toHaveBeenCalled();
});
