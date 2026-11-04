/* global document, getComputedStyle */
import { expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { test } from './neconyan-conversation-durable-fixture.js';
import { selectSampleCharacter } from './chat-scroll-regression-helpers.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

const styles = ['calico', 'windows-aero', 'macos-minimal', 'clean-minimal', 'cozy-warm', 'hypr-glow', 'slate-flat', 'kittyless', 'windows-98', 'windows-xp', 'starlight-conservatory'];

for (const device of ['desktop', 'phone', 'ios']) {
    const phone = device !== 'desktop';
    test(`generating edge follows the secondary accent on ${device}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: device === 'ios' ? IPHONE_SAFARI_CONTEXT : {} });
        if (device === 'ios') await installIPhoneSafari(account.context, { standalone: true });
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
            if (device === 'ios') await applyIOSOnlyCss(page, { inPlace: true });

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
                const expected = await edge.evaluate((element, { custom, style }) => {
                    const probe = document.createElement('span');
                    probe.style.color = custom ? 'var(--SmartThemeUnderlineColor)' : 'var(--neco-ginger)';
                    const accent = custom ? 'var(--SmartThemeUnderlineColor)' : 'var(--neco-ginger)';
                    const rim = style === 'cozy-warm' ? 'var(--cozy-shadow)' : `inset 0 0 0 1.5px color-mix(in srgb, ${accent} 78%, transparent)`;
                    probe.style.boxShadow = `${rim}, 0 0 12px color-mix(in srgb, ${accent} 14%, transparent)`;
                    element.append(probe);
                    const expected = [getComputedStyle(probe).boxShadow, getComputedStyle(probe).color];
                    probe.remove();
                    return expected;
                }, { custom, style });

                // A late chat-load step can call hideStopButton() and drop the class, so re-apply it until it sticks.
                await expect.poll(async () => {
                    await form.evaluate(element => element.classList.add('sb-generating-controls'));
                    return edge.evaluate(element => [getComputedStyle(element).boxShadow, getComputedStyle(element).borderTopColor]);
                }, { message: `${style}, custom=${custom}` }).toEqual(expected);
                if (phone) {
                    await expect(form).toHaveCSS('backdrop-filter', 'none');
                    await expect(form).toHaveCSS('box-shadow', 'none');
                }
                if (style === 'cozy-warm') {
                    for (const side of ['top', 'right', 'bottom', 'left']) {
                        await expect(edge).toHaveCSS(`border-${side}-style`, 'dashed');
                        await expect(edge).toHaveCSS(`border-${side}-width`, '2px');
                        await expect(edge).toHaveCSS(`border-${side}-color`, expected[1]);
                    }
                }
                if (process.env.NECONYAN_ACCENT_SCREENSHOTS && custom && ['windows-aero', 'cozy-warm'].includes(style)) {
                    const directory = new URL('../screenshots/', import.meta.url);
                    await mkdir(directory, { recursive: true });
                    await page.screenshot({ path: new URL(`${process.env.NECONYAN_ACCENT_SCREENSHOTS}-${style}-${device}-generating.png`, directory).pathname });
                }
                const active = await edge.boundingBox();
                expect(active.height).toBe(idle.height);
                await form.evaluate(element => element.classList.remove('sb-generating-controls'));
                await expect(edge, `${style}, custom=${custom}: idle edge restored`).toHaveCSS('box-shadow', idle.shadow);
                if (process.env.NECONYAN_ACCENT_SCREENSHOTS && custom && style === 'cozy-warm') {
                    await page.screenshot({ path: new URL(`../screenshots/${process.env.NECONYAN_ACCENT_SCREENSHOTS}-${style}-${device}-idle.png`, import.meta.url).pathname });
                }
            }
        }
    });
}
