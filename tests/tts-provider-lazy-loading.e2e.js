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

test('disabled TTS keeps its provider deferred until settings are opened', async ({ app }) => {
    // Each test owns a fresh server; account() logs in to its existing default user.
    const account = await app.account();
    await account.context.addInitScript(() => globalThis.performance.setResourceTimingBufferSize(2000));
    const page = await account.open({ workspace: false });

    const providerModules = () => page.evaluate(() => performance.getEntriesByType('resource')
        .map(entry => new globalThis.URL(entry.name).pathname)
        .filter(pathname => /^\/scripts\/extensions\/tts\/[^/]+\.js$/.test(pathname)));
    const loadedProviderModules = async () => (await providerModules())
        .map(providerModuleFromPath)
        .filter(name => name && !['index', 'kokoro-worker'].includes(name));

    await page.waitForFunction(() => globalThis._ttsExtensionInitialized
        && globalThis.document.querySelector('#tts_enabled')
        && globalThis.document.querySelectorAll('#tts_provider option').length > 0);
    await page.evaluate(() => new Promise(resolve => globalThis.setTimeout(resolve, 500)));
    expect(await loadedProviderModules()).toEqual([]);

    await page.evaluate(() => {
        const tab = globalThis.document.getElementById('sb-shell-tab-right-extensions');
        if (tab) tab.click();
        else globalThis.document.querySelector('#extensions-settings-button > .drawer-toggle')?.click();
    });
    await page.getByRole('button', { name: 'Built-in', exact: true }).click();
    await expect(page.locator('#tts_container')).toBeVisible();
    if (!await page.locator('#tts_enabled').isVisible()) {
        await page.getByRole('button', { name: 'Expand TTS', exact: true }).click();
    }

    await expect.poll(async () => (await loadedProviderModules()).includes('system'), { timeout: 30000 }).toBe(true);
    await expect(page.locator('#tts_provider_settings')).toBeVisible();
    await expect.poll(() => page.locator('#tts_provider_settings').evaluate(element => element.textContent.trim().length)).toBeGreaterThan(0);
    await expect(page.locator('#tts_enabled')).not.toBeChecked();

    await page.locator('#tts_enabled').check();
    await expect(page.locator('#tts_enabled')).toBeChecked();

    await page.locator('#tts_voices').click();
    const popup = page.locator('dialog.popup[open]');
    await expect(popup).toBeVisible();
    await expect(popup).not.toContainText('Could not load voices list');
    await page.keyboard.press('Escape');
    await expect(popup).toBeHidden();

    // Refresh applies the settings, then rebuilds the voice map and replaces its
    // short-lived success label with the provider-ready label.
    const appliedSettings = page.waitForEvent('console', {
        predicate: message => message.type() === 'info' && message.text().startsWith('Saved settings System '),
    });
    await page.locator('#tts_status').evaluate(element => { element.textContent = ''; });
    await page.locator('#tts_refresh').click();
    await appliedSettings;
    await expect(page.locator('#tts_status')).toHaveText('TTS Provider Loaded');
    expect(await loadedProviderModules()).toEqual(['system']);
});
