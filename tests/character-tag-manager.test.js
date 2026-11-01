import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
    TAG_FILTER_MODES,
    TAG_SORT_MODES,
    ENTITY_FILTER_MODES,
    ENTITY_SORT_MODES,
    applyNotesImportPayload,
    applyTagDragOrder,
    buildTagManagerBackupPayload,
    bulkAssignTagsToEntities,
    bulkRemoveTagsFromEntities,
    createTagDeletionSnapshot,
    filterAndSortEntities,
    filterAndSortTagRecords,
    getEntityOrganizerNote,
    getTagNote,
    mergeTagsIntoPrimary,
    parseEntitySearchQuery,
    parseTagSearchQuery,
    pruneEntityOrganizerNotes,
    renameEntityOrganizerNoteKey,
    resolveTagKeyForEntity,
    restoreTagDeletionSnapshot,
    restoreTagsFromBackup,
    setEntityOrganizerNote,
    setTagNote,
} from '../public/scripts/neconyan-character-tag-manager.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(repoRoot, file), 'utf8').replace(/\r\n/g, '\n');

const tag = (id, name, extra = {}) => ({ id, name, ...extra });
const character = (avatar, name, extra = {}) => ({ avatar, name, ...extra });
const group = (id, name, extra = {}) => ({ id, name, ...extra });

describe('Character Tag Manager search parsing', () => {
    test('parses comma OR groups, quoted phrases and negated terms for tags', () => {
        const parsed = parseTagSearchQuery('slow, c:"Big Cat" -c:Alice');
        expect(parsed.groups).toHaveLength(2);
        expect(parsed.groups[0]).toEqual([
            expect.objectContaining({ value: 'slow', prefix: null, negated: false }),
        ]);
        expect(parsed.groups[1]).toEqual([
            expect.objectContaining({ value: 'Big Cat', prefix: 'c', negated: false }),
            expect.objectContaining({ value: 'Alice', prefix: 'c', negated: true }),
        ]);
    });

    test('parses entity prefixes, quoted values and negation', () => {
        const parsed = parseEntitySearchQuery('t:elf -t:dark, f:fold, a:"first message", n:tea');
        expect(parsed.groups).toHaveLength(4);
        expect(parsed.groups[0].map(term => [term.prefix, term.value, term.negated])).toEqual([
            ['t', 'elf', false],
            ['t', 'dark', true],
        ]);
        expect(parsed.groups[1][0]).toEqual(expect.objectContaining({ prefix: 'f', value: 'fold' }));
        expect(parsed.groups[2][0]).toEqual(expect.objectContaining({ prefix: 'a', value: 'first message' }));
        expect(parsed.groups[3][0]).toEqual(expect.objectContaining({ prefix: 'n', value: 'tea' }));
    });

    test('ignores empty terms and treats unknown prefixes as plain text', () => {
        expect(parseTagSearchQuery(' , -, c: ')).toEqual({ groups: [] });
        expect(parseTagSearchQuery('x:value').groups[0][0]).toEqual(expect.objectContaining({ prefix: null, value: 'x:value' }));
        expect(parseEntitySearchQuery('-').groups).toEqual([]);
    });
});

describe('Character Tag Manager entity key resolution', () => {
    const characters = Array.from({ length: 12 }, (_, index) => character(`char${index}.png`, `Char ${index}`));
    const groups = [group('7', 'Party'), group('20', 'Twentieth')];

    test('prefers numeric character indices over matching group ids', () => {
        expect(resolveTagKeyForEntity(7, { characters, groups })).toBe('char7.png');
        expect(resolveTagKeyForEntity(9, { characters, groups })).toBe('char9.png');
        expect(resolveTagKeyForEntity(10, { characters, groups })).toBe('char10.png');
        expect(resolveTagKeyForEntity(20, { characters, groups })).toBe('20');
        expect(resolveTagKeyForEntity(99, { characters, groups })).toBeUndefined();
    });

    test('honours explicit character and group wrappers over ambiguity', () => {
        expect(resolveTagKeyForEntity({ type: 'character', id: 7, item: characters[7] }, { characters, groups })).toBe('char7.png');
        expect(resolveTagKeyForEntity({ type: 'group', id: '7', item: groups[0] }, { characters, groups })).toBe('7');
        expect(resolveTagKeyForEntity(characters[7], { characters, groups })).toBe('char7.png');
        expect(resolveTagKeyForEntity(groups[0], { characters, groups })).toBe('7');
        expect(resolveTagKeyForEntity({ type: 'tag', id: '7' }, { characters, groups, tagMap: { '7': [] } })).toBe('7');
        expect(resolveTagKeyForEntity({ type: 'tag', id: '7' }, { characters, groups })).toBeUndefined();
    });

    test('resolves strings by avatar, group id, then string character index', () => {
        expect(resolveTagKeyForEntity('char7.png', { characters, groups })).toBe('char7.png');
        expect(resolveTagKeyForEntity('7', { characters, groups })).toBe('7');
        expect(resolveTagKeyForEntity('9', { characters, groups })).toBe('char9.png');
        expect(resolveTagKeyForEntity('9', { characters, groups: [] })).toBe('char9.png');
        expect(resolveTagKeyForEntity('legacy-key', { characters, groups, tagMap: { 'legacy-key': [] } })).toBe('legacy-key');
        expect(resolveTagKeyForEntity('missing', { characters, groups })).toBeUndefined();
    });

    test('keeps raw object fallbacks and unmatched ids predictable', () => {
        expect(resolveTagKeyForEntity({ id: '7' }, { characters, groups })).toBe('7');
        expect(resolveTagKeyForEntity({ id: 4 }, { characters, groups })).toBe('char4.png');
        expect(resolveTagKeyForEntity({ id: 'tag-id' }, { characters, groups, tagMap: { 'tag-id': [] } })).toBe('tag-id');
        expect(resolveTagKeyForEntity(null, { characters, groups })).toBeUndefined();
        expect(resolveTagKeyForEntity({}, { characters, groups })).toBeUndefined();
    });
});

describe('Character Tag Manager tag filtering and sorting', () => {
    const characters = [
        character('alice.png', 'Alice'),
        character('bob.png', 'Bob'),
    ];
    const groups = [group('7', 'Party')];
    const tags = [
        tag('a', 'Alpha', { sort_order: 1 }),
        tag('b', 'Beta', { sort_order: 0, folder_type: 'OPEN', note: 'Slow burn notes' }),
        tag('c', 'Gamma', { sort_order: 2, folder_type: 'CLOSED' }),
        tag('d', 'Delta', { sort_order: 3 }),
    ];
    const tagMap = {
        'alice.png': ['a', 'b'],
        'bob.png': ['a'],
        '7': ['c'],
    };

    test('counts valid characters and groups and matches c: by name', () => {
        const all = filterAndSortTagRecords(tags, tagMap, characters, groups, { sortMode: TAG_SORT_MODES.ALPHABETICAL });
        expect(all.map(record => [record.tag.name, record.count])).toEqual([
            ['Alpha', 2],
            ['Beta', 1],
            ['Delta', 0],
            ['Gamma', 1],
        ]);

        const usingAlice = filterAndSortTagRecords(tags, tagMap, characters, groups, { query: 'c:alice', sortMode: TAG_SORT_MODES.ALPHABETICAL });
        expect(usingAlice.map(record => record.tag.id)).toEqual(['a', 'b']);

        const notAlice = filterAndSortTagRecords(tags, tagMap, characters, groups, { query: '-c:alice' });
        expect(notAlice.map(record => record.tag.id).sort()).toEqual(['c', 'd']);

        const party = filterAndSortTagRecords(tags, tagMap, characters, groups, { query: 'c:party' });
        expect(party.map(record => record.tag.id)).toEqual(['c']);
    });

    test('matches names and notes, supports OR groups and folder filters', () => {
        expect(filterAndSortTagRecords(tags, tagMap, characters, groups, { query: 'slow' }).map(record => record.tag.id)).toEqual(['b']);
        expect(filterAndSortTagRecords(tags, tagMap, characters, groups, { query: 'gamma, delta' }).map(record => record.tag.id).sort()).toEqual(['c', 'd']);
        expect(filterAndSortTagRecords(tags, tagMap, characters, groups, { filter: TAG_FILTER_MODES.FOLDERS }).map(record => record.tag.id).sort()).toEqual(['b', 'c']);
        expect(filterAndSortTagRecords(tags, tagMap, characters, groups, { filter: TAG_FILTER_MODES.OPEN_FOLDER }).map(record => record.tag.id)).toEqual(['b']);
        expect(filterAndSortTagRecords(tags, tagMap, characters, groups, { filter: TAG_FILTER_MODES.CLOSED_FOLDER }).map(record => record.tag.id)).toEqual(['c']);
        expect(filterAndSortTagRecords(tags, tagMap, characters, groups, { filter: TAG_FILTER_MODES.NO_FOLDER }).map(record => record.tag.id).sort()).toEqual(['a', 'd']);
        expect(filterAndSortTagRecords(tags, tagMap, characters, groups, { filter: TAG_FILTER_MODES.UNUSED }).map(record => record.tag.id)).toEqual(['d']);
        expect(filterAndSortTagRecords(tags, tagMap, characters, groups, { filter: TAG_FILTER_MODES.WITH_NOTES }).map(record => record.tag.id)).toEqual(['b']);
    });

    test('sorts alphabetically, by use count and by manual order with a fallback', () => {
        const alpha = filterAndSortTagRecords(tags, tagMap, characters, groups, { sortMode: TAG_SORT_MODES.ALPHABETICAL });
        expect(alpha.map(record => record.tag.name)).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma']);

        const alphaDesc = filterAndSortTagRecords(tags, tagMap, characters, groups, { sortMode: TAG_SORT_MODES.ALPHABETICAL_DESC });
        expect(alphaDesc.map(record => record.tag.name)).toEqual(['Gamma', 'Delta', 'Beta', 'Alpha']);

        const byEntries = filterAndSortTagRecords(tags, tagMap, characters, groups, { sortMode: TAG_SORT_MODES.BY_ENTRIES });
        expect(byEntries.map(record => record.tag.name)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);

        const byEntriesAsc = filterAndSortTagRecords(tags, tagMap, characters, groups, { sortMode: TAG_SORT_MODES.BY_ENTRIES_ASC });
        expect(byEntriesAsc.map(record => record.tag.name)).toEqual(['Delta', 'Beta', 'Gamma', 'Alpha']);

        const manual = filterAndSortTagRecords(tags, tagMap, characters, groups, { sortMode: TAG_SORT_MODES.MANUAL });
        expect(manual.map(record => record.tag.name)).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']);

        const fallback = filterAndSortTagRecords([tag('x', 'A'), tag('y', 'B')], {}, [], [], {
            sortMode: TAG_SORT_MODES.MANUAL,
            compareFallback: (a, b) => b.name.localeCompare(a.name),
        });
        expect(fallback.map(record => record.tag.name)).toEqual(['B', 'A']);
    });
});

describe('Character Tag Manager entity filtering and sorting', () => {
    const tags = [
        tag('elf', 'Elf', { folder_type: 'OPEN' }),
        tag('dark', 'Dark', { folder_type: 'NONE' }),
        tag('magic', 'Magic'),
    ];
    const tagMap = {
        'alice.png': ['elf', 'magic'],
        'bob.png': ['dark'],
        '7': ['elf'],
    };
    const notes = { 'alice.png': 'Likes tea and quiet mornings' };
    const entities = [
        { type: 'character', key: 'alice.png', name: 'Alice', fav: true, allText: 'Loves tea Calm A garden Hello there Old card' },
        { type: 'character', key: 'bob.png', name: 'Bob', fav: false, allText: 'Grumpy blacksmith' },
        { type: 'character', key: 'carol.png', name: 'Carol', fav: false, allText: '' },
        { type: 'group', key: '7', name: 'The Party', fav: false, allText: 'A travelling band' },
    ];

    test('matches tag, folder, all-text and note prefixes with negation', () => {
        const byTag = filterAndSortEntities(entities, tags, tagMap, notes, { query: 't:elf' });
        expect(byTag.map(entity => entity.key).sort()).toEqual(['7', 'alice.png']);

        const notTag = filterAndSortEntities(entities, tags, tagMap, notes, { query: '-t:elf' });
        expect(notTag.map(entity => entity.key).sort()).toEqual(['bob.png', 'carol.png']);

        const byFolder = filterAndSortEntities(entities, tags, tagMap, notes, { query: 'f:el' });
        expect(byFolder.map(entity => entity.key).sort()).toEqual(['7', 'alice.png']);

        const byText = filterAndSortEntities(entities, tags, tagMap, notes, { query: 'a:blacksmith' });
        expect(byText.map(entity => entity.key)).toEqual(['bob.png']);

        const byNote = filterAndSortEntities(entities, tags, tagMap, notes, { query: 'n:quiet' });
        expect(byNote.map(entity => entity.key)).toEqual(['alice.png']);

        const byPhrase = filterAndSortEntities(entities, tags, tagMap, notes, { query: 'a:"travelling band"' });
        expect(byPhrase.map(entity => entity.key)).toEqual(['7']);

        const orQuery = filterAndSortEntities(entities, tags, tagMap, notes, { query: 'a:garden, a:blacksmith' });
        expect(orQuery.map(entity => entity.key).sort()).toEqual(['alice.png', 'bob.png']);
    });

    test('filters by type, tag state, folder state, notes and favourites', () => {
        expect(filterAndSortEntities(entities, tags, tagMap, notes, { filter: ENTITY_FILTER_MODES.CHARACTERS }).map(entity => entity.key)).toHaveLength(3);
        expect(filterAndSortEntities(entities, tags, tagMap, notes, { filter: ENTITY_FILTER_MODES.GROUPS }).map(entity => entity.key)).toEqual(['7']);
        expect(filterAndSortEntities(entities, tags, tagMap, notes, { filter: ENTITY_FILTER_MODES.UNTAGGED }).map(entity => entity.key)).toEqual(['carol.png']);
        expect(filterAndSortEntities(entities, tags, tagMap, notes, { filter: ENTITY_FILTER_MODES.TAGGED }).map(entity => entity.key).sort()).toEqual(['7', 'alice.png', 'bob.png']);
        expect(filterAndSortEntities(entities, tags, tagMap, notes, { filter: ENTITY_FILTER_MODES.IN_FOLDER }).map(entity => entity.key).sort()).toEqual(['7', 'alice.png']);
        expect(filterAndSortEntities(entities, tags, tagMap, notes, { filter: ENTITY_FILTER_MODES.NO_FOLDER }).map(entity => entity.key).sort()).toEqual(['bob.png', 'carol.png']);
        expect(filterAndSortEntities(entities, tags, tagMap, notes, { filter: ENTITY_FILTER_MODES.WITH_NOTES }).map(entity => entity.key)).toEqual(['alice.png']);
        expect(filterAndSortEntities(entities, tags, tagMap, notes, { filter: ENTITY_FILTER_MODES.WITHOUT_NOTES }).map(entity => entity.key).sort()).toEqual(['7', 'bob.png', 'carol.png']);
        expect(filterAndSortEntities(entities, tags, tagMap, notes, { filter: ENTITY_FILTER_MODES.FAVORITES }).map(entity => entity.key)).toEqual(['alice.png']);
    });

    test('sorts by name and tag count', () => {
        const byName = filterAndSortEntities(entities, tags, tagMap, notes, { sortMode: ENTITY_SORT_MODES.ALPHA_ASC });
        expect(byName.map(entity => entity.name)).toEqual(['Alice', 'Bob', 'Carol', 'The Party']);

        const byNameDesc = filterAndSortEntities(entities, tags, tagMap, notes, { sortMode: ENTITY_SORT_MODES.ALPHA_DESC });
        expect(byNameDesc.map(entity => entity.name)).toEqual(['The Party', 'Carol', 'Bob', 'Alice']);

        const mostTags = filterAndSortEntities(entities, tags, tagMap, notes, { sortMode: ENTITY_SORT_MODES.TAG_COUNT_DESC });
        expect(mostTags[0].key).toBe('alice.png');

        const fewestTags = filterAndSortEntities(entities, tags, tagMap, notes, { sortMode: ENTITY_SORT_MODES.TAG_COUNT_ASC });
        expect(fewestTags[0].key).toBe('carol.png');
    });

    test('does not append card fields twice when allText is already built', () => {
        const supplied = [{ type: 'character', key: 'x.png', name: 'X', allText: 'Known text only', description: 'Hidden description' }];
        expect(filterAndSortEntities(supplied, [], {}, {}, { query: 'a:hidden' })).toHaveLength(0);
        expect(filterAndSortEntities(supplied, [], {}, {}, { query: 'a:known' })).toHaveLength(1);
    });
});

describe('Character Tag Manager notes and mutations', () => {
    test('keeps tag notes lazy and removes empty values', () => {
        const item = tag('a', 'Alpha');
        expect(getTagNote(item)).toBe('');
        expect(setTagNote(item, '  note  ')).toBe(true);
        expect(item.note).toBe('note');
        expect(setTagNote(item, 'note')).toBe(false);
        expect(setTagNote(item, '')).toBe(true);
        expect(Object.hasOwn(item, 'note')).toBe(false);
    });

    test('keeps organiser notes in one lazy power-user bucket', () => {
        const powerUser = {};
        expect(getEntityOrganizerNote(powerUser, 'alice.png')).toBe('');
        expect(setEntityOrganizerNote(powerUser, 'alice.png', 'tea')).toBe(true);
        expect(powerUser.character_tag_notes).toEqual({ 'alice.png': 'tea' });
        expect(setEntityOrganizerNote(powerUser, 'alice.png', 'tea')).toBe(false);
        expect(setEntityOrganizerNote(powerUser, 'alice.png', '')).toBe(true);
        expect(Object.hasOwn(powerUser, 'character_tag_notes')).toBe(false);
    });

    test('renames and prunes organiser notes without creating empty buckets', () => {
        const powerUser = { character_tag_notes: { 'alice.png': 'tea', '7': 'party' } };
        expect(renameEntityOrganizerNoteKey(powerUser, 'alice.png', 'alice-new.png')).toBe(true);
        expect(powerUser.character_tag_notes).toEqual({ 'alice-new.png': 'tea', '7': 'party' });
        expect(renameEntityOrganizerNoteKey(powerUser, 'missing', 'other')).toBe(false);
        expect(pruneEntityOrganizerNotes(powerUser, ['alice-new.png'])).toBe(1);
        expect(powerUser.character_tag_notes).toEqual({ 'alice-new.png': 'tea' });
        expect(pruneEntityOrganizerNotes({}, ['alice-new.png'])).toBe(0);
    });

    test('bulk assigns and removes tags without duplicates', () => {
        const tagMap = { 'alice.png': ['a'] };
        expect(bulkAssignTagsToEntities({ tagMap, tagIds: ['a', 'b'], entityKeys: ['alice.png', 'bob.png'] })).toEqual({ entityCount: 2, assignmentCount: 3 });
        expect(tagMap).toEqual({ 'alice.png': ['a', 'b'], 'bob.png': ['a', 'b'] });
        expect(bulkAssignTagsToEntities({ tagMap, tagIds: ['a', 'b'], entityKeys: ['alice.png'] })).toEqual({ entityCount: 0, assignmentCount: 0 });
        expect(bulkRemoveTagsFromEntities({ tagMap, tagIds: ['b'], entityKeys: ['alice.png', 'bob.png'] })).toEqual({ entityCount: 2, assignmentCount: 2 });
        expect(tagMap).toEqual({ 'alice.png': ['a'], 'bob.png': ['a'] });
        expect(bulkRemoveTagsFromEntities({ tagMap, tagIds: ['a'], entityKeys: ['alice.png', 'bob.png'] })).toEqual({ entityCount: 2, assignmentCount: 2 });
        expect(tagMap).toEqual({ 'alice.png': [], 'bob.png': [] });
    });

    test('applies a filtered drag to the visible slots without moving hidden tags', () => {
        const tags = [tag('a', 'Alpha'), tag('b', 'Beta'), tag('c', 'Gamma'), tag('d', 'Delta')];
        const ordered = tags.slice();

        applyTagDragOrder({ tags, orderedTags: ordered, visibleTagIds: ['d', 'c'] });
        expect(ordered.map(item => item.id)).toEqual(['a', 'b', 'd', 'c']);
        expect(tags.map(item => [item.id, item.sort_order])).toEqual([
            ['a', 0],
            ['b', 1],
            ['c', 3],
            ['d', 2],
        ]);
    });

    test('normalises missing sort orders when a drag reorders the full list', () => {
        const tags = [tag('a', 'Alpha'), tag('b', 'Beta'), tag('c', 'Gamma')];
        const ordered = tags.slice();

        applyTagDragOrder({ tags, orderedTags: ordered, visibleTagIds: ['b', 'c', 'a'] });
        expect(ordered.map(item => item.id)).toEqual(['b', 'c', 'a']);
        expect(tags.every(item => Number.isInteger(item.sort_order))).toBe(true);
        expect(tags.map(item => item.sort_order)).toEqual([2, 0, 1]);
    });

    test('restores tags without creating duplicate ids when a tag was renamed', () => {
        const tags = [tag('t1', 'Old Name')];
        const tagMap = { 'alice.png': ['t1'], 'bob.png': ['t1'] };
        const data = {
            tags: [
                { id: 't1', name: 'New Name', note: '  ' },
                { id: 't2', name: 'Second', note: 'Keep me' },
            ],
            tag_map: { 'alice.png': ['t1', 't2'] },
        };

        const result = restoreTagsFromBackup({
            data,
            tags,
            tagMap,
            characters: [character('alice.png', 'Alice'), character('bob.png', 'Bob')],
            groups: [],
            overwrite: true,
        });

        expect(result.warnings).toEqual([]);
        expect(tags.filter(item => item.id === 't1')).toHaveLength(1);
        expect(tags.map(item => [item.id, item.name, item.note])).toEqual([
            ['t1', 'New Name', undefined],
            ['t2', 'Second', 'Keep me'],
        ]);
        expect(tagMap).toEqual({ 'alice.png': ['t1', 't2'], 'bob.png': ['t1'] });
    });

    test('remaps every live assignment when overwrite replaces a tag by name', () => {
        const tags = [tag('old-id', 'Shared name')];
        const tagMap = { 'alice.png': ['old-id'], 'bob.png': ['old-id'], 'unmentioned.png': ['old-id'] };
        const data = {
            tags: [{ id: 'new-id', name: 'Shared name' }],
            tag_map: { 'alice.png': ['new-id'] },
        };

        const result = restoreTagsFromBackup({
            data,
            tags,
            tagMap,
            characters: [
                character('alice.png', 'Alice'),
                character('bob.png', 'Bob'),
                character('unmentioned.png', 'Unmentioned'),
            ],
            groups: [],
            overwrite: true,
        });

        expect(result.replacedTags).toBe(1);
        expect(tags.map(item => item.id)).toEqual(['new-id']);
        expect(tagMap).toEqual({
            'alice.png': ['new-id'],
            'bob.png': ['new-id'],
            'unmentioned.png': ['new-id'],
        });
    });

    test('skips null and primitive backup entries without throwing', () => {
        const tags = [];
        const tagMap = {};
        const data = {
            tags: [null, 42, 'bad', { id: 'good', name: 'Valid', note: 42 }],
            tag_map: { 'alice.png': ['missing-tag', 'good'] },
        };

        const result = restoreTagsFromBackup({
            data,
            tags,
            tagMap,
            characters: [character('alice.png', 'Alice')],
            groups: [],
        });

        expect(result.warnings).toHaveLength(3);
        expect(result.importedTags).toBe(1);
        expect(tags).toEqual([{ id: 'good', name: 'Valid' }]);
        expect(tagMap['alice.png']).toEqual(['good']);
    });

    test('copies a missing note onto an existing tag when overwrite is off', () => {
        const tags = [tag('t1', 'Existing')];
        const tagMap = { 'alice.png': ['t1'] };
        const data = { tags: [{ id: 't1', name: 'Existing', note: 'Copied note' }], tag_map: {} };

        const result = restoreTagsFromBackup({
            data, tags, tagMap, characters: [character('alice.png', 'Alice')], groups: [], overwrite: false,
        });

        expect(result.importedTags).toBe(0);
        expect(tags[0].note).toBe('Copied note');
    });

    test('warns for unknown entities and filters dangling ids from the imported map', () => {
        const tags = [tag('a', 'Alpha')];
        const tagMap = {};
        const data = { tags: [], tag_map: { 'missing.png': ['a'], 'alice.png': ['a', 'gone'] } };

        const result = restoreTagsFromBackup({
            data, tags, tagMap, characters: [character('alice.png', 'Alice')], groups: [], overwrite: false,
        });

        expect(result.warnings).toHaveLength(1);
        expect(tagMap).toEqual({ 'alice.png': ['a'] });
    });

    test('merges tags, keeps notes and assignments, and undoes cleanly', () => {
        const tags = [
            tag('a', 'Alpha', { sort_order: 1, note: 'Primary note' }),
            tag('b', 'Beta', { sort_order: 2, note: 'Second note' }),
            tag('c', 'Gamma', { sort_order: 3, note: 'Primary note' }),
        ];
        const tagMap = {
            'alice.png': ['a', 'b'],
            'bob.png': ['b'],
            'carol.png': ['c'],
        };

        const result = mergeTagsIntoPrimary({ tags, tagMap, primaryTagId: 'a', sourceTagIds: ['b', 'c', 'missing'] });
        expect(result.mergedCount).toBe(2);
        expect(result.affectedEntities).toBe(3);
        expect(result.snapshot).not.toBeNull();
        expect(result.snapshot.operation).toBe('merge');
        expect(result.snapshot.primaryTagId).toBe('a');
        expect(tags.map(item => item.id)).toEqual(['a']);
        expect(tagMap).toEqual({ 'alice.png': ['a'], 'bob.png': ['a'], 'carol.png': ['a'] });
        expect(tags[0].note).toBe('Primary note\nSecond note');

        // Later edits to the primary tag must survive undo; its pre-merge note must return.
        Object.assign(tags[0], { name: 'Renamed Alpha', color: 'plum', folder_type: 'CLOSED', note: 'Post-merge note' });

        const restored = restoreTagDeletionSnapshot({ tags, tagMap, snapshot: result.snapshot });
        expect(restored.restoredTags).toBe(2);
        expect(tags.map(item => item.id).sort()).toEqual(['a', 'b', 'c']);

        const primary = tags.find(item => item.id === 'a');
        expect(primary.name).toBe('Renamed Alpha');
        expect(primary.color).toBe('plum');
        expect(primary.folder_type).toBe('CLOSED');
        expect(primary.note).toBe('Primary note');
        expect(tagMap).toEqual({ 'alice.png': ['a', 'b'], 'bob.png': ['b'], 'carol.png': ['c'] });
    });

    test('keeps unrelated removals removed when undoing a deletion', () => {
        const tags = [tag('a', 'Alpha'), tag('b', 'Beta')];
        const tagMap = { 'alice.png': ['a', 'b'] };
        const snapshot = createTagDeletionSnapshot({ tags, tagMap, tagIds: ['a'] });

        tags.splice(tags.findIndex(item => item.id === 'a'), 1);
        tagMap['alice.png'] = ['b'];

        // Unrelated edit after the deletion: remove Beta from Alice.
        tagMap['alice.png'] = [];

        const restored = restoreTagDeletionSnapshot({ tags, tagMap, snapshot });
        expect(restored.restoredTags).toBe(1);
        expect(tagMap['alice.png']).toEqual(['a']);
    });

    test('keeps unrelated removals removed when undoing a merge', () => {
        const tags = [tag('a', 'Alpha'), tag('b', 'Beta')];
        const tagMap = { 'alice.png': ['a', 'b'] };
        const result = mergeTagsIntoPrimary({ tags, tagMap, primaryTagId: 'a', sourceTagIds: ['b'] });
        expect(tagMap['alice.png']).toEqual(['a']);

        // Unrelated edit after the merge: remove the primary from Alice.
        tagMap['alice.png'] = [];

        restoreTagDeletionSnapshot({ tags, tagMap, snapshot: result.snapshot });
        expect(tagMap['alice.png']).toEqual(['b']);
    });

    test('restores deleted tags without clobbering unrelated assignments added since', () => {
        const tags = [tag('a', 'Alpha'), tag('b', 'Beta')];
        const tagMap = { 'alice.png': ['a', 'b'] };
        const snapshot = createTagDeletionSnapshot({ tags, tagMap, tagIds: ['a'] });

        tags.splice(tags.findIndex(item => item.id === 'a'), 1);
        tagMap['alice.png'] = tagMap['alice.png'].filter(id => id !== 'a');
        tagMap['alice.png'].push('new');

        const restored = restoreTagDeletionSnapshot({ tags, tagMap, snapshot });
        expect(restored.restoredTags).toBe(1);
        expect(tags.map(item => item.id).sort()).toEqual(['a', 'b']);
        expect(tagMap['alice.png']).toEqual(['b', 'new', 'a']);
    });

    test('restores pruned orphan references and notes', () => {
        const tags = [tag('a', 'Alpha')];
        const tagMap = { 'alice.png': ['a'], 'gone.png': ['a'] };
        const powerUser = { character_tag_notes: { 'gone.png': 'old note' } };
        const snapshot = createTagDeletionSnapshot({ tags, tagMap, tagIds: [] });
        snapshot.orphanTagMapEntries['gone.png'] = ['a'];
        snapshot.characterTagNotes['gone.png'] = 'old note';

        delete tagMap['gone.png'];
        delete powerUser.character_tag_notes['gone.png'];

        const restored = restoreTagDeletionSnapshot({ tags, tagMap, snapshot, powerUser });
        expect(tagMap['gone.png']).toEqual(['a']);
        expect(powerUser.character_tag_notes).toEqual({ 'gone.png': 'old note' });
        expect(restored.restoredNotes).toBe(1);
    });

    test('builds a deep backup and applies Character Tag Manager notes exports', () => {
        const tags = [tag('a', 'Alpha', { note: 'Tag note' })];
        const tagMap = { 'alice.png': ['a'] };
        const powerUser = { character_tag_notes: { 'alice.png': 'Alice note' } };
        const backup = buildTagManagerBackupPayload({ tags, tagMap, powerUser });

        backup.tags[0].name = 'Changed';
        expect(tags[0].name).toBe('Alpha');
        expect(backup.character_tag_notes).toEqual({ 'alice.png': 'Alice note' });

        const importedTags = [tag('a', 'Alpha'), tag('b', 'Beta')];
        const characters = [character('alice.png', 'Alice'), character('bob.png', 'Bob')];
        const groups = [group('7', 'The Party')];
        const importedPowerUser = {};
        const result = applyNotesImportPayload({
            payload: {
                tagNotes: { a: 'Imported tag note', Beta: 'Second tag note', missing: 'Nope' },
                charNotes: { 'alice.png': 'Imported Alice', 'bob': 'Matched by basename', 'The Party': 'Group note', unknown: 'Nope' },
            },
            tags: importedTags,
            characters,
            groups,
            powerUser: importedPowerUser,
            overwrite: false,
        });

        expect(result.importedTagNotes).toBe(2);
        expect(result.importedEntityNotes).toBe(3);
        expect(result.skipped).toHaveLength(2);
        expect(importedTags[0].note).toBe('Imported tag note');
        expect(importedTags[1].note).toBe('Second tag note');
        expect(getEntityOrganizerNote(importedPowerUser, 'alice.png')).toBe('Imported Alice');
        expect(getEntityOrganizerNote(importedPowerUser, 'bob.png')).toBe('Matched by basename');
        expect(getEntityOrganizerNote(importedPowerUser, '7')).toBe('Group note');
    });

    test('matches note identities with dots and exact group ids first', () => {
        const dotted = {};
        applyNotesImportPayload({
            payload: { charNotes: { 'Dr. Smith': 'A dotted character name' } },
            tags: [],
            characters: [character('dr.png', 'Dr. Smith')],
            groups: [],
            powerUser: dotted,
            overwrite: false,
        });
        expect(getEntityOrganizerNote(dotted, 'dr.png')).toBe('A dotted character name');

        const grouped = {};
        applyNotesImportPayload({
            payload: { charNotes: { '7': 'A group key' } },
            tags: [],
            characters: [character('dr.png', 'Dr. Smith')],
            groups: [group('7', 'The Party')],
            powerUser: grouped,
            overwrite: false,
        });
        expect(getEntityOrganizerNote(grouped, '7')).toBe('A group key');

        const exact = {};
        const result = applyNotesImportPayload({
            payload: { charNotes: { 'Dr. Smith': 'Matched by name', 'dr.png': 'Matched by avatar' } },
            tags: [],
            characters: [character('dr.png', 'Dr. Smith')],
            groups: [],
            powerUser: exact,
            overwrite: true,
        });
        expect(result.importedEntityNotes).toBe(2);
        expect(getEntityOrganizerNote(exact, 'dr.png')).toBe('Matched by avatar');
    });

    test('imports the manager backup note map by exact entity key', () => {
        const powerUser = {};
        const result = applyNotesImportPayload({
            payload: {
                character_tag_notes: {
                    'alice.png': 'From the manager backup',
                    'missing.png': 'No such entity',
                },
            },
            tags: [tag('a', 'Alpha')],
            characters: [character('alice.png', 'Alice')],
            groups: [],
            powerUser,
            overwrite: false,
        });

        expect(result.importedEntityNotes).toBe(1);
        expect(result.skipped).toHaveLength(1);
        expect(getEntityOrganizerNote(powerUser, 'alice.png')).toBe('From the manager backup');
    });

    test('respects the overwrite choice when importing notes', () => {
        const tags = [tag('a', 'Alpha', { note: 'Old tag note' })];
        const powerUser = { character_tag_notes: { 'alice.png': 'Old character note' } };
        const payload = {
            tagNotes: { a: 'New tag note' },
            charNotes: { 'alice.png': 'New character note' },
        };

        applyNotesImportPayload({ payload, tags, characters: [character('alice.png', 'Alice')], groups: [], powerUser, overwrite: false });
        expect(tags[0].note).toBe('Old tag note');
        expect(powerUser.character_tag_notes['alice.png']).toBe('Old character note');

        applyNotesImportPayload({ payload, tags, characters: [character('alice.png', 'Alice')], groups: [], powerUser, overwrite: true });
        expect(tags[0].note).toBe('New tag note');
        expect(powerUser.character_tag_notes['alice.png']).toBe('New character note');
    });
});

describe('Character Tag Manager template, wiring and styling contracts', () => {
    const template = read('public/scripts/templates/tagManagement.html');
    const indexHtml = read('public/index.html');
    const tagsJs = read('public/scripts/tags.js');
    const tagsCss = read('public/css/neconyan-character-tags.css');
    const swJs = read('public/sw.js');
    const tabsJs = read('public/scripts/neconyan-tabs.js');
    const cacheVersion = swJs.match(/NN_SW_CACHE_VERSION = 'neconyan-cache-v([^']+)'/)[1];

    test('ships both panels and keeps every legacy tag manager selector', () => {
        for (const selector of [
            'data-tag-manager-tab="tags"',
            'data-tag-manager-tab="entities"',
            'data-tag-manager-panel="tags"',
            'data-tag-manager-panel="entities"',
            'id="tag_view_create_input"',
            'id="tag_view_create_folder"',
            'id="tag_view_search"',
            'id="tag_view_filter_select"',
            'id="tag_sort_mode_select"',
            'id="tag_view_bogus_folders_toggle"',
            'class="tag_view_list_tags ui-sortable"',
            'class="menu_button menu_button_icon tag_view_prune"',
            'class="menu_button menu_button_icon tag_view_backup"',
            'class="menu_button menu_button_icon tag_view_restore"',
            'id="tag_view_restore_input"',
            'class="menu_button menu_button_icon menu_button_primary tag_view_create"',
            'id="tag_merge_primary"',
            'id="tag_bulk_delete_confirm"',
            'class="menu_button menu_button_primary tag_view_undo"',
            'id="neconyan_tag_char_search"',
            'id="neconyan_tag_char_filter"',
            'id="neconyan_tag_char_sort"',
            'id="neconyan_tag_maintenance" class="neconyan-tag-maintenance"',
            'id="neconyan_tag_bulk_panel" class="neconyan-tag-bulk-panel"',
            'class="neconyan-tag-disclosure-summary"',
            'class="neconyan-tag-assign-box neconyan-tag-assign-bar"',
            'id="neconyan_bulk_assign_tags_btn"',
            'id="neconyan_bulk_remove_tags_btn"',
        ]) {
            expect(template).toContain(selector);
        }
    });

    test('keeps search and lists ahead of secondary maintenance chrome', () => {
        expect(template.indexOf('class="neconyan-tag-toolbar"')).toBeLessThan(template.indexOf('id="neconyan_tag_maintenance"'));
        expect(template.indexOf('id="neconyan_tag_maintenance"')).toBeLessThan(template.indexOf('class="tag_view_list_tags ui-sortable"'));
        expect(template.indexOf('class="neconyan-tag-entity-toolbar"')).toBeLessThan(template.indexOf('id="neconyan_tag_bulk_panel"'));
        expect(template.indexOf('id="neconyan_tag_bulk_panel"')).toBeLessThan(template.indexOf('class="neconyan-tag-entity-list"'));
        expect(template).toContain('<details id="neconyan_tag_maintenance"');
        expect(template).toContain('<details id="neconyan_tag_bulk_panel"');
    });

    test('keeps the legacy tag row classes inside the new structured card', () => {
        const start = indexHtml.indexOf('<div id="tag_view_template"');
        const end = indexHtml.indexOf('<div id="entry_edit_template"', start);
        const rowTemplate = indexHtml.slice(start, end);

        for (const selector of [
            'neconyan-tag-item-main',
            'neconyan-tag-item-controls',
            'neconyan-tag-assigned-drawer',
            'neconyan-tag-note-drawer',
            'drag-handle',
            'tag_as_folder',
            'tag_folder_indicator',
            'eye-toggle',
            'tag_view_color_picker',
            'tag_view_name',
            'tag_view_counter',
            'tag_view_counter_value',
            'tag_delete',
            'neconyan-tag-folder-select',
            'aria-label="Tag note"',
        ]) {
            expect(rowTemplate).toContain(selector);
        }
    });

    test('wires the native helpers into tags.js', () => {
        for (const call of [
            'filterAndSortTagRecords',
            'filterAndSortEntities',
            'mergeTagsIntoPrimary',
            'createTagDeletionSnapshot',
            'restoreTagDeletionSnapshot',
            'bulkAssignTagsToEntities',
            'bulkRemoveTagsFromEntities',
            'setEntityOrganizerNote',
            'setTagNote',
            'buildTagManagerBackupPayload',
            'applyNotesImportPayload',
            'pruneEntityOrganizerNotes',
            'renameEntityOrganizerNoteKey',
        ]) {
            expect(tagsJs).toContain(call);
        }
        expect(tagsJs).toMatch(/function renameTagKey\(oldKey, newKey\)[\s\S]*?renameEntityOrganizerNoteKey/);
        expect(tagsJs).toMatch(/async function onTagsPruneClick\(\)[\s\S]*?pruneEntityOrganizerNotes/);
    });

    test('escapes confirmation bodies and styles the confirmation dialog', () => {
        expect(tagsJs).toMatch(/function buildTagManagerConfirmBody\(message\)[\s\S]*?\.text\(message\)/);
        expect(tagsJs).toMatch(/buildTagManagerConfirmBody\(t`Merge/);
        expect(tagsJs).toMatch(/buildTagManagerConfirmBody\(t`Delete/);
        expect(tagsCss).toMatch(/dialog\.popup:has\(#neconyan_tag_manager_confirm\)/);
    });

    test('imports tag notes, character notes and the manager note map together', () => {
        expect(tagsJs).toMatch(/character_tag_notes: data\.character_tag_notes,[\s\S]*?tagNotes: data\.tagNotes,[\s\S]*?charNotes: data\.charNotes,/);
        expect(tagsJs).toMatch(/function restoreTagManagerBackup[\s\S]*?restoreTagsFromBackup/);
    });

    test('routes manager entity mutations through the bulk helpers', () => {
        expect(tagsJs).toMatch(/function assignTagToManagerEntity\(tagId, entityKey\)[\s\S]*?bulkAssignTagsToEntities/);
        expect(tagsJs).toMatch(/function removeTagFromManagerEntity\(tagId, entityKey\)[\s\S]*?bulkRemoveTagsFromEntities/);
        expect(tagsJs).toMatch(/resolveTagKeyForEntity\(entityOrKey, \{ characters, groups, tagMap: tag_map \}\)/);
        expect(tagsJs).toMatch(/Number\.isNaN\(numericChid\) \? String\(chid\) : numericChid/);
        expect(tagsJs).toMatch(/const targetGroupId = groupId !== null[\s\S]*?String\(selected_group\)/);
        expect(tagsJs).toContain('.tag:not(.actionable)');
        expect(tagsJs).toMatch(/applyTagDragOrder\(\{ tags, orderedTags: ordered, visibleTagIds: visibleIds \}\)/);
        expect(tagsJs.indexOf('applyTagDragOrder')).toBeLessThan(tagsJs.indexOf('power_user.tag_sort_mode = tag_sort_mode.MANUAL'));
    });

    test('writes note state synchronously and reports only existing entity notes', () => {
        expect(tagsJs).toMatch(/noteInput\.on\('input', \(\) => \{[\s\S]*?setTagNote\(tag, value\)/);
        expect(tagsJs).toMatch(/const saveNote = \(\) => \{[\s\S]*?setEntityOrganizerNote\(power_user, record\.key, note\)/);
        expect(tagsJs).not.toMatch(/const saveNote = debounce\(\(\) => \{\s*const note = noteInput/);
        expect(tagsJs).toMatch(/const entityKeys = new Set\(\[[\s\S]*?character_tag_notes \?\? \{\}\)[\s\S]*?\.filter\(key => entityKeys\.has\(key\)\)/);
    });

    test('keeps entity rows lazy and skips hidden tag-panel rebuilds', () => {
        expect(tagsJs).toMatch(/const populate = \(\) => \{[\s\S]*?new Option\(tag\.name, String\(tag\.id\)\)/);
        expect(tagsJs).toMatch(/function printViewTagList\([\s\S]*?tagManagerState\.activeTab !== 'tags'/);
        expect(tagsJs).toMatch(/function refreshTagManagerEntityRow\(/);
        expect(tagsJs).toMatch(/function refreshTagManagerEntityRow\([\s\S]*?\['tag_count_desc', 'tag_count_asc'\][\s\S]*?renderEntityPanel\(\)/);
        expect(tagsJs).toMatch(/container\.find\('\.neconyan-tag-entity-row'\)\.length === 0[\s\S]*?renderEntityPanel\(\)/);
        expect(tagsJs).toMatch(/addSelect\[0\]\.selectedIndex = 0/);
    });

    test('keeps bulk controls in accessible disclosures with stable selectors', () => {
        expect(template).toMatch(/<details id="neconyan_tag_maintenance" class="neconyan-tag-maintenance">[\s\S]*?<summary class="neconyan-tag-disclosure-summary"/);
        expect(template).toMatch(/<details id="neconyan_tag_bulk_panel" class="neconyan-tag-bulk-panel">[\s\S]*?<summary class="neconyan-tag-disclosure-summary"/);
        expect(tagsCss).toMatch(/#tag_view_list \.neconyan-tag-disclosure-summary \{[\s\S]*?min-height: 44px/);
        expect(tagsCss).toMatch(/#tag_view_list \.menu_button_danger/);
        expect(tagsCss).toMatch(/#tag_view_list \.neconyan-tag-entity-note-toggle\.is-active[\s\S]*?background: color-mix/);
    });

    test('keeps the dialog opaque, accent-aware and within the CSS constraints', () => {
        expect(tagsCss).toMatch(/:root body\.neconyan dialog\.popup:has\(#tag_view_list\)/);
        expect(tagsCss).toMatch(/background: var\(--neco-surface\)/);
        expect(tagsCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(tagsCss).not.toMatch(/!important/);
        expect(tagsCss).not.toMatch(/\btransition\b|\banimation\b/);
        expect(tagsCss).not.toMatch(/^\s*\/\//m);
        expect(tagsCss).toMatch(/min-height: 44px/);
        expect(tagsCss).toMatch(/@media \(max-width: 768px\)/);
    });

    test('bumps every stylesheet cache version together', () => {
        expect(cacheVersion).toBe('20261102-meower-messages');
        expect(tabsJs).toContain(`NN_SHELL_STYLE_STYLESHEET_VERSION = '${cacheVersion}'`);
        expect(indexHtml).not.toContain('20261101-faithful-trackers');
        expect(indexHtml).toContain(`css/neconyan-character-tags.css?v=${cacheVersion}`);
    });
});
