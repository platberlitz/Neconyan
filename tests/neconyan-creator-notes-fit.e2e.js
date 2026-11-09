/* global window, document */
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} fits imported Creator's Notes in the panel and fullscreen`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(settings) {
            settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        } });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="500"><rect width="1600" height="500" fill="#88b7ca"/><text x="60" y="220" font-size="80">Welcome to the harbour</text></svg>').toString('base64');
        const notes = `<div style="width:1400px;min-width:1400px;white-space:nowrap"><img src="${svg}" width="1600" height="500" style="width:1600px;height:500px"><p>${'A note about Nova and the harbour. '.repeat(8)}</p><p>${'long-link-'.repeat(40)}</p><pre>${'long code '.repeat(60)}</pre><table style="width:1800px"><tr><td>${'table-text-'.repeat(40)}</td><td>End of notes</td></tr></table></div>`;
        const merged = await account.context.request.post('/api/characters/merge-attributes', { headers: account.headers, data: { avatar: account.avatar, data: { creator_notes: notes } } });
        expect(merged.ok()).toBe(true);
        const page = await account.open({ workspace: false });
        await page.evaluate(async avatar => {
            const core = window.SillyTavern.getContext();
            window.NeconyanShell.closeWorkspace();
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(card => card.avatar === avatar));
            document.querySelector('#right-nav-panel').classList.add('openDrawer');
            document.querySelector('#spoiler_free_desc').classList.add('flex1');
        }, account.avatar);
        if (phone) await applyIOSOnlyCss(page);
        const content = page.locator('#creator_notes_spoiler');
        const measure = () => content.evaluate(node => {
            const image = node.querySelector('img').getBoundingClientRect();
            return { width: node.clientWidth, scroll: node.scrollWidth, image: image.width, ratio: image.width / image.height,
                overflowing: [...node.querySelectorAll('*')].filter(child => child.scrollWidth > child.clientWidth + 1 && child.clientWidth > 0).map(child => child.tagName) };
        });
        await expect.poll(async () => (await measure()).width).toBeGreaterThan(0);
        let layout = await measure();
        expect(layout.scroll).toBeLessThanOrEqual(layout.width + 1);
        expect(layout.image).toBeLessThanOrEqual(layout.width);
        expect(layout.ratio).toBeCloseTo(3.2, 1);
        expect(layout.overflowing).toEqual([]);
        await content.evaluate(node => { node.dataset.notesIdentity = 'preserved'; });
        await page.locator('#sb_creator_notes_maximize').evaluate(button => button.click());
        await expect(page.locator('.sb-creator-notes-fullscreen')).toBeVisible();
        layout = await measure();
        console.log('NOTES FIT', phone, layout);
        expect(layout.scroll).toBeLessThanOrEqual(layout.width + 1);
        expect(layout.image).toBeLessThanOrEqual(layout.width);
        expect(layout.ratio).toBeCloseTo(3.2, 1);
        expect(layout.overflowing).toEqual([]);
        await page.screenshot({ path: path.resolve('../screenshots/html-preview', `${phone ? 'phone' : 'desktop'}-notes-after.png`) });
        await page.locator('dialog:visible .popup-button-ok').click();
        await expect(page.locator('#right-nav-panel #creator_notes_spoiler')).toHaveAttribute('data-notes-identity', 'preserved');
        expect((await account.post('/api/characters/get', { avatar_url: account.avatar })).data.creator_notes).toBe(notes);
    });
}
