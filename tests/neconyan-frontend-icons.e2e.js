/* global window */
import { expect, test } from '@playwright/test';

test.setTimeout(60000);

async function expand(page, selector) {
    const header = page.locator(selector);
    if (await header.getAttribute('aria-expanded') !== 'true') await header.click();
}

for (const viewport of [{ width: 393, height: 852 }, { width: 1280, height: 900 }]) {
    test.describe(`assistant icons at ${viewport.width}px`, () => {
        test.use({ viewport, hasTouch: viewport.width < 768, isMobile: viewport.width < 768, serviceWorkers: 'block' });
        test('selects, badges and remembers each assistant icon', async ({ page }, testInfo) => {
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            let firstLoad = true;
            await page.route('**/api/settings/get', async route => {
                const response = await route.fetch();
                const data = await response.json();
                const settings = JSON.parse(data.settings);
                settings.firstRun = false;
                settings.accountStorage['NeconyanTutorialStatus.v1'] = 'skipped';
                settings.accountStorage.WelcomePage_PanelMode = 'full';
                if (firstLoad) {
                    for (const id of ['miso', 'taro', 'nori']) delete settings.accountStorage[`neconyanAssistantGender:${id}`];
                    firstLoad = false;
                }
                await route.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
            });
            await page.goto('/');
            await expect(page.locator('.neconyan-assistant-row').first()).toBeAttached({ timeout: 60000 });
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'settings'));
            await expand(page, '#AppearanceSection > .inline-drawer-header');
            await expand(page, '#sb-interface-drawer > .inline-drawer-header');
            const options = page.locator('[data-sb-frontend-icon-option]');
            await expect(options).toHaveCount(4);
            for (const id of ['miso', 'taro', 'nori']) {
                const button = page.locator(`[data-sb-frontend-icon-option="${id}"]`);
                await button.click();
                await expect(button).toHaveAttribute('aria-pressed', 'true');
                await expect.poll(() => page.evaluate(() => window.localStorage.getItem('sb-frontend-icon'))).toBe(id);
                await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute('href', new RegExp(`assistant-icons/${id}-neutral\\.png\\?v=`));
                const geometry = await button.evaluate(element => {
                    const box = element.getBoundingClientRect();
                    const image = element.querySelector('img');
                    return { width: box.width, height: box.height, left: box.left, right: box.right, imageWidth: image.naturalWidth, rendering: window.getComputedStyle(image).imageRendering };
                });
                expect(geometry.width).toBeGreaterThanOrEqual(44);
                expect(geometry.height).toBeGreaterThanOrEqual(44);
                expect(geometry.left).toBeGreaterThanOrEqual(0);
                expect(geometry.right).toBeLessThanOrEqual(viewport.width);
                expect(geometry.imageWidth).toBe(192);
                expect(geometry.rendering).toBe('auto');
                await page.evaluate(async () => {
                    const notifications = await import('/scripts/neconyan-conversation/notifications.js');
                    notifications.updateConversationFaviconBadge(2);
                });
                await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute('href', /^data:image\/png/);
                await page.evaluate(async () => {
                    const notifications = await import('/scripts/neconyan-conversation/notifications.js');
                    notifications.updateConversationFaviconBadge(0);
                });
                await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute('href', new RegExp(`assistant-icons/${id}-neutral\\.png\\?v=`));
            }
            await page.locator('.sb-frontend-icon-group').screenshot({ path: testInfo.outputPath('assistant-icons.png') });
            await page.evaluate(() => window.NeconyanShell.showHome());
            const choices = { miso: 'female', taro: 'male', nori: 'female' };
            for (const [id, gender] of Object.entries(choices)) {
                const row = page.locator(`[data-assistant-personality="${id}"]`);
                await expect(row.locator('input[data-gender="neutral"]')).toBeChecked();
                await row.locator(`input[data-gender="${gender}"]`).check();
                await expect(row.locator('[data-assistant-portrait]')).toHaveAttribute('src', new RegExp(`${id}-${gender}/portrait\\?v=[a-f0-9]{12}$`));
                await expect(page.locator(`[data-assistant-icon="${id}"]`)).toHaveAttribute('src', new RegExp(`${id}-${gender}\\.png\\?v=`));
            }
            await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute('href', /nori-female\.png\?v=/);
            await page.evaluate(async () => (await import('/script.js')).saveSettings());
            await page.reload();
            await expect(page.locator('.neconyan-assistant-row').first()).toBeAttached({ timeout: 60000 });
            await expect(page.locator('html')).toHaveAttribute('data-sb-frontend-icon', 'nori');
            await expect.poll(() => page.evaluate(() => window.NeconyanFrontendIcon.getSrc())).toBe('/img/neconyan/assistant-icons/nori-female.png?v=20260916-art4');
            await page.evaluate(() => window.NeconyanShell.showHome());
            for (const [id, gender] of Object.entries(choices)) {
                await expect(page.locator(`[data-assistant-personality="${id}"] input[data-gender="${gender}"]`)).toBeChecked();
            }
            await page.getByText('Home layout', { exact: true }).click();
            await page.getByRole('button', { name: 'Replay First paws tour', exact: true }).click();
            const tour = page.locator('#neconyan-tour-coachmark');
            await expect(tour.locator('[data-tour-image]')).toHaveAttribute('src', /tour-01-miso-connect-female\.webp\?v=/);
            // Keyboard selection also refreshes an already visible guide without advancing the tour.
            await page.locator('input[value="miso-male"]').focus();
            await page.locator('input[value="miso-male"]').press('Space');
            await expect(tour.locator('[data-tour-image]')).toHaveAttribute('src', /tour-01-miso-connect-male\.webp\?v=/);
            await page.locator('input[value="miso-female"]').focus();
            await page.locator('input[value="miso-female"]').press('Space');
            for (let step = 0; step < 8; step++) {
                await expect(tour).toHaveAttribute('data-tutorial-index', String(step));
                await expect.poll(() => tour.locator('[data-tour-image]').evaluate(image => image.complete && image.naturalWidth === 512)).toBe(true);
                await tour.locator('[data-tour-coach-next]').click();
            }
            await expect(tour.locator('[data-tour-image]')).toHaveCount(3);
            for (const [id, gender] of Object.entries(choices)) {
                await expect(tour.locator(`[data-tour-image][src*="${id}"]`)).toHaveAttribute('src', new RegExp(`-${gender}\\.webp\\?v=`));
            }
            await expect.poll(() => tour.locator('[data-tour-image]').evaluateAll(images => images.every(image => image.complete && image.naturalWidth === 512))).toBe(true);
            const tourGeometry = await tour.evaluate(element => {
                const box = element.getBoundingClientRect();
                return { left: box.left, right: box.right, overflow: element.scrollWidth > element.clientWidth,
                    images: [...element.querySelectorAll('[data-tour-image]')].map(image => ({ width: image.getBoundingClientRect().width, fit: window.getComputedStyle(image).objectFit })) };
            });
            expect(tourGeometry.left).toBeGreaterThanOrEqual(0);
            expect(tourGeometry.right).toBeLessThanOrEqual(viewport.width);
            expect(tourGeometry.overflow).toBe(false);
            for (const image of tourGeometry.images) {
                expect(image.width).toBeGreaterThan(0);
                expect(image.fit).toBe('contain');
            }
            await tour.screenshot({ path: testInfo.outputPath('gender-aware-tour-ending.png') });
            await tour.locator('[data-tour-coach-next]').click();
            await expect(tour).toHaveCount(0);
            const miso = page.locator('[data-assistant-personality="miso"]');
            await miso.locator('input[value="miso-neutral"]').check();
            await miso.locator('[data-assistant-open]').click();
            await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().characterId)).toBeDefined();
            await expect(page.locator('body')).not.toHaveClass(/neconyan-home-visible/, { timeout: 30000 });
            await page.evaluate(() => window.NeconyanShell.activateMode('meower'));
            await expect(page.locator('html')).toHaveAttribute('data-neconyan-chat-mode', 'meower');
            await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute('href', '/img/neconyan-paw-192.png');
            await page.evaluate(() => window.NeconyanShell.activateMode('roleplay'));
            await expect(page.locator('html')).toHaveAttribute('data-neconyan-chat-mode', 'roleplay');
            await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute('href', /assistant-icons\/nori-female\.png\?v=/);
            expect(errors).toEqual([]);
        });
    });
}
