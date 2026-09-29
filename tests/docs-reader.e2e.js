/* global document, getComputedStyle */
import { expect, test } from '@playwright/test';

for (const viewport of [{ width: 1280, height: 900 }, { width: 393, height: 852 }]) {
    test.describe(`glossary at ${viewport.width}px`, () => {
        test.use({ viewport, hasTouch: viewport.width < 768, isMobile: viewport.width < 768, reducedMotion: 'reduce', colorScheme: 'dark' });

        test('read, search, navigate and remember the reading theme', async ({ page }) => {
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            const response = await page.goto('/docs/in-chat-agents-glossary');
            expect(response.status()).toBe(200);
            await expect(page.getByRole('heading', { level: 1 })).toHaveText('In-Chat Agents Glossary');
            await page.evaluate(() => document.fonts.ready);
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
            expect(await page.locator('.doc').evaluate(element => getComputedStyle(element).fontFamily)).toContain('Nunito');
            expect(await page.locator('.hero h1').evaluate(element => getComputedStyle(element).fontFamily)).toContain('Fredoka One');

            const taro = page.locator('img.hero-host');
            await expect(taro).toBeVisible();
            await expect.poll(() => taro.evaluate(image => image.complete && image.naturalWidth)).toBeGreaterThan(0);
            await expect(page.getByRole('note', { name: 'Taro says' })).toContainText('Taro');
            expect(await page.locator('.hero').evaluate(element => getComputedStyle(element, '::before').backgroundImage)).toContain('ear-left');
            const heroBox = await page.locator('.hero').boundingBox();
            const taroBox = await taro.boundingBox();
            expect(taroBox.x + taroBox.width).toBeLessThanOrEqual(heroBox.x + heroBox.width + 1);

            const search = page.getByRole('searchbox');
            await search.fill('depth');
            await expect(page.locator('#search-status')).toContainText('matches');
            await expect(page.locator('mark').first()).toHaveText(/depth/i);
            await expect(page.locator('#core-terms')).toBeHidden();
            await search.fill('nothing-matches-this-term');
            await expect(page.locator('#empty-state')).toBeVisible();
            await expect(page.locator('#empty-state')).toContainText('I checked twice');
            await expect.poll(() => page.locator('#empty-state img.empty-host').evaluate(image => image.complete && image.naturalWidth)).toBeGreaterThan(0);
            await search.press('Escape');
            await expect(page.locator('#empty-state')).toBeHidden();
            await expect(page.locator('#core-terms')).toBeVisible();
            await expect(page.locator('mark')).toHaveCount(0);

            await page.getByRole('button', { name: 'Switch to light theme' }).click();
            await page.reload();
            await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
            await expect(page.getByRole('button', { name: 'Switch to dark theme' })).toBeVisible();
            const contrast = await page.locator('.doc p.term').first().evaluate(element => {
                const luminance = colour => {
                    const channels = colour.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255)
                        .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
                    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
                };
                const text = luminance(getComputedStyle(element.querySelector('strong')).color);
                const background = luminance(getComputedStyle(element).backgroundColor);
                return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
            });
            expect(contrast).toBeGreaterThanOrEqual(4.5);
            expect((await page.getByRole('link', { name: 'Open Neconyan' }).boundingBox()).height).toBeGreaterThanOrEqual(44);

            if (viewport.width < 768) {
                const sections = page.getByRole('button', { name: 'Sections' });
                expect((await sections.boundingBox()).height).toBeGreaterThanOrEqual(44);
                await sections.tap();
                await expect(sections).toHaveAttribute('aria-expanded', 'true');
                expect(await page.locator('.doc td').first().evaluate(element => getComputedStyle(element).display)).toBe('block');
            }
            await page.locator('#doc-toc').getByRole('link', { name: 'Main Agents Panel', exact: true }).click();
            await expect(page).toHaveURL(/#main-agents-panel$/);
            await expect.poll(() => page.locator('#main-agents-panel').evaluate(element => element.getBoundingClientRect().top)).toBeGreaterThanOrEqual(60);
            await expect(page.locator('body')).not.toHaveClass(/toc-open/);
            await expect(page.locator('#back-to-top')).toBeVisible();
            await page.locator('#back-to-top').click();
            await expect(page.locator('#back-to-top')).toBeHidden();

            const raw = await page.request.get('/docs/in-chat-agents-glossary.md');
            expect(raw.headers()['content-type']).toContain('text/plain');
            expect(await raw.text()).toContain('# In-Chat Agents Glossary');
            expect(errors).toEqual([]);
        });
    });
}
