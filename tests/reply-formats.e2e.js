/* global document, window, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

// Each viewport checks four complete app starts against real saved settings.
test.setTimeout(300000);

for (const phone of [false, true]) {
    test(`Reply formats migrate retired selections on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        const account = await app.account({ phone, configureSettings: settings => {
            settings.main_api = 'novel';
        } });
        const page = await account.open({ workspace: false });
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
        const formats = page.locator('#main_api');
        await expect(formats).toBeVisible();
        await expect(formats.locator('option')).toHaveText(['Chat Completion', 'Text Completion']);
        await expect(formats).toHaveValue('openai');
        await expect(page.locator('#openai_api')).toBeVisible();
        for (const selector of ['#novel_api', '#kobold_horde', '#kobold_api']) {
            await expect(page.locator(selector)).toBeHidden();
        }

        // A legacy caller cannot re-enable a removed format or desynchronise the selector.
        for (const requested of ['novel', 'koboldhorde', 'kobold', 'poe', 'unknown']) {
            await page.evaluate(async api => (await import('/script.js')).changeMainAPI(api), requested);
            await expect(formats).toHaveValue('openai');
            expect(await page.evaluate(async () => (await import('/script.js')).main_api)).toBe('openai');
        }
        const apiChoices = await page.evaluate(async () => Object.keys((await import('/scripts/slash-commands.js')).CONNECT_API_MAP));
        for (const retired of ['novel', 'horde', 'kobold']) expect(apiChoices).not.toContain(retired);
        expect(apiChoices).toEqual(expect.arrayContaining(['openai', 'koboldcpp', 'kcpp']));

        // Both remaining formats still switch their actual connection controls.
        await formats.selectOption('textgenerationwebui');
        await expect(page.locator('#textgenerationwebui_api')).toBeVisible();
        await expect(page.locator('#openai_api')).toBeHidden();
        await formats.selectOption('openai');
        await expect(page.locator('#openai_api')).toBeVisible();
        await expect(page.locator('#textgenerationwebui_api')).toBeHidden();
        const geometry = await formats.evaluate(element => ({
            width: element.getBoundingClientRect().width,
            height: element.getBoundingClientRect().height,
            display: getComputedStyle(element).display,
            pageWidth: document.documentElement.scrollWidth,
        }));
        expect(geometry.width).toBeGreaterThan(100);
        expect(geometry.height).toBeGreaterThanOrEqual(44);
        expect(geometry.display).not.toBe('none');
        expect(geometry.pageWidth).toBeLessThanOrEqual((phone ? 393 : 1280) + 1);
        await page.close();

        // Read real saved settings on reload, including preserved Text Completion accounts.
        for (const [savedApi, expected] of [
            ['koboldhorde', 'openai'],
            ['kobold', 'openai'],
            ['textgenerationwebui', 'textgenerationwebui'],
        ]) {
            await test.step(`Restore saved ${savedApi}`, async () => {
                const saved = JSON.parse((await account.post('/api/settings/get')).settings);
                saved.main_api = savedApi;
                await account.post('/api/settings/save', saved);
                const restored = await account.open({ workspace: false });
                await restored.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
                await expect(restored.locator('#main_api')).toHaveValue(expected);
                await expect(restored.locator(`#${expected}_api`)).toBeVisible();
                expect(await restored.evaluate(async () => {
                    const core = await import('/script.js');
                    await core.saveSettings(0);
                    return core.main_api;
                })).toBe(expected);
                expect(JSON.parse((await account.post('/api/settings/get')).settings).main_api).toBe(expected);
                await restored.close();
            });
        }
    });
}
