/* eslint-env browser */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

for (const phone of [true, false]) {
    test(`Nano-GPT recall presets save and reopen on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        const account = await app.account({ phone });
        const initial = (await account.post('/api/mewmory/config/get')).config;
        initial.sharedProfileId = 'durable';
        Object.assign(initial.roles.selector, { enabled: true, useShared: true, endpoint: 'https://openrouter.ai/api/alpha/decisions', apiKey: 'old-provider-test-key' });
        await account.post('/api/mewmory/config/save', { config: initial });
        const page = await account.open({ workspace: false });
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
        const workspace = page.locator('#mewmory-workspace');
        const preset = workspace.getByLabel('Recall decision model', { exact: true });
        await expect(preset.locator('option[value^="nanogpt-"]')).toHaveCount(20);
        await preset.selectOption('nanogpt-jev-1.14');
        await expect(preset).toHaveValue('nanogpt-jev-1.14');
        await expect(workspace.getByLabel('Selector endpoint', { exact: true })).toHaveValue('https://api.nano-gpt.com/api/v1/systemone');
        await expect(workspace.getByLabel('Selector model', { exact: true })).toHaveValue('typesafe/jev-1.14');
        await expect.poll(async () => (await account.post('/api/mewmory/config/get')).config.roles.selector).toMatchObject({
            model: 'typesafe/jev-1.14', useShared: false, profileId: '', hasKey: false,
        });
        await workspace.getByLabel('Selector API key', { exact: true }).fill('nano-test-only-key');
        await workspace.getByLabel('Selector API key', { exact: true }).press('Tab');
        await expect.poll(async () => (await account.post('/api/mewmory/config/get')).config.roles.selector.hasKey).toBe(true);
        await preset.selectOption('nanogpt-kev-9b');
        await expect.poll(async () => (await account.post('/api/mewmory/config/get')).config.roles.selector).toMatchObject({ model: 'jaredpalmer/kev-9b', hasKey: true });
        await preset.selectOption('nanogpt-jev-1.14');
        await workspace.getByRole('tab', { name: 'Settings', exact: true }).click();
        const models = workspace.locator('#mewmory-settings-models');
        if (!await models.evaluate(element => element.open)) await models.locator('summary').first().click();
        await workspace.locator('#mewmory-role-selector').click();
        const detailed = workspace.getByLabel('Jev / decision model preset', { exact: true });
        await expect(detailed).toHaveValue('nanogpt-jev-1.14');
        await workspace.locator('#mewmory-role-fallback').click();
        await detailed.selectOption('nanogpt-d3');
        await expect(detailed).toHaveValue('nanogpt-d3');
        await expect(workspace.locator('#mewmory-settings-status')).toHaveText('Configuration saved.');
        const saved = (await account.post('/api/mewmory/config/get')).config;
        expect(JSON.stringify(saved)).not.toContain('nano-test-only-key');
        expect(saved.roles.selector).toMatchObject({ model: 'typesafe/jev-1.14', endpoint: 'https://api.nano-gpt.com/api/v1/systemone', decisionMode: 'decision', decisionThreshold: 0.5 });
        expect(saved.roles.fallback).toMatchObject({ model: 'vllm-sr/decision-large', endpoint: 'https://api.nano-gpt.com/api/v1/systemone', decisionMode: 'decision' });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
        await workspace.getByRole('tab', { name: 'Now', exact: true }).click();
        await expect(preset).toHaveValue('nanogpt-jev-1.14');
        await workspace.locator('#mewmory-now-quick-controls').evaluate(element => element.scrollIntoView({ block: 'start' }));
        expect(await workspace.evaluate(element => element.scrollWidth > element.clientWidth + 1)).toBe(false);
        await fs.mkdir(path.resolve('../screenshots'), { recursive: true });
        await page.screenshot({ path: path.resolve(`../screenshots/nanogpt-mewmory-after-${phone ? 393 : 1280}.png`) });
    });
}
