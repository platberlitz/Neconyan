/* global globalThis */
/* eslint-disable playwright/no-conditional-in-test */
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const nativeClient = { run: jest.fn(), request: jest.fn() };
jest.unstable_mockModule('../public/scripts/operations-client.js', () => ({
    getOperationClient: async () => nativeClient, mountOperationRecovery: () => {},
}));
const {
    ARCHIVE_PAGE_SIZE,
    exportChat,
    fetchArchiveFile,
    fetchArchiveInventory,
    fetchOrganization,
    iterateArchiveInventoryPages,
    releaseArchiveSession,
    saveOrganization,
    searchArchive,
} = await import('../public/scripts/extensions/neconyan-chats-archive/src/api.js');
import {
    buildSearchScopes,
    createDefaultOrganization,
    deepResultToRecentRow,
    filterRows,
    findMatchingMessageIndex,
    findMatchingSnippet,
    findMatchingSnippetInJsonl,
    findMatchingSnippetInJsonlAsync,
    formatBytes,
    groupRows,
    normalizeRow,
    normalizeOrganization,
    normalizeSavedView,
    matchesQueryFragments,
    ownerFilterKey,
    parseChatJsonl,
    parseHumanSize,
    parseJsonl,
    parseLastMes,
    parseOwnerFilter,
    parseOrganization,
    physicalChatKey,
    recordsToText,
    shapeChatRecords,
    sortRows,
} from '../public/scripts/extensions/neconyan-chats-archive/src/core.js';
const { navigateAndConfirm } = await import('../public/scripts/extensions/neconyan-chats-archive/src/ui.js');

const extensionRoot = new URL('../public/scripts/extensions/neconyan-chats-archive/', import.meta.url);
const [entry, ui, manifestText, extensionsEndpoint] = await Promise.all([
    readFile(new URL('index.js', extensionRoot), 'utf8'),
    readFile(new URL('src/ui.js', extensionRoot), 'utf8'),
    readFile(new URL('manifest.json', extensionRoot), 'utf8'),
    readFile(new URL('../src/endpoints/extensions.js', import.meta.url), 'utf8'),
]);
const manifest = JSON.parse(manifestText);
const entryModule = await import('../public/scripts/extensions/neconyan-chats-archive/index.js');
const originalFetch = globalThis.fetch;
beforeEach(() => { nativeClient.run.mockReset(); nativeClient.request.mockReset(); });

afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.useRealTimers();
});

describe('SillyBunny Chats Archive API', () => {
    test('one accepted inventory supplies every display page and preserves late matching metadata', async () => {
        const rows = Array.from({ length: ARCHIVE_PAGE_SIZE }, (_, index) => ({ avatar: 'Scale.png', file_name: `chat-${index}.jsonl`, file_size: '1KB', chat_items: 1, last_mes: index }));
        rows.push({ avatar: 'Scale.png', file_name: 'qualifying.jsonl', file_size: '8MB', chat_items: 900, last_mes: 50_000 });
        nativeClient.run.mockResolvedValue({ key: 'saved-inventory', result: { rows, errors: 1 } });
        const progress = jest.fn();
        const inventory = await fetchArchiveInventory({}, 'archive', undefined, progress);
        expect(nativeClient.run).toHaveBeenCalledTimes(1);
        expect(nativeClient.run).toHaveBeenCalledWith('archive-inventory', { scope: 'archive' }, expect.objectContaining({ scope: 'archive:archive' }));
        expect(progress.mock.calls.map(([page]) => page.loaded)).toEqual([250, 251]);
        expect(inventory.readToken).toBe('saved-inventory');
        expect(inventory.errors).toBe(1);
        const normalized = inventory.rows.map(row => normalizeRow(row, [{ avatar: 'Scale.png', name: 'Scale' }], []));
        expect(filterRows(normalized, { minDate: 40_000, minMessages: 500, minSize: 4 * 1024 * 1024 }).map(row => row.file_id)).toEqual(['qualifying']);
        expect(sortRows(normalized, 'size')[0]).toMatchObject({ file_id: 'qualifying', archiveRecord: 'saved-inventory' });
    });

    test('closing display pagination neither releases server evidence nor submits another inventory', async () => {
        nativeClient.run.mockResolvedValue({ key: 'saved', result: { rows: Array.from({ length: 251 }, () => ({ file_name: 'one.jsonl' })), errors: 0 } });
        globalThis.fetch = jest.fn();
        const pages = iterateArchiveInventoryPages({}, 'orphans');
        expect((await pages.next()).value.loaded).toBe(250);
        await pages.return();
        await releaseArchiveSession({}, { token: 'saved' });
        expect(nativeClient.run).toHaveBeenCalledTimes(1);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    test('search and export each submit one complete workflow and propagate unknown outcomes', async () => {
        nativeClient.run.mockResolvedValueOnce({ key: 'search', result: { rows: [{ file_name: 'match.jsonl' }], errors: 2 } });
        expect(await searchArchive({}, 'dragon tavern')).toEqual({ rows: [{ file_name: 'match.jsonl', archive_record: 'search' }], errors: 2 });
        nativeClient.run.mockRejectedValueOnce(Object.assign(new Error('Unknown completion'), { status: 503 }));
        await expect(exportChat({}, { file: 'one.jsonl' })).rejects.toMatchObject({ status: 503 });
        expect(nativeClient.run.mock.calls.map(([kind]) => kind)).toEqual(['archive-search', 'archive-export']);
    });

    test('organisation changes retain Unicode and advance only the acknowledged server revision', async () => {
        const ctx = {}; const organization = { version: 1, name: '兔子 café', tags: ['竜', '🙂'] };
        await expect(saveOrganization(ctx, organization)).rejects.toThrow(/Load/);
        nativeClient.request.mockResolvedValue({ organization: null, revision: 'before' });
        expect(await fetchOrganization(ctx)).toBeNull();
        nativeClient.run.mockResolvedValueOnce({ result: { organization, revision: 'after' } });
        expect(await saveOrganization(ctx, organization)).toEqual({ organization, revision: 'after' });
        nativeClient.run.mockRejectedValueOnce(new Error('Lost acknowledgement'));
        await expect(saveOrganization(ctx, organization)).rejects.toThrow('Lost acknowledgement');
        expect(nativeClient.run.mock.calls.map(([, input]) => input)).toEqual([
            { revision: 'before', organization }, { revision: 'after', organization },
        ]);
    });

    test('versioned file reads retain status errors and use only the permanent owner-bound record', async () => {
        const signal = new AbortController().signal;
        globalThis.fetch = jest.fn(async () => ({ ok: true, text: async () => 'chat body' }));
        expect(await fetchArchiveFile({ getRequestHeaders: () => ({ 'x-test': 'yes' }) }, 'saved/key', 'hash', signal)).toBe('chat body');
        expect(globalThis.fetch).toHaveBeenCalledWith('/api/operations/records/saved%2Fkey/archive/hash', { headers: { 'x-test': 'yes' }, signal, cache: 'no-store' });
        globalThis.fetch.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'File changed' }) });
        await expect(fetchArchiveFile({ getRequestHeaders: () => ({}) }, 'saved', 'hash')).rejects.toMatchObject({ status: 409, message: 'File changed' });
    });

    test('incomplete saved results and aborted observations never become an empty successful archive', async () => {
        nativeClient.run.mockResolvedValueOnce({ key: 'broken', result: {} });
        await expect(fetchArchiveInventory({}, 'archive')).rejects.toThrow(/incomplete/);
        nativeClient.run.mockRejectedValueOnce(new DOMException('closed', 'AbortError'));
        await expect(fetchArchiveInventory({}, 'archive')).rejects.toMatchObject({ name: 'AbortError' });
    });
});

describe('SillyBunny Chats Archive core', () => {
    const characters = [
        { avatar: 'Seraphina.png', name: 'Seraphina' },
        { avatar: 'Nahida.png', name: 'Nahida' },
    ];
    const groups = [
        { id: 'group-1', name: 'Tavern Night' },
    ];
    const recentRows = [
        { avatar: 'Seraphina.png', file_id: 'dragon tavern', file_name: 'dragon tavern.jsonl', file_size: '1.5MB', chat_items: 142, last_mes: 3000, mes: 'The dragon grins.' },
        { avatar: 'Missing.png', file_id: 'lost chat', file_name: 'lost chat.jsonl', file_size: '800B', chat_items: 3, last_mes: 2000, mes: 'Hello?' },
        { group: 'group-1', file_id: 'abc-123', file_name: 'abc-123.jsonl', file_size: '2KB', chat_items: 38, last_mes: 4000, mes: 'Cheers!' },
        { file_id: 'stray', file_name: 'stray.jsonl', file_size: '12B', chat_items: 0, last_mes: 1000, mes: '[The chat is empty]' },
    ];
    const normalized = recentRows.map(row => normalizeRow(row, characters, groups));

    test('parseHumanSize handles the host formats', () => {
        expect(parseHumanSize('800B')).toBe(800);
        expect(parseHumanSize('1.5MB')).toBe(1.5 * 1024 * 1024);
        expect(parseHumanSize('1.2 KB')).toBe(1.2 * 1024);
        expect(parseHumanSize('1.2.3MB')).toBe(0);
        expect(parseHumanSize(`${Number.MAX_VALUE}TB`)).toBe(0);
        expect(parseHumanSize('garbage')).toBe(0);
        expect(parseHumanSize(undefined)).toBe(0);
    });

    test('formatBytes handles known and invalid byte counts', () => {
        expect(formatBytes(0)).toBe('0B');
        expect(formatBytes(1536)).toBe('1.5KB');
        expect(formatBytes(2 * 1024 * 1024)).toBe('2MB');
        expect(formatBytes(undefined)).toBe('');
    });

    test('parseLastMes handles mtimeMs numbers, ISO strings, host formats via toMoment, and garbage', () => {
        expect(parseLastMes(12345)).toBe(12345);
        expect(parseLastMes('2026-01-01T00:00:00.000Z')).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
        expect(parseLastMes(undefined)).toBe(0);
        expect(parseLastMes('not a date')).toBe(0);
        expect(parseLastMes(8_640_000_000_000_001)).toBe(0);
        const toMoment = value => ({ isValid: () => value === 'June 2, 2026 7:49pm', valueOf: () => 777 });
        expect(parseLastMes('June 2, 2026 7:49pm', toMoment)).toBe(777);
        expect(parseLastMes('2026-01-01T00:00:00.000Z', toMoment)).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
        expect(parseLastMes('too large', () => ({ isValid: () => true, valueOf: () => 1e100 }))).toBe(0);
    });

    test('normalizeRow uses toMoment for string last_mes', () => {
        const toMoment = () => ({ isValid: () => true, valueOf: () => 999 });
        const row = normalizeRow({ avatar: 'Seraphina.png', file_id: 'x', last_mes: 'June 2, 2026 7:49pm' }, characters, groups, toMoment);
        expect(row.mtime).toBe(999);
    });

    test('normalizeRow classifies solo, group, and both orphan causes', () => {
        expect(normalized[0].kind).toBe('solo');
        expect(normalized[0].ownerName).toBe('Seraphina');
        expect(normalized[1].kind).toBe('orphan');
        expect(normalized[1].ownerName).toBe('Missing');
        expect(normalized[1].avatar).toBe('Missing.png');
        expect(normalized[1].orphanType).toBe('missing-character');
        expect(normalized[2].kind).toBe('group');
        expect(normalized[2].ownerName).toBe('Tavern Night');
        expect(normalized[3].kind).toBe('orphan');
        expect(normalized[3].avatar).toBeNull();
        expect(normalized[3].orphanType).toBe('root');
    });

    test('normalizeRow accepts legacy numeric group IDs', () => {
        const row = normalizeRow({ group: 42, file_id: 'legacy' }, [], [{ id: '42', name: 'Legacy group' }]);
        expect(row.kind).toBe('group');
        expect(row.groupId).toBe('42');
        expect(row.ownerName).toBe('Legacy group');
    });

    test('normalizeRow accepts indexed owner maps', () => {
        const characterMap = new Map(characters.map(character => [character.avatar, character]));
        const groupMap = new Map(groups.map(group => [String(group.id), group]));
        expect(normalizeRow({ avatar: 'Seraphina.png', file_id: 'solo' }, characterMap, groupMap).ownerName).toBe('Seraphina');
        expect(normalizeRow({ group: 'group-1', file_id: 'group' }, characterMap, groupMap).ownerName).toBe('Tavern Night');
    });

    test('normalizeRow derives file_id from file_name when missing', () => {
        const row = normalizeRow({ file_name: 'plain.jsonl' }, [], []);
        expect(row.file_id).toBe('plain');
        expect(row.count).toBeNull();
        expect(row.snippet).toBe('');
    });

    test('normalizeRow turns available message text into a visible one-line preview', () => {
        expect(normalizeRow({ file_id: 'text', mes: '\n  First line\n\nSecond line  ' }).snippet).toBe('First line Second line');
        expect(normalizeRow({ file_id: 'blank', mes: ' \n\t ' }).snippet).toBe('');
        expect(normalizeRow({ file_id: 'long', mes: 'x'.repeat(500) }).snippet).toBe(`${'x'.repeat(397)}...`);
    });

    test('normalizers reject malformed records and keep file identity consistent', () => {
        expect(normalizeRow(null)).toBeNull();
        expect(normalizeRow({ avatar: 1, file_id: 'bad' })).toBeNull();
        expect(normalizeRow({ orphan_type: 'invalid', file_name: 'bad.jsonl' })).toBeNull();
        expect(deepResultToRecentRow('bad', {})).toBeNull();
        const row = normalizeRow({ file_id: 'wrong', file_name: 'actual.jsonl', chat_items: -3 });
        expect(row.file_id).toBe('actual');
        expect(row.count).toBe(0);
    });

    test('deepResultToRecentRow maps search results into the recent-row shape', () => {
        const mapped = deepResultToRecentRow(
            { file_name: 'found chat', file_size: '2KB', message_count: 7, last_mes: 5000, preview_message: '…tavern…' },
            { avatar_url: 'Seraphina.png' },
        );
        const row = normalizeRow(mapped, characters, groups);
        expect(row.kind).toBe('solo');
        expect(row.file_id).toBe('found chat');
        expect(row.count).toBe(7);
        expect(row.snippet).toBe('…tavern…');
        expect(row.source).toBe('search');
    });

    test('search scopes cover both wire types for legacy numeric group IDs', () => {
        expect(buildSearchScopes(
            [{ avatar: 'Seraphina.png' }],
            [{ id: '42' }, { id: 'group-1' }, { id: '0042' }, { id: '0' }],
        )).toEqual([
            { avatar_url: 'Seraphina.png' },
            { group_id: '42' },
            { group_id: 42 },
            { group_id: 'group-1' },
            { group_id: '0042' },
            { group_id: '0' },
        ]);
    });

    test('search scopes can be restricted to the selected owner', () => {
        expect(buildSearchScopes(characters, groups, 'Seraphina')).toEqual([
            { avatar_url: 'Seraphina.png' },
        ]);
        expect(buildSearchScopes(characters, groups, 'Tavern Night')).toEqual([
            { group_id: 'group-1' },
        ]);
        expect(buildSearchScopes(characters, groups, 'missing')).toEqual([]);
    });

    test('typed owner filters keep duplicate names and owner kinds distinct', () => {
        const duplicateCharacters = [
            { avatar: 'Alex.png', name: 'Alex' },
            { avatar: 'Alex_2.png', name: 'Alex' },
        ];
        const duplicateGroups = [{ id: 'alex-group', name: 'Alex' }];
        const rows = [
            normalizeRow({ avatar: 'Alex.png', file_id: 'first' }, duplicateCharacters, duplicateGroups),
            normalizeRow({ avatar: 'Alex_2.png', file_id: 'second' }, duplicateCharacters, duplicateGroups),
            normalizeRow({ group: 'alex-group', file_id: 'group' }, duplicateCharacters, duplicateGroups),
            normalizeRow({
                _source: 'archive-orphan',
                archive_hash: 'hash',
                chatFolder: 'Alex',
                file_name: 'missing.jsonl',
                orphan_type: 'missing-character',
            }),
        ];
        const first = ownerFilterKey(rows[0]);
        const second = ownerFilterKey(rows[1]);
        const group = ownerFilterKey(rows[2]);

        expect(first).toBe('@sbca:["character","Alex"]');
        expect(first).not.toBe(second);
        expect(parseOwnerFilter(group)).toEqual({ kind: 'group', id: 'alex-group' });
        expect(parseOwnerFilter('Alex')).toBeNull();
        expect(parseOwnerFilter('["group","alex-group"]')).toBeNull();
        expect(filterRows(rows, { owner: first }).map(row => row.file_id)).toEqual(['first', 'missing']);
        expect(filterRows(rows, { owner: second }).map(row => row.file_id)).toEqual(['second']);
        expect(filterRows(rows, { owner: group }).map(row => row.file_id)).toEqual(['group']);
        expect(filterRows(rows, { owner: 'Alex' })).toHaveLength(4);
        expect(buildSearchScopes(duplicateCharacters, duplicateGroups, second)).toEqual([{ avatar_url: 'Alex_2.png' }]);
        expect(buildSearchScopes(duplicateCharacters, duplicateGroups, group)).toEqual([{ group_id: 'alex-group' }]);
        expect(normalizeSavedView({ owner: second }).owner).toBe(second);
    });

    test('normalizeRow preserves archive orphan source details', () => {
        const row = normalizeRow({
            _source: 'archive-orphan',
            archive_hash: 'abc',
            chatFolder: 'Deleted',
            file_name: 'lost.jsonl',
            file_size: '2KB',
            last_mes: 123,
            orphan_type: 'missing-character',
        });
        expect(row.kind).toBe('orphan');
        expect(row.orphanType).toBe('missing-character');
        expect(row.ownerName).toBe('Deleted');
        expect(row.chatFolder).toBe('Deleted');
        expect(row.file_id).toBe('lost');
        expect(row.sizeText).toBe('2KB');
        expect(row.count).toBeNull();
        expect(row.archiveHash).toBe('abc');
    });

    test('physicalChatKey follows physical file scope instead of owner or archive token identity', () => {
        const linkedGroup = normalizeRow({ group: 'group-1', file_id: 'shared' }, [], groups);
        const missingGroup = normalizeRow({ group: 'deleted-group', file_id: 'shared' });
        const unlinkedGroup = normalizeRow({
            _source: 'archive-orphan',
            archive_hash: 'temporary-a',
            file_name: 'shared.jsonl',
            orphan_type: 'unlinked-group',
        });
        expect(physicalChatKey(linkedGroup)).toBe(physicalChatKey(missingGroup));
        expect(physicalChatKey(missingGroup)).toBe(physicalChatKey(unlinkedGroup));

        const linkedCharacter = normalizeRow({ avatar: 'Seraphina.png', file_id: 'solo' }, characters);
        const missingCharacter = normalizeRow({
            _source: 'archive-orphan',
            archive_hash: 'temporary-b',
            chatFolder: 'Seraphina',
            file_name: 'solo.jsonl',
            orphan_type: 'missing-character',
        });
        expect(linkedCharacter.chatFolder).toBe('Seraphina');
        expect(physicalChatKey(linkedCharacter)).toBe(physicalChatKey(missingCharacter));
        expect(physicalChatKey({ ...missingCharacter, archiveHash: 'different' })).toBe(physicalChatKey(missingCharacter));

        expect(physicalChatKey({ kind: 'solo', chatFolder: 'a:b', file_id: 'c' }))
            .not.toBe(physicalChatKey({ kind: 'solo', chatFolder: 'a', file_id: 'b:c' }));
        expect(physicalChatKey({ kind: 'orphan', orphanType: 'root', file_id: 'solo' })).toBe('["root","solo"]');
    });

    test('organization normalization is strict, sparse, stable, and reference-safe', () => {
        expect(createDefaultOrganization()).toEqual({
            version: 1,
            lastView: {},
            views: [],
            folders: [],
            collections: [],
            chats: {},
        });
        expect(() => normalizeOrganization(null)).toThrow(/root must be an object/);
        expect(() => normalizeOrganization([])).toThrow(/root must be an object/);
        expect(() => normalizeOrganization({})).toThrow(/Unsupported organization version/);
        expect(() => normalizeOrganization({ version: 2 })).toThrow(/version: 2/);

        const normalizedOrganization = normalizeOrganization({
            version: 1,
            unknown: true,
            lastView: {
                query: '  tavern  ',
                kinds: ['solo', 'solo', 'invalid', 'group'],
                sort: ' oldest ',
                group: ' folder ',
                density: ' compact ',
                favorite: false,
                folder: ' f1 ',
                collection: 'missing',
                minSize: 0,
                maxMessages: 20,
                minDate: '2026-01-01',
                results: [{ deep: true }],
            },
            views: [
                { id: ' view-1 ', name: ' Work ', view: { owner: ' Seraphina ', collection: 'c1', tag: ' Dragon ' } },
                { id: 'view-2', name: 'work', view: {} },
                { id: 'view-3', name: 'Broken' },
            ],
            folders: [
                { id: ' f1 ', name: ' Work ' },
                { id: 'f2', name: 'work' },
                { id: 'f1', name: 'Other' },
            ],
            collections: [
                { id: 'c1', name: ' Lore ' },
                { id: 'c2', name: 'lore' },
                { id: 'c3', name: 'Archive' },
            ],
            chats: {
                ' keep ': {
                    favorite: true,
                    folder: ' f1 ',
                    collections: ['c1', 'c1', 'missing'],
                    tags: [' Dragon ', 'dragon', 'Lore'],
                    ignored: true,
                },
                stale: { favorite: false, folder: 'missing', collections: ['missing'], tags: [] },
                retainedWithoutRows: { tags: [' Keep me '] },
            },
        });

        expect(normalizedOrganization).toEqual({
            version: 1,
            lastView: {
                query: 'tavern',
                kinds: ['solo', 'group'],
                sort: 'oldest',
                group: 'folder',
                density: 'compact',
                favorite: false,
                folder: 'f1',
                minSize: 0,
                maxMessages: 20,
                minDate: '2026-01-01',
            },
            views: [{
                id: 'view-1',
                name: 'Work',
                view: { owner: 'Seraphina', collection: 'c1', tag: 'Dragon' },
            }],
            folders: [{ id: 'f1', name: 'Work' }],
            collections: [{ id: 'c1', name: 'Lore' }, { id: 'c3', name: 'Archive' }],
            chats: {
                keep: { favorite: true, folder: 'f1', collections: ['c1'], tags: ['Dragon', 'Lore'] },
                retainedWithoutRows: { tags: ['Keep me'] },
            },
        });
        expect(parseOrganization(JSON.stringify(normalizedOrganization))).toEqual(normalizedOrganization);
    });

    test('normalizeSavedView retains only bounded browse state', () => {
        expect(normalizeSavedView({
            query: '   ',
            kinds: [],
            sort: 'invalid',
            group: 'owner',
            density: 'minimal',
            charSort: 'new',
            owner: ' Alice ',
            orphan: 'root',
            favorite: false,
            folder: null,
            collection: ' c1 ',
            tag: ' History ',
            minDate: 10,
            maxDate: '2026-12-31',
            minSize: 0,
            maxSize: Infinity,
            minMessages: 0,
            maxMessages: 2.5,
            selection: ['chat'],
            page: 4,
            viewer: { raw: true },
        }, { folders: [], collections: [{ id: 'c1' }] })).toEqual({
            kinds: [],
            group: 'owner',
            density: 'minimal',
            owner: 'Alice',
            orphan: 'root',
            favorite: false,
            folder: null,
            collection: 'c1',
            tag: 'History',
            minSize: 0,
            minMessages: 0,
            minDate: 10,
            maxDate: '2026-12-31',
        });
    });

    test('filterRows matches file name, owner, and snippet case-insensitively', () => {
        expect(filterRows(normalized, { text: 'DRAGON' })).toHaveLength(1);
        expect(filterRows(normalized, { text: 'seraphina' })[0].file_id).toBe('dragon tavern');
        expect(filterRows(normalized, { text: 'cheers' })[0].kind).toBe('group');
        expect(filterRows(normalized, { text: '' })).toHaveLength(4);
    });

    test('filterRows applies kind filters', () => {
        expect(filterRows(normalized, { kinds: ['orphan'] })).toHaveLength(2);
        expect(filterRows(normalized, { kinds: ['solo', 'group'] })).toHaveLength(2);
        expect(filterRows(normalized, { text: 'lost', kinds: ['solo'] })).toHaveLength(0);
    });

    test('an active Favorites category outranks deselected chat types', () => {
        const organization = {
            folders: [],
            collections: [],
            chats: {
                [physicalChatKey(normalized[0])]: { favorite: true },
                [physicalChatKey(normalized[2])]: { favorite: true },
            },
        };

        expect(filterRows(normalized, { kinds: [], favoritesSelected: true }, organization).map(row => row.file_id))
            .toEqual(['dragon tavern', 'abc-123']);
        expect(filterRows(normalized, { kinds: ['orphan'], favoritesSelected: true }, organization).map(row => row.file_id))
            .toEqual(['dragon tavern', 'lost chat', 'abc-123', 'stray']);
        expect(filterRows(normalized, { kinds: [], favoritesSelected: true }, null)).toHaveLength(0);
        expect(filterRows(normalized, { kinds: [] }, organization)).toHaveLength(0);
        expect(filterRows(normalized, { kinds: ['solo'], favoritesSelected: true }, organization).map(row => row.file_id))
            .toEqual(['dragon tavern', 'abc-123']);
        expect(filterRows(normalized, {
            kinds: [],
            favoritesSelected: true,
            owner: 'Tavern Night',
        }, organization).map(row => row.file_id)).toEqual(['abc-123']);
        expect(filterRows(normalized, {
            kinds: [],
            favorite: false,
            favoritesSelected: true,
        }, organization)).toHaveLength(0);
    });

    test('filterRows applies organization labels, facets, and metadata bounds', () => {
        const organization = {
            folders: [{ id: 'quests', name: 'Heroic Quests' }],
            collections: [{ id: 'lore', name: 'Lore Shelf' }],
            chats: {
                [physicalChatKey(normalized[0])]: {
                    favorite: true,
                    folder: 'quests',
                    collections: ['lore'],
                    tags: ['Ancient Dragon'],
                },
            },
        };
        for (const text of ['heroic quests', 'LORE SHELF', 'ancient dragon']) {
            expect(filterRows(normalized, { text }, organization).map(row => row.file_id)).toEqual(['dragon tavern']);
        }
        expect(filterRows(normalized, {
            kinds: ['solo'],
            owner: 'Seraphina',
            favorite: true,
            folder: 'quests',
            collection: 'lore',
            tag: 'ANCIENT DRAGON',
            minDate: 2500,
            maxDate: 3500,
            minSize: 1024,
            maxSize: 2 * 1024 * 1024,
            minMessages: 100,
            maxMessages: 200,
        }, organization).map(row => row.file_id)).toEqual(['dragon tavern']);
        expect(filterRows(normalized, { orphan: 'missing-character' }).map(row => row.file_id)).toEqual(['lost chat']);
        expect(filterRows(normalized, { folder: null }, organization)).toHaveLength(3);
        expect(filterRows(normalized, { favorite: false }, organization)).toHaveLength(3);

        const unknown = normalizeRow({ file_id: 'unknown' });
        expect(filterRows([unknown])).toHaveLength(1);
        expect(filterRows([unknown], { minDate: 0 })).toHaveLength(0);
        expect(filterRows([unknown], { minSize: 0 })).toHaveLength(0);
        expect(filterRows([unknown], { minMessages: 0 })).toHaveLength(0);
    });

    test('sortRows sorts by all four keys', () => {
        expect(sortRows(normalized, 'recent').map(row => row.file_id)).toEqual(['abc-123', 'dragon tavern', 'lost chat', 'stray']);
        expect(sortRows(normalized, 'size').map(row => row.file_id)).toEqual(['dragon tavern', 'abc-123', 'lost chat', 'stray']);
        expect(sortRows(normalized, 'count').map(row => row.file_id)).toEqual(['dragon tavern', 'abc-123', 'lost chat', 'stray']);
        expect(sortRows(normalized, 'name').map(row => row.file_id)).toEqual(['abc-123', 'dragon tavern', 'lost chat', 'stray']);
    });

    test('sortRows supports reverse sorts and keeps unknown metadata last', () => {
        expect(sortRows(normalized, 'oldest').map(row => row.file_id)).toEqual(['stray', 'lost chat', 'dragon tavern', 'abc-123']);
        expect(sortRows(normalized, 'smallest').map(row => row.file_id)).toEqual(['stray', 'lost chat', 'abc-123', 'dragon tavern']);
        expect(sortRows(normalized, 'fewest').map(row => row.file_id)).toEqual(['stray', 'lost chat', 'abc-123', 'dragon tavern']);
        expect(sortRows(normalized, 'name-reverse').map(row => row.file_id)).toEqual(['stray', 'lost chat', 'dragon tavern', 'abc-123']);
        expect(sortRows(normalized, 'owner').map(row => row.file_id)).toEqual(['stray', 'lost chat', 'dragon tavern', 'abc-123']);

        const rows = [
            { file_id: 'known-high', mtime: 20, sizeBytes: 20, count: 20 },
            { file_id: 'z-unknown', mtime: null, sizeBytes: null, count: null },
            { file_id: 'known-low', mtime: 10, sizeBytes: 10, count: 10 },
            { file_id: 'a-unknown' },
        ];
        for (const key of ['recent', 'size', 'count']) {
            expect(sortRows(rows, key).map(row => row.file_id)).toEqual(['known-high', 'known-low', 'a-unknown', 'z-unknown']);
        }
        for (const key of ['oldest', 'smallest', 'fewest']) {
            expect(sortRows(rows, key).map(row => row.file_id)).toEqual(['known-low', 'known-high', 'a-unknown', 'z-unknown']);
        }
    });

    test('groupRows preserves sorted first-occurrence group order', () => {
        const rows = [normalized[2], normalized[0], normalized[3], normalized[1]];
        const organization = {
            folders: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }],
            collections: [],
            chats: {
                [physicalChatKey(normalized[2])]: { folder: 'beta' },
                [physicalChatKey(normalized[0])]: { folder: 'alpha' },
                [physicalChatKey(normalized[3])]: { folder: 'beta' },
            },
        };

        expect(groupRows(rows, 'type').map(group => [group.label, group.rows.map(row => row.file_id)])).toEqual([
            ['group', ['abc-123']],
            ['solo', ['dragon tavern']],
            ['orphan', ['stray', 'lost chat']],
        ]);
        const folderRows = [normalized[1], normalized[2], normalized[0], normalized[3]];
        expect(groupRows(folderRows, 'folder', organization).map(group => [group.label, group.rows.map(row => row.file_id)])).toEqual([
            ['Beta', ['abc-123', 'stray']],
            ['Alpha', ['dragon tavern']],
            ['Unfiled', ['lost chat']],
        ]);
        expect(groupRows(rows, 'owner').map(group => group.label)).toEqual(['Tavern Night', 'Seraphina', 'Unknown owner', 'Missing']);
        expect(groupRows(rows, 'flat').map(group => group.rows)).toEqual([rows]);
    });

    test('shapeChatRecords splits header from messages and shapes them', () => {
        const records = [
            { user_name: 'unused', chat_metadata: { integrity: 'uuid', MacroEnhanced: {} } },
            { name: 'You', is_user: true, send_date: '2026-01-01T00:00:00.000Z', mes: 'Hi' },
            { name: 'Seraphina', is_user: false, mes: 'Hello', swipe_id: 1, swipes: [null, 'Hello', 'Hey'], extra: { model: 'x', api: 'y' } },
            { name: 'System', is_system: true, mes: 'note' },
        ];
        const shaped = shapeChatRecords(records);
        expect(shaped.metadataKeys).toEqual(['integrity', 'MacroEnhanced']);
        expect(shaped.messages).toHaveLength(3);
        expect(shaped.messages[0].isUser).toBe(true);
        expect(shaped.messages[1].swipeCount).toBe(1);
        expect(shaped.messages[1].alternatives).toEqual(['Hey']);
        expect(shaped.messages[1].extra).toEqual({ model: 'x', api: 'y' });
        expect(shaped.messages[2].isSystem).toBe(true);
    });

    test('parseJsonl handles BOMs and blank lines and identifies corrupt lines', () => {
        expect(parseJsonl('\uFEFF{"chat_metadata":{}}\n\n{"name":"You","mes":"Hi"}\r\n')).toEqual([
            { chat_metadata: {} },
            { name: 'You', mes: 'Hi' },
        ]);
        expect(() => parseJsonl('{"ok":true}\nnot json')).toThrow(/line 2/);
    });

    test('findMatchingSnippet uses cross-message AND fragment semantics', () => {
        const records = [
            { name: 'A', mes: 'The red dragon left.' },
            { name: 'B', mes: 'Meet me at the tavern.' },
            { name: 'C', mes: 'This final preview has neither term.' },
        ];
        expect(findMatchingSnippet(records, 'dragon tavern')).toBe('The red dragon left.');
        expect(findMatchingSnippet(records, 'dragon castle')).toBeNull();
        expect(findMatchingSnippet([{ mes: '\n  dragon\n\narrives  ' }], 'dragon')).toBe('dragon arrives');
    });

    test('findMatchingMessageIndex points to the first preview match only when the whole query matches', () => {
        const messages = [
            { mes: 'The red dragon left.' },
            { mes: 'Meet me at the tavern.' },
        ];
        expect(findMatchingMessageIndex(messages, 'dragon tavern')).toBe(0);
        expect(findMatchingMessageIndex(messages, 'dragon castle')).toBe(-1);
        expect(findMatchingMessageIndex(messages, '   ')).toBe(-1);
    });

    test('matchesQueryFragments applies host-style AND matching to filenames', () => {
        expect(matchesQueryFragments('dragon at the tavern', 'DRAGON tavern')).toBe(true);
        expect(matchesQueryFragments('dragon at the inn', 'dragon tavern')).toBe(false);
        expect(matchesQueryFragments('anything', '   ')).toBe(false);
    });

    test('JSONL search keeps readable messages around a corrupt line', () => {
        const raw = '{"name":"A","mes":"red dragon"}\nnot json\n{"name":"B","mes":"the tavern"}';
        expect(findMatchingSnippetInJsonl(raw, 'dragon tavern')).toEqual({ snippet: 'red dragon', invalidLines: 1 });
        expect(findMatchingSnippetInJsonl(raw, 'dragon castle')).toEqual({ snippet: null, invalidLines: 1 });
    });

    test('chunked JSONL parsing and search preserve behavior and honor cancellation', async () => {
        const raw = '\uFEFF{"chat_metadata":{"integrity":"ok"}}\n{"name":"A","mes":"red dragon"}\n{"name":"B","mes":"the tavern"}';
        await expect(parseChatJsonl(raw, { linesPerChunk: 1 })).resolves.toEqual(shapeChatRecords(parseJsonl(raw)));
        await expect(findMatchingSnippetInJsonlAsync(`${raw}\nnot json`, 'dragon tavern', { linesPerChunk: 1 }))
            .resolves.toEqual({ snippet: 'red dragon', invalidLines: 1 });

        const controller = new AbortController();
        const pending = findMatchingSnippetInJsonlAsync(raw.repeat(100), 'dragon', {
            signal: controller.signal,
            linesPerChunk: 1,
        });
        setTimeout(() => controller.abort(), 0);
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

        const parseController = new AbortController();
        const parsing = parseChatJsonl('{"mes":"ok"}\nnot json', {
            signal: parseController.signal,
            linesPerChunk: 1,
        });
        parseController.abort();
        await expect(parsing).rejects.toMatchObject({ name: 'AbortError' });
    });

    test('recordsToText skips system messages and honors display text', () => {
        const text = recordsToText([
            { name: 'System', is_system: true, mes: 'hidden' },
            { name: 'You', mes: 'raw', extra: { display_text: 'shown' } },
            { name: 'You', mes: 'fallback', extra: { display_text: '' } },
            { name: 'Bot', mes: 'reply' },
        ]);
        expect(text).toBe('You: shown\n\nYou: fallback\n\nBot: reply');
    });

    test('shapeChatRecords tolerates malformed and empty input', () => {
        expect(shapeChatRecords(null).messages).toEqual([]);
        expect(shapeChatRecords([]).metadataKeys).toEqual([]);
        const noHeader = shapeChatRecords([{ name: 'You', mes: 'orphan line' }, null, 'junk']);
        expect(noHeader.header).toBeNull();
        expect(noHeader.messages).toHaveLength(1);
    });
});

describe('SillyBunny Chats Archive navigation', () => {
    function context() {
        return {
            eventSource: new EventEmitter(),
            eventTypes: { CHAT_CHANGED: 'chat-changed' },
        };
    }

    test('navigation resolves only after the requested host event', async () => {
        const ctx = context();
        await navigateAndConfirm(ctx, 'wanted', async () => {
            ctx.eventSource.emit(ctx.eventTypes.CHAT_CHANGED, 'other');
            ctx.eventSource.emit(ctx.eventTypes.CHAT_CHANGED, 'wanted');
        });
        expect(ctx.eventSource.listenerCount(ctx.eventTypes.CHAT_CHANGED)).toBe(0);
    });

    test('navigation rejects immediately when the host action finishes unconfirmed', async () => {
        const ctx = context();
        await expect(navigateAndConfirm(ctx, 'wanted', async () => {})).rejects.toThrow(/did not confirm/);
        expect(ctx.eventSource.listenerCount(ctx.eventTypes.CHAT_CHANGED)).toBe(0);
    });

    test('navigation timeout rejects and removes the host listener when the action hangs', async () => {
        const ctx = context();
        let actionSignal;
        await expect(navigateAndConfirm(ctx, 'wanted', signal => {
            actionSignal = signal;
            return new Promise(() => {});
        }, { timeout: 5 })).rejects.toMatchObject({ name: 'TimeoutError' });
        expect(actionSignal.aborted).toBe(true);
        expect(ctx.eventSource.listenerCount(ctx.eventTypes.CHAT_CHANGED)).toBe(0);
    });

    test('navigation abort rejects and removes the host listener', async () => {
        const ctx = context();
        const controller = new AbortController();
        const pending = navigateAndConfirm(ctx, 'wanted', signal => (
            new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
        ), { signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(ctx.eventSource.listenerCount(ctx.eventTypes.CHAT_CHANGED)).toBe(0);
    });
});

describe('SillyBunny Chats Archive integration', () => {
    test('entry point is one host-sized native dialog button, not a fake tab', () => {
        expect(entry).toMatch(/createElement\('button'\)/);
        expect(entry).toMatch(/createElement\('i'\)/);
        expect(entry).toMatch(/fa-box-archive/);
        expect(entry).toMatch(/aria-haspopup', 'dialog'/);
        expect(entry).not.toMatch(/role', 'tab'/);
        expect(entry).not.toMatch(/data-sb-character-tab/);
        expect(entry).toMatch(/button\.className = 'menu_button sbca-drawer-button'/);
    });

    test('archive exposes labels, live state, selection, and cancellable work', () => {
        expect(ui).toMatch(/setAttribute\('role', 'status'\)/);
        expect(ui).toMatch(/aria-labelledby/);
        expect(ui).toMatch(/aria-current/);
        expect(ui).toMatch(/new AbortController\(\)/);
        expect(ui).toMatch(/eventTypes\.CHAT_CHANGED/);
        expect(ui).toMatch(/setActive(?:Character|Group)/);
        expect(ui).toMatch(/aria-expanded/);
        expect(ui).toMatch(/aria-pressed/);
        expect(ui).toMatch(/const search = mentionSearchState\(ui\.search\.value, ui\.characterMentions\);[\s\S]*state\.deepRows === null \? search\.text : ''/);
        expect(ui).toMatch(/favoritesSelected: ui\.favorite\.checked/);
        expect(ui).toMatch(/ORGANIZATION_FILE_NAME/);
        expect(ui).not.toMatch(/Do not delete \{name\} through host Data Maid/);
        expect(ui).toMatch(/sbca-selection-toggle/);
        expect(ui).toMatch(/sbca-organizer/);
        expect(ui).toMatch(/physicalChatKey/);
        expect(ui).toMatch(/summary\.setAttribute\('aria-label', `\$\{tr\(ctx, 'Character or group'\)\}: \$\{choice\.label\}`\)/);
        expect(ui).not.toMatch(/el\('span', 'sbca-label', tr\(ctx, 'Character or group'\)\)/);
        expect(ui).toMatch(/'All characters and groups'/);
        expect(ui).toMatch(/sbca-owner-selector/);
        expect(ui).toMatch(/const ownerField = ownerControl\(ctx\)/);
        expect(ui).toMatch(/ownerFilterKey\(row\)/);
        expect(ui).toMatch(/getThumbnailUrl\('avatar', choice\.avatar\)/);
        expect(ui).toMatch(/Search characters and groups/);
        expect(ui).toMatch(/Character: \{name\}/);
        expect(ui).toMatch(/const listTools = el\('div', 'sbca-list-tools'\)/);
        expect(ui).toMatch(/listTools\.append\(ownerField\.wrap, sortPills, selectionBar\)/);
        expect(ui).toMatch(/listTop\.append\(listHeading, listTools\)/);
        expect(ui).toMatch(/listPanel\.append\(listTop, list\)/);
        expect(ui).toMatch(/sbca-list-tools/);
        expect(ui).not.toMatch(/listTools\.open/);
        expect(ui).toMatch(/option\.addEventListener\('pointerdown', event => \{\s*if \(event\.button !== 0 \|\| event\.pointerType === 'touch'\)/);
        expect(ui).toMatch(/option\.addEventListener\('click', select\)/);
        expect(ui).toMatch(/sbca-sortpill/);
        expect(ui).not.toMatch(/characterChips|sbca-charstrip|sbca-charchip|charSort/);
        expect(ui).toMatch(/enterKeyHint = 'search'/);
        expect(ui).toMatch(/Type to search chats\. Mention character names with @\./);
        expect(ui).toMatch(/role', 'listbox'/);
        expect(ui).toMatch(/function fuzzyMentionChoices/);
        expect(ui).toMatch(/function mentionedRows/);
        expect(ui).toMatch(/SEARCH_CONTENT_DEBOUNCE_MS = 600/);
        expect(ui).toMatch(/state\.listState !== 'ready' \|\| state\.scanAbort \|\| state\.searchAbort/);
        expect(ui).toMatch(/search\.addEventListener\('input',[\s\S]*?applyQuery\(\);[\s\S]*?runDeepSearch/);
        expect(ui).toMatch(/await searchArchive\(ctx, query, signal/);
        expect(ui).toMatch(/findMatchingMessageIndex/);
        expect(ui).toMatch(/First search match/);
        expect(ui).toMatch(/Latest messages/);
        expect(ui).toMatch(/event\.key !== 'ArrowDown'/);
        expect(ui).toMatch(/event\.isComposing/);
        expect(ui).toMatch(/more\.click\(\)/);
        expect(ui).toMatch(/showPage\(shaped\.messages\.length - MESSAGE_PAGE_SIZE\)/);
        expect(ui).toMatch(/state\.deepRows !== null && state\.deepQuery === matchQuery/);
        expect(ui).not.toMatch(/search result verification failed/);
        expect(ui).toMatch(/const found = new Map\(filterRows\(mentionedRows\(allRows\(state\), search\.mentions\), \{ text: query \}/);
        expect(ui).toMatch(/search items had errors/);
        expect(ui).toMatch(/normalizeRow\(raw, state\.charactersByAvatar, state\.groupsById/);
        expect(ui).not.toMatch(/row\.kind === 'orphan' \|\| row\.source === 'inventory'/);
        expect(ui).not.toMatch(/findMatchingSnippetInJsonlAsync\(raw, query/);
        expect(ui).not.toMatch(/findExistingGroupFiles/);
        expect(ui).toMatch(/savedViewField\.wrap\.hidden = true/);
        expect(ui).toMatch(/ui\.savedViewWrap\.hidden = organization\.views\.length === 0/);
        expect(ui).toMatch(/filterToggle\.setAttribute\('aria-controls', optionsPanel\.id\)/);
        expect(ui).toMatch(/filterToggle\.setAttribute\('aria-expanded'/);
        expect(ui).toMatch(/organizationToggle\.setAttribute\('aria-controls', organizationPanel\.id\)/);
        expect(ui).toMatch(/Manage organization/);
        expect(ui).not.toMatch(/SORT_OPTIONS/);
        expect(ui).not.toMatch(/sortField/);
        expect(ui).not.toMatch(/Clear filters/);
        expect(ui).not.toMatch(/Search message content/);
        expect(ui).not.toMatch(/sbca-row-selection-label/);
        expect(ui).not.toMatch(/\browKey\(/);
        expect(ui).not.toMatch(/menu_button/);
        expect(ui).not.toMatch(/el\('div', 'sbca-action/);
    });

    test('archive preserves focus and exposes item-specific actions', () => {
        expect(ui).toMatch(/function preserveArchiveFocus\(ui, update\)/);
        expect(ui).toMatch(/organizationFocusKey\('manager', type, item\.id, 'rename'\)/);
        expect(ui).toMatch(/organizationFocusKey\('viewer-action', key, 'favorite'\)/);
        expect(ui).toMatch(/control\.dataset\.sbcaFocusKey === snapshot\.fallback/);
        expect(ui).toMatch(/snapshot\.viewer \? ui\.viewerTitle : snapshot\.list \? ui\.listHeading/);
        expect(ui).toMatch(/preserveArchiveFocus\(ui, \(\) => \{\s*refreshOrganizationUI/s);
        expect(ui).toMatch(/Rename \{name\}/);
        expect(ui).toMatch(/Delete \{name\}/);
        expect(ui).toMatch(/Select \{name\} for \{owner\}/);
        expect(ui).toMatch(/Delete saved view \{name\}\?/);
        expect(ui).toMatch(/const focusInFilters = optionsPanel\.contains\(active\);\s*const organizationExpanded = organizationToggle\.getAttribute\('aria-expanded'\) === 'true';\s*const showDesktopFilters = !event\.matches && !organizationExpanded;\s*optionsPanel\.hidden = !showDesktopFilters/s);
        expect(ui).toMatch(/focusInFilters\) \{[\s\S]*?restoreFilterFocusOnDesktop = true;[\s\S]*?filterToggle\.focus/s);
        expect(ui).toMatch(/focusInBrowse\) \{\s*groupField\.select\.focus/s);
        expect(ui).toMatch(/const folder = el\('div', 'sbca-organizer-folder'\)/);
        expect(ui).toMatch(/folder\.setAttribute\('aria-labelledby', folderLabel\.id\)/);
        expect(ui).toMatch(/folderLabel\.classList\.add\('sbca-organizer-section-title'\)/);
        expect(ui).toMatch(/const collectionsField = selectControl\(ctx, 'Collections'/);
        expect(ui).toMatch(/Remove collection \{name\}/);
        const cancelViewer = ui.slice(ui.indexOf('function cancelViewer'), ui.indexOf('function cancelNavigation'));
        expect(cancelViewer).toMatch(/state\.viewerAbort\?\.abort\(\)/);
        expect(cancelViewer).not.toMatch(/state\.viewerAbort = null/);
    });

    test('message lists, grouping, scans, and search retain their safety contracts', () => {
        const searchStart = ui.indexOf('search.addEventListener(\'keydown\'', ui.indexOf('const flushQuery'));
        const searchHandler = ui.slice(searchStart, ui.indexOf('\n    });', searchStart));
        expect(searchHandler).toMatch(/event\.key !== 'Enter' \|\| event\.isComposing/);
        expect(searchHandler).toMatch(/flushQuery\(\)/);
        expect(ui).not.toMatch(/deepButton/);
        expect(ui).toMatch(/control === ui\.owner && mentionSearchState\(ui\.search\.value, ui\.characterMentions\)\.text[\s\S]*state\.listState === 'ready' && !state\.scanAbort/);
        expect(ui).toMatch(/function applySavedView[\s\S]*mentionSearchState\(ui\.search\.value, ui\.characterMentions\)\.text && state\.listState === 'ready' && !state\.scanAbort[\s\S]*runDeepSearch/);
        expect(ui).toMatch(/ui\.scanButton\.textContent = tr[\s\S]*if \(mentionSearchState\(ui\.search\.value, ui\.characterMentions\)\.text\) \{[\s\S]*runDeepSearch/);
        expect(ui).toMatch(/const messageList = el\('div', 'sbca-message-list'\);/);
        expect(ui).toMatch(/messageList\.setAttribute\('role', 'list'\)/);
        expect(ui).toMatch(/messages\.append\(messageList, el\('p', 'sbca-placeholder'/);
        expect(ui).toMatch(/appendMessagePage\(ctx, shaped\.messages, messageList, messages/);
        expect(ui).toMatch(/list\.append\(card\)/);
        expect(ui).toMatch(/controls\.append\(more\)/);
        expect(ui).toMatch(/showPage\(end\)\?\.focus/);
        expect(ui).toMatch(/Raw preview truncated\. Download the original file/);
        expect(ui).toMatch(/const shownRows = new Set\(rows\.slice\(0, state\.visibleLimit\)\)/);
        expect(ui).toMatch(/groupRows\(rows, ui\.group\.value, state\.organization\)/);
        expect(ui).toMatch(/group\.rows\.filter\(row => shownRows\.has\(row\)\)/);
        expect(ui).toMatch(/group\.rows\.length/);
        expect(ui).toMatch(/for \(const row of shownGroupRows\)/);
        expect(ui).toMatch(/ui\.status\.setAttribute\('aria-busy', 'true'\)/);
        expect(ui).toMatch(/ui\.status\.removeAttribute\('aria-busy'\)/);
    });

    test('manifest hooks resolve to exported lifecycle functions', () => {
        expect(manifest.hooks).toEqual({ activate: 'activate', enable: 'enable', disable: 'disable' });
        expect(manifest).not.toHaveProperty('bundled_opt_in');
        expect(manifest).not.toHaveProperty('minimum_client_version');
        for (const hook of Object.values(manifest.hooks)) {
            expect(typeof entryModule[hook]).toBe('function');
        }
        expect(extensionsEndpoint).toMatch(/const CORE_EXTENSIONS = new Set\(\[[\s\S]*?'neconyan-chats-archive',[\s\S]*?\]\);/);
        expect(ui).toContain('import(\'../../../../script.js\')');
        expect(ui).toContain('import(\'../../../group-chats.js\')');
    });

    test('entry observer narrows from the document body when the host panel appears', () => {
        expect(entry).toMatch(/const target = document\.querySelector\(PANEL_SELECTOR\) \?\? document\.body/);
        expect(entry).toMatch(/observerTarget !== target/);
        expect(entry).toMatch(/observer\.observe\(target\.parentElement, \{ childList: true \}\)/);
        expect(entry).toMatch(/pending = setTimeout\(\(\) => \{\s*pending = null;\s*install\(\);/);
    });

});
