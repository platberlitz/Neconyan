/* global document, window */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test.setTimeout(120000);

for (const phone of [true, false]) {
    test(`Purrks connection profile uses the available width on ${phone ? 'phone' : 'desktop'}`, async ({ app }, info) => {
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context);
        const page = await account.open({ workspace: false });
        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar));
            window.NeconyanShell.openTab('characters', 'characters');
        }, account.avatar);
        await page.getByRole('button', { name: 'Edit Durable Nova', exact: true }).click();
        const panel = await page.locator('#character_purrks_block').evaluate(node => node.closest('[data-sb-character-editor-panel]').dataset.sbCharacterEditorPanel);
        await page.locator(`[data-sb-character-editor-tab="${panel}"]`).click();
        if (phone) await applyIOSOnlyCss(page);
        const select = page.getByRole('combobox', { name: 'Scene AI connection profile' });
        await expect(select).toBeVisible();
        await select.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest' }));
        await page.evaluate(() => document.fonts.ready);
        if (process.env.NECONYAN_PURRKS_SCREENSHOTS) {
            const directory = path.join(root, 'screenshots');
            await fs.mkdir(directory, { recursive: true });
            const file = path.join(directory, `purrks-${phone ? 'phone' : 'desktop'}-${process.env.NECONYAN_PURRKS_SCREENSHOTS}.png`);
            await page.screenshot({ path: file });
            await info.attach('Purrks layout', { path: file, contentType: 'image/png' });
        }
        const geometry = await select.evaluate(node => {
            const bar = node.parentElement;
            const style = window.getComputedStyle(bar);
            const bounds = bar.getBoundingClientRect();
            const field = node.getBoundingClientRect();
            return {
                width: field.width,
                available: bounds.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
                    - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth),
                right: field.right,
                viewport: window.innerWidth,
                overflow: document.documentElement.scrollWidth > window.innerWidth,
            };
        });
        await info.attach('profile geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
        expect(geometry.width).toBeGreaterThan(220);
        expect(Math.abs(geometry.width - geometry.available)).toBeLessThanOrEqual(1);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
        expect(geometry.overflow).toBe(false);
        await select.selectOption('durable');
        await expect(select).toHaveValue('durable');
        await expect.poll(() => page.evaluate(() => {
            const context = window.SillyTavern.getContext();
            return context.characters[context.characterId]?.data?.extensions?.neconyan_purrks?.autoSceneProfileId;
        })).toBe('durable');
    });
}
