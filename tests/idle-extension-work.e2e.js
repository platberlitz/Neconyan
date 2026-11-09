/* global window, document, MutationObserver */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} disabled speech and unchanged guides have no recurring checks`, async ({ app }) => {
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(saved) {
            saved.extension_settings.tts = { ...saved.extension_settings.tts, enabled: false };
            saved.power_user.neconyan_shell_style = 'clean-minimal';
        } });
        if (phone) await installIPhoneSafari(account.context);
        await account.context.addInitScript(() => {
            window.addEventListener('neconyan:ready', () => { window.idleWorkReady = true; });
            const start = window.setInterval;
            const stop = window.clearInterval;
            const active = new Map();
            window.idleWork = { active, calls: { speech: 0, guides: 0 } };
            window.setInterval = function (callback, ms, ...args) {
                const stack = new Error().stack;
                const feature = stack.includes('/extensions/tts/index.js') ? 'speech'
                    : stack.includes('/extensions/guided-generations/index.js') ? 'guides' : null;
                const id = start.call(window, feature ? (...values) => {
                    window.idleWork.calls[feature]++;
                    return callback(...values);
                } : callback, ms, ...args);
                if (feature) active.set(id, feature);
                return id;
            };
            window.clearInterval = function (id) {
                active.delete(id);
                return stop.call(window, id);
            };
        });
        const page = await account.open({ workspace: false, readyTimeout: 120000 });
        await page.waitForFunction(() => window.idleWorkReady, null, { timeout: 120000 });
        await page.locator('#neconyan-home-skeleton').waitFor({ state: 'hidden' });
        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        if (phone) await applyIOSOnlyCss(page, { inPlace: true });
        // The separate Quick Reply discovery timer has a bounded 30-second lifetime.
        await expect.poll(() => page.evaluate(() => [...window.idleWork.active.values()]), { timeout: 45000 }).toEqual([]);
        const idle = await page.evaluate(() => new Promise(resolve => {
            window.idleWork.calls = { speech: 0, guides: 0 };
            window.setTimeout(() => resolve(window.idleWork.calls), 4500);
        }));
        expect(idle).toEqual({ speech: 0, guides: 0 });

        const guides = page.locator('#gg_flush_guides_button');
        const command = text => page.evaluate(async value => {
            const { executeSlashCommandsWithOptions } = await import('/scripts/slash-commands.js');
            await executeSlashCommandsWithOptions(value);
        }, text);
        await command('/inject id=gg-guided-response Keep the reply concise.');
        await expect(guides).toHaveAttribute('data-active-count', '1');
        await command('/inject id=gg-guided-swipe Offer another reply.');
        await expect(guides).toHaveAttribute('data-active-count', '2');
        await command('/flushinject gg-guided-response');
        await expect(guides).toHaveAttribute('data-active-count', '1');
        await command('/inject id=gg-guided-swipe');
        await expect(guides).toHaveAttribute('data-active-count', '0');
        await command('/inject id=gg-guided-response ephemeral=true One reply only.');
        await expect(guides).toHaveAttribute('data-active-count', '1');
        await page.evaluate(async () => {
            const { eventSource, event_types } = await import('/script.js');
            await eventSource.emit(event_types.GENERATION_STOPPED);
        });
        await expect(guides).toHaveAttribute('data-active-count', '0');
        await command('/inject id=gg-guided-response Another guide.');
        await command('/flushinject');
        await expect(guides).toHaveAttribute('data-active-count', '0');

        // Settings changes restart one worker, and repeated changes never duplicate it.
        await page.evaluate(async () => {
            const { extension_settings } = await import('/scripts/extensions.js');
            const { eventSource, event_types } = await import('/script.js');
            extension_settings.tts.enabled = true;
            await eventSource.emit(event_types.SETTINGS_UPDATED);
            await eventSource.emit(event_types.SETTINGS_UPDATED);
        });
        expect(await page.evaluate(() => [...window.idleWork.active.values()])).toEqual(['speech']);
        await expect.poll(() => page.evaluate(() => window.idleWork.calls.speech)).toBeGreaterThan(0);
        const unchangedWrites = await page.evaluate(() => new Promise(resolve => {
            let writes = 0;
            const observer = new MutationObserver(records => { writes += records.length; });
            observer.observe(document.getElementById('tts_media_control'), { attributes: true });
            window.setTimeout(() => { observer.disconnect(); resolve(writes); }, 2500);
        }));
        expect(unchangedWrites).toBe(0);
        await page.evaluate(async () => {
            const { extension_settings } = await import('/scripts/extensions.js');
            const { eventSource, event_types } = await import('/script.js');
            extension_settings.tts.enabled = false;
            await eventSource.emit(event_types.SETTINGS_UPDATED);
        });
        expect(await page.evaluate(() => [...window.idleWork.active.values()])).toEqual([]);
    });
}
