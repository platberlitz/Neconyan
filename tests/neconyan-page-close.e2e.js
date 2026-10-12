/* global document, window, getComputedStyle, requestAnimationFrame */
import { expect, test as base } from '@playwright/test';
import { existsSync } from 'node:fs';
import { isolateSettingsSaves, selectSampleCharacter } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const test = base.extend({
    pageCloseBrowser: ['chromium', { option: true }],
    pageClosePhone: [false, { option: true }],
    page: async ({ playwright, pageCloseBrowser, pageClosePhone, baseURL }, use) => {
        // eslint-disable-next-line playwright/no-skipped-test
        test.skip(pageCloseBrowser === 'webkit' && !existsSync(playwright.webkit.executablePath()), 'WebKit not installed');
        const browser = await playwright[pageCloseBrowser].launch();
        const context = await browser.newContext({
            ...(pageClosePhone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } }),
            baseURL,
            serviceWorkers: 'block',
            reducedMotion: 'no-preference',
        });
        const page = await context.newPage();
        try {
            await use(page);
        } finally {
            await page.unrouteAll({ behavior: 'wait' });
            await context.close();
            await browser.close();
        }
    },
});
test.setTimeout(120000);

async function refreshPhoneCss(page, phone) {
    if (phone) await applyIOSOnlyCss(page);
}

async function openApp(page, phone) {
    if (phone) await installIPhoneSafari(page.context(), { standalone: false });
    await isolateSettingsSaves(page, settings => {
        settings.firstRun = false;
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        settings.power_user.reduced_motion = false;
    });
    await page.addLocatorHandler(page.locator('#qig-setup-wizard'), wizard => wizard.evaluate(node => node.remove()));
    await page.goto('/?view=home', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
    await expect(page.locator('#neconyan-home-host')).toBeVisible();
    await refreshPhoneCss(page, phone);
}

async function openModelPage(page) {
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
    const panel = page.locator('#left-nav-panel');
    await expect(panel).toBeVisible();
    await expect.poll(() => panel.evaluate(node => node.getAnimations().length)).toBe(0);
    await expect(page.locator('#sheld')).toHaveCSS('visibility', 'hidden');
}

async function closeAndSample(page, phone, home) {
    // Observe the real close button after its own handler, before the first exit frame.
    await page.evaluate(async () => {
        const { isUiClosing } = await import('/scripts/ui-motion.js');
        const panel = document.getElementById('left-nav-panel');
        window.pageCloseTraceDone = new Promise((resolve, reject) => {
            panel.querySelector('.sb-shell-close').addEventListener('click', () => {
                const frames = [];
                const sample = () => ({
                    closing: isUiClosing(panel),
                    marker: panel.dataset.uiClosing ?? null,
                    open: panel.classList.contains('openDrawer'),
                    running: panel.getAnimations().length > 0,
                    sheld: getComputedStyle(document.getElementById('sheld')).visibility,
                    home: getComputedStyle(document.getElementById('neconyan-home-host')).visibility,
                });
                const immediate = sample();
                const timeout = window.setTimeout(() => reject(new Error('Page close did not settle')), 15000);
                const nextFrame = () => {
                    const frame = sample();
                    frames.push(frame);
                    if (frame.closing || frame.running) requestAnimationFrame(nextFrame);
                    else {
                        window.clearTimeout(timeout);
                        resolve({ immediate, frames });
                    }
                };
                requestAnimationFrame(nextFrame);
            }, { once: true });
        });
    });
    const close = page.locator('#left-nav-panel .sb-shell-close');
    if (phone) await close.tap();
    else await close.click();
    const trace = await page.evaluate(() => window.pageCloseTraceDone);
    expect(trace.immediate).toMatchObject({ closing: true, marker: 'true', open: true, running: true, sheld: 'visible' });
    expect(trace.frames.length).toBeGreaterThan(0);
    expect(trace.frames.some(frame => frame.closing && frame.running)).toBe(true);
    for (const frame of [trace.immediate, ...trace.frames]) {
        expect(frame.sheld).toBe('visible');
        if (home) expect(frame.home).toBe('visible');
        if (frame.closing) expect(frame.marker).toBe('true');
    }
    expect(trace.frames.at(-1)).toMatchObject({ closing: false, marker: null, open: false, running: false });
    await expect(page.locator('#left-nav-panel')).toBeHidden();
}

for (const browserName of ['chromium', 'webkit']) {
    for (const phone of [true, false]) {
        test.describe(`${browserName} ${phone ? 'iPhone Safari stand-in' : 'desktop'} page close`, () => {
            test.use({ pageCloseBrowser: browserName, pageClosePhone: phone });

            test('reveals Home and chat throughout the exit, without exposing them behind another open page', async ({ page }) => {
                await openApp(page, phone);
                await openModelPage(page);
                await expect(page.locator('#neconyan-home-host')).toHaveCSS('visibility', 'hidden');
                await closeAndSample(page, phone, true);

                await selectSampleCharacter(page);
                await expect(page.locator('#neconyan-home-host')).toBeHidden();
                await refreshPhoneCss(page, phone);
                await openModelPage(page);
                await closeAndSample(page, phone, false);

                await openModelPage(page);
                const reopened = await page.evaluate(async () => {
                    const { isUiClosing } = await import('/scripts/ui-motion.js');
                    const panel = document.getElementById('left-nav-panel');
                    panel.querySelector('.sb-shell-close').click();
                    const closing = { closing: isUiClosing(panel), marker: panel.dataset.uiClosing, sheld: getComputedStyle(document.getElementById('sheld')).visibility };
                    window.NeconyanShell.openTab('left', 'api');
                    return {
                        closing,
                        reopened: { closing: isUiClosing(panel), marker: panel.dataset.uiClosing ?? null, sheld: getComputedStyle(document.getElementById('sheld')).visibility },
                    };
                });
                expect(reopened.closing).toEqual({ closing: true, marker: 'true', sheld: 'visible' });
                expect(reopened.reopened).toEqual({ closing: false, marker: null, sheld: 'hidden' });
                await expect.poll(() => page.locator('#left-nav-panel').evaluate(node => node.getAnimations().length)).toBe(0);
                await expect(page.locator('#left-nav-panel')).toBeVisible();
                await expect(page.locator('#left-nav-panel')).not.toHaveAttribute('data-ui-closing');
                await expect(page.locator('#sheld')).toHaveCSS('visibility', 'hidden');

                const replaced = await page.evaluate(async () => {
                    const panel = document.getElementById('left-nav-panel');
                    panel.querySelector('.sb-shell-close').click();
                    window.NeconyanShell.openTab('right', 'extensions');
                    const replacement = document.getElementById('user-settings-block');
                    const sample = () => ({ sheld: getComputedStyle(document.getElementById('sheld')).visibility, replacementOpen: replacement.classList.contains('openDrawer') });
                    const immediate = sample();
                    const frames = await new Promise(resolve => {
                        const frames = [];
                        const nextFrame = () => {
                            frames.push(sample());
                            if (panel.getAnimations().length || replacement.getAnimations().length) requestAnimationFrame(nextFrame);
                            else resolve(frames);
                        };
                        requestAnimationFrame(nextFrame);
                    });
                    return { immediate, frames };
                });
                for (const frame of [replaced.immediate, ...replaced.frames]) expect(frame).toEqual({ sheld: 'hidden', replacementOpen: true });
                await expect(page.locator('#left-nav-panel')).toBeHidden();
                await expect(page.locator('#left-nav-panel')).not.toHaveAttribute('data-ui-closing');
                await expect.poll(() => page.locator('#user-settings-block').evaluate(node => node.getAnimations().length)).toBe(0);
                await expect(page.locator('#sheld')).toHaveCSS('visibility', 'hidden');
            });
        });
    }
}
