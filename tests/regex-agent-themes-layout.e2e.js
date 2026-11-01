/* global document, window, getComputedStyle */
import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { acknowledgeSettingsSave } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';
import { contrastRatio } from '../public/scripts/theme-contrast.js';

async function navigationColours(page) {
    return page.evaluate(() => [...document.querySelectorAll('#rat_drawer .rat-stage-nav button')].map(button => {
        const context = document.createElement('canvas').getContext('2d');
        const rgb = value => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = value;
            context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data];
        };
        const ancestors = [];
        for (let parent = button; parent; parent = parent.parentElement) ancestors.unshift(parent);
        let background = [255, 255, 255];
        for (const parent of ancestors) {
            const over = rgb(getComputedStyle(parent).backgroundColor);
            background = over.slice(0, 3).map((value, i) => value * over[3] / 255 + background[i] * (1 - over[3] / 255));
        }
        return { colour: rgb(getComputedStyle(button).color).slice(0, 3), background, height: button.getBoundingClientRect().height };
    }));
}

async function navigationGeometry(page) {
    return page.evaluate(() => {
        const nav = document.querySelector('#rat_drawer .rat-stage-nav');
        const bounds = nav.getBoundingClientRect();
        const boxes = [...nav.children].map(element => {
            const box = element.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(element);
            const content = range.getBoundingClientRect();
            return {
                left: box.left, right: box.right, top: box.top, bottom: box.bottom,
                contained: content.left >= box.left - 1 && content.right <= box.right + 1,
                withinNav: box.left >= bounds.left - 1 && box.right <= bounds.right + 1,
            };
        });
        return {
            contained: boxes.every(box => box.contained && box.withinNav),
            overlaps: boxes.some((a, i) => boxes.slice(i + 1).some(b =>
                a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top)),
        };
    });
}

for (const phone of [true, false]) {
    test(`theme search navigation keeps labels readable on ${phone ? 'phone' : 'desktop'}`, async ({ browser }, info) => {
        test.setTimeout(90000);
        const context = await browser.newContext({
            baseURL: info.project.use.baseURL,
            ...(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } }),
            serviceWorkers: 'block', reducedMotion: 'reduce',
        });
        try {
            if (phone) await installIPhoneSafari(context, { standalone: true });
            const page = await context.newPage();
            await page.route('**/api/characters/all', route => route.fulfill({ json: [] }));
            await page.route('**/api/settings/get', async route => {
                const response = await route.fetch();
                const data = await response.json();
                const settings = JSON.parse(data.settings || await readFile(new URL('../default/content/settings.json', import.meta.url), 'utf8'));
                settings.firstRun = false;
                settings.extension_settings ||= {};
                settings.extension_settings.disabledExtensions = [...new Set([...(settings.extension_settings.disabledExtensions || []), 'third-party/Neconyan-Time-Machine'])];
                settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', WelcomePage_PanelMode: 'full' };
                await route.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
            });
            await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
            await page.goto('/');
            await page.waitForFunction(() => window.NeconyanShell && document.querySelector('#rat_drawer') && !document.querySelector('#preloader'));
            await page.evaluate(() => window.NeconyanShell.openIncludedTool('third-party/Neconyan-Regex-Agent-Themes'));
            await page.locator('#rat_toggle_browse').click();
            if (phone) await applyIOSOnlyCss(page);
            const search = page.locator('#rat_theme_search');
            const position = page.locator('#rat_drawer .rat-stage-position');
            const next = page.locator('#rat_drawer [data-focus-key="stage-next"]');
            const previous = page.locator('#rat_drawer [data-focus-key="stage-previous"]');
            await search.fill('rain');
            await expect(position).toHaveText(/Not in this filter, \d+ shown/);
            await page.evaluate(() => {
                document.activeElement.blur();
                document.querySelector('#rat_drawer .rat-stage-position').scrollIntoView({ block: 'center', behavior: 'instant' });
            });
            await page.evaluate(() => window.toastr.clear());
            await expect(page.locator('#toast-container .toast')).toHaveCount(0);
            await expect(position).toBeInViewport({ ratio: 1 });
            const directory = new URL('../screenshots/', import.meta.url);
            await mkdir(directory, { recursive: true });
            const screenshot = new URL(`regex-search-${phone ? 'phone' : 'desktop'}.png`, directory).pathname;
            await page.screenshot({ path: screenshot });
            await info.attach('filtered theme navigation', { path: screenshot, contentType: 'image/png' });
            expect(await navigationGeometry(page)).toEqual({ contained: true, overlaps: false });
            await next.click();
            await expect(position).toHaveText(/1 of \d+/);
            expect(await navigationGeometry(page)).toEqual({ contained: true, overlaps: false });
            await search.fill('no-such-theme-12345');
            await expect(position).toHaveText('Not in this filter, 0 shown');
            await expect(next).toBeDisabled();
            await expect(previous).toBeDisabled();
            expect(await navigationGeometry(page)).toEqual({ contained: true, overlaps: false });
            await search.fill('');
            await expect(next).toBeEnabled();
            await expect(position).toHaveText(/\d+ of \d+/);
            expect(await navigationGeometry(page)).toEqual({ contained: true, overlaps: false });
            // A narrow desktop panel needs the same protection as a phone.
            await page.locator('#rat_drawer').evaluate(drawer => { drawer.style.maxWidth = '450px'; });
            await search.fill('rain');
            await expect(position).toHaveText(/1 of \d+/);
            expect(await navigationGeometry(page)).toEqual({ contained: true, overlaps: false });
            const contrast = [];
            for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
                await page.locator('#themes').selectOption({ label: theme }, { force: true });
                for (const accent of [null, 'Pearl', 'Midnight Ink']) {
                    if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
                    await page.evaluate(async () => Promise.all(document.getAnimations().filter(animation => animation instanceof window.CSSTransition).map(animation => animation.finished.catch(() => {}))));
                    const colours = await navigationColours(page);
                    expect(colours).toHaveLength(2);
                    for (const measured of colours) {
                        const ratio = contrastRatio(measured.colour, measured.background);
                        expect(ratio, JSON.stringify({ theme, accent, ...measured })).toBeGreaterThanOrEqual(4.5);
                        expect(measured.height).toBeGreaterThanOrEqual(phone ? 44 : 32);
                        contrast.push({ theme, accent, ratio, ...measured });
                    }
                    expect(await navigationGeometry(page)).toEqual({ contained: true, overlaps: false });
                }
            }
            await info.attach('navigation contrast and tap sizes', { body: JSON.stringify(contrast, null, 2), contentType: 'application/json' });
        } finally {
            await context.close();
        }
    });
}
