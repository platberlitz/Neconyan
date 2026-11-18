/* eslint-env browser */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves } from './chat-scroll-regression-helpers.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'no-preference' });

const longLabel = 'The Midnight Library on the Far Side of the Moon';

async function openLabelSettings(page) {
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
    const categories = page.locator('.sb-settings-category-select');
    if (await categories.isVisible()) await categories.selectOption('appearance');
    else await page.locator('.sb-settings-tab-btn[data-tab="appearance"]').click();
    const drawer = page.locator('#sb-topbar-label-drawer');
    const toggle = drawer.getByRole('checkbox', { name: 'Scroll long labels' });
    if (!await toggle.isVisible()) await drawer.locator('.inline-drawer-toggle').click();
    return toggle;
}

async function measureOverflow(text) {
    return text.evaluate(element => element.scrollWidth - element.parentElement.clientWidth);
}

async function expectStill(text) {
    await expect(text).toHaveCSS('animation-name', 'none');
    await expect(text).toHaveCSS('text-overflow', 'ellipsis');
    await expect(text).toHaveCSS('max-width', '100%');
}

for (const mode of ['mobile', 'desktop']) {
    test.describe(`top bar on ${mode}`, () => {
        test.use(mode === 'mobile'
            ? { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true }
            : { viewport: { width: 1280, height: 900 } });

        test('only scrolls clipped top bar labels and remembers the switch', async ({ page }) => {
            await isolateSettingsSaves(page, settings => {
                settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
                settings.power_user.reduced_motion = false;
            });
            await page.addInitScript(() => {
                window.addEventListener('neconyan:ready', () => { window.marqueeTestReady = true; }, { once: true });
            });
            await page.addLocatorHandler(page.locator('#qig-setup-wizard'), async wizard => {
                await wizard.getByRole('button', { name: 'Skip', exact: true }).click();
            });
            await page.goto('/', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => window.marqueeTestReady);
            await page.addStyleTag({ content: '#toast-container, #nn-update-toast { display: none !important; }' });
            const toggle = await openLabelSettings(page);
            await expect(toggle).toBeChecked();

            const drawer = page.locator('#sb-topbar-label-drawer');
            const customPart = drawer.locator(`[data-sb-topbar-label-mode="${mode}"][data-sb-topbar-label-part="custom"]`);
            const customText = drawer.getByRole('textbox', { name: 'Top bar custom text' });
            const title = page.locator('#sb-topbar-title');
            const text = title.locator('.sb-brand-title-text');
            await customPart.check();
            await customText.fill('Moon');
            await expect(title).toHaveText('Moon');
            await expectStill(text);

            // Reproduce a crowded bar even when the desktop viewport has spare room.
            const narrow = await page.addStyleTag({ content: '#sb-topbar-title { max-width: 160px; }' });
            await customText.fill(longLabel);
            await expect(title).toHaveText(longLabel);
            await expect(title).toHaveAccessibleName(new RegExp(longLabel));
            await expect.poll(() => measureOverflow(text)).toBeGreaterThan(30);
            await expect(text).toHaveCSS('animation-name', 'sb-title-slide');
            const [start, end, overflow] = await text.evaluate(element => {
                const animation = element.getAnimations()[0];
                const position = () => element.getBoundingClientRect().left;
                animation.currentTime = 0;
                const start = position();
                animation.currentTime = animation.effect.getComputedTiming().duration * 0.9;
                return [start, position(), element.scrollWidth - element.parentElement.clientWidth];
            });
            expect(start - end).toBeCloseTo(overflow, 0);

            await toggle.uncheck();
            await expectStill(text);
            await expect.poll(() => measureOverflow(text)).toBeGreaterThan(30);
            expect(await page.evaluate(() => localStorage.getItem('sb-topbar-label-marquee'))).toBe('false');
            await toggle.check();

            await expect(text).toHaveCSS('animation-name', 'sb-title-slide');
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await expectStill(text);
            await page.emulateMedia({ reducedMotion: 'no-preference' });
            await expect(text).toHaveCSS('animation-name', 'sb-title-slide');
            await page.locator('#reduced_motion').evaluate(input => {
                input.checked = true;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await expectStill(text);
            await page.locator('#reduced_motion').evaluate(input => {
                input.checked = false;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await expect(text).toHaveCSS('animation-name', 'sb-title-slide');
            await narrow.evaluate(element => { element.textContent = '#sb-topbar-title { max-width: 88px; }'; });
            await expect.poll(async () => {
                const overflow = await measureOverflow(text);
                const distance = await text.evaluate(element => Number.parseFloat(element.style.getPropertyValue('--sb-title-overflow')));
                return overflow > 100 && distance === overflow;
            }).toBe(true);
            await customText.fill('Moon');
            await expect(title).toHaveText('Moon');
            await expectStill(text);
        });
    });
}
