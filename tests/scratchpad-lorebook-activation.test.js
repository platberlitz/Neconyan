import { jest } from '@jest/globals';

const worldInfoState = {
    world_names: [],
    books: new Map(),
    saveCalls: [],
};

const contextState = {
    isCurrent: true,
    characters: [],
};

jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
    get world_names() { return worldInfoState.world_names; },
    updateWorldInfoList: jest.fn(async () => {}),
    loadWorldInfo: jest.fn(async name => worldInfoState.books.get(name) ?? null),
    saveWorldInfo: jest.fn(async (name, data, immediately) => {
        worldInfoState.saveCalls.push({ name, data: structuredClone(data), immediately });
        worldInfoState.books.set(name, structuredClone(data));
        return true;
    }),
    createWorldInfoEntry: jest.fn((_name, data) => {
        const uids = Object.keys(data.entries).map(Number).filter(Number.isFinite);
        const uid = uids.length ? Math.max(...uids) + 1 : 0;
        const entry = {
            uid,
            key: [],
            keysecondary: [],
            comment: '',
            content: '',
            constant: false,
            vectorized: false,
            selective: true,
            selectiveLogic: 0,
            addMemo: true,
            order: 100,
            position: 0,
            disable: false,
            ignoreBudget: false,
            excludeRecursion: false,
            preventRecursion: false,
            delayUntilRecursion: 0,
            probability: 100,
            useProbability: true,
            depth: 4,
            outletName: '',
            group: '',
            groupOverride: false,
            groupWeight: 100,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            role: 0,
            sticky: null,
            cooldown: null,
            delay: null,
        };
        data.entries[uid] = entry;
        return entry;
    }),
    deleteWorldInfoEntry: jest.fn((data, uid) => {
        if (!(uid in data.entries)) return false;
        delete data.entries[uid];
        return true;
    }),
}));

jest.unstable_mockModule('../public/scripts/scratchpad/context.js', () => ({
    isCurrentSource: jest.fn(() => contextState.isCurrent),
    sourceCharacters: jest.fn(() => contextState.characters),
    wireSource: jest.fn(source => source),
}));

jest.unstable_mockModule('../public/script.js', () => ({
    characters: [],
    chat: [],
    chat_metadata: {},
    deleteMessage: jest.fn(),
    extractMessageBias: () => '',
    getOneCharacter: jest.fn(),
    getRequestHeaders: jest.fn(() => ({})),
    getThumbnailUrl: jest.fn(),
    isGenerating: () => false,
    name1: 'User',
    printCharactersDebounced: jest.fn(),
    reloadCurrentChat: jest.fn(async () => {}),
    saveChatConditional: jest.fn(async () => true),
    select_selected_character: jest.fn(),
    syncMesToSwipe: jest.fn(),
    this_chid: 0,
    updateMessageBlock: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/chats.js', () => ({
    hideChatMessageRange: jest.fn(async () => true),
}));

jest.unstable_mockModule('../public/scripts/events.js', () => ({
    event_types: { MESSAGE_EDITED: 'edited', MESSAGE_UPDATED: 'updated' },
    eventSource: { emit: jest.fn() },
}));

jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (parts, ...values) => parts.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
}));

jest.unstable_mockModule('../public/scripts/personas.js', () => ({
    user_avatar: 'user.png',
}));

jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    power_user: { personas: {} },
}));

jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({
    getMessageTimeStamp: () => 'today',
}));

jest.unstable_mockModule('../public/scripts/slash-commands.js', () => ({
    getNameAndAvatarForMessage: () => ({ name: 'Mira' }),
}));

jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({
    getAgentById: jest.fn(() => null),
    saveAgent: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/extensions/css-snippets/src/runtime.js', () => ({
    getSettings: () => ({ snippetList: [] }),
    saveSnippet: jest.fn(),
    hasNoReadableRules: () => false,
    getCtx: () => ({ saveSettingsDebounced: jest.fn() }),
}));

jest.unstable_mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/state.js', () => ({
    characterColors: {},
}));
jest.unstable_mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/palettes.js', () => ({
    getBaseColor: () => '',
}));
jest.unstable_mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/ui.js', () => ({
    applyCharacterBaseColor: jest.fn(),
    maybeAutoRecolorAfterColorChange: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/storage.js', () => ({
    saveData: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/extensions/regex/engine.js', () => ({
    SCRIPT_TYPES: { GLOBAL: 0 },
    getScriptsByType: () => [],
    saveScriptsByType: jest.fn(async () => {}),
    RegexProvider: { instance: { clear() {} } },
}));
jest.unstable_mockModule('../public/scripts/extensions/regex/index.js', () => ({
    loadRegexScripts: jest.fn(async () => {}),
}));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    regexFromString: () => undefined,
}));

jest.unstable_mockModule('../public/scripts/scratchpad/api.js', () => ({
    readMewmoryRecord: jest.fn(),
    correctMewmoryRecord: jest.fn(),
}));

const { normaliseChange } = await import('../public/scripts/scratchpad/proposals.js');
const { prepareChange } = await import('../public/scripts/scratchpad/changes.js');
const {
    LOREBOOK_FIELD_LABELS,
    describeLorebookSettingChanges,
} = await import('../public/scripts/scratchpad/lorebook-fields.js');

const ROLEPLAY_SOURCE = { kind: 'roleplay', avatar: 'mira.png', chatId: 'chat-1' };
const GENERAL_SOURCE = { kind: 'general', sessionId: 'gen-1' };

function sampleEntry(overrides = {}) {
    return {
        uid: 0,
        comment: 'Harbour Beacon',
        key: ['lighthouse'],
        keysecondary: ['fog'],
        content: 'The lighthouse guides ships through fog.',
        constant: false,
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        order: 100,
        position: 0,
        role: 0,
        outletName: '',
        depth: 4,
        scanDepth: 3,
        caseSensitive: true,
        matchWholeWords: false,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: false,
        probability: 80,
        useProbability: true,
        group: 'harbour',
        groupOverride: false,
        groupWeight: 100,
        useGroupScoring: true,
        ignoreBudget: false,
        sticky: 2,
        cooldown: 3,
        delay: 1,
        disable: false,
        agentBlacklisted: false,
        ...overrides,
    };
}

function installBook(name, entries) {
    worldInfoState.world_names.splice(0, worldInfoState.world_names.length, name);
    worldInfoState.saveCalls = [];
    const map = {};
    for (const entry of entries) map[entry.uid] = structuredClone(entry);
    worldInfoState.books.set(name, {
        entries: map,
        originalData: {
            entries: entries.map(entry => ({
                id: entry.uid,
                keys: [...(entry.key || [])],
                secondary_keys: [...(entry.keysecondary || [])],
                comment: entry.comment || '',
                content: entry.content || '',
                constant: Boolean(entry.constant),
                selective: Boolean(entry.selective),
                insertion_order: Number(entry.order ?? 100),
                enabled: !entry.disable,
                extensions: {
                    position: Number(entry.position ?? 0),
                    depth: Number(entry.depth ?? 4),
                    probability: Number(entry.probability ?? 100),
                    useProbability: Boolean(entry.useProbability ?? true),
                    selectiveLogic: Number(entry.selectiveLogic ?? 0),
                    scan_depth: entry.scanDepth ?? null,
                    case_sensitive: entry.caseSensitive ?? null,
                    match_whole_words: entry.matchWholeWords ?? null,
                    use_group_scoring: entry.useGroupScoring ?? null,
                    exclude_recursion: Boolean(entry.excludeRecursion),
                    prevent_recursion: Boolean(entry.preventRecursion),
                    delay_until_recursion: entry.delayUntilRecursion ?? false,
                    group: entry.group || '',
                    group_override: Boolean(entry.groupOverride),
                    group_weight: Number(entry.groupWeight ?? 100),
                    sticky: entry.sticky ?? null,
                    cooldown: entry.cooldown ?? null,
                    delay: entry.delay ?? null,
                    ignore_budget: Boolean(entry.ignoreBudget),
                },
            })),
        },
    });
}

describe('lorebook activation field validation', () => {
    const validCases = [
        ['keys', ['beacon', 'tower'], ['beacon', 'tower']],
        ['keysecondary', ['mist', 'storm'], ['mist', 'storm']],
        ['selective', false, false],
        ['selectiveLogic', 3, 3],
        ['constant', true, true],
        ['probability', 55, 55],
        ['useProbability', false, false],
        ['order', 250, 250],
        ['position', 4, 4],
        ['role', 2, 2],
        ['role', null, null],
        ['outletName', 'harbour_notes', 'harbour_notes'],
        ['depth', 2, 2],
        ['scanDepth', 6, 6],
        ['scanDepth', null, null],
        ['caseSensitive', true, true],
        ['caseSensitive', false, false],
        ['caseSensitive', null, null],
        ['matchWholeWords', true, true],
        ['matchWholeWords', null, null],
        ['excludeRecursion', true, true],
        ['preventRecursion', true, true],
        ['delayUntilRecursion', false, false],
        ['delayUntilRecursion', true, true],
        ['delayUntilRecursion', 0, 0],
        ['delayUntilRecursion', 1, 1],
        ['delayUntilRecursion', 3, 3],
        ['group', 'harbour, coast', 'harbour, coast'],
        ['groupOverride', true, true],
        ['groupWeight', 250, 250],
        ['useGroupScoring', false, false],
        ['useGroupScoring', null, null],
        ['ignoreBudget', true, true],
        ['sticky', 5, 5],
        ['sticky', null, null],
        ['cooldown', 4, 4],
        ['cooldown', null, null],
        ['delay', 3, 3],
        ['delay', null, null],
        ['disable', true, true],
        ['disable', false, false],
    ];

    test.each(validCases)('accepts valid %s = %p', (field, input, expected) => {
        const result = normaliseChange({
            type: 'lorebook',
            action: 'edit',
            book: 'Harbour',
            uid: 0,
            [field]: input,
        });
        expect(result[field]).toEqual(expected);
    });

    const invalidCases = [
        ['keys', 123, /keys.*list of strings|Primary Keywords/i],
        ['keys', ['ok', 42], /keys.*only strings/i],
        ['keysecondary', 'fog, mist', /keysecondary.*list of strings/i],
        ['keysecondary', [true], /keysecondary.*only strings/i],
        ['selective', 'yes', /selective.*true or false/i],
        ['selectiveLogic', 4, /selectiveLogic.*0/i],
        ['selectiveLogic', 'AND ALL', /selectiveLogic/i],
        ['constant', 'true', /constant.*true or false/i],
        ['probability', 101, /probability.*from 0 to 100/i],
        ['probability', -1, /probability.*from 0 to 100/i],
        ['probability', '50', /probability/i],
        ['useProbability', 1, /useProbability.*true or false/i],
        ['order', -5, /order.*from 0 to 9999/i],
        ['order', 10000, /order.*from 0 to 9999/i],
        ['order', 1.5, /order.*whole number/i],
        ['position', 8, /position.*from 0 to 7/i],
        ['position', 'after', /position/i],
        ['role', 3, /role.*0.*1.*2/i],
        ['role', 'system', /role/i],
        ['outletName', 42, /outletName.*text up to 120 characters/i],
        ['depth', -1, /depth.*from 0 to 1000/i],
        ['depth', 1001, /depth.*from 0 to 1000/i],
        ['scanDepth', -1, /scanDepth.*from 0 to 1000/i],
        ['scanDepth', 1001, /scanDepth.*from 0 to 1000/i],
        ['scanDepth', 'global', /scanDepth/i],
        ['caseSensitive', 'yes', /caseSensitive.*true, false, or null/i],
        ['matchWholeWords', 0, /matchWholeWords.*true, false, or null/i],
        ['excludeRecursion', 'no', /excludeRecursion.*true or false/i],
        ['preventRecursion', 1, /preventRecursion.*true or false/i],
        ['delayUntilRecursion', -1, /delayUntilRecursion/i],
        ['delayUntilRecursion', 1001, /delayUntilRecursion/i],
        ['delayUntilRecursion', '2', /delayUntilRecursion/i],
        ['group', ['a'], /group.*text up to 300 characters/i],
        ['groupOverride', 'yes', /groupOverride.*true or false/i],
        ['groupWeight', 0, /groupWeight.*from 1 to 999999/i],
        ['groupWeight', 1_000_000, /groupWeight.*from 1 to 999999/i],
        ['useGroupScoring', 'global', /useGroupScoring.*true, false, or null/i],
        ['ignoreBudget', 1, /ignoreBudget.*true or false/i],
        ['sticky', 0, /sticky.*from 1 to 10000.*null/i],
        ['sticky', 10001, /sticky.*from 1 to 10000/i],
        ['cooldown', 0, /cooldown.*from 1 to 10000.*null/i],
        ['delay', -2, /delay.*from 1 to 10000.*null/i],
        ['disable', 'false', /disable.*true or false/i],
    ];

    test.each(invalidCases)('refuses invalid %s = %p with a plain reason', (field, input, pattern) => {
        expect(() => normaliseChange({
            type: 'lorebook',
            action: 'edit',
            book: 'Harbour',
            uid: 0,
            [field]: input,
        })).toThrow(pattern);
    });

    test('refuses unknown fields including agentBlacklisted on add, edit, and delete', () => {
        expect(() => normaliseChange({
            type: 'lorebook',
            action: 'edit',
            book: 'Harbour',
            uid: 0,
            agentBlacklisted: false,
        })).toThrow(/Unsupported lorebook field.*agentBlacklisted/i);

        expect(() => normaliseChange({
            type: 'lorebook',
            action: 'add',
            book: 'Harbour',
            content: 'Text.',
            bogusFlag: true,
        })).toThrow(/Unsupported lorebook field.*bogusFlag/i);

        expect(() => normaliseChange({
            type: 'lorebook',
            action: 'delete',
            book: 'Harbour',
            uid: 0,
            probability: 50,
        })).toThrow(/Unsupported lorebook field.*probability/i);
    });
});

describe('lorebook activation review plan, saving, staleness, and privacy', () => {
    beforeEach(() => {
        worldInfoState.books.clear();
        worldInfoState.saveCalls = [];
        contextState.isCurrent = true;
    });

    test('shows every changed setting as before -> after in editor labels, omits unchanged ones, and saves back to defaults', async () => {
        installBook('Harbour', [sampleEntry()]);
        const plan = await prepareChange({
            type: 'lorebook',
            action: 'edit',
            book: 'Harbour',
            uid: 0,
            keys: ['lighthouse'], // unchanged — must NOT appear in rows
            keysecondary: ['fog', 'squall'],
            selective: true, // unchanged — must NOT appear in rows
            selectiveLogic: 3,
            constant: true,
            probability: 100,
            useProbability: false,
            order: 55,
            position: 4,
            role: 1,
            depth: 2,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            excludeRecursion: true,
            preventRecursion: true,
            delayUntilRecursion: 2,
            group: 'harbour, sea',
            groupOverride: true,
            groupWeight: 250,
            useGroupScoring: null,
            ignoreBudget: true,
            sticky: null,
            cooldown: null,
            delay: null,
        }, ROLEPLAY_SOURCE);

        expect(plan.editable).toBe(false);
        expect(plan.hideTextDiff).toBe(true);

        const byField = new Map(plan.settings.map(row => [row.field, row]));
        expect(byField.has('keys')).toBe(false);
        expect(byField.has('selective')).toBe(false);

        expect(byField.get('keysecondary')).toEqual({
            field: 'keysecondary',
            label: LOREBOOK_FIELD_LABELS.keysecondary,
            before: 'fog',
            after: 'fog, squall',
        });
        expect(byField.get('selectiveLogic')).toMatchObject({ label: 'Logic', before: 'AND ANY', after: 'AND ALL' });
        expect(byField.get('constant')).toMatchObject({ label: 'Constant', before: 'Keyword-triggered', after: 'Always active' });
        expect(byField.get('probability')).toMatchObject({ label: 'Trigger probability', before: '80%', after: '100%' });
        expect(byField.get('useProbability')).toMatchObject({ label: 'Use Probability', before: 'Yes', after: 'No' });
        expect(byField.get('order')).toMatchObject({ label: 'Order', before: '100', after: '55' });
        expect(byField.get('position')).toMatchObject({ label: 'Position', before: 'Before Char Defs', after: 'At Depth' });
        expect(byField.get('role')).toMatchObject({ label: 'Role', before: 'System', after: 'User' });
        expect(byField.get('depth')).toMatchObject({ label: 'Depth', before: '4', after: '2' });
        expect(byField.get('scanDepth')).toMatchObject({ label: 'Scan Depth', before: '3', after: 'Use global setting' });
        expect(byField.get('caseSensitive')).toMatchObject({ label: 'Case-Sensitive', before: 'Yes', after: 'Use global' });
        expect(byField.get('matchWholeWords')).toMatchObject({ label: 'Whole Words', before: 'No', after: 'Use global' });
        expect(byField.get('excludeRecursion')).toMatchObject({ label: 'Non-recursable', before: 'No', after: 'Yes' });
        expect(byField.get('preventRecursion')).toMatchObject({ label: 'Prevent further recursion', before: 'No', after: 'Yes' });
        expect(byField.get('delayUntilRecursion')).toMatchObject({ label: 'Delay until recursion', before: 'Off', after: 'Level 2' });
        expect(byField.get('group')).toMatchObject({ label: 'Inclusion Group', before: 'harbour', after: 'harbour, sea' });
        expect(byField.get('groupOverride')).toMatchObject({ label: 'Prioritize', before: 'No', after: 'Yes' });
        expect(byField.get('groupWeight')).toMatchObject({ label: 'Group Weight', before: '100', after: '250' });
        expect(byField.get('useGroupScoring')).toMatchObject({ label: 'Group Scoring', before: 'Yes', after: 'Use global' });
        expect(byField.get('ignoreBudget')).toMatchObject({ label: 'Ignore budget', before: 'No', after: 'Yes' });
        expect(byField.get('sticky')).toMatchObject({ label: 'Sticky', before: '2', after: 'Non-sticky' });
        expect(byField.get('cooldown')).toMatchObject({ label: 'Cooldown', before: '3', after: 'No cooldown' });
        expect(byField.get('delay')).toMatchObject({ label: 'Delay', before: '1', after: 'No delay' });

        await plan.commit();

        const saved = worldInfoState.books.get('Harbour').entries[0];
        expect(saved.keysecondary).toEqual(['fog', 'squall']);
        expect(saved.selectiveLogic).toBe(3);
        expect(saved.constant).toBe(true);
        expect(saved.vectorized).toBe(false);
        expect(saved.probability).toBe(100);
        expect(saved.useProbability).toBe(false);
        expect(saved.order).toBe(55);
        expect(saved.position).toBe(4);
        expect(saved.role).toBe(1);
        expect(saved.depth).toBe(2);
        expect(saved.scanDepth).toBeNull();
        expect(saved.caseSensitive).toBeNull();
        expect(saved.matchWholeWords).toBeNull();
        expect(saved.excludeRecursion).toBe(true);
        expect(saved.preventRecursion).toBe(true);
        expect(saved.delayUntilRecursion).toBe(2);
        expect(saved.group).toBe('harbour, sea');
        expect(saved.groupOverride).toBe(true);
        expect(saved.groupWeight).toBe(250);
        expect(saved.useGroupScoring).toBeNull();
        expect(saved.ignoreBudget).toBe(true);
        expect(saved.sticky).toBeNull();
        expect(saved.cooldown).toBeNull();
        expect(saved.delay).toBeNull();
        expect(saved.content).toBe('The lighthouse guides ships through fog.');
    });

    test('refuses pure activation edit when no proposed setting actually differs', async () => {
        installBook('Harbour', [sampleEntry()]);
        await expect(prepareChange({
            type: 'lorebook',
            action: 'edit',
            book: 'Harbour',
            uid: 0,
            probability: 80,
            scanDepth: 3,
        }, ROLEPLAY_SOURCE)).rejects.toThrow(/already has those settings/i);
    });

    test('detects staleness when an activation setting changed since the review card was opened', async () => {
        installBook('Harbour', [sampleEntry()]);
        const plan = await prepareChange({
            type: 'lorebook',
            action: 'edit',
            book: 'Harbour',
            uid: 0,
            probability: 100,
        }, ROLEPLAY_SOURCE);

        worldInfoState.books.get('Harbour').entries[0].scanDepth = 9;
        await expect(plan.commit()).rejects.toThrow(/changed while the review was open/i);
        expect(worldInfoState.saveCalls).toHaveLength(0);
    });

    test('add supports activation settings, shows non-default ones, and stores them on the created entry', async () => {
        installBook('Harbour', [sampleEntry()]);
        const plan = await prepareChange({
            type: 'lorebook',
            action: 'add',
            book: 'Harbour',
            title: 'Bell Buoy',
            keys: ['buoy'],
            keysecondary: ['harbour'],
            selectiveLogic: 3,
            content: 'The bell buoy rings in heavy swell.',
            probability: 75,
            scanDepth: 6,
            caseSensitive: true,
            sticky: 3,
            position: 4,
            depth: 2,
            role: 0,
        }, ROLEPLAY_SOURCE);

        expect(plan.editable).toBe(true);
        const byField = new Map(plan.settings.map(row => [row.field, row]));
        expect(byField.get('keysecondary')).toMatchObject({ before: 'None', after: 'harbour' });
        expect(byField.get('selectiveLogic')).toMatchObject({ before: 'AND ANY', after: 'AND ALL' });
        expect(byField.get('probability')).toMatchObject({ before: '100%', after: '75%' });
        expect(byField.get('scanDepth')).toMatchObject({ before: 'Use global setting', after: '6' });
        expect(byField.get('caseSensitive')).toMatchObject({ before: 'Use global', after: 'Yes' });
        expect(byField.get('sticky')).toMatchObject({ before: 'Non-sticky', after: '3' });
        expect(byField.get('position')).toMatchObject({ before: 'Before Char Defs', after: 'At Depth' });
        expect(byField.get('depth')).toMatchObject({ before: '4', after: '2' });

        await plan.commit(plan.after);
        const created = worldInfoState.books.get('Harbour').entries[1];
        expect(created.comment).toBe('Bell Buoy');
        expect(created.key).toEqual(['buoy']);
        expect(created.keysecondary).toEqual(['harbour']);
        expect(created.selectiveLogic).toBe(3);
        expect(created.probability).toBe(75);
        expect(created.scanDepth).toBe(6);
        expect(created.caseSensitive).toBe(true);
        expect(created.sticky).toBe(3);
        expect(created.position).toBe(4);
        expect(created.depth).toBe(2);
    });

    test('never edits, enables, or reveals any setting of an entry hidden from Agents', async () => {
        installBook('Harbour', [sampleEntry({
            uid: 5,
            comment: 'VaultSecretTitle',
            key: ['vaultkey'],
            content: 'VaultSecretBody',
            disable: true,
            probability: 12,
            agentBlacklisted: true,
        })]);

        let error;
        try {
            await prepareChange({
                type: 'lorebook',
                action: 'edit',
                book: 'Harbour',
                uid: 5,
                disable: false,
                probability: 100,
            }, ROLEPLAY_SOURCE, { disabledEntriesListed: true });
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeDefined();
        expect(error.message).toMatch(/hidden from assistants/i);
        expect(error.message).not.toMatch(/VaultSecretTitle|vaultkey|VaultSecretBody|12/i);
    });

    test('disabled entries can be enabled only when listed, and never allow editing unseen content', async () => {
        installBook('Harbour', [sampleEntry({
            uid: 2,
            comment: 'Dormant Entry',
            content: 'UnsharedSecretDisabledBody',
            disable: true,
            probability: 20,
        })]);

        // Refused when Problem checks did not list disabled entries
        await expect(prepareChange({
            type: 'lorebook',
            action: 'edit',
            book: 'Harbour',
            uid: 2,
            disable: false,
        }, ROLEPLAY_SOURCE, { disabledEntriesListed: false })).rejects.toThrow(/disabled/i);

        // Refused if trying to change settings while keeping it disabled
        await expect(prepareChange({
            type: 'lorebook',
            action: 'edit',
            book: 'Harbour',
            uid: 2,
            probability: 100,
        }, ROLEPLAY_SOURCE, { disabledEntriesListed: true })).rejects.toThrow(/set disable to false/i);

        // Refused if trying to edit unshared content while disabled, without revealing content
        let contentErr;
        try {
            await prepareChange({
                type: 'lorebook',
                action: 'edit',
                book: 'Harbour',
                uid: 2,
                disable: false,
                content: 'Overwrite it.',
            }, ROLEPLAY_SOURCE, { disabledEntriesListed: true });
        } catch (caught) {
            contentErr = caught;
        }
        expect(contentErr.message).toMatch(/will not edit their text while disabled/i);
        expect(contentErr.message).not.toContain('UnsharedSecretDisabledBody');

        // Allowed when listed and enabling without editing content; disabled content never enters plan
        const plan = await prepareChange({
            type: 'lorebook',
            action: 'edit',
            book: 'Harbour',
            uid: 2,
            disable: false,
            probability: 100,
        }, ROLEPLAY_SOURCE, { disabledEntriesListed: true });
        expect(plan.editable).toBe(false);
        expect(plan.hideTextDiff).toBe(true);
        expect(plan.before).not.toContain('UnsharedSecretDisabledBody');
        expect(plan.after).not.toContain('UnsharedSecretDisabledBody');
        expect(plan.settings).toEqual([
            { field: 'probability', label: 'Trigger probability', before: '20%', after: '100%' },
            { field: 'disable', label: 'Status', before: 'Disabled', after: 'Enabled' },
        ]);

        await plan.commit();
        const saved = worldInfoState.books.get('Harbour').entries[2];
        expect(saved.disable).toBe(false);
        expect(saved.probability).toBe(100);
        expect(saved.content).toBe('UnsharedSecretDisabledBody');
    });

    test('General Scratchpad keeps the hand-picked book guard for activation edits', async () => {
        installBook('Harbour', [sampleEntry()]);
        await expect(prepareChange({
            type: 'lorebook',
            action: 'edit',
            book: 'Harbour',
            uid: 0,
            probability: 100,
        }, GENERAL_SOURCE, { sharedLorebook: 'OtherBook' })).rejects.toThrow(/Share that lorebook under Context/i);

        const plan = await prepareChange({
            type: 'lorebook',
            action: 'edit',
            book: 'Harbour',
            uid: 0,
            probability: 100,
        }, GENERAL_SOURCE, { sharedLorebook: 'Harbour' });
        await plan.commit();
        expect(worldInfoState.books.get('Harbour').entries[0].probability).toBe(100);
    });

    test('describeLorebookSettingChanges treats delayUntilRecursion 0 and false as equivalent', () => {
        const rows = describeLorebookSettingChanges({ delayUntilRecursion: 0 }, { delayUntilRecursion: false });
        expect(rows).toEqual([]);
        const level1 = describeLorebookSettingChanges({ delayUntilRecursion: true }, { delayUntilRecursion: 1 });
        expect(level1).toEqual([]);
        const level2 = describeLorebookSettingChanges({ delayUntilRecursion: 0 }, { delayUntilRecursion: 2 });
        expect(level2).toEqual([{ field: 'delayUntilRecursion', label: 'Delay until recursion', before: 'Off', after: 'Level 2' }]);
    });
});
