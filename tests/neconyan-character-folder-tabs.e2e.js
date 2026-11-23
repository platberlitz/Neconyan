/* global document, getComputedStyle, window */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { contrastRatio } from '../public/scripts/theme-contrast.js';
import { acknowledgeSettingsSave, dismissOnboardingIfPresent, settleCssTransitions } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

async function openCharacters(page, phone, { showToasts = false, onboarded = false } = {}) {
    if (!onboarded) await page.addLocatorHandler(page.locator('#qig-setup-wizard'), wizard => wizard.getByRole('button', { name: 'Skip', exact: true }).click());
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    if (!onboarded) await dismissOnboardingIfPresent(page);
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 120000 });
    if (!onboarded) {
        const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
        if (await skip.isVisible()) await skip.click();
    }
    await page.evaluate(() => window.NeconyanShell.openTab('characters', 'characters'));
    if (!onboarded) {
        const later = page.locator('#rm_characters_block .neconyan-tool-tour-invite button').filter({ hasText: 'Not now' });
        if (await later.isVisible()) await later.click();
    }
    if (phone) await applyIOSOnlyCss(page);
    await page.addStyleTag({ content: `${showToasts ? '' : '#toast-container, '}#nn-update-toast { display: none !important; }` });
    await expect(page.locator('#neconyan-folder-tabs')).toBeVisible({ timeout: 30000 });
}

const screenshotDir = process.env.NECONYAN_AI_SORT_SCREENSHOTS;
const baselineDir = process.env.NECONYAN_AI_SORT_BASELINE;

async function screenshot(page, name, focus) {
    if (!screenshotDir) return;
    await mkdir(screenshotDir, { recursive: true });
    await focus.evaluate(node => node.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), animations: 'disabled' });
}

async function aiFixture(browser, testInfo, phone, { batchSize, baseline = false, count = 64 }) {
    const context = await browser.newContext({
        ...(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } }),
        baseURL: testInfo.project.use.baseURL, reducedMotion: 'reduce', serviceWorkers: 'block',
    });
    try {
        if (phone) await installIPhoneSafari(context, { standalone: false });
        if (baseline) {
            for (const asset of ['scripts/neconyan-character-folders.js', 'scripts/neconyan-character-folders-policy.js', 'css/neconyan-character-folders.css']) {
                const body = await readFile(path.join(baselineDir, 'public', asset));
                await context.route(url => url.pathname === `/${asset}`, route => route.fulfill({
                    body, contentType: asset.endsWith('.css') ? 'text/css' : 'text/javascript',
                }));
            }
        }
        const page = await context.newPage();
        await page.route('**/api/settings/get', async route => {
            const request = route.request().postDataJSON();
            if (request?.settingsOnly || request?.extensionSettings || (request?.sections && !request.sections.includes('settings'))) return route.continue();
            const response = await route.fetch();
            const data = await response.json();
            if (typeof data.settings !== 'string') return route.fulfill({ response, json: data });
            const defaults = await readFile(new URL('../default/content/settings.json', import.meta.url), 'utf8');
            const settings = { ...JSON.parse(defaults), ...JSON.parse(data.settings) };
            settings.firstRun = false;
            settings.main_api = 'openai';
            settings.oai_settings = { ...settings.oai_settings, chat_completion_source: 'custom', custom_model: 'gemini-4-neon' };
            settings.power_user.character_folder_sort = { ai: { batchSize } };
            settings.power_user.theme = 'Neconyan Calico';
            settings.accountStorage = {
                ...settings.accountStorage,
                'NeconyanTutorialStatus.v1': 'skipped',
                'neconyanToolTourInvite.character-library': 'seen',
                WelcomePage_PanelMode: 'full',
            };
            // The sorter is built into Characters and doesn't need extensions.
            await route.fulfill({ response, json: { ...data, enable_extensions: false, settings: JSON.stringify(settings) } });
        });
        const saves = [];
        let conflict = false;
        await page.route('**/api/settings/save', route => {
            const body = route.request().postDataJSON();
            saves.push(body);
            if (conflict) return route.fulfill({ status: 409, json: { error: 'settings_conflict', version: body._version + 1, settingsRevision: body._settingsRevision + 1 } });
            return acknowledgeSettingsSave(route);
        });
        await test.step('Boot Characters in a fresh browser context', () => openCharacters(page, phone, { showToasts: !baseline, onboarded: true }));
        await page.evaluate(async count => {
            const script = await import('/script.js');
            const { tag_map, tags } = await import('/scripts/tags.js');
            tags.push({ id: 'ai-sort-existing', name: 'Coastal Towns', folder_type: 'OPEN' });
            script.characters.splice(0, script.characters.length, ...Array.from({ length: count }, (_, index) => ({
                avatar: `ai-sort-fixture-${index}.png`, name: `Character ${String(index + 1).padStart(2, '0')}`,
                description: 'Travels between the coast and the observatory.', tags: ['explorer'],
            })));
            tag_map[script.characters.at(-1).avatar] = ['ai-sort-existing'];
            script.setOnlineStatus('gemini-4-neon');
            await script.saveSettings(0, { returnResult: true });
            document.querySelectorAll('#toast-container .toast').forEach(toast => toast.remove());
        }, count);
        await page.locator('#neconyan-folder-tabs .neconyan-folder-tabs-organise').click();
        const organiser = page.locator('.neconyan-folder-organiser');
        await expect(organiser.locator('h3')).toHaveText('Organise folders');
        return { context, page, organiser, saves, rejectNextSave: () => { conflict = true; } };
    } catch (error) {
        await context.close().catch(() => {});
        throw error;
    }
}

function rejectStaleAcknowledgement(route) {
    return route.fulfill({ status: 409, json: { error: 'The active connection settings are not acknowledged. Save them before generating a reply.',
        code: 'active_settings_ack_required', notAccepted: true } });
}

function completeBatch(route, assignments) {
    return completeBatchWithText(route, JSON.stringify({ assignments }));
}

function completeBatchWithText(route, text) {
    const { key, kind } = route.request().postDataJSON();
    return route.fulfill({ status: 202, json: { record: { key, kind, state: 'completed', result: { text } } } });
}

async function checkButtonAccents(page, buttons) {
    let previousFills;
    for (const rgba of [null, 'rgba(110,231,183,1)', 'rgba(126,34,206,1)']) {
        if (rgba) await page.locator('#sb-accent-primary-picker').evaluate((picker, rgba) => picker.dispatchEvent(new CustomEvent('change', { detail: { rgba } })), rgba);
        await settleCssTransitions(page);
        const samples = await buttons.evaluateAll(nodes => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const ctx = canvas.getContext('2d');
            const rgb = colour => {
                ctx.clearRect(0, 0, 1, 1);
                ctx.fillStyle = colour;
                ctx.fillRect(0, 0, 1, 1);
                return `rgb(${[...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).join(', ')})`;
            };
            return nodes.map(node => {
                const style = getComputedStyle(node);
                const fill = style.backgroundClip === 'padding-box, border-box'
                    ? style.backgroundImage.split(/, (?=linear-gradient)/)[0] : style.backgroundImage;
                return {
                    ink: rgb(style.color), backgrounds: (fill.match(/(?:rgba?|color)\([^)]+\)/g) ?? [style.backgroundColor]).map(rgb),
                    height: node.getBoundingClientRect().height,
                };
            });
        });
        expect(samples).toHaveLength(2);
        const fills = samples.map(sample => sample.backgrounds);
        if (previousFills) expect(fills).not.toEqual(previousFills);
        previousFills = fills;
        for (const { ink, backgrounds, height } of samples) {
            expect(height).toBeGreaterThanOrEqual(44);
            for (const background of backgrounds) expect(contrastRatio(ink, background), rgba ?? 'Calico').toBeGreaterThanOrEqual(4.5);
        }
    }
}

test.describe('Sort with AI', () => {
    // Each case cold-boots the full app, like the import regressions below.
    // The readiness assertions still bound each step separately.
    test.describe.configure({ timeout: 120_000 });
    for (const phone of [true, false]) {
        const device = phone ? 'phone' : 'desktop';

        if (baselineDir && screenshotDir) test(`staging comparison: ${device}`, async ({ browser }, testInfo) => {
            const fixture = await aiFixture(browser, testInfo, phone, { batchSize: 25, baseline: true });
            try {
                await screenshot(fixture.page, `before-${device}-ai-sort`, fixture.organiser.getByText('Sort with AI', { exact: true }));
            } finally {
                await fixture.context.close();
            }
        });

        test(`retries only the refused generation with newly saved settings: ${device}`, async ({ browser }, testInfo) => {
            const { context, page, organiser, saves } = await aiFixture(browser, testInfo, phone, { batchSize: 5, count: 6 });
            try {
                const requests = [];
                await page.route('**/api/operations/submit', route => {
                    requests.push({ body: route.request().postDataJSON(), saves: saves.length });
                    if (requests.length === 1) return rejectStaleAcknowledgement(route);
                    return completeBatch(route, [{ id: 1, folder: 'Coastal Towns' }]);
                });
                await expect(organiser.getByText('Model: gemini-4-neon')).toBeVisible();
                await organiser.getByRole('button', { name: 'Suggest folders' }).click();
                await expect(organiser.getByText('1 suggestion for 1 folder')).toBeVisible();
                expect(requests).toHaveLength(2);
                expect(requests.map(request => request.body.kind)).toEqual(['raw-generation', 'raw-generation']);
                const [first, retry] = requests;
                expect(retry.saves).toBe(first.saves + 1);
                expect(retry.body.key).not.toBe(first.body.key);
                expect(retry.body.acknowledgement.settingsRevision).toBeGreaterThan(first.body.acknowledgement.settingsRevision);
                expect(retry.body.prompt).toBe(first.body.prompt);
                expect(retry.body.maxTokens).toBe(1324);
                expect(requests.map(request => request.body.reasoningEffort)).toEqual(['none', 'none']);
                await checkButtonAccents(page, organiser.getByRole('button', { name: 'Suggest folders' }).or(organiser.getByRole('button', { name: 'Apply', exact: true })));
            } finally {
                await context.close();
            }
        });

        test(`stops the first batch when another device saved settings: ${device}`, async ({ browser }, testInfo) => {
            const { context, page, organiser, rejectNextSave } = await aiFixture(browser, testInfo, phone, { batchSize: 25, count: 501 });
            try {
                let submissions = 0;
                await page.route('**/api/operations/submit', route => {
                    submissions++;
                    rejectNextSave();
                    return rejectStaleAcknowledgement(route);
                });
                await expect(organiser.getByText('500 characters in 20 batches')).toBeVisible();
                await organiser.getByRole('button', { name: 'Suggest folders' }).click();
                const conflict = page.locator('dialog[open]').filter({ hasText: 'Settings changed on another device' });
                await expect(conflict.getByRole('button', { name: 'Reload now' })).toBeVisible();
                await conflict.getByRole('button', { name: 'Keep editing' }).click();
                const message = 'Reload this page to get the settings saved on another device, then try again.';
                const status = organiser.locator('.neconyan-folder-organiser-status');
                await expect(status).toHaveText(message);
                await expect(status).toHaveAttribute('data-tone', 'error');
                await expect(page.locator('#toast-container .toast-error')).toContainText(message);
                await expect(page.getByText('The active connection settings are not acknowledged.', { exact: false })).toHaveCount(0);
                expect(submissions).toBe(1);
                if (phone) await screenshot(page, 'after-phone-ai-sort-error', status);
            } finally {
                await context.close();
            }
        });

        test(`shows the plan and can bulk-apply partial suggestions after Stop: ${device}`, async ({ browser }, testInfo) => {
            const { context, page, organiser } = await aiFixture(browser, testInfo, phone, { batchSize: 25 });
            const gate = Promise.withResolvers();
            try {
                const heading = organiser.getByRole('heading', { name: 'Sort with AI' });
                const suggest = organiser.getByRole('button', { name: 'Suggest folders' });
                const scope = organiser.getByLabel('Characters to sort');
                await expect(organiser.getByText('63 characters in 3 batches')).toBeVisible();
                await screenshot(page, `after-${device}-ai-sort`, heading);
                await scope.selectOption('all');
                await expect(organiser.getByText('64 characters in 3 batches')).toBeVisible();
                await scope.selectOption('unsorted');
                await organiser.getByLabel('Characters per request').fill('40');
                await expect(organiser.getByText('63 characters in 2 batches')).toBeVisible();
                let submissions = 0;
                await page.route('**/api/operations/submit', async route => {
                    if (++submissions === 1) return completeBatch(route, Array.from({ length: 40 }, (_, index) => ({ id: index + 1, folder: index < 32 ? 'Coastal Towns' : 'Observatories' })));
                    await gate.promise;
                    return completeBatch(route, []).catch(() => {});
                });
                await suggest.click();
                await expect(organiser.getByText('Checking batch 2 of 2 · 40 suggestions so far...')).toBeVisible();
                await expect.poll(() => submissions).toBe(2);
                await organiser.getByRole('button', { name: 'Stop', exact: true }).click();
                gate.resolve();
                await expect(organiser.getByText('40 suggestions across 2 folders')).toBeVisible();
                expect(submissions).toBe(2);
                const status = organiser.locator('.neconyan-folder-organiser-status');
                const next = 'Review and apply these suggestions, then run again with \'Only characters not in a folder yet\'.';
                await expect(status).toHaveText(`Sorting stopped. ${next}`);
                await expect(status).toHaveAttribute('data-tone', 'info');
                await expect(page.locator('#toast-container .toast-info')).toContainText(next);
                const results = organiser.locator('.neconyan-folder-organiser-results');
                await expect(results.locator('.neconyan-folder-results-summary')).toHaveText(/40 suggestions across 2 folders.*40 of 40 selected/);
                const coastal = results.getByRole('button', { name: /Coastal Towns/ });
                const check = results.getByRole('checkbox', { name: 'Select suggestions for Coastal Towns' });
                const apply = results.getByRole('button', { name: 'Apply', exact: true });
                await expect(coastal).toHaveAttribute('aria-expanded', 'false');
                await screenshot(page, `after-${device}-ai-sort-suggestions`, status);
                const bulk = await results.evaluate(root => {
                    const button = name => [...root.querySelectorAll('button')].find(node => node.textContent === name);
                    const selected = () => root.querySelectorAll('input[type="checkbox"]:checked').length;
                    button('Select none').click();
                    const none = { disabled: button('Apply').disabled, checked: selected(), text: root.textContent };
                    button('Select all').click();
                    return { none, all: { disabled: button('Apply').disabled, checked: selected(), text: root.textContent } };
                });
                expect(bulk.none).toMatchObject({ disabled: true, checked: 0, text: expect.stringContaining('0 of 40 selected') });
                expect(bulk.all).toMatchObject({ disabled: false, checked: 42, text: expect.stringContaining('40 of 40 selected') });
                await coastal.click();
                await expect(coastal).toHaveAttribute('aria-expanded', 'true');
                await results.getByRole('checkbox', { name: 'Character 01', exact: true }).uncheck();
                const group = await check.evaluate((node, selector) => {
                    const root = node.closest(selector);
                    const mixed = { indeterminate: node.indeterminate, text: root.textContent };
                    node.click();
                    const all = { checked: node.checked, text: root.textContent };
                    node.click();
                    return { mixed, all, none: { checked: node.checked, text: root.textContent } };
                }, '.neconyan-folder-organiser-results');
                expect(group.mixed).toMatchObject({ indeterminate: true, text: expect.stringContaining('39 of 40 selected') });
                expect(group.all).toMatchObject({ checked: true, text: expect.stringContaining('40 of 40 selected') });
                expect(group.none).toMatchObject({ checked: false, text: expect.stringContaining('8 of 40 selected') });
                await apply.click();
                await expect(organiser.getByText('Moved 8 characters into folders.')).toBeVisible();
                await expect(organiser.getByText('55 characters in 2 batches')).toBeVisible();
                const placements = await page.evaluate(async () => {
                    const { tags, tag_map } = await import('/scripts/tags.js');
                    const folder = tags.find(tag => tag.name === 'Observatories');
                    return { type: folder?.folder_type, assigned: Object.values(tag_map).filter(ids => ids.includes(folder?.id)).length };
                });
                expect(placements).toEqual({ type: 'OPEN', assigned: 8 });
            } finally {
                gate.resolve();
                await context.close();
            }
        });
    }

    test('stops after two consecutive unreadable replies and keeps earlier suggestions', async ({ browser }, testInfo) => {
        const { context, page, organiser } = await aiFixture(browser, testInfo, false, { batchSize: 25, count: 501 });
        try {
            let submissions = 0;
            await page.route('**/api/operations/submit', route => {
                submissions++;
                if (submissions === 2) return completeBatch(route, [{ id: 1, folder: 'Coastal Towns' }]);
                return completeBatchWithText(route, submissions === 4 ? '' : 'not JSON');
            });
            await expect(organiser.getByText('500 characters in 20 batches')).toBeVisible();
            await organiser.getByRole('button', { name: 'Suggest folders' }).click();
            const message = 'Stopped after 2 unreadable replies in a row. Try another prompt, another model or fewer characters per request.';
            const status = organiser.locator('.neconyan-folder-organiser-status');
            await expect(status).toContainText(message);
            await expect(status).toHaveAttribute('data-tone', 'error');
            await expect(page.locator('#toast-container .toast-error')).toContainText(message);
            await expect(organiser.getByText('1 suggestion for 1 folder')).toBeVisible();
            expect(submissions).toBe(4);
        } finally {
            await context.close();
        }
    });

    test('stops after two consecutive empty replies and points at the model', async ({ browser }, testInfo) => {
        const { context, page, organiser } = await aiFixture(browser, testInfo, false, { batchSize: 25, count: 501 });
        try {
            let submissions = 0;
            await page.route('**/api/operations/submit', route => {
                submissions++;
                return completeBatchWithText(route, '');
            });
            await expect(organiser.getByText('500 characters in 20 batches')).toBeVisible();
            await organiser.getByRole('button', { name: 'Suggest folders' }).click();
            const message = 'Stopped after 2 empty replies in a row. Choose another model in Connections, then try again.';
            await expect(organiser.locator('.neconyan-folder-organiser-status')).toContainText(message);
            await expect(page.locator('#toast-container .toast-error')).toContainText(message);
            expect(submissions).toBe(2);
        } finally {
            await context.close();
        }
    });

    test('sorts with a saved generation setting changed in memory without a save', async ({ browser }, testInfo) => {
        const { context, page, organiser } = await aiFixture(browser, testInfo, false, { batchSize: 5, count: 6 });
        try {
            const requests = [];
            await page.route('**/api/operations/submit', route => {
                requests.push(route.request().postDataJSON());
                return completeBatch(route, [{ id: 1, folder: 'Coastal Towns' }]);
            });
            await page.evaluate(async () => {
                const { oai_settings } = await import('/scripts/openai.js');
                oai_settings.openai_max_tokens = Number(oai_settings.openai_max_tokens) + 1;
            });
            await organiser.getByRole('button', { name: 'Suggest folders' }).click();
            await expect(organiser.getByText('1 suggestion for 1 folder')).toBeVisible();
            expect(requests.length).toBeGreaterThan(0);
            await expect(page.locator('#toast-container .toast-error')).toHaveCount(0);
        } finally {
            await context.close();
        }
    });
});

for (const phone of [false, true]) {
    test(`Folder tabs sort a JanitorAI import into its own folder: ${phone ? 'iPhone emulation' : 'desktop'}`, async ({ browser }, testInfo) => {
        test.setTimeout(180000);
        const context = await browser.newContext({
            ...(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } }),
            baseURL: testInfo.project.use.baseURL, reducedMotion: 'reduce', serviceWorkers: 'block',
        });
        const name = `Folder Tab Check ${phone ? 'Phone' : 'Desktop'} ${Date.now().toString(36)}`;
        let page;
        try {
            if (phone) await installIPhoneSafari(context, { standalone: false });
            page = await context.newPage();
            await openCharacters(page, phone);

            await page.evaluate(async () => {
                const { power_user } = await import('/scripts/power-user.js');
                const tagsModule = await import('/scripts/tags.js');
                window.__folderTabsRestore = {
                    settings: power_user.character_folder_sort ? JSON.parse(JSON.stringify(power_user.character_folder_sort)) : undefined,
                    tagImport: power_user.tag_import_setting,
                    hadJanitor: tagsModule.tags.some(tag => tag.name === 'JanitorAI'),
                };
                power_user.tag_import_setting = tagsModule.tag_import_setting.NONE;
            });

            const rail = page.locator('#neconyan-folder-tabs-rail');
            const toggle = page.locator('#neconyan-folder-tabs .neconyan-folder-tabs-toggle');
            if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
            await expect(rail).toBeVisible();
            const all = rail.locator('.neconyan-folder-tab[data-folder-id=""]');
            if (await all.getAttribute('aria-pressed') !== 'true') await all.click();
            await expect(all).toHaveAttribute('aria-pressed', 'true');

            await page.locator('#neconyan-folder-tabs .neconyan-folder-tabs-organise').click();
            const organiser = page.locator('.neconyan-folder-organiser');
            await expect(organiser.locator('h3')).toHaveText('Organise folders');
            const bySite = organiser.locator('label').filter({ hasText: 'Sort imported characters by site' }).locator('input');
            if (!await bySite.isChecked()) await bySite.check({ force: true });
            await expect(organiser.locator('label').filter({ hasText: 'Make a folder for a site the first time' })).toBeVisible();
            await page.locator('dialog[open] .popup-button-ok').click();
            await expect(organiser).toHaveCount(0);

            await page.evaluate(async (name) => {
                const script = await import('/script.js');
                const card = {
                    spec: 'chara_card_v2', spec_version: '2.0',
                    data: { name, description: 'A folder tab test card.', first_mes: 'Hello.', personality: '', scenario: '', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {} },
                };
                const file = new File([JSON.stringify(card)], 'folder-tab-check.json', { type: 'application/json' });
                window.__folderTabsImport = 'running';
                script.processDroppedFiles([file], new Map(), { sourceUrl: 'https://janitorai.com/characters/folder-tab-check' })
                    .then(() => { window.__folderTabsImport = 'done'; }, error => { window.__folderTabsImport = `failed: ${error}`; });
            }, name);
            await expect.poll(() => page.evaluate(() => window.__folderTabsImport), { timeout: 60000 }).toBe('done');

            const janitor = rail.locator('.neconyan-folder-tab').filter({ has: page.locator('.neconyan-folder-tab-name', { hasText: /^JanitorAI$/ }) });
            await expect(janitor).toHaveCount(1);
            await expect.poll(() => page.evaluate(async (name) => {
                const script = await import('/script.js');
                const tagsModule = await import('/scripts/tags.js');
                const folder = tagsModule.tags.find(tag => tag.name === 'JanitorAI');
                const character = script.characters.find(item => item.name === name);
                return Boolean(folder && ['OPEN', 'CLOSED'].includes(folder.folder_type) && character && tagsModule.tag_map[character.avatar]?.includes(folder.id));
            }, name)).toBe(true);

            // Importing opens the new character, so go back to the list.
            await page.evaluate(() => window.NeconyanShell.openTab('characters', 'characters'));
            await expect(page.locator('#neconyan-folder-tabs')).toBeVisible();
            await janitor.click();
            await expect(janitor).toHaveAttribute('aria-pressed', 'true');
            await expect(all).toHaveAttribute('aria-pressed', 'false');
            await expect(page.locator('#neconyan-folder-tabs .neconyan-folder-tabs-current')).toHaveText('JanitorAI');
            await expect(page.locator('#rm_characters_block .rm_tag_filter .tag.selected')).toHaveCount(1);
            await expect(page.locator('#rm_print_characters_block .character_select .ch_name').filter({ hasText: name })).toHaveCount(1);
            await all.click();
            await expect(all).toHaveAttribute('aria-pressed', 'true');
            await expect(page.locator('#rm_characters_block .rm_tag_filter .tag.selected')).toHaveCount(0);

            // The folder's own row in the list is one compact line: name beside the icon, cards at the end.
            const folderRow = page.locator('#rm_print_characters_block > .bogus_folder_select').filter({ has: page.locator('.ch_name', { hasText: /^JanitorAI$/ }) });
            await expect(folderRow).toHaveCount(1);
            await expect.poll(() => folderRow.evaluate(row => {
                const box = selector => row.querySelector(selector).getBoundingClientRect();
                const [icon, label, count, cards] = [box(':scope > .avatar'), box('.ch_name'), box('.bogus_folder_counter'), box('.bogus_folder_avatars_block')];
                return row.getBoundingClientRect().height <= 60
                    && label.left - icon.right <= 16
                    && count.left >= label.right && count.top < label.bottom
                    && cards.left >= count.right && cards.top < label.bottom;
            })).toBe(true);

            if (phone) {
                const touch = await rail.evaluate(node => window.getComputedStyle(node).touchAction);
                expect(touch).toBe('pan-x');
            }
            const sizes = await rail.locator('.neconyan-folder-tab').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
            for (const height of sizes) expect(height).toBeGreaterThanOrEqual(phone ? 44 : 32);

            await toggle.click();
            await expect(toggle).toHaveAttribute('aria-expanded', 'false');
            await expect(rail).toBeHidden();
            await toggle.click();
            await expect(rail).toBeVisible();
        } finally {
            if (page) {
                await page.evaluate(async (name) => {
                    const script = await import('/script.js');
                    const { power_user } = await import('/scripts/power-user.js');
                    const tagsModule = await import('/scripts/tags.js');
                    const restore = window.__folderTabsRestore;
                    if (!restore) return;
                    for (const character of script.characters.filter(item => item.name === name)) {
                        await fetch('/api/characters/delete', {
                            method: 'POST',
                            headers: script.getRequestHeaders(),
                            body: JSON.stringify({ avatar_url: character.avatar, delete_chats: true }),
                        });
                        delete tagsModule.tag_map[character.avatar];
                    }
                    if (!restore.hadJanitor) {
                        const index = tagsModule.tags.findIndex(tag => tag.name === 'JanitorAI');
                        if (index >= 0) tagsModule.tags.splice(index, 1);
                    }
                    if (restore.settings === undefined) delete power_user.character_folder_sort;
                    else power_user.character_folder_sort = restore.settings;
                    power_user.tag_import_setting = restore.tagImport;
                    // No character list refresh here: the deleted card is still open,
                    // and refreshing would raise the app's 'no longer available' reload prompt.
                    await script.saveSettings();
                }, name).catch(() => {});
            }
            await context.close();
        }
    });
}
