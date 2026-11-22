/* global getComputedStyle, requestAnimationFrame, window */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

const desktop = { phone: false, contextOptions: {}, prepare: () => {}, applyCss: () => {} };
const iphone = {
    phone: true,
    contextOptions: IPHONE_SAFARI_CONTEXT,
    prepare: context => installIPhoneSafari(context, { standalone: false }),
    applyCss: applyIOSOnlyCss,
};

for (const [device, { phone, contextOptions, prepare, applyCss }] of Object.entries({ desktop, iphone })) {
    test(`Saved entry lists and aligned Entry tools on ${device}`, async ({ app }) => {
        const account = await app.account({ phone, contextOptions, configureSettings(saved) {
            saved.firstRun = false;
            saved.accountStorage = { ...saved.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', WI_PerPage: '10' };
        } });
        await prepare(account.context);
        const name = 'Field notes';
        const file = path.join(app.dataRoot, 'default-user', 'worlds', `${name}.json`);
        const original = JSON.stringify({ name, entries: Array.from({ length: 181 }, (_, index) => ({
            id: 100 + 2 * index, uid: 100 + 2 * index, keys: [`landmark-${index}`], key: [`landmark-${index}`],
            comment: `Landmark ${String(index).padStart(3, '0')}`, content: `Notes about landmark ${index}.`,
            enabled: true, insertion_order: 100, position: 'before_char', extensions: { position: 0 },
        })) });
        await writeFile(file, original);
        const page = await account.open({ workspace: false });
        await page.locator('#preloader').waitFor({ state: 'detached' });
        await page.evaluate(() => window.NeconyanShell.openTab('characters', 'world-info'));
        const open = page.locator('.neconyan-lorebook-book-open').filter({ hasText: name });
        const loaded = page.waitForResponse(response => response.url().endsWith('/api/worldinfo/get') && response.ok());
        await open.click();
        const revision = (await loaded).headers()['x-world-info-revision'];
        await applyCss(page);
        await page.evaluate(() => window.toastr.remove());

        const tools = page.locator('#world_popup_toolbar .world_popup_action_group_details');
        await tools.locator('summary').click();
        const buttons = tools.locator('.world_popup_action_group_contents > .menu_button:visible');
        await expect(buttons).toHaveCount(phone ? 9 : 7);
        const summary = page.locator('#world_info_results_summary');
        await expect(summary).toHaveText('181 entries • all • showing 10 on this page');
        await expect(page.locator('#world_popup_entries_list .world_entry')).toHaveCount(10);
        const health = page.locator('#neco-lore-health-button');
        const icon = health.locator('i.fa-shield-halved');
        await expect(icon).toBeVisible();
        expect(await icon.evaluate(node => getComputedStyle(node, '::before').maskImage)).toContain('#shield-halved');
        if (process.env.NECONYAN_LOREBOOK_SCREENSHOTS) {
            await page.locator('.world_popup_action_group--entry').screenshot({ path: path.join(process.env.NECONYAN_LOREBOOK_SCREENSHOTS, `${device}.png`) });
        }

        const rects = await buttons.evaluateAll(nodes => nodes.map(node => {
            const { x, y, width, height } = node.getBoundingClientRect();
            return { x, y, width, height, fits: node.scrollWidth <= node.clientWidth + 1 };
        }));
        const columns = [...new Set(rects.map(rect => Math.round(rect.x)))];
        expect(columns.length).toBeGreaterThan(1);
        for (const [index, rect] of rects.entries()) {
            expect(Math.abs(rect.width - rects[0].width)).toBeLessThanOrEqual(1);
            expect(Math.abs(rect.height - rects[0].height)).toBeLessThanOrEqual(1);
            expect(rect.height).toBeGreaterThanOrEqual(44);
            expect(Math.round(rect.x)).toBe(columns[index % columns.length]);
            expect(rect.fits).toBe(true);
        }

        const { data, history } = await account.post('/api/worldinfo/history', { name, includeBook: true });
        expect(Object.keys(data.entries)).toHaveLength(181);
        expect(data.entries[460]).toMatchObject({ uid: 460, content: 'Notes about landmark 180.' });
        await account.post('/api/worldinfo/history', { name, action: 'commit', revision, headCommitId: history.headCommitId, message: 'Original entries' });
        expect(await readFile(file, 'utf8')).toBe(original);
        data.entries[460].content = 'Updated notes.';
        await account.post('/api/worldinfo/edit', { name, data, revision });
        const saved = JSON.parse(await readFile(file, 'utf8'));
        expect(saved.entries[460]).toMatchObject({ uid: 460, content: 'Updated notes.' });
        expect(Object.keys(saved.entries)).toHaveLength(181);
    });

    test(`Lorebook pagination and damaged entries on ${device}`, async ({ app }) => {
        const account = await app.account({ phone, contextOptions, configureSettings(saved) {
            saved.firstRun = false;
            saved.accountStorage = { ...saved.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', WI_PerPage: '10' };
        } });
        await prepare(account.context);
        const entries = Object.fromEntries(Array.from({ length: 23 }, (_, uid) => [uid, {
            uid, key: [`landmark-${uid}`], keysecondary: [], content: `Notes about landmark ${uid}.`, comment: `Landmark ${uid}`,
        }]));
        entries[23] = { uid: 0, comment: 'Broken duplicate' };
        entries[24] = null;
        const book = { entries };
        // Simulate an existing damaged file; the save endpoint rejects malformed records.
        await writeFile(path.join(app.dataRoot, 'default-user', 'worlds', 'Landmark notes.json'), JSON.stringify(book));
        const page = await account.open({ workspace: false });
        await page.locator('#preloader').waitFor({ state: 'detached' });
        await page.evaluate(() => window.NeconyanShell.openTab('characters', 'world-info'));
        await page.locator('.neconyan-lorebook-book-open').filter({ hasText: 'Landmark notes' }).click();
        await applyCss(page);
        await page.evaluate(() => window.toastr.remove());

        const list = page.locator('#world_popup_entries_list');
        const rows = list.locator('.world_entry');
        const pager = page.locator('#world_info_pagination');
        const size = pager.locator('select');
        const range = pager.locator('.paginationjs-nav');
        const next = pager.locator('.paginationjs-next a');
        await expect(rows).toHaveCount(10);
        await expect(range).toHaveText('1-10 .. 23');
        await expect(list).toHaveCSS('overflow-y', 'visible');
        await expect.poll(() => list.evaluate(node => node.scrollHeight - node.clientHeight)).toBeLessThanOrEqual(1);

        await next.click();
        await expect(rows).toHaveCount(10);
        await expect(range).toHaveText('11-20 .. 23');
        await next.click();
        await expect(rows).toHaveCount(3);
        await expect(range).toHaveText('21-23 .. 23');

        const scroller = page.locator('.scrollableInner').filter({ has: size });
        await size.evaluate(node => node.scrollIntoView({ block: 'center' }));
        await size.evaluate(node => node.focus({ preventScroll: true }));
        const originalScrollTop = await scroller.evaluate(node => node.scrollTop);
        expect(originalScrollTop).toBeGreaterThan(0);
        for (const [value, count] of [['25', 23], ['10', 10]]) {
            await size.selectOption(value);
            await expect(rows).toHaveCount(count);
            await expect(size).toBeVisible();
            await expect(size).toBeFocused();
            await scroller.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            expect(Math.abs(await scroller.evaluate(node => node.scrollTop) - originalScrollTop)).toBeLessThanOrEqual(1);
        }

        const health = page.locator('#neco-lore-health-button');
        const icon = health.locator('i.fa-triangle-exclamation');
        await expect(health.locator('.neco-lore-badge')).toHaveText('2');
        await expect(icon).toBeVisible();
        expect(await icon.evaluate(node => getComputedStyle(node, '::before').maskImage)).toContain('#triangle-exclamation');
        await health.click();
        const findings = page.locator('.neco-lore-health-results li');
        await expect(findings).toHaveCount(2);
        await expect(findings.locator('strong')).toHaveText(['Damaged entries', 'Damaged entries']);
        await expect(findings.getByRole('button', { name: 'Go to entry' })).toHaveCount(0);
        const { data } = await account.post('/api/worldinfo/history', { name: 'Landmark notes', includeBook: true });
        expect(data).toEqual(book);
    });
}
