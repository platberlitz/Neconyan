import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, jest, test } from '@jest/globals';
import { getPositiveTokenCount, updateReasoningTokenAccounting } from '../public/scripts/reasoning-token-accounting.js';

const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const body = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body;
const helper = body.find(row => row.id?.name === 'ensureFirstMessageTokenCount');

function fixture(message = { mes: 'Hello, User.', is_user: false, is_system: false, extra: {} }) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const countTokens = jest.fn(async () => { await gate; return 5; });
    let current = true;
    const runtime = vm.createContext({
        console: { warn: jest.fn() }, chat: [message], power_user: { message_token_count_enabled: true },
        getPositiveTokenCount, firstMessageTokenCounts: new WeakMap(),
        captureChatRenderValidity: () => () => current,
        updateMessageTokenAccounting: (target, options) => updateReasoningTokenAccounting(target, { countTokens, ...options }),
        updateMessageMetaBadges: jest.fn(),
    });
    vm.runInContext(source.slice(helper.start, helper.end), runtime);
    return { runtime, message, countTokens, release, invalidate: () => { current = false; } };
}

describe('greeting token counts', () => {
    test('normal first-message renders request a count, but server previews never do', () => {
        const renderer = body.find(row => row.declaration?.id?.name === 'updateMessageElement').declaration;
        expect(source.slice(renderer.start, renderer.end)).toContain('if (!isPreview && messageId === 0) {\n        void ensureFirstMessageTokenCount(mes, messageElement);');
        expect(source.slice(renderer.start, renderer.end).indexOf('getMessageTextHTML(mes'))
            .toBeLessThan(source.slice(renderer.start, renderer.end).indexOf('ensureFirstMessageTokenCount(mes'));
    });

    test('counts the rendered greeting and its active swipe without counting unused alternatives', async () => {
        const message = { mes: 'Hello, User.', swipe_id: 0, swipes: ['Hello, {{user}}.', 'Another greeting.'],
            swipe_info: [{ extra: {} }, { extra: {} }], extra: {} };
        const { runtime, countTokens, release } = fixture(message);
        const element = {};
        const counting = runtime.ensureFirstMessageTokenCount(message, element);
        expect(countTokens).toHaveBeenCalledWith('Hello, User.');
        release();
        await counting;
        expect(message.extra.token_count).toBe(5);
        expect(message.swipe_info[0].extra.token_count).toBe(5);
        expect(message.swipe_info[1].extra.token_count).toBeUndefined();
        expect(runtime.updateMessageMetaBadges).toHaveBeenCalledWith(element, message);
    });

    test('shares a pending count when the same greeting is rendered twice', async () => {
        const { runtime, message, countTokens, release } = fixture();
        const first = runtime.ensureFirstMessageTokenCount(message, {});
        const second = runtime.ensureFirstMessageTokenCount(message, {});
        expect(countTokens).toHaveBeenCalledTimes(1);
        release();
        await Promise.all([first, second]);
        expect(runtime.updateMessageMetaBadges).toHaveBeenCalledTimes(2);
        expect(runtime.firstMessageTokenCounts.has(message)).toBe(false);
    });

    test.each(['disabled', 'user', 'system', 'empty', 'counted', 'not-current'])('skips %s messages', async kind => {
        const { runtime, message, countTokens } = fixture();
        if (kind === 'disabled') runtime.power_user.message_token_count_enabled = false;
        if (kind === 'user') message.is_user = true;
        if (kind === 'system') message.is_system = true;
        if (kind === 'empty') message.mes = '';
        if (kind === 'counted') message.extra.token_count = 12;
        if (kind === 'not-current') runtime.chat[0] = {};
        await runtime.ensureFirstMessageTokenCount(message, {});
        expect(countTokens).not.toHaveBeenCalled();
        expect(runtime.updateMessageMetaBadges).not.toHaveBeenCalled();
    });

    test.each([['navigation', 5], ['replacement', 5], ['edit', undefined], ['swipe', undefined], ['disabled', 5]])('a late count cannot repaint after %s', async (kind, expectedCount) => {
        const { runtime, message, release, invalidate } = fixture();
        const counting = runtime.ensureFirstMessageTokenCount(message, {});
        if (kind === 'navigation') invalidate();
        if (kind === 'replacement') runtime.chat[0] = {};
        if (kind === 'edit') message.mes = 'Edited.';
        if (kind === 'swipe') { message.swipe_id = 1; message.mes = 'Alternate.'; }
        if (kind === 'disabled') runtime.power_user.message_token_count_enabled = false;
        release();
        await counting;
        expect(runtime.updateMessageMetaBadges).not.toHaveBeenCalled();
        expect(message.extra.token_count).toBe(expectedCount);
    });

    test('a failed count leaves the greeting usable and allows a later retry', async () => {
        const { runtime, message, countTokens, release } = fixture();
        countTokens.mockRejectedValueOnce(new Error('Tokenizer unavailable'));
        await runtime.ensureFirstMessageTokenCount(message, {});
        expect(runtime.console.warn).toHaveBeenCalled();
        expect(runtime.firstMessageTokenCounts.has(message)).toBe(false);
        const retry = runtime.ensureFirstMessageTokenCount(message, {});
        release();
        await retry;
        expect(message.extra.token_count).toBe(5);
    });
});
