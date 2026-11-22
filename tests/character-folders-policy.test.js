import {
    AI_SORT_BATCH_MAX,
    AI_SORT_BATCH_MIN,
    buildAiSortPrompt,
    buildFolderTabs,
    chunkForAiSort,
    cleanFolderName,
    createCustomPrompt,
    defaultCharacterFolderSettings,
    detectImportSource,
    detectSourceFromUrl,
    mergeNewFolderSpellings,
    normalizeCharacterFolderSettings,
    parseAiSortResponse,
    planImportFolder,
    resolveAiSortPrompt,
    summarizeCharacterForSort,
} from '../public/scripts/neconyan-character-folders-policy.js';

function enabledSettings(overrides = {}) {
    const settings = defaultCharacterFolderSettings();
    settings.autoSort.enabled = true;
    Object.assign(settings.autoSort, overrides);
    return settings;
}

describe('character folder settings', () => {
    test('fills defaults for missing or broken settings', () => {
        expect(normalizeCharacterFolderSettings(undefined)).toEqual(defaultCharacterFolderSettings());
        expect(normalizeCharacterFolderSettings('nonsense')).toEqual(defaultCharacterFolderSettings());
        const defaults = defaultCharacterFolderSettings();
        expect(defaults.autoSort.enabled).toBe(false);
        expect(defaults.autoSort.folderType).toBe('OPEN');
        expect(defaults.tabs.collapsed).toBe(false);
    });

    test('keeps valid values and drops invalid ones', () => {
        const settings = normalizeCharacterFolderSettings({
            tabs: { collapsed: true, hidden: ['a', 'a', 3, ''] },
            autoSort: { enabled: true, createFolders: false, folderType: 'WEIRD', sources: { chub: 'tag-1', nowhere: 'tag-2', janitorai: 7 } },
            ai: { promptId: 'missing', scope: 'all', allowNewFolders: false, batchSize: 999, customPrompts: [{ id: 'custom-x', name: 'X', prompt: 'Sort by colour' }, { id: 'bad' }] },
        });
        expect(settings.tabs).toEqual({ collapsed: true, hidden: ['a'] });
        expect(settings.autoSort.enabled).toBe(true);
        expect(settings.autoSort.createFolders).toBe(false);
        expect(settings.autoSort.folderType).toBe('OPEN');
        expect(settings.autoSort.sources).toEqual({ chub: 'tag-1' });
        expect(settings.ai.promptId).toBe('genre');
        expect(settings.ai.scope).toBe('all');
        expect(settings.ai.allowNewFolders).toBe(false);
        expect(settings.ai.batchSize).toBe(AI_SORT_BATCH_MAX);
        expect(settings.ai.customPrompts).toEqual([{ id: 'custom-x', name: 'X', prompt: 'Sort by colour' }]);
    });

    test('keeps a saved custom prompt selected', () => {
        const settings = normalizeCharacterFolderSettings({
            ai: { promptId: 'custom-x', customPrompts: [{ id: 'custom-x', name: 'X', prompt: 'Sort by colour' }] },
        });
        expect(settings.ai.promptId).toBe('custom-x');
        expect(resolveAiSortPrompt('custom-x', settings)).toMatchObject({ name: 'X', custom: true, existingOnly: false });
        expect(resolveAiSortPrompt('existing', settings)).toMatchObject({ custom: false, existingOnly: true });
        expect(resolveAiSortPrompt('gone', settings)).toBeNull();
    });
});

describe('import source detection', () => {
    test.each([
        ['https://janitorai.com/characters/abc_character-aria', 'janitorai'],
        ['https://www.janitorai.com/characters/abc', 'janitorai'],
        ['https://jani.com/characters/abc', 'janitorai'],
        ['https://janitorai.mirror.example/characters/abc', 'janitorai'],
        ['https://jannyai.com/characters/abc', 'jannyai'],
        ['https://chub.ai/characters/someone/rho', 'chub'],
        ['https://www.characterhub.org/characters/someone/rho', 'chub'],
        ['https://realm.risuai.net/character/123', 'risurealm'],
        ['https://pygmalion.chat/character/123', 'pygmalion'],
        ['https://perchance.org/ai-character-chat', 'perchance'],
        ['https://app.wyvern.chat/characters/1', 'wyvern'],
        ['https://character-tavern.com/character/a/b', 'charactertavern'],
        ['https://example.com/card.png', ''],
        ['not a url at all', ''],
        ['', ''],
    ])('%s -> %s', (url, expected) => {
        expect(detectSourceFromUrl(url)).toBe(expected);
    });

    test('does not mistake look-alike hosts for a site', () => {
        expect(detectSourceFromUrl('https://notchub.ai/x')).toBe('');
        expect(detectSourceFromUrl('https://chub.ai.evil.example/x')).toBe('');
    });

    test('prefers the URL, then the site id, then the file name, then the card', () => {
        expect(detectImportSource({ sourceUrl: 'https://chub.ai/characters/a/b', sourceId: 'janitorai' })).toBe('chub');
        expect(detectImportSource({ sourceId: 'JanitorAI', fileName: 'chub-x.png' })).toBe('janitorai');
        expect(detectImportSource({ fileName: 'botbooru-some-card.png' })).toBe('botbooru');
        expect(detectImportSource({ fileName: 'janitorai-url.png' })).toBe('janitorai');
        expect(detectImportSource({ fileName: 'Character.byaf' })).toBe('backyard');
        expect(detectImportSource({ fileName: 'card.png', card: { data: { extensions: { chub: { full_path: 'a/b' } } } } })).toBe('chub');
        expect(detectImportSource({ fileName: 'card.png', card: { data: { extensions: { perchance_data: { x: 1 } } } } })).toBe('perchance');
        expect(detectImportSource({ fileName: 'my-favourite.png', card: { data: { extensions: { chub: '' } } } })).toBe('');
        expect(detectImportSource({})).toBe('');
    });
});

describe('import folder planning', () => {
    const tags = [
        { id: 't-janitor', name: 'JanitorAI', folder_type: 'OPEN' },
        { id: 't-plain', name: 'chub', folder_type: 'NONE' },
        { id: 't-mine', name: 'Imported', folder_type: 'CLOSED' },
    ];

    test('does nothing while auto-sort is off or the site is unknown', () => {
        expect(planImportFolder({ sourceId: 'janitorai', settings: defaultCharacterFolderSettings(), tags })).toEqual({ action: 'none' });
        expect(planImportFolder({ sourceId: '', settings: enabledSettings(), tags })).toEqual({ action: 'none' });
    });

    test('uses the folder chosen for the site first', () => {
        const settings = enabledSettings({ sources: { janitorai: 't-mine' } });
        expect(planImportFolder({ sourceId: 'janitorai', settings, tags })).toEqual({ action: 'existing', tagId: 't-mine', makeFolder: false });
    });

    test('falls back to a tag named after the site, turning a plain tag into a folder', () => {
        expect(planImportFolder({ sourceId: 'janitorai', settings: enabledSettings(), tags })).toEqual({ action: 'existing', tagId: 't-janitor', makeFolder: false });
        expect(planImportFolder({ sourceId: 'chub', settings: enabledSettings(), tags })).toEqual({ action: 'existing', tagId: 't-plain', makeFolder: true });
    });

    test('ignores a chosen folder that was deleted', () => {
        const settings = enabledSettings({ sources: { risurealm: 'deleted-tag' } });
        expect(planImportFolder({ sourceId: 'risurealm', settings, tags })).toEqual({ action: 'create', name: 'RisuRealm' });
    });

    test('creates a site folder only when allowed', () => {
        expect(planImportFolder({ sourceId: 'risurealm', settings: enabledSettings(), tags })).toEqual({ action: 'create', name: 'RisuRealm' });
        expect(planImportFolder({ sourceId: 'risurealm', settings: enabledSettings({ createFolders: false }), tags })).toEqual({ action: 'none' });
    });
});

describe('folder tabs', () => {
    test('lists folders only, counting characters that still exist', () => {
        const tabs = buildFolderTabs({
            tags: [
                { id: 'a', name: 'Fantasy', folder_type: 'OPEN' },
                { id: 'b', name: 'plain', folder_type: 'NONE' },
                { id: 'c', name: 'Sci-fi', folder_type: 'CLOSED' },
                { id: 'd', name: 'Empty', folder_type: 'OPEN' },
            ],
            tagMap: { 'one.png': ['a', 'b', 'a'], 'two.png': ['a', 'c'], 'gone.png': ['c'] },
            entityKeys: ['one.png', 'two.png'],
            hidden: ['d'],
            selected: ['c'],
        });
        expect(tabs).toEqual([
            { id: 'a', name: 'Fantasy', closed: false, count: 2, hidden: false, selected: false },
            { id: 'c', name: 'Sci-fi', closed: true, count: 1, hidden: false, selected: true },
            { id: 'd', name: 'Empty', closed: false, count: 0, hidden: true, selected: false },
        ]);
    });
});

describe('AI sorting', () => {
    test('summarises a card and builds a prompt that names every character', () => {
        const summary = summarizeCharacterForSort({
            name: 'Aria Vale',
            data: { description: 'A  knight\nfrom the north. '.repeat(40), scenario: 'Castle siege', tags: ['fantasy', 'knight'] },
        }, ['knight', 'Favourites']);
        expect(summary.name).toBe('Aria Vale');
        expect(summary.description.length).toBeLessThanOrEqual(400);
        expect(summary.tags).toEqual(['fantasy', 'knight', 'Favourites']);

        const { systemPrompt, prompt } = buildAiSortPrompt({
            instructions: 'Sort by genre.',
            folders: ['Fantasy'],
            characters: [summary, { name: 'Pixel', tags: [] }],
            allowNewFolders: false,
        });
        expect(systemPrompt).toMatch(/only from the existing folders/);
        expect(prompt).toContain('Sorting rule:\nSort by genre.');
        expect(prompt).toContain('Existing folders: Fantasy');
        expect(prompt).toContain('#1 Aria Vale');
        expect(prompt).toContain('#2 Pixel');
    });

    test('reads plain, fenced and chatty JSON replies', () => {
        const options = { count: 3, folders: ['Fantasy', 'Sci-fi'], allowNewFolders: true };
        expect(parseAiSortResponse('{"assignments":[{"id":1,"folder":"fantasy"},{"id":2,"folder":"Horror"}]}', options)).toEqual([
            { index: 0, folder: 'Fantasy', isNew: false },
            { index: 1, folder: 'Horror', isNew: true },
        ]);
        expect(parseAiSortResponse('Sure!\n```json\n[{"id":"#3","folder":"Sci-fi"}]\n```', options)).toEqual([
            { index: 2, folder: 'Sci-fi', isNew: false },
        ]);
        expect(parseAiSortResponse('Here you go: {"assignments":[{"id":2,"folder":"\\"Slice of life.\\""}]} hope it helps', options)).toEqual([
            { index: 1, folder: 'Slice of life', isNew: true },
        ]);
    });

    test('drops bad ids, duplicates and new folders when they are not allowed', () => {
        const reply = JSON.stringify({ assignments: [
            { id: 0, folder: 'Fantasy' },
            { id: 9, folder: 'Fantasy' },
            { id: 1, folder: 'Horror' },
            { id: 1, folder: 'Fantasy' },
            { id: 2, folder: '' },
            'junk',
        ] });
        expect(parseAiSortResponse(reply, { count: 2, folders: ['Fantasy'], allowNewFolders: false })).toEqual([
            { index: 0, folder: 'Fantasy', isNew: false },
        ]);
        expect(parseAiSortResponse('no json here', { count: 2 })).toEqual([]);
    });

    test('cleans folder names', () => {
        expect(cleanFolderName('  **Space   Opera**. ')).toBe('Space Opera');
        expect(cleanFolderName('x'.repeat(80))).toHaveLength(48);
    });

    test('splits work into batches within the allowed size', () => {
        const items = Array.from({ length: 12 }, (_, index) => index);
        expect(chunkForAiSort(items, 5).map(chunk => chunk.length)).toEqual([5, 5, 2]);
        expect(chunkForAiSort(items, 1)[0]).toHaveLength(AI_SORT_BATCH_MIN);
        expect(chunkForAiSort([], 10)).toEqual([]);
    });

    test('merges new folder spellings across batches', () => {
        expect(mergeNewFolderSpellings([
            { index: 0, folder: 'Sci-Fi', isNew: true },
            { index: 1, folder: 'sci-fi', isNew: true },
            { index: 2, folder: 'Fantasy', isNew: false },
        ]).map(item => item.folder)).toEqual(['Sci-Fi', 'Sci-Fi', 'Fantasy']);
    });

    test('gives custom prompts unique ids that never clash with presets', () => {
        expect(createCustomPrompt('Genre', 'x').id).toBe('custom-genre');
        expect(createCustomPrompt('By colour!', 'x', ['custom-by-colour']).id).toBe('custom-by-colour-2');
        expect(createCustomPrompt('', 'x').id).toBe('custom-prompt');
    });
});
