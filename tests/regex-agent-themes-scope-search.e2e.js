/* global document, window, requestAnimationFrame, CompositionEvent */
import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { acknowledgeSettingsSave } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';
import { TEMPLATE_LABELS } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/template-catalog.js';

const extension = '/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/';
const templates = new URL('../public/scripts/extensions/in-chat-agents/templates/', import.meta.url);
const bundles = JSON.parse(await readFile(new URL('regex-bundles.json', templates), 'utf8'));
const agents = await Promise.all(Object.entries(TEMPLATE_LABELS).map(async ([id, name]) => ({
    id: `search-${id}`, name, sourceTemplateId: id, version: 5, phaseLocked: false,
    regexScripts: bundles[id] ?? JSON.parse(await readFile(new URL(`${id.slice(4)}.json`, templates), 'utf8')).regexScripts,
})));
agents.push({ ...agents.find(agent => agent.sourceTemplateId === 'tpl-relationship-tracker'), id: 'search-duplicate', name: 'Moonlight bonds' });

for (const phone of [true, false]) {
    const device = phone ? 'phone' : 'desktop';
    const minimumInputHeight = phone ? 44 : 32;
    test.describe(`tracker override search on ${device}`, () => {
        test.describe.configure({ mode: 'serial' });
        let context;
        let page;

        test.beforeAll(async ({ browser }, info) => {
            context = await browser.newContext({
                baseURL: info.project.use.baseURL,
                ...(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } }),
                serviceWorkers: 'block', reducedMotion: 'reduce',
            });
            if (phone) await installIPhoneSafari(context, { standalone: true });
            page = await context.newPage();
            page.on('pageerror', error => console.error(error.message));
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
        });

        test.beforeAll(async () => {
            // Use real bundled scripts and the real UI, with a disposable in-memory
            // store so typing can be checked for accidental reads and writes.
            await page.evaluate(async ({ extension, agents }) => {
                // The UI fixture owns refreshes. Detach the real account's startup
                // reconciliation and settings listeners before replacing its store.
                // Use the loader's versioned URL, not a second instance of the entry point.
                const entry = new URL('../index.js', new URL(extension, document.baseURI)).pathname;
                const loaded = [...document.scripts].find(script => script.src && new URL(script.src).pathname === entry);
                if (!loaded) throw new Error('Regex Agent Themes entry script was not loaded');
                (await import(loaded.src)).deactivate();
                const host = await import(`${extension}host.js`);
                const scripts = await import('/scripts/extensions/in-chat-agents/regex-scripts.js');
                const fixture = window.ratScopeFixture = { agents, reads: 0, saves: 0 };
                host.__setHostForTests({ ok: true, scripts, store: {
                    getAgents: () => { fixture.reads++; return fixture.agents; },
                    saveAgent: async agent => {
                        fixture.saves++;
                        fixture.agents = fixture.agents.map(current => current.id === agent.id ? agent : current);
                    },
                } });
                window.ratScopeRefresh = (await import(`${extension}ui.js`)).mountSettings();
            }, { extension, agents });
            await page.evaluate(() => window.NeconyanShell.openIncludedTool('third-party/Neconyan-Regex-Agent-Themes'));
            await page.locator('#rat_toggle_scope').click();
            if (phone) await applyIOSOnlyCss(page);
        });

        test.afterAll(async () => { await context?.close(); });

        test('filters without rebuilding controls or saving settings', async ({}, info) => {
            const search = page.locator('#rat_scope_search');
            const cards = page.locator('#rat_scope_list .rat-scope-card');
            const visible = page.locator('#rat_scope_list .rat-scope-card:visible');
            const status = page.locator('#rat_section_scope [role="status"]');
            const total = Object.keys(TEMPLATE_LABELS).length;
            await expect(search).toHaveAccessibleName('Search tracker overrides');
            await expect(visible).toHaveCount(total);
            expect(await cards.locator('option').count()).toBeGreaterThan(4000);
            await expect(status).toHaveText(`Trackers shown: ${total} of ${total}`);
            const details = page.locator('[aria-labelledby="rat_scope_title_tpl-relationship-tracker"] details');
            await details.locator('summary').click();
            await expect(details).toHaveAttribute('open', '');
            await page.evaluate(() => {
                window.ratScopeOriginal = {
                    input: document.querySelector('#rat_scope_search'),
                    cards: [...document.querySelectorAll('#rat_scope_list .rat-scope-card')],
                    selects: [...document.querySelectorAll('#rat_scope_list select')],
                    reads: window.ratScopeFixture.reads,
                    saves: window.ratScopeFixture.saves,
                };
            });

            for (const [query, heading] of [
                ['rELAtionship', 'Relationship Tracker'],
                ['Moonlight bonds', 'Relationship Tracker'],
                ['  CHECKS   choices  ', 'CYOA Choices with Skill Checks'],
                ['tpl-four-winds', 'The Four Winds'],
            ]) {
                await search.fill(query);
                await expect(visible).toHaveCount(1);
                await expect(visible.locator('h4')).toHaveText(heading);
                await expect(search).toBeFocused();
            }
            await search.fill('.*[no matching tracker]');
            await expect(visible).toHaveCount(0);
            await expect(page.getByText('No matching trackers', { exact: true })).toBeVisible();
            await expect(status).toHaveText(`Trackers shown: 0 of ${total}`);
            await search.fill('');
            await expect(search).toHaveValue('');
            await expect(visible).toHaveCount(total);
            await search.fill('   ');
            await expect(visible).toHaveCount(total);
            await expect(page.getByText('No matching trackers', { exact: true })).toBeHidden();
            expect(await page.evaluate(() => {
                const original = window.ratScopeOriginal;
                return {
                    input: original.input === document.querySelector('#rat_scope_search'),
                    cards: original.cards.every((card, i) => card === document.querySelectorAll('#rat_scope_list .rat-scope-card')[i]),
                    selects: original.selects.every((select, i) => select === document.querySelectorAll('#rat_scope_list select')[i]),
                    reads: window.ratScopeFixture.reads - original.reads,
                    saves: window.ratScopeFixture.saves - original.saves,
                };
            })).toEqual({ input: true, cards: true, selects: true, reads: 0, saves: 0 });
            await expect(details).toHaveAttribute('open', '');

            // Measure each handler separately while typing, with the full option list
            // mounted. Presentation samples include the following layout and paint.
            await search.fill('');
            await page.evaluate(() => {
                const input = document.querySelector('#rat_scope_search');
                window.ratScopeTiming = { handlers: [], presentations: [] };
                let started;
                input.addEventListener('input', () => { started = performance.now(); }, { capture: true });
                input.addEventListener('input', () => {
                    window.ratScopeTiming.handlers.push(performance.now() - started);
                    const start = started;
                    requestAnimationFrame(() => {
                        const channel = new MessageChannel();
                        channel.port1.onmessage = () => {
                            window.ratScopeTiming.presentations.push(performance.now() - start);
                            channel.port1.close();
                            channel.port2.close();
                        };
                        channel.port2.postMessage(null);
                    });
                });
            });
            await search.pressSequentially('relationship', { delay: 25 });
            await expect(visible).toHaveCount(1);
            await expect.poll(() => page.evaluate(() => window.ratScopeTiming.presentations.length)).toBe('relationship'.length);
            const timing = await page.evaluate(() => window.ratScopeTiming);
            expect(Math.max(...timing.handlers)).toBeLessThan(50);
            const timingPath = info.outputPath('tracker-search-timings.json');
            await writeFile(timingPath, JSON.stringify(timing, null, 2));
            await info.attach('tracker search input timings', { path: timingPath, contentType: 'application/json' });
        });

        test('keeps the query and focus through refreshes and applies complete overrides', async ({}, info) => {
            const search = page.locator('#rat_scope_search');
            const visible = page.locator('#rat_scope_list .rat-scope-card:visible');
            // A refresh while text is being composed must keep the same input,
            // focus, selection and query, and reapply the current filter.
            await search.evaluate(input => {
                input.setSelectionRange(2, 5);
                input.dispatchEvent(new CompositionEvent('compositionstart', { data: 'relation', bubbles: true }));
                window.ratScopeFixture.agents.push({ ...window.ratScopeFixture.agents[0], id: 'another-copy', name: 'Relationship notes' });
                window.ratScopeRefresh();
            });
            await expect(visible).toHaveCount(2);
            expect(await search.evaluate(input => input === window.ratScopeOriginal.input)).toBe(true);
            await expect(search).toBeFocused();
            expect(await search.evaluate(input => [input.selectionStart, input.selectionEnd])).toEqual([2, 5]);
            await search.evaluate(input => input.dispatchEvent(new CompositionEvent('compositionend', { data: 'relationship', bubbles: true })));
            await page.locator('#rat_toggle_scope').click();
            await page.locator('#rat_toggle_scope').click();
            await expect(search).toHaveValue('relationship');
            await expect(visible).toHaveCount(2);

            // Filtering is independent from Browse themes, and the override still
            // applies to every duplicate rather than only the matching agent name.
            await search.fill('Moonlight');
            const theme = await visible.locator('select option').evaluateAll(options => options.find(option => option.value && option.value !== 'stock').value);
            await visible.locator('select').selectOption(theme);
            await expect(search).toBeEnabled();
            await expect.poll(() => page.evaluate(() => window.ratScopeFixture.saves)).toBe(2);
            await expect(search).toHaveValue('Moonlight');
            await expect(visible).toHaveCount(1);
            await expect(visible.locator('select')).toHaveValue(theme);
            await page.locator('#rat_toggle_browse').click();
            await page.locator('#rat_theme_search').fill('rain');
            await expect(search).toHaveValue('Moonlight');
            await expect(visible).toHaveCount(1);
            await page.locator('#rat_toggle_browse').click();

            await search.fill('Moonlight');
            await page.evaluate(() => {
                document.activeElement.blur();
                document.querySelector('#rat_toggle_scope').scrollIntoView({ block: 'start', behavior: 'instant' });
                window.toastr.clear();
            });
            const geometry = await search.evaluate(input => {
                const rect = input.getBoundingClientRect();
                return { height: rect.height, contained: rect.left >= 0 && rect.right <= window.innerWidth, width: rect.width, overflow: input.closest('#rat_drawer').scrollWidth > input.closest('#rat_drawer').clientWidth + 1 };
            });
            expect(geometry.contained).toBe(true);
            expect(geometry.overflow).toBe(false);
            expect(geometry.height).toBeGreaterThanOrEqual(minimumInputHeight);
            const directory = new URL('../screenshots/', import.meta.url);
            await mkdir(directory, { recursive: true });
            const screenshot = new URL(`tracker-overrides-search-${device}-after.png`, directory).pathname;
            await page.screenshot({ path: screenshot });
            await info.attach('filtered tracker overrides', { path: screenshot, contentType: 'image/png' });
        });
    });
}
