/* global document, window, NeconyanShell, jQuery, getComputedStyle */
import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { contrastRatio } from '../public/scripts/theme-contrast.js';
import { acknowledgeSettingsSave } from './chat-scroll-regression-helpers.js';

const shellSource = await readFile(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8');
const shells = [...shellSource.match(/const NN_THEMES = Object\.freeze\(\[([\s\S]*?)\]\);/)[1].matchAll(/id:\s*'([^']+)'/g)].map(match => match[1]);

async function colours(locator) {
    return locator.evaluate(element => {
        const style = getComputedStyle(element);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        const rgb = colour => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = colour;
            context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data];
        };
        const composite = (over, under) => over.slice(0, 3).map((channel, i) => Math.round(channel * over[3] / 255 + under[i] * (1 - over[3] / 255)));
        const format = channels => `rgb(${channels.slice(0, 3).join(', ')})`;
        let backdrop = [255, 255, 255];
        const ancestors = [];
        for (let parent = element.parentElement; parent; parent = parent.parentElement) ancestors.unshift(parent);
        for (const parent of ancestors) backdrop = composite(rgb(getComputedStyle(parent).backgroundColor), backdrop);
        const base = composite(rgb(style.backgroundColor), backdrop);
        const brightness = Number(style.filter.match(/brightness\(([\d.]+)\)/)?.[1] || 1);
        const filtered = channels => format(channels.map(channel => Math.min(255, Math.round(channel * brightness))));
        // A padding-box fill covers the lower border-only gradient behind the label.
        const image = style.backgroundClip === 'padding-box, border-box'
            ? style.backgroundImage.split(/, (?=linear-gradient)/)[0] : style.backgroundImage;
        const stops = image.match(/(?:rgba?|color)\([^)]+\)/g) || [];
        return {
            background: style.backgroundColor, image: style.backgroundImage,
            ink: filtered(rgb(style.color)),
            stops: stops.length ? stops.map(stop => filtered(composite(rgb(stop), base))) : [filtered(base)],
            children: [...element.querySelectorAll('i, span')].map(child => filtered(rgb(getComputedStyle(child).color))),
            filter: style.filter,
            shadow: style.boxShadow,
            outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
        };
    });
}

for (const phone of [false, true]) {
    test(`accent button pairs across every shell on ${phone ? 'phone' : 'desktop'}`, async ({ browser }, info) => {
        test.setTimeout(240000);
        const context = await browser.newContext({
            baseURL: info.project.use.baseURL,
            viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 },
            hasTouch: phone, isMobile: phone, serviceWorkers: 'block', reducedMotion: 'reduce',
        });
        const findings = [];
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
            await page.route('**/api/settings/save', acknowledgeSettingsSave);
            await page.goto('/');
            await page.waitForFunction(() => window.NeconyanShell && document.querySelector('.neconyan-home') && !document.querySelector('#preloader'));
            // Measure settled colours, not intermediate transition frames between shells.
            await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
            for (const shell of shells.filter(shell => shell !== 'calico')) await page.addStyleTag({ url: `/css/shell-styles/${shell}.css` });
            await page.addStyleTag({ url: '/css/neconyan-kittyless.css' });
            await page.evaluate(() => {
                NeconyanShell.openTab('left', 'api');
                for (const [id, classes] of [['primary', 'menu_button_primary'], ['confirm', 'popup-button-ok'], ['secondary', '']]) {
                    const probe = document.createElement('button');
                    probe.id = `accent-${id}-reference`;
                    probe.className = `menu_button menu_button_icon ${classes}`;
                    probe.innerHTML = '<i class="fa-solid fa-check"></i><span>Button audit</span>';
                    document.querySelector('#api_button_openai').parentElement.append(probe);
                }
            });
            const primary = page.locator('#accent-primary-reference');
            const confirm = page.locator('#accent-confirm-reference');
            const secondary = page.locator('#accent-secondary-reference');
            const connect = page.locator('#api_button_openai');
            const check = async (locator, label) => {
                const value = await colours(locator);
                const minimum = Math.min(...value.stops.map(stop => contrastRatio(value.ink, stop)));
                if (minimum < 4.5 || value.children.some(ink => ink !== value.ink)) findings.push({ label, minimum, ...value });
                return value;
            };
            for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
                for (const profile of [null, 'Mint Glass', 'Plum Wine']) {
                    await page.evaluate(name => jQuery('#themes').val(name).trigger('change'), theme);
                    await expect(page.locator('#themes')).toHaveValue(theme);
                    if (profile) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${profile} accent profile"]`).evaluate(el => el.click());
                    for (const shell of shells) {
                        await page.evaluate(shell => {
                            document.documentElement.dataset.sbTheme = shell;
                            if (shell === 'kittyless') document.documentElement.dataset.sbKittyless = 'true';
                            else delete document.documentElement.dataset.sbKittyless;
                        }, shell);
                        const label = `${theme}/${profile || 'default'}/${shell}`;
                        await page.mouse.move(0, 0);
                        const normal = await check(primary, `${label}/primary`);
                        await check(confirm, `${label}/confirmation`);
                        const neutral = await check(secondary, `${label}/secondary`);
                        const actual = await check(connect, `${label}/Connect`);
                        if (actual.background !== normal.background || actual.image !== normal.image || actual.ink !== normal.ink) findings.push({ label: `${label}/Connect pair differs from primary`, actual, normal });
                        if (!phone) {
                            await primary.hover();
                            const hovered = await check(primary, `${label}/hover`);
                            if (hovered.shadow === normal.shadow && hovered.filter === normal.filter && hovered.background === normal.background) findings.push({ label: `${label}/primary hover looks the same as rest`, minimum: null });
                            await primary.focus();
                            await page.keyboard.press('Shift');
                            await check(primary, `${label}/focus`);
                            await page.mouse.move(0, 0);
                            await secondary.hover();
                            await check(secondary, `${label}/secondary hover`);
                            await page.mouse.move(0, 0);
                        }
                        await primary.evaluate(el => el.setAttribute('aria-pressed', 'true'));
                        await check(primary, `${label}/selected`);
                        await primary.evaluate(el => el.removeAttribute('aria-pressed'));
                        await secondary.evaluate(el => el.setAttribute('aria-pressed', 'true'));
                        const selected = await check(secondary, `${label}/secondary selected`);
                        expect(selected.outline, `${label}: selection keeps an accent indicator`).not.toBe(neutral.outline);
                        await secondary.evaluate(el => el.removeAttribute('aria-pressed'));
                        await primary.evaluate(el => el.classList.add('active'));
                        await check(primary, `${label}/active`);
                        await primary.evaluate(el => el.classList.remove('active'));
                        for (const [backend, id] of [['kobold', 'api_button'], ['novel', 'api_button_novel'], ['textgenerationwebui', 'api_button_textgenerationwebui'], ['openai', 'api_button_openai']]) {
                            await page.locator('#main_api').selectOption(backend);
                            await expect(page.locator(`#${id}`)).toBeVisible();
                            await check(page.locator(`#${id}`), `${label}/${backend} Connect`);
                        }
                        await primary.evaluate(el => { el.blur(); });
                    }
                }
            }
            await info.attach('accent-audit', { body: JSON.stringify(findings, null, 2), contentType: 'application/json' });
            await writeFile(info.outputPath('accent-audit.json'), JSON.stringify(findings, null, 2));
            expect(findings.map(({ label, minimum }) => ({ label, minimum })), 'button fills, labels and icons keep their contrast-aware pair').toEqual([]);
        } finally {
            await context.close();
        }
    });
}
