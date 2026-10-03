import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, jest, test } from '@jest/globals';

const renderSource = fs.readFileSync(new URL('../public/scripts/notebooks/render.js', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../public/scripts/notebooks/notes-app.js', import.meta.url), 'utf8');
function functionSource(source, name) {
    return source.match(new RegExp(`(?:export )?(?:async )?function ${name}\\([^]*?\\n}`, 'm'))[0].replace(/^export /, '');
}

test('preview tokens accept only exact bounded source references and preserve every other character', () => {
    const text = '# Source\r\nBefore ![[Target]] after. ![[Other]]';
    const start = text.indexOf('![[Target]]');
    const node = { start, end: start + '![[Target]]'.length, status: 'unavailable' };
    const context = vm.createContext({ text, nodes: [node, node, { start: 0, end: 8 }, { start: -1, end: 3 }, { start: 1, end: text.length + 1 }] });
    vm.runInContext(functionSource(renderSource, 'prepareEmbedMarkdown') + '\n' + functionSource(renderSource, 'restoreEmbedTokens'), context);
    const result = vm.runInContext('prepareEmbedMarkdown(text, nodes, "testnonce")', context);
    expect(result.tokens.size).toBe(1);
    expect(result.markdown).toContain(' after. ![[Other]]');
    expect(result.markdown).toContain('# Source\r\nBefore ');
    context.result = result;
    expect(vm.runInContext('restoreEmbedTokens(result.markdown, result.tokens, text)', context)).toBe(text);
    expect(text).toBe('# Source\r\nBefore ![[Target]] after. ![[Other]]');
});

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function reader() {
    const pending = deferred();
    const app = { state: { note: { id: 'source', path: 'Source.md' }, account: 'owner', notebookId: 'book', view: 'read',
        noteRequestVersion: 0, notebookSelectionVersion: 0, readerRequestVersion: 0 },
    elements: { textarea: { value: '![[Target]]' }, reader: { querySelector: () => true } }, sourceEditor: { setFolds: jest.fn() } };
    const request = jest.fn(() => pending.promise);
    const renderNoteInto = jest.fn();
    const rememberFolds = jest.fn();
    const context = vm.createContext({ app, request, renderNoteInto, noteFolds: () => ['stored-fold'], attachmentUrl: jest.fn(), rememberFolds });
    vm.runInContext(functionSource(appSource, 'readerPreviewCurrent') + '\n' + functionSource(appSource, 'renderReader'), context);
    return { app, pending, request, renderNoteInto, rememberFolds, start: () => vm.runInContext('renderReader()', context) };
}

describe('Read preview response ownership', () => {
    test('requests the current owner draft and renders saved targets only after the matching response', async () => {
        const fixture = reader();
        const started = fixture.start();
        expect(fixture.request).toHaveBeenCalledWith('/embeds', { notebookId: 'book', noteId: 'source', text: '![[Target]]' });
        expect(fixture.renderNoteInto.mock.calls[0][2].embedLoading).toBe(true);
        fixture.pending.resolve({ status: 'success', embeds: [{ status: 'rendered', text: 'Saved target.' }] });
        await started;
        expect(fixture.renderNoteInto).toHaveBeenCalledTimes(2);
        expect(fixture.renderNoteInto.mock.calls[1][2].embeds[0].text).toBe('Saved target.');
        expect(fixture.renderNoteInto.mock.calls[1][2].noteId).toBe('source');
    });

    for (const field of ['note', 'account', 'notebookId', 'view', 'noteRequestVersion', 'notebookSelectionVersion', 'readerRequestVersion', 'text']) {
        test(`a later ${field} change cannot receive an old preview or its fold callback`, async () => {
            const fixture = reader();
            const started = fixture.start();
            const fold = fixture.renderNoteInto.mock.calls[0][2].onFold;
            if (field === 'text') fixture.app.elements.textarea.value = 'Newer text.';
            else if (field === 'note') fixture.app.state.note = { ...fixture.app.state.note, id: 'new-note' };
            else if (field.endsWith('Version')) fixture.app.state[field]++;
            else fixture.app.state[field] = field === 'view' ? 'write' : 'another';
            fixture.pending.resolve({ status: 'success', embeds: [{ text: 'Old preview.' }] });
            await started;
            expect(fixture.renderNoteInto).toHaveBeenCalledTimes(1);
            fold(['old-fold']);
            expect(fixture.rememberFolds).not.toHaveBeenCalled();
            expect(fixture.app.sourceEditor.setFolds).not.toHaveBeenCalled();
        });
    }

    test('a failed preview still produces ordinary safe generic placeholders', async () => {
        const fixture = reader();
        const started = fixture.start();
        fixture.pending.resolve({ status: 'failure' });
        await started;
        expect(fixture.renderNoteInto.mock.calls[1][2].embeds).toEqual([]);
        expect(fixture.renderNoteInto.mock.calls[1][2].embedLoading).toBeUndefined();
    });
});

test('embedded relative links resolve from their own source and cannot open over a later choice', async () => {
    const pending = deferred();
    const app = { state: { note: { id: 'root' }, notebookId: 'book', noteRequestVersion: 0, notebookSelectionVersion: 0 } };
    const request = jest.fn(() => pending.promise);
    const openNote = jest.fn();
    const context = vm.createContext({ app, request, openNote, failed: () => false });
    vm.runInContext(functionSource(appSource, 'followLink'), context);
    const started = vm.runInContext('followLink({target: "./Child", kind: "wiki", fromNoteId: "embedded-parent"})', context);
    expect(request).toHaveBeenCalledWith('/resolve', { notebookId: 'book', target: './Child', kind: 'wiki', fromNoteId: 'embedded-parent' });
    app.state.noteRequestVersion++;
    pending.resolve({ resolution: 'resolved', note: { id: 'child' } });
    await started;
    expect(openNote).not.toHaveBeenCalled();
});
