/* global document, window, getComputedStyle */
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

test.use({ serviceWorkers: 'block' });
test.setTimeout(90000);

const entries = [
    'Let’s follow the lanterns through the old town.\nI tuck the map into my coat and wait for you at the bridge.',
    'What did you mean about the letter?',
    '/send A little rain never stopped us before.',
];

for (const phone of [false, true]) {
    for (const tone of ['Dark', 'Light']) {
        test(`${phone ? 'phone' : 'desktop'} ${tone}: readable, accessible input history`, async ({ browser }) => {
            const context = await browser.newContext(phone ? { ...IPHONE_SAFARI_CONTEXT, serviceWorkers: 'block' } : { viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
            if (phone) await installIPhoneSafari(context, { standalone: true });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            let savedSettings;
            await page.route('**/api/settings/get', async route => {
                const response = await route.fetch();
                const envelope = await response.json();
                if (typeof envelope.settings !== 'string') return route.fulfill({ json: envelope });
                const settings = savedSettings ?? JSON.parse(envelope.settings);
                const theme = JSON.parse(readFileSync(new URL(`../default/content/themes/Neconyan Calico${tone === 'Dark' ? ' Dark' : ''}.json`, import.meta.url), 'utf8'));
                settings.power_user = { ...settings.power_user, ...theme, theme: theme.name, google_font: '' };
                settings.extension_settings.disabledExtensions = [...new Set([...(settings.extension_settings.disabledExtensions || []), 'third-party/Neconyan-Time-Machine'])];
                settings.firstRun = false;
                settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', 'st--inputHistory': JSON.stringify(entries) };
                await route.fulfill({ json: { ...envelope, settings: JSON.stringify(settings) } });
            });
            await page.route('**/api/settings/save', async route => {
                let bytes = route.request().postDataBuffer();
                if (route.request().headers()['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
                const payload = JSON.parse(bytes.toString());
                savedSettings = { ...payload, _version: Math.max(Date.now(), Number(payload._version || 0) + 1), _settingsRevision: Number(payload._settingsRevision || 0) + 1 };
                await route.fulfill({ json: { result: 'ok', version: savedSettings._version, settingsRevision: savedSettings._settingsRevision } });
            });
            await page.goto(process.env.NECONYAN_TEST_BASE_URL || 'http://127.0.0.1:4433', { waitUntil: 'domcontentloaded' });
            const trigger = page.locator('.stih--menuTrigger');
            await expect(trigger).toBeAttached({ timeout: 60000 });
            await expect(page.locator('body')).not.toHaveClass(/neconyan-home-booting/, { timeout: 60000 });
            await page.evaluate(async () => (await import('/scripts/welcome-screen.js')).hideWelcomeHome());
            if (phone) await applyIOSOnlyCss(page);
            for (const width of phone ? [320, 360, 768, 393] : [1280]) {
                await page.setViewportSize({ width, height: phone ? 852 : 900 });
                const toolbar = await page.locator('#gg-action-button-container').evaluate(element => {
                    const buttons = [...element.querySelectorAll('.stih--button, .gg-action-button')].filter(button => button.getClientRects().length);
                    return buttons.map(button => {
                        const box = button.getBoundingClientRect();
                        return { centre: box.top + box.height / 2, height: box.height, left: box.left, right: box.right };
                    });
                });
                expect(toolbar).toHaveLength(10);
                expect(Math.max(...toolbar.map(button => button.centre)) - Math.min(...toolbar.map(button => button.centre)), `${width}px toolbar stays on one row`).toBeLessThanOrEqual(1);
                expect(Math.min(...toolbar.map(button => button.height))).toBeGreaterThanOrEqual(phone ? 44 : 24);
                expect(Math.min(...toolbar.map(button => button.left))).toBeGreaterThanOrEqual(0);
                expect(Math.max(...toolbar.map(button => button.right))).toBeLessThanOrEqual(page.viewportSize().width);
            }
            await trigger[phone ? 'tap' : 'click']();
            const panel = page.locator('.stih--history');
            await expect(panel).toBeVisible();
            await expect(panel.locator('.stih--item')).toHaveCount(3);
            await expect(panel.locator('.stih--title').first()).toHaveCSS('font-size', '16px');
            await expect(panel.locator('.stih--item').first()).toHaveCSS('border-radius', '0px');
            await expect(panel.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
            const geometry = await panel.evaluate(element => {
                const box = element.getBoundingClientRect();
                const form = document.querySelector('#send_form').getBoundingClientRect();
                return {
                    left: box.left, right: box.right, top: box.top, bottom: box.bottom,
                    contentWidth: element.scrollWidth, panelWidth: element.clientWidth,
                    viewport: window.innerWidth, formBottom: form.bottom, height: window.innerHeight,
                    targets: [...document.querySelectorAll('.stih--buttons button')].map(button => button.getBoundingClientRect().height),
                };
            });
            expect(geometry.contentWidth).toBeLessThanOrEqual(geometry.panelWidth + 1);
            expect(geometry.left).toBeGreaterThanOrEqual(0);
            expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
            expect(geometry.top).toBeGreaterThanOrEqual(0);
            expect(geometry.formBottom).toBeLessThanOrEqual(geometry.height + 1);
            expect(Math.min(...geometry.targets)).toBeGreaterThanOrEqual(44);
            await page.screenshot({ path: `../screenshots/input-history-${phone ? 'phone' : 'desktop'}-${tone.toLowerCase()}-after.png` });

            // Secondary controls must keep readable labels across pale and dark accents.
            for (const accent of ['rgb(214, 146, 112)', 'rgb(216, 241, 226)', 'rgb(67, 25, 53)']) {
                await page.evaluate(accent => document.documentElement.style.setProperty('--SmartThemeQuoteColor', accent), accent);
                await panel.getByRole('button', { name: 'Close', exact: true }).hover();
                const contrasts = await panel.evaluate(async () => {
                    const { contrastRatio } = await import('/scripts/theme-contrast.js');
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    const channels = colour => {
                        ctx.fillStyle = colour;
                        ctx.fillRect(0, 0, 1, 1);
                        return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
                    };
                    return [...document.querySelectorAll('.stih--buttons button')].map(button => {
                        const style = getComputedStyle(button);
                        return contrastRatio(channels(style.color), channels(style.backgroundColor));
                    });
                });
                expect(Math.min(...contrasts)).toBeGreaterThanOrEqual(4.5);
            }
            const search = panel.getByRole('searchbox', { name: 'Search input history' });
            await search.fill('MAP bridge');
            await expect(panel.locator('.stih--item:visible')).toHaveCount(1);
            await search.fill('no matching phrase');
            await expect(panel.getByRole('status')).toHaveText('No matching inputs. Try another search.');
            await search.fill('lanterns');
            await page.locator('#send_textarea').evaluate(element => {
                window.historyInputEvents = 0;
                element.addEventListener('input', () => window.historyInputEvents++);
            });
            await panel.locator('.stih--item:visible').focus();
            await page.keyboard.press('Enter');
            await expect(panel).toHaveCount(0);
            await expect(page.locator('#send_textarea')).toHaveValue(entries[0]);
            expect(await page.evaluate(() => window.historyInputEvents)).toBe(1);
            await trigger[phone ? 'tap' : 'click']();
            await page.keyboard.press('Escape');
            await expect(panel).toHaveCount(0);
            await expect(trigger).toBeFocused();
            await expect(trigger).toHaveAttribute('aria-expanded', 'false');

            await page.evaluate(async () => {
                const { accountStorage } = await import('/scripts/util/AccountStorage.js');
                accountStorage.setItem('st--inputHistory', JSON.stringify(Array.from({ length: 30 }, (_, index) => `${index}: ${'longinput'.repeat(50)}\nA second line.`)));
            });
            await trigger[phone ? 'tap' : 'click']();
            const overflow = await panel.locator('.stih--list').evaluate(element => ({
                client: element.clientHeight, scroll: element.scrollHeight,
                width: element.clientWidth, contentWidth: element.scrollWidth,
            }));
            expect(overflow.scroll).toBeGreaterThan(overflow.client);
            expect(overflow.contentWidth).toBeLessThanOrEqual(overflow.width + 1);
            await panel.getByRole('button', { name: 'Close', exact: true }).click();

            await page.evaluate(async () => {
                const { accountStorage } = await import('/scripts/util/AccountStorage.js');
                accountStorage.setItem('st--inputHistory', '[]');
            });
            await trigger[phone ? 'tap' : 'click']();
            await expect(panel.getByRole('status')).toHaveText('Your inputs will appear here after you send them.');
            await page.locator('#send_textarea').click();
            await expect(panel).toHaveCount(0);
            await page.getByRole('button', { name: 'Previous input', exact: true }).click();
            await expect(page.locator('#send_textarea')).toHaveValue('');
            expect(errors).toEqual([]);
            await context.close();
        });
    }
}
