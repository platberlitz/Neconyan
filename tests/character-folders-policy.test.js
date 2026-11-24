import {
    AI_SORT_BATCH_MAX,
    AI_SORT_BATCH_MIN,
    buildAiSortPrompt,
    buildFolderTabs,
    characterFolderListMode,
    chunkForAiSort,
    classifyAiSortError,
    cleanFolderName,
    createCustomPrompt,
    defaultCharacterFolderSettings,
    describeAiSortPlan,
    detectImportSource,
    detectSourceFromUrl,
    mergeNewFolderSpellings,
    normalizeCharacterFolderSettings,
    parseAiSortResponse,
    planImportFolder,
    resolveAiSortPrompt,
    summarizeCharacterForSort,
} from '../public/scripts/neconyan-character-folders-policy.js';

describe('AI sort planning and error messages', () => {
    test('uses the same batch bounds as the runner', () => {
        expect(describeAiSortPlan({ characterCount: 500, batchSize: 25, allowNewFolders: true, existingFolderCount: 0 }))
            .toEqual({ characterCount: 500, batchCount: 20, batchSize: 25, blockedReason: null });
        expect(describeAiSortPlan({ characterCount: 61, batchSize: 80, allowNewFolders: false, existingFolderCount: 1 }))
            .toEqual({ characterCount: 61, batchCount: 2, batchSize: 60, blockedReason: null });
    });

    test('explains when no requests can be made', () => {
        expect(describeAiSortPlan({ characterCount: 0, batchSize: 25, allowNewFolders: true, existingFolderCount: 0 }).blockedReason).toBe('empty_scope');
        expect(describeAiSortPlan({ characterCount: 61, batchSize: 25, allowNewFolders: false, existingFolderCount: 0 }))
            .toEqual({ characterCount: 61, batchCount: 0, batchSize: 25, blockedReason: 'no_folders_allowed' });
    });

    test.each([
        [{ code: 'settings_conflict' }, /reload/i, true],
        [{ code: 'active_settings_ack_required' }, /save your settings/i, true, { settings: true }],
        [{ code: 'settings_save_failed' }, /save your settings/i, true, { settings: true }],
        [new Error('Save the active connection settings before generating a reply.'), /in Connections/, true, { settings: true }],
        [new SyntaxError('Unexpected token < in JSON at position 0'), /could not be read/, false],
        [new Error('Unexpected end of JSON input'), /could not be read/, false],
        [new Error('The provider sent invalid JSON.'), /could not be read/, false],
        [{ code: 'invalid_model_reply', message: 'Save the active connection settings before generating a reply.' }, /could not be read/, false],
        [{ code: 'empty_model_reply', message: 'Save the active connection settings before generating a reply.' }, /empty reply/, false, { empty: true }],
        [{ code: 'no_connection' }, /Connect to a model/, true],
        [{ message: 'The active provider does not have a saved API key.' }, /Check your API key/, true],
        [{ status: 401 }, /Check your API key/, true],
        [{ status: 403 }, /Check your API key/, true],
        [{ status: 429 }, /usage limits/, true],
        [{ code: 'insufficient_quota' }, /usage limits/, true],
        [{ status: 413, code: 'APPLICATION_WORK_CHANGED', message: 'Application storage has no room for another result. Existing records were kept.' }, /Background job storage is full/, true],
        [{ status: 413, code: 'JOB_STORE_FULL', message: 'Background job history is full.' }, /Background job storage is full/, true],
        [{ status: 413, message: 'Request entity too large' }, /Lower 'Characters per request'/, true],
        [{ code: 'context_length_exceeded' }, /Lower 'Characters per request'/, true],
        [new Error('Prompt is too long'), /Lower 'Characters per request'/, true],
        [new TypeError('Failed to fetch'), /internet/, true],
        [{ message: 'The request was cancelled' }, /stopped/i, true],
        [{ name: 'AbortError' }, /stopped/i, true],
        [new Error('Invalid value for reasoning.effort on model "tencent/hy4-flash": "low". Supported values are: none, high.'), /Change Reasoning Effort/, true],
        [{ code: 'UNSUPPORTED_REASONING_EFFORT' }, /Change Reasoning Effort/, true],
        [{ code: 'empty_model_reply' }, /empty reply/, false, { empty: true }],
        [new Error('The model returned an empty reply.'), /empty reply/, false, { empty: true }],
        [new Error('No message generated'), /empty reply/, false, { empty: true }],
        [{ code: 'invalid_model_reply' }, /could not be read/, false],
        [new Error('Non-JSON response'), /could not be read/, false],
        [new Error('Chat completion request error: 502 Bad Gateway'), /provider failed/, false, { failed: true }],
        [{ status: 503 }, /provider failed/, false, { failed: true }],
        [{ message: 'The job is unavailable. Its saved Application record has been retained.', jobState: 'missing' }, /provider failed/, false, { failed: true }],
        [{ message: 'Application work is interrupted. Review it in Jobs before retrying.', jobState: 'interrupted' }, /provider failed/, false, { failed: true }],
    ])('classifies %j without surfacing provider details', (error, message, fatal, extra = {}) => {
        expect(classifyAiSortError(error)).toEqual({ message: expect.stringMatching(message), fatal, ...extra });
    });

    test('strict replies distinguish an empty list from an unreadable reply', () => {
        expect(parseAiSortResponse('{"assignments":[]}', { count: 5, strict: true })).toEqual([]);
        expect(() => parseAiSortResponse('not JSON', { count: 5, strict: true })).toThrow('Could not read the sorting reply');
    });
});

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
        expect(defaults.tabs.enabled).toBe(false);
        expect(defaults.folders).toEqual({ enabled: false });
    });

    test('keeps the folders page and folder tabs as separate opt-in switches', () => {
        expect(normalizeCharacterFolderSettings({ folders: { enabled: true } }).tabs.enabled).toBe(false);
        expect(normalizeCharacterFolderSettings({ tabs: { enabled: true } }).folders.enabled).toBe(false);
        expect(normalizeCharacterFolderSettings({ folders: { enabled: 'yes' }, tabs: { enabled: 1 } }))
            .toMatchObject({ folders: { enabled: false }, tabs: { enabled: false } });
    });

    test.each([
        [{ folders: { enabled: true } }, { bogusFolders: false }, 'none'],
        [{ folders: { enabled: false } }, { bogusFolders: true }, 'none'],
        [{ folders: { enabled: false } }, { bogusFolders: true, folderOpen: true }, 'nested'],
        [{ folders: { enabled: true } }, { bogusFolders: true, folderOpen: true, pageOpen: true }, 'nested'],
        [{ folders: { enabled: true } }, { bogusFolders: true }, 'characters'],
        [{ folders: { enabled: true } }, { bogusFolders: true, pageOpen: true }, 'folders'],
    ])('lists %j with %j as %s', (settings, view, mode) => {
        expect(characterFolderListMode(normalizeCharacterFolderSettings(settings), view)).toBe(mode);
    });

    test('keeps valid values and drops invalid ones', () => {
        const settings = normalizeCharacterFolderSettings({
            tabs: { collapsed: true, hidden: ['a', 'a', 3, ''] },
            autoSort: { enabled: true, createFolders: false, folderType: 'WEIRD', sources: { chub: 'tag-1', nowhere: 'tag-2', janitorai: 7 } },
            ai: { promptId: 'missing', scope: 'all', allowNewFolders: false, batchSize: 999, customPrompts: [{ id: 'custom-x', name: 'X', prompt: 'Sort by colour' }, { id: 'bad' }] },
        });
        expect(settings.tabs).toEqual({ enabled: false, collapsed: true, hidden: ['a'] });
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
