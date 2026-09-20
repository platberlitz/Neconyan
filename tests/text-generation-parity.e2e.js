import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { instructSettings, promptMessages, expectedPrompts } from './fixtures/text-generation-baseline.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server and fake provider.');
test.setTimeout(120000);

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} scoped text requests preserve instruct, macros and explicit server cache policy`, async ({ app }, info) => {
        const account = await app.account({ phone });
        const page = await account.open();
        app.provider.mode.reply = { choices: [{ text: 'Answer<sto' }] };
        const result = await page.evaluate(async ({ url, instruct, messages }) => {
            const { power_user } = await import('/scripts/power-user.js');
            const { TextCompletionService } = await import('/scripts/custom-request.js');
            const { textgenerationwebui_settings: active, createTextGenGenerationData } = await import('/scripts/textgen-settings.js');
            const core = await import('/script.js');
            core.setUserName('Sam');
            core.setCharacterName('Ada');
            const scopedMessages = messages.map(message => ({ ...message, content: core.normalizeContentText(message.content) }));
            const formatted = TextCompletionService.constructPrompt(scopedMessages, instruct);
            power_user.instruct = { ...instruct, enabled: false };
            const fallback = TextCompletionService.constructPrompt([{ role: 'user', name: 'Visitor', content: 'Hello' }], 'missing fixture preset');
            power_user.custom_stopping_strings = '["{{getvar::parity}}"]';
            power_user.custom_stopping_strings_macro = true;
            active.server_urls.llamacpp = 'https://unused.invalid/v1';
            const settings = { ...active, type: 'llamacpp', api_server: url, dry_sequence_breakers: '["{{setvar::parity::1}}"]', negative_prompt: '{{setvar::parity::2}}{{getvar::parity}}', logit_bias: [], banned_tokens: '', banned_strings: '' };
            const payload = createTextGenGenerationData(settings, 'fixture-model', formatted, 73);
            const requests = [];
            requests.push({ url: payload.api_server, cache: payload.cache_prompt, stops: payload.stop, negative: payload.negative_prompt });
            payload.stopping_strings = ['<stop>'];
            const response = await TextCompletionService.processRequest({ ...payload, stream: false });
            active.server_urls.llamacpp = url;
            const remote = createTextGenGenerationData({ ...settings, api_server: 'https://unused.invalid/v1' }, 'fixture-model', formatted, 73);
            const noOverride = { ...settings };
            delete noOverride.api_server;
            const main = createTextGenGenerationData(noOverride, 'fixture-model', formatted, 73, false, false, null, 'quiet', { cacheScope: 'main' });
            return { formatted, fallback, response: response.content, requests, remoteCache: remote.cache_prompt, mainCache: main.cache_prompt, mainUrl: main.api_server };
        }, { url: app.provider.url, instruct: instructSettings, messages: promptMessages });
        expect(result.formatted).toBe(expectedPrompts.scoped);
        expect(result.fallback).toContain('<user Visitor>');
        expect(result.response).toBe('Answer');
        expect(result.requests[0]).toMatchObject({ url: app.provider.url, cache: false, negative: '2' });
        expect(result.requests[0].stops).toContain('1');
        expect(result.remoteCache).toBeUndefined();
        expect(result.mainCache).toBe(true);
        expect(result.mainUrl).toBe(app.provider.url);
        expect(app.provider.calls).toHaveLength(1);
        expect(app.provider.calls[0].prompt).toBe(expectedPrompts.scoped);
        await info.attach('scoped-text-request', { body: JSON.stringify(result), contentType: 'application/json' });
    });
}
