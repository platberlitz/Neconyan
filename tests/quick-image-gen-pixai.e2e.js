/* global document, window */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

test.setTimeout(120000);

const TSUBAKI_3 = '2024383379556065549';
const HARUKA = '1861558740588989558';
const MEDIA_ID = '1943547603237249965';
const IMAGE_URL = 'https://images-ng.pixai.art/images/orig/0f6a0d1c-2a39-4f10-9b9e-4c3f1d2e5a7b';
const OFFSITE_URL = 'https://storage.example/pixai-result.png';
const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
};

// Steps sits in another settings tab; the provider decides whether its field is offered at all.
const stepsFieldShown = page => page.locator('#qig-steps').evaluate(input => input.closest('.qig-field')?.style.display !== 'none');

for (const [layout, phone] of [['desktop', false], ['phone', true]]) {
    test(`${layout} Quick Image Gen recovers a PixAI image with Tsubaki.3 by default`, async ({ app }, info) => {
        const png = await readFile(new URL('../public/img/ai4.png', import.meta.url));
        const api = [];
        const images = [];
        const offsite = [];
        let polls = 0;
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(saved) {
            saved.extension_settings['quick-image-gen'] = {
                _syncCacheId: randomUUID(),
                provider: 'pixai', setupWizardSeen: true, useLastMessage: false, useLLMPrompt: false,
                twoStepPrompt: false, appendQuality: false, useSTStyle: false, useWorldInfo: false,
                reviewBeforeGenerate: false, autoInsert: false, batchCount: 1,
                pixaiKey: 'fixture-pixai-key', width: 832, height: 1216, seed: 77, negativePrompt: 'blurry',
            };
        } });
        if (phone) await installIPhoneSafari(account.context);
        await account.context.route('https://api.pixai.art/**', async route => {
            const request = route.request();
            if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
            const url = new URL(request.url());
            api.push({ method: request.method(), path: `${url.pathname}${url.search}`,
                authorization: request.headers().authorization, body: request.method() === 'POST' ? request.postDataJSON() : null });
            if (url.pathname === '/v2/image/create') {
                return route.fulfill({ status: 201, headers: CORS, json: { id: 'task-1', status: 'waiting', outputs: { mediaIds: [], mediaUrls: [] } } });
            }
            if (url.pathname === '/v2/task/task-1') {
                polls += 1;
                if (polls === 1) return route.fulfill({ status: 404, headers: CORS, json: { code: 'NOT_FOUND', status: 404, message: 'Task not found' } });
                if (polls === 2) return route.fulfill({ headers: CORS, json: { id: 'task-1', status: 'running' } });
                return route.fulfill({ headers: CORS, json: { id: 'task-1', status: 'completed', outputs: { seed: '77', mediaIds: [MEDIA_ID], mediaUrls: [OFFSITE_URL] } } });
            }
            if (url.pathname === '/v2/media/batch') {
                return route.fulfill({ headers: CORS, json: [{ id: MEDIA_ID, type: 'IMAGE', urls: [{ variant: 'PUBLIC', url: IMAGE_URL }] }] });
            }
            return route.fulfill({ status: 404, headers: CORS, json: { code: 'NOT_FOUND', status: 404, message: 'Unexpected path' } });
        });
        await account.context.route(OFFSITE_URL, route => {
            offsite.push(route.request().url());
            return route.abort();
        });
        await account.context.route('https://images-ng.pixai.art/**', async route => {
            images.push({ url: route.request().url(), authorization: route.request().headers().authorization });
            await route.fulfill({ headers: { 'access-control-allow-origin': '*', 'content-type': 'image/png' }, body: png });
        });

        const page = await account.open({ workspace: false });
        await page.evaluate(() => window.NeconyanShell.openTab('right', 'extensions'));
        await page.waitForFunction(() => window.NeconyanExtensions && document.querySelector('#qig-settings'));
        if (phone) await applyIOSOnlyCss(page);
        await page.evaluate(() => window.NeconyanExtensions.focusUnit('Quick Image Gen'));
        await expect(page.locator('#qig-settings')).toBeVisible();

        if (!await page.locator('#qig-section-provider-content').isVisible()) await page.locator('#qig-tab-provider').click();
        const section = page.locator('#qig-pixai-settings');
        await expect(section).toBeVisible();
        await expect(page.locator('#qig-provider')).toHaveValue('pixai');
        await expect(section.locator('#qig-pixai-key')).toHaveAttribute('type', 'password');
        const model = section.locator('#qig-pixai-model');
        await expect(model).toHaveValue(TSUBAKI_3);
        await expect(model.locator('option').first()).toHaveText('Tsubaki.3 (default)');
        const mode = section.locator('#qig-pixai-mode');
        await expect(mode).toBeVisible();
        await expect(mode.locator('option')).toHaveCount(2);
        expect(await mode.locator('option').evaluateAll(options => options.map(option => option.value))).toEqual(['pro', 'ultra']);
        await expect(mode).toHaveValue('pro');
        await expect(section.locator('#qig-pixai-prompt-helper')).toHaveValue('disable');
        await expect(section.locator('#qig-pixai-custom-model')).toBeHidden();
        await expect.poll(() => stepsFieldShown(page)).toBe(false);

        await model.selectOption(HARUKA);
        await expect(mode).toBeHidden();
        await expect.poll(() => stepsFieldShown(page)).toBe(true);
        await model.selectOption('custom');
        await expect(section.locator('#qig-pixai-custom-model')).toBeVisible();
        await expect(section.locator('#qig-pixai-custom-model')).toHaveValue(HARUKA);
        await model.selectOption(TSUBAKI_3);
        await expect(section.locator('#qig-pixai-custom-model')).toBeHidden();
        await expect(mode).toBeVisible();
        await expect(mode).toHaveValue('pro');
        await expect.poll(() => stepsFieldShown(page)).toBe(false);
        const sectionBox = await section.boundingBox();
        expect(sectionBox.x).toBeGreaterThanOrEqual(0);
        expect(sectionBox.x + sectionBox.width).toBeLessThanOrEqual(phone ? 394 : 1281);
        await info.attach(`${layout}-pixai-settings`, { body: await section.screenshot(), contentType: 'image/png' });

        await page.locator('#qig-prompt').fill('A calico cat reading by a window.');
        await page.locator('#qig-generate-btn').click();
        await expect(page.locator('#qig-result-img')).toBeVisible({ timeout: 45000 });
        await expect.poll(() => page.locator('#qig-result-img').evaluate(img => img.complete && img.naturalWidth > 1)).toBe(true);

        const created = api.filter(call => call.path === '/v2/image/create');
        expect(created).toHaveLength(1);
        expect(created[0].body).toEqual({
            modelVersionId: TSUBAKI_3, prompt: expect.stringContaining('A calico cat reading by a window.'),
            negativePrompt: expect.stringContaining('blurry'), aspectRatio: '2:3', size: '1k', mode: 'pro',
            promptHelper: 'disable', batchSize: 1, seed: 77,
        });
        expect(api.map(call => call.path)).toEqual([
            '/v2/image/create', '/v2/task/task-1', '/v2/task/task-1', '/v2/task/task-1', `/v2/media/batch?ids=${MEDIA_ID}`,
        ]);
        expect(api.every(call => call.authorization === 'Bearer fixture-pixai-key')).toBe(true);
        expect(offsite).toEqual([]);
        expect(images.length).toBeGreaterThanOrEqual(1);
        expect(images.every(call => call.url === IMAGE_URL && call.authorization === undefined)).toBe(true);
        await info.attach(`${layout}-pixai-result`, { body: await page.screenshot(), contentType: 'image/png' });
    });
}
