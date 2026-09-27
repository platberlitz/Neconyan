/* global window */
import { acknowledgeSettingsSave } from './chat-scroll-regression-helpers.js';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const manifest = JSON.parse(readFileSync(new URL('../default/content/assistants/manifest.json', import.meta.url), 'utf8'));
const variants = manifest.personalities.flatMap(personality => personality.variants.map(variant => ({ ...variant, personality: personality.id, name: personality.name })));

test.use({ serviceWorkers: 'block' });
test.setTimeout(180000);

async function openHome(page) {
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await expect(page.locator('.neconyan-assistant-row')).toHaveCount(3);
    await expect(page.locator('.neconyan-assistant-row').first()).toBeVisible();
}

async function activeAssistant(page) {
    return page.evaluate(() => {
        const context = window.SillyTavern.getContext();
        const character = context.characters[context.characterId];
        return {
            id: character?.data?.extensions?.neconyan_assistant?.id,
            avatar: character?.avatar,
            chatId: context.getCurrentChatId(),
            text: context.chat.map(message => message.mes),
            overrides: context.extensionSettings.expressionOverrides,
        };
    });
}

test('all nine choices open real chats, preserve their chat on repeat, and associate expressions', async ({ page }, testInfo) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.neconyan-assistant-row').first()).toBeVisible({ timeout: 45000 });
    const firstOpen = new Map();
    for (const variant of variants) {
        await openHome(page);
        const row = page.locator(`[data-assistant-personality="${variant.personality}"]`);
        await row.locator(`input[value="${variant.id}"]`).check();
        const action = row.locator('[data-assistant-open]');
        await expect(action).toHaveAccessibleName(`Open ${variant.name}, ${variant.gender[0].toUpperCase() + variant.gender.slice(1)}`);
        const installed = page.waitForResponse(response => response.url().endsWith('/api/characters/assistants/install') && response.request().method() === 'POST');
        await action.press('Enter');
        expect((await installed).ok()).toBe(true);
        await expect(page.locator('body')).not.toHaveClass(/neconyan-home-visible/);
        await expect.poll(async () => (await activeAssistant(page)).id).toBe(variant.id);
        const state = await activeAssistant(page);
        expect(state.chatId).toBeTruthy();
        expect(state.text.length).toBeGreaterThan(0);
        const override = state.overrides.find(value => value.name === state.avatar.replace(/\.png$/i, ''));
        expect(override?.path).toMatch(/^Neconyan Assistants\//);
        const sprites = await page.request.get(`/api/sprites/get?name=${encodeURIComponent(override.path)}`);
        expect(sprites.ok()).toBe(true);
        expect(await sprites.json()).toHaveLength(28);
        firstOpen.set(variant.id, state);
    }
    await openHome(page);
    const repeat = variants[0];
    const row = page.locator(`[data-assistant-personality="${repeat.personality}"]`);
    await row.locator(`input[value="${repeat.id}"]`).check();
    await row.locator('[data-assistant-open]').click();
    await expect(page.locator('body')).not.toHaveClass(/neconyan-home-visible/);
    await expect.poll(async () => (await activeAssistant(page)).id).toBe(repeat.id);
    const reopened = await activeAssistant(page);
    expect(reopened.avatar).toBe(firstOpen.get(repeat.id).avatar);
    expect(reopened.chatId).toBe(firstOpen.get(repeat.id).chatId);
    expect(reopened.text).toEqual(firstOpen.get(repeat.id).text);
    await page.evaluate(() => window.toastr?.remove());
    await page.screenshot({ path: testInfo.outputPath('assistant-chat.png') });
    expect(errors).toEqual([]);
});

for (const width of [320, 390, 1280]) {
    test.describe(`assistant layout at ${width}px`, () => {
        test.use({ viewport: { width, height: 900 }, isMobile: width < 768, hasTouch: width < 768 });
        test('library controls remain clickable through their decorations', async ({ page }, testInfo) => {
            await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
            await page.goto('/', { waitUntil: 'domcontentloaded' });
            await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 45000 });
            const headers = await page.evaluate(() => window.SillyTavern.getContext().getRequestHeaders());
            expect((await page.request.post('/api/characters/assistants/install', { headers, data: { id: 'miso-male' } })).ok()).toBe(true);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 45000 });
            await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
            const importButton = page.locator('#character_import_button');
            // Import's retained host control is hidden in both current layouts.
            await expect(importButton).toBeHidden();
            const createButton = page.locator('#rm_button_create');
            await expect(createButton).toBeVisible();
            const decoration = createButton.locator('.neconyan-whiskers');
            await expect(decoration).toHaveCSS('pointer-events', 'none');
            // The compact library toolbar deliberately hides its decorations.
            await expect(decoration).toBeHidden();
            await Promise.all([page.waitForEvent('filechooser'), importButton.dispatchEvent('click')]);
            await createButton.click();
            await expect(page.locator('#avatar-and-name-block')).toBeVisible();
            await expect(page.locator('#rm_button_back > span')).toHaveText('Cancel');
            await expect(page.locator('#create_button_label > span')).toHaveText('Create character');
            await expect(page.locator('#rm_button_back .neconyan-whiskers')).toHaveText('');
            await expect(page.locator('#create_button_label .neconyan-whiskers')).toHaveText('');
            await expect(page.locator('#rm_button_back .neconyan-whiskers > *')).toHaveCount(4);
            await expect(page.locator('#create_button_label .neconyan-whiskers > *')).toHaveCount(4);
            await expect.poll(() => page.locator('#avatar-and-name-block').evaluate(element => window.getComputedStyle(element, '::before').display)).toBe('block');
            await page.evaluate(() => window.toastr?.remove());
            await page.screenshot({ path: testInfo.outputPath('character-controls.png') });
            await page.locator('#rm_button_back').click();
            await page.locator('#rm_print_characters_block [data-entity-action="edit-card"]').first().click();
            await expect(page.locator('#create_button_label > span')).toHaveText('Save now');
            await expect(page.locator('#rm_button_back > span')).toHaveText('Back to library');
            await expect(page.locator('#rm_button_back .neconyan-whiskers')).toHaveText('');
            await expect(page.locator('#create_button_label .neconyan-whiskers')).toHaveText('');
            await expect(page.locator('#rm_button_back .neconyan-whiskers > *')).toHaveCount(4);
            await expect(page.locator('#create_button_label .neconyan-whiskers > *')).toHaveCount(4);
            await page.evaluate(() => window.toastr?.remove());
            await page.screenshot({ path: testInfo.outputPath('character-edit-controls.png') });
        });
        for (const tone of ['Dark', 'Light']) {
            test(`${tone} has readable choices and contained controls`, async ({ page }, testInfo) => {
                const filename = tone === 'Dark' ? 'Neconyan Calico Dark.json' : 'Neconyan Calico.json';
                const { name, ...theme } = JSON.parse(readFileSync(new URL(`../default/content/themes/${filename}`, import.meta.url), 'utf8'));
                await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
                await page.route('**/api/settings/get', async route => {
                    const response = await route.fetch();
                    const data = await response.json();
                    const settings = JSON.parse(data.settings);
                    Object.assign(settings.power_user, theme, { theme: name });
                    data.settings = JSON.stringify(settings);
                    await route.fulfill({ response, json: data });
                });
                await page.goto('/', { waitUntil: 'domcontentloaded' });
                const row = page.locator('.neconyan-assistant-row').first();
                await expect(row).toBeVisible({ timeout: 45000 });
                await row.locator('input[data-gender="neutral"]').check();
                await expect(row.locator('[data-assistant-open]')).toBeEnabled();
                await expect(row.locator('[data-assistant-open]')).toHaveCSS('background-image', /linear-gradient/);
                await expect(row.locator('[data-assistant-open]')).toHaveCSS('border-top-left-radius', '28px');
                await row.locator('[data-assistant-open]').hover();
                await expect(row.locator('[data-assistant-open]')).toHaveCSS('background-image', /linear-gradient/);
                await row.scrollIntoViewIfNeeded();
                await page.evaluate(() => window.toastr?.remove());
                const geometry = await row.evaluate(element => {
                    const bounds = element.getBoundingClientRect();
                    return Array.from(element.querySelectorAll('label, button')).map(control => {
                        const box = control.getBoundingClientRect();
                        const text = control.querySelector('[data-assistant-action-label], span')?.getBoundingClientRect();
                        return { height: box.height, left: box.left - bounds.left, right: bounds.right - box.right, textLeft: text.left - box.left, textRight: box.right - text.right };
                    });
                });
                for (const control of geometry) {
                    expect(control.height).toBeGreaterThanOrEqual(44);
                    expect(control.left).toBeGreaterThanOrEqual(0);
                    expect(control.right).toBeGreaterThanOrEqual(0);
                    expect(control.textLeft).toBeGreaterThanOrEqual(0);
                    expect(control.textRight).toBeGreaterThanOrEqual(0);
                }
                await page.screenshot({ path: testInfo.outputPath('picker.png') });
                await expect(page.locator('body')).toHaveCSS('color-scheme', tone.toLowerCase());
            });
        }
    });
}

test('catalog and install failures keep Home usable and can be retried', async ({ page }) => {
    let catalogCalls = 0;
    await page.route('**/api/characters/assistants', route => ++catalogCalls === 1
        ? route.fulfill({ status: 503, json: { error: 'Unavailable' } }) : route.continue());
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-assistant-catalog-retry]')).toBeVisible({ timeout: 45000 });
    await page.locator('[data-assistant-catalog-retry]').click();
    const row = page.locator('[data-assistant-personality="nori"]');
    await expect(row).toBeVisible();
    await row.locator('input[data-gender="neutral"]').check();
    let installCalls = 0;
    await page.route('**/api/characters/assistants/install', route => ++installCalls === 1
        ? route.fulfill({ status: 503, json: { error: 'Please retry this install.' } }) : route.continue());
    await row.locator('[data-assistant-open]').click();
    await expect(page.locator('[data-assistant-picker-status]')).toContainText('Please retry this install.');
    await expect(row.locator('input[data-gender="neutral"]')).toBeChecked();
    await expect(row.locator('[data-assistant-open]')).toBeEnabled();
    await row.locator('[data-assistant-open]').click();
    await expect(page.locator('body')).not.toHaveClass(/neconyan-home-visible/);
    await expect.poll(async () => (await activeAssistant(page)).id).toBe('nori-neutral');
});
