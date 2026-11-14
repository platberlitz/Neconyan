/* global document, window */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36';
const books = ['Aster harbour', 'Birch forest', 'Cedar village'];

async function openPicker(page, avatar) {
    await page.evaluate(async target => {
        const context = window.SillyTavern.getContext();
        const id = context.characters.findIndex(character => character.avatar === target);
        await context.selectCharacterById(id);
        window.NeconyanShell.openTab('characters', 'characters');
    }, avatar);
    await page.getByRole('button', { name: 'Edit Durable Nova', exact: true }).click();
    await page.locator('#char-management-dropdown').selectOption({ label: 'Link to Lorebook' });
    await expect(page.locator('dialog[open] .character_world')).toBeVisible();
}

for (const device of ['phone', 'tablet', 'desktop']) {
    test(`additional lorebooks can be searched, selected and cleared on ${device}`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account({
            phone: device === 'phone',
            contextOptions: device === 'desktop' ? {} : {
                userAgent: device === 'tablet' ? android.replace(' Mobile', '') : android,
                hasTouch: true,
                isMobile: true,
                ...(device === 'tablet' ? { viewport: { width: 1024, height: 900 } } : {}),
            },
        });
        for (const name of books) await account.post('/api/worldinfo/edit', { name, data: { entries: {} } });
        const page = await account.open({ workspace: false });
        await openPicker(page, account.avatar);
        const dialog = page.locator('dialog[open]');
        const select = dialog.locator('.character_extra_world_info_selector');
        const trigger = dialog.locator('.sb-select-picker-button');
        const panel = dialog.locator('.sb-select-picker');
        const press = locator => device === 'desktop' ? locator.click() : locator.tap();
        await expect(select).toBeHidden();
        await expect(trigger).toHaveClass(/is-placeholder/);
        await press(trigger);
        await expect(panel).toBeVisible();
        if (process.env.NECONYAN_PICKER_SCREENSHOTS) {
            await page.screenshot({ path: `../screenshots/additional-lorebooks/${device}-${process.env.NECONYAN_PICKER_SCREENSHOTS}.png` });
        }
        await expect(panel.getByRole('button', { name: '-- Lorebooks not found --', exact: true })).toHaveCount(0);
        const geometry = await panel.evaluate(element => {
            const rect = element.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + Math.min(rect.height / 2, 30);
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
                width: window.innerWidth, height: window.innerHeight,
                reachable: element.contains(document.elementFromPoint(x, y)) };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.width);
        expect(geometry.top).toBeGreaterThanOrEqual(0);
        expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
        expect(geometry.reachable).toBe(true);
        const search = panel.locator('.sb-chat-picker-search');
        await search.fill('Birch');
        await press(panel.getByRole('button', { name: books[1], exact: true }));
        await search.fill('Cedar');
        await press(panel.getByRole('button', { name: books[2], exact: true }));
        await expect(select).toHaveValues(['1', '2']);
        await expect(panel).toBeVisible();
        await expect(trigger).toContainText(`${books[1]}, ${books[2]}`);
        await dialog.locator('h3').click();
        await expect(panel).toHaveCount(0);
        await dialog.locator('.popup-button-ok').click();
        const savedBooks = async () => {
            const settings = JSON.parse((await account.post('/api/settings/get')).settings);
            return settings.world_info_settings?.world_info?.charLore?.find(lore => lore.name === account.avatar.replace(/\.png$/, ''))?.extraBooks ?? [];
        };
        await expect.poll(savedBooks).toEqual([books[1], books[2]]);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await openPicker(page, account.avatar);
        await expect(select).toHaveValues(['1', '2']);
        await press(trigger);
        await press(panel.getByRole('button', { name: 'Clear', exact: true }));
        await expect(select).toHaveValues([]);
        await expect(trigger).toHaveClass(/is-placeholder/);
        await dialog.locator('h3').click();
        await dialog.locator('.popup-button-ok').click();
        await expect.poll(savedBooks).toEqual([]);
    });
}
