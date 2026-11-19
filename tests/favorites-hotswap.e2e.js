/* global document, getComputedStyle, HTMLElement, window, WheelEvent */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves, openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';

const railSelector = '#HotSwapWrapper .hotswap';
const leftSelector = '#HotSwapWrapper .sb-mobile-rail-left';
const rightSelector = '#HotSwapWrapper .sb-mobile-rail-right';

test.use({ serviceWorkers: 'block' });
test.setTimeout(60000);

async function setFavorites(page, count) {
    await page.evaluate(async count => {
        const { characters, groups } = window.SillyTavern.getContext();
        characters.splice(0, characters.length, ...Array.from({ length: count }, (_, index) => ({
            name: `Favourite ${String(index + 1).padStart(2, '0')}`,
            avatar: 'none', fav: true, data: { extensions: {} },
        })));
        groups.forEach(group => { group.fav = false; });
        const { favsToHotswap } = await import('/scripts/RossAscends-mods.js');
        await favsToHotswap();
        window.NeconyanShell.openTab('characters', 'characters');
    }, count);
    await expect(page.locator(`${railSelector} .avatar`)).toHaveCount(count);
}

test.beforeEach(async ({ page }) => {
    await isolateSettingsSaves(page, settings => {
        settings.firstRun = false;
        settings.accountStorage ??= {};
        settings.accountStorage['NeconyanTutorialStatus.v1'] = 'skipped';
    });
    await openQuietChatForSmoke(page, { selectCharacter: false });
});

test.describe('favorites hotswap scrolling', () => {
    test.use({ viewport: { width: 1280, height: 900 } });

    test('scrolls vertical wheel input sideways without cancelling browser zoom gestures', async ({ page }) => {
        const result = await page.evaluate(() => {
            const hotswapBar = document.querySelector('#HotSwapWrapper .hotswap');

            if (!(hotswapBar instanceof HTMLElement)) {
                return null;
            }

            Object.defineProperties(hotswapBar, {
                clientWidth: { configurable: true, value: 100 },
                scrollWidth: { configurable: true, value: 200 },
            });

            let scrollLeft = null;
            Object.defineProperty(hotswapBar, 'scrollTo', {
                configurable: true,
                value: options => {
                    scrollLeft = options.left;
                },
            });

            const dispatchWheel = options => {
                const event = new WheelEvent('wheel', {
                    bubbles: true,
                    cancelable: true,
                    deltaY: 80,
                    ...options,
                });
                hotswapBar.dispatchEvent(event);

                return event.defaultPrevented;
            };

            return {
                ctrlWheelPrevented: dispatchWheel({ ctrlKey: true }),
                metaWheelPrevented: dispatchWheel({ metaKey: true }),
                horizontalWheelPrevented: dispatchWheel({ deltaX: 100, deltaY: 2 }),
                verticalWheelPrevented: dispatchWheel({}),
                scrollLeft,
            };
        });

        expect(result).toEqual({
            ctrlWheelPrevented: false,
            metaWheelPrevented: false,
            horizontalWheelPrevented: false,
            verticalWheelPrevented: true,
            scrollLeft: 80,
        });
    });

    test('desktop arrows reach both ends with mouse and keyboard', async ({ page }) => {
        await setFavorites(page, 60);
        const rail = page.locator(railSelector);
        const left = page.locator(leftSelector);
        const right = page.locator(rightSelector);
        await expect(left).toBeHidden();
        await expect(left).toBeDisabled();
        await expect(right).toBeVisible();
        await expect(right).toBeEnabled();
        await expect(page.locator('#HotSwapWrapper .sb-mobile-rail-track')).toBeVisible();
        await expect(rail).toHaveCSS('scrollbar-width', 'none');

        const firstTarget = await rail.evaluate(bar => bar.clientWidth * 0.68);
        await right.click();
        await expect.poll(async () => Math.abs(await rail.evaluate(bar => bar.scrollLeft) - firstTarget)).toBeLessThanOrEqual(1);
        await expect(left).toBeEnabled();
        await expect(left).toBeVisible();
        // Several page-sized steps must reveal the last actual avatar, not just move the arrows.
        for (let step = 0; step < 6 && await rail.evaluate(bar => bar.scrollWidth - bar.clientWidth - bar.scrollLeft > 1); step++) {
            const target = await rail.evaluate(bar => Math.min(bar.scrollWidth - bar.clientWidth, bar.scrollLeft + bar.clientWidth * 0.68));
            await right.click();
            await expect.poll(async () => Math.abs(await rail.evaluate(bar => bar.scrollLeft) - target)).toBeLessThanOrEqual(1);
        }
        await expect(right).toBeDisabled();
        const end = await rail.evaluate(bar => ({
            remaining: bar.scrollWidth - bar.clientWidth - bar.scrollLeft,
            lastRight: bar.lastElementChild.getBoundingClientRect().right,
            railRight: bar.getBoundingClientRect().right,
        }));
        expect(end.remaining).toBeLessThanOrEqual(1);
        expect(end.lastRight).toBeLessThanOrEqual(end.railRight);

        await page.emulateMedia({ reducedMotion: 'reduce' });
        await left.focus();
        await page.keyboard.press('Enter');
        await expect(right).toBeEnabled();
        for (let step = 0; step < 6 && await rail.evaluate(bar => bar.scrollLeft > 1); step++) await left.click();
        await expect(left).toBeDisabled();
        expect(await rail.evaluate(bar => bar.scrollLeft)).toBe(0);
    });

    test('arrows update when favourites change and the desktop is resized', async ({ page }) => {
        await setFavorites(page, 22);
        await expect(page.locator(leftSelector)).toBeHidden();
        await expect(page.locator(rightSelector)).toBeHidden();
        await page.setViewportSize({ width: 800, height: 900 });
        await expect(page.locator(rightSelector)).toBeVisible();
        await page.setViewportSize({ width: 1280, height: 900 });
        await expect(page.locator(rightSelector)).toBeHidden();
        await setFavorites(page, 60);
        await expect(page.locator(rightSelector)).toBeVisible();
        await setFavorites(page, 1);
        await expect(page.locator(leftSelector)).toBeHidden();
        await expect(page.locator(rightSelector)).toBeHidden();
        await setFavorites(page, 0);
        await expect(page.locator(rightSelector)).toBeHidden();
    });
});

test.describe('phone favourites', () => {
    test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });

    test('keeps the existing compact touch rail and shared controls', async ({ page, context }, info) => {
        await setFavorites(page, 36);
        await expect(page.locator(leftSelector)).toBeHidden();
        await expect(page.locator(rightSelector)).toBeVisible();
        const rail = page.locator(railSelector);
        await expect(rail).toHaveCSS('scrollbar-width', 'none');
        await expect(rail).toHaveCSS('touch-action', 'pan-x');
        const dimensions = await rail.evaluate(bar => {
            const drawer = bar.closest('#right-nav-panel');
            const events = [];
            const tagFor = el => el?.outerHTML?.split('>', 1)[0] ?? null;
            const snapshot = () => ({
                rail: bar.getBoundingClientRect().toJSON(),
                drawer: drawer.getBoundingClientRect().toJSON(),
                scrollLeft: bar.scrollLeft,
                maxScrollLeft: bar.scrollWidth - bar.clientWidth,
                viewport: { width: window.innerWidth, height: window.innerHeight, scale: window.visualViewport?.scale },
            });
            for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'click', 'scroll']) {
                window.addEventListener(type, event => {
                    if (events.length >= 50) return;
                    const touch = event.changedTouches?.[0];
                    const inside = bar.contains(event.target);
                    events.push({ event, data: {
                        type, inside, target: tagFor(event.target),
                        x: touch?.clientX, y: touch?.clientY,
                        ...(type === 'touchstart' ? snapshot() : {}),
                    } });
                }, { capture: true, passive: true });
            }
            window.testFavoritesSwipe = point => ({
                point, hitAfterSwipe: tagFor(document.elementFromPoint(point.x, point.y)),
                after: snapshot(),
                events: events.map(({ event, data }) => ({ ...data, cancelable: event.cancelable, cancelled: event.defaultPrevented })),
            });
            return { height: bar.getBoundingClientRect().height, overflow: getComputedStyle(bar).overflowX };
        });
        expect(dimensions.height).toBeLessThanOrEqual(36);
        expect(dimensions.overflow).toBe('auto');
        const box = await rail.boundingBox();
        const client = await context.newCDPSession(page);
        const start = { x: box.x + box.width - 60, y: box.y + box.height / 2 };
        try {
            await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
            for (let x = box.x + box.width - 65; x > box.x + 50; x -= 10) {
                await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: start.y }] });
            }
            await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await expect.poll(() => rail.evaluate(bar => bar.scrollLeft)).toBeGreaterThan(0);
            await expect(page.locator(leftSelector)).toBeVisible();
        } catch (error) {
            await info.attach('favourites-touch-targets', {
                body: JSON.stringify(await page.evaluate(point => window.testFavoritesSwipe(point), start)),
                contentType: 'application/json',
            });
            throw error;
        } finally {
            await client.detach();
        }
    });
});
