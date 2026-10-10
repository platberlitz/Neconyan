/* global document, getComputedStyle */
/* eslint-disable playwright/no-conditional-in-test -- Viewport setup and named accent variants share the same contrast checks. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} reply modes stay readable with default, pale and dark accents`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account({ phone, contextOptions: { ...(phone ? IPHONE_SAFARI_CONTEXT : {}), reducedMotion: 'reduce' } });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await expect(page.locator('.scratchpad-composer')).toBeEnabled();
        await page.locator('.scratchpad-round-table').click();
        await expect(page.locator('.scratchpad-round-table')).toHaveAttribute('aria-pressed', 'true');
        await page.locator('.scratchpad-random').click();
        await expect(page.locator('.scratchpad-random')).toHaveAttribute('aria-pressed', 'true');
        await expect.poll(() => page.locator('.scratchpad-empty img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
        await page.addStyleTag({ content: '#toast-container { display: none; }' });
        const results = [];
        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            await page.locator('#themes').selectOption({ label: theme }, { force: true });
            if (phone) await applyIOSOnlyCss(page);
            for (const accent of [null, 'Pearl', 'Midnight Ink']) {
                if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
                for (const pressed of [true, false]) {
                    await expect(page.locator('.scratchpad-random')).toHaveAttribute('aria-pressed', String(pressed));
                    for (const selector of ['.scratchpad-random', '.scratchpad-round-table']) {
                        const measured = await page.locator(selector).evaluate(async element => {
                            const { contrastRatio } = await import('/scripts/theme-contrast.js');
                            const canvas = document.createElement('canvas').getContext('2d');
                            const channels = colour => {
                                canvas.clearRect(0, 0, 1, 1);
                                canvas.fillStyle = colour;
                                canvas.fillRect(0, 0, 1, 1);
                                return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3);
                            };
                            const style = getComputedStyle(element);
                            const label = getComputedStyle(element.querySelector('span'));
                            const rect = element.getBoundingClientRect();
                            return { ratio: contrastRatio(channels(label.color), channels(style.backgroundColor)), color: label.color, background: style.backgroundColor,
                                width: rect.width, height: rect.height };
                        });
                        results.push({ theme, accent, pressed, selector, ...measured });
                        expect(measured.ratio, JSON.stringify(results)).toBeGreaterThanOrEqual(4.5);
                        expect(measured.height).toBeGreaterThanOrEqual(phone ? 44 : 36);
                    }
                    if (theme === 'Neconyan Calico Dark' && accent === null && pressed) {
                        await page.screenshot({ path: test.info().outputPath(`scratchpad-after-${phone ? 'phone' : 'desktop'}.png`) });
                    }
                    await page.locator('.scratchpad-random').click();
                }
            }
        }
        await test.info().attach('accent-measurements', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    });
}
