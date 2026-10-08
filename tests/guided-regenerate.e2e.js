/* global window, document, getComputedStyle */
import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { test, acknowledgeActiveSettings } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

for (const phone of [true, false]) {
    test(`Guided Regenerate ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        const account = await app.account({ phone, activeConnection: true, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context);
        const page = await account.open({ workspace: false, readyTimeout: 120000 });
        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            const core = await import('/script.js');
            await core.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        const button = page.getByRole('button', { name: 'Guided Regenerate', exact: true });
        await expect(button).toBeVisible();
        await page.locator('#send_textarea').fill('Make the reply more suspicious.');
        if (phone) await applyIOSOnlyCss(page);
        await page.locator('#send_textarea').blur();
        await fs.mkdir('../screenshots', { recursive: true });
        await page.screenshot({ path: `../screenshots/guided-regenerate-${phone ? 'phone' : 'desktop'}-after.png` });
        const box = await button.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        for (const width of phone ? [320, 375, 393, 600, 768] : [1280]) {
            await page.setViewportSize({ width, height: phone ? 852 : 900 });
            await expect.poll(() => page.locator('#gg-action-button-container').evaluate(row => {
                const boxes = Array.from(row.querySelectorAll('.stih--button, .gg-action-button'))
                    .map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
                const bounds = row.getBoundingClientRect();
                return {
                    count: boxes.length,
                    rows: new Set(boxes.map(rect => Math.round(rect.y))).size,
                    fits: boxes.every(rect => rect.left >= bounds.left && rect.right <= bounds.right + 1),
                    compactTargets: boxes.every(rect => rect.width >= 26 && rect.height >= 26),
                    noOverlap: boxes.every((rect, index) => index === 0 || rect.left >= boxes[index - 1].right),
                };
            }), { message: `Composer helpers stay on one line at ${width}px` }).toEqual({
                count: 10, rows: 1, fits: true, compactTargets: true, noOverlap: true,
            });
        }
        await page.setViewportSize({ width: phone ? 393 : 1280, height: phone ? 852 : 900 });
        await button.focus();
        await button.press('Tab');
        await page.keyboard.press('Shift+Tab');
        await expect(button).toBeFocused();
        expect(await button.evaluate(element => parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThanOrEqual(2);

        // Use the real controls so the theme's contrast recalculation runs too.
        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            await page.locator('#themes').selectOption({ label: theme }, { force: true });
            for (const accent of [null, 'Mint Glass', 'Plum Wine']) {
                if (accent) await page.locator(`.sb-accent-profile-apply[title="Apply ${accent}"]`).evaluate(element => element.click());
                const contrast = () => button.evaluate(element => {
                    const style = getComputedStyle(element);
                    const canvas = document.createElement('canvas');
                    canvas.width = canvas.height = 1;
                    const context = canvas.getContext('2d');
                    const luminance = colour => {
                        context.clearRect(0, 0, 1, 1);
                        context.fillStyle = colour;
                        context.fillRect(0, 0, 1, 1);
                        const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
                            const channel = value / 255;
                            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
                        });
                        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
                    };
                    const foreground = luminance(style.color);
                    const background = luminance(style.backgroundColor);
                    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
                });
                await expect.poll(contrast, { message: `${theme}, ${accent || 'default'}` }).toBeGreaterThanOrEqual(4.5);
            }
        }
        await page.locator('#themes').selectOption({ label: 'Neconyan Calico Dark' }, { force: true });
        await page.evaluate(async () => {
            const context = window.SillyTavern.getContext();
            context.chat.splice(0, context.chat.length,
                { name: 'User', is_user: true, mes: 'Is anyone at the door?', extra: {} },
                { name: 'Durable Nova', is_user: false, mes: 'Nobody is here.', extra: {}, swipes: ['Nobody is here.'], swipe_id: 0 });
            await context.saveChat();
            await context.redisplayChat();
        });
        await acknowledgeActiveSettings(page);
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: 'Nova watches the door.' } }] };
        const submitted = page.waitForResponse(response => response.url().endsWith('/api/roleplay/workflow/submit') && response.status() === 202);
        await button.click();
        const response = await submitted;
        expect(response.request().postDataJSON().name).toBe('guided.regenerate');
        await account.settled((await response.json()).jobId);
        await expect(page.locator('#chat .mes').last()).toContainText('Nova watches the door.');
        await expect(page.locator('#chat .mes')).toHaveCount(2);
        await expect(page.locator('#send_textarea')).toHaveValue('Make the reply more suspicious.');
        expect(app.provider.calls).toHaveLength(1);
        const prompt = JSON.stringify(app.provider.calls[0].messages);
        expect(prompt).toContain('Make the reply more suspicious.');
        expect(prompt).toContain('Is anyone at the door?');
        expect(prompt).not.toContain('Nobody is here.');
        const saved = await page.evaluate(async () => {
            const core = await import('/script.js');
            const context = window.SillyTavern.getContext();
            const response = await fetch('/api/chats/get', { method: 'POST', headers: core.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: context.characters[context.characterId].avatar, file_name: context.chatId }) });
            return response.json();
        });
        expect(saved.map(record => record.mes).filter(Boolean)).toEqual(['Is anyone at the door?', 'Nova watches the door.']);
        expect(saved.at(-1).swipes ?? [saved.at(-1).mes]).toEqual(['Nova watches the door.']);

        await page.locator('#send_textarea').fill('');
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: 'Nova opens the door.' } }] };
        const plain = page.waitForResponse(result => result.url().endsWith('/api/roleplay/workflow/submit') && result.status() === 202);
        await button.click();
        const plainResponse = await plain;
        expect(plainResponse.request().postDataJSON().name).toBe('roleplay.correct');
        await account.settled((await plainResponse.json()).jobId);
        await expect(page.locator('#chat .mes').last()).toContainText('Nova opens the door.');
        expect(JSON.stringify(app.provider.calls[1].messages)).not.toContain('Make the reply more suspicious.');

        await page.evaluate(() => {
            window.NeconyanShell.openTab('right', 'extensions');
            window.NeconyanExtensions.focusUnit('Guided Generations');
        });
        const toggle = page.locator('#gg_showGuidedRegenerate');
        await expect(toggle).toBeVisible();
        await page.locator('#gg_promptGuidedRegenerate').scrollIntoViewIfNeeded();
        if (phone) await applyIOSOnlyCss(page);
        await page.screenshot({ path: `../screenshots/guided-regenerate-${phone ? 'phone' : 'desktop'}-settings.png` });
        await toggle.uncheck();
        await expect(button).toHaveCount(0);
        await page.locator('#gg_promptGuidedRegenerate').fill('New direction: {{input}}');
        await page.locator('#gg_depthPromptGuidedRegenerate').fill('2');
        await page.evaluate(async () => (await import('/script.js')).saveSettings(0));
        const settings = JSON.parse((await account.post('/api/settings/get')).settings);
        expect(settings.extension_settings['guided-generations']).toMatchObject({
            showGuidedRegenerate: false, promptGuidedRegenerate: 'New direction: {{input}}', depthPromptGuidedRegenerate: 2,
        });
    });
}
