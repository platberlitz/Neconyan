import { describe, expect, test } from '@jest/globals';
import { defaultLorebookName, mergeLoreEntries } from '../public/scripts/mewmory/lorebook.js';

function book() {
    let uid = 0;
    const data = { entries: { 0: { uid: 0, comment: 'Hand written', key: ['door'], content: 'Keep me.' } } };
    const create = target => {
        uid += 1;
        target.entries[uid] = { uid, comment: '', key: [], content: '' };
        return target.entries[uid];
    };
    return { data, create };
}

describe('Mewmory lorebook export', () => {
    test('the default name follows the chat and stays short', () => {
        expect(defaultLorebookName('Gift')).toBe('Mewmory - Gift');
        expect(defaultLorebookName('')).toBe('Mewmory - chat');
        expect(defaultLorebookName('x'.repeat(300))).toHaveLength(120);
    });

    test('sending twice updates the same entries instead of adding copies', () => {
        const { data, create } = book();
        const entries = [
            { id: 'event:gift', version: 1, title: 'Event: Mara accepted the gift.', keys: ['Mara', 'gift'], content: 'Mara accepted the gift.' },
            { id: 'commitment:return', version: 1, title: 'Promise: Return the receipt.', keys: ['receipt'], content: 'Return the receipt.' },
        ];
        expect(mergeLoreEntries(data, entries, create)).toEqual({ added: 2, updated: 0, unchanged: 0, stale: 0 });
        expect(Object.keys(data.entries)).toHaveLength(3);
        expect(data.entries[1]).toMatchObject({ mewmoryRecordId: 'event:gift', comment: entries[0].title, key: ['Mara', 'gift'], content: entries[0].content });
        expect(data.entries[0]).toEqual({ uid: 0, comment: 'Hand written', key: ['door'], content: 'Keep me.' });

        expect(mergeLoreEntries(data, entries, create)).toEqual({ added: 0, updated: 0, unchanged: 2, stale: 0 });

        const changed = [{ ...entries[0], version: 2, content: 'Mara quietly accepted the gift.' }];
        expect(mergeLoreEntries(data, changed, create)).toEqual({ added: 0, updated: 1, unchanged: 0, stale: 1 });
        expect(Object.keys(data.entries)).toHaveLength(3);
        expect(data.entries[1]).toMatchObject({ content: 'Mara quietly accepted the gift.', mewmoryVersion: 2 });
    });

    test('a full lorebook reports a clear error', () => {
        const { data } = book();
        expect(() => mergeLoreEntries(data, [{ id: 'a', title: 'A', keys: [], content: 'A' }], () => undefined)).toThrow('could not take another entry');
    });
});
