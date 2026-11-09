/* global window, document */
import { test, expect } from '@playwright/test';
import { openControlledReef } from './sunken-reef-performance-fixture.js';

for (const phone of [false, true]) {
    test(`Sunken Reef reuses colours without losing frames or palette updates on ${phone ? 'phone' : 'desktop'}`, async ({ browser, baseURL }) => {
        const context = await browser.newContext({
            baseURL,
            viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 },
            hasTouch: phone,
            reducedMotion: 'no-preference',
        });
        try {
            const page = await context.newPage();
            await openControlledReef(page);
            const counts = () => page.evaluate(() => window.reefTest.counts());
            expect(await counts()).toEqual({ frames: 0, readbacks: 5, motionWrites: 1, pending: 1 });
            const initial = await page.evaluate(() => window.NeconyanSunkenReef.snapshot());
            await page.evaluate(() => window.reefTest.advance(120));
            expect(await counts()).toEqual({ frames: 120, readbacks: 5, motionWrites: 1, pending: 1 });
            const animated = await page.evaluate(() => window.NeconyanSunkenReef.snapshot());
            expect(animated.creatures).not.toEqual(initial.creatures);
            expect(animated.bubbles).toBe(initial.bubbles);

            // This changes the stylesheet without touching the observed root/body
            // attributes. The periodic sampler must still notice the new colour.
            await page.evaluate(() => {
                document.styleSheets[0].insertRule(':root { --reef-lagoon: color(srgb 0.2 0.6 0.8); }', document.styleSheets[0].cssRules.length);
                window.reefTest.advance(30);
            });
            expect((await counts()).readbacks).toBe(6);
            expect(await page.evaluate(() => window.NeconyanSunkenReef.snapshot().palette.lagoon)).toBe('rgb(51, 153, 204)');

            await page.evaluate(() => {
                document.body.style.setProperty('--neco-ginger', '#ff4fa3');
                document.body.style.setProperty('--neco-accent-secondary', '#00ffd5');
                document.documentElement.dataset.neconyanAccent = 'custom';
            });
            const custom = await page.evaluate(() => window.NeconyanSunkenReef.snapshot().palette);
            expect(custom.lagoon).not.toBe('rgb(51, 153, 204)');
            expect(custom.coral).not.toBe(initial.palette.coral);
            expect((await counts()).readbacks).toBe(8);

            await page.evaluate(() => document.body.classList.add('reduced-motion'));
            expect((await counts()).motionWrites).toBe(2);
            expect((await counts()).pending).toBe(0);
            await page.evaluate(() => {
                document.body.classList.remove('reduced-motion');
                window.NeconyanSunkenReef.unmount();
                window.NeconyanSunkenReef.mount();
            });
            expect(await page.locator('#sb-sunken-reef-stage > span').count()).toBe(5);
            const remounted = await counts();
            expect(remounted.readbacks).toBe(13);
            await page.evaluate(() => window.reefTest.advance(60));
            expect((await counts()).readbacks).toBe(remounted.readbacks);
            await page.evaluate(() => window.NeconyanSunkenReef.unmount());
            await expect(page.locator('#sb-sunken-reef-stage')).toHaveCount(0);
            expect((await counts()).pending).toBe(0);
        } finally {
            await context.close();
        }
    });
}
