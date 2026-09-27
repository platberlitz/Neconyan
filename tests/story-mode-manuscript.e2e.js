/* global document, window */
import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';

test.use({ serviceWorkers: 'block' });
test.setTimeout(120000);

for (const width of [393, 1280]) {
    test.describe(`Story manuscript at ${width}px`, () => {
        test.use({ viewport: { width, height: width === 393 ? 852 : 900 }, hasTouch: width === 393, isMobile: width === 393 });

        test('joins prose, keeps only end sleepers and still opens the editor', async ({ page }) => {
            await page.route('**/api/settings/save', route => route.fulfill({ json: { version: Date.now() } }));
            await openQuietChatForSmoke(page);
            const skip = page.locator('[data-tour-coach-skip]');
            if (await skip.isVisible()) await skip.click();
            await page.evaluate(async () => {
                // Exercise the real mode and editor without saving the synthetic transcript.
                // Story Mode requires an acknowledged metadata save, unlike the smoke helper's
                // empty chat-save response, so acknowledge only that presentation preference.
                const getContext = window.SillyTavern.getContext;
                window.SillyTavern.getContext = () => ({ ...getContext(), saveMetadata: async () => true });
                await window.NeconyanShell.activateMode('roleplay');
                const context = window.SillyTavern.getContext();
                context.chat.splice(0);
                document.querySelector('#chat').replaceChildren();
                const paragraphs = [
                    'The lamp was still turning when the boat came in.',
                    'Mara climbed the steps. The door was',
                    'bolted from the inside. She knocked, then listened.',
                    'There was no answer.',
                    'Above her, someone began to wind the lamp.',
                ];
                for (const [index, mes] of paragraphs.entries()) {
                    context.chat.push({ name: index % 2 ? 'You' : 'Miso', is_user: index % 2 === 1,
                        is_system: false, send_date: Date.now(), mes, extra: {} });
                }
                await context.printMessages();
            });
            await expect.poll(() => page.evaluate(() => window.NeconyanShell.activateMode('story')), { timeout: 30000 }).toBe(true);
            await expect(page.locator('body')).toHaveClass(/sbstory/);
            const rows = page.locator('#chat > .mes');
            await expect(rows).toHaveCount(5);
            await expect(rows.nth(2)).toHaveAttribute('data-sbstory-join', '');
            for (let i = 0; i < 5; i++) {
                const end = i === 0 || i === 4;
                await expect(rows.nth(i)).toHaveCSS('margin-top', end ? '44px' : '0px');
                await expect(rows.nth(i).locator(':scope > .neconyan-message-sleeper')).toHaveCSS('display', end ? 'block' : 'none');
            }
            const gap = await rows.evaluateAll(elements => elements[2].getBoundingClientRect().top - elements[1].getBoundingClientRect().bottom);
            expect(Math.abs(gap)).toBeLessThan(1);
            await expect(rows.nth(1)).toHaveCSS('padding-bottom', '0px');
            if (width === 393) {
                const actions = rows.first().locator('.mes_buttons');
                await expect(actions).toHaveCSS('clip-path', 'inset(50%)');
                await rows.first().locator('.mes_edit').focus();
                await expect(actions).toHaveCSS('clip-path', 'none');
                await page.locator('#send_textarea').focus();
                await rows.first().locator('.mes_text').tap();
            } else {
                await rows.first().locator('.mes_text').click();
            }
            await expect(rows.first().locator('.edit_textarea')).toBeVisible();
            await expect(rows.first().locator('.mes_edit_cancel')).toBeVisible();
            await rows.first().locator('.mes_edit_cancel').click();
            await expect(rows.first().locator('.edit_textarea')).toHaveCount(0);
            await page.evaluate(() => window.NeconyanShell.activateMode('roleplay'));
            await expect(rows.nth(2).locator(':scope > .neconyan-message-sleeper')).toHaveCSS('display', 'block');
            await expect(rows.nth(2)).toHaveCSS('margin-top', '44px');
        });
    });
}
