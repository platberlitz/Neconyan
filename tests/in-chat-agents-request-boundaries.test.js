/* eslint-disable playwright/no-standalone-expect -- These are Jest table-driven tests. */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { isGenerationLengthFinish } from '../public/scripts/generation-request-controls.js';
import { buildChatPresetPayload, createChatRequestData } from '../public/scripts/chat-preset-request.js';
import { normalizeContentText as normalizeContentTextPure, extractMessageFromData as extractMessageFromDataPure, constructScopedTextPrompt, cleanScopedTextResponse } from '../public/scripts/generation-format.js';
import { instructSettings, promptMessages, expectedPrompts, providerDependencies } from './fixtures/text-generation-baseline.js';
import { createTextProviderParameters } from '../public/scripts/text-provider-parameters.js';
import { getLocalPromptCacheValue, isLikelyLocalServerUrl } from '../public/scripts/local-url-utils.js';

function load(context, file, names) {
    const source = readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    for (const name of names) {
        const node = ast.body.map(item => item.declaration ?? item)
            .find(item => item.id?.name === name || item.declarations?.some(declaration => declaration.id.name === name));
        if (!node) throw new Error(`Missing declaration: ${name}`);
        vm.runInContext(`${source.slice(node.start, node.end)}\nglobalThis.${name} = ${name};`, context);
    }
}

function runtime() {
    const context = vm.createContext({
        console, structuredClone, AbortController, Error,
        isGenerationLengthFinish, normalizeContentTextPure, extractMessageFromDataPure, constructScopedTextPrompt, cleanScopedTextResponse,
        name1: 'Sam', name2: 'Ada', selected_group: null, substituteParams: providerDependencies.substitute,
        getPresetManager: () => ({ getCompletionPresetByName: () => undefined }),
        getTextGenServer: () => 'http://127.0.0.1:5000',
        buildChatPresetPayload, createChatRequestData,
        getGenerateUrl: () => '/generate', getRequestHeaders: () => ({}),
        getNanoGptServiceTier: async () => '',
        extractReasoningFromData: () => 'reasoning stays separate',
        fetchResumable: jest.fn(),
        chat_completion_sources: { OPENAI: 'openai', NANOGPT: 'nanogpt' },
        settingsToUpdate: { openai_max_tokens: [null, 'openai_max_tokens'] },
        oai_settings: { openai_max_tokens: 8192, auto_append_reasoning_tags: false },
        power_user: { instruct: instructSettings, reasoning: { auto_parse: false, prefix: '<think>', suffix: '</think>' } },
        migrateNanoGptProviderSettings: () => {},
    });
    load(context, 'script.js', ['stringifyUnknown', 'normalizeContentText', 'extractMessageFromData']);
    load(context, 'scripts/utils.js', ['escapeRegex']);
    load(context, 'scripts/reasoning.js', ['AUTO_APPEND_REASONING_TAGS', 'getAutoAppendReasoningTagOrder', 'getAutoAppendReasoningTemplates', 'getReasoningParseTemplates', 'isReasoningAutoParseEnabled', 'removeReasoningFromString']);
    load(context, 'scripts/custom-request.js', ['ChatCompletionService', 'TextCompletionService']);
    load(context, 'scripts/extensions/in-chat-agents/agent-runner.js', ['serializeChatContext', 'parseChatContext']);
    return context;
}

describe('real agent request boundaries', () => {
    test.each([undefined, 'missing', instructSettings])('direct text prompt preserves instruct fallback %#', preset => {
        const ctx = runtime();
        expect(ctx.TextCompletionService.constructPrompt(structuredClone(promptMessages), preset)).toBe(expectedPrompts.scoped);
        expect(ctx.TextCompletionService.constructPrompt([{ role: 'user', content: 'Hello' }], {})).toBe('Hello');
    });

    test.each([[null, 'Answer'], [['<stop>'], 'Answer<sto']])('text response cleanup accepts stop list %#', async (stopping_strings, content) => {
        const ctx = runtime();
        ctx.TextCompletionService.sendRequest = jest.fn(async () => ({ content }));
        await expect(ctx.TextCompletionService.processRequest({ prompt: 'Question', stopping_strings })).resolves.toEqual({ content: 'Answer' });
    });

    test.each([
        ['https://remote.example/v1', 'http://127.0.0.1:5000', true],
        ['http://127.0.0.1:5000', 'https://remote.example/v1', false],
        ['http://127.0.0.1:5000', undefined, true],
    ])('cache policy follows the actual request address %#', (globalUrl, api_server, local) => {
        const ctx = runtime();
        Object.assign(ctx, {
            window: { location: { href: 'http://localhost:8000' } },
            getTextGenServer: () => globalUrl,
            createTextProviderParameters, getLocalPromptCacheValue, isLikelyLocalServerUrl,
            getCustomTokenBans: () => ({ banned_tokens: '', banned_strings: [] }),
            calculateLogitBias: () => ({}), getStoppingStrings: () => [], max_context: 8192,
        });
        load(ctx, 'scripts/textgen-settings.js', ['shouldUseLocalPromptCache', 'createTextGenGenerationData']);
        const make = scope => ctx.createTextGenGenerationData({ type: 'llamacpp', api_server }, 'model', 'Prompt', 50, false, false, null, 'quiet', { cacheScope: scope });
        expect(make('main').cache_prompt).toBe(local ? true : undefined);
        expect(make('auxiliary').cache_prompt).toBe(local ? false : undefined);
        expect(make('main').api_server).toBe(api_server ?? globalUrl);
    });

    test.each(['ChatCompletionService', 'TextCompletionService'])('%s retains HTTP status and provider diagnostics', async service => {
        const ctx = runtime();
        ctx.fetchResumable.mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: { message: 'Quota exhausted' } }) });
        await expect(ctx[service].sendRequest({ stream: false })).rejects.toMatchObject({ status: 429, message: 'Quota exhausted' });
    });

    test.each(['ChatCompletionService', 'TextCompletionService'])('%s excludes typed thinking before converting to text', async service => {
        const ctx = runtime();
        ctx.fetchResumable.mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: [
            { type: 'thinking', text: 'secret draft' },
            { type: 'text', text: 'Visible reply' },
        ] }, finish_reason: 'length' }] }) });
        await expect(ctx[service].sendRequest({ stream: false })).resolves.toMatchObject({ content: 'Visible reply', lengthLimited: true });
    });

    test('helper reasoning removal is independent of the main chat display preference', () => {
        const ctx = runtime();
        const text = '<think>private</think>Visible<thought>also private</thought>';
        expect(ctx.removeReasoningFromString(text)).toBe(text);
        expect(ctx.removeReasoningFromString(text, { force: true })).toBe('Visible');
        expect(ctx.removeReasoningFromString('<think>unfinished', { force: true })).toBe('');
    });

    test.each(['gpt-4', 'gpt-5', 'o3'])('preset merging keeps the converted output limit for %s', async model => {
        const ctx = runtime();
        ctx.createGenerationParameters = async settings => ({ generate_data: model === 'gpt-4'
            ? { max_tokens: settings.openai_max_tokens } : { max_completion_tokens: settings.openai_max_tokens } });
        const result = await ctx.ChatCompletionService.presetToGeneratePayload({ openai_max_tokens: 8192 }, {}, { model, max_tokens: 128 });
        expect(result).toMatchObject(model === 'gpt-4' ? { max_tokens: 128 } : { max_completion_tokens: 128 });
        expect(result[model === 'gpt-4' ? 'max_completion_tokens' : 'max_tokens']).toBeUndefined();
        expect(ctx.oai_settings.openai_max_tokens).toBe(8192);
    });

    test('chat replacement preserves image parts and null tool-call content', () => {
        const ctx = runtime();
        const messages = [
            { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,test' } }] },
            { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'call-1', content: 'Found' },
        ];
        expect(ctx.parseChatContext(ctx.serializeChatContext(messages))).toEqual(messages);
    });

    test.each([
        [], [{ role: 'user', content: '' }], [{ role: 'tool', tool_call_id: 'missing', content: 'Found' }],
        [{ role: 'system', tool_calls: [] }], [{ role: 'user', content: [null] }], [{ role: 'user', content: [2] }],
        [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }],
    ].map(messages => [messages]))('rejects unusable replacement context %#', messages => {
        const ctx = runtime();
        expect(() => ctx.parseChatContext(JSON.stringify(messages))).toThrow();
    });
});

describe('message visibility save ownership', () => {
    function visibilityRuntime() {
        const ctx = vm.createContext({
            console,
            chat: [{ mes: 'Original story', is_system: false }], chat_metadata: {}, chatId: 'original',
            getCurrentChatId: () => ctx.chatId,
            $: () => ({ length: 1, attr: jest.fn() }),
            refreshSwipeButtons: jest.fn(), saveChatConditional: jest.fn(async () => true),
            event_types: { MESSAGE_UPDATED: 'updated' }, eventSource: { emit: jest.fn() },
            toastr: { error: jest.fn() }, t: strings => strings.join(''),
        });
        load(ctx, 'scripts/chats.js', ['messageVisibilityOperations', 'hideChatMessageRange']);
        return ctx;
    }

    test.each(['declined', 'thrown'])('a %s save restores visibility and reports failure', async failure => {
        const ctx = visibilityRuntime();
        ctx.saveChatConditional.mockImplementationOnce(async () => {
            if (failure === 'thrown') throw new Error('Save unavailable');
            return false;
        });
        await expect(ctx.hideChatMessageRange(0, 0, false)).resolves.toBe(false);
        expect(ctx.chat[0].is_system).toBe(false);
        expect(ctx.eventSource.emit).not.toHaveBeenCalled();
        expect(ctx.toastr.error).toHaveBeenCalledTimes(1);
    });

    test('a completed save does not refresh a different chat', async () => {
        const ctx = visibilityRuntime();
        ctx.saveChatConditional.mockImplementationOnce(async () => {
            ctx.chatId = 'next';
            ctx.chat = [{ mes: 'Other story', is_system: false }];
            ctx.chat_metadata = {};
            return true;
        });
        await expect(ctx.hideChatMessageRange(0, 0, false)).resolves.toBe(false);
        expect(ctx.chat[0].is_system).toBe(false);
        expect(ctx.eventSource.emit).not.toHaveBeenCalled();
    });

    test('a failed older operation cannot undo a newer successful visibility change', async () => {
        const ctx = visibilityRuntime();
        let release;
        ctx.saveChatConditional.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const first = ctx.hideChatMessageRange(0, 0, false);
        await expect(ctx.hideChatMessageRange(0, 0, false)).resolves.toBe(true);
        release(false);
        await expect(first).resolves.toBe(false);
        expect(ctx.chat[0].is_system).toBe(true);
    });
});
