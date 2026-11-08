/* global document, getComputedStyle, window */
import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { acknowledgeSettingsSave } from './chat-scroll-regression-helpers.js';

for (const phone of [true, false]) {
    const deviceName = phone ? 'phone' : 'desktop';
    test(`tracker companion previews preserve their layout on ${deviceName}`, async ({ browser }, info) => {
        test.setTimeout(180000);
        const context = await browser.newContext({
            baseURL: info.project.use.baseURL,
            viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 },
            ...(phone ? { isMobile: true, hasTouch: true } : {}),
            serviceWorkers: 'block', reducedMotion: 'reduce',
        });
        try {
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
            await page.locator('#rat_drawer [data-focus-key="stage-next"]').click();
            const picker = page.locator('#rat_preview_archetype');
            for (const [value, label] of [['position', 'Position Tracker'], ['visual-map', 'Visual Map'], ['vitals', 'Vitals']]) {
                await expect(picker.locator(`option[value="${value}"]`)).toHaveText(label);
                await picker.selectOption(value);
                await expect(page.locator(`#rat_drawer [data-rat-key="${value}"]`).first()).toBeVisible();
            }

            // Keep the real formatter and app styles, but show all three cards together
            // so the stock and themed screenshots use the same sample data and layout.
            await page.evaluate(() => {
                for (const child of document.body.children) child.style.display = 'none';
                for (const element of [document.documentElement, document.body]) {
                    for (const [property, value] of [['height', 'auto'], ['max-height', 'none'], ['overflow', 'visible'], ['position', 'static']]) {
                        element.style.setProperty(property, value, 'important');
                    }
                }
                const host = document.createElement('main');
                host.id = 'tracker-captures';
                host.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:18px;padding:20px;background:#202129;color:#eee;min-height:100vh;box-sizing:border-box';
                document.body.append(host);
            });
            const directory = new URL('../screenshots/', import.meta.url);
            await mkdir(directory, { recursive: true });
            const appearanceChecks = [];
            for (const [stage, slug] of [['before', null], ['after', 'obsidian-ink'], ['after-light', 'delft-porcelain']]) {
                await page.evaluate(async selected => {
                    const base = '/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/';
                    const { mountPreview } = await import(`${base}preview.js`);
                    const { getTheme } = await import(`${base}themes/index.js`);
                    const host = document.querySelector('#tracker-captures');
                    host.textContent = '';
                    for (const [archetype, label] of [['position', 'Position Tracker'], ['visual-map', 'Visual Map'], ['vitals', 'Vitals']]) {
                        const section = document.createElement('section');
                        section.dataset.capture = archetype;
                        section.style.cssText = 'min-width:0;align-self:start';
                        const heading = document.createElement('h2');
                        heading.textContent = label;
                        heading.style.cssText = 'font:600 16px system-ui;color:#eee;margin:0 0 12px';
                        section.append(heading);
                        const card = document.createElement('div');
                        section.append(card);
                        host.append(section);
                        mountPreview(card, archetype, selected ? getTheme(selected) : null);
                    }
                }, slug);
                const screenshot = new URL(`regex-companions-${stage}-${deviceName}.png`, directory).pathname;
                await page.screenshot({ path: screenshot, fullPage: true });
                await info.attach(`${stage} ${deviceName}`, { path: screenshot, contentType: 'image/png' });
                for (const value of ['Harbour at dusk', 'Mira', 'Tavern', 'Docks', 'Health', '23', 'Bruised ribs', 'Sheltered']) {
                    await expect(page.locator('#tracker-captures')).toContainText(value);
                }
                const bounds = await page.evaluate(() => {
                    const host = document.querySelector('#tracker-captures');
                    return { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
                        sections: [...host.children].map(element => ({ width: element.clientWidth, scroll: element.scrollWidth })) };
                });
                expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
                for (const section of bounds.sections) expect(section.scroll).toBeLessThanOrEqual(section.width + 1);
                const fontSizes = await page.evaluate(() => ['position', 'vitals'].map(key => {
                    const card = document.querySelector(`[data-capture="${key}"] .mes_text > div`);
                    return getComputedStyle(card).fontSize;
                }));
                const inheritedInk = await page.evaluate(() => {
                    const elements = [...document.querySelectorAll('#tracker-captures small, #tracker-captures i')]
                        .filter(element => element.style.color === 'inherit');
                    return {
                        count: elements.length,
                        mismatches: elements.filter(element => getComputedStyle(element).color !== getComputedStyle(element.parentElement).color)
                            .map(element => element.outerHTML),
                        weather: getComputedStyle(document.querySelector('[data-capture="position"] small')).color,
                        positionInk: getComputedStyle(document.querySelector('[data-capture="position"] .mes_text > div')).color,
                    };
                });
                appearanceChecks.push({ fontSizes, inheritedInk });
            }
            expect(appearanceChecks.map(check => check.fontSizes)).toEqual(Array(3).fill(appearanceChecks[0].fontSizes));
            for (const { inheritedInk } of appearanceChecks.slice(1)) {
                expect(inheritedInk.count).toBeGreaterThan(10);
                expect(inheritedInk.mismatches).toEqual([]);
                expect(inheritedInk.weather).toBe(inheritedInk.positionInk);
            }
            const measurements = await page.evaluate(() => {
                const root = document.querySelector('[data-capture="visual-map"]');
                const here = root.querySelector('[data-vm-d="here"]');
                const east = root.querySelector('[data-vm-d="east"]');
                const vitals = document.querySelector('[data-capture="vitals"]');
                return {
                    here: here && { x: here.getBoundingClientRect().x, y: here.getBoundingClientRect().y },
                    east: east && { x: east.getBoundingClientRect().x, y: east.getBoundingClientRect().y },
                    fills: [...vitals.querySelectorAll('[style*="width:"]')].map(element => ({ style: element.getAttribute('style'), width: getComputedStyle(element).width })),
                };
            });
            expect(measurements.here).not.toBeNull();
            expect(measurements.east).not.toBeNull();
            expect(measurements.east.x).toBeGreaterThan(measurements.here.x);
            for (const width of [23, 41, 57, 78, 90]) {
                expect(measurements.fills.some(fill => fill.style.includes(`width:${width}%`) && parseFloat(fill.width) > 0)).toBe(true);
            }
            const mapStyles = () => page.evaluate(() => {
                const root = document.querySelector('[data-capture="visual-map"]');
                return [...root.querySelectorAll('[data-vm-d]')].map(element => {
                    const style = getComputedStyle(element);
                    return { column: style.gridColumnStart, background: style.backgroundColor, shadow: style.boxShadow };
                });
            });
            const firstMap = await mapStyles();
            expect(firstMap.map(place => place.column)).toEqual(['2', '3']);
            await page.evaluate(async () => {
                const base = '/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/';
                const { mountPreview } = await import(`${base}preview.js`);
                const { getTheme } = await import(`${base}themes/index.js`);
                const host = document.createElement('section');
                document.querySelector('#tracker-captures').append(host);
                mountPreview(host, 'visual-map', getTheme('obsidian-ink'));
            });
            expect(await mapStyles()).toEqual(firstMap);

            // Exercise the additional selectors used by the real chat, including Tide's
            // phone rules, rather than relying on the gallery wrapper alone.
            await page.evaluate(async () => {
                const base = '/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/';
                const { mountPreview } = await import(`${base}preview.js`);
                const { getTheme } = await import(`${base}themes/index.js`);
                document.querySelector('#chat').id = 'original-chat-for-capture';
                document.body.classList.remove('documentstyle', 'echostyle', 'whisperstyle', 'hushstyle', 'ripplestyle');
                document.body.classList.add('tidestyle');
                const chat = document.createElement('div');
                chat.id = 'chat';
                chat.style.cssText = 'display:block;position:relative;width:100%;height:auto;max-height:none;overflow:visible';
                document.querySelector('#tracker-captures').append(chat);
                for (const [archetype, slug] of [['position', 'delft-porcelain'], ['visual-map', 'obsidian-ink'], ['vitals', 'delft-porcelain']]) {
                    const message = document.createElement('div');
                    message.className = 'mes';
                    message.dataset.chatCapture = archetype;
                    const block = document.createElement('div');
                    block.className = 'mes_block';
                    message.append(block);
                    chat.append(message);
                    mountPreview(block, archetype, getTheme(slug));
                }
            });
            for (const [archetype, value] of [['position', 'Rain easing'], ['visual-map', 'Docks'], ['vitals', 'Bruised ribs']]) {
                const message = page.locator(`#chat [data-chat-capture="${archetype}"]`);
                await expect(message).toContainText(value);
                await expect(message.locator('[data-rat]').first()).toBeVisible();
            }
            const chatDetails = await page.evaluate(() => {
                const chat = document.querySelector('#chat');
                const weather = chat.querySelector('[data-chat-capture="position"] small');
                const mapHere = chat.querySelector('[data-chat-capture="visual-map"] [data-vm-d="here"]');
                const mapEast = chat.querySelector('[data-chat-capture="visual-map"] [data-vm-d="east"]');
                return {
                    weather: getComputedStyle(weather).color,
                    weatherParent: getComputedStyle(weather.parentElement).color,
                    hereColumn: getComputedStyle(mapHere).gridColumnStart,
                    eastColumn: getComputedStyle(mapEast).gridColumnStart,
                };
            });
            expect(chatDetails.weather).toBe(chatDetails.weatherParent);
            expect(chatDetails.hereColumn).toBe('2');
            expect(chatDetails.eastColumn).toBe('3');
        } finally {
            await context.close();
        }
    });
}
