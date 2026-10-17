/* global globalThis */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

// This case owns a disposable server and a local speech fixture.
test.describe.configure({ mode: 'parallel' });
test.setTimeout(120000);

const speechCalls = app => app.provider.calls.filter(call => call.url.endsWith('/audio/speech'));

function providerModuleFromPath(pathname) {
    return /^\/scripts\/extensions\/tts\/([^/]+)\.js$/.exec(pathname)?.[1].replace(/-[a-f0-9]{8,}$/, '') ?? null;
}

test('saved TTS provider loads only when selected and narrates roleplay and conversation', async ({ app }) => {
    const account = await app.account({ tts: true });
    await account.context.addInitScript(() => globalThis.performance.setResourceTimingBufferSize(2000));
    const page = await account.open();

    const providerModules = () => page.evaluate(() => performance.getEntriesByType('resource')
        .map(entry => new globalThis.URL(entry.name).pathname)
        .filter(pathname => /^\/scripts\/extensions\/tts\/[^/]+\.js$/.test(pathname)));

    const loadedProviderModules = async () => (await providerModules())
        .map(providerModuleFromPath)
        .filter(name => name && !['index', 'kokoro-worker'].includes(name));

    await expect.poll(async () => (await loadedProviderModules()).includes('openai-compatible'), { timeout: 30000 })
        .toBe(true);
    expect(await loadedProviderModules()).toEqual(['openai-compatible']);

    const roleplayNarrated = await page.evaluate(async () => {
        const tts = await import('/scripts/extensions/tts/index.js');
        await tts.init();
        return tts.narrateTtsMessage(
            { name: 'Durable Nova', mes: 'Roleplay narration.' },
            { manual: true, force: true, unrestrictedVoiceMap: true },
        );
    });
    expect(roleplayNarrated).toBe(true);
    await expect.poll(() => speechCalls(app)).toHaveLength(1);

    const conversationNarrated = await page.evaluate(async () => {
        const { narrateConversationMessage } = await import('/scripts/neconyan-conversation/tts.js');
        return narrateConversationMessage(
            { role: 'character', name: 'Durable Nova', mes: 'Conversation narration.' },
            { manual: true, force: true },
        );
    });
    expect(conversationNarrated).toBe(true);
    await expect.poll(() => speechCalls(app)).toHaveLength(2);

    // Selecting one saved provider must not pull in the other 26 built-in modules.
    expect(await loadedProviderModules()).toEqual(['openai-compatible']);
});
