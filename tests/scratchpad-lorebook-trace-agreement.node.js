import assert from 'node:assert/strict';
import test from 'node:test';

import { scanWorldInfo } from '../src/generation/world-info-scan.js';
import { traceLorebooks } from '../public/scripts/scratchpad/checks/lorebook-trace.js';
import { prepareWorldInfoEntries } from '../public/scripts/world-info-scan-core.js';

function makeEntry(uid, overrides = {}) {
    return {
        uid,
        world: 'Harbour',
        comment: `Entry ${uid}`,
        key: [],
        keysecondary: [],
        content: `Lore content for entry ${uid}.`,
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

test('lorebook activation trace agrees with real scanWorldInfo across every deterministic activation rule', async () => {
    const cooldownBody = 'Cooling down tavern gossip.';
    const stickyBody = 'Sticky pier lantern stays lit.';
    const entriesList = [
        makeEntry(0, { comment: 'Always On', constant: true, order: 500, content: 'Always present harbour rule.' }),
        makeEntry(1, { comment: 'Primary Match', key: ['harbour'], order: 450, content: 'The harbour mentions secretbell.' }),
        makeEntry(2, { comment: 'Recursive Match', key: ['secretbell'], order: 440, content: 'Secret bell rings recursively.' }),
        makeEntry(3, { comment: 'Delayed Recursion Level 1', key: ['harbour'], delayUntilRecursion: 1, order: 430, content: 'Joins on recursion step 1.' }),
        makeEntry(4, { comment: 'Ignore Budget Rescue', key: ['harbour'], order: 1, ignoreBudget: true, content: 'Small rescue lore.' }),
        makeEntry(5, { comment: 'Disabled Entry', key: ['harbour'], disable: true }),
        makeEntry(6, { comment: 'No Key Match', key: ['volcano', 'lava'] }),
        makeEntry(7, { comment: 'Secondary Logic Fail', key: ['harbour'], keysecondary: ['storm', 'gale'], selective: true, selectiveLogic: 3 }),
        makeEntry(8, { comment: 'Zero Probability', key: ['harbour'], probability: 0, useProbability: true }),
        makeEntry(9, { comment: 'Delayed By Chat Length', key: ['harbour'], delay: 10 }),
        makeEntry(10, { comment: 'Cooling Down', key: ['harbour'], cooldown: 5, content: cooldownBody }),
        makeEntry(11, { comment: 'Group Override Winner', key: ['harbour'], group: 'docks', groupOverride: true, order: 420 }),
        makeEntry(12, { comment: 'Group Override Loser', key: ['harbour'], group: 'docks', groupOverride: false, order: 410 }),
        makeEntry(13, { comment: 'Sticky Group Winner', key: ['never'], group: 'pier', sticky: 5, order: 400, content: stickyBody }),
        makeEntry(14, { comment: 'Non Sticky Group Loser', key: ['harbour'], group: 'pier', order: 390 }),
        makeEntry(15, { comment: 'Character Filtered Out', key: ['harbour'], characterFilter: { isExclude: false, names: ['other.png'], tags: [] } }),
        makeEntry(16, { comment: 'Tag Filtered Out', key: ['harbour'], characterFilter: { isExclude: true, names: [], tags: ['tag-maritime'] } }),
        makeEntry(17, { comment: 'Trigger Filtered Out', key: ['harbour'], triggers: ['swipe'] }),
        makeEntry(18, { comment: 'Excluded From Recursion', key: ['secretbell'], excludeRecursion: true }),
        makeEntry(19, { comment: 'Waiting For Higher Recursion', key: ['harbour'], delayUntilRecursion: 5 }),
        makeEntry(20, { comment: 'Short Scan Depth', key: ['antique'], scanDepth: 1 }),
    ];

    // Newest message first (index 0 = depth 1, index 2 = depth 3)
    const messages = [
        'You: We reach the harbour at dusk.',
        'Mira: Keep your coat closed.',
        'You: Remember the antique bell?',
    ];

    // 1. Run the real Neconyan activation scan loop (`src/generation/world-info-scan.js`)
    const preparedRealEntries = prepareWorldInfoEntries(
        { globalLore: entriesList.map(item => structuredClone(item)) },
        0,
    );
    const hashOf = uid => preparedRealEntries.find(item => item.uid === uid).hash;
    const chatMetadata = {
        timedWorldInfo: {
            cooldown: { 'Harbour.10': { hash: hashOf(10), start: 1, end: 8, protected: false } },
            sticky: { 'Harbour.13': { hash: hashOf(13), start: 1, end: 8, protected: false } },
        },
    };

    const countTokens = text => Math.ceil(String(text ?? '').length / 4);
    const maxContext = 4000;
    const budgetCap = 1000;

    const realResult = await scanWorldInfo({
        entries: preparedRealEntries,
        chat: [...messages],
        chatLength: messages.length,
        metadata: structuredClone(chatMetadata),
        settings: {
            world_info_depth: 2,
            world_info_budget: 25,
            world_info_budget_cap: budgetCap,
            world_info_min_activations: 0,
            world_info_min_activations_depth_max: 0,
            world_info_recursive: true,
            world_info_max_recursion_steps: 2,
            world_info_case_sensitive: false,
            world_info_match_whole_words: false,
            world_info_use_group_scoring: false,
            world_info_overflow_alert: false,
        },
        global: {
            trigger: 'normal',
            characterFile: 'mira.png',
            characterTags: ['tag-maritime'],
        },
        maxContext,
        countTokens: async text => countTokens(text),
        substitute: value => String(value ?? ''),
        random: () => 0.5,
    });

    // 2. Run Scratchpad's activation trace (`public/scripts/scratchpad/checks/lorebook-trace.js`)
    const entriesMap = Object.fromEntries(entriesList.map(item => [item.uid, structuredClone(item)]));
    const traceResult = await traceLorebooks({
        books: [{ name: 'Harbour', source: 'global', raw: { entries: entriesMap } }],
        messages: [...messages],
        settings: {
            depth: 2,
            budgetPercent: 25,
            budgetCap,
            recursive: true,
            maxRecursionSteps: 2,
            caseSensitive: false,
            matchWholeWords: false,
            useGroupScoring: false,
        },
        maxContext,
        character: { filename: 'mira.png', tags: ['tag-maritime'], tagsAvailable: true },
        chatMetadata: structuredClone(chatMetadata),
        chatLength: messages.length,
        hasChatState: true,
        hasChatMessages: true,
        trigger: 'normal',
        expand: value => String(value ?? ''),
        tokenCount: countTokens,
        seed: 1,
    });

    const realActivatedUids = realResult.activated.map(item => item.uid).sort((a, b) => a - b);
    const traceActivatedUids = traceResult.activated.map(item => item.uid).sort((a, b) => a - b);

    // Proof: exact same activated set as the real app code path!
    assert.deepStrictEqual(traceActivatedUids, realActivatedUids);
    assert.deepStrictEqual(traceActivatedUids, [0, 1, 2, 3, 4, 11, 13]);

    const reasonByUid = new Map(traceResult.notActivated.map(item => [item.uid, item.reason]));
    assert.equal(reasonByUid.get(5), 'disabled');
    assert.match(reasonByUid.get(6), /no primary key matched.*volcano, lava/i);
    assert.match(reasonByUid.get(7), /primary key "harbour" matched.*AND ALL failed.*storm, gale/i);
    assert.match(reasonByUid.get(8), /probability is 0%/i);
    assert.match(reasonByUid.get(9), /blocked by delay.*10 messages.*chat has 3/i);
    assert.match(reasonByUid.get(10), /blocked by cooldown.*5 messages/i);
    assert.match(reasonByUid.get(12), /lost in inclusion group "docks".*Group Override Winner/i);
    assert.match(reasonByUid.get(14), /lost in inclusion group "pier".*Sticky Group Winner.*not yet sticky/i);
    assert.match(reasonByUid.get(15), /filtered by character.*other\.png/i);
    assert.match(reasonByUid.get(16), /filtered by character tags.*tag-maritime/i);
    assert.match(reasonByUid.get(17), /filtered by generation type.*swipe/i);
    assert.match(reasonByUid.get(18), /excluded from recursion.*secretbell/i);
    assert.match(reasonByUid.get(19), /waiting for recursion/i);
    assert.match(reasonByUid.get(20), /scan depth too short.*1 message.*antique.*message depth 3/i);

    // 3. Separate budget-overflow & ignoreBudget agreement proof (overflow halts recursion by design)
    const budgetEntries = [
        makeEntry(0, { comment: 'Fits Budget', key: ['harbour'], order: 300, content: 'Short entry.' }),
        makeEntry(1, { comment: 'Over Budget', key: ['harbour'], order: 200, content: 'B'.repeat(2000) }),
        makeEntry(2, { comment: 'Ignore Budget Rescue', key: ['harbour'], order: 100, ignoreBudget: true, content: 'Rescue.' }),
    ];
    const realBudget = await scanWorldInfo({
        entries: prepareWorldInfoEntries({ globalLore: budgetEntries.map(item => structuredClone(item)) }, 0),
        chat: [...messages],
        chatLength: messages.length,
        metadata: {},
        settings: {
            world_info_depth: 2,
            world_info_budget: 25,
            world_info_budget_cap: 150,
            world_info_min_activations: 0,
            world_info_min_activations_depth_max: 0,
            world_info_recursive: false,
            world_info_max_recursion_steps: 0,
            world_info_case_sensitive: false,
            world_info_match_whole_words: false,
            world_info_use_group_scoring: false,
            world_info_overflow_alert: false,
        },
        global: { trigger: 'normal', characterFile: 'mira.png', characterTags: [] },
        maxContext: 1000,
        countTokens: async text => countTokens(text),
        substitute: value => String(value ?? ''),
        random: () => 0.5,
    });
    const traceBudget = await traceLorebooks({
        books: [{ name: 'Harbour', source: 'global', raw: { entries: Object.fromEntries(budgetEntries.map(item => [item.uid, structuredClone(item)])) } }],
        messages: [...messages],
        settings: { depth: 2, budgetPercent: 25, budgetCap: 150, recursive: false },
        maxContext: 1000,
        hasChatMessages: true,
        tokenCount: countTokens,
    });
    assert.deepStrictEqual(
        traceBudget.activated.map(item => item.uid).sort((a, b) => a - b),
        realBudget.activated.map(item => item.uid).sort((a, b) => a - b),
    );
    assert.deepStrictEqual(traceBudget.activated.map(item => item.uid).sort((a, b) => a - b), [0, 2]);
    assert.match(traceBudget.notActivated.find(item => item.uid === 1)?.reason || '', /cut by token budget.*150 tokens/i);
});

test('lorebook activation trace uses cautious wording where probability or chat state is uncertain', async () => {
    const entries = {
        0: makeEntry(0, { comment: 'Coin Flip', key: ['harbour'], probability: 50, useProbability: true }),
        1: makeEntry(1, { comment: 'Cooldown Without Chat', key: ['harbour'], cooldown: 4, delay: 3 }),
    };

    const trace = await traceLorebooks({
        books: [{ name: 'Harbour', source: 'global', raw: { entries } }],
        messages: ['harbour'],
        settings: { depth: 2 },
        hasChatState: false,
        hasChatMessages: false,
        seed: 1,
    });

    const coinFlipReason = trace.notActivated.find(item => item.uid === 0)?.reason
        || trace.activated.find(item => item.uid === 0)?.caveats?.join(' ');
    assert.match(coinFlipReason, /may.*50%.*random/i);

    const noChatEntry = trace.activated.find(item => item.uid === 1);
    assert.ok(noChatEntry);
    assert.match(noChatEntry.caveats.join(' '), /may be blocked by delay.*depends on chat length/i);
    assert.match(noChatEntry.caveats.join(' '), /cooldown 4 depends on chat state/i);
});
