import { describe, expect, jest, test } from '@jest/globals';
import { checkPostInterceptChatBudget, shouldCheckPostInterceptChatBudget } from '../public/scripts/openai-prompt-budget.js';

describe('OpenAI post-intercept prompt budget', () => {
    test('recounts chat payloads after pre-generation intercepts', async () => {
        const chat = [{ role: 'user', content: 'intercept-expanded prompt' }];
        const countTokens = jest.fn(async () => 120);

        const result = await checkPostInterceptChatBudget(chat, {
            openai_max_context: 150,
            openai_max_tokens: 40,
        }, countTokens);

        expect(countTokens).toHaveBeenCalledWith(chat);
        expect(result).toEqual({
            promptTokens: 120,
            promptTokenBudget: 110,
            exceeded: true,
        });
    });

    test('does not flag payloads that stay within the post-intercept budget', async () => {
        const result = await checkPostInterceptChatBudget([{ role: 'user', content: 'prompt' }], {
            openai_max_context: 150,
            openai_max_tokens: 40,
        }, async () => 110);

        expect(result.exceeded).toBe(false);
    });

    test('rejects non-array post-intercept payloads', async () => {
        await expect(checkPostInterceptChatBudget(null, {
            openai_max_context: 150,
            openai_max_tokens: 40,
        }, async () => 0)).rejects.toThrow('Post-intercept chat payload must be an array.');
    });

    test('counts clean memory text after an intercept while preserving the working slot for proof', async () => {
        const marker = { open: '[private begin]', close: '[private end]' };
        const working = marker.open + '\nprimary\n' + marker.close;
        const chat = [{ role: 'system', content: working }];
        const counter = jest.fn(async payload => payload[0].content.length);
        const result = await checkPostInterceptChatBudget(chat, { openai_max_context: 8, openai_max_tokens: 1 }, counter, marker);
        expect(result).toEqual({ promptTokens: 7, promptTokenBudget: 7, exceeded: false });
        expect(counter).toHaveBeenCalledWith([{ role: 'system', content: 'primary' }]);
        expect(chat[0].content).toBe(working);
    });

    test('checks budget only when the prompt-ready chat changed', () => {
        expect(shouldCheckPostInterceptChatBudget({ chatChanged: true })).toBe(true);
        expect(shouldCheckPostInterceptChatBudget({ chatChanged: false })).toBe(false);
        expect(shouldCheckPostInterceptChatBudget({})).toBe(false);
        expect(shouldCheckPostInterceptChatBudget(null)).toBe(false);
    });
});

describe('post-intercept budget leaves hidden data out of the count', () => {
    const settings = { openai_max_context: 100000, openai_max_tokens: 1000 };
    const countedView = async (chat, marker = null) => {
        const counter = jest.fn(async () => 1);
        await checkPostInterceptChatBudget(chat, settings, counter, marker);
        return counter.mock.calls[0][0];
    };

    test('counts a reply without its signature and leaves the input alone', async () => {
        const chat = [{ role: 'assistant', content: 'Visible reply', reasoning: 'Plain thinking', signature: 'S'.repeat(9000) }];
        const before = structuredClone(chat);
        const view = await countedView(chat);
        expect(view).toEqual([{ role: 'assistant', content: 'Visible reply', reasoning: 'Plain thinking' }]);
        expect(view[0]).not.toHaveProperty('signature');
        expect(chat).toEqual(before);
        expect(view).not.toBe(chat);
        expect(view[0]).not.toBe(chat[0]);
    });

    test('counts tool calls without their signatures but with their names and arguments', async () => {
        const call = { id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"query":"harbour"}' }, signature: 'T'.repeat(9000) };
        const chat = [{ role: 'assistant', tool_calls: [call], signature: 'S'.repeat(500) }, { role: 'tool', tool_call_id: 'call-1', content: 'Found it.' }];
        const before = structuredClone(chat);
        const view = await countedView(chat);
        expect(view[0].tool_calls).toEqual([{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"query":"harbour"}' } }]);
        expect(view[0].tool_calls[0]).not.toHaveProperty('signature');
        expect(view[0]).not.toHaveProperty('signature');
        expect(view[1]).toEqual(chat[1]);
        expect(chat).toEqual(before);
        expect(chat[0].tool_calls[0]).toBe(call);
    });

    test('counts an inlined picture, video or audio as an empty address and keeps web addresses', async () => {
        const chat = [{ role: 'user', content: [
            { type: 'text', text: 'Look at these.' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(9000), detail: 'low' } },
            { type: 'image_url', image_url: { url: 'https://example.invalid/lamp.png', detail: 'high' } },
            { type: 'video_url', video_url: { url: 'data:video/mp4;base64,' + 'B'.repeat(9000) } },
            { type: 'audio_url', audio_url: { url: 'data:audio/wav;base64,' + 'C'.repeat(9000) } },
        ] }];
        const before = structuredClone(chat);
        const view = await countedView(chat);
        expect(view[0].content).toEqual([
            { type: 'text', text: 'Look at these.' },
            { type: 'image_url', image_url: { url: '', detail: 'low' } },
            { type: 'image_url', image_url: { url: 'https://example.invalid/lamp.png', detail: 'high' } },
            { type: 'video_url', video_url: { url: '' } },
            { type: 'audio_url', audio_url: { url: '' } },
        ]);
        expect(chat).toEqual(before);
    });

    test('passes entries that are not objects through unchanged', async () => {
        const chat = [null, 'plain text', 7, { role: 'user', content: [null, 'part', { type: 'text', text: 'Hello' }] }];
        const before = structuredClone(chat);
        const view = await countedView(chat);
        expect(view).toEqual(before);
        expect(view[0]).toBeNull();
        expect(chat).toEqual(before);
    });

    test('hands the counter a new array even when nothing needs removing', async () => {
        const chat = [{ role: 'user', content: 'Plain' }];
        const view = await countedView(chat);
        expect(view).toEqual(chat);
        expect(view).not.toBe(chat);
    });

    test('removes hidden data from the clean memory view too', async () => {
        const marker = { open: '[private begin]', close: '[private end]' };
        const working = marker.open + '\nprimary\n' + marker.close;
        const chat = [{ role: 'system', content: working, signature: 'S'.repeat(2000) }];
        const view = await countedView(chat, marker);
        expect(view).toEqual([{ role: 'system', content: 'primary' }]);
        expect(chat[0].content).toBe(working);
        expect(chat[0].signature).toHaveLength(2000);
    });

    test('flags a prompt only when its visible text is over the budget', async () => {
        const size = async payload => JSON.stringify(payload).length;
        const small = { openai_max_context: 1500, openai_max_tokens: 500 };
        const hidden = [{ role: 'assistant', content: 'x'.repeat(200), signature: 'S'.repeat(5000) }];
        const visible = [{ role: 'assistant', content: 'x'.repeat(5000), signature: 'S'.repeat(5000) }];
        expect((await checkPostInterceptChatBudget(hidden, small, size)).exceeded).toBe(false);
        expect((await checkPostInterceptChatBudget(visible, small, size)).exceeded).toBe(true);
    });
});
