/* global document, window, localStorage, getComputedStyle */
import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const shellSource = readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8');
const shellStyles = [...shellSource.match(/const NN_THEMES = Object.freeze\(\[([\s\S]*?)\]\);/)[1].matchAll(/id: '([^']+)'/g)].map(match => match[1]);

test.use({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });

test.beforeEach(async ({ page }) => {
    await page.route('**/api/settings/save', async route => {
        let bytes = route.request().postDataBuffer();
        if (route.request().headers()['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
        const settings = JSON.parse(bytes.toString());
        await route.fulfill({ json: { result: 'ok', version: Number(settings._version || 0) + 1, settingsRevision: Number(settings._settingsRevision || 0) + 1 } });
    });
});

test('collapsed rail centres every icon inside reachable square buttons', async ({ page }) => {
    test.setTimeout(240000);
    const target = process.env.NECONYAN_TEST_BASE_URL;
    expect(target, 'Use an explicit disposable preview').toBeTruthy();
    expect(new URL(target).port).not.toBe('4433');
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const body = await response.json();
        if (typeof body.settings !== 'string') return route.fulfill({ response, json: body });
        const settings = JSON.parse(body.settings);
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanWorkspaceRailCollapsed.v1': 'true', 'NeconyanSimpleMode.v1': 'off', 'NeconyanTutorialStatus.v1': 'skipped' };
        await route.fulfill({ response, json: { ...body, settings: JSON.stringify(settings) } });
    });
    await page.goto('/');
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    await page.evaluate(() => window.NeconyanShell.closeWorkspace());
    await page.evaluate(() => document.fonts.ready);
    for (const [style, height] of [...shellStyles.map(style => [style, 900]), ['calico', 600]]) {
        await page.evaluate(style => window.NeconyanShell.applyTheme(style), style);
        await page.waitForFunction(style => style === 'calico' || [...document.querySelectorAll('link[data-sb-shell-style]')].some(link => link.dataset.sbShellStyle === style && link.sheet), style);
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
        await page.setViewportSize({ width: 1280, height });
        const rail = page.locator('#neconyan-workspace-rail');
        expect((await rail.boundingBox()).width).toBe(style === 'hypr-glow' ? 44 : 52);
        const expand = await page.locator('#neconyan-sidebar-toggle').boundingBox();
        const axis = expand.x + expand.width / 2;
        const scroll = await rail.locator('.neconyan-rail-scroll').evaluate(element => ({ x: element.getBoundingClientRect().x, y: element.getBoundingClientRect().y, client: element.clientWidth, height: element.clientHeight }));
        const buttons = rail.locator('button:visible').filter({ has: page.locator('i:not(.neconyan-whiskers)') });
        for (const button of await buttons.all()) {
            await button.scrollIntoViewIfNeeded();
            const box = await button.boundingBox();
            const icon = await button.locator(':scope > i:not(.neconyan-whiskers)').first().boundingBox();
            const name = (await button.textContent()).trim();
            expect(Math.abs(box.x + box.width / 2 - icon.x - icon.width / 2), name).toBeLessThanOrEqual(1);
            expect(Math.abs(box.y + box.height / 2 - icon.y - icon.height / 2), name).toBeLessThanOrEqual(1);
            expect(Math.abs(box.x + box.width / 2 - axis), name).toBeLessThanOrEqual(1);
            expect(box.x, name).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width, name).toBeLessThanOrEqual(51);
        }
        for (const button of await rail.locator('button:visible:not(#neconyan-sidebar-toggle)').all()) {
            const box = await button.boundingBox();
            expect(box.width).toBe(style === 'hypr-glow' ? 32 : 36);
            expect(box.height).toBe(box.width);
        }
        for (const button of await rail.locator('.neconyan-rail-scroll button:visible').all()) {
            await button.scrollIntoViewIfNeeded();
            const box = await button.boundingBox();
            expect(box.x + box.width).toBeLessThanOrEqual(scroll.x + scroll.client);
            expect(box.y).toBeGreaterThanOrEqual(scroll.y);
            expect(box.y + box.height).toBeLessThanOrEqual(scroll.y + scroll.height);
            await button.focus();
            await expect(button).toBeFocused();
        }
        expect(await rail.locator('.neconyan-rail-scroll').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(scroll.client);
        // Chromium's overlay allocation is zero without the stable gutter.
        // Changing that allocation must not move any of the fixed icon axes.
        await rail.locator('.neconyan-rail-scroll').evaluate(element => { element.style.scrollbarGutter = 'auto'; });
        const overlay = await rail.locator('[data-neconyan-route="home"]').boundingBox();
        expect(Math.abs(overlay.x + overlay.width / 2 - axis)).toBeLessThanOrEqual(1);
        await rail.locator('.neconyan-rail-scroll').evaluate(element => { element.style.scrollbarGutter = ''; });
    }
});

test('empty shortcuts and saved-hidden sections leave no collapsed gap', async ({ page }) => {
    test.setTimeout(120000);
    expect(process.env.NECONYAN_TEST_BASE_URL).toBeTruthy();
    expect(new URL(process.env.NECONYAN_TEST_BASE_URL).port).not.toBe('4433');
    await page.addInitScript(() => localStorage.setItem('sb-desktop-quick-actions-v2', '[]'));
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const body = await response.json();
        if (typeof body.settings !== 'string') return route.fulfill({ response, json: body });
        const settings = JSON.parse(body.settings);
        settings.accountStorage = {
            ...settings.accountStorage,
            'NeconyanWorkspaceRailCollapsed.v1': 'true',
            'NeconyanSimpleMode.v1': 'off',
            'NeconyanTutorialStatus.v1': 'skipped',
            'NeconyanWorkspaceRailSections.v1': JSON.stringify({ advanced: true }),
            'NeconyanWorkspaceRailOrder.v1': JSON.stringify({ enabled: true, primary: ['model', 'home'] }),
        };
        await route.fulfill({ response, json: { ...body, settings: JSON.stringify(settings) } });
    });
    await page.goto('/');
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    await page.evaluate(() => window.NeconyanShell.closeWorkspace());
    await expect(page.locator('[data-neconyan-advanced-nav]')).toBeHidden();
    await expect(page.locator('[data-neconyan-primary-nav] > button').first()).toHaveAttribute('data-neconyan-route', 'model');
    await expect(page.locator('[data-neconyan-quick-actions] > button')).toHaveCount(0);
    for (const section of [page.locator('.neconyan-rail-fine-tuning'), page.locator('section[aria-labelledby="neconyan-rail-quick-actions-title"]')]) {
        expect((await section.boundingBox()).height).toBe(0);
        expect(await section.evaluate(element => getComputedStyle(element).marginTop)).toBe('0px');
    }
    await expect(page.locator('.neconyan-rail-grip:visible')).toHaveCount(0);
    await expect(page.locator('.neconyan-rail-button > small:visible')).toHaveCount(0);
});

test('populated recent chats keep collapsed geometry and keyboard reachability', async ({ page }) => {
    test.setTimeout(120000);
    expect(process.env.NECONYAN_TEST_BASE_URL).toBeTruthy();
    expect(new URL(process.env.NECONYAN_TEST_BASE_URL).port).not.toBe('4433');
    const character = { name: 'M14 geometry fixture', avatar: 'm14-geometry-fixture.png', chat: 'M14 recent 1', first_mes: '', mes_example: '', shallow: false, tags: [], data: { name: 'M14 geometry fixture', first_mes: '', description: '', extensions: {} } };
    const recents = Array.from({ length: 6 }, (_, index) => ({ avatar: character.avatar, file_name: `M14 recent ${index + 1}.jsonl`, last_mes: new Date(Date.UTC(2026, 9, 20, 17, 6 - index)).toISOString(), chat_items: 2, file_size: '1kb', mes: 'Owned geometry fixture' }));
    await page.route('**/api/characters/all', route => route.fulfill({ json: [character] }));
    await page.route('**/api/chats/recent', route => route.fulfill({ json: recents }));
    await page.route(/\/thumbnail\?.*m14-geometry-fixture/, route => route.fulfill({ contentType: 'image/png', body: readFileSync(new URL('../public/img/neconyan-character.png', import.meta.url)) }));
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const body = await response.json();
        if (typeof body.settings !== 'string') return route.fulfill({ response, json: body });
        const settings = JSON.parse(body.settings);
        settings.active_character = '';
        settings.active_group = '';
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanWorkspaceRailCollapsed.v1': 'true', 'NeconyanWorkspaceRailSections.v1': '{}', 'NeconyanSimpleMode.v1': 'off', 'NeconyanTutorialStatus.v1': 'skipped' };
        await route.fulfill({ response, json: { ...body, settings: JSON.stringify(settings) } });
    });
    await page.goto('/');
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    await page.evaluate(() => window.NeconyanShell.closeWorkspace());
    const buttons = page.locator('[data-neconyan-recent-list] > button');
    await expect(buttons).toHaveCount(6);
    const names = recents.map(recent => recent.file_name.replace('.jsonl', ''));
    expect(await buttons.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))).toEqual(names);
    for (const [style, height] of [['calico', 900], ['calico', 600], ['hypr-glow', 900], ['hypr-glow', 600]]) {
        await page.evaluate(style => window.NeconyanShell.applyTheme(style), style);
        await page.waitForFunction(style => style === 'calico' || [...document.querySelectorAll('link[data-sb-shell-style]')].some(link => link.dataset.sbShellStyle === style && link.sheet), style);
        await page.setViewportSize({ width: 1280, height });
        const scroll = await page.locator('.neconyan-rail-scroll').evaluate(element => ({ x: element.getBoundingClientRect().x, y: element.getBoundingClientRect().y, width: element.clientWidth, height: element.clientHeight }));
        const toggle = await page.locator('#neconyan-sidebar-toggle').boundingBox();
        for (const button of await buttons.all()) {
            await button.scrollIntoViewIfNeeded();
            await button.focus();
            await expect(button).toBeFocused();
            const box = await button.boundingBox();
            const icon = await button.locator(':scope > i').boundingBox();
            expect(box.width).toBe(style === 'hypr-glow' ? 32 : 36);
            expect(box.height).toBe(box.width);
            expect(Math.abs(box.x + box.width / 2 - icon.x - icon.width / 2)).toBeLessThanOrEqual(1);
            expect(Math.abs(box.y + box.height / 2 - icon.y - icon.height / 2)).toBeLessThanOrEqual(1);
            expect(Math.abs(box.x + box.width / 2 - toggle.x - toggle.width / 2)).toBeLessThanOrEqual(1);
            expect(box.x + box.width).toBeLessThanOrEqual(scroll.x + scroll.width);
            expect(box.y).toBeGreaterThanOrEqual(scroll.y);
            expect(box.y + box.height).toBeLessThanOrEqual(scroll.y + scroll.height);
            await expect(button.locator('small')).toBeHidden();
            await expect(button.locator('span')).toBeHidden();
        }
    }
});

async function openPhoneRail(page, phone) {
    if (!phone) return;
    await page.locator('#sb-hamburger').tap();
    await page.waitForFunction(() => {
        const rail = document.querySelector('#neconyan-workspace-rail');
        return rail.getAttribute('aria-hidden') === 'false' && Math.abs(rail.getBoundingClientRect().x) < 0.01;
    });
    await page.locator('#neconyan-workspace-rail').evaluate(async rail => {
        await Promise.all(rail.getAnimations().map(animation => animation.finished.catch(() => {})));
    });
}

async function checkDesktopHeadingsHidden(page, phone) {
    if (phone) return;
    await page.locator('#neconyan-sidebar-toggle').click();
    await expect(page.locator('[data-neconyan-section-toggle]:visible')).toHaveCount(0);
}

for (const phone of [false, true]) {
    test.describe(`${phone ? 'phone' : 'desktop'} Hypr headings`, () => {
        test.use({ viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, hasTouch: phone, isMobile: phone });
        test('heading prefixes stay inline through saved section collapse', async ({ page }) => {
            test.setTimeout(120000);
            expect(process.env.NECONYAN_TEST_BASE_URL).toBeTruthy();
            expect(new URL(process.env.NECONYAN_TEST_BASE_URL).port).not.toBe('4433');
            let sections = '{}';
            await page.route('**/api/settings/get', async route => {
                const response = await route.fetch();
                const body = await response.json();
                if (typeof body.settings !== 'string') return route.fulfill({ response, json: body });
                const settings = JSON.parse(body.settings);
                settings.accountStorage = { ...settings.accountStorage, 'NeconyanWorkspaceRailCollapsed.v1': 'false', 'NeconyanWorkspaceRailSections.v1': sections, 'NeconyanSimpleMode.v1': 'off', 'NeconyanTutorialStatus.v1': 'skipped' };
                await route.fulfill({ response, json: { ...body, settings: JSON.stringify(settings) } });
            });
            await page.route('**/api/settings/save', async route => {
                let bytes = route.request().postDataBuffer();
                if (route.request().headers()['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
                const settings = JSON.parse(bytes.toString());
                sections = settings.accountStorage['NeconyanWorkspaceRailSections.v1'] ?? sections;
                await route.fulfill({ json: { result: 'ok', version: Number(settings._version || 0) + 1, settingsRevision: Number(settings._settingsRevision || 0) + 1 } });
            });
            const open = async () => {
                await page.goto('/');
                await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
                await page.evaluate(() => {
                    window.NeconyanShell.closeWorkspace();
                    window.NeconyanShell.applyTheme('hypr-glow');
                    window.$('#themes').val('Windows XP Olive Green').trigger('change');
                });
                await page.waitForFunction(() => [...document.querySelectorAll('link[data-sb-shell-style]')].some(link => link.dataset.sbShellStyle === 'hypr-glow' && link.sheet));
                await page.evaluate(() => document.fonts.ready);
                await openPhoneRail(page, phone);
            };
            await open();
            const rows = await page.locator('[data-neconyan-section-toggle]').evaluateAll(buttons => buttons.map(button => {
                const span = button.querySelector('span');
                const range = document.createRange();
                range.selectNodeContents(span);
                const text = range.getBoundingClientRect();
                const box = span.getBoundingClientRect();
                const style = getComputedStyle(span);
                const context = document.createElement('canvas').getContext('2d');
                context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
                const actions = [...button.parentElement.querySelectorAll('.neconyan-rail-section-actions button')];
                const rail = button.closest('#neconyan-workspace-rail').getBoundingClientRect();
                return { name: button.getAttribute('aria-label'), content: getComputedStyle(span, '::before').content, display: getComputedStyle(span, '::before').display, containerPrefix: getComputedStyle(button.parentElement, '::before').content, offset: text.x - box.x, expectedOffset: context.measureText('# ').width, spanLeft: box.x, textRight: text.right, railLeft: rail.x, railRight: rail.right, actionLeft: Math.min(...actions.map(action => action.getBoundingClientRect().x)) };
            }));
            expect(rows).toHaveLength(8);
            for (const row of rows) {
                expect(row.content, row.name).toBe('"# "');
                expect(row.display, row.name).toBe('inline');
                expect(row.containerPrefix, row.name).toBe('none');
                expect(Math.abs(row.offset - row.expectedOffset), row.name).toBeLessThan(1);
                expect(row.spanLeft, row.name).toBeGreaterThanOrEqual(row.railLeft);
                expect(row.textRight, row.name).toBeLessThanOrEqual(row.railRight);
                expect(row.textRight, row.name).toBeLessThanOrEqual(row.actionLeft);
            }
            const images = new URL('../screenshots/sidebar-geometry/headings/', import.meta.url);
            mkdirSync(images, { recursive: true });
            await page.locator('.neconyan-rail-scroll').evaluate(element => { element.scrollTop = 0; });
            await page.screenshot({ path: fileURLToPath(new URL(`${phone ? 'phone' : 'desktop'}-top.png`, images)) });
            await page.locator('.neconyan-rail-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
            await page.waitForFunction(() => {
                const scroll = document.querySelector('.neconyan-rail-scroll');
                return scroll.scrollTop >= scroll.scrollHeight - scroll.clientHeight - 1;
            });
            await page.screenshot({ path: fileURLToPath(new URL(`${phone ? 'phone' : 'desktop'}-bottom.png`, images)) });
            for (const action of ['data-neconyan-edit-quick-actions', 'data-neconyan-open-archive', 'data-neconyan-refresh-recent']) {
                const button = page.locator(`[${action}]`);
                await button.scrollIntoViewIfNeeded();
                await button.click({ trial: true });
            }
            const quick = page.locator('[data-neconyan-section-toggle="quickActions"]');
            await quick.scrollIntoViewIfNeeded();
            await quick.click();
            await expect(quick).toHaveAttribute('aria-expanded', 'false');
            await expect.poll(() => JSON.parse(sections).quickActions).toBe(true);
            await open();
            await expect(quick).toHaveAttribute('aria-expanded', 'false');
            await expect(page.locator('[data-neconyan-quick-actions]')).toBeHidden();
            await expect(quick).toHaveAccessibleName('Quick Actions');
            await expect(quick.locator('span')).toHaveCSS('display', 'block');
            await page.evaluate(() => window.NeconyanShell.applyTheme('calico'));
            expect(await quick.locator('span').evaluate(span => getComputedStyle(span, '::before').content)).toBe('none');
            await page.evaluate(() => window.NeconyanShell.applyTheme('hypr-glow'));
            await checkDesktopHeadingsHidden(page, phone);
        });
    });
}
