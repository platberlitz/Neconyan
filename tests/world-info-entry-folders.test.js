import { describe, expect, test } from '@jest/globals';
import { ENTRY_FOLDER_KEY, ENTRY_FOLDERS_KEY, addEntryFolder, getEntryFolder, getEntryFolders, groupEntriesByFolder, renameEntryFolder, setEntryFolder } from '../public/scripts/world-info-entry-folders.js';
import { serializeWorldInfoEntry } from '../public/scripts/world-info-character-book.js';

const entry = (uid, folder = '') => ({ uid, key: ['key'], content: 'Content', order: 17, group: 'Activation group', extensions: { custom: true, [ENTRY_FOLDER_KEY]: folder } });

describe('lorebook entry folders', () => {
    test('keeps empty folders and discovers folders carried by imported entries', () => {
        const data = { extensions: { other: true }, entries: { 0: entry(0, 'Imported') }, originalData: { extensions: { book: true } } };
        addEntryFolder(data, ' Empty ');
        addEntryFolder(data, 'Empty');
        expect(getEntryFolders(data)).toEqual(['Imported', 'Empty']);
        expect(data.extensions.other).toBe(true);
        expect(data.originalData.extensions).toEqual({ book: true, [ENTRY_FOLDERS_KEY]: ['Imported', 'Empty'] });
    });

    test('renames, merges and removes folders without touching activation or entry content', () => {
        const data = { entries: { 0: entry(0, 'First'), 1: entry(1, 'Second') } };
        const content = { ...data.entries[0], extensions: undefined };
        expect(renameEntryFolder(data, 'First', 'Second').map(e => e.uid)).toEqual([0]);
        expect(getEntryFolders(data)).toEqual(['Second']);
        renameEntryFolder(data, 'Second', '');
        expect(getEntryFolders(data)).toEqual([]);
        expect(getEntryFolder(data.entries[0])).toBe('');
        expect({ ...data.entries[0], extensions: undefined }).toEqual(content);
        expect(Object.keys(data.entries)).toEqual(['0', '1']);
    });

    test('groups before pagination, preserving the selected order inside each folder', () => {
        const entries = [entry(3, 'B'), entry(2, 'A'), entry(1, 'B'), entry(0)];
        const data = { entries: Object.fromEntries(entries.map(e => [e.uid, e])), extensions: { [ENTRY_FOLDERS_KEY]: ['A', 'B'] } };
        expect(groupEntriesByFolder(entries, data).map(e => e.uid)).toEqual([0, 2, 3, 1]);
        expect(groupEntriesByFolder(entries, data, 'B').map(e => e.uid)).toEqual([3, 1]);
        expect(entries.map(e => e.uid)).toEqual([3, 2, 1, 0]);
    });

    test('preserves and clears entry folders when serialising an embedded character book', () => {
        const source = entry(0, 'Characters');
        const positions = { before: 0, after: 1 };
        const saved = serializeWorldInfoEntry(source, positions);
        expect(saved.extensions[ENTRY_FOLDER_KEY]).toBe('Characters');
        setEntryFolder(source, '');
        const cleared = serializeWorldInfoEntry(source, positions, saved);
        expect(cleared.extensions[ENTRY_FOLDER_KEY]).toBe('');
        expect(cleared.extensions.custom).toBe(true);
    });
});
