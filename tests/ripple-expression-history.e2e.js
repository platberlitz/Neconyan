/* global window, document, getComputedStyle */
import { acknowledgeSettingsSave } from './chat-scroll-regression-helpers.js';
import { createMockRoleplayStore } from './roleplay-browser-fixture.js';
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const avatar = fileURLToPath(new URL('../public/img/neconyan-character.png', import.meta.url));
const theme = JSON.parse(readFileSync(new URL('../default/content/themes/Neconyan Calico Dark.json', import.meta.url), 'utf8'));
const requestJson = request => JSON.parse((request.headers()['content-encoding'] === 'gzip'
    ? gunzipSync(request.postDataBuffer()) : request.postDataBuffer()).toString());
const first = '/characters/Expression Cat/joy-1.png?t=1';
const second = '/characters/Expression Cat/joy-2.png?t=2';

async function fixture(page, chatStyle = 6) {
    let envelope, settings;
    const storage = createMockRoleplayStore(() => envelope.roleplayAccount);
    const state = { saved: null, saves: 0, savedSettings: null, modelCalls: [], errors: [], groups: [], storage };
    const character = { name: 'Expression Cat', avatar: 'expression-cat.png', chat: 'expression-chat', first_mes: 'Legacy greeting',
        mes_example: '', shallow: false, tags: [], data: { name: 'Expression Cat', first_mes: 'Legacy greeting', description: '', extensions: {} } };
    page.on('pageerror', error => state.errors.push(error.message));
    await page.route('**/api/settings/get', async route => {
        envelope ??= await (await route.fetch()).json();
        settings ??= JSON.parse(envelope.settings);
        settings.firstRun = false;
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', 'NeconyanTutorialIndex.v1': '0' };
        Object.assign(settings.power_user, theme, { theme: theme.name, chat_display: chatStyle, waifuMode: chatStyle === 6, chat_truncation: 50 });
        settings.extension_settings.expressions = { ...settings.extension_settings.expressions, api: 99, showDefault: true };
        settings.extension_settings.disabledExtensions = (settings.extension_settings.disabledExtensions ?? []).filter(id => !['regex', 'expressions'].includes(id));
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
    await page.route('**/api/groups/all', route => storage.readGroups(route, state.groups));
    await page.route('**/api/chats/get', route => storage.read(route));
    await page.route('**/api/chats/save', async route => {
        state.saved = requestJson(route.request()).chat;
        state.saves++;
        await storage.save(route);
    });
    await page.route('**/api/sprites/get?**', route => route.fulfill({ json: [{ label: 'joy', path: first }, { label: 'joy', path: second }] }));
    await page.route(url => url.pathname.startsWith('/characters/'), route => route.fulfill({ path: avatar }));
    await page.route('**/thumbnail?**', route => route.fulfill({ path: avatar }));
    await page.route(/\/api\/.*\/(?:generate|generate-quiet)(?:\?|$)/, async route => {
        state.modelCalls.push(route.request().url());
        await route.fulfill({ status: 503, json: {} });
    });
    await page.goto('/');
    await page.waitForFunction(() => window.SillyTavern?.getContext().characters.length && window.NeconyanShell?.openExtensionSettings);
    await page.evaluate(async () => {
        await window.SillyTavern.getContext().selectCharacterById(0, { switchMenu: false });
    });
    await expect(page.locator('#send_textarea')).toBeVisible();
    return state;
}

async function selectSprite(page, file) {
    await page.evaluate(async file => {
        const { executeSlashCommandsWithOptions } = await import('/scripts/slash-commands.js');
        await executeSlashCommandsWithOptions(`/expression-set type=sprite ${file}`);
    }, file);
}

for (const [name, phone] of [['desktop', false], ['phone', true]]) {
    test.describe(`${name}`, () => {
        test.use({ serviceWorkers: 'block', viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 },
            hasTouch: phone, isMobile: phone,
            ...(phone ? { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' } : {}) });
        test.setTimeout(120000);
        test('optional phone portraits follow saved expressions in every chat style', async ({ page }) => {
            const state = await fixture(page, 0);
            await selectSprite(page, 'joy-1.png');
            await expect(page.locator('#toast-container .toast')).toHaveCount(0, { timeout: 20000 });
            await page.screenshot({ path: `../screenshots/expressions-display-${name}-before.png`, animations: 'disabled' });
            await page.evaluate(() => window.NeconyanShell.openExtensionSettings('expressions'));
            const toggle = page.locator('#expressions_mobile_portraits');
            await expect(toggle).toBeVisible();
            await expect(toggle).not.toBeChecked();
            await toggle.check();
            await page.screenshot({ path: `../screenshots/expressions-display-${name}-setting.png`, animations: 'disabled' });
            await page.evaluate(() => window.NeconyanShell.closeWorkspace());
            await expect(toggle).toBeHidden();
            await expect(page.locator('[data-ui-closing]')).toHaveCount(0);
            const portrait = page.locator('#chat .mes[mesid="0"] .neconyan-mobile-expression img');
            if (!phone) {
                await expect(portrait).toHaveCount(0);
                await page.screenshot({ path: '../screenshots/expressions-display-desktop-after.png', animations: 'disabled' });
                await page.setViewportSize({ width: 393, height: 852 });
            }
            for (let style = 0; style <= 12; style++) {
                await page.locator('#chat_display').selectOption(String(style), { force: true });
                if (style === 6) {
                    await expect(portrait).toHaveCount(0);
                    await expect(page.locator('#chat .mes[mesid="0"] .neconyan-expression-avatar')).toBeVisible();
                    continue;
                }
                await expect(portrait).toBeVisible();
                await expect(portrait).toHaveAttribute('src', first);
                const geometry = await portrait.evaluate(image => {
                    const rect = image.getBoundingClientRect();
                    const text = image.closest('.mes_block').querySelector('.mes_text').getBoundingClientRect();
                    const holder = image.parentElement.getBoundingClientRect();
                    return { holderWidth: holder.width, holderHeight: holder.height, fit: getComputedStyle(image).objectFit, left: rect.left, right: rect.right,
                        height: rect.height, bottom: rect.bottom, textTop: text.top,
                        overflow: document.documentElement.scrollWidth > window.innerWidth };
                });
                expect(geometry.fit, `style ${style}`).toBe('contain');
                expect(geometry.height, `style ${style}`).toBeGreaterThan(80);
                // Big enough to read the face on a phone, in every chat style.
                expect(geometry.holderHeight, `style ${style}`).toBeGreaterThanOrEqual(180);
                expect(geometry.holderWidth, `style ${style}`).toBeGreaterThanOrEqual(200);
                expect(geometry.left, `style ${style}`).toBeGreaterThanOrEqual(0);
                expect(geometry.right, `style ${style}`).toBeLessThanOrEqual(393);
                expect(geometry.bottom, `style ${style}`).toBeLessThanOrEqual(geometry.textTop);
                expect(geometry.overflow, `style ${style}`).toBe(false);
                if (phone && [0, 3, 10].includes(style)) await page.screenshot({ path: `../screenshots/expressions-display-phone-style-${style}-after.png` });
            }
            await page.locator('#chat_display').selectOption('0', { force: true });
            await selectSprite(page, 'joy-2.png');
            await expect(portrait).toHaveAttribute('src', second);
            // Chat-style changes debounce the same settings save as this option.
            // Reload only once the server has acknowledged the actual selection.
            await expect.poll(() => state.savedSettings?.extension_settings?.expressions?.mobilePortraits).toBe(true);
            await page.reload();
            await page.waitForFunction(() => window.SillyTavern?.getContext().characters.length && window.NeconyanShell?.openExtensionSettings);
            await page.evaluate(async () => window.SillyTavern.getContext().selectCharacterById(0, { switchMenu: false }));
            await expect(portrait).toHaveAttribute('src', second);
            await expect(portrait).toBeVisible();
            await page.setViewportSize({ width: 1280, height: 900 });
            await expect(portrait).toHaveCount(0);
            await page.setViewportSize({ width: 393, height: 852 });
            await expect(portrait).toBeVisible();
            await page.route(url => url.pathname.endsWith('/missing.png'), route => route.fulfill({ status: 404, body: '' }));
            await page.evaluate(async () => {
                const core = await import('/script.js');
                await core.recordMessageExpression(core.captureExpressionTarget(core.chat[0]), '/characters/Expression Cat/missing.png');
            });
            await expect(page.locator('#chat .neconyan-mobile-expression')).toBeHidden();
            await selectSprite(page, 'joy-2.png');
            await expect(portrait).toBeVisible();
            await page.evaluate(() => window.NeconyanShell.openExtensionSettings('expressions'));
            await expect(toggle).toBeChecked();
            await toggle.uncheck();
            await page.evaluate(() => window.NeconyanShell.closeWorkspace());
            await expect(portrait).toHaveCount(0);
            await page.locator('#chat_display').selectOption('6', { force: true });
            await expect(page.locator('#chat .mes[mesid="0"] .neconyan-expression-avatar')).toBeVisible();
            expect(state.modelCalls).toEqual([]);
            expect(state.errors).toEqual([]);
        });

        test('Fine-tuning opens existing controls and Ripple preserves exact message/swipe history', async ({ page }, info) => {
            const state = await fixture(page);
            for (const [route, control] of [['regex', '#open_regex_editor'], ['expressions', '#expression_api']]) {
                if (phone) await page.locator('#sb-hamburger').tap();
                const button = page.locator(`#neconyan-workspace-rail [data-neconyan-route="${route}"]`);
                await button.click();
                await expect(page.locator(control)).toBeVisible();
                if (phone) await expect(page.locator('body')).not.toHaveClass(/neconyan-rail-drawer-open/);
            }
            await page.evaluate(() => window.NeconyanShell.closeWorkspace());
            await page.evaluate(async () => {
                const core = await import('/script.js');
                const context = window.SillyTavern.getContext();
                core.cancelDebouncedChatSave();
                context.chat.splice(0, context.chat.length, { name: 'Expression Cat', is_user: false, is_system: false,
                    mes: 'First reply.\n\n'.repeat(40), send_date: Date.now(), extra: {} });
                await core.redisplayChat();
            });
            await selectSprite(page, 'joy-1.png');
            await expect(page.locator('#chat .mes[mesid="0"] .neconyan-expression-avatar')).toHaveAttribute('src', first);
            await page.evaluate(async () => {
                const core = await import('/script.js');
                const context = window.SillyTavern.getContext();
                context.chat.push({ name: 'Expression Cat', is_user: false, is_system: false, mes: 'Second reply.', send_date: Date.now(), extra: {} });
                await core.redisplayChat();
            });
            await selectSprite(page, 'joy-2.png');
            await expect(page.locator('#chat .mes[mesid="1"] .neconyan-expression-avatar')).toHaveAttribute('src', second);
            await expect(page.locator('#chat .mes[mesid="0"] .neconyan-expression-avatar')).toHaveAttribute('src', first);
            await page.evaluate(async () => {
                const core = await import('/script.js');
                const message = core.chat[1];
                message.swipes.push('Alternative reply.');
                message.swipe_info.push({ extra: {} });
                message.swipe_id = 1;
                core.syncSwipeToMes(1);
                await core.redisplayChat();
            });
            // With classification off, a new swipe inherits the previous message's
            // expression. Its sibling swipe must retain its own selected image.
            await expect(page.locator('#chat .mes[mesid="1"] .neconyan-expression-avatar')).toHaveAttribute('src', first, { timeout: 10000 });
            await selectSprite(page, 'joy-1.png');
            await page.evaluate(async () => {
                const core = await import('/script.js');
                core.chat[1].swipe_id = 0;
                core.syncSwipeToMes(1);
                await core.redisplayChat();
                await core.saveChatConditional({ throwOnError: true });
            });
            await expect(page.locator('#chat .mes[mesid="1"] .neconyan-expression-avatar')).toHaveAttribute('src', second);
            await page.reload();
            await page.waitForFunction(() => window.SillyTavern?.getContext().characters.length && window.NeconyanShell?.openExtensionSettings);
            await page.evaluate(async () => window.SillyTavern.getContext().selectCharacterById(0, { switchMenu: false }));
            await expect(page.locator('#chat .mes[mesid="1"] .avatar')).toHaveClass(/has-expression/);
            const geometry = await page.evaluate(() => {
                const image = document.querySelector('#chat .mes[mesid="1"] .neconyan-expression-avatar');
                const rect = image.getBoundingClientRect();
                const frame = image.parentElement.getBoundingClientRect();
                const style = getComputedStyle(image);
                return { fit: style.objectFit, position: style.objectPosition, left: rect.left, right: rect.right, width: rect.width,
                    top: rect.top, height: rect.height, frameTop: frame.top, frameWidth: frame.width, frameHeight: frame.height,
                    sheldTop: document.querySelector('#sheld').getBoundingClientRect().top,
                    floating: getComputedStyle(document.querySelector('#expression-wrapper')).visibility,
                    sticky: getComputedStyle(document.querySelector('#chat .mesAvatarWrapper')).position };
            });
            // The expression fills the avatar frame like a normal avatar, pinned to the top
            // so square sprites keep the face instead of shrinking to the frame width.
            expect(geometry.fit).toBe('cover');
            expect(geometry.position).toBe('50% 0px');
            expect(Math.abs(geometry.top - geometry.frameTop)).toBeLessThanOrEqual(1);
            expect(Math.abs(geometry.width - geometry.frameWidth)).toBeLessThanOrEqual(1);
            expect(Math.abs(geometry.height - geometry.frameHeight)).toBeLessThanOrEqual(1);
            expect(geometry.height).toBeGreaterThan(geometry.width);
            expect(geometry.width).toBeGreaterThan(0);
            expect(geometry.left).toBeGreaterThanOrEqual(0);
            expect(geometry.right).toBeLessThanOrEqual(phone ? 393 : 1280);
            expect(geometry.sheldTop).toBeLessThan(200);
            expect(geometry.floating).toBe('hidden');
            if (phone) expect(geometry.sticky).toBe('sticky');
            await page.screenshot({ path: info.outputPath('ripple-history.png') });
            await page.evaluate(() => { document.body.classList.remove('ripplestyle'); document.dispatchEvent(new Event('sb:chat-style-updated')); });
            await expect(page.locator('#chat .neconyan-expression-avatar')).toHaveCount(0);
            await page.evaluate(() => { document.body.classList.add('ripplestyle'); document.dispatchEvent(new Event('sb:chat-style-updated')); });
            await expect(page.locator('#chat .mes[mesid="1"] .neconyan-expression-avatar')).toHaveAttribute('src', second);
            expect(state.saved[2].swipe_info[1].extra.neconyanExpression.src).toBe(first);

            // Missing historical artwork falls back without deleting the saved selection.
            await page.route(url => url.pathname.endsWith('/missing.png'), route => route.fulfill({ status: 404, body: '' }));
            await page.evaluate(async () => {
                const core = await import('/script.js');
                await core.recordMessageExpression(core.captureExpressionTarget(core.chat[1]), '/characters/Expression Cat/missing.png');
            });
            await expect(page.locator('#chat .mes[mesid="1"] .avatar')).not.toHaveClass(/has-expression/);
            await expect(page.locator('#chat .mes[mesid="1"] .avatar img:not(.neconyan-expression-avatar)')).toBeVisible();
            await selectSprite(page, '#reset');
            await expect(page.locator('#chat .mes[mesid="1"] .neconyan-expression-avatar')).toHaveCount(0);

            let classifications = 0;
            await page.route('**/api/extra/classify/labels', route => route.fulfill({ json: { labels: ['joy'] } }));
            await page.route('**/api/extra/classify', async route => {
                classifications++;
                await route.fulfill({ json: { classification: [{ label: 'joy', score: 1 }] } });
            });
            await page.evaluate(async () => {
                const core = await import('/script.js');
                const { extension_settings } = await import('/scripts/extensions.js');
                extension_settings.expressions.api = 0;
                extension_settings.expressions.translate = false;
                core.chat.push({ name: 'Expression Cat', is_user: false, is_system: false, mes: 'New automatic reply.', send_date: Date.now(), extra: {} });
                await core.redisplayChat();
            });
            await expect(page.locator('#chat .mes[mesid="2"] .avatar')).toHaveClass(/has-expression/, { timeout: 15000 });
            expect(classifications).toBe(1);
            // A second identical reply still receives its own saved selection.
            await page.evaluate(async () => {
                const core = await import('/script.js');
                core.chat.push({ name: 'Expression Cat', is_user: false, is_system: false, mes: 'New automatic reply.', send_date: Date.now(), extra: {} });
                await core.redisplayChat();
            });
            await expect(page.locator('#chat .mes[mesid="3"] .avatar')).toHaveClass(/has-expression/, { timeout: 15000 });
            expect(classifications).toBe(2);

            // Same-name group members retain separate avatar identities, including Visual Novel mode.
            const groupMessages = ['expression-cat.png', 'other-cat.png'].map((original_avatar, index) => ({
                name: 'Expression Cat', original_avatar, force_avatar: `/thumbnail?type=avatar&file=${original_avatar}`,
                is_user: false, is_system: false, mes: `Group reply ${index}`, send_date: Date.now(), extra: {},
            }));
            await page.route('**/api/chats/group/info', route => route.fulfill({ json: {} }));
            await page.route('**/api/chats/group/get', route => state.storage.read(route, [{ chat_metadata: { tainted: true } }, ...groupMessages]));
            await page.route('**/api/chats/group/save', route => state.storage.save(route));
            await page.route('**/api/groups/edit', route => state.storage.saveGroup(route));
            state.groups.push({ id: 'expression-group', name: 'Expression group', members: ['expression-cat.png', 'other-cat.png'],
                disabled_members: [], chat_id: 'group-history', chats: ['group-history'], chat_metadata: {}, past_metadata: {} });
            await page.evaluate(async () => {
                const core = await import('/script.js');
                const { getGroups, openGroupById } = await import('/scripts/group-chats.js');
                const { extension_settings } = await import('/scripts/extensions.js');
                extension_settings.expressions.api = 99;
                core.characters.push({ ...structuredClone(core.characters[0]), avatar: 'other-cat.png' });
                await getGroups();
                await openGroupById('expression-group', { switchMenu: false });
                await core.recordMessageExpression(core.captureExpressionTarget(core.chat[0]), '/characters/Expression Cat/joy-1.png?t=1');
            });
            await selectSprite(page, 'joy-2.png');
            await expect(page.locator('#chat .mes[mesid="0"] .neconyan-expression-avatar')).toHaveAttribute('src', first);
            await expect(page.locator('#chat .mes[mesid="1"] .neconyan-expression-avatar')).toHaveAttribute('src', second);
            expect(await page.evaluate(() => window.SillyTavern.getContext().chat.map(message => message.extra.neconyanExpression.avatar)))
                .toEqual(['expression-cat.png', 'other-cat.png']);
            expect(await page.locator('#visual-novel-wrapper').evaluate(element => getComputedStyle(element).visibility)).toBe('hidden');
            expect(state.modelCalls).toEqual([]);
            expect(state.errors).toEqual([]);
        });
    });
}
