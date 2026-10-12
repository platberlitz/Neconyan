import { describe, expect, test } from '@jest/globals';
import { normalizePinnedPromptIds, setPinnedPromptId, getPinnedPromptRows, resolveChatWidgetLayout } from '../public/scripts/pinned-prompt-toggles.js';

describe('preset pin metadata and projection', () => {
    test.each([undefined, null, {}, { version: 2, identifiers: ['a'] }, { version: 1, identifiers: 'a' }])('rejects malformed metadata %j without rewriting it', value => {
        expect(normalizePinnedPromptIds(value)).toEqual([]);
    });
    test('normalises exact identifiers, not property paths or display names', () => {
        expect(normalizePinnedPromptIds({ version: 1, identifiers: ['a', 'a', '', ' ', 3, '__proto__', 'a.b'] })).toEqual(['a', '__proto__', 'a.b']);
        expect(setPinnedPromptId({ version: 1, identifiers: ['a', 'detached'] }, 'b', true)).toEqual({ version: 1, identifiers: ['a', 'detached', 'b'] });
        expect(setPinnedPromptId({ version: 1, identifiers: ['a', 'b'] }, 'a', false)).toEqual({ version: 1, identifiers: ['b'] });
    });
    test.each([42, '42'])('uses active character %s and stable order, preserving detached pins', id => {
        const settings = { extensions: { neconyan_pinned_prompts: { version: 1, identifiers: ['a', 'b', 'detached', 'restricted', 'missing'] } },
            prompts: [{ identifier: 'a', name: 'Same' }, { identifier: 'b', name: 'Same' }, { identifier: 'restricted', marker: true }],
            prompt_order: [{ character_id: 1, order: [{ identifier: 'a', enabled: false }] }, { character_id: '42', order: [
                { identifier: 'b', enabled: false }, { identifier: 'a', enabled: true }, { identifier: 'a', enabled: false },
                { identifier: 'restricted', enabled: true }, { identifier: 'missing', enabled: true },
            ] }] };
        const before = JSON.stringify(settings);
        const manager = { serviceSettings: settings, activeCharacter: { id },
            getPromptOrderForCharacter: character => settings.prompt_order.find(order => String(order.character_id) === String(character.id)).order,
            getPromptById: identifier => settings.prompts.find(prompt => prompt.identifier === identifier),
            isPromptToggleAllowed: prompt => !prompt.marker };
        expect(getPinnedPromptRows(manager).map(({ identifier, name, enabled }) => ({ identifier, name, enabled }))).toEqual([
            { identifier: 'b', name: 'Same', enabled: false }, { identifier: 'a', name: 'Same', enabled: true },
        ]);
        expect(JSON.stringify(settings)).toBe(before);
        manager.activeCharacter = null;
        expect(getPinnedPromptRows(manager)).toEqual([]);
    });
    test('layout depends on border-box host width and explicit collapse only', () => {
        expect(resolveChatWidgetLayout({ hostWidth: 800, collapsed: false })).toBe('side');
        expect(resolveChatWidgetLayout({ hostWidth: 799, collapsed: false })).toBe('stacked');
        expect(resolveChatWidgetLayout({ hostWidth: 1036, collapsed: true })).toBe('collapsed');
    });
    test('attached permitted markers can be pinned, but the runtime Agents entry cannot', () => {
        const prompts = [{ identifier: 'chatHistory', marker: true, name: 'History' }, { identifier: 'neconyanRuntimeAgents', name: 'Agents' }];
        const manager = { activeCharacter: { id: 1 }, serviceSettings: { extensions: { neconyan_pinned_prompts: { version: 1, identifiers: prompts.map(prompt => prompt.identifier) } } },
            getPromptOrderForCharacter: () => prompts.map(prompt => ({ identifier: prompt.identifier, enabled: true })),
            getPromptById: identifier => prompts.find(prompt => prompt.identifier === identifier), isPromptToggleAllowed: () => true };
        expect(getPinnedPromptRows(manager).map(row => row.identifier)).toEqual(['chatHistory']);
    });
});
