/* global document, window */
import { readFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

test.setTimeout(120000);

for (const phone of [true, false]) {
    const layout = phone ? 'phone' : 'desktop';
    test(`${layout} Gallery shortcuts keep the chat and reuse saved pictures`, async ({ app }, info) => {
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(saved) {
            saved.extension_settings['quick-image-gen'] = { _syncCacheId: randomUUID(), setupWizardSeen: true };
        } });
        if (phone) await installIPhoneSafari(account.context);
        const page = await account.open();
        await page.waitForFunction(() => document.querySelector('#qig-gallery-settings-btn'));
        if (phone) await applyIOSOnlyCss(page);
        await page.addStyleTag({ content: '#nn-update-toast, #toast-container { visibility: hidden !important; }' });
        await page.locator('#sb_conversation_input').fill('Keep this draft while I look at pictures.');
        const timeline = await page.locator('#sb_conversation_timeline').innerText();
        const rail = page.locator('#neconyan-workspace-rail [data-neconyan-route="gallery"]');
        const gallery = page.locator('#qig-gallery-popup');
        const screenshots = new URL('../screenshots/', import.meta.url);
        await mkdir(screenshots, { recursive: true });
        const screenshot = async name => {
            const path = new URL(`gallery-${layout}-${name}-after.png`, screenshots).pathname;
            await page.screenshot({ path });
            await info.attach(name, { path, contentType: 'image/png' });
        };
        if (phone) await page.locator('#sb-hamburger').click();
        await expect(rail).toBeVisible();
        await screenshot('workspace');
        await rail.click();
        await expect(gallery).toBeVisible();
        await expect(page.locator('#qig-gallery-empty')).toBeVisible();
        await expect(page.locator('body')).not.toHaveClass(/neconyan-rail-drawer-open/);
        const bounds = await gallery.locator('.qig-popup-content').boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(phone ? 394 : 1281);
        await screenshot('empty');
        await gallery.getByRole('button', { name: 'Close dialog', exact: true }).click();
        await expect(gallery).toBeHidden();
        await expect(phone ? page.locator('#sb-hamburger') : rail).toBeFocused();
        await expect(page.locator('#sb_conversation_input')).toHaveValue('Keep this draft while I look at pictures.');
        await expect(page.locator('#sb_conversation_timeline')).toHaveText(timeline, { useInnerText: true });

        await page.evaluate(() => window.NeconyanShell.openGlobalSearch());
        await page.locator('#sb-universal-search-input').fill('Gallery');
        const result = page.locator('.sb-search-result').filter({ has: page.getByText('Gallery', { exact: true }) });
        await expect(result).toHaveCount(1);
        await screenshot('search');
        await result.click();
        await expect(gallery).toBeVisible();
        const image = await readFile(new URL('../public/img/ai4.png', import.meta.url));
        await page.locator('#qig-gallery-import-url').fill(`data:image/png;base64,${image.toString('base64')}`);
        await page.locator('#qig-gallery-import-add').click();
        await expect(gallery.locator('.qig-gallery-card')).toHaveCount(1);
        await expect(page.locator('#qig-gallery-empty')).toBeHidden();
        await screenshot('saved');
        await page.keyboard.press('Escape');
        await expect(gallery).toBeHidden();

        // Set the real preference control, then exercise the resulting top-bar button.
        await page.locator('#sb-shortcut-left-select').evaluate(select => {
            select.value = 'action:gallery';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        const shortcut = page.locator('#sb-shortcut-left');
        await expect(shortcut).toHaveAccessibleName('Quick access: Gallery');
        await shortcut.click();
        await expect(gallery.locator('.qig-gallery-card')).toHaveCount(1);
        await gallery.locator('.qig-gallery-card').click();
        await expect(page.locator('#qig-result-img')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(shortcut).toBeFocused();
        await expect(page.locator('#sb_conversation_input')).toHaveValue('Keep this draft while I look at pictures.');
        expect(app.provider.calls).toHaveLength(0);

        // The saved gallery survives a page reload and is shared with the existing settings button.
        await page.reload();
        await page.waitForFunction(() => document.querySelector('#qig-gallery-settings-btn'));
        await page.evaluate(() => window.NeconyanShell.openIncludedTool('quick-image-gen'));
        await page.locator('#qig-gallery-settings-btn').click();
        await expect(gallery.locator('.qig-gallery-card')).toHaveCount(1);
    });

    test(`${layout} Gallery preserves the open tool and offers prompt controls without generating`, async ({ app }) => {
        const calls = [];
        const image = (await readFile(new URL('../public/img/ai4.png', import.meta.url))).toString('base64');
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(saved) {
            saved.extension_settings['quick-image-gen'] = {
                _syncCacheId: randomUUID(), setupWizardSeen: true, provider: 'gptimage',
                useLastMessage: false, useLLMPrompt: false, twoStepPrompt: false,
                appendQuality: false, useSTStyle: false, useWorldInfo: false,
                reviewBeforeGenerate: false, autoInsert: false, batchCount: 1,
                gptImageProxyUrl: 'https://image-proxy.example.test/v1',
                gptImageProxyKey: 'fixture-key', gptImageModel: 'gpt-image-2.6-sunburst',
            };
        } });
        if (phone) await installIPhoneSafari(account.context);
        await account.context.route('https://image-proxy.example.test/**', async route => {
            calls.push(route.request().url());
            await route.fulfill({ json: { object: 'response', status: 'completed', output: [
                { type: 'image_generation_call', status: 'completed', result: image },
            ] } });
        });
        const page = await account.open({ workspace: false });
        await page.waitForFunction(() => document.querySelector('#qig-gallery-settings-btn'));
        await page.evaluate(() => window.NeconyanShell.openIncludedTool('quick-image-gen'));
        if (phone) await applyIOSOnlyCss(page);
        const prompt = page.locator('#qig-prompt');
        await prompt.fill('Keep this picture prompt.');
        if (phone) await page.locator('#sb-hamburger').click();
        await page.locator('[data-neconyan-route="gallery"]').click();
        await expect(page.locator('#qig-gallery-popup')).toBeVisible();
        await expect(prompt).toBeVisible();
        const url = page.locator('#qig-gallery-import-url');
        if (phone) await url.tap();
        else await url.click();
        await page.keyboard.press('Escape');
        await expect(prompt).toBeVisible();
        await expect(prompt).toHaveValue('Keep this picture prompt.');
        await page.locator('#sb-shortcut-left-select').evaluate(select => {
            select.value = 'action:gallery';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.locator('#sb-shortcut-left').click();
        await expect(page.locator('#qig-gallery-popup')).toBeVisible();
        await page.locator('#qig-gallery-popup .qig-close-btn').click();
        await expect(prompt).toBeVisible();
        await page.locator('#qig-gallery-settings-btn').click();
        await page.locator('#qig-gallery-generate').click();
        await expect(page.locator('#qig-gallery-popup')).toBeHidden();
        await expect(page.locator('#qig-prompt')).toBeVisible();
        await expect(page.locator('#qig-prompt')).toBeFocused();
        expect(app.provider.calls).toHaveLength(0);
        expect(calls).toHaveLength(0);
        await page.locator('#qig-generate-btn').click();
        await expect(page.locator('#qig-result-img')).toBeVisible();
        expect(calls).toHaveLength(1);
    });
}

test('Gallery sends a switched-off Quick Image Gen to Extensions', async ({ app }) => {
    const account = await app.account({ configureSettings(saved) {
        saved.extension_settings.disabledExtensions = [...new Set([...(saved.extension_settings.disabledExtensions || []), 'quick-image-gen'])];
    } });
    const page = await account.open({ workspace: false });
    const rail = page.locator('[data-neconyan-route="gallery"]');
    await expect(rail).toHaveClass(/is-off/);
    await rail.click();
    await expect(page.locator('#extensions_details')).toBeVisible();
    await expect(page.locator('#qig-gallery-popup')).toHaveCount(0);
    expect(app.provider.calls).toHaveLength(0);
});
