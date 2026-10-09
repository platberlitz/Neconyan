/* global document, window, getComputedStyle */
import { expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} slash command workflow`, async ({ app }) => {
        const account = await app.account({ phone, activeConnection: true, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context);
        const page = await account.open({ workspace: false });
        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        if (phone) await applyIOSOnlyCss(page);
        const input = page.locator('#send_textarea');
        const send = page.locator('#send_but');
        const submit = async command => {
            await input.fill(command);
            await input.blur();
            if (phone) await send.tap();
            else await send.click();
        };
        await expect(input).toBeVisible();
        await input.fill('/ec Keep this draft | /pass keep this too');
        await input.evaluate(element => {
            element.setSelectionRange(3, 3);
            element.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await input.press('Control+Space');
        const suggestion = page.locator('.autoComplete-wrap li[data-name="echo"]');
        await expect(suggestion).toBeVisible();
        await mkdir('../screenshots', { recursive: true });
        const prefix = `../screenshots/slash-${phone ? 'phone' : 'desktop'}-after`;
        await page.screenshot({ path: `${prefix}-completion.png` });
        if (phone) await suggestion.tap();
        else await suggestion.click();
        await expect(input).toHaveValue('/echo Keep this draft | /pass keep this too');

        // Read the draft from an automation without sending or modifying it.
        expect(await page.evaluate(async () => (await (await import('/scripts/slash-commands.js'))
            .executeSlashCommandsWithOptions('/getinput')).pipe)).toBe('/echo Keep this draft | /pass keep this too');
        await expect(input).toHaveValue('/echo Keep this draft | /pass keep this too');

        const audit = await page.evaluate(async () => {
            const { executeSlashCommandsWithOptions: run } = await import('/scripts/slash-commands.js');
            const { power_user } = await import('/scripts/power-user.js');
            power_user.experimental_macro_engine = false;
            const indexed = await run('/let key=items ["first","second"] | /pass {{var::items::1}}');
            const invalid = await run('/not-a-real-neconyan-command');
            return { indexed: indexed.pipe, invalidIsError: invalid.isError };
        });
        expect(audit).toEqual({ indexed: 'second', invalidIsError: true });
        await submit('/not-a-real-neconyan-command <img id="slash-error-html">');
        await expect(input).toHaveValue('/not-a-real-neconyan-command <img id="slash-error-html">');
        await expect(page.locator('#slash-error-html')).toHaveCount(0);
        await page.evaluate(async () => {
            window.toastr.remove();
            const core = await import('/script.js');
            window.slashGenerationEvents = 0;
            core.eventSource.on(core.event_types.GENERATION_STARTED, () => window.slashGenerationEvents++);
        });

        app.provider.mode.hold = 'conversation-fixture';
        await input.fill('Keep replying while I use a command.');
        if (phone) await send.tap();
        else await send.click();
        await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(1);
        await input.fill('Keep this ordinary draft');
        await expect(send).toBeHidden();
        await input.press('Enter');
        await expect(input).toHaveValue('Keep this ordinary draft');
        expect(await page.evaluate(async () => {
            const { executeSlashCommandsWithOptions: run } = await import('/scripts/slash-commands.js');
            return [(await run('/is-generating')).pipe, (await run('/wait-generation timeout=20')).pipe];
        })).toEqual(['true', 'false']);
        await input.fill('/echo Slash command ran');
        await input.blur();
        await expect(send).toBeVisible();
        await page.screenshot({ path: `${prefix}-generating.png` });
        const buttons = await page.locator('#send_but, #mes_stop').evaluateAll(elements => elements.map(element => {
            const rect = element.getBoundingClientRect();
            return { x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom, width: rect.width, height: rect.height };
        }));
        expect(buttons[0].right <= buttons[1].x || buttons[1].right <= buttons[0].x).toBe(true);
        for (const button of buttons) {
            expect(button.x).toBeGreaterThanOrEqual(0);
            expect(button.right).toBeLessThanOrEqual(phone ? 393 : 1280);
            expect(button.bottom).toBeLessThanOrEqual(phone ? 852 : 900);
            if (phone) expect(Math.abs(button.width - button.height)).toBeLessThan(1);
        }
        for (const profile of [null, 'Pearl', 'Midnight Ink']) {
            if (profile) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${profile} accent profile"]`).evaluate(element => element.click());
            const contrast = await send.evaluate(async element => {
                const { contrastRatio } = await import('/scripts/theme-contrast.js');
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                const channels = colour => {
                    ctx.fillStyle = colour;
                    ctx.fillRect(0, 0, 1, 1);
                    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
                };
                const style = getComputedStyle(element);
                return contrastRatio(channels(style.color), channels(style.backgroundColor));
            });
            expect(contrast).toBeGreaterThanOrEqual(4.5);
        }
        await page.locator('.sb-accent-profile-apply').first().evaluate(element => element.click());
        if (phone) await send.tap();
        else await send.click();
        await expect(page.locator('#toast-container')).toContainText('Slash command ran');
        await expect(input).toHaveValue('');
        await expect(page.locator('#mes_stop')).toBeVisible();
        expect(app.provider.calls).toHaveLength(1);
        expect(app.provider.calls[0].completedAt).toBeNull();
        expect(await page.evaluate(() => window.slashGenerationEvents)).toBe(1);
        await input.press('Alt+ArrowUp');
        await expect(input).toHaveValue('/echo Slash command ran');

        // Script cancellation is independent of reply cancellation, including on phones.
        for (const command of ['/delay 60000 | /echo Should never run', '/wait-generation | /echo Should never run', '/trigger await=true | /echo Should never run']) {
            await submit(command);
            const stopScript = page.locator('.stscript_stop');
            await expect(stopScript).toBeVisible();
            await input.fill('A newer draft survives script cancellation');
            if (command.startsWith('/delay')) await page.screenshot({ path: `${prefix}-script-stop.png` });
            if (phone) await stopScript.tap();
            else await stopScript.click();
            await expect(stopScript).toBeHidden({ timeout: 2000 });
            await expect(input).toHaveValue('A newer draft survives script cancellation');
            await expect(page.locator('#mes_stop')).toBeVisible();
            await expect(page.locator('#toast-container')).not.toContainText('Should never run');
            expect(app.provider.calls[0].completedAt).toBeNull();
        }

        await input.fill('/stop');
        if (phone) await send.tap();
        else await input.press('Enter');
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).isGenerating())).toBe(false);
        expect(await page.evaluate(async () => {
            const { executeSlashCommandsWithOptions: run } = await import('/scripts/slash-commands.js');
            return [(await run('/is-generating')).pipe, (await run('/wait-generation')).pipe];
        })).toEqual(['false', 'true']);
    });
}
