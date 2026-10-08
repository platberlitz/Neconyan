import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildStylesheet,
    dedupeImportedIds,
    exportFileName,
    groupActiveSnippets,
    isFilteredOut,
    isTrueFlag,
    matchesSearch,
    mergeSyncedList,
    normalizeSettings,
    normalizeSnippet,
    parseImport,
    readBooleanArgument,
    toSnippetJson,
    upsertSynced,
    wasSynced,
} from '../public/scripts/extensions/css-snippets/src/store.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(repoRoot, 'public/scripts/extensions/css-snippets');

function idMaker() {
    let next = 0;
    return () => `id-${++next}`;
}

function snippet(props) {
    return normalizeSnippet(props, { makeId: idMaker() });
}

describe('CSS Snippets data compatibility', () => {
    test('normalises original snippets, including legacy fields', () => {
        const result = normalizeSnippet({
            id: 'abc',
            name: 'Old',
            content: 'body { color: red; }',
            isCollapsedd: true,
            isTheme: true,
        }, { makeId: idMaker(), themeSnippets: { Calico: ['Old'] } });
        expect(result).toEqual({
            id: 'abc',
            name: 'Old',
            isDisabled: false,
            isGlobal: true,
            content: 'body { color: red; }',
            isCollapsed: true,
            isSynced: false,
            isDeleted: false,
            modifiedOn: expect.any(Number),
            themeList: ['Calico'],
            charList: [],
            groupList: [],
        });
        expect(result).not.toHaveProperty('isTheme');
        expect(Object.keys(toSnippetJson(result)).sort()).toEqual([
            'charList', 'content', 'groupList', 'id', 'isCollapsed', 'isDeleted', 'isDisabled',
            'isGlobal', 'isSynced', 'modifiedOn', 'name', 'themeList',
        ]);
    });

    test('fills missing settings and keeps the original key names', () => {
        const settings = { snippetList: [{ id: 'same', content: 'a{}' }, { id: 'same', content: 'b{}' }] };
        normalizeSettings(settings, { makeId: idMaker() });
        expect(settings.watchInterval).toBe(500);
        expect(settings.themeSnippets).toEqual({});
        expect(settings.filters).toEqual({ disabled: false, theme: false, thisTheme: false, global: false });
        expect(settings.snippetList.map(item => item.content)).toEqual(['a{}', 'b{}']);
        expect(new Set(settings.snippetList.map(item => item.id)).size).toBe(2);
    });

    test('reads slash command flags like the original', () => {
        expect(isTrueFlag(undefined)).toBe(false);
        expect(isTrueFlag('')).toBe(true);
        expect(isTrueFlag('true')).toBe(true);
        expect(isTrueFlag('false')).toBe(false);
        expect(readBooleanArgument(undefined, true)).toBe(true);
        expect(readBooleanArgument('false', true)).toBe(false);
    });
});

describe('CSS Snippets apply rules', () => {
    const chat = { avatar: 'alice.png', groupId: null };

    test('groups snippets into everywhere, theme and chat sections', () => {
        const list = [
            snippet({ id: 'g', name: 'G', isGlobal: true, content: 'g{}' }),
            snippet({ id: 'off', isGlobal: true, isDisabled: true, content: 'o{}' }),
            snippet({ id: 't', isGlobal: false, themeList: ['Calico'], content: 't{}' }),
            snippet({ id: 'tc-miss', isGlobal: false, themeList: ['Calico'], charList: ['bob.png'], content: 'x{}' }),
            snippet({ id: 'c', isGlobal: false, charList: ['alice.png'], content: 'c{}' }),
            snippet({ id: 'tc', isGlobal: false, themeList: ['Calico'], charList: ['alice.png'], content: 'b{}' }),
            snippet({ id: 'other', isGlobal: false, themeList: ['Paper'], content: 'p{}' }),
        ];
        const sections = groupActiveSnippets(list, { theme: 'Calico', chat });
        expect(sections.global.map(item => item.id)).toEqual(['g']);
        expect(sections.theme.map(item => item.id)).toEqual(['t', 'tc']);
        expect(sections.chat.map(item => item.id)).toEqual(['c']);
    });

    test('matches group chats by id', () => {
        const list = [snippet({ id: 'grp', isGlobal: false, groupList: ['17'], content: 'g{}' })];
        const sections = groupActiveSnippets(list, { theme: '', chat: { avatar: null, groupId: '17' } });
        expect(sections.chat.map(item => item.id)).toEqual(['grp']);
    });

    test('builds the stylesheet with the original section headers', () => {
        const sections = {
            global: [snippet({ name: 'One', content: 'a { color: red; }' })],
            theme: [snippet({ name: 'Two */ evil', content: 'b {}' })],
            chat: [],
        };
        const css = buildStylesheet(sections, text => text.trim());
        expect(css).toContain('=== GLOBAL SNIPPETS ===');
        expect(css).toContain('=== THEME SNIPPETS ===');
        expect(css).toContain('=== CHAR SNIPPETS ===');
        expect(css).toContain('/* SNIPPET: One */\na { color: red; }');
        expect(css).toContain('/* SNIPPET: Two * / evil */');
    });
});

describe('CSS Snippets sharing in this browser', () => {
    test('upserts and recognises shared entries', () => {
        const item = snippet({ id: 's1', isSynced: true, content: 'a{}' });
        const list = upsertSynced([], item);
        expect(wasSynced(list, item)).toBe(true);
        expect(upsertSynced(list, { ...item, content: 'b{}' })).toHaveLength(1);
    });

    test('merges shared entries with the original rules', () => {
        const settings = {
            snippetList: [
                snippet({ id: 'unshare', isSynced: true, modifiedOn: 1 }),
                snippet({ id: 'newer', isSynced: true, content: 'old{}', modifiedOn: 1 }),
                snippet({ id: 'gone', isSynced: true, modifiedOn: 1 }),
            ],
        };
        normalizeSettings(settings, { makeId: idMaker() });
        const shared = [
            { id: 'unshare', isSynced: false, modifiedOn: 5 },
            { id: 'newer', isSynced: true, content: 'new{}', modifiedOn: 5 },
            { id: 'gone', isSynced: true, isDeleted: true, modifiedOn: 5 },
            { id: 'added', isSynced: true, content: 'add{}', modifiedOn: 5 },
            { id: 'deleted-elsewhere', isSynced: true, isDeleted: true, modifiedOn: 5 },
        ];
        const { changed } = mergeSyncedList(settings, shared, { makeId: idMaker() });
        expect(changed).toBe(true);
        const byId = Object.fromEntries(settings.snippetList.map(item => [item.id, item]));
        expect(byId.unshare.isSynced).toBe(false);
        expect(byId.newer.content).toBe('new{}');
        expect(byId.gone).toBeUndefined();
        expect(byId.added.content).toBe('add{}');
        expect(byId['deleted-elsewhere']).toBeUndefined();
    });
});

describe('CSS Snippets manager helpers', () => {
    const item = snippet({ name: 'Bubble tweak', content: '.mes { border-radius: 8px; }', themeList: ['Calico'] });

    test('searches with the original prefixes', () => {
        expect(matchesSearch(item, 'bubble')).toBe(true);
        expect(matchesSearch(item, 'name:radius')).toBe(false);
        expect(matchesSearch(item, 'css:radius')).toBe(true);
        expect(matchesSearch(item, 'theme:calico')).toBe(true);
        expect(matchesSearch(item, 'all:border')).toBe(true);
        expect(matchesSearch(item, '[unclosed')).toBe(false);
    });

    test('applies the original hide filters', () => {
        const none = { disabled: false, theme: false, thisTheme: false, global: false };
        expect(isFilteredOut(item, none, 'Calico')).toBe(false);
        expect(isFilteredOut(item, { ...none, global: true }, 'Calico')).toBe(true);
        expect(isFilteredOut(item, { ...none, thisTheme: true }, 'Calico')).toBe(true);
        expect(isFilteredOut(item, { ...none, theme: true }, 'Paper')).toBe(true);
        expect(isFilteredOut({ ...item, isDisabled: true }, { ...none, disabled: true }, 'Calico')).toBe(true);
    });

    test('imports exported JSON, single objects and plain CSS', () => {
        const makeId = idMaker();
        const exported = JSON.stringify([toSnippetJson({ ...item, isDeleted: true })]);
        const fromJson = parseImport(exported, { makeId });
        expect(fromJson).toHaveLength(1);
        expect(fromJson[0]).toMatchObject({ name: 'Bubble tweak', isDeleted: false });
        expect(parseImport('{"name":"x","content":"a{}"}', { makeId })[0].name).toBe('x');
        const plain = parseImport('body { margin: 0; }', { makeId });
        expect(plain).toEqual([expect.objectContaining({ name: '', content: 'body { margin: 0; }' })]);
        expect(parseImport('   ', { makeId })).toEqual([]);
    });

    test('gives clashing imports a fresh id', () => {
        const existing = [snippet({ id: 'taken' })];
        const result = dedupeImportedIds(existing, [snippet({ id: 'taken', isSynced: true })], () => 'fresh');
        expect(result[0]).toMatchObject({ id: 'fresh', isSynced: false });
    });

    test('keeps the original export file name', () => {
        expect(exportFileName('2026-10-01T00:00:00.000Z')).toBe('SillyTavern-CSS-Snippets-2026-10-01T00:00:00.000Z.json');
    });
});

describe('CSS Snippets packaging', () => {
    test('ships as a native extension with the original commands and launcher', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
        expect(manifest).toMatchObject({ display_name: 'CSS Snippets', js: 'index.js', css: 'style.css', auto_update: false });
        const commands = fs.readFileSync(path.join(extensionRoot, 'src/commands.js'), 'utf8');
        for (const name of ['csss', 'csss-on', 'csss-off', 'csss-create', 'csss-delete', 'csss-get', 'csss-update']) {
            expect(commands).toContain(`name: '${name}'`);
        }
        const index = fs.readFileSync(path.join(extensionRoot, 'index.js'), 'utf8');
        expect(index).toContain('\'csss_manager_button\'');
        expect(index).toContain('#CustomCSS-block');
        const tabs = fs.readFileSync(path.join(repoRoot, 'public/scripts/neconyan-tabs.js'), 'utf8');
        expect(tabs).toContain('{ id: \'css-snippets\', label: \'CSS Snippets\', icon: \'fa-list-check\', actions: [\'open\'], open: \'css-snippets\' }');
        expect(tabs).toContain('clickNeconyanNativeLauncher(\'#csss_manager_button\')');
    });

    test('does not ship the original bundled code editor', () => {
        expect(fs.existsSync(path.join(extensionRoot, 'lib'))).toBe(false);
    });
});
