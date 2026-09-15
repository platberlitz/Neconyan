/* global document, getComputedStyle, window */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(120000);
let safety;
test.beforeEach(async ({ page }) => {
    safety = { errors: [], unexpected: [] };
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => safety.errors.push(error.message));
    await page.route('**/api/server-admin/**', route => route.fulfill({ status: 403, json: { error: 'Administration is disabled in this fixture.' } }));
    await page.route(/\/api\/.*\/(?:generate|generate-quiet|delete|reset[^/]*|recover-step[^/]*|backup|restart|update|install)(?:\?|$)/, route => {
        safety.unexpected.push({ url: route.request().url(), body: route.request().postData() });
        return route.fulfill({ status: 403, json: { error: 'Unrelated mutation is disabled in this fixture.' } });
    });
});
test.afterEach(() => {
    expect(safety.errors).toEqual([]);
    expect(safety.unexpected).toEqual([]);
});

async function mockSettings(page, tone) {
    let envelopePromise, settings;
    await page.route('**/api/settings/get', async route => {
        const envelope = await (envelopePromise ??= route.fetch().then(response => response.json()));
        if (!settings) {
            settings = JSON.parse(envelope.settings);
            const { name, ...theme } = JSON.parse(readFileSync(new URL(`../default/content/themes/Neconyan Calico${tone === 'dark' ? ' Dark' : ''}.json`, import.meta.url), 'utf8'));
            Object.assign(settings.power_user, theme, { theme: name, google_font: '' });
        }
        await route.fulfill({ json: { ...envelope, settings: JSON.stringify(settings) } });
    });
    await page.route('**/api/settings/save', async route => {
        let bytes = route.request().postDataBuffer();
        if (route.request().headers()['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
        const payload = JSON.parse(bytes.toString());
        settings = { ...payload, _version: Math.max(Date.now(), Number(payload._version || 0) + 1) };
        await route.fulfill({ json: { version: settings._version } });
    });
}
function inventory() {
    return {
        version: 1, handle: 'fixture-user', warnings: [],
        candidates: [
            { id: 'character', type: 'character', name: 'Mittens.png', action: 'archive', state: 'ready', dependencies: [] },
            { id: 'sprites', type: 'sprites', name: 'Mittens', action: 'archive', state: 'ready', dependencies: ['character'] },
            { id: 'avatar', type: 'avatar', name: 'user-default.png', action: 'replace', state: 'ready', dependencies: [] },
            { id: 'in-use', type: 'background', name: 'Favourite cloudy room.jpg', state: 'in-use', reason: 'Assigned to a background folder.', dependencies: [] },
        ],
        archived: [
            { id: 'old-background', itemId: 'background', type: 'background', name: 'A quiet room from an older install.jpg', status: 'archived' },
            { id: 'attention', itemId: 'attention', type: 'background', name: 'Unverified archive.jpg', status: 'attention' },
        ],
    };
}
async function openSettings(page, tone = 'dark') {
    await mockSettings(page, tone);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
    await expect(page.locator('html')).toHaveAttribute('data-sb-surface-tone', tone);
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
    const category = page.getByRole('combobox', { name: 'Settings category', exact: true });
    if (await category.isVisible()) await category.selectOption('cache-account');
    else await page.locator('.sb-settings-tab-btn[data-tab="cache-account"]').click();
    const drawer = page.locator('#nn-retired-content-drawer');
    await expect(drawer).toBeVisible();
    return drawer;
}

test('recovery preserves selection, focus and results through failures and partial success', async ({ page }, info) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    const data = inventory();
    const calls = { list: 0, archive: [], restore: [] };
    let releaseList, releaseArchive, releaseRestore;
    const listGate = new Promise(resolve => { releaseList = resolve; });
    const archiveGate = new Promise(resolve => { releaseArchive = resolve; });
    const restoreGate = new Promise(resolve => { releaseRestore = resolve; });
    await page.route('**/api/content/retired/**', async route => {
        const endpoint = new URL(route.request().url()).pathname.split('/').pop();
        const body = route.request().postDataJSON();
        if (endpoint === 'list') {
            if (++calls.list === 1) {
                await listGate;
                return route.fulfill({ status: 503, json: { error: 'The recovery list is temporarily unavailable.' } });
            }
            return route.fulfill({ json: data });
        }
        expect(body.handle).toBe('fixture-user');
        if (endpoint === 'archive') {
            calls.archive.push(body);
            if (calls.archive.length === 1) {
                await archiveGate;
                return route.fulfill({ status: 503, json: { error: 'Archive storage is temporarily unavailable.' } });
            }
            const failed = calls.archive.length === 2 ? ['sprites'] : [];
            for (const id of body.ids.filter(id => !failed.includes(id))) {
                const entry = data.candidates.find(entry => entry.id === id);
                data.archived.push({ ...entry, id: `record-${id}`, itemId: id, status: 'archived' });
                data.candidates = data.candidates.filter(entry => entry.id !== id);
            }
            data.candidates.forEach(entry => { entry.dependencies = []; });
            return route.fulfill({ json: { results: body.ids.map(id => ({ id, ok: !failed.includes(id), reason: failed.includes(id) ? 'Please retry this file.' : '' })) } });
        }
        calls.restore.push(body);
        if (calls.restore.length === 1) {
            await restoreGate;
            return route.fulfill({ status: 409, json: { error: 'The restore destination is temporarily unavailable.' } });
        }
        const entry = data.archived.find(entry => entry.id === body.id);
        Object.assign(entry, { status: 'restored', restoredName: 'Mittens (restored).png' });
        return route.fulfill({ json: { ok: true, name: entry.restoredName, record: entry } });
    });
    const drawer = await openSettings(page);
    const toggle = drawer.getByRole('button', { name: 'Old defaults & recovery' });
    expect(calls.list).toBe(0);
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveAttribute('aria-controls', 'nn-retired-content-body');
    await expect(drawer.locator('.neconyan-retired-content-body')).toHaveAttribute('aria-busy', 'true');
    await expect(drawer.getByRole('button', { name: 'Check old defaults' })).toBeDisabled();
    releaseList();
    await expect(drawer.getByRole('status')).toHaveText('The recovery list is temporarily unavailable.');
    await drawer.getByRole('button', { name: 'Retry', exact: true }).click();
    const character = drawer.getByRole('checkbox', { name: 'Select Mittens.png', exact: true });
    const sprites = drawer.getByRole('checkbox', { name: 'Select Mittens', exact: true });
    const avatar = drawer.getByRole('checkbox', { name: 'Select user-default.png', exact: true });
    await sprites.check();
    await expect(character).toBeChecked();
    await character.uncheck();
    await expect(sprites).not.toBeChecked();
    await avatar.check();
    await expect(drawer.getByRole('button', { name: 'Replace with Neconyan avatar', exact: true })).toBeEnabled();
    await sprites.check();
    const archive = drawer.getByRole('button', { name: 'Archive files and replace avatar', exact: true });
    await archive.focus();
    await archive.evaluate(button => { button.click(); button.click(); });
    await expect.poll(() => calls.archive.length).toBe(1);
    await expect(archive).toBeDisabled();
    releaseArchive();
    await expect(drawer.getByRole('status')).toHaveText('Archive storage is temporarily unavailable.');
    await expect(archive).toBeFocused();
    for (const checkbox of [character, sprites, avatar]) await expect(checkbox).toBeChecked();
    await drawer.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(drawer.getByRole('status')).toHaveText('Mittens: Please retry this file.');
    await expect(sprites).toBeChecked();
    await expect(character).toHaveCount(0);
    await expect(avatar).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: 'Reload Neconyan' })).toBeVisible();
    await drawer.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(drawer.getByRole('status')).toHaveText('Selected old defaults are safely archived.');
    expect(calls.archive[2].ids).toEqual(['sprites']);
    const restore = drawer.locator('button[data-retired-id="record-character"]');
    await restore.focus();
    await restore.evaluate(button => { button.click(); button.click(); });
    await expect.poll(() => calls.restore.length).toBe(1);
    releaseRestore();
    await expect(drawer.getByRole('status')).toHaveText('The restore destination is temporarily unavailable.');
    await expect(restore).toBeFocused();
    await drawer.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(drawer.getByRole('status')).toHaveText('Restored as Mittens (restored).png.');
    await expect(restore.locator('..')).toContainText('Restored as Mittens (restored).png.');
    await expect(drawer.getByRole('button', { name: 'Retry', exact: true })).toBeHidden();
    await expect(drawer.getByRole('status')).toBeFocused();
    await expect(drawer.locator('button[data-retired-id="attention"]')).toBeDisabled();
    await expect(drawer.getByText('This archive needs attention.', { exact: false })).toBeVisible();
    await drawer.getByRole('status').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('recovery-result.png') });
    const beforeToggle = calls.list;
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(drawer.locator('.neconyan-retired-content-body')).toBeHidden();
    await toggle.click();
    await expect(drawer.locator('.neconyan-retired-content-body')).toBeVisible();
    expect(calls.list).toBe(beforeToggle);
});

for (const width of [1280, 390, 320]) {
    for (const tone of ['dark', 'light']) {
        test.describe(`recovery ${width}px ${tone}`, () => {
            test.use({ viewport: { width, height: 1000 }, isMobile: width < 600, hasTouch: width < 600 });
            test('uses a real theme with readable controls and contained rows', async ({ page }, info) => {
                await page.route('**/api/content/retired/list', route => route.fulfill({ json: inventory() }));
                await page.route(/\/api\/content\/retired\/(archive|restore)$/, route => {
                    safety.unexpected.push(route.request().url());
                    return route.fulfill({ status: 403, json: { error: 'This view is read-only.' } });
                });
                const drawer = await openSettings(page, tone);
                const toggle = drawer.getByRole('button', { name: 'Old defaults & recovery' });
                await toggle.click();
                await drawer.getByRole('checkbox', { name: 'Select user-default.png' }).check();
                await expect(drawer.getByRole('button', { name: 'Replace with Neconyan avatar', exact: true })).toBeVisible();
                await expect(drawer.getByRole('checkbox', { name: 'Select Favourite cloudy room.jpg' })).toBeDisabled();
                await expect(drawer.locator('button[data-retired-id="attention"]')).toBeDisabled();
                const metrics = await drawer.evaluate(element => ({
                    viewport: window.innerWidth, pageWidth: document.documentElement.scrollWidth,
                    controls: [...element.querySelectorAll('button, label.neconyan-retired-content-row')]
                        .filter(node => node.getClientRects().length && !node.hidden).map(node => {
                            const box = node.getBoundingClientRect();
                            const range = document.createRange(); range.selectNodeContents(node);
                            return { height: box.height, left: box.left, right: box.right, lines: range.getClientRects().length };
                        }),
                    background: getComputedStyle(document.body).getPropertyValue('--neco-surface'),
                }));
                expect(metrics.pageWidth).toBeLessThanOrEqual(width + 1);
                for (const control of metrics.controls) {
                    expect(control.height).toBeGreaterThanOrEqual(43.5);
                    expect(control.left).toBeGreaterThanOrEqual(0);
                    expect(control.right).toBeLessThanOrEqual(width + 1);
                    expect(control.lines).toBeLessThan(12);
                }
                await info.attach('layout', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
                await toggle.scrollIntoViewIfNeeded();
                await page.screenshot({ path: info.outputPath(`retirement-${width}-${tone}.png`) });
            });
        });
    }
}
