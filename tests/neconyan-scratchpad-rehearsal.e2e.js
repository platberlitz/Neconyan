/* global document, getComputedStyle, window */
/* eslint-disable playwright/no-conditional-in-test -- Both modes and viewports share one interaction contract. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';
import { settleCssTransitions } from './chat-scroll-regression-helpers.js';

const before = process.env.NECONYAN_SCRATCHPAD_BEFORE === '1';
if (before) test.use({ initialServerOptions: { checkoutRoot: '/srv/projects/Neconyan' } });
const DRAFT = 'Nova pauses at the doorway.\n```scratchpad-change\n{"type":"authors-note","action":"replace","value":"Should not apply"}\n```';

for (const phone of [false, true]) {
    for (const kind of ['roleplay', 'conversation']) {
        test(`${phone ? 'phone' : 'desktop'} ${kind} rehearses a draft without editing the chat`, async ({ app }) => {
            test.setTimeout(180000);
            const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
            if (phone) await installIPhoneSafari(account.context, { standalone: true });
            const page = await account.open({ workspace: kind === 'conversation' });
            if (kind === 'roleplay') {
                await page.evaluate(async avatar => {
                    const context = window.SillyTavern.getContext();
                    await context.getCharacters();
                    await context.selectCharacterById(context.characters.findIndex(item => item.avatar === avatar), { switchMenu: false });
                }, account.avatar);
                await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chat.at(-1)?.mes)).toBe('Hello.');
            }
            const story = () => page.evaluate(() => JSON.stringify(window.SillyTavern.getContext().chat));
            const original = await story();
            await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'context' }));
            if (phone) await applyIOSOnlyCss(page);
            await page.locator('[id^="scratchpad-connection-"]').first().selectOption('durable');
            await page.getByRole('checkbox', { name: 'Stream replies' }).uncheck();
            await page.getByRole('tab', { name: 'Chat', exact: true }).click();
            await page.locator('.scratchpad-plus').click();
            const button = page.locator('.scratchpad-rehearse');
            const prefix = `../screenshots/scratchpad-rehearsal/${kind}-${phone ? 'phone' : 'desktop'}`;
            await page.evaluate(() => window.toastr.remove());
            if (before) {
                await expect(button).toHaveCount(0);
                await page.screenshot({ path: `${prefix}-before.png` });
                return;
            }
            await expect(button).toBeVisible();
            const box = await button.boundingBox();
            expect(box.height).toBeGreaterThanOrEqual(phone ? 44 : 32);
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(phone ? 393 : 1280);
            await page.screenshot({ path: `${prefix}-after.png` });
            for (const accent of [null, 'Pearl', 'Midnight Ink']) {
                if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
                await settleCssTransitions(page);
                const contrast = await button.evaluate(async element => {
                    const { contrastRatio } = await import('/scripts/theme-contrast.js');
                    const canvas = document.createElement('canvas').getContext('2d');
                    const channels = colour => { canvas.fillStyle = colour; canvas.fillRect(0, 0, 1, 1); return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3); };
                    let surface = element;
                    while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
                    return contrastRatio(channels(getComputedStyle(element).color), channels(getComputedStyle(surface ?? document.body).backgroundColor));
                });
                expect(contrast).toBeGreaterThanOrEqual(4.5);
            }
            app.provider.mode.reply = { choices: [{ message: { content: DRAFT } }] };
            if (kind === 'conversation') await page.locator('.scratchpad-composer').fill('Keep it quiet.');
            // Filling the composer closes its menu.
            if (!await button.isVisible()) await page.locator('.scratchpad-plus').click();
            const sending = page.waitForResponse('**/api/scratchpad/send');
            await button.click();
            const response = await sending;
            expect(response.ok(), await response.text()).toBe(true);
            await account.settled((await response.json()).job.id);
            await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
            const reply = page.locator('.scratchpad-message.is-assistant').last();
            await expect(reply.locator('.scratchpad-badge')).toHaveText('Rehearsal');
            await expect(reply).toContainText('Nova pauses');
            await expect(reply.locator('.scratchpad-change')).toHaveCount(0);
            expect(await story()).toBe(original);
            const call = app.provider.calls.at(-1);
            expect(call.messages[0].content).toContain('as a rehearsal');
            expect(call.tools ?? []).toHaveLength(0);
            expect(call.messages.at(-1).content).toBe(kind === 'conversation' ? 'Keep it quiet.' : 'Rehearse the next story reply using the shared context.');
            await page.screenshot({ path: `${prefix}-reply.png` });
            const source = response.request().postDataJSON().source;
            expect(source.kind).toBe(kind);
            const saved = (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions.find(item => item.id === response.request().postDataJSON().sessionId);
            expect(saved.messages.every(message => message.rehearsal)).toBe(true);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        });
    }
}
