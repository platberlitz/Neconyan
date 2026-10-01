import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { OWNED_SCRIPT_PREFIX } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/constants.js';
import { repaintMessagesForAgents } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/host.js';
import {
    THEME_ADD_ON_SCRIPT_PREFIX,
    cacheAgentRegexScripts,
    clearCachedAgentRegexScripts,
    resolveRegexScriptsForSnapshot,
} from '../public/scripts/extensions/in-chat-agents/regex-snapshot-store.js';
import { readFileSync } from 'node:fs';

const COMPANION_RESULTS_EXTRA_KEY = 'inChatAgentCompanionResults';
const COMPANION_RESULTS_UPDATED_EVENT = 'in_chat_agent_companion_results_updated';
const read = path => readFileSync(new URL(`../public/scripts/extensions/${path}`, import.meta.url), 'utf8');

const script = (id) => ({ id, scriptName: id, findRegex: `/${id}/g`, replaceString: id, placement: [2] });

describe('theme add-on scripts reach replies saved before the theme', () => {
    afterEach(() => clearCachedAgentRegexScripts());

    test('the snapshot store and the theme extension agree on the add-on prefix', () => {
        expect(THEME_ADD_ON_SCRIPT_PREFIX).toBe(OWNED_SCRIPT_PREFIX);
    });

    test('resolves saved refs in order, then the agent\'s live add-on scripts', () => {
        cacheAgentRegexScripts('tracker', [script('stock-a'), script('stock-b'), script('rat:cleanup-directions:tracker')]);
        cacheAgentRegexScripts('other', [script('other-a'), script('rat:meter:other')]);
        const resolved = resolveRegexScriptsForSnapshot({
            regexScriptRefs: [
                { agentId: 'tracker', scriptId: 'stock-b' },
                { agentId: 'tracker', scriptId: 'stock-a' },
            ],
        });
        expect(resolved.map(item => item.id)).toEqual(['stock-b', 'stock-a', 'rat:cleanup-directions:tracker']);
    });

    test('does not add an add-on script twice when the reply already references it', () => {
        cacheAgentRegexScripts('tracker', [script('stock-a'), script('rat:meter:tracker')]);
        const resolved = resolveRegexScriptsForSnapshot({
            regexScriptRefs: [
                { agentId: 'tracker', scriptId: 'stock-a' },
                { agentId: 'tracker', scriptId: 'rat:meter:tracker' },
            ],
        });
        expect(resolved.map(item => item.id)).toEqual(['stock-a', 'rat:meter:tracker']);
    });

    test('leaves ordinary scripts added later out of older replies', () => {
        cacheAgentRegexScripts('tracker', [script('stock-a'), script('user-added')]);
        const resolved = resolveRegexScriptsForSnapshot({ regexScriptRefs: [{ agentId: 'tracker', scriptId: 'stock-a' }] });
        expect(resolved.map(item => item.id)).toEqual(['stock-a']);
    });
});

describe('theme changes redraw companion note cards', () => {
    afterEach(() => {
        delete global.SillyTavern;
    });

    test('uses the same extra key and event name as In-Chat Agents', () => {
        expect(read('in-chat-agents/companion/companion-shared.js'))
            .toContain(`export const COMPANION_RESULTS_EXTRA_KEY = '${COMPANION_RESULTS_EXTRA_KEY}';`);
        expect(read('in-chat-agents/companion/companion-runner.js'))
            .toContain(`export const COMPANION_RESULTS_UPDATED_EVENT = '${COMPANION_RESULTS_UPDATED_EVENT}';`);
        const host = read('third-party/Neconyan-Regex-Agent-Themes/src/host.js');
        expect(host).toContain(`const COMPANION_RESULTS_EXTRA_KEY = '${COMPANION_RESULTS_EXTRA_KEY}';`);
        expect(host).toContain(`const COMPANION_RESULTS_UPDATED_EVENT = '${COMPANION_RESULTS_UPDATED_EVENT}';`);
    });

    test('repaints inline replies and re-renders cards written by the changed agent', async () => {
        const updateMessageBlock = jest.fn(async () => {});
        const emit = jest.fn(async () => {});
        const chat = [
            { is_user: true, mes: 'hi', extra: {} },
            { mes: 'inline', extra: { inChatAgents: { regexScriptRefs: [{ agentId: 'inline', scriptId: 'stock-a' }] } } },
            { mes: 'card', extra: { [COMPANION_RESULTS_EXTRA_KEY]: { companion: { content: 'note' } } } },
            { mes: 'swipe card', swipe_id: 1, swipe_info: [{ extra: {} }, { extra: { [COMPANION_RESULTS_EXTRA_KEY]: { companion: { content: 'note' } } } }], extra: {} },
            { mes: 'unrelated', extra: { [COMPANION_RESULTS_EXTRA_KEY]: { someoneElse: { content: 'note' } } } },
        ];
        global.SillyTavern = { getContext: () => ({ chat, updateMessageBlock, eventSource: { emit } }) };

        const result = await repaintMessagesForAgents([
            { agentId: 'inline', scriptIds: ['stock-a'] },
            { agentId: 'companion', scriptIds: ['stock-a'] },
        ]);

        expect(updateMessageBlock.mock.calls.map(([index]) => index)).toEqual([1]);
        expect(emit.mock.calls).toEqual([
            [COMPANION_RESULTS_UPDATED_EVENT, { messageIndex: 2 }],
            [COMPANION_RESULTS_UPDATED_EVENT, { messageIndex: 3 }],
        ]);
        expect(result).toEqual({ ok: true, matched: 3, repainted: 3, failed: 0 });
    });
});
