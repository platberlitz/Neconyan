/* eslint-disable playwright/no-standalone-expect -- These are parameterised Jest tests. */
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { event_types } from '../public/scripts/events.js';

const source = readFileSync(new URL('../public/scripts/world-info.js', import.meta.url), 'utf8');

function functionSource(name) {
    const match = source.match(new RegExp(`^(?:export )?((?:async )?function ${name}\\([\\s\\S]*?^})`, 'm'));
    if (!match) throw new Error(`Missing function ${name}`);
    return match[1];
}

const { isKeywordActivationSuppressed, setKeywordActivationPolicy } = await import('../public/scripts/world-info-policy.js');

function chatText() {
    return 'We enter the town and follow the river.';
}

function entryFixture() {
    return [
        { uid: 0, world: 'Book A', key: ['town'], content: 'Town lore.', constant: false, position: 0, order: 100, probability: 100, decorators: [] },
        { uid: 1, world: 'Book A', key: ['always'], content: 'Constant lore.', constant: true, position: 0, order: 100, probability: 100, decorators: [] },
        { uid: 2, world: 'Other', key: ['river'], content: 'River lore.', constant: false, position: 0, order: 100, probability: 100, decorators: [] },
    ];
}

function installContext(entries, matchesWorldInfoEntry) {
    const scan_state = { NONE: 0, INITIAL: 1, RECURSION: 2, MIN_ACTIVATIONS: 3 };
    class WorldInfoBuffer {
        constructor(chat) { this.chat = chat; this.recurseTexts = []; }
        addInject() {}
        getExternallyActivated() { return null; }
        get() { return this.chat.map(message => message.mes).join(' '); }
        hasRecurse() { return this.recurseTexts.length > 0; }
        getDepth() { return 0; }
        advanceScan() {}
        addRecurse(text) { this.recurseTexts.push(text); }
        resetExternalEffects() {}
        getScore() { return 0; }
    }
    class WorldInfoTimedEffects {
        checkTimedEffects() {}
        isEffectActive() { return false; }
        setTimedEffects() {}
        cleanUp() {}
    }
    const context = vm.createContext({
        console: { debug: () => {}, log: () => {}, warn: () => {}, error: () => {} },
        getContext: () => ({ extensionPrompts: {}, tagMap: {} }),
        getExtensionPromptByName: async () => null,
        WorldInfoBuffer, WorldInfoTimedEffects, scan_state,
        world_info_budget: 25, world_info_budget_cap: 0, world_info_recursive: false,
        world_info_max_recursion_steps: 0, world_info_min_activations: 0,
        world_info_min_activations_depth_max: 0, world_info_overflow_alert: false,
        world_info_case_sensitive: false, world_info_match_whole_words: false,
        world_info_use_group_scoring: false,
        world_info_position: { before: 0, after: 1, EMTop: 2, EMBottom: 3, ANTop: 4, ANBottom: 5, atDepth: 6, outlet: 7 },
        wi_anchor_position: { before: 0, after: 1 }, regex_placement: {}, extension_prompt_roles: { SYSTEM: 0 },
        DEFAULT_DEPTH: 4, shouldWIAddPrompt: false,
        getSortedEntries: async () => entries,
        getTokenCountAsync: async text => text.length,
        filterByInclusionGroups: () => {},
        passesWorldInfoProbability: () => true,
        matchesWorldInfoEntry,
        substituteParams: value => value,
        getRegexedString: content => content,
        sortFn: (a, b) => (a.order ?? 0) - (b.order ?? 0),
        getCharaFilename: () => 'char', getTagKeyForEntity: () => null, characters: [], this_chid: null,
        defaultGlobalScanData: { trigger: 0 },
        event_types,
        eventSource: { emit: async () => {} },
        toastr: { warning: () => {} },
        isKeywordActivationSuppressed,
    });
    vm.runInContext(functionSource('checkWorldInfo'), context);
    return context;
}

async function scan(entries, policy) {
    setKeywordActivationPolicy(policy ?? null);
    const context = installContext(entries, (entry, text) => entry.key.some(keyword => text.includes(keyword)));
    return context.checkWorldInfo([{ mes: chatText() }], 4096, false, { trigger: 0 });
}

describe('World Info keyword activation policy', () => {
    beforeEach(() => {
        setKeywordActivationPolicy(null);
    });

    afterEach(() => {
        setKeywordActivationPolicy(null);
    });

    test('activates keyword entries normally when no policy is registered', async () => {
        const result = await scan(entryFixture());
        expect(result.worldInfoBefore).toContain('Town lore.');
        expect(result.worldInfoBefore).toContain('Constant lore.');
        expect(result.worldInfoBefore).toContain('River lore.');
        expect(result.allActivatedEntries.size).toBe(3);
    });

    test('a policy veto removes only keyword activation for covered entries', async () => {
        const result = await scan(entryFixture(), entry => entry.world === 'Book A');
        expect(result.worldInfoBefore).not.toContain('Town lore.');
        expect(result.worldInfoBefore).toContain('Constant lore.');
        expect(result.worldInfoBefore).toContain('River lore.');
        const activated = Array.from(result.allActivatedEntries).map(entry => entry.uid);
        expect(activated).toEqual([1, 2]);
    });

    test('a policy that covers nothing changes nothing', async () => {
        const result = await scan(entryFixture(), () => false);
        expect(result.worldInfoBefore).toContain('Town lore.');
        expect(result.worldInfoBefore).toContain('Constant lore.');
        expect(result.worldInfoBefore).toContain('River lore.');
    });
});
