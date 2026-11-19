/* global document, window, indexedDB, getComputedStyle */
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- Shared phone/desktop and before-build checks. */
import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';
import { settleCssTransitions } from './chat-scroll-regression-helpers.js';

const baseline = process.env.NECONYAN_GALLERY_BASELINE_SCRIPT;
const deleteBaseline = process.env.NECONYAN_GALLERY_DELETE_BASELINE_DIR;
const prompt = 'A friendly cat in warm afternoon light.';

async function localAssetCount(page) {
    return page.evaluate(async () => {
        const { name } = (await indexedDB.databases()).find(db => db.name.startsWith('qig-gallery-account-'));
        return new Promise((resolve, reject) => {
            const open = indexedDB.open(name);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const db = open.result;
                const tx = db.transaction('assets');
                const count = tx.objectStore('assets').count();
                tx.oncomplete = () => { db.close(); resolve(count.result); };
                tx.onabort = () => { db.close(); reject(tx.error); };
            };
        });
    });
}

async function checkButtonReadability(page, selectors) {
    const sizes = await page.evaluate(selectors => {
        const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
        const luminance = ([r, g, b]) => [r, g, b].map(v => v / 255)
            .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
            .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        const fill = colour => { ctx.fillStyle = colour; ctx.fillRect(0, 0, 1, 1); };
        return selectors.map(selector => {
            const node = document.querySelector(selector);
            const style = getComputedStyle(node);
            ctx.clearRect(0, 0, 1, 1);
            fill(style.getPropertyValue('--neco-surface'));
            fill(style.backgroundColor);
            const bg = luminance(ctx.getImageData(0, 0, 1, 1).data);
            fill(style.color);
            const fg = luminance(ctx.getImageData(0, 0, 1, 1).data);
            const { width, height, left, right } = node.getBoundingClientRect();
            return { width, height, left, right, contrast: (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05) };
        });
    }, selectors);
    for (const [index, item] of sizes.entries()) {
        const selector = selectors[index];
        expect(item.contrast, selector).toBeGreaterThanOrEqual(4.5);
        expect(item.left, selector).toBeGreaterThanOrEqual(0);
        expect(item.right, selector).toBeLessThanOrEqual(page.viewportSize().width);
        if (!selector.includes('selection-mark')) {
            expect(item.width, selector).toBeGreaterThanOrEqual(44);
            expect(item.height, selector).toBeGreaterThanOrEqual(44);
        }
    }
}

for (const phone of [true, false]) {
    const layout = phone ? 'phone' : 'desktop';
    test(`${layout} Gallery includes Scratchpad pictures with local history and keeps their saved originals`, async ({ app }, info) => {
        test.setTimeout(120000);
        const image = await readFile(new URL('../public/img/ai4.png', import.meta.url));
        const provider = await app.images();
        provider.mode.reply = { data: [{ b64_json: image.toString('base64') }] };
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(saved) {
            saved.extension_settings['quick-image-gen'] = { _syncCacheId: randomUUID(), provider: 'gptimage', gptImageKey: 'fixture-image-key',
                gptImageModel: 'gpt-image-1', gptImageProxyUrl: provider.url, width: 1024, height: 1024,
                style: 'none', appendQuality: false, useSTStyle: false, reviewBeforeGenerate: false, setupWizardSeen: true };
        } });
        if (phone) await installIPhoneSafari(account.context);
        if (baseline) await account.context.route('**/scripts/extensions/quick-image-gen/index.js*', route => route.fulfill({ path: baseline, contentType: 'text/javascript' }));
        if (deleteBaseline) for (const [file, contentType] of [['index.js', 'text/javascript'], ['style.css', 'text/css']]) {
            const asset = `scripts/extensions/quick-image-gen/${file}`;
            await account.context.route(`**/${asset}*`, route => route.fulfill({ path: path.join(deleteBaseline, 'public', asset), contentType }));
        }
        const page = await account.open({ workspace: false });
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        if (phone) await applyIOSOnlyCss(page);
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await page.locator('#scratchpad-connection-miso').selectOption('durable');
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        const change = { type: 'image', action: 'generate', target: 'image', prompt, negative: 'blur' };
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: '```scratchpad-change\n' + JSON.stringify(change) + '\n```' } }] };
        await page.locator('.scratchpad-composer').fill('Draw a cat for me.');
        const sent = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const reply = await sent;
        expect(reply.ok(), await reply.text()).toBe(true);
        await account.settled((await reply.json()).job.id);
        const card = page.locator('.scratchpad-image-card').first();
        const generating = page.waitForResponse('**/api/scratchpad/images/generate');
        await card.getByRole('button', { name: 'Generate image', exact: true }).click();
        const accepted = await generating;
        expect(accepted.ok(), await accepted.text()).toBe(true);
        await account.settled((await accepted.json()).job.id);
        await expect(card.locator('.scratchpad-generated-image')).toBeVisible();
        const url = await card.locator('.scratchpad-generated-image').getAttribute('src');
        const savedPath = `${app.dataRoot}/default-user/${url.replace(/^\//, '')}`;
        const saved = await readFile(savedPath);

        // A reload proves these pictures are discovered from saved Scratchpad data, not a browser callback.
        await page.reload();
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await page.waitForFunction(() => document.querySelector('#qig-gallery-settings-btn'));
        if (phone) await applyIOSOnlyCss(page);
        await page.addStyleTag({ content: '#nn-update-toast, #toast-container { visibility: hidden !important; }' });
        if (phone) await page.locator('#sb-hamburger').click();
        await page.locator('#neconyan-workspace-rail [data-neconyan-route="gallery"]').click();
        const gallery = page.locator('#qig-gallery-popup');
        await expect(gallery).toBeVisible();
        await expect(gallery.locator('.qig-gallery-card')).toHaveCount(baseline ? 0 : 1);
        if (!baseline) await expect(gallery.locator('.qig-gallery-card img')).toHaveJSProperty('naturalWidth', 512);
        const bounds = await gallery.locator('.qig-popup-content').boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(phone ? 394 : 1281);
        await mkdir(new URL('../screenshots/', import.meta.url), { recursive: true });
        const screenshot = new URL(`../screenshots/scratchpad-gallery-${layout}-${baseline ? 'before' : 'after'}.png`, import.meta.url).pathname;
        await page.screenshot({ path: screenshot });
        await info.attach('Scratchpad pictures in Gallery', { path: screenshot, contentType: 'image/png' });
        if (baseline) return;

        await expect(gallery.locator('.qig-gallery-card')).toContainText(prompt);
        await gallery.locator('.qig-gallery-card').click();
        await expect(page.locator('#qig-result-img')).toHaveAttribute('src', url);
        await page.locator('#qig-toggle-prompt-editor').click();
        await expect(page.locator('#qig-result-prompt-editor textarea').first()).toHaveValue(prompt);
        await expect(page.locator('#qig-result-prompt-editor textarea').nth(1)).toHaveValue('blur');
        await page.keyboard.press('Escape');
        await page.evaluate(() => window.NeconyanShell.openGallery());
        const tiles = gallery.locator('.qig-gallery-card');
        const addLocal = async buffer => {
            await gallery.locator('#qig-gallery-import-url').fill(`data:image/png;base64,${buffer.toString('base64')}`);
            await gallery.locator('#qig-gallery-import-add').click();
        };
        const snapshot = async name => {
            await settleCssTransitions(page);
            const shot = new URL(`../screenshots/gallery-delete-${layout}-${name}.png`, import.meta.url).pathname;
            await page.screenshot({ path: shot });
            await info.attach(`Gallery ${name}`, { path: shot, contentType: 'image/png' });
        };
        await expect(tiles).toHaveCount(1);
        const other = await readFile(new URL('../public/img/neconyan-persona.png', import.meta.url));
        await addLocal(other);
        await expect(tiles).toHaveCount(2);
        await expect(tiles.first().locator('img')).not.toHaveJSProperty('naturalWidth', 0);
        await snapshot(deleteBaseline ? 'before' : 'after');
        if (deleteBaseline) return;

        await checkButtonReadability(page, ['#qig-gallery-edit', '.qig-gallery-delete']);
        await gallery.locator('#qig-gallery-clear').click();
        await page.locator('dialog.popup').getByRole('button', { name: 'Clear local history', exact: true }).click();
        await expect(tiles).toHaveCount(1);
        expect(await readFile(savedPath)).toEqual(saved);
        await addLocal(other);
        await expect(tiles).toHaveCount(2);

        const singleDelete = gallery.locator('.qig-gallery-tile').first().locator('.qig-gallery-delete');
        const confirm = page.locator('dialog.popup[open]');
        await singleDelete.click();
        await confirm.getByRole('button', { name: 'Cancel' }).click();
        await expect(tiles).toHaveCount(2);
        await expect(singleDelete).toBeFocused();
        await singleDelete.click();
        await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
        await expect(tiles).toHaveCount(1);
        expect(await localAssetCount(page)).toBe(0);

        await addLocal(other);
        await expect(tiles).toHaveCount(2);
        await addLocal(image);
        await expect(tiles).toHaveCount(3);
        const batch = gallery.getByRole('button', { name: 'Batch Edit' });
        const deleteSelected = gallery.locator('#qig-gallery-delete-selected');
        await batch.click();
        await expect(deleteSelected).toBeDisabled();
        await tiles.first().click();
        await tiles.nth(1).click();
        await tiles.nth(1).click();
        await tiles.filter({ hasText: prompt }).click();
        await expect(gallery.locator('#qig-gallery-selection')).toHaveText('2 selected');
        await expect(tiles.nth(1)).toHaveAttribute('aria-pressed', 'false');
        await expect(tiles.nth(1).locator('.qig-gallery-selection-mark')).toBeEmpty();
        await expect(tiles.first().locator('.qig-gallery-selection-mark')).toHaveText('✓');
        await snapshot('batch');

        for (const rgba of [null, 'rgba(110,231,183,1)', 'rgba(126,34,206,1)']) {
            if (rgba) await page.evaluate(rgba => {
                document.querySelector('#sb-accent-primary-picker').dispatchEvent(new CustomEvent('change', { detail: { rgba } }));
            }, rgba);
            await settleCssTransitions(page);
            await checkButtonReadability(page, ['#qig-gallery-edit', '#qig-gallery-delete-selected', '.qig-gallery-card[aria-pressed="true"] .qig-gallery-selection-mark']);
        }

        const removeRoute = '**/api/scratchpad/images/gallery/remove';
        await page.route(removeRoute, route => route.fulfill({ status: 503, json: { error: true } }));
        await deleteSelected.click();
        await expect(confirm).toContainText('The original pictures will stay in Scratchpad.');
        await confirm.getByRole('button', { name: 'Delete selected', exact: true }).click();
        await expect(tiles).toHaveCount(2);
        await expect(gallery.locator('#qig-gallery-selection')).toHaveText('1 selected');
        await expect(tiles.filter({ hasText: prompt })).toHaveAttribute('aria-pressed', 'true');
        await page.unroute(removeRoute);
        await deleteSelected.click();
        await confirm.getByRole('button', { name: 'Delete selected', exact: true }).click();
        await expect(tiles).toHaveCount(1);
        await expect(gallery.locator('#qig-gallery-selection')).toHaveText('0 selected');
        await gallery.getByRole('button', { name: 'Done', exact: true }).click();
        await expect(batch).toBeVisible();
        expect(await localAssetCount(page)).toBe(1);
        expect(await readFile(savedPath)).toEqual(saved);

        await page.reload();
        await page.waitForFunction(() => document.querySelector('#qig-gallery-settings-btn'));
        await page.evaluate(() => window.NeconyanShell.openGallery());
        await expect(gallery.locator('#qig-gallery-status')).toBeHidden();
        await expect(tiles).toHaveCount(1);
        await expect(tiles).not.toContainText(prompt);
        expect(provider.calls).toHaveLength(1);
        expect(app.provider.calls).toHaveLength(1);
    });
}

test('Gallery keeps local pictures usable during a slow or failed Scratchpad request and ignores an older opening', async ({ app }) => {
    // eslint-disable-next-line playwright/no-skipped-test -- Before screenshots use a build without this request.
    test.skip(Boolean(baseline || deleteBaseline), 'The before screenshots only use the phone and desktop cases.');
    test.setTimeout(120000);
    const account = await app.account({ configureSettings(saved) {
        saved.extension_settings['quick-image-gen'] = { _syncCacheId: randomUUID(), setupWizardSeen: true };
    } });
    const page = await account.open();
    await page.waitForFunction(() => document.querySelector('#qig-gallery-settings-btn'));
    const requests = [];
    await page.route('**/api/scratchpad/images/gallery', route => { requests.push(route); });
    await page.evaluate(() => { void window.NeconyanShell.openGallery(); });
    const gallery = page.locator('#qig-gallery-popup');
    await expect(gallery).toBeVisible();
    await expect.poll(() => requests.length).toBe(1);
    await expect(gallery.locator('#qig-gallery-status')).toHaveText('Loading Scratchpad pictures…');
    const image = await readFile(new URL('../public/img/ai4.png', import.meta.url));
    await gallery.locator('#qig-gallery-import-url').fill(`data:image/png;base64,${image.toString('base64')}`);
    await gallery.locator('#qig-gallery-import-add').click();
    await expect(gallery.locator('.qig-gallery-card')).toHaveCount(1);
    await requests[0].fulfill({ status: 503, json: { error: true } });
    await expect(gallery.locator('#qig-gallery-status')).toContainText('Reopen Gallery to try again.');
    await gallery.locator('.qig-gallery-card').click();
    await expect(page.locator('#qig-result-img')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.evaluate(() => { void window.NeconyanShell.openGallery(); });
    await expect.poll(() => requests.length).toBe(2);
    await page.keyboard.press('Escape');
    await page.evaluate(() => { void window.NeconyanShell.openGallery(); });
    await expect.poll(() => requests.length).toBe(3);
    const entry = { id: 'saved-picture', url: '/img/ai4.png', date: Date.now(), prompt: 'The latest saved picture' };
    await requests[2].fulfill({ json: { images: [entry] } });
    await expect(gallery.locator('.qig-gallery-card')).toHaveCount(2);
    await expect(gallery.locator('#qig-gallery-status')).toBeHidden();
    await requests[1].fulfill({ json: { images: [{ ...entry, prompt: 'An outdated picture' }] } });
    await expect(gallery).toContainText(entry.prompt);
    await expect(gallery).not.toContainText('An outdated picture');
    expect(app.provider.calls).toHaveLength(0);
});
