/* global document, getComputedStyle, window */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { renderRegisteredDocsPage } from '../src/docs-reader.js';

const serverDirectory = fileURLToPath(new URL('../', import.meta.url));

for (const viewport of [{ width: 1280, height: 900 }, { width: 393, height: 852 }]) {
    test.describe(`glossary at ${viewport.width}px`, () => {
        test.use({ viewport, hasTouch: viewport.width < 768, isMobile: viewport.width < 768, contextOptions: { reducedMotion: 'reduce' }, colorScheme: 'dark' });

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
            await expect(page.locator('.hero').getByRole('note', { name: 'Taro says' })).toContainText('Taro');

            const asides = page.locator('.doc .host-aside');
            await expect(asides).toHaveCount(5);
            const lastAside = asides.last();
            await lastAside.scrollIntoViewIfNeeded();
            await expect(lastAside).toBeVisible();
            await expect.poll(() => lastAside.locator('img.host-aside-art').evaluate(image => image.complete && image.naturalWidth)).toBeGreaterThan(0);
            const asideBox = await lastAside.boundingBox();
            expect(asideBox.x + asideBox.width).toBeLessThanOrEqual(viewport.width);
            await page.evaluate(() => window.scrollTo(0, 0));
            expect(await page.locator('.hero').evaluate(element => getComputedStyle(element, '::before').backgroundImage)).toContain('ear-left');
            const heroBox = await page.locator('.hero').boundingBox();
            const taroBox = await taro.boundingBox();
            expect(taroBox.x + taroBox.width).toBeLessThanOrEqual(heroBox.x + heroBox.width + 1);

            const search = page.getByRole('searchbox');
            await search.fill('depth');
            await expect(page.locator('#search-status')).toContainText('matches');
            await expect(page.locator('mark').first()).toHaveText(/depth/i);
            await expect(page.locator('#core-terms')).toBeHidden();
            await expect(page.locator('.doc .host-aside:visible')).toHaveCount(0);
            await search.fill('nothing-matches-this-term');
            await expect(page.locator('#empty-state')).toBeVisible();
            await expect(page.locator('#empty-state')).toContainText('I checked twice');
            await expect.poll(() => page.locator('#empty-state img.empty-host').evaluate(image => image.complete && image.naturalWidth)).toBeGreaterThan(0);
            await search.press('Escape');
            await expect(page.locator('#empty-state')).toBeHidden();
            await expect(page.locator('#core-terms')).toBeVisible();
            await expect(page.locator('mark')).toHaveCount(0);
            await expect(page.locator('.doc .host-aside:visible')).toHaveCount(5);

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

        // The phone header hides the wordmark, so the cat sits centred in the 44 px brand link.
        const brandPlace = viewport.width < 768
            ? { imgOffsetX: 9, imgOffsetY: 10, spanBoxes: 0, spanGap: 0 }
            : { imgOffsetX: 0, imgOffsetY: 10, spanBoxes: 1, spanGap: 10 };

        test('the header cat rests under reduced motion and keeps its place', async ({ page }) => {
            const { cat, catFrames, layout } = headerCat(page);

            await page.goto('/docs/in-chat-agents-glossary');
            await expect.poll(() => cat.evaluate(image => image.complete && image.naturalWidth)).toBeGreaterThan(0);
            expect(new URL(await cat.evaluate(image => image.currentSrc)).pathname).toBe('/img/neconyan-pixel-cat-rest.webp');
            expect((await page.request.get('/img/neconyan-pixel-cat-rest.webp')).status()).toBe(200);
            expect(await catFrames(7)).toBe(1);

            const still = await layout();
            expect(still.picture).toBe('contents');
            expect(still.sourceBoxes).toBe(0);
            expect(still.img.width).toBe(26);
            expect(still.img.height).toBe(24);
            expect(still.brand.height).toBe(44);
            expect(still).toMatchObject(brandPlace);

            await page.emulateMedia({ reducedMotion: 'no-preference' });
            await page.reload();
            await expect.poll(() => cat.evaluate(image => image.complete && image.naturalWidth)).toBeGreaterThan(0);
            expect(new URL(await cat.evaluate(image => image.currentSrc)).pathname).toBe('/img/neconyan-pixel-cat.webp');
            expect(await catFrames(7)).toBeGreaterThan(1);
            expect(await layout()).toEqual(still);
        });

        // The shared test server's own settings stay untouched: the page comes from the real
        // renderer reading a throwaway settings file, and everything else from the server.
        test('the Reduced Motion setting keeps the reader still without a device preference', async ({ page }) => {
            const { cat, catFrames, layout } = headerCat(page);
            const userRoot = mkdtempSync(join(tmpdir(), 'neconyan-docs-motion-'));
            let html;
            try {
                writeFileSync(join(userRoot, 'settings.json'), JSON.stringify({ power_user: { reduced_motion: true } }));
                html = renderRegisteredDocsPage(serverDirectory, 'in-chat-agents-glossary', { userRoot });
            } finally {
                rmSync(userRoot, { recursive: true, force: true });
            }
            const movingRequests = [];
            page.on('request', request => {
                if (new URL(request.url()).pathname === '/img/neconyan-pixel-cat.webp') movingRequests.push(request.url());
            });

            await page.emulateMedia({ reducedMotion: 'no-preference' });
            await page.goto('/docs/in-chat-agents-glossary');
            await expect.poll(() => cat.evaluate(image => image.complete && image.naturalWidth)).toBeGreaterThan(0);
            const moving = await layout();
            expect(movingRequests.length).toBeGreaterThan(0);
            movingRequests.length = 0;

            await page.route('**/docs/in-chat-agents-glossary', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
            await page.reload();
            await expect.poll(() => cat.evaluate(image => image.complete && image.naturalWidth)).toBeGreaterThan(0);
            await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'true');
            expect(new URL(await cat.evaluate(image => image.currentSrc)).pathname).toBe('/img/neconyan-pixel-cat-rest.webp');
            expect(await catFrames(7)).toBe(1);

            await page.locator('.hero.cat-panel').hover();
            const motion = await page.evaluate(() => ({
                scroll: getComputedStyle(document.documentElement).scrollBehavior,
                ear: getComputedStyle(document.querySelector('.cat-panel'), '::before').animationName,
                button: getComputedStyle(document.querySelector('.icon-button')).transitionDuration,
            }));
            expect(motion).toEqual({ scroll: 'auto', ear: 'none', button: '0s' });
            expect(movingRequests).toEqual([]);

            const still = await layout();
            expect(still).toMatchObject(brandPlace);
            expect({ brand: still.brand, img: still.img, span: still.span }).toEqual({ brand: moving.brand, img: moving.img, span: moving.span });
        });
    });
}

function headerCat(page) {
    const cat = page.locator('.topbar .brand img');
    const frame = async () => (await cat.screenshot({ animations: 'allow' })).toString('base64');
    const catFrames = async (count) => {
        const frames = [await frame()];
        for (let index = 1; index < count; index++) {
            await page.evaluate(delay => new Promise(resolve => window.setTimeout(resolve, delay)), 4800 / (count - 1));
            frames.push(await frame());
        }
        return new Set(frames).size;
    };
    const layout = () => page.locator('.topbar .brand').evaluate(brand => {
        const box = element => element.getBoundingClientRect().toJSON();
        const img = box(brand.querySelector('img'));
        const span = brand.querySelector('span');
        const picture = brand.querySelector('picture');
        return {
            brand: box(brand),
            img,
            span: box(span),
            imgOffsetX: img.x - box(brand).x,
            imgOffsetY: img.y - box(brand).y,
            spanBoxes: span.getClientRects().length,
            spanGap: Math.max(0, box(span).x - img.right),
            picture: picture ? getComputedStyle(picture).display : null,
            sourceBoxes: brand.querySelector('source')?.getClientRects().length ?? 0,
        };
    });
    return { cat, catFrames, layout };
}
