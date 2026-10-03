/* global document, window */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(120000);

for (const [layout, phone, provider, variant] of [
    ['desktop', false, 'gptimage', 'sunburst'],
    ['phone', true, 'proxy', 'flare'],
]) {
    test(`${layout} Quick Image Gen displays a Responses image from ${variant}`, async ({ app }, info) => {
        const model = `gpt-image-2.5-${variant}`;
        const image = (await readFile(new URL('../public/img/ai4.png', import.meta.url))).toString('base64');
        const reference = `data:image/png;base64,${image}`;
        const calls = [];
        const account = await app.account({ phone, configureSettings(saved) {
            saved.extension_settings['quick-image-gen'] = {
                _syncCacheId: randomUUID(),
                provider, setupWizardSeen: true, useLastMessage: false, useLLMPrompt: false,
                twoStepPrompt: false, appendQuality: false, useSTStyle: false, useWorldInfo: false,
                reviewBeforeGenerate: false, autoInsert: false, batchCount: 1,
                gptImageProxyUrl: 'https://image-proxy.example.test/openai/flex/v1', gptImageProxyKey: 'fixture-key', gptImageModel: model,
                proxyUrl: 'https://image-proxy.example.test/openai/flex/v1/chat/completions', proxyKey: 'fixture-key', proxyModel: model,
                proxyChatImageMode: true, proxyChatImageIncludePersonality: false, proxyRefImages: [reference],
                proxyPayloadMode: 'extended', proxySse: 'on', width: 1024, height: 1024,
            };
        } });
        await account.context.route('https://image-proxy.example.test/**', async route => {
            calls.push({ url: route.request().url(), body: route.request().postDataJSON() });
            await route.fulfill({ json: { object: 'response', status: 'completed', output: [
                { type: 'image_generation_call', status: 'completed', result: image },
            ] } });
        });
        const page = await account.open({ workspace: false });
        await page.evaluate(() => window.NeconyanShell.openTab('right', 'extensions'));
        await page.waitForFunction(() => window.NeconyanExtensions && document.querySelector('#qig-settings'));
        await page.evaluate(() => window.NeconyanExtensions.focusUnit('Quick Image Gen'));
        await expect(page.locator('#qig-settings')).toBeVisible();
        await page.locator('#qig-prompt').fill('A small orange circle on white.');
        await page.locator('#qig-generate-btn').click();
        await expect(page.locator('#qig-result-img')).toBeVisible({ timeout: 30000 });
        await expect.poll(() => page.locator('#qig-result-img').evaluate(img => img.complete && img.naturalWidth > 1)).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://image-proxy.example.test/openai/flex/v1/responses');
        expect(calls[0].body.model).toBe('gpt-5.5');
        expect(calls[0].body.tools[0]).toMatchObject({ type: 'image_generation', model, action: provider === 'proxy' ? 'edit' : 'generate' });
        expect(calls[0].body.tool_choice).toEqual({ type: 'image_generation' });
        expect(calls[0].body.stream).toBeUndefined();
        expect(calls[0].body.input[0].content.filter(item => item.type === 'input_image')).toEqual(provider === 'proxy'
            ? [{ type: 'input_image', image_url: reference, detail: 'high' }] : []);
        const bounds = await page.locator('#qig-result-img').boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(phone ? 394 : 1281);
        await info.attach(`${layout}-result`, { body: await page.screenshot(), contentType: 'image/png' });
    });
}
