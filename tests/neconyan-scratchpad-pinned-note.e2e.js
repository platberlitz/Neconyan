/* global document, getComputedStyle, window */
/* eslint-disable playwright/no-conditional-in-test -- Baseline captures and both viewport sizes use the same fixture. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';
import { settleCssTransitions } from './chat-scroll-regression-helpers.js';

const before = process.env.NECONYAN_SCRATCHPAD_BEFORE === '1';
if (before) test.use({ initialServerOptions: { checkoutRoot: '/srv/projects/Neconyan' } });
const NOTE = 'Goal: reach the harbour.\nLoose end: the brass key. TRACKER-KEY';

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} a pinned note follows its session and keeps conflicting drafts`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        const open = async (tab = 'chat') => {
            await page.evaluate(async tab => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab }), tab);
            if (phone) await applyIOSOnlyCss(page);
        };
        await open();
        await page.evaluate(() => window.toastr.remove());
        const prefix = `../screenshots/scratchpad-pinned-note/${phone ? 'phone' : 'desktop'}`;
        const button = page.locator('.scratchpad-pinned-note');
        if (before) {
            await expect(button).toHaveCount(0);
            await page.screenshot({ path: `${prefix}-before.png` });
            return;
        }
        await expect(button).toHaveText('Pinned note');
        await expect(button).toBeVisible();
        await page.screenshot({ path: `${prefix}-after.png` });
        const bounds = await button.boundingBox();
        expect(bounds.height).toBeGreaterThanOrEqual(phone ? 44 : 32);
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(phone ? 393 : 1280);

        await button.click();
        const dialog = page.locator('dialog[open]');
        const editor = dialog.getByRole('textbox', { name: 'Pinned note text', exact: true });
        await editor.fill('Discard this draft');
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await button.click();
        await expect(editor).toHaveValue('');
        await editor.fill(NOTE);
        await page.screenshot({ path: `${prefix}-editor.png` });
        const saving = page.waitForResponse('**/api/scratchpad/session/update');
        await dialog.getByRole('button', { name: 'Save note', exact: true }).click();
        const saved = await saving;
        expect(saved.ok(), await saved.text()).toBe(true);
        const { source, sessionId } = saved.request().postDataJSON();
        await expect(dialog).toHaveCount(0);
        await expect(button).toHaveText('Pinned note (saved)');

        // A second tab changes the saved note while this editor holds a draft.
        await button.click();
        await editor.fill('My unsaved version');
        await account.post('/api/scratchpad/session/update', { source, sessionId, changes: { pinnedNote: 'Other tab', expectedPinnedNote: NOTE } });
        await dialog.getByRole('button', { name: 'Save note', exact: true }).click();
        await expect(dialog.getByRole('alert')).toContainText('changed elsewhere');
        await expect(editor).toHaveValue('My unsaved version');
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await account.post('/api/scratchpad/session/update', { source, sessionId, changes: { pinnedNote: NOTE, expectedPinnedNote: 'Other tab' } });

        await open('context');
        await page.getByRole('button', { name: 'Show preview', exact: true }).click();
        const preview = page.locator('.scratchpad-preview-text');
        await expect(preview).toContainText('TRACKER-KEY');
        const previewText = await preview.textContent();
        const noteBlock = previewText.slice(previewText.indexOf('<pinned_note>'));
        await page.locator('[id^="scratchpad-connection-"]').first().selectOption('durable');
        await page.getByRole('checkbox', { name: 'Stream replies' }).uncheck();
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        const question = 'What is the loose end?';
        app.provider.mode.reply = { choices: [{ message: { content: 'The brass key.' } }] };
        await page.locator('.scratchpad-composer').fill(question);
        const sending = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const sent = await sending;
        expect(sent.ok(), await sent.text()).toBe(true);
        await account.settled((await sent.json()).job.id);
        await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
        const call = app.provider.calls.find(call => call.messages?.at(-1)?.content === question);
        expect(call.messages.find(message => String(message.content).startsWith('<pinned_note>')).content).toBe(noteBlock);

        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            await page.locator('#themes').selectOption({ label: theme }, { force: true });
            for (const accent of [null, 'Pearl', 'Midnight Ink']) {
                if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
                await settleCssTransitions(page);
                const contrast = await button.evaluate(async element => {
                    const { contrastRatio } = await import('/scripts/theme-contrast.js');
                    const canvas = document.createElement('canvas').getContext('2d');
                    const channels = colour => {
                        canvas.fillStyle = colour;
                        canvas.fillRect(0, 0, 1, 1);
                        return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3);
                    };
                    let surface = element;
                    while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
                    return contrastRatio(channels(getComputedStyle(element).color), channels(getComputedStyle(surface ?? document.body).backgroundColor));
                });
                expect(contrast, `${theme} ${accent ?? 'default'}`).toBeGreaterThanOrEqual(4.5);
            }
        }
        await page.reload();
        await page.locator('body.neconyan-rail-ready').waitFor();
        await page.evaluate(async avatar => (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar), account.avatar);
        await open();
        await button.click();
        await expect(editor).toHaveValue(NOTE);
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.locator('.scratchpad-header .scratchpad-new-session').click();
        await expect(button).toHaveText('Pinned note');
        await button.click();
        await expect(editor).toHaveValue('');
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });
}
