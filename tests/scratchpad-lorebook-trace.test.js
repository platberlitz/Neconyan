import { jest } from '@jest/globals';

const worldInfoState = {
    books: new Map(),
    selected: [],
    world_info: { charLore: [] },
    world_names: [],
    depth: 2,
    budget: 25,
    budgetCap: 0,
    recursive: true,
    maxRecursionSteps: 3,
    caseSensitive: false,
    matchWholeWords: false,
};

const scriptState = {
    characters: [],
    chat: [],
    chat_metadata: {},
    this_chid: 0,
    name1: 'You',
    chatId: 'chat-trace-1',
};

jest.unstable_mockModule('../public/script.js', () => ({
    get characters() { return scriptState.characters; },
    get chat() { return scriptState.chat; },
    get chat_metadata() { return scriptState.chat_metadata; },
    get this_chid() { return scriptState.this_chid; },
    get name1() { return scriptState.name1; },
    getCurrentChatId: jest.fn(() => scriptState.chatId),
    substituteParams: jest.fn((value, user = scriptState.name1, char = scriptState.characters[scriptState.this_chid]?.name || '') =>
        String(value ?? '').replace(/\{\{user\}\}/gi, user).replace(/\{\{char\}\}/gi, char)),
    unshallowCharacter: jest.fn(async () => {}),
}));

jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
    loadWorldInfo: jest.fn(async name => worldInfoState.books.get(name) ?? null),
    get selected_world_info() { return worldInfoState.selected; },
    get world_info() { return worldInfoState.world_info; },
    get world_names() { return worldInfoState.world_names; },
    get world_info_depth() { return worldInfoState.depth; },
    get world_info_budget() { return worldInfoState.budget; },
    get world_info_budget_cap() { return worldInfoState.budgetCap; },
    get world_info_recursive() { return worldInfoState.recursive; },
    get world_info_max_recursion_steps() { return worldInfoState.maxRecursionSteps; },
    get world_info_case_sensitive() { return worldInfoState.caseSensitive; },
    get world_info_match_whole_words() { return worldInfoState.matchWholeWords; },
}));

jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (parts, ...values) => parts.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
}));

jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({
    getTokenCountAsync: jest.fn(async text => Math.ceil(String(text ?? '').length / 4)),
}));

jest.unstable_mockModule('../public/scripts/scratchpad/preset.js', () => ({
    readCurrentPreset: jest.fn(() => null),
    currentLimits: jest.fn(() => ({ maxContext: 2048, maxResponse: 256 })),
    currentPresetName: jest.fn(() => ''),
}));

jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    power_user: { persona_description: '', persona_descriptions: {}, default_persona: '' },
}));

jest.unstable_mockModule('../public/scripts/personas.js', () => ({
    user_avatar: '',
}));

jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
    getGroupMembers: () => [],
    groups: [],
    selected_group: null,
}));

jest.unstable_mockModule('../public/scripts/neconyan-assistant-knowledge.js', () => ({
    buildAssistantKnowledge: async () => ({}),
}));

jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({
    getActiveConversationBranch: () => null,
    getConversationGroupById: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationThreadKey: () => '',
    getCurrentCharAvatar: () => '',
    getConversationPersonaId: () => '',
}));

jest.unstable_mockModule('../public/scripts/neconyan-conversation/personas.js', () => ({
    composeConversationPersonaDescription: () => '',
    getConversationPersonaName: () => '',
}));

jest.unstable_mockModule('../public/scripts/neconyan-conversation/settings-store.js', () => ({
    getSettings: () => ({}),
}));

jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({
    conversationState: { conversationWorkspaceOpen: false },
}));

jest.unstable_mockModule('../public/scripts/roleplay-save-chain.js', () => ({
    getRoleplaySourceId: jest.fn(() => null),
}));

jest.unstable_mockModule('../public/scripts/macros/engine/MacroRegistry.js', () => ({
    MacroRegistry: { getAllMacros: () => { throw new Error('The registry is unavailable in this test.'); } },
}));

const { traceLorebooks, formatLorebookTrace } = await import('../public/scripts/scratchpad/checks/lorebook-trace.js');
const homeState = { visible: false };
global.document = {
    getElementById: () => ({ hidden: !homeState.visible }),
};
const { buildContext, currentSource } = await import('../public/scripts/scratchpad/context.js');
const { prepareWorldInfoEntries } = await import('../public/scripts/world-info-scan-core.js');

function entry(uid, overrides = {}) {
    return {
        uid,
        comment: `Entry ${uid}`,
        key: [],
        keysecondary: [],
        content: `Lore body ${uid}.`,
        constant: false,
        selective: true,
        selectiveLogic: 0,
        order: 100,
        position: 0,
        depth: 4,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: 0,
        probability: 100,
        useProbability: true,
        group: '',
        groupOverride: false,
        groupWeight: 100,
        useGroupScoring: null,
        ignoreBudget: false,
        sticky: null,
        cooldown: null,
        delay: null,
        triggers: [],
        characterFilter: null,
        disable: false,
        agentBlacklisted: false,
        ...overrides,
    };
}

describe('lorebook activation trace reasons', () => {
    test('reports concrete reason for every non-activation case and cautious phrasing for random / chat-state rules', async () => {
        const cooldownContent = 'Cooldown lore body.';
        const stickyWinnerContent = 'Sticky winner body.';
        const bookEntries = {
            0: entry(0, { comment: 'Triggered Torch', key: ['harbour'], content: 'Harbour mentions lantern.' }),
            1: entry(1, { comment: 'Disabled One', key: ['harbour'], disable: true, content: 'DisabledSecretText' }),
            2: entry(2, { comment: 'Missing Key', key: ['volcano', 'crater'] }),
            3: entry(3, { comment: 'Secondary Fail', key: ['harbour'], keysecondary: ['storm', 'gale'], selective: true, selectiveLogic: 3 }),
            4: entry(4, { comment: 'Zero Chance', key: ['harbour'], probability: 0, useProbability: true }),
            5: entry(5, { comment: 'Half Chance', key: ['harbour'], probability: 40, useProbability: true }),
            6: entry(6, { comment: 'Delayed Entry', key: ['harbour'], delay: 10 }),
            7: entry(7, { comment: 'Cooling Entry', key: ['harbour'], cooldown: 5, content: cooldownContent }),
            8: entry(8, { comment: 'Not Sticky Yet', key: ['nevermatches'], sticky: 4 }),
            9: entry(9, { comment: 'Group Winner', key: ['harbour'], group: 'dock', groupOverride: true, order: 200 }),
            10: entry(10, { comment: 'Group Loser', key: ['harbour'], group: 'dock', groupOverride: false, order: 50 }),
            11: entry(11, { comment: 'Sticky Winner', key: ['never'], group: 'pier', sticky: 5, content: stickyWinnerContent }),
            12: entry(12, { comment: 'Non Sticky Loser', key: ['harbour'], group: 'pier' }),
            13: entry(13, { comment: 'Char Filtered', key: ['harbour'], characterFilter: { isExclude: false, names: ['other.png'], tags: [] } }),
            14: entry(14, { comment: 'Trigger Filtered', key: ['harbour'], triggers: ['impersonate'] }),
            15: entry(15, { comment: 'Excluded Recursion', key: ['lantern'], excludeRecursion: true }),
            16: entry(16, { comment: 'Waiting Recursion', key: ['harbour'], delayUntilRecursion: 3 }),
            17: entry(17, { comment: 'Short Depth', key: ['antique'], scanDepth: 1 }),
            18: entry(18, { comment: 'Level One Gate', key: ['never_hits_level_one'], delayUntilRecursion: 1 }),
        };

        const preparedEntries = prepareWorldInfoEntries(
            { globalLore: Object.values(bookEntries).map(item => ({ uid: item.uid, world: 'Harbour', ...structuredClone(item) })) },
            0,
        );
        const hashOf = uid => preparedEntries.find(item => item.uid === uid).hash;
        const chatMetadata = {
            timedWorldInfo: {
                cooldown: { 'Harbour.7': { hash: hashOf(7), start: 1, end: 8, protected: false } },
                sticky: { 'Harbour.11': { hash: hashOf(11), start: 1, end: 8, protected: false } },
            },
        };

        // Messages are newest first: depth 1 has 'harbour', depth 3 has 'antique'
        const messages = [
            'You: The harbour is quiet tonight.',
            'Mira: Just the waves.',
            'You: Remember that antique compass?',
        ];

        const trace = await traceLorebooks({
            books: [{ name: 'Harbour', source: 'global', raw: { entries: bookEntries } }],
            messages,
            settings: { depth: 2, budgetPercent: 50, budgetCap: 1000, recursive: true, maxRecursionSteps: 2 },
            maxContext: 2000,
            character: { filename: 'mira.png', tags: [], tagsAvailable: true },
            chatMetadata,
            chatLength: 3,
            hasChatState: true,
            hasChatMessages: true,
            trigger: 'normal',
            tokenCount: text => Math.ceil(String(text ?? '').length / 4),
            seed: 1,
        });

        const byUid = new Map(trace.notActivated.map(item => [item.uid, item.reason]));
        const activatedUids = new Set(trace.activated.map(item => item.uid));

        expect(activatedUids.has(0)).toBe(true);
        expect(activatedUids.has(9)).toBe(true);
        expect(activatedUids.has(11)).toBe(true);

        expect(byUid.get(1)).toBe('disabled');
        expect(byUid.get(2)).toMatch(/no primary key matched.*volcano, crater/i);
        expect(byUid.get(3)).toMatch(/primary key "harbour" matched.*AND ALL failed.*storm, gale/i);
        expect(byUid.get(4)).toMatch(/probability is 0%/i);
        // Half Chance either activated with a cautious caveat OR failed with a cautious 'may' reason
        const halfNote = activatedUids.has(5)
            ? trace.activated.find(item => item.uid === 5).caveats.join(' ')
            : byUid.get(5);
        expect(halfNote).toMatch(/may.*40%.*random/i);
        expect(byUid.get(6)).toMatch(/blocked by delay.*10 messages.*chat has 3/i);
        expect(byUid.get(7)).toMatch(/blocked by cooldown.*5 messages/i);
        expect(byUid.get(8)).toMatch(/no primary key matched.*not yet sticky/i);
        expect(byUid.get(10)).toMatch(/lost in inclusion group "dock".*Group Winner/i);
        expect(byUid.get(12)).toMatch(/lost in inclusion group "pier".*Sticky Winner.*not yet sticky/i);
        expect(byUid.get(13)).toMatch(/filtered by character.*other\.png/i);
        expect(byUid.get(14)).toMatch(/filtered by generation type.*impersonate/i);
        expect(byUid.get(15)).toMatch(/excluded from recursion.*lantern/i);
        expect(byUid.get(16)).toMatch(/waiting for recursion/i);
        expect(byUid.get(17)).toMatch(/scan depth too short.*1 message.*antique.*message depth 3/i);

        // Separate budget-cutoff check (budget overflow stops recursion by design)
        const budgetTrace = await traceLorebooks({
            books: [{
                name: 'BudgetBook',
                source: 'global',
                raw: {
                    entries: {
                        0: entry(0, { comment: 'Fits', key: ['harbour'], order: 200, content: 'Short.' }),
                        1: entry(1, { comment: 'Over Budget', key: ['harbour'], order: 100, content: 'x'.repeat(2400) }),
                    },
                },
            }],
            messages,
            settings: { depth: 2, budgetPercent: 10, budgetCap: 200, recursive: false },
            maxContext: 2000,
            hasChatMessages: true,
            tokenCount: text => Math.ceil(String(text ?? '').length / 4),
        });
        expect(budgetTrace.notActivated.find(item => item.uid === 1)?.reason).toMatch(/cut by token budget.*200 tokens/i);

        // Disabled content never leaks anywhere in formatted trace
        const formatted = formatLorebookTrace(trace);
        expect(formatted).not.toContain('DisabledSecretText');
    });

    test('caps lines and characters and reports how many lines were omitted', async () => {
        const entries = {};
        for (let i = 0; i < 20; i++) {
            entries[i] = entry(i, { comment: `Miss ${i}`, key: [`missing_${i}`] });
        }
        const trace = await traceLorebooks({
            books: [{ name: 'BigBook', source: 'global', raw: { entries } }],
            messages: ['Nothing matches here.'],
            settings: { depth: 2 },
            hasChatMessages: true,
        });
        const formatted = formatLorebookTrace(trace, { maxLines: 6, maxChars: 2000 });
        expect(formatted).toMatch(/omitted to fit the shared limit/i);
        expect(formatted.split('\n').length).toBeLessThanOrEqual(7);
    });
});

describe('Scratchpad context integration, privacy, and General isolation', () => {
    beforeEach(() => {
        global.document = {
            body: {
                classList: {
                    contains: name => name === 'neconyan-home-visible' && homeState.visible,
                },
            },
        };
        worldInfoState.books.clear();
        worldInfoState.selected.splice(0, worldInfoState.selected.length, 'Harbour');
        worldInfoState.world_names.splice(0, worldInfoState.world_names.length, 'Harbour');
        worldInfoState.depth = 2;
        worldInfoState.recursive = true;
        scriptState.characters.splice(0, scriptState.characters.length, {
            avatar: 'mira.png',
            name: 'Mira',
            description: 'Keeper of the tower.',
            personality: '',
            scenario: '',
            data: { extensions: { world: 'Harbour' } },
        });
        scriptState.chat.splice(0, scriptState.chat.length,
            { name: 'You', is_user: true, mes: 'Remember the antique bell?' },
            { name: 'Mira', is_user: false, mes: 'The waves are calm.' },
            { name: 'You', is_user: true, mes: 'We walk down to the harbour.' },
        );
        for (const key of Object.keys(scriptState.chat_metadata)) delete scriptState.chat_metadata[key];
    });

    test('hidden entries (agentBlacklisted) never leak title, keys, or content into trace or context in Roleplay or General', async () => {
        const book = {
            entries: {
                0: entry(0, { comment: 'Public Beacon', key: ['harbour'], content: 'The tower light burns bright.' }),
                1: entry(1, { comment: 'Unmatched Entry', key: ['antique'], scanDepth: 1, content: 'Old brass bell.' }),
                2: entry(2, { comment: 'Disabled Entry', key: ['harbour'], disable: true, content: 'NeverShareDisabledBody' }),
                3: entry(3, {
                    comment: 'SecretVaultHeading',
                    key: ['harbour', 'SecretTriggerWord'],
                    content: 'SecretHiddenLoreContent',
                    probability: 0,
                    scanDepth: 0,
                    agentBlacklisted: true,
                }),
            },
        };
        worldInfoState.books.set('Harbour', book);

        homeState.visible = false;
        const roleplay = await buildContext({
            source: currentSource(),
            settings: { include: { lore: true, problems: true, card: false, chat: true, preset: false } },
            pendingText: 'Why did my entry not trigger?',
            sessionText: '',
        });

        expect(roleplay.text).toContain('## Lorebook activation trace');
        expect(roleplay.text).toContain('scan depth too short');
        expect(roleplay.text).toContain('1 entry is hidden from Agents and was not shared.');
        expect(roleplay.text).not.toMatch(/secretvaultheading|secrettriggerword|secrethiddenlorecontent/i);
        expect(roleplay.text).not.toContain('NeverShareDisabledBody');
        // Unmatched entry is explained in the trace and not duplicated as 'reason: no keyword matched' in Lorebook details
        expect(roleplay.text).not.toContain('reason: no keyword matched');

        homeState.visible = true;
        const general = await buildContext({
            source: currentSource(),
            settings: {
                lorebook: 'Harbour',
                include: { lore: true, problems: true, card: false, chat: false, preset: false },
            },
            pendingText: 'Let us inspect harbour and {{user}}.',
            sessionText: '',
        });

        expect(general.text).toContain('## Lorebook activation trace');
        expect(general.text).toContain('no open chat');
        expect(general.text).toContain('1 entry is hidden from Agents and was not shared.');
        expect(general.text).not.toMatch(/secretvaultheading|secrettriggerword|secrethiddenlorecontent/i);
        expect(general.text).not.toContain('NeverShareDisabledBody');
        // General has no chat: Roleplay messages and character must not leak into General trace!
        expect(general.text).not.toContain('scan depth too short');
        expect(general.text).not.toContain('Mira');
    });

    test('General Scratchpad never expands macros during activation trace', async () => {
        worldInfoState.books.set('Harbour', {
            entries: {
                0: entry(0, { comment: 'Macro Entry', key: ['{{user}}'], content: 'Macro content.' }),
                1: entry(1, { comment: 'User Name Entry', key: ['You'], content: 'Expanded user name content.' }),
            },
        });
        scriptState.name1 = 'You';

        homeState.visible = true;
        const general = await buildContext({
            source: currentSource(),
            settings: {
                lorebook: 'Harbour',
                include: { lore: true, problems: true },
            },
            pendingText: 'Check why {{user}} did not match.',
            sessionText: '',
        });

        // Literal '{{user}}' matches without expansion, while 'You' does NOT match '{{user}}'
        expect(general.text).toMatch(/Would activate \(1\): Macro Entry/);
        expect(general.text).toMatch(/User Name Entry \(uid 1\): no primary key matched/);
    });
});
