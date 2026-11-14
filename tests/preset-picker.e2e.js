/* global document, window, getComputedStyle, innerWidth, innerHeight */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

const NAMES = ['Slow Burn Romance', 'Terse Narrator', 'Group Chat Director', 'Kitchen Sink Experimental Preset With A Very Long Name For Wrapping'];

async function seededAccount(app, phone) {
    let preset;
    const account = await app.account({ phone, activeConnection: true, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings: settings => {
        Object.assign(settings.oai_settings, { preset_settings_openai: NAMES[0], bind_preset_to_connection: false });
        preset = structuredClone(settings.oai_settings);
    } });
    if (phone) await installIPhoneSafari(account.context, { standalone: true });
    for (const name of NAMES) await account.post('/api/presets/save', { apiId: 'openai', name, preset });
    return account;
}

async function buttonContrast(page) {
    return page.evaluate(async () => {
        const { contrastRatio } = await import('/scripts/theme-contrast.js');
        const context = document.createElement('canvas').getContext('2d');
        const channels = colour => {
            context.fillStyle = colour;
            context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        return [...document.querySelectorAll('#sb-openai-preset-picker button, #sb-openai-preset-picker-button')].map(button => {
            const style = getComputedStyle(button);
            return contrastRatio(channels(style.color), channels(style.backgroundColor));
        });
    });
}

for (const phone of [false, true]) {
    test(`Chat Completion presets open the chat browser's searchable list on ${phone ? 'iPhone emulation' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await seededAccount(app, phone);
        const page = await account.open({ workspace: false });
        if (phone) await applyIOSOnlyCss(page);
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'presets'));
        const invitation = page.getByRole('button', { name: 'Not now', exact: true });
        if (await invitation.isVisible()) await invitation.click();

        const select = page.locator('#settings_preset_openai');
        const trigger = page.locator('#sb-openai-preset-picker-button');
        const panel = page.locator('#sb-openai-preset-picker');
        const rows = panel.locator('.sb-chat-picker-row');
        await expect(select).toBeHidden();
        await expect(trigger).toBeVisible();
        await expect(trigger).toHaveAccessibleName(`Chat Completion Presets ${NAMES[0]}`);
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
        expect((await trigger.boundingBox()).height).toBeGreaterThanOrEqual(44);

        await trigger.click();
        await expect(trigger).toHaveAttribute('aria-expanded', 'true');
        const total = await select.locator('option').count();
        expect(total).toBeGreaterThanOrEqual(NAMES.length);
        await expect(rows).toHaveCount(total);
        await expect(panel.locator('[aria-current="true"]')).toHaveAttribute('title', NAMES[0]);
        await expect(panel.locator('[aria-current="true"] .sb-chat-picker-current')).toHaveText('Current');
        const search = panel.getByRole('searchbox', { name: 'Search presets' });
        if (phone) await expect(panel.locator('[aria-current="true"]')).toBeFocused();
        else await expect(search).toBeFocused();

        // A body-level layer just below the trigger, inside the viewport and above the drawers.
        const viewport = page.viewportSize();
        const box = await panel.boundingBox();
        const anchor = await trigger.boundingBox();
        expect(await panel.evaluate(node => node.parentElement === document.body)).toBe(true);
        expect(box.y).toBeGreaterThanOrEqual(anchor.y + anchor.height);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
        expect(await panel.evaluate(node => {
            const rect = node.getBoundingClientRect();
            return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        })).toBe(true);
        await expect(panel.locator('.sb-chat-picker-list')).toHaveCSS('overscroll-behavior', 'contain');

        await search.fill('TERSE narrator');
        await expect(rows).toHaveCount(1);
        await expect(panel.locator('.sb-chat-picker-count')).toHaveText(`1 / ${total}`);
        await search.fill('missing preset');
        await expect(panel.getByRole('status')).toHaveText('No matches');
        await search.press('Escape');
        await expect(search).toHaveValue('');
        await expect(rows).toHaveCount(total);

        // Pressing inside the layer keeps it and the settings drawer open.
        await panel.locator('.sb-chat-picker-title').click();
        await expect(panel).toBeVisible();
        await expect(page.locator('#left-nav-panel')).toHaveClass(/openDrawer/);

        await page.evaluate(() => {
            window.fixturePresetChanges = [];
            document.getElementById('settings_preset_openai').addEventListener('change', event => window.fixturePresetChanges.push(event.target.selectedOptions[0].label));
        });
        await panel.getByTitle(NAMES[2], { exact: true }).click();
        await expect(panel).toHaveCount(0);
        await expect(trigger).toBeFocused();
        await expect(trigger).toHaveAccessibleName(`Chat Completion Presets ${NAMES[2]}`);
        await expect.poll(() => page.evaluate(() => window.fixturePresetChanges)).toEqual([NAMES[2]]);
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/openai.js')).oai_settings.preset_settings_openai)).toBe(NAMES[2]);

        // Code that sets the select without a change event still updates the trigger.
        await page.evaluate(name => {
            const option = [...document.querySelectorAll('#settings_preset_openai option')].find(node => node.textContent === name);
            window.$('#settings_preset_openai').val(option.value);
        }, NAMES[1]);
        await expect(trigger).toHaveAccessibleName(`Chat Completion Presets ${NAMES[1]}`);
        await page.evaluate(name => {
            window.$('#settings_preset_openai').append(new window.Option(name, 'fixture-added'));
            window.$('#settings_preset_openai option[value="fixture-added"]').prop('selected', true);
        }, 'Added by code');
        await expect(trigger).toHaveAccessibleName('Chat Completion Presets Added by code');
        await page.evaluate(() => window.$('#settings_preset_openai option[value="fixture-added"]').remove());
        await expect(trigger).not.toHaveAccessibleName(/Added by code/);

        if (!phone) {
            await trigger.focus();
            await page.keyboard.press('ArrowDown');
            await expect(panel).toBeVisible();
            await expect(search).toBeFocused();
            await page.keyboard.press('ArrowDown');
            await expect(rows.first()).toBeFocused();
            await page.keyboard.press('Escape');
            await expect(panel).toHaveCount(0);
            await expect(trigger).toBeFocused();
        }

        // Pressing elsewhere in the drawer closes the list but not the drawer.
        await trigger.click();
        await expect(panel).toBeVisible();
        const outside = await page.evaluate(() => {
            const layer = document.getElementById('sb-openai-preset-picker');
            const drawer = document.getElementById('left-nav-panel');
            for (let y = 12; y < innerHeight; y += 23) {
                for (let x = 12; x < innerWidth; x += 29) {
                    const node = document.elementFromPoint(x, y);
                    if (node && drawer.contains(node) && !layer.contains(node) && !node.closest('button, a, input, select, textarea, label, summary, [role], [tabindex], [onclick], .menu_button, .inline-drawer-toggle')) return { x, y };
                }
            }
            return null;
        });
        expect(outside).not.toBeNull();
        await page.mouse.click(outside.x, outside.y);
        await expect(panel).toHaveCount(0);
        await expect(page.locator('#left-nav-panel')).toHaveClass(/openDrawer/);

        const results = [];
        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            await page.locator('#themes').evaluate((node, name) => { node.value = name; node.dispatchEvent(new Event('change', { bubbles: true })); }, theme);
            const gingers = new Set();
            for (const accent of ['default', 'Mint Glass', 'Plum Wine']) {
                if (accent !== 'default') {
                    await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(node => node.click());
                    await expect(page.locator('html')).toHaveAttribute('data-neconyan-accent', 'custom');
                }
                if (!await panel.count()) await trigger.click();
                await expect(panel).toBeVisible();
                const ginger = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--neco-ginger').trim());
                gingers.add(ginger);
                const contrast = await buttonContrast(page);
                expect(contrast.length).toBeGreaterThan(total);
                results.push({ theme, accent, ginger, lowest: Math.min(...contrast) });
                expect(Math.min(...contrast), `${theme}, ${accent}: readable trigger and rows`).toBeGreaterThanOrEqual(4.5);
            }
            expect(gingers.size, `${theme}: each accent profile changes the accent`).toBe(3);
        }
        console.log('PRESET_PICKER_CONTRAST', JSON.stringify(results));
        await page.close();
    });
}
