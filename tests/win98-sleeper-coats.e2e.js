/* global document, window, getComputedStyle, Image */
import { expect, test } from '@playwright/test';
import { SLEEPER_COATS } from '../public/scripts/neconyan-sleeper-coats.js';
import { isolateSettingsSaves, openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';

for (const width of [393, 1280]) {
    test.describe(`Windows 98 sleeping coats at ${width}px`, () => {
        test.use({ viewport: { width, height: width === 393 ? 852 : 900 }, hasTouch: width === 393, serviceWorkers: 'block' });
        test('every coat uses pixel art on both sides and while being petted', async ({ page }) => {
            test.setTimeout(180000);
            await isolateSettingsSaves(page, settings => {
                settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
            });
            await openQuietChatForSmoke(page);
            await page.evaluate(async () => {
                const context = window.SillyTavern.getContext();
                context.chat.splice(0);
                document.querySelector('#chat').replaceChildren();
                for (const is_user of [false, true]) context.chat.push({ name: is_user ? 'You' : 'Miso', is_user,
                    is_system: false, send_date: Date.now(), mes: 'A quiet moment with every cat.', extra: {} });
                await context.printMessages();
                window.NeconyanShell.applyTheme('windows-98');
                document.body.classList.remove('flatchat');
                document.body.classList.add('bubblechat');
            });
            await page.waitForFunction(() => document.querySelector('link[data-sb-shell-style="windows-98"]')?.sheet);
            const userCat = page.locator('#chat > .mes[is_user="true"] > .neconyan-message-sleeper');
            const cats = page.locator('#chat > .mes > .neconyan-message-sleeper');
            await expect(cats).toHaveCount(2);
            await userCat.evaluate(img => {
                img.__pixelFrames = [];
                new window.MutationObserver(() => img.__pixelFrames.push(getComputedStyle(img).content))
                    .observe(img, { attributes: true, attributeFilter: ['src'] });
            });
            for (const coat of SLEEPER_COATS) {
                await page.evaluate(async id => {
                    const { setSleeperCoat } = await import('/scripts/neconyan-sleeper-coats.js');
                    setSleeperCoat('user', id);
                    setSleeperCoat('character', id);
                    document.querySelector('#chat').scrollTop = 0;
                }, coat.id);
                const stem = `sleeping-${coat.id}-${coat.side}`;
                for (const cat of await cats.all()) {
                    const rendered = await cat.evaluate(async img => {
                        const content = getComputedStyle(img).content;
                        const image = new Image();
                        image.src = content.slice(5, -2);
                        await image.decode();
                        const box = img.getBoundingClientRect();
                        return { content, width: box.width, height: box.height, left: box.left, right: box.right,
                            naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight };
                    });
                    expect(rendered.content).toContain(`/win98/${stem}.webp`);
                    expect([rendered.naturalWidth, rendered.naturalHeight]).toEqual([768, 616]);
                    expect([rendered.width, rendered.height]).toEqual([96, 77]);
                    expect(rendered.left).toBeGreaterThanOrEqual(0);
                    expect(rendered.right).toBeLessThanOrEqual(width);
                }
                await expect(userCat).toHaveCSS('scale', coat.side === 'left' ? '-1 1' : 'none');
                for (const preview of await page.locator('.sb-sleeper-coat-preview').all()) {
                    expect(await preview.evaluate(img => getComputedStyle(img).content)).toContain(`/win98/${stem}.webp`);
                }
                // Preload the actual CSS replacement, then observe the brief petting frame.
                await page.evaluate(async stem => {
                    const image = new Image();
                    image.src = `/img/neconyan/win98/${stem}-twitch.webp`;
                    await image.decode();
                }, stem);
                await userCat.press('Enter');
                await expect.poll(() => userCat.evaluate((img, stem) => img.__pixelFrames.some(frame => frame.includes(`/win98/${stem}-twitch.webp`)), stem)).toBe(true);
                await expect(userCat).toHaveAttribute('src', `/img/neconyan/${stem}.webp`);
            }
            await userCat.evaluate(img => { img.__pixelFrames = []; });
            if (width === 393) await userCat.tap({ position: { x: 48, y: 25 } });
            else await userCat.click({ position: { x: 48, y: 25 } });
            await expect.poll(() => userCat.evaluate(img => img.__pixelFrames.some(frame => frame.includes('-twitch.webp')))).toBe(true);
            await expect(userCat).toHaveAttribute('src', '/img/neconyan/sleeping-white-tiger-left.webp');
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await userCat.evaluate(img => { img.__pixelFrames = []; });
            await userCat.press('Space');
            await page.waitForTimeout(300);
            expect(await userCat.evaluate(img => img.__pixelFrames.some(frame => frame.includes('-twitch.webp')))).toBe(false);
            await page.evaluate(() => window.NeconyanShell.applyTheme('calico'));
            for (const cat of await cats.all()) await expect(cat).toHaveCSS('content', 'normal');
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            expect(overflow).toBeLessThanOrEqual(1);
        });
    });
}
