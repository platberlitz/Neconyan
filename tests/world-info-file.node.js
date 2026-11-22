import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkLorebookHealth } from '../public/scripts/neconyan-lorebook-health.js';
import { deleteLorebookOriginalEntry, lorebookToCharacterBook } from '../public/scripts/neconyan-lorebook-tools-core.js';
import { parseSavedWorldInfo } from '../src/world-info-file.js';

test('normalises a hybrid saved list without changing IDs, folders or authored metadata', () => {
    const source = {
        name: 'Camp', extensions: { custom: { keep: true } },
        entries: [{
            uid: 100, id: 18, name: 'Camp', content: 'Near the river', key: ['camp'], keys: ['old key'],
            keysecondary: ['river'], disable: true, order: 50, position: 4, displayIndex: 8,
            extensions: { position: 0, depth: 2, custom: 'kept' }, vendor: { enabled: true },
        }, { id: 77, keys: ['a.b'], use_regex: true, enabled: true, content: 'A bridge', position: 'after_char' }],
    };
    const book = parseSavedWorldInfo(JSON.stringify(source));
    assert.deepEqual(Object.keys(book.entries), ['77', '100']);
    assert.deepEqual(book.extensions, source.extensions);
    assert.deepEqual(book.originalDataUidMap, { 77: 1, 100: 0 });
    const camp = book.entries[100];
    assert.deepEqual({ uid: camp.uid, key: camp.key, keysecondary: camp.keysecondary, comment: camp.comment,
        content: camp.content, disable: camp.disable, order: camp.order, position: camp.position,
        displayIndex: camp.displayIndex, depth: camp.depth, custom: camp.extensions.custom },
    { uid: 100, key: ['camp'], keysecondary: ['river'], comment: 'Camp', content: 'Near the river',
        disable: true, order: 50, position: 4, displayIndex: 8, depth: 2, custom: 'kept' });
    assert.equal(book.entries[77].position, 1);
    assert.deepEqual(book.entries[77].key, ['/a.b/']);
    camp.key = ['new key'];
    const exported = lorebookToCharacterBook(book).entries.find(entry => entry.id === 18);
    assert.deepEqual(exported.vendor, { enabled: true });
    assert.deepEqual(exported.keys, ['new key']);
    assert.equal(Object.hasOwn(exported, 'key'), false);
});

test('reserves later IDs, preserves damaged originals and reports only the unusable slots', () => {
    const text = JSON.stringify({ entries: [
        { content: 'ID missing', keys: ['alpha'] }, null, { uid: 100, content: 'First', key: ['beta'] },
        { uid: 100, content: 'Duplicate ID', key: ['gamma'] }, { id: '0', content: 'Reserved', keys: ['delta'] },
        { uid: 999, content: 42, key: ['invalid'] },
    ] });
    const book = parseSavedWorldInfo(text);
    assert.equal(book.entries[0].content, 'Reserved');
    assert.equal(book.entries[1].content, 'ID missing');
    assert.equal(book.entries[2].content, 'Duplicate ID');
    assert.equal(book.entries[100].content, 'First');
    assert.equal(book.entries['invalid-1'].disable, true);
    assert.equal(book.entries['invalid-1'].originalEntry, null);
    assert.equal(book.entries['invalid-5'].originalEntry.content, 42);
    assert.equal(checkLorebookHealth(book).diagnostics.filter(item => item.rule === 'damaged-entry').length, 2);
    assert.deepEqual(book, parseSavedWorldInfo(text));
    deleteLorebookOriginalEntry(book, 2);
    assert.equal(book.originalData.entries[book.originalDataUidMap[100]].content, 'First');
    assert.equal(book.originalData.entries[book.originalDataUidMap[0]].content, 'Reserved');
});

test('does not reinterpret native maps, including damaged slots', () => {
    const book = { entries: { 12: { uid: 12, content: 'A lake' }, 14: null } };
    assert.deepEqual(parseSavedWorldInfo(JSON.stringify(book)), book);
    assert.deepEqual(parseSavedWorldInfo('{"entries":[]}').entries, {});
});
