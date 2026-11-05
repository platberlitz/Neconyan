/* global document, window */
import { test, expect } from '@playwright/test';

for (const phone of [false, true]) {
    test(`Sunken Reef water and ${phone ? 'touch' : 'mouse'} ripples preserve controls and reduced motion`, async ({ browser, baseURL }) => {
        const context = await browser.newContext({
            baseURL,
            viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 },
            hasTouch: phone,
            reducedMotion: 'no-preference',
        });
        try {
            const page = await context.newPage();
            await page.route('**/reef-water-fixture', route => route.fulfill({
                contentType: 'text/html',
                body: `<!doctype html><html data-sb-theme="sunken-reef"><body>
                    <button style="position:fixed;left:40px;top:100px;width:180px;height:60px"
                        onclick="this.dataset.clicks=Number(this.dataset.clicks||0)+1">Test control</button>
                    <script type="module">
                        import { mountSunkenReef } from '/scripts/neconyan-sunken-reef.js';
                        mountSunkenReef();
                    </script></body></html>`,
            }));
            await page.goto('/reef-water-fixture');
            const stage = page.locator('#sb-sunken-reef-stage');
            await expect(stage).toHaveAttribute('data-reef-motion', 'active');
            const waterPixels = () => page.evaluate(() => {
                const canvas = document.getElementById('sb-sunken-reef-wake');
                const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
                let painted = 0;
                for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) painted += 1;
                return { painted, image: canvas.toDataURL() };
            });
            const first = await waterPixels();
            expect(first.painted).toBeGreaterThan(1000);
            await expect.poll(async () => (await waterPixels()).image).not.toBe(first.image);

            const button = page.getByRole('button');
            const bounds = await button.boundingBox();
            if (phone) await button.tap();
            else await button.click();
            await expect(button).toHaveAttribute('data-clicks', '1');
            const rippleCount = () => page.evaluate(() => window.NeconyanSunkenReef.snapshot().touchRipples);
            expect(await rippleCount()).toBe(1);
            expect(await button.boundingBox()).toEqual(bounds);
            await expect.poll(rippleCount).toBe(0);

            await button.focus();
            await page.keyboard.press('Enter');
            await expect(button).toHaveAttribute('data-clicks', '2');
            expect(await rippleCount()).toBe(0);

            await page.emulateMedia({ reducedMotion: 'reduce' });
            await expect(stage).toHaveAttribute('data-reef-motion', 'still');
            if (phone) await button.tap();
            else await button.click();
            await expect(button).toHaveAttribute('data-clicks', '3');
            expect(await rippleCount()).toBe(0);
            expect((await waterPixels()).painted).toBe(0);

            await page.emulateMedia({ reducedMotion: 'no-preference' });
            await expect(stage).toHaveAttribute('data-reef-motion', 'active');
            await page.evaluate(() => document.body.classList.add('reduced-motion'));
            await expect(stage).toHaveAttribute('data-reef-motion', 'still');
            expect((await waterPixels()).painted).toBe(0);
            await page.evaluate(() => {
                document.body.classList.remove('reduced-motion');
                window.NeconyanSunkenReef.unmount();
                window.NeconyanSunkenReef.mount();
            });
            await expect(stage).toHaveCount(1);
            if (phone) await button.tap();
            else await button.click();
            expect(await rippleCount()).toBe(1);
            await page.evaluate(() => { document.documentElement.dataset.sbTheme = 'calico'; });
            await expect(stage).toHaveCount(0);
            if (phone) await button.tap();
            else await button.click();
            await expect(button).toHaveAttribute('data-clicks', '5');
            expect(await rippleCount()).toBe(0);
        } finally {
            await context.close();
        }
    });
}
