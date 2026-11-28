/* global document, window */
import { isolateSettingsSaves } from './chat-scroll-regression-helpers.js';
import { expect, test } from '@playwright/test';

// Home's template names the 348 KB moving cat. WebKit used to start downloading it while
// the template was parsed, before Home could swap in the resting cat for reduced motion.
const MOVING_CAT = /(?:^|\/)img\/neconyan-pixel-cat\.webp(?:\?|$)/;
const RESTING_CAT = /(?:^|\/)img\/neconyan-pixel-cat-rest\.webp(?:\?|$)/;

test.use({ serviceWorkers: 'block' });
test.setTimeout(150000);
test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'wait' });
});

const webkitTest = test.extend({ browserName: 'webkit' });

async function openHome(page, { appReducedMotion }) {
    const network = { moving: [], resting: [] };
    const pageErrors = [];
    page.on('request', request => {
        if (MOVING_CAT.test(request.url())) network.moving.push(request.url());
    });
    page.on('response', response => {
        if (RESTING_CAT.test(response.url())) network.resting.push(response.status());
        if (MOVING_CAT.test(response.url())) network.movingStatus = response.status();
    });
    page.on('pageerror', error => pageErrors.push(error.message));
    await isolateSettingsSaves(page, settings => {
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        settings.power_user = { ...settings.power_user, reduced_motion: appReducedMotion };
    });
    await page.addInitScript(() => {
        window.addEventListener('neconyan:ready', () => { window.homeCatAppReady = true; }, { once: true });
    });
    await page.addLocatorHandler(page.locator('#qig-setup-wizard'), async wizard => {
        await wizard.getByRole('button', { name: 'Skip', exact: true }).click();
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.homeCatAppReady === true, null, { timeout: 90000 });
    await expect(page.locator('body')).not.toHaveClass(/neconyan-home-booting/);
    await page.addStyleTag({ content: '#toast-container, #nn-update-toast { display: none !important; }' });
    return { network, pageErrors };
}

function movingCatTimings(page) {
    return page.evaluate(() => performance.getEntriesByType('resource')
        .map(entry => entry.name)
        .filter(name => /\/img\/neconyan-pixel-cat\.webp(?:\?|$)/.test(name)).length);
}

function systemReducesMotion(page) {
    return page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function nextPaint(page) {
    return page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
}

async function expectRestingHome(page, { network, pageErrors }) {
    const cat = page.locator('.welcomePanel [data-neconyan-cat]');
    const toggle = page.locator('.welcomePanel [data-neconyan-cat-toggle]');
    await expect(cat).toBeVisible();
    await expect(cat).toHaveAttribute('src', RESTING_CAT);
    await expect.poll(() => cat.evaluate(image => image.complete && image.naturalWidth)).toBe(208);
    await expect(toggle).toBeHidden();
    // Let any fetch started while Home was parsed reach the network log and resource timing.
    await nextPaint(page);
    expect(network.moving).toEqual([]);
    expect(await movingCatTimings(page)).toBe(0);
    expect(network.resting.length).toBeGreaterThan(0);
    expect(network.resting.every(status => status === 200)).toBe(true);
    expect(pageErrors).toEqual([]);
}

// Once motion is allowed the same page does fetch and play the moving cat, so the
// listener above would have seen it. Pausing and drawing Home again must not fetch it twice.
async function expectMotionThenPausedRedraw(page, { network, pageErrors }) {
    const cat = page.locator('.welcomePanel [data-neconyan-cat]');
    const toggle = page.locator('.welcomePanel [data-neconyan-cat-toggle]');
    await expect(cat).toHaveAttribute('src', MOVING_CAT);
    await expect(toggle).toHaveText('Pause cat animation');
    await expect.poll(() => network.moving.length).toBe(1);
    await expect.poll(() => network.movingStatus).toBe(200);
    await expect.poll(() => cat.evaluate(image => image.complete && image.naturalWidth)).toBe(208);

    await toggle.click();
    await expect(toggle).toHaveText('Play cat animation');
    await expect(cat).toHaveAttribute('src', RESTING_CAT);
    await page.evaluate(() => { document.querySelector('.welcomePanel').dataset.homeCatOldPanel = 'true'; });
    await page.evaluate(async () => (await import('/scripts/welcome-screen.js')).openWelcomeScreen({ force: true }));
    await expect(page.locator('.welcomePanel')).toHaveCount(1);
    await expect(page.locator('.welcomePanel[data-home-cat-old-panel]')).toHaveCount(0);
    await expect(toggle).toHaveText('Play cat animation');
    await expect(cat).toHaveAttribute('src', RESTING_CAT);
    await nextPaint(page);
    expect(network.moving).toHaveLength(1);
    expect(pageErrors).toEqual([]);
}

for (const [runner, engine] of [[test, 'chromium'], [webkitTest, 'webkit']]) {
    runner.describe(`phone with the system Reduce Motion setting (${engine})`, () => {
        runner.use({ viewport: { width: 393, height: 852 }, hasTouch: true, contextOptions: { reducedMotion: 'reduce' } });

        runner('Home never requests the moving cat', async ({ page, browserName }) => {
            expect(browserName).toBe(engine);
            const state = await openHome(page, { appReducedMotion: false });
            expect(await systemReducesMotion(page)).toBe(true);
            await expectRestingHome(page, state);
            await page.emulateMedia({ reducedMotion: 'no-preference' });
            await expectMotionThenPausedRedraw(page, state);
        });
    });

    runner.describe(`desktop with the app Reduced motion setting (${engine})`, () => {
        runner.use({ viewport: { width: 1280, height: 900 }, contextOptions: { reducedMotion: 'no-preference' } });

        runner('Home never requests the moving cat', async ({ page, browserName }) => {
            expect(browserName).toBe(engine);
            const state = await openHome(page, { appReducedMotion: true });
            expect(await systemReducesMotion(page)).toBe(false);
            await expect(page.locator('body')).toHaveClass(/(?:^|\s)reduced-motion(?:\s|$)/);
            await expectRestingHome(page, state);
            await page.evaluate(() => {
                const setting = document.getElementById('reduced_motion');
                setting.checked = false;
                setting.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await expect(page.locator('body')).not.toHaveClass(/(?:^|\s)reduced-motion(?:\s|$)/);
            await expectMotionThenPausedRedraw(page, state);
        });
    });
}
