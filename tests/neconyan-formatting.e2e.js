/* global window, document, getComputedStyle */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect as baseExpect, test } from '@playwright/test';

const expect = baseExpect.configure({ timeout: 20000 });

test.describe.configure({ mode: 'serial' });
test.setTimeout(180000);

async function openFormatting(page, backend = 'textgenerationwebui') {
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 90000 });
    const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
    if (await skip.isVisible()) await skip.click();
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
    await page.locator('#main_api').selectOption(backend);
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'advanced-formatting'));
    await expect(page.locator('#left-nav-panel .sb-shell-header .neconyan-tool-tour-button')).toBeVisible();
    const later = page.getByRole('button', { name: 'Not now', exact: true });
    if (await later.isVisible()) await later.click();
}

async function expand(page, id) {
    const header = page.locator(`#${id} > .inline-drawer-header`);
    if (await header.getAttribute('aria-expanded') !== 'true') await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(`#${id}-content`)).toBeVisible();
    return header;
}

for (const phone of [true, false]) {
    for (const dark of [true, false]) {
        test(`${phone ? 'phone' : 'desktop'} ${dark ? 'dark' : 'light'}: formatting groups, keyboard, saving and accents`, async ({ browser }, info) => {
            const context = await browser.newContext({
                baseURL: info.project.use.baseURL,
                viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 },
                isMobile: phone, hasTouch: phone, reducedMotion: 'reduce', serviceWorkers: 'block',
            });
            try {
                const page = await context.newPage();
                let savedSettings;
                await page.route('**/api/settings/get', async route => {
                    const response = await route.fetch();
                    const envelope = await response.json();
                    if (typeof envelope.settings !== 'string') return route.fulfill({ json: envelope });
                    const settings = savedSettings ?? JSON.parse(envelope.settings);
                    const theme = JSON.parse(readFileSync(new URL(`../default/content/themes/Neconyan Calico${dark ? ' Dark' : ''}.json`, import.meta.url), 'utf8'));
                    settings.power_user = { ...settings.power_user, ...theme, theme: theme.name, google_font: '' };
                    settings.firstRun = false;
                    settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
                    await route.fulfill({ json: { ...envelope, settings: JSON.stringify(settings) } });
                });
                await page.route('**/api/settings/save', async route => {
                    let bytes = route.request().postDataBuffer();
                    if (route.request().headers()['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
                    const payload = JSON.parse(bytes.toString());
                    savedSettings = { ...payload, _version: Math.max(Date.now(), Number(payload._version || 0) + 1), _settingsRevision: Number(payload._settingsRevision || 0) + 1 };
                    await route.fulfill({ json: { result: 'ok', version: savedSettings._version, settingsRevision: savedSettings._settingsRevision } });
                });
                // Isolate settings writes while exercising the real input handlers and reload path.
                await page.goto('/', { waitUntil: 'domcontentloaded' });
                await openFormatting(page);
                const drawers = page.locator('#AdvancedFormatting .sb-af-settings-drawer:visible');
                await expect(drawers).toHaveCount(5);
                const insets = await drawers.evaluateAll(nodes => nodes.map(drawer => {
                    const header = drawer.querySelector(':scope > .inline-drawer-header');
                    return header.getBoundingClientRect().right - header.querySelector('.inline-drawer-icon').getBoundingClientRect().right;
                }));
                expect(Math.min(...insets), 'chevrons sit inside the panel, clear of the right edge').toBeGreaterThanOrEqual(16);
                await expect(page.locator('#sb-af-reasoning #reasoning_auto_parse')).toHaveCount(1);
                await expect(page.locator('#sb-af-replies #custom_stopping_strings')).toHaveCount(1);
                await expect(page.locator('#sb-af-sysprompt #reasoning_auto_parse')).toHaveCount(0);

                const header = await expand(page, 'sb-af-sysprompt');
                await header.focus();
                await page.keyboard.press('Space');
                await expect(header).toHaveAttribute('aria-expanded', 'false');
                await page.keyboard.press('Enter');
                await expect(header).toHaveAttribute('aria-expanded', 'true');
                await expect(page.locator('#sysprompt_content')).toBeVisible();
                await expect(header.locator('.inline-drawer-icon')).toHaveAttribute('tabindex', '-1');

                // Selecting a template still reaches its original editor and export action.
                const presets = page.locator('#sysprompt_select');
                const options = await presets.locator('option').evaluateAll(nodes => nodes.map(node => node.value));
                expect(options.length).toBeGreaterThan(1);
                const current = await presets.inputValue();
                await presets.selectOption(options.find(value => value !== current));
                await expect(page.locator('#sysprompt_content')).not.toHaveValue('');
                const download = page.waitForEvent('download');
                await page.locator('[data-preset-manager-export="sysprompt"]').click();
                expect((await download).suggestedFilename()).toMatch(/\.json$/);

                for (const accent of [null, 'Pearl', 'Midnight Ink']) {
                    if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(el => el.click());
                    const save = page.locator('[data-preset-manager-update="sysprompt"]');
                    await save.scrollIntoViewIfNeeded();
                    for (const hover of [false, true]) {
                        if (hover) await save.hover();
                        else await header.hover();
                        const result = await save.evaluate(async element => {
                            const { contrastRatio } = await import('/scripts/theme-contrast.js');
                            const canvas = document.createElement('canvas');
                            const ctx = canvas.getContext('2d');
                            const channels = colour => {
                                ctx.fillStyle = colour;
                                ctx.fillRect(0, 0, 1, 1);
                                return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
                            };
                            const style = getComputedStyle(element);
                            return contrastRatio(channels(style.color), channels(style.backgroundColor));
                        });
                        expect(result, `${accent ?? 'default'} accent, hover=${hover}`).toBeGreaterThanOrEqual(4.5);
                    }
                }

                for (const id of ['sb-af-context', 'sb-af-instruct', 'sb-af-sysprompt', 'sb-af-reasoning', 'sb-af-replies']) {
                    await expand(page, id);
                    const bad = await page.locator(`#${id}`).evaluate(drawer => [...drawer.querySelectorAll('.sb-af-preset-action, select, textarea')]
                        .filter(el => el.checkVisibility()).flatMap(el => {
                            const box = el.getBoundingClientRect();
                            const bounds = drawer.getBoundingClientRect();
                            return box.left < bounds.left - 1 || box.right > bounds.right + 1 || (el.classList.contains('sb-af-preset-action') && box.height < 44)
                                ? [{ id: el.id, text: el.textContent, width: box.width, height: box.height }] : [];
                        }));
                    expect(bad, `${id} fits and actions have full touch targets`).toEqual([]);
                }

                await expand(page, 'sb-af-reasoning');
                const reasoning = page.locator('#reasoning_auto_expand');
                const checked = await reasoning.isChecked();
                await reasoning.setChecked(!checked);
                await expand(page, 'sb-af-replies');
                await page.locator('#start_reply_with').fill('Formatting persistence check');
                await expect.poll(() => savedSettings?.power_user?.user_prompt_bias).toBe('Formatting persistence check');
                await page.reload({ waitUntil: 'domcontentloaded' });
                await openFormatting(page, 'openai');
                await expect(drawers).toHaveCount(3);
                await expect(page.locator('#sb-af-sysprompt')).toBeHidden();
                await expect(page.locator('#sb-af-instruct')).toBeHidden();
                await expand(page, 'sb-af-context');
                await expect(page.locator('#trim_spaces')).toBeVisible();
                await expand(page, 'sb-af-reasoning');
                await expect(reasoning).toBeChecked({ checked: !checked });
                await expand(page, 'sb-af-replies');
                await expect(page.locator('#start_reply_with')).toHaveValue('Formatting persistence check');
                await expect(page.locator('#custom_stopping_strings')).toBeVisible();
                await expect(page.locator('#tokenizer')).toBeHidden();
            } finally {
                await context.close();
            }
        });
    }
}
