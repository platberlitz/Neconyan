/* global document, window, getComputedStyle, NeconyanShell, CSSTransition */
import { test, expect } from '@playwright/test';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

// These cases share the preview account's saved appearance settings.
test.describe.configure({ mode: 'serial' });

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} background fitting and paired accents`, async ({ browser }) => {
        test.setTimeout(120000);
        const context = await browser.newContext(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } });
        if (phone) await installIPhoneSafari(context, { standalone: true });
        const page = await context.newPage();
        await page.goto('/');
        // The startup overlay disappears before backgrounds finish initialising.
        await page.waitForFunction(() => window.jQuery?.('#bg_tabs').data('ui-tabs'));
        const skip = page.getByRole('button', { name: 'Skip', exact: true });
        if (await skip.isVisible()) await skip.click();
        await page.evaluate(() => {
            NeconyanShell.applyTheme('calico');
            NeconyanShell.openTab('right', 'background');
        });
        if (phone) await applyIOSOnlyCss(page);
        const fitting = page.locator('#background_fitting');
        await expect(fitting).toBeVisible();
        const widths = await fitting.evaluate(el => {
            const style = getComputedStyle(el);
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            ctx.font = `${style.fontSize} ${style.fontFamily}`;
            return {
                available: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
                required: Math.max(...[...el.options].map(option => ctx.measureText(option.text).width)),
            };
        });
        expect(widths.available).toBeGreaterThanOrEqual(widths.required);
        const background = page.locator('#bg1');
        await expect(background).toHaveCSS('background-attachment', 'scroll');
        for (const [value, size] of Object.entries({ classic: 'cover', cover: 'cover', contain: 'contain', stretch: '100% 100%', center: 'auto' })) {
            await fitting.selectOption(value);
            await expect(background).toHaveCSS('background-size', size);
            expect(await page.evaluate(() => getComputedStyle(document.body, '::before').backgroundSize)).toBe(size);
        }

        for (const name of ['Midnight Ink', 'Black Cherry', 'Aubergine', 'Deep Ocean', 'Pine Shadow', 'Espresso', 'Storm Slate', 'Oxblood']) {
            const button = page.locator(`.sb-accent-profile-apply[aria-label="Apply ${name} accent profile"]`);
            await expect(button).toHaveCount(1);
            const applied = await button.evaluate(el => {
                const swatch = getComputedStyle(el).getPropertyValue('--sb-accent-profile-primary').trim();
                el.click();
                const style = getComputedStyle(document.body);
                return { swatch, primary: style.getPropertyValue('--neco-ginger').trim(), ink: style.getPropertyValue('--neco-accent-ink').trim() };
            });
            expect(applied.primary).toBe(applied.swatch);
            expect(applied.ink).toBe('rgb(255, 255, 255)');
        }
        await page.evaluate(() => document.querySelector('.sb-accent-profile-apply').click());
        const readAccents = () => page.evaluate(() => {
            const style = getComputedStyle(document.body);
            const topbar = getComputedStyle(document.querySelector('#top-bar'));
            return {
                primary: style.getPropertyValue('--neco-ginger').trim(),
                secondary: style.getPropertyValue('--neco-accent-secondary').trim(),
                gradient: style.getPropertyValue('--neco-accent-gradient').trim(),
                border: topbar.borderBottomColor,
            };
        });
        const profile = await readAccents();
        expect(profile.secondary).not.toBe(profile.primary);
        expect(profile.gradient).toContain(profile.secondary);
        await page.locator('#sb-accent-secondary-picker').evaluate(el => el.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { rgba: 'rgba(32, 196, 224, 1)' } })));
        const custom = await readAccents();
        expect(custom.primary).toBe(profile.primary);
        expect(custom.secondary).toBe('rgba(32, 196, 224, 1)');
        expect(custom.gradient).not.toBe(profile.gradient);
        expect(custom.border).not.toBe(profile.border);

        const decorations = {
            'windows-aero': ['#auto_background', null, 'backgroundImage'],
            'hypr-glow': ['#top-bar', '::after', 'backgroundImage'],
            'cozy-warm': [phone ? '#form_sheld' : '#send_form', null, 'borderTopColor'],
            'slate-flat': ['#background_fitting', null, 'borderTopColor'],
            'clean-minimal': ['#background_fitting', null, 'borderTopColor'],
            'macos-minimal': ['#background_fitting', null, 'borderTopColor'],
        };
        for (const [theme, decoration] of Object.entries(decorations)) {
            await page.evaluate(id => NeconyanShell.applyTheme(id), theme);
            await page.waitForFunction(id => document.querySelector(`link[data-sb-shell-style="${id}"]`)?.sheet, theme);
            await page.locator('#auto_background').hover();
            for (const tone of ['dark', 'light']) {
                const samples = [];
                for (const colour of ['rgba(32, 196, 224, 1)', 'rgba(224, 64, 160, 1)']) {
                    await page.evaluate(({ colour, tone }) => {
                        document.querySelector('#sb-accent-secondary-picker').dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { rgba: colour } }));
                        // Exercise both CSS palettes without changing the saved base theme.
                        document.documentElement.dataset.sbSurfaceTone = tone;
                        document.documentElement.dataset.neconyanCalicoTone = tone;
                    }, { colour, tone });
                    samples.push(await page.evaluate(async ([selector, pseudo, property]) => {
                        const element = document.querySelector(selector);
                        // Resolve the new style, then sample the completed colour transition.
                        const initial = getComputedStyle(element, pseudo)[property];
                        const transitions = element.getAnimations().filter(animation => animation instanceof CSSTransition);
                        if (!transitions.length) return initial;
                        await Promise.all(transitions.map(animation => animation.finished));
                        return getComputedStyle(element, pseudo)[property];
                    }, decoration));
                }
                expect(samples[1], `${theme} ${tone} secondary decoration`).not.toBe(samples[0]);
                expect((await readAccents()).primary).toBe(profile.primary);
            }
        }
        await context.close();
    });
}
