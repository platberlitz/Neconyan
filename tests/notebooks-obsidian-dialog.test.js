import fs from 'node:fs';
import vm from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { expect, jest, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../public/scripts/notebooks/obsidian-dialogs.js', import.meta.url), 'utf8');
const dialogs = fs.readFileSync(new URL('../public/scripts/notebooks/notes-dialogs.js', import.meta.url), 'utf8');
const dom = fs.readFileSync(new URL('../public/scripts/notebooks/dom.js', import.meta.url), 'utf8');
const popupTypes = fs.readFileSync(new URL('../public/scripts/popup.js', import.meta.url), 'utf8').match(/export const POPUP_TYPE = [^]*?\n};/)[0].replace(/^export /, '');
const extract = (text, name) => text.match(new RegExp(`(?:export )?(?:async )?function ${name}\\([^]*?\\n}`, 'm'))[0].replace(/^export /, '');

function element(tag, attributes = {}, ...children) {
    return {
        tagName: tag.toUpperCase(), attributes, children: children.flat().filter(Boolean), value: String(attributes.value ?? ''),
        checked: Boolean(attributes.checked), disabled: Boolean(attributes.disabled), textContent: attributes.text ?? '',
        id: attributes.id ?? '', onclick: attributes.onclick, oninput: attributes.oninput,
        append(...values) { this.children.push(...values.flat().filter(Boolean)); },
        setAttribute(key, value) { this.attributes[key] = String(value); },
    };
}
const all = node => [node, ...(node?.children ?? []).flatMap(all)];
const text = node => `${node.textContent ?? ''}${(node.children ?? []).map(text).join('')}`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture() {
    const state = { open: true, account: 'owner', notebookId: 'first', notebookSelectionVersion: 1, noteRequestVersion: 2, workspaceVersion: 3 };
    const snapshot = { ...state };
    let content;
    let options;
    let count = 0;
    const adapter = { available: true, configured: false, revision: null, candidateFolder: '/approved/first', running: false };
    const request = jest.fn(async route => route === '/obsidian/history' ? { status: 'success', history: [] } : { status: 'success', adapter: { ...adapter } });
    const app = { state, request };
    const context = vm.createContext({ app, snapshot, h: element, clear: node => { node.children = []; node.textContent = ''; },
        formatTime: value => value, newOperationId: () => `test-op:${++count}`,
        callGenericPopup: async (node, _type, _value, configured) => { content = node; options = configured; configured.onOpen(); return 1; },
        notesDownload: jest.fn(), URL, setTimeout, document: { body: element('body') } });
    vm.runInContext(`${popupTypes}\n${extract(dom, 'button')}\n${extract(dom, 'field')}\n${extract(source, 'obsidianDialogCurrent')}\n${extract(source, 'openObsidianSync')}`, context);
    await context.openObsidianSync(app, snapshot);
    await nextTurn();
    return { state, snapshot, app, request, adapter, context, options, content,
        control: label => all(content).find(node => node.tagName === 'BUTTON' && text(node) === label),
        folder: all(content).find(node => node.tagName === 'INPUT' && node.attributes.type === 'text'),
        checkbox: all(content).find(node => node.tagName === 'INPUT' && node.attributes.type === 'checkbox'),
    };
}

test('opening optional controls only reads status and private history, and never starts or approves a client', async () => {
    const f = await fixture();
    expect(f.request.mock.calls.map(([route]) => route)).toEqual(['/obsidian/status', '/obsidian/history']);
    expect(f.folder.value).toBe('/approved/first');
    expect(f.control('Start client').disabled).toBe(true);
    expect(text(f.content)).not.toContain('[object Object]');
});

test('folder approval and starting are separate explicit actions with the loaded settings revision', async () => {
    const f = await fixture();
    f.control('Approve folder').onclick();
    await nextTurn();
    expect(f.request).toHaveBeenCalledTimes(2);
    f.checkbox.checked = true;
    f.request.mockImplementation(async route => route === '/obsidian/history' ? { status: 'success', history: [] }
        : { status: 'success', adapter: { ...f.adapter, configured: true, folder: '/approved/first', revision: 'loaded-revision' } });
    f.control('Approve folder').onclick();
    await nextTurn();
    expect(f.request.mock.calls.find(([route]) => route === '/obsidian/configure')[1]).toMatchObject({ notebookId: 'first', expectedRevision: null, singleMechanism: true, folder: '/approved/first' });
    expect(f.request.mock.calls.some(([route]) => route === '/obsidian/start')).toBe(false);
    f.control('Start client').onclick();
    await nextTurn();
    expect(f.request.mock.calls.find(([route]) => route === '/obsidian/start')[1]).toMatchObject({ notebookId: 'first', expectedRevision: 'loaded-revision' });
});

test('a failed approval retry keeps its operation id and the entered folder without replacing the loaded revision', async () => {
    const f = await fixture();
    f.checkbox.checked = true;
    f.folder.value = '/approved/first';
    f.folder.oninput();
    f.request.mockResolvedValue({ status: 'conflict', http: 409, message: 'Refresh these settings before saving.' });
    f.control('Approve folder').onclick();
    await nextTurn();
    f.control('Approve folder').onclick();
    await nextTurn();
    const attempts = f.request.mock.calls.filter(([route]) => route === '/obsidian/configure').map(([, body]) => body);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(f.folder.value).toBe('/approved/first');
    expect(f.control('Start client').disabled).toBe(true);
});

test('refreshing status keeps an unsubmitted folder value and uses no unchecked write', async () => {
    const f = await fixture();
    f.folder.value = '/typed/not-yet-approved';
    f.folder.oninput();
    f.control('Refresh status').onclick();
    await nextTurn();
    expect(f.folder.value).toBe('/typed/not-yet-approved');
    expect(f.request.mock.calls.every(([route]) => route === '/obsidian/status' || route === '/obsidian/history')).toBe(true);
});

test('an active request blocks duplicate actions and closing until its owned reply completes', async () => {
    const f = await fixture();
    const gate = deferred();
    f.request.mockReturnValue(gate.promise);
    f.control('Refresh status').onclick();
    f.control('Refresh status').onclick();
    expect(f.request).toHaveBeenCalledTimes(3);
    expect(f.options.onClosing()).toBe(false);
    gate.resolve({ status: 'failure', message: 'Offline.' });
    await nextTurn();
    expect(f.options.onClosing()).toBe(true);
});

test('a stale dialog can close after its reply is ignored for a later notebook', async () => {
    const f = await fixture();
    const gate = deferred();
    f.request.mockReturnValue(gate.promise);
    f.control('Refresh status').onclick();
    f.state.notebookId = 'second';
    gate.resolve({ status: 'success', adapter: { ...f.adapter } });
    await nextTurn();
    expect(f.options.onClosing()).toBe(true);
});

test('a client reported as starting cannot be started or reconfigured a second time', async () => {
    const f = await fixture();
    f.request.mockImplementation(async route => route === '/obsidian/history' ? { status: 'success', history: [] }
        : { status: 'success', adapter: { ...f.adapter, configured: true, busy: true, revision: 'loaded-revision' } });
    f.control('Refresh status').onclick();
    await nextTurn();
    expect(f.control('Start client').disabled).toBe(true);
    expect(f.control('Approve folder').disabled).toBe(true);
    expect(f.control('Stop client').disabled).toBe(false);
});

for (const [key, value] of [['account', 'other-owner'], ['notebookId', 'second'], ['open', false], ['notebookSelectionVersion', 4], ['noteRequestVersion', 5], ['workspaceVersion', 6]]) {
    test(`an old sync dialog ignores replies and controls after ${key} changes`, async () => {
        const f = await fixture();
        const gate = deferred();
        f.request.mockReturnValue(gate.promise);
        f.control('Refresh status').onclick();
        f.state[key] = value;
        gate.resolve({ status: 'success', adapter: { ...f.adapter, folder: '/foreign-folder', running: true } });
        await nextTurn();
        expect(text(f.content)).not.toContain('/foreign-folder');
        const previous = f.request.mock.calls.length;
        f.control('Stop client').onclick();
        expect(f.request).toHaveBeenCalledTimes(previous);
    });
}

test('an old lazy sync-controls import cannot open a popup after another notebook is chosen', async () => {
    const gate = deferred();
    const app = { state: { account: 'owner', notebookId: 'first', workspaceVersion: 1, notebookSelectionVersion: 1, noteRequestVersion: 1 } };
    const open = jest.fn();
    const context = vm.createContext({ app, loadControls: () => gate.promise });
    vm.runInContext(extract(dialogs, 'obsidianSync').replace('import(\'./obsidian-dialogs.js\')', 'loadControls()'), context);
    const pending = context.obsidianSync(app);
    app.state.notebookSelectionVersion++;
    gate.resolve({ obsidianDialogCurrent: (host, snapshot) => host.state.notebookSelectionVersion === snapshot.notebookSelectionVersion, openObsidianSync: open });
    await pending;
    expect(open).not.toHaveBeenCalled();
});
