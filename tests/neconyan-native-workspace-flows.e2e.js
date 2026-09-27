/* global document, window */
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(120000);

async function ready(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
    if (await skip.isVisible()) await skip.click();
}

async function open(page, side, tab) {
    await page.evaluate(({ side, tab }) => window.NeconyanShell.openTab(side, tab), { side, tab });
}

async function requestHeaders(page) {
    return page.evaluate(() => window.SillyTavern.getContext().getRequestHeaders());
}

test('native character library preserves a failed edit and saves the card without losing imported metadata', async ({ page }, info) => {
    page.setDefaultTimeout(15000);
    await page.setViewportSize({ width: 1024, height: 900 });
    await ready(page);
    const api = page.request;
    const headers = await requestHeaders(page);
    const name = `Native card ${Date.now()}`;
    const response = await api.post('/api/characters/create', { headers, data: {
        ch_name: name, description: 'Original description', first_mes: 'A saved greeting.',
        json_data: JSON.stringify({ data: { extensions: { foreign: { keep: 'card metadata' } } } }),
    } });
    expect(response.ok()).toBe(true);
    const avatar = await response.text();
    let rejectEdits = true;
    try {
        await ready(page);
        await open(page, 'characters', 'characters');
        await page.locator('#character_search_bar').fill(name);
        const row = page.locator('#rm_print_characters_block .character_select').filter({ hasText: name });
        await expect(row).toHaveCount(1);
        await row.locator('[data-entity-action="edit-card"]').click();
        await page.locator('#sb_character_editor_tab_char_info').click();
        await page.route('**/api/characters/edit', route => rejectEdits
            ? route.fulfill({ status: 503, body: 'Temporary save failure' }) : route.continue());
        await page.locator('#description_textarea').fill('Edited in the native workspace.');
        await expect(page.locator('#sb_character_save_status')).toHaveAttribute('data-save-status', 'error');
        await page.locator('#rm_button_back').click();
        await row.locator('[data-entity-action="edit-card"]').click();
        await expect(page.locator('#description_textarea')).toBeVisible();
        await expect(page.locator('#description_textarea')).toHaveValue('Edited in the native workspace.');
        await expect(page.locator('#form_create')).toHaveAttribute('actiontype', 'editcharacter');
        rejectEdits = false;
        await page.locator('#create_button_label').click();
        await expect(page.locator('#sb_character_save_status')).toHaveAttribute('data-save-status', 'saved');
        const saved = await (await api.post('/api/characters/get', { headers, data: { avatar_url: avatar } })).json();
        expect(saved.data).toMatchObject({ description: 'Edited in the native workspace.', first_mes: 'A saved greeting.', extensions: { foreign: { keep: 'card metadata' } } });
        await page.locator('#rm_button_back').click();
        for (const width of [1280, 1024, 997, 768, 390, 320]) {
            await page.setViewportSize({ width, height: 900 });
            await open(page, 'characters', 'characters');
            const heading = page.locator('#right-nav-panel > .sb-character-shell-header .sb-shell-title');
            if (width > 768) {
                await expect(heading, `Character heading at ${width}px`).toBeVisible();
                const title = await heading.boundingBox();
                expect(title.width).toBeGreaterThan(60);
                expect(title.height).toBeGreaterThan(12);
            } else {
                // Phone sheets deliberately replace the large header with the close
                // control and labelled tabs (neconyan.css's phone shell rules).
                await expect(heading).toBeHidden();
                const close = page.locator('#right-nav-panel > .sb-character-shell-header .sb-shell-close');
                await expect(close).toBeVisible();
                const bounds = await close.boundingBox();
                expect(bounds.width).toBeGreaterThanOrEqual(44);
                expect(bounds.height).toBeGreaterThanOrEqual(44);
            }
            await expect(page.locator('#character_search_bar')).toBeVisible();
            await expect(row.locator('[data-entity-action="edit-card"]')).toBeVisible();
            const clipped = await page.locator('#rm_print_characters_block > .character_select').evaluateAll(rows => rows.flatMap(row => {
                const bounds = row.getBoundingClientRect();
                return [...row.querySelectorAll('.sb-entity-action')].filter(action => {
                    const button = action.getBoundingClientRect();
                    return button.height && (button.top < bounds.top - 1 || button.bottom > bounds.bottom + 1);
                }).map(action => action.textContent);
            }));
            expect(clipped).toEqual([]);
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
            await page.evaluate(() => window.toastr?.remove());
            await page.screenshot({ path: info.outputPath(`characters-${width}.png`) });
        }
        await row.locator('[data-entity-action="open-chat"]').click();
        await expect(page.locator('#chat')).toContainText('A saved greeting.');
    } finally {
        await page.close();
        await api.post('/api/characters/delete', { headers, data: { avatar_url: avatar, delete_chats: true } });
    }
});

test('native Model connections create, update, reload and delete a saved profile', async ({ page }, info) => {
    page.setDefaultTimeout(15000);
    await page.setViewportSize({ width: 1024, height: 900 });
    await ready(page);
    const api = page.request;
    const headers = await requestHeaders(page);
    const settings = async () => JSON.parse((await (await api.post('/api/settings/get', { headers, data: {} })).json()).settings);
    const original = await settings();
    const name = `Native connection ${Date.now()}`;
    let profileId;
    try {
        await open(page, 'left', 'api');
        await page.locator('#main_api').selectOption('openai');
        await page.locator('#chat_completion_source').selectOption('custom');
        await page.locator('#custom_api_url_text').fill('http://127.0.0.1:1/v1');
        await page.locator('#custom_model_id').fill('native-model-one');
        await page.locator('#create_connection_profile').click();
        const popup = page.locator('dialog.popup[open]').last();
        await popup.getByRole('textbox').fill(name);
        await popup.locator('.popup-button-ok').click();
        await expect.poll(async () => (await settings()).extension_settings.connectionManager.profiles.some(profile => profile.name === name)).toBe(true);
        profileId = (await settings()).extension_settings.connectionManager.profiles.find(profile => profile.name === name).id;
        await page.locator('#custom_model_id').fill('native-model-two');
        await page.locator('#update_connection_profile').click();
        await expect.poll(async () => (await settings()).extension_settings.connectionManager.profiles.find(profile => profile.id === profileId)?.model).toBe('native-model-two');
        await ready(page);
        await open(page, 'left', 'api');
        await expect(page.locator('#connection_profiles')).toHaveValue(profileId);
        await expect(page.locator('#custom_model_id')).toHaveValue('native-model-two');
        for (const width of [1280, 1024, 997, 768, 390, 320]) {
            await page.setViewportSize({ width, height: 900 });
            await expect(page.locator('#create_connection_profile')).toBeVisible();
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
            await page.evaluate(() => window.toastr?.remove());
            await page.screenshot({ path: info.outputPath(`model-${width}.png`) });
        }
        await page.locator('.neconyan-connection-management > summary').click();
        await page.locator('#delete_connection_profile').click();
        await page.locator('dialog.popup[open]').last().locator('.popup-button-ok').click();
        await expect.poll(async () => (await settings()).extension_settings.connectionManager.profiles.some(profile => profile.id === profileId)).toBe(false);
    } finally {
        await page.close();
        const current = await settings();
        for (const key of ['main_api', 'oai_settings', 'custom_endpoint_presets', 'selected_custom_endpoint_preset']) current[key] = original[key];
        current.extension_settings.connectionManager = original.extension_settings.connectionManager;
        expect((await api.post('/api/settings/save', { headers, data: current })).ok()).toBe(true);
    }
});
