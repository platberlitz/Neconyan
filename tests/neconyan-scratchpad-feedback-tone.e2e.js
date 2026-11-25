/* global document, getComputedStyle */
/* eslint-disable playwright/no-conditional-in-test -- Both viewport variants share the same checks with optional iOS emulation. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';
import { openScratchpadContext, openContextDrawer } from './neconyan-scratchpad-context-helpers.js';

const QUESTION = 'Is my opening line any good?';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} Feedback tone saves a shared tone and per-assistant overrides into each speaker's prompt`, async ({ app }) => {
        test.setTimeout(150000);
        const size = phone ? 'phone' : 'desktop';
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings: saved => {
            const profiles = saved.extension_settings.connectionManager.profiles;
            for (const id of ['miso', 'taro', 'nori']) profiles.push({ ...profiles[0], id: `tone-${id}`, name: id, model: `tone-${id}` });
        } });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await expect(page.locator('.scratchpad-composer')).toBeEnabled();
        if (phone) await applyIOSOnlyCss(page);
        const source = await page.evaluate(async () => {
            const context = await import('/scripts/scratchpad/context.js');
            return context.wireSource(context.currentSource());
        });
        const savedSettings = async () => {
            const { bucket } = await account.post('/api/scratchpad/bucket', { source });
            return bucket.sessions.find(session => session.id === bucket.activeSessionId)?.settings;
        };

        const chatTone = page.locator('#scratchpad-feedback-tone');
        await expect(chatTone).toHaveAttribute('aria-valuetext', 'Neutral');
        await expect(page.locator('.scratchpad-tone-row .scratchpad-tone-value')).toHaveText('Neutral');
        await chatTone.focus();
        await page.keyboard.press('ArrowRight');
        await expect(chatTone).toHaveAttribute('aria-valuetext', 'Harsher');
        await expect.poll(async () => (await savedSettings())?.feedbackTone).toBe('harsher');

        await openScratchpadContext(page, 'replies');
        await openContextDrawer(page, 'other-assistants');
        for (const id of ['miso', 'taro', 'nori']) await page.locator(`#scratchpad-connection-${id}`).selectOption(`tone-${id}`);
        const contextTone = page.locator('#scratchpad-context-tone');
        await expect(contextTone).toHaveAttribute('aria-valuetext', 'Harsher');
        await expect(page.locator('#scratchpad-context-tone-description')).toHaveText(/Leads with the biggest problem/);
        await page.locator('.scratchpad-tone-overrides-list > summary').click();
        await expect(page.locator('#scratchpad-tone-taro option').first()).toHaveText('Same as shared (Harsher)');
        await page.locator('#scratchpad-tone-miso').selectOption('nicer');
        await page.locator('#scratchpad-tone-taro').selectOption('critical');
        await expect.poll(async () => (await savedSettings())?.assistantTones).toEqual({ miso: 'nicer', taro: 'critical' });

        // Tapping a stop name commits it just like the range does.
        await page.locator('.scratchpad-tone-settings .scratchpad-tone-stop[data-tone="nicer"]').click();
        await expect(contextTone).toHaveAttribute('aria-valuetext', 'Nicer');
        await expect(page.locator('#scratchpad-tone-nori option').first()).toHaveText('Same as shared (Nicer)');
        await page.locator('.scratchpad-tone-settings .scratchpad-tone-stop[data-tone="harsher"]').click();
        await expect.poll(async () => (await savedSettings())?.feedbackTone).toBe('harsher');

        const targets = await page.locator('.scratchpad-tone-settings').locator('.scratchpad-tone-range, .scratchpad-tone-stop, .scratchpad-tone-overrides-list > summary, select')
            .evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
        expect(Math.min(...targets)).toBeGreaterThanOrEqual(phone ? 44 : 24);
        // The app-wide range style paints a grey pill and dims the slider; only the tone track should show.
        await contextTone.hover();
        expect(await contextTone.evaluate(element => {
            const style = getComputedStyle(element);
            return { background: style.backgroundColor, filter: style.filter, shadow: style.boxShadow };
        })).toEqual({ background: 'rgba(0, 0, 0, 0)', filter: 'none', shadow: 'none' });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
        await page.locator('.scratchpad-tone-settings').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../screenshots/scratchpad-feedback-tone-context-${size}-after.png` });

        // The editable prompt stays tone-free; the tone is shown beside it and still follows a saved custom prompt.
        await page.getByRole('button', { name: 'View or edit Taro\'s prompt', exact: true }).click();
        const editor = page.getByRole('textbox', { name: 'Assistant prompt', exact: true });
        await expect(editor).toHaveValue(/Taro/);
        expect(await editor.inputValue()).not.toContain('Feedback tone:');
        const tonePrompt = page.locator('.scratchpad-tone-prompt');
        await expect(tonePrompt.locator('summary')).toHaveText('Added after this prompt for the Unreasonably critical feedback tone');
        await tonePrompt.locator('summary').click();
        await expect(tonePrompt).toContainText('drop the act and answer kindly');
        await page.getByRole('button', { name: 'Save prompt', exact: true }).click();

        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await expect(chatTone).toHaveAttribute('aria-valuetext', 'Harsher');
        // Only the assistants taking part are listed, so Taro joins the note with the round table.
        await expect(page.locator('.scratchpad-tone-overrides')).toHaveText('Miso uses Nicer');
        await page.locator('.scratchpad-round-table').click();
        await expect(page.locator('.scratchpad-send')).toHaveAccessibleName('Ask 3');
        await expect(page.locator('.scratchpad-tone-overrides')).toHaveText('Miso uses Nicer, Taro uses Unreasonably critical');
        const rangeBox = await chatTone.boundingBox();
        expect(rangeBox.height).toBeGreaterThanOrEqual(phone ? 44 : 24);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
        await page.screenshot({ path: `../screenshots/scratchpad-feedback-tone-chat-${size}-after.png` });

        app.provider.mode.streamReply = body => ({ first: `${body.model} judges `, rest: 'the opening line.' });
        await page.locator('.scratchpad-composer').fill(QUESTION);
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await accepted;
        expect(response.ok(), await response.text()).toBe(true);
        const result = await response.json();
        await expect.poll(() => app.provider.calls.filter(call => call.messages?.at(-1)?.content === QUESTION).length).toBe(3);
        const calls = app.provider.calls.filter(call => call.messages?.at(-1)?.content === QUESTION);
        const toneOf = model => calls.find(call => call.model === model).messages[0].content.match(/Feedback tone: ([A-Za-z ]+)\./)?.[1];
        expect(toneOf('tone-miso')).toBe('Nicer');
        expect(toneOf('tone-taro')).toBe('Unreasonably critical');
        expect(toneOf('tone-nori')).toBe('Harsher');
        await expect(chatTone).toBeDisabled();
        for (const call of calls) call.finishStream();
        await account.settled(result.job.id);
        await expect(page.locator('.scratchpad-message.is-assistant.is-done')).toHaveCount(3);
        await expect(chatTone).toBeEnabled();

        await page.locator('.scratchpad-overview-toggle').click();
        await expect(page.locator('.scratchpad-overview-bar .scratchpad-tone-badge')).toHaveText('Harsher');
    });
}
