/* global document, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { selectSampleCharacter } from './chat-scroll-regression-helpers.js';

const styles = ['calico', 'windows-aero', 'macos-minimal', 'clean-minimal', 'cozy-warm', 'hypr-glow', 'slate-flat', 'kittyless', 'windows-98'];

for (const phone of [false, true]) {
    test(`generating edge follows the secondary accent on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account({ phone });
        const page = await account.open({ workspace: false });
        await selectSampleCharacter(page);
        const form = page.locator('#send_form');
        const edge = page.locator(phone ? '#form_sheld' : '#send_form');

        for (const style of styles) {
            await page.evaluate(async style => {
                document.documentElement.dataset.sbTheme = style;
                document.querySelectorAll('link[data-sb-shell-style], #generating-style-fixture').forEach(link => link.remove());
                if (style !== 'calico') {
                    const link = document.createElement('link');
                    link.id = 'generating-style-fixture';
                    link.rel = 'stylesheet';
                    link.href = `/css/shell-styles/${style}.css`;
                    await new Promise((resolve, reject) => {
                        link.onload = resolve;
                        link.onerror = reject;
                        document.head.append(link);
                    });
                }
            }, style);

            for (const custom of [true, false]) {
                await page.evaluate(custom => {
                    document.documentElement.dataset.neconyanAccent = custom ? 'custom' : 'default';
                    document.documentElement.style.setProperty('--SmartThemeQuoteColor', 'rgb(220, 120, 70)');
                    document.documentElement.style.setProperty('--SmartThemeUnderlineColor', 'rgb(80, 190, 210)');
                }, custom);
                // Focus must not replace the generating edge with the primary accent.
                await page.locator('#send_textarea').focus();
                await expect.poll(() => edge.evaluate(element => element.getAnimations().length)).toBe(0);
                const idle = await edge.evaluate(element => ({
                    shadow: getComputedStyle(element).boxShadow,
                    height: element.getBoundingClientRect().height,
                }));
                const colour = await edge.evaluate((element, custom) => {
                    const probe = document.createElement('span');
                    probe.style.color = custom ? 'var(--SmartThemeUnderlineColor)' : 'var(--neco-ginger)';
                    element.append(probe);
                    const colour = getComputedStyle(probe).color;
                    probe.remove();
                    return colour;
                }, custom);

                // A late chat-load step can call hideStopButton() and drop the class, so re-apply it until it sticks.
                await expect.poll(async () => {
                    await form.evaluate(element => element.classList.add('sb-generating-controls'));
                    return edge.evaluate(element => [getComputedStyle(element).boxShadow, getComputedStyle(element).borderTopColor]);
                }, { message: `${style}, custom=${custom}` }).toEqual([`${colour} 0px 0px 0px 3px inset`, colour]);
                const active = await edge.boundingBox();
                expect(active.height).toBe(idle.height);
                await form.evaluate(element => element.classList.remove('sb-generating-controls'));
                await expect(edge, `${style}, custom=${custom}: idle edge restored`).toHaveCSS('box-shadow', idle.shadow);
            }
        }
    });
}
