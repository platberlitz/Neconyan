import { describe, expect, jest, test } from '@jest/globals';
import {
    changeLorebookDelimiter, delimitLorebook, exportLorebookProject, lorebookChanges, lorebookDigest,
    lorebookMergeCandidates, lorebookToCharacterBook, mergeLorebooks, parseLorebookImport,
    searchReplaceLorebook, serializeLorebook,
} from '../public/scripts/neconyan-lorebook-tools-core.js';

function book() {
    return {
        extensions: { foreign: { enabled: true } },
        entries: {
            0: { uid: 0, comment: 'Paris', content: 'Paris, PARIS, Parisian, 巴黎Paris. $1', key: ['Paris'], keysecondary: ['France'], order: 100, position: 4, role: 1, depth: 7 },
            8: { uid: 8, comment: 'Other', content: '<Other>\nUnchanged\n</Other>', key: [], disable: true, displayIndex: 1, extensions: { foreign: 'entry' } },
        },
    };
}

describe('native lorebook authoring', () => {
    test('literal, Unicode whole-word, and regex replacements preview without changing the source', () => {
        const original = book();
        const snapshot = structuredClone(original);
        const literal = searchReplaceLorebook(original, { search: '$1', replacement: '$&' });
        expect(literal.book.entries[0].content).toContain('$&');
        const words = searchReplaceLorebook(original, { search: 'Paris', replacement: 'Rome', wholeWord: true, fields: ['content', 'comment', 'key', 'keysecondary'] });
        expect(words.matches).toBe(4);
        expect(words.book.entries[0].content).toBe('Rome, Rome, Parisian, 巴黎Paris. $1');
        expect(words.book.entries[0].key).toEqual(['Rome']);
        const capture = searchReplaceLorebook(original, { search: '(Par)(is)', replacement: '$2$1', regex: true, caseSensitive: true });
        expect(capture.book.entries[0].content.startsWith('isPar')).toBe(true);
        expect(searchReplaceLorebook(original, { search: '^', replacement: '!', regex: true }).matches).toBe(2);
        expect(() => searchReplaceLorebook(original, { search: '[', regex: true })).toThrow();
        expect(original).toEqual(snapshot);
        expect(words.changes.map(change => change.uid)).toEqual(['0']);
        expect(words.book.entries[8]).toEqual(original.entries[8]);
    });

    test('secondary keys and imported records stay in sync, preserving foreign fields and card IDs', () => {
        const original = book();
        original.originalData = {
            custom: 'book metadata',
            entries: [{ id: 74, custom: 'entry metadata', content: original.entries[0].content, secondary_keys: ['France'] }],
        };
        original.originalDataUidMap = { 0: 0 };
        const result = searchReplaceLorebook(original, { search: 'France', replacement: 'Italy', fields: ['keysecondary'] });
        expect(result.book.entries[0].keysecondary).toEqual(['Italy']);
        expect(result.book.originalData.entries[0]).toMatchObject({ id: 74, custom: 'entry metadata', secondary_keys: ['Italy'] });
        expect(lorebookToCharacterBook(result.book)).toMatchObject({ custom: 'book metadata', entries: [{ id: 74 }, { id: 0 }] });
    });

    test('delimiter changes are idempotent, preserve plain content, and support a single-entry scope', () => {
        const content = '  text\nwith whitespace  ';
        expect(changeLorebookDelimiter(content, 'none')).toBe(content);
        for (const style of ['tag', 'bracket', 'separator']) {
            const wrapped = changeLorebookDelimiter(content, style, 'Name');
            expect(changeLorebookDelimiter(wrapped, style, 'Name')).toBe(wrapped);
            expect(changeLorebookDelimiter(wrapped, 'none')).toBe(content);
            expect(changeLorebookDelimiter(changeLorebookDelimiter('', style, 'Name'), style, 'Name')).toBe(changeLorebookDelimiter('', style, 'Name'));
        }
        expect(changeLorebookDelimiter('<Wrong>\ntext\n</Other>', 'none')).toBe('<Wrong>\ntext\n</Other>');
        const original = book();
        const result = delimitLorebook(original, { uid: '8', style: 'bracket', nameSource: 'fixed', name: '<A/B>\n' });
        expect(result.book.entries[8].content).toBe('[A B=\nUnchanged]');
        expect(result.book.entries[0]).toEqual(original.entries[0]);
    });

    test('legacy character books without a UID map keep their existing records', () => {
        const original = book();
        original.originalData = { entries: [{ id: 0, custom: 'first' }, { id: 8, custom: 'second' }] };
        const result = searchReplaceLorebook(original, { search: 'Paris', replacement: 'Rome' });
        expect(result.book.originalData.entries).toHaveLength(2);
        expect(result.book.originalDataUidMap).toEqual({ 0: 0, 8: 1 });
        expect(result.book.originalData.entries.map(entry => entry.custom)).toEqual(['first', 'second']);
    });

    test('merge choices preserve local UIDs, allocate unused IDs, and never overwrite skipped entries', () => {
        const original = book();
        const incoming = { entries: {
            2: { uid: 2, comment: 'Paris', content: 'Incoming Paris', key: [], foreign: 'preserve' },
            8: { uid: 8, comment: 'New', content: 'Imported as new', key: [] },
            9: { uid: 9, comment: 'Skipped', content: 'Skip', key: [] },
        } };
        expect(lorebookMergeCandidates(original, incoming).map(item => item.targetUid)).toEqual(['0', '8', null]);
        const result = mergeLorebooks(original, incoming, { 2: 'overwrite', 8: 'import', 9: 'skip' });
        expect(result.book.entries[0]).toMatchObject({ uid: 0, content: 'Incoming Paris', foreign: 'preserve' });
        expect(result.book.entries[1]).toMatchObject({ uid: 1, content: 'Imported as new' });
        expect(result.book.entries[8]).toEqual(original.entries[8]);
        expect(result.book.entries[9]).toBeUndefined();
        expect(result.book.extensions).toEqual(original.extensions);
        expect(original.entries[0].content).toContain('Paris, PARIS');
        expect(() => mergeLorebooks(original, incoming, { 9: 'overwrite' })).toThrow();
    });

    test('native project archives round-trip working data and every snapshot without conversion losses', () => {
        const original = book();
        original.arbitrary = { topLevel: true };
        original.entries[0].arbitrary = { entryLevel: true };
        const commit = { id: 'a'.repeat(64), parentId: null, timestamp: 10, message: 'Initial', snapshot: original };
        const history = { version: 1, id: 'project', headCommitId: commit.id, createdAt: 10, updatedAt: 11, commits: [commit] };
        const working = structuredClone(original);
        working.entries[0].content = 'Working edit';
        const exported = exportLorebookProject('My book', working, history);
        const convert = jest.fn();
        const imported = parseLorebookImport(JSON.parse(JSON.stringify(exported)), convert);
        expect(imported.book).toEqual(working);
        expect(imported.history.commits[0].snapshot).toEqual(original);
        expect(imported.history.headCommitId).toBe(commit.id);
        expect(convert).not.toHaveBeenCalled();
        expect(exported.workspace.activeBook.entries[0].extensions).toMatchObject({ position: 4, role: 1, depth: 7 });

        exported.workspace.activeBook.entries[0].content = 'Edited in LoreStitch';
        convert.mockImplementation(cardBook => ({ entries: { 0: { uid: 0, content: cardBook.entries[0].content } }, originalData: cardBook }));
        const edited = parseLorebookImport(exported, convert);
        expect(edited.book.originalData.entries[0].content).toBe('Edited in LoreStitch');
        expect(edited.book.entries[0].content).toBe('Edited in LoreStitch');
        expect(edited.book.entries[0].arbitrary).toEqual({ entryLevel: true });
        expect(edited.book.arbitrary).toEqual({ topLevel: true });
        expect(convert).toHaveBeenCalledTimes(1);
    });

    test('external LoreStitch names and normalized character filters reach the native converter', () => {
        const convert = jest.fn(cardBook => ({ entries: {}, originalData: cardBook }));
        const imported = parseLorebookImport({ entries: [{ name: 'Named', content: '', keys: [], extensions: {
            character_filter: { is_exclude: true, names: ['Nori'], tags: ['test'] },
        } }] }, convert);
        expect(imported.book.originalData.entries[0]).toMatchObject({
            comment: 'Named', character_filter: { isExclude: true, names: ['Nori'], tags: ['test'] },
        });
        expect(() => parseLorebookImport({ entries: [null] }, convert)).toThrow();
        expect(() => parseLorebookImport({ format: 'lorestitch-project', version: 2, workspace: {} }, convert)).toThrow();
    });

    test('changes include removals and metadata, while digests retain literal entry text', () => {
        const original = book();
        const changed = structuredClone(original);
        delete changed.entries[8];
        changed.extensions.foreign.enabled = false;
        expect(lorebookChanges(original, changed).map(change => change.uid)).toEqual(['8', null]);
        expect(lorebookDigest('Review', original)).toContain(original.entries[8].content);
        expect(lorebookDigest('Review', original)).toContain('(disabled)');
        expect(serializeLorebook({ z: 1, a: { b: 2, a: 1 } })).toBe(serializeLorebook({ a: { a: 1, b: 2 }, z: 1 }));
        expect({}.polluted).toBeUndefined();
        const foreign = JSON.parse('{"entries":{},"extensions":{"__proto__":{"polluted":true}}}');
        expect(serializeLorebook(foreign)).toContain('__proto__');
        expect({}.polluted).toBeUndefined();
    });
});
