/* global document, getComputedStyle, globalThis */
/* eslint-disable playwright/no-conditional-in-test -- Both viewport variants share the same checks with optional iOS emulation. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const CHANGE = '```scratchpad-change\n{"type":"persona","action":"replace","field":"description","value":"Tall."}\n```';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} Scratchpad reads a reply aloud and can stop it`, async ({ app }) => {
        test.setTimeout(150000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await expect(page.locator('.scratchpad-composer')).toBeEnabled();
        if (phone) await applyIOSOnlyCss(page);

        // The real text to speech extension offers what Scratchpad needs to start, watch and stop playback.
        await expect.poll(() => page.evaluate(async () => {
            const { getExtensionCapability } = await import('/scripts/neconyan-conversation/extension-capabilities.js');
            const tts = getExtensionCapability('tts');
            return ['narrateTtsMessage', 'stopPlayback', 'isPlaying'].map(name => typeof tts?.[name]);
        })).toEqual(['function', 'function', 'function']);

        // Headless browsers have no voices, so a stand-in records what would be spoken.
        await page.evaluate(async () => {
            const { registerExtensionCapability } = await import('/scripts/neconyan-conversation/extension-capabilities.js');
            const spoken = globalThis.scratchpadSpoken = { calls: [], playing: false, stops: 0 };
            registerExtensionCapability('tts', {
                narrateTtsMessage: async (message, options) => { spoken.calls.push({ message, options }); spoken.playing = true; return true; },
                stopPlayback: () => { spoken.stops += 1; spoken.playing = false; },
                isPlaying: () => spoken.playing,
            });
        });

        app.provider.mode.streamReply = () => ({ first: 'The harbour is quiet [1].', rest: `\n\n${CHANGE}\n\nSee https://example.com/tide for more.` });
        const sent = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-composer').fill('What is the harbour like?');
        await page.locator('.scratchpad-send').click();
        const response = await sent;
        expect(response.ok(), await response.text()).toBe(true);
        await expect(page.locator('.scratchpad-stream')).toContainText('The harbour is quiet');
        app.provider.calls.at(-1).finishStream();
        await account.settled((await response.json()).job.id);
        await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);

        const reply = page.locator('.scratchpad-message.is-assistant');
        await expect(reply).toHaveCount(1);
        await reply.locator('summary[aria-label="Message actions"]').click();
        const read = reply.getByRole('button', { name: 'Read aloud', exact: true });
        await expect(read).toBeVisible();
        await expect(read).toHaveAttribute('aria-pressed', 'false');
        const box = await read.boundingBox();
        expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(phone ? 44 : 32);
        // Your own messages are not offered for reading.
        await page.locator('.scratchpad-message.is-user summary[aria-label="Message actions"]').click();
        await expect(page.locator('.scratchpad-message.is-user').getByRole('button', { name: 'Read aloud', exact: true })).toHaveCount(0);
        await page.screenshot({ path: `../screenshots/scratchpad-read-aloud/${phone ? 'phone' : 'desktop'}-button.png` });

        await read.click();
        const stop = reply.getByRole('button', { name: 'Stop reading', exact: true });
        await expect(stop).toBeVisible();
        await expect(stop).toHaveAttribute('aria-pressed', 'true');
        await expect(stop).toBeFocused();
        const spoken = await page.evaluate(() => globalThis.scratchpadSpoken.calls);
        expect(spoken).toHaveLength(1);
        expect(spoken[0].message.mes).toBe('The harbour is quiet.\n\nSee for more.');
        expect(spoken[0].message.name).toBeTruthy();
        expect(spoken[0].options).toMatchObject({ manual: true, force: true });
        await page.screenshot({ path: `../screenshots/scratchpad-read-aloud/${phone ? 'phone' : 'desktop'}-reading.png` });

        // The pressed button is filled with the accent, and its icon stays readable on every accent.
        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            await page.locator('#themes').selectOption({ label: theme }, { force: true });
            for (const accent of [null, 'Pearl', 'Midnight Ink']) {
                if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
                const measured = await stop.evaluate(async element => {
                    const { contrastRatio } = await import('/scripts/theme-contrast.js');
                    const context = document.createElement('canvas').getContext('2d');
                    const channels = colour => {
                        context.clearRect(0, 0, 1, 1);
                        context.fillStyle = colour;
                        context.fillRect(0, 0, 1, 1);
                        return [...context.getImageData(0, 0, 1, 1).data];
                    };
                    const fill = channels(getComputedStyle(element).backgroundColor);
                    return { alpha: fill[3], contrast: contrastRatio(channels(getComputedStyle(element.querySelector('i')).color).slice(0, 3), fill.slice(0, 3)) };
                });
                expect(measured.alpha, `${theme} ${accent ?? 'default'}`).toBe(255);
                expect(measured.contrast, `${theme} ${accent ?? 'default'}`).toBeGreaterThanOrEqual(4.5);
            }
        }

        await stop.click();
        await expect(read).toBeVisible();
        await expect(read).toBeFocused();
        expect(await page.evaluate(() => globalThis.scratchpadSpoken.stops)).toBe(1);

        // When playback ends by itself the button returns without a press.
        await read.click();
        await expect(stop).toBeVisible();
        await page.evaluate(() => { globalThis.scratchpadSpoken.playing = false; });
        await expect(read).toBeVisible();
        expect(await page.evaluate(() => globalThis.scratchpadSpoken.stops)).toBe(1);

        // Closing Scratchpad stops the voice.
        await read.click();
        await expect(stop).toBeVisible();
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).hideScratchpad());
        expect(await page.evaluate(() => globalThis.scratchpadSpoken)).toMatchObject({ stops: 2, playing: false });
    });
}
