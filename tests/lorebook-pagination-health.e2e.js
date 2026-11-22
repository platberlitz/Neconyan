/* global getComputedStyle, requestAnimationFrame, window */
import { writeFile } from 'node:fs/promises';
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
