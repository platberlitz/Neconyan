/* global document */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [true, false]) {
    test(`external media global default is editable from the character dialog (${phone ? 'phone' : 'desktop'})`, async ({ app }) => {
        test.setTimeout(240000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(saved) {
            saved.power_user.forbid_external_media = true;
            saved.power_user.external_media_allowed_overrides = [];
            saved.power_user.external_media_forbidden_overrides = [];
        } });
        if (phone) await installIPhoneSafari(account.context);
        const page = await account.open({ workspace: false });
        const diagnostics = [];
        page.on('pageerror', error => diagnostics.push(error.message));
        page.on('console', message => {
            if (message.type() === 'error') diagnostics.push(message.text());
        });
        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            await core.getCharacters();
            const id = core.characters.findIndex(character => character.avatar === avatar);
            await core.selectCharacterById(id, { switchMenu: false });
            document.getElementById('character_open_media_overrides').click();
        }, account.avatar);
        if (phone) await applyIOSOnlyCss(page);
        const popup = page.locator('dialog:visible').filter({ has: page.locator('.forbid_media_override') });
        const globalDefault = popup.locator('#forbid_media_global_default');
        await expect(globalDefault).toBeChecked();
        await expect(popup.locator('#forbid_media_override_global')).toBeChecked();
        await expect(popup.locator('.forbid_media_global_state_forbidden')).toBeVisible();
        await expect(popup).toContainText('Settings → Chat & Writing → Chat & messages → Messages → Block external media');

        const screenshots = path.resolve('..', 'screenshots');
        await fs.mkdir(screenshots, { recursive: true });
        await page.screenshot({ path: path.join(screenshots, `external-media-${phone ? 'phone' : 'desktop'}-after.png`) });
        const geometry = await popup.evaluate(element => {
            const rect = element.getBoundingClientRect();
            return { x: rect.x, right: rect.right, top: rect.top, bottom: rect.bottom, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
        });
        expect(geometry.x).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(phone ? 393 : 1280);
        expect(geometry.top).toBeGreaterThanOrEqual(0);
        expect(geometry.bottom).toBeLessThanOrEqual(phone ? 852 : 900);
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);

        await globalDefault.uncheck();
        await expect(popup.locator('.forbid_media_global_state_allowed')).toBeVisible();
        await expect(page.locator('#forbid_external_media')).not.toBeChecked();
        expect(await page.evaluate(async () => (await import('/scripts/chats.js')).isExternalMediaAllowed())).toBe(true);

        await popup.locator('#forbid_media_override_forbidden').check();
        await globalDefault.check();
        await globalDefault.uncheck();
        await expect(popup.locator('#forbid_media_override_forbidden')).toBeChecked();
        expect(await page.evaluate(async () => (await import('/scripts/chats.js')).isExternalMediaAllowed())).toBe(false);

        await popup.locator('#forbid_media_override_global').check();
        await popup.locator('.popup-button-ok').click();
        await page.evaluate(async () => {
            if (!await (await import('/script.js')).saveSettings(0, { returnResult: true })) throw new Error('Settings save failed');
        });
        const saved = JSON.parse((await account.post('/api/settings/get')).settings);
        expect(saved.power_user.forbid_external_media).toBe(false);
        expect(saved.power_user.external_media_allowed_overrides).toEqual([]);
        expect(saved.power_user.external_media_forbidden_overrides).toEqual([]);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect.poll(async () => ({ ready: await page.evaluate(() => document.body.classList.contains('neconyan-rail-ready')), errors: diagnostics }), { timeout: 60000 }).toMatchObject({ ready: true });
        expect(await page.evaluate(async () => (await import('/scripts/power-user.js')).power_user.forbid_external_media)).toBe(false);

        const group = await account.post('/api/groups/create', { name: 'External media group', members: [account.avatar] });
        await page.evaluate(async id => {
            const groups = await import('/scripts/group-chats.js');
            await groups.getGroups();
            await groups.openGroupById(id, { switchMenu: false });
            document.getElementById('group_open_media_overrides').click();
        }, group.id);
        await expect(globalDefault).not.toBeChecked();
        await expect(popup.locator('#forbid_media_override_global')).toBeChecked();
        await popup.locator('#forbid_media_override_allowed').check();
        await globalDefault.check();
        await expect(popup.locator('#forbid_media_override_allowed')).toBeChecked();
        expect(await page.evaluate(async () => (await import('/scripts/chats.js')).isExternalMediaAllowed())).toBe(true);
    });
}
