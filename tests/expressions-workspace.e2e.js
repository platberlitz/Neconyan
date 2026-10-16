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
    const state = { character, errors: [], folders: [], failSave: false, spriteNames: ['joy.png', 'neutral.png'], uploads: [], uploadFolders: [], uploadSizes: [], exports: [], savedSettings: null };
    page.on('pageerror', error => state.errors.push(error.message));
    await page.route('**/api/settings/get', async route => {
        envelope ??= await (await route.fetch()).json();
        settings ??= JSON.parse(envelope.settings);
        settings.firstRun = false;
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        Object.assign(settings.power_user, palette, { theme: palette.name, chat_display: 6 });
        settings.power_user.personas = { 'robin.png': 'Robin', 'robin-alt.png': 'Robin' };
        settings.power_user.persona_descriptions = { 'robin.png': { description: 'Blue eyes and a green coat.' }, 'robin-alt.png': { description: 'Red hair and a blue jacket.' } };
        settings.extension_settings.expressions = { ...settings.extension_settings.expressions, api: 99, showDefault: true };
        settings.extension_settings.disabledExtensions = (settings.extension_settings.disabledExtensions ?? []).filter(id => id !== 'expressions');
        await route.fulfill({ json: { ...envelope, settings: JSON.stringify(settings) } });
    });
    await page.route('**/api/settings/save', async route => {
        settings = requestJson(route.request());
        await acknowledgeSettingsSave(route);
        settings._settingsRevision = Number(settings._settingsRevision || 0) + 1;
        state.savedSettings = structuredClone(settings);
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
        return route.fulfill({ json: state.spriteNames.map(filename => ({ label: filename.split(/[.-]/)[0], path: `/characters/${folder}/${filename}` })) });
    });
    await page.route('**/api/sprites/upload', route => {
        const bytes = route.request().postDataBuffer(), body = bytes.toString();
        const png = bytes.indexOf(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        if (png >= 0) state.uploadSizes.push([bytes.readUInt32BE(png + 16), bytes.readUInt32BE(png + 20)]);
        const spriteName = body.match(/name="spriteName"\r\n\r\n([^\r]+)/)[1];
        state.uploads.push(spriteName);
        state.uploadFolders.push(body.match(/name="name"\r\n\r\n([^\r]+)/)[1]);
        state.spriteNames.push(`${spriteName}.png`);
        return route.fulfill({ json: {} });
    });
    await page.route('**/api/sprites/export', route => {
        state.exports.push(requestJson(route.request()).name);
        return route.fulfill({ contentType: 'application/zip', body: Buffer.from('export download fixture') });
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
            await page.locator('#expression_visibility [data-value="ready"]').click();
            await expect(page.locator('#expression_visibility [data-value="ready"]')).toHaveAttribute('aria-pressed', 'true');
            await expect(page.locator('#image_list .expression_list_item:visible')).toHaveCount(0);
            await expect(page.locator('#expression_count')).not.toBeEmpty();
            await page.locator('#expression_search').fill('');
            await page.locator('#expression_visibility [data-value="missing"]').click();
            await expect(page.locator('#image_list .expression_list_item[data-expression-type="failure"]:visible').first()).toBeVisible();
            await expect(page.locator('#image_list .expression_list_item:not([data-expression-type="failure"]):visible')).toHaveCount(0);
            await page.locator('#expression_visibility [data-value="all"]').click();
            await expect(page.locator('#expression_count')).toBeEmpty();
            await expect(page.locator('#expression_progress_bar')).toHaveAttribute('aria-valuemax', /\d+/);

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

        test('upload suggestions leave custom expression names and existing images intact', async ({ page }) => {
            const state = await fixture(page);
            state.spriteNames.push('joy-1.webp');
            await page.locator('#expression_add_many').click();
            await inputPopup(page, 'joy-1, joy-2');
            await expect(page.locator('#image_list [data-expression="joy-1"][data-expression-type="success"]')).toHaveCount(1);
            await page.locator('#expressions_allow_multiple').check();
            const chooser = page.waitForEvent('filechooser');
            await page.locator('#image_list [data-expression="joy"] .expression_list_upload').click();
            await (await chooser).setFiles({ name: 'another.png', mimeType: 'image/png', buffer: readFileSync(avatar) });
            const popup = page.locator('dialog[open]').last();
            await expect(popup.locator('.popup-input')).toHaveValue('joy-3');
            await popup.locator('.popup-button-ok').click();
            await expect.poll(() => state.uploads).toEqual(['joy-3']);
            await expect(page.locator('#image_list [data-filename="joy-1.webp"]')).toHaveAttribute('data-expression', 'joy-1');
            await expect(page.locator('#image_list [data-filename="joy-3.png"]')).toHaveAttribute('data-expression', 'joy');
            expect(state.errors).toEqual([]);
        });

        test('the delete confirmation names the image instead of [object Object]', async ({ page }) => {
            const state = await fixture(page);
            await page.locator('#image_list [data-filename="joy.png"] .expression_list_delete').click();
            const popup = page.locator('dialog[open]').last();
            await expect(popup.locator('h3')).toHaveText('Delete Expression');
            await expect(popup).toContainText('Are you sure you want to delete this expression?');
            await expect(popup.locator('code')).toHaveText('joy.png');
            await expect(popup).not.toContainText('[object Object]');
            await popup.locator('.popup-button-cancel').click();
            expect(state.errors).toEqual([]);
        });

        test('export downloads the current character set and reports an empty set without leaving the button disabled', async ({ page }) => {
            const state = await fixture(page);
            const download = page.waitForEvent('download');
            await page.locator('#expressions_export_sprites').click();
            expect((await download).suggestedFilename()).toBe('Mira and Sol-expressions.zip');
            expect(state.exports).toEqual(['Mira and Sol']);
            await page.route('**/api/sprites/export', route => route.fulfill({ status: 404 }));
            await page.locator('#expressions_export_sprites').click();
            await expect(page.getByText('This set has no images to export.', { exact: true })).toBeVisible();
            await expect(page.locator('#expressions_export_sprites')).toBeEnabled();
            expect(state.errors).toEqual([]);
        });

        test('persona sets generate, upload, export and retain independent user-message portraits', async ({ page }) => {
            const state = await fixture(page);
            await page.locator('#expression_owner').selectOption('robin.png');
            await expect(page.locator('#expression_member_controls')).toBeHidden();
            await expect(page.locator('#image_list_header_name')).toHaveText('Robin');
            const folder = await page.locator('#image_list').evaluate(element => window.$(element).data('name'));
            expect(folder).toMatch(/^__personas\/[a-f0-9]{64}$/);
            await page.evaluate(async () => {
                const { registerExtensionCapability } = await import('/scripts/neconyan-conversation/extension-capabilities.js');
                window.expressionPrompts = [];
                registerExtensionCapability('quick-image-gen', { ensureReady: async () => {}, getSettingsSnapshot: () => ({}),
                    generateImage: async prompt => { window.expressionPrompts.push(prompt); return { url: '/img/neconyan-character.png' }; } });
            });
            await page.locator('#image_list [data-expression="anger"] .expression_list_generate').click();
            await expect.poll(() => state.uploadFolders).toContain(folder);
            const prompts = await page.evaluate(() => window.expressionPrompts);
            expect(prompts[0]).toContain('Robin');
            expect(prompts[0]).toContain('Blue eyes and a green coat.');
            expect(prompts[0]).not.toContain('Mira has silver hair');
            const download = page.waitForEvent('download');
            await page.locator('#expressions_export_sprites').click();
            expect((await download).suggestedFilename()).toBe('Robin-expressions.zip');
            expect(state.exports).toEqual([folder]);

            await page.evaluate(async () => {
                const core = await import('/script.js');
                await core.sendMessageAsUser('My first reply.', '', null, false, 'Robin', 'robin.png');
            });
            await page.locator('#image_list [data-filename="joy.png"]').click();
            await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chat.at(-1).extra.neconyanExpression?.avatar)).toBe('persona:robin.png');
            await page.evaluate(async () => {
                const core = await import('/script.js');
                await core.sendMessageAsUser('Another reply.', '', null, false, 'Robin', 'robin.png');
                await core.sendMessageAsUser('A different persona.', '', null, false, 'Robin', 'robin-alt.png');
            });
            const history = await page.evaluate(() => window.SillyTavern.getContext().chat.slice(-3).map(message => message.extra.neconyanExpression));
            expect(history[0].src).toBe(`/characters/${folder}/joy.png`);
            expect(history[1]).toEqual(history[0]);
            expect(history[2]).toBeUndefined();
            await page.locator('#expression_owner').selectOption('robin-alt.png');
            await expect.poll(() => page.locator('#image_list').evaluate(element => window.$(element).data('name'))).not.toBe(folder);
            await page.locator('#image_list [data-filename="neutral.png"]').click();
            await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chat.at(-1).extra.neconyanExpression?.avatar)).toBe('persona:robin-alt.png');
            await page.locator('#expression_persona_clear').click();
            await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chat.at(-1).extra.neconyanExpression?.src)).toBeNull();
            await expect.poll(() => state.savedSettings?.extension_settings.expressions.personaSelections?.['robin.png']).toBe(history[0].src);
            await page.locator('#expression_owner').selectOption('robin.png');
            await page.locator('#expression_owner').scrollIntoViewIfNeeded();
            await expect(page.locator('#toast-container .toast')).toHaveCount(0, { timeout: 20000 });
            await page.screenshot({ path: `../screenshots/expressions-persona-${name}-after.png`, animations: 'disabled' });
            await page.reload();
            await page.waitForFunction(() => window.SillyTavern?.getContext().characters.length && window.NeconyanShell?.openExtensionSettings);
            await page.evaluate(async () => {
                await window.SillyTavern.getContext().selectCharacterById(0, { switchMenu: false });
                window.NeconyanShell.openExtensionSettings('expressions');
            });
            await page.locator('#expression_owner').selectOption('robin.png');
            await expect.poll(() => page.locator('#image_list').evaluate(element => window.$(element).data('name'))).toBe(folder);
            await expect(page.locator('#chat .mes[is_user="true"] .neconyan-expression-avatar')).toHaveCount(2);
            await page.locator('#expression_owner').selectOption('');
            await expect(page.locator('#expression_member_controls')).toBeVisible();
            expect(state.errors).toEqual([]);
        });

        test('optional sprite models install explicitly, preserve output size, and stop without publishing failures', async ({ page }) => {
            const state = await fixture(page), installs = [], calls = [];
            let failInstall = true, failProcessing = false, holdProcessing = false, held;
            await page.route('**/api/sprites/models/install', route => {
                installs.push(requestJson(route.request()).kind);
                return route.fulfill({ status: failInstall ? 403 : 200, json: failInstall ? { error: 'Model downloads are disabled in the server configuration.' } : { ok: true } });
            });
            await page.route('**/api/sprites/process?**', async route => {
                const query = new URL(route.request().url()).searchParams;
                const kind = query.get('kind'), width = Number(query.get('width')), height = Number(query.get('height'));
                calls.push(kind);
                if (holdProcessing) { held = route; return; }
                if (failProcessing) return route.fulfill({ status: 500, json: { error: 'The model could not process this image.' } });
                if (kind === 'matting') return route.fulfill({ contentType: 'application/octet-stream', body: Buffer.alloc(width * height, 255) });
                expect(route.request().postDataBuffer().length).toBe(width * height * 4);
                const scale = Number(query.get('scale'));
                return route.fulfill({ contentType: 'application/octet-stream', body: Buffer.alloc(width * height * scale * scale * 4, 150) });
            });
            await page.evaluate(async () => {
                const { registerExtensionCapability } = await import('/scripts/neconyan-conversation/extension-capabilities.js');
                window.expressionPrompts = [];
                registerExtensionCapability('quick-image-gen', { ensureReady: async () => {}, getSettingsSnapshot: () => ({}),
                    generateImage: async prompt => { window.expressionPrompts.push(prompt); return { url: '/img/neconyan-character.png' }; } });
            });
            await page.locator('.expression_generation_options summary').click();
            const background = page.locator('#expressions_agent_sprite_background');
            const matting = page.locator('#expressions_agent_sprite_matting'), upscale = page.locator('#expressions_agent_sprite_upscale');
            await expect(background).toHaveValue('green');
            await expect(matting).not.toBeChecked();
            await expect(upscale).toHaveValue('0');
            expect(installs).toEqual([]);
            await page.locator('#image_list [data-expression="anger"] .expression_list_generate').click();
            await expect.poll(() => state.uploads.length).toBe(1);
            expect(calls).toEqual([]);
            expect((await page.evaluate(() => window.expressionPrompts))[0]).toContain('#00FF00');
            await background.selectOption('magenta');
            await matting.click();
            await expect(page.locator('#expressions_model_status')).toContainText('downloads are disabled');
            await expect(matting).not.toBeChecked();
            failInstall = false;
            await matting.check();
            await expect(matting).toBeEnabled();
            await upscale.selectOption('2');
            await expect(upscale).toBeEnabled();
            expect(installs).toEqual(['matting', 'matting', 'upscale']);
            await page.locator('#image_list [data-expression="caring"] .expression_list_generate').click();
            await expect.poll(() => state.uploads.length).toBe(2);
            expect(calls).toEqual(['matting', 'upscale']);
            expect(state.uploadSizes.at(-1)).toEqual(state.uploadSizes[0].map(size => size * 2));
            expect((await page.evaluate(() => window.expressionPrompts))[1]).toContain('#FF00FF');
            await expect.poll(() => state.savedSettings?.extension_settings.expressions.agentSpriteUpscale).toBe(2);
            await matting.scrollIntoViewIfNeeded();
            await expect(page.locator('#toast-container .toast')).toHaveCount(0, { timeout: 20000 });
            await page.screenshot({ path: `../screenshots/expressions-models-${name}-after.png`, animations: 'disabled' });
            for (const control of [background, upscale]) {
                await control.scrollIntoViewIfNeeded();
                const box = await control.boundingBox();
                expect(box.width).toBeGreaterThan(100);
                expect(box.x).toBeGreaterThanOrEqual(0);
                expect(box.x + box.width).toBeLessThanOrEqual(phone ? 393 : 1280);
            }
            failProcessing = true;
            await page.locator('#image_list [data-expression="fear"] .expression_list_generate').click();
            await expect(page.locator('.toast-error').last()).toContainText('could not process');
            await expect(upscale).toBeEnabled();
            expect(state.uploads).toHaveLength(2);
            failProcessing = false; holdProcessing = true;
            await page.locator('#image_list [data-expression="fear"] .expression_list_generate').click();
            await expect.poll(() => Boolean(held)).toBe(true);
            await page.locator('#expressions_stop_sprite_generation').click();
            await held.abort();
            await expect(upscale).toBeEnabled();
            expect(state.uploads).toHaveLength(2);
            await page.reload();
            await page.waitForFunction(() => window.SillyTavern?.getContext().characters.length && window.NeconyanShell?.openExtensionSettings);
            await page.evaluate(async () => {
                await window.SillyTavern.getContext().selectCharacterById(0, { switchMenu: false });
                window.NeconyanShell.openExtensionSettings('expressions');
            });
            await page.locator('.expression_generation_options summary').click();
            await expect(matting).toBeChecked();
            await expect(upscale).toHaveValue('2');
            expect(installs).toHaveLength(3);
            expect(state.errors).toEqual([]);
        });

        for (const light of [false, true]) {
            test(`buttons fit and retain contrast in ${light ? 'light' : 'dark'} colours`, async ({ page }) => {
                const palette = light ? JSON.parse(readFileSync(new URL('../default/content/themes/Neconyan Calico.json', import.meta.url), 'utf8')) : theme;
                await fixture(page, palette);
                await addMember(page, 'Mira');
                await page.locator('#expression_member_details summary').click();
                for (const accent of [null, 'Pearl', 'Midnight Ink']) {
                    await page.locator('#expression_owner').selectOption('');
                    if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
                    for (const id of ['expression_add_many', 'expressions_export_sprites', 'expression_member_save', 'expression_member_add', 'expression_member_remove', 'expression_persona_clear']) {
                        if (id === 'expression_persona_clear') await page.locator('#expression_owner').selectOption('robin.png');
                        const button = page.locator(`#${id}`);
                        await button.scrollIntoViewIfNeeded();
                        for (const hover of [false, true]) {
                            if (hover) await button.hover();
                            else await page.locator('#expression_owner').hover();
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
