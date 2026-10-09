/* global window, document, getComputedStyle */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { acknowledgeSettingsSave } from './chat-scroll-regression-helpers.js';
import { createMockRoleplayStore } from './roleplay-browser-fixture.js';

const avatar = fileURLToPath(new URL('../public/img/neconyan-character.png', import.meta.url));
const theme = JSON.parse(readFileSync(new URL('../default/content/themes/Neconyan Calico Dark.json', import.meta.url), 'utf8'));
const requestJson = request => JSON.parse((request.headers()['content-encoding'] === 'gzip'
    ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer()).toString());

async function fixture(page, palette = theme) {
    let envelope, settings;
    const storage = createMockRoleplayStore(() => envelope.roleplayAccount);
    const character = { name: 'Mira and Sol', avatar: 'mira-and-sol.png', chat: 'expressions-workspace', first_mes: 'Mira: Hello!',
        mes_example: '', shallow: false, tags: [], data: { name: 'Mira and Sol', first_mes: 'Mira: Hello!',
            description: 'Mira has silver hair. Sol has red hair.', extensions: {} } };
    const state = { character, errors: [], folders: [], failSave: false };
    page.on('pageerror', error => state.errors.push(error.message));
    await page.route('**/api/settings/get', async route => {
        envelope ??= await (await route.fetch()).json();
        settings ??= JSON.parse(envelope.settings);
        settings.firstRun = false;
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        Object.assign(settings.power_user, palette, { theme: palette.name, chat_display: 6 });
        settings.extension_settings.expressions = { ...settings.extension_settings.expressions, api: 99, showDefault: true };
        settings.extension_settings.disabledExtensions = (settings.extension_settings.disabledExtensions ?? []).filter(id => id !== 'expressions');
        await route.fulfill({ json: { ...envelope, settings: JSON.stringify(settings) } });
    });
    await page.route('**/api/settings/save', async route => {
        settings = requestJson(route.request());
        await acknowledgeSettingsSave(route);
        settings._settingsRevision = Number(settings._settingsRevision || 0) + 1;
    });
    await page.route('**/api/characters/all', route => route.fulfill({ json: [character] }));
    await page.route('**/api/characters/chats', route => route.fulfill({ json: [{ file_name: character.chat, message_count: 1 }] }));
    await page.route('**/api/characters/edit-attribute', route => route.fulfill({ json: {} }));
    await page.route('**/api/characters/merge-attributes', route => {
        if (state.failSave) return route.fulfill({ status: 500, json: {} });
        Object.assign(character.data.extensions, requestJson(route.request()).data.extensions);
        return route.fulfill({ json: {} });
    });
    await page.route('**/api/groups/all', route => storage.readGroups(route, []));
    await page.route('**/api/chats/get', route => storage.read(route));
    await page.route('**/api/chats/save', route => storage.save(route));
    await page.route('**/api/sprites/get?**', route => {
        const folder = new URL(route.request().url()).searchParams.get('name');
        state.folders.push(folder);
        return route.fulfill({ json: ['joy', 'neutral'].map(label => ({ label, path: `/characters/${folder}/${label}.png` })) });
    });
    await page.route(url => url.pathname.startsWith('/characters/'), route => route.fulfill({ path: avatar }));
    await page.route('**/thumbnail?**', route => route.fulfill({ path: avatar }));
    await page.addLocatorHandler(page.locator('#qig-setup-wizard'), async locator => {
        await locator.getByText('Skip', { exact: true }).click();
    });
    await page.addLocatorHandler(page.locator('.neconyan-tool-tour-invite:visible').first(), async locator => {
        await locator.getByRole('button', { name: 'Not now', exact: true }).click();
    });
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext().characters.length && window.NeconyanShell?.openExtensionSettings);
    await page.evaluate(async () => {
        await window.SillyTavern.getContext().selectCharacterById(0, { switchMenu: false });
        window.NeconyanShell.openExtensionSettings('expressions');
    });
    await expect(page.locator('#expression_api')).toBeVisible();
    return state;
}

async function inputPopup(page, value) {
    const popup = page.locator('dialog[open]').last();
    await popup.locator('.popup-input').fill(value);
    await popup.locator('.popup-button-ok').click();
}

async function addMember(page, name) {
    await page.locator('#expression_member_add').click();
    await inputPopup(page, name);
    await expect(page.locator('#expression_member option:checked')).toHaveText(name);
    return page.locator('#expression_member').inputValue();
}

for (const [name, phone] of [['desktop', false], ['phone', true]]) {
    test.describe(`${name}`, () => {
        test.use({ serviceWorkers: 'block', viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 },
            hasTouch: phone, isMobile: phone, reducedMotion: 'reduce' });
        test.setTimeout(120000);
        test('expression workspace', async ({ page }) => {
            const state = await fixture(page);
            await expect(page.locator('#image_list .expression_list_item').first()).toBeVisible();
            await page.locator('#expression_add_many').click();
            await inputPopup(page, 'sleepy, joy-soft\nsurprised_2, sleepy');
            await expect(page.locator('#image_list [data-expression="joy-soft"]')).toHaveCount(1);
            await page.locator('#expression_search').fill('sleepy');
            await expect(page.locator('#image_list .expression_list_item:visible')).toHaveCount(1);
            await page.locator('#expression_visibility').selectOption('ready');
            await expect(page.locator('#image_list .expression_list_item:visible')).toHaveCount(0);
            await page.locator('#expression_search').fill('');
            await page.locator('#expression_visibility').selectOption('all');

            const mira = await addMember(page, 'Mira');
            await page.locator('#expression_member_details summary').click();
            await page.locator('#expression_member_description').fill('Silver hair, green eyes and a white coat.');
            await page.locator('#expression_member_save').click();
            await expect.poll(() => state.character.data.extensions.expression_sets?.members[0]?.description).toContain('Silver hair');
            const sol = await addMember(page, 'Sol');
            expect(sol).not.toBe(mira);
            const sets = state.character.data.extensions.expression_sets;
            expect(new Set(sets.members.map(member => member.folder)).size).toBe(2);
            await page.locator('#expression_member').selectOption(mira);
            await expect(page.locator('#expression_member_description')).toHaveValue('Silver hair, green eyes and a white coat.');
            await expect.poll(() => state.folders.at(-1)).toBe(sets.members[0].folder);
            state.failSave = true;
            await page.locator('#expression_member').selectOption(sol);
            await expect(page.locator('.toast-error').last()).toContainText('Could not save');
            await expect(page.locator('#expression_member')).toHaveValue(mira);
            state.failSave = false;
            await page.locator('#expression_member_auto').check();
            await expect.poll(() => state.character.data.extensions.expression_sets.auto).toBe(true);
            // Only an explicitly named speaker selects the other member.
            await page.evaluate(() => { window.SillyTavern.getContext().chat.at(-1).mes = 'Sol: Good evening.'; });
            await expect(page.locator('#expression_member')).toHaveValue(sol, { timeout: 10000 });
            await expect(page.locator('#image_list_header_name')).toHaveText(sets.members[1].folder);
            await page.locator('#expression_member').selectOption(mira);
            await expect.poll(() => state.character.data.extensions.expression_sets.auto).toBe(false);
            await page.reload();
            await page.waitForFunction(() => window.SillyTavern?.getContext().characters.length && window.NeconyanShell?.openExtensionSettings);
            await page.evaluate(async () => {
                await window.SillyTavern.getContext().selectCharacterById(0, { switchMenu: false });
                window.NeconyanShell.openExtensionSettings('expressions');
            });
            await expect(page.locator('#expression_member')).toHaveValue(mira);
            await expect(page.locator('#image_list [data-expression="surprised_2"]')).toHaveCount(1);
            await page.locator('#expression_member_details').evaluate(element => { element.open = false; });
            await page.locator('#expression_member').scrollIntoViewIfNeeded();
            await page.screenshot({ path: `../screenshots/expressions-${name}-${process.env.EXPRESSIONS_SCREENSHOT_PHASE || 'after'}.png` });
            expect(state.errors).toEqual([]);
        });

        for (const light of [false, true]) {
            test(`buttons fit and retain contrast in ${light ? 'light' : 'dark'} colours`, async ({ page }) => {
                const palette = light ? JSON.parse(readFileSync(new URL('../default/content/themes/Neconyan Calico.json', import.meta.url), 'utf8')) : theme;
                await fixture(page, palette);
                await addMember(page, 'Mira');
                await page.locator('#expression_member_details summary').click();
                for (const accent of [null, 'Pearl', 'Midnight Ink']) {
                    if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
                    for (const id of ['expression_add_many', 'expression_member_save', 'expression_member_add', 'expression_member_remove']) {
                        const button = page.locator(`#${id}`);
                        await button.scrollIntoViewIfNeeded();
                        for (const hover of [false, true]) {
                            if (hover) await button.hover();
                            else await page.locator('#expression_member').hover();
                            const result = await button.evaluate(async element => {
                                const { contrastRatio } = await import('/scripts/theme-contrast.js');
                                const ctx = document.createElement('canvas').getContext('2d');
                                const channels = colour => {
                                    ctx.fillStyle = colour;
                                    ctx.fillRect(0, 0, 1, 1);
                                    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
                                };
                                const style = getComputedStyle(element), box = element.getBoundingClientRect();
                                return { contrast: contrastRatio(channels(style.color), channels(style.backgroundColor)),
                                    height: box.height, left: box.left, right: box.right, viewport: window.innerWidth };
                            });
                            expect(result.contrast, `${id}: ${accent}, hover ${hover}`).toBeGreaterThanOrEqual(4.5);
                            expect(result.height).toBeGreaterThanOrEqual(44);
                            expect(result.left).toBeGreaterThanOrEqual(0);
                            expect(result.right).toBeLessThanOrEqual(result.viewport);
                        }
                    }
                }
            });
        }
    });
}
