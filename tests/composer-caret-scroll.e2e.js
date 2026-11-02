/* global document, window, CSS, requestAnimationFrame */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves, openReadyChat } from './chat-scroll-regression-helpers.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

test.use({ ...IPHONE_SAFARI_CONTEXT, serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(120000);
test.afterEach(async ({ page }) => page.unrouteAll({ behavior: 'wait' }));

for (const fallback of [false, true]) {
    test(`multiline typing follows the end caret immediately (${fallback ? 'fallback sizing' : 'CSS sizing'})`, async ({ context, page }) => {
        await installIPhoneSafari(context, { standalone: true });
        if (fallback) {
            await context.addInitScript(() => {
                const supports = CSS.supports.bind(CSS);
                CSS.supports = (...args) => args[0] === 'field-sizing' ? false : supports(...args);
            });
        }
        await isolateSettingsSaves(page, settings => {
            settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
            settings.power_user.compact_input_area = true;
        });
        await openReadyChat(page);
        await applyIOSOnlyCss(page, { inPlace: true });
        if (fallback) await page.addStyleTag({ content: '#send_textarea { field-sizing: fixed; }' });
        const textarea = page.locator('#send_textarea');
        await textarea.fill(Array.from({ length: 24 }, (_, i) => `Line ${i} with words`).join('\n'));
        await textarea.evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
        await page.evaluate(fallback => {
            window.caretGaps = [];
            const el = document.getElementById('send_textarea');
            el.addEventListener('input', () => {
                const measure = () => window.caretGaps.push(el.scrollHeight - el.clientHeight - el.scrollTop);
                if (fallback) requestAnimationFrame(measure);
                else measure();
            });
        }, fallback);
        for (let i = 0; i < 3; i++) {
            await page.keyboard.press('Shift+Enter');
            await page.keyboard.insertText(`New bottom line ${i}`);
            await page.evaluate(() => new Promise(requestAnimationFrame));
        }
        const gaps = await page.evaluate(() => window.caretGaps);
        expect(gaps).toHaveLength(6);
        expect(gaps.every(gap => Math.abs(gap) <= 1)).toBe(true);
        // Editing earlier text must not drag the view back to the end.
        await textarea.evaluate(el => { el.setSelectionRange(5, 5); el.scrollTop = 0; });
        await page.keyboard.insertText(' edited');
        await page.evaluate(() => new Promise(requestAnimationFrame));
        expect(await textarea.evaluate(el => el.scrollTop)).toBeLessThan(10);
        expect(await textarea.evaluate(el => el.selectionStart)).toBeLessThan(30);
    });
}
