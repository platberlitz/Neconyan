/* global document, window, localStorage, getComputedStyle */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { trackNavigationErrors } from './chat-scroll-regression-helpers.js';

test.use({ serviceWorkers: 'block' });
test.setTimeout(180000);

let safety;
test.beforeEach(async ({ page }) => {
    const state = safety = { ...trackNavigationErrors(page), modelRequests: [], googleFontRequests: [], badAssets: [], unexpected: [], fontRequests: [] };
    page.on('request', request => {
        const path = decodeURIComponent(new URL(request.url()).pathname);
        if ((path.includes('/webfonts/Nunito/') && path.endsWith('.woff2')) || (path.includes('/webfonts/FredokaOne/') && path.endsWith('.ttf'))) state.fontRequests.push(path);
    });
    page.on('response', response => {
        if (response.url().includes('/frontend-assets/') && response.status() >= 400) state.badAssets.push(response.url());
    });
    await page.route(/\/api\/.*\/(?:generate|generate-quiet)(?:\?|$)/, async route => {
        state.modelRequests.push(route.request().url());
        await route.fulfill({ status: 503, json: { error: 'Models are disabled during native UI checks.' } });
    });
    await page.route(/https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, async route => {
        state.googleFontRequests.push(route.request().url());
        await route.abort();
    });
    await page.route('**/api/server-admin/**', route => route.fulfill({ status: 403, json: { error: 'Administration is disabled in this fixture.' } }));
    for (const pattern of ['**/api/users/reset*', '**/api/users/backup*', '**/api/users/delete*', '**/api/users/create*', '**/api/users/recover-step*', '**/api/chats/delete', '**/api/chats/group/delete', '**/api/characters/delete', '**/api/groups/delete', '**/api/files/delete', '**/api/extensions/delete']) {
        await page.route(pattern, async route => {
            state.unexpected.push({ path: new URL(route.request().url()).pathname, body: route.request().postData() });
            await route.fulfill({ status: 403, json: { error: 'Unrelated destructive request blocked.' } });
        });
    }
});
test.afterEach(() => {
    for (const key of ['errors', 'modelRequests', 'googleFontRequests', 'badAssets', 'unexpected']) expect(safety[key], key).toEqual([]);
});

async function mockNativeSettings(page, { tone = 'dark', resetTerminal = false, mainFont, tutorialStatus = 'skipped', homePanelMode } = {}) {
    let envelopePromise, settings;
    const state = { saves: 0, reads: 0, lastSaved: null, failSaves: false };
    await page.route('**/api/settings/get', async route => {
        state.reads++;
        const envelope = await (envelopePromise ??= route.fetch().then(response => response.json()));
        if (!settings) {
            settings = JSON.parse(envelope.settings);
            settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': tutorialStatus, 'NeconyanTutorialIndex.v1': '0' };
            if (homePanelMode) settings.accountStorage.WelcomePage_PanelMode = homePanelMode;
            const { name, ...theme } = JSON.parse(readFileSync(new URL(`../default/content/themes/Neconyan Calico${tone === 'dark' ? ' Dark' : ''}.json`, import.meta.url), 'utf8'));
            Object.assign(settings.power_user, theme, { theme: name, google_font: '' });
            if (resetTerminal) delete settings.extension_settings['Neconyan-Terminal-UI'];
            if (mainFont) settings.extension_settings.CTSI = { ...settings.extension_settings.CTSI, entries: { ...settings.extension_settings.CTSI?.entries, mainFont } };
        }
        await route.fulfill({ json: { ...envelope, settings: JSON.stringify(settings) } });
    });
    await page.route('**/api/settings/save', async route => {
        if (state.failSaves) return route.fulfill({ status: 503, json: { error: 'Settings storage is temporarily unavailable.' } });
        let bytes = route.request().postDataBuffer();
        if (route.request().headers()['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
        const payload = JSON.parse(bytes.toString());
        settings = { ...payload, _version: Math.max(Date.now(), Number(payload._version || 0) + 1) };
        state.lastSaved = settings;
        state.saves++;
        await route.fulfill({ json: { version: settings._version } });
    });
    return state;
}

async function dismissStoryHint(page) {
    const hint = page.locator('#toast-container .toast-info').filter({ hasText: 'Tap a paragraph to edit, or Tab to its Edit button.' });
    if (await hint.count()) {
        await hint.click();
        await expect(hint).toHaveCount(0);
    }
}

// The character list can re-render while the editor opens, detaching the Edit button.
async function openCharacterEditor(page, name = 'Edit Miso (Male)') {
    const button = page.getByRole('button', { name, exact: true });
    for (let attempt = 0; ; attempt++) {
        try {
            await button.click({ timeout: 5000 });
            return;
        } catch (error) {
            if (attempt >= 3) throw error;
            await page.waitForTimeout(250);
        }
    }
}

async function openMisoChat(page) {
    const miso = page.locator('[data-assistant-personality="miso"]');
    await miso.locator('input[value="miso-male"]').check();
    await miso.locator('[data-assistant-open]').click();
    await page.waitForFunction(() => document.querySelector('[data-assistant-picker]')?.dataset.assistantBusy !== 'true');
}

async function modeButton(page, width, mode) {
    if (width < 769) {
        const nav = page.locator('#neconyan-workspace-rail');
        const drawerOpen = await page.evaluate(() => document.body.classList.contains('neconyan-rail-drawer-open'));
        if (!drawerOpen) {
            await page.locator('#sb-hamburger').tap();
            await expect.poll(() => page.evaluate(() => document.body.classList.contains('neconyan-rail-drawer-open'))).toBe(true);
        }
        return nav.locator(`[data-neconyan-chat-mode="${mode}"]`);
    }
    return page.locator(`#neconyan-workspace-rail [data-neconyan-chat-mode="${mode}"]`);
}

async function expectLoadedFont(page, name, style = 'normal') {
    await expect.poll(() => page.evaluate(({ name, style }) => [...document.fonts].some(face => face.family.replace(/['"]/g, '') === name && face.style === style), { name, style })).toBe(true);
    const loaded = await page.evaluate(async ({ name, style }) => {
        await document.fonts.load(`${style} 400 16px ${name}`);
        return [...document.fonts].some(face => face.family.replace(/['"]/g, '') === name && face.style === style && face.status === 'loaded');
    }, { name, style });
    expect(loaded).toBe(true);
}

    test('Included tools stay closed until opened and keep eighteen keyboard-accessible disclosures', async ({ page }) => {
    await mockNativeSettings(page);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await safety.navigate(() => page.goto('/', { waitUntil: 'domcontentloaded' }));
    await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });

    const railTools = page.locator('#neconyan-workspace-rail [data-neconyan-native-tool-list]');
    await expect(page.locator('#neconyan-workspace-rail .neconyan-rail-tools')).not.toHaveAttribute('open', '');
    await expect(railTools.locator('details[data-neconyan-native-tool]')).toHaveCount(18);
    const summaryState = await railTools.locator('summary').evaluateAll(summaries => summaries.map(summary => ({
        controls: summary.getAttribute('aria-controls'),
        expanded: summary.getAttribute('aria-expanded'),
    })));
    expect(new Set(summaryState.map(item => item.controls)).size).toBe(18);
    expect(summaryState.every(item => ['true', 'false'].includes(item.expanded))).toBe(true);
    await page.locator('#neconyan-workspace-rail .neconyan-rail-tools > summary').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#neconyan-workspace-rail .neconyan-rail-tools')).toHaveAttribute('open', '');
    await railTools.locator('summary').first().focus();
    await page.keyboard.press('Enter');
    await expect(railTools.locator('details').first()).toHaveAttribute('open', '');
    await expect(railTools.locator('details').first().locator('.neconyan-native-tool-panel')).toBeVisible();

    await page.setViewportSize({ width: 390, height: 1000 });
    await page.locator('#sb-hamburger').click();
    const mobileTools = page.locator('#neconyan-workspace-rail [data-neconyan-native-tool-list]');
    await expect(mobileTools.locator('details[data-neconyan-native-tool]')).toHaveCount(18);
    await expect(mobileTools.locator('[data-neconyan-native-tool-action="manage"]')).toHaveCount(18);
});

test.describe('Editor surfaces and composer density', () => {
    test.use({ hasTouch: true });

    test('character and persona editors use solid surfaces at every layout width', async ({ page }, info) => {
        page.setDefaultTimeout(15000);
        await mockNativeSettings(page);
        await safety.navigate(() => page.goto('/', { waitUntil: 'domcontentloaded' }));
        await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
        await openMisoChat(page);
        for (const width of [1280, 768, 390, 320]) {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(() => window.NeconyanShell.openTab('characters', 'characters'));
            await expect(page.locator('#rm_print_characters_block .character_select').filter({ hasText: 'Miso (Male)' })).toHaveCount(1, { timeout: 15000 });
            await openCharacterEditor(page);
            await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', /character_edit|create/, { timeout: 15000 });
            const sections = page.getByRole('combobox', { name: 'Editor section', exact: true });
            await expect.poll(async () => await sections.isVisible() || await page.locator('#sb_character_editor_tab_definitions').isVisible()).toBe(true);
            if (await sections.isVisible()) await sections.selectOption('definitions');
            else await page.locator('#sb_character_editor_tab_definitions').click();
            for (const selector of ['#right-nav-panel', '#form_create', '#spoiler_free_desc']) {
                const alpha = await page.locator(selector).evaluate(element => {
                    const context = document.createElement('canvas').getContext('2d');
                    context.fillStyle = getComputedStyle(element).backgroundColor;
                    context.fillRect(0, 0, 1, 1);
                    return context.getImageData(0, 0, 1, 1).data[3];
                });
                expect(alpha, `${selector} at ${width}px`).toBe(255);
            }
            await page.screenshot({ path: info.outputPath(`character-editor-${width}.png`) });
            await page.evaluate(() => window.NeconyanShell.openTab('characters', 'persona'));
            await expect(page.locator('#persona-management-block')).toBeVisible();
            for (const selector of ['#right-nav-panel', '#PersonaManagement', '#persona-management-block']) {
                const alpha = await page.locator(selector).evaluate(element => {
                    const context = document.createElement('canvas').getContext('2d');
                    context.fillStyle = getComputedStyle(element).backgroundColor;
                    context.fillRect(0, 0, 1, 1);
                    return context.getImageData(0, 0, 1, 1).data[3];
                });
                expect(alpha, `${selector} at ${width}px`).toBe(255);
            }
            await page.screenshot({ path: info.outputPath(`persona-${width}.png`) });
        }
    });

    test('character editor commit bar stays on the panel floor above the scrolling body', async ({ page }, info) => {
        page.setDefaultTimeout(15000);
        await mockNativeSettings(page);
        await safety.navigate(() => page.goto('/', { waitUntil: 'domcontentloaded' }));
        await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
        await openMisoChat(page);
        for (const width of [1280, 390]) {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(() => window.NeconyanShell.openTab('characters', 'characters'));
            await expect(page.locator('#rm_print_characters_block .character_select').filter({ hasText: 'Miso (Male)' })).toHaveCount(1, { timeout: 15000 });
            await openCharacterEditor(page);
            await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', /character_edit|create/, { timeout: 15000 });
            const sections = page.getByRole('combobox', { name: 'Editor section', exact: true });
            if (await sections.isVisible()) await sections.selectOption('greetings');
            else await page.locator('#sb_character_editor_tab_greetings').click();
            await expect(page.locator('#sb_character_editor_panel_greetings')).toBeVisible();
            const geometry = await page.evaluate(() => {
                const form = document.getElementById('form_create');
                const bar = document.getElementById('sb_character_commit_bar');
                const panels = document.querySelector('.sb-character-editor-subtab-panels');
                const f = form.getBoundingClientRect();
                const b = bar.getBoundingClientRect();
                const p = panels.getBoundingClientRect();
                return { formBottom: f.bottom, barTop: b.top, barBottom: b.bottom, panelsBottom: p.bottom };
            });
            expect(Math.abs(geometry.barBottom - geometry.formBottom), `footer at ${width}px`).toBeLessThanOrEqual(2);
            expect(geometry.panelsBottom, `body above footer at ${width}px`).toBeLessThanOrEqual(geometry.barTop + 2);
            const clearance = await page.evaluate(() => {
                const bar = document.getElementById('sb_character_commit_bar');
                const panels = document.querySelector('.sb-character-editor-subtab-panels');
                panels.scrollTop = panels.scrollHeight;
                const last = panels.querySelector('[data-sb-character-editor-panel]:not([hidden]) > *:last-child');
                return {
                    lastBottom: last.getBoundingClientRect().bottom,
                    barTop: bar.getBoundingClientRect().top,
                    panelBottom: panels.getBoundingClientRect().bottom,
                };
            });
            expect(clearance.lastBottom, `last field clears footer at ${width}px`).toBeLessThanOrEqual(clearance.barTop + 2);
            await page.screenshot({ path: info.outputPath(`commit-bar-${width}.png`) });
        }
    });

    test('the compact composer grows for multiline drafts and keeps its actions reachable', async ({ page }, info) => {
        page.setDefaultTimeout(15000);
        await mockNativeSettings(page);
        await safety.navigate(() => page.goto('/', { waitUntil: 'domcontentloaded' }));
        await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
        await openMisoChat(page);
        await page.evaluate(() => window.NeconyanShell.activateMode('roleplay'));
        const input = page.locator('#send_textarea');
        const form = page.locator('#send_form');
        await expect(input).toBeVisible();
        for (const width of [1280, 768, 390, 320]) {
            await page.setViewportSize({ width, height: 900 });
            await input.fill('');
            await expect.poll(async () => (await form.boundingBox()).height).toBeLessThanOrEqual(90);
            const emptyHeight = (await form.boundingBox()).height;
            expect((await input.boundingBox()).width).toBeGreaterThanOrEqual(100);
            await page.screenshot({ path: info.outputPath(`composer-empty-${width}.png`) });
            await input.fill('One short line');
            await expect.poll(async () => (await form.boundingBox()).height).toBeLessThanOrEqual(90);
            await input.fill('Line one\nLine two\nLine three\nLine four\nLine five\nLine six');
            await expect.poll(async () => (await form.boundingBox()).height).toBeGreaterThan(emptyHeight + 20);
            await expect(input).toHaveValue(/Line six$/);
            await page.screenshot({ path: info.outputPath(`composer-multiline-${width}.png`) });
            await input.fill('');
            const connect = form.getByRole('button', { name: 'Connect a model', exact: true });
            await expect(connect).toBeVisible();
            await connect.tap();
            await expect(page.locator('#left-nav-panel')).toHaveAttribute('data-sb-active-tab', 'api');
            await expect(page.locator('#left-nav-panel')).toHaveClass(/openDrawer/);
            await page.evaluate(() => window.NeconyanShell.closeWorkspace());
            await expect(page.locator('#left-nav-panel')).not.toHaveClass(/openDrawer/);
            const chatTools = form.getByRole('button', { name: 'Chat tools', exact: true });
            const deleteOption = page.locator('#option_delete_mes');
            if (!await deleteOption.isVisible()) await chatTools.tap();
            await expect(deleteOption).toBeVisible();
            await page.keyboard.press('Escape');
            if (await deleteOption.isVisible()) await chatTools.tap();
            await expect(deleteOption).toBeHidden();
        }
    });
});

test('top bar shows the system time and a roleplay-only Edit card shortcut', async ({ page }, info) => {
    page.setDefaultTimeout(15000);
    await mockNativeSettings(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await safety.navigate(() => page.goto('/', { waitUntil: 'domcontentloaded' }));
    await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });

    const clock = page.locator('#sb-topbar-clock');
    await expect(clock).toBeVisible();
    await expect(clock).toHaveText(/^\d{1,2}:\d{2}/);
    const editCard = page.locator('#sb-topbar-edit-card');
    await expect(editCard).toBeHidden();

    const kbd = page.locator('.neconyan-rail-footer kbd').first();
    await expect(kbd).toHaveText('/');
    await expect(kbd).toHaveCSS('border-radius', '5px');
    await expect(kbd).not.toHaveCSS('background-color', 'rgb(255, 255, 255)');

    await openMisoChat(page);
    await page.evaluate(() => window.NeconyanShell.activateMode('roleplay'));
    await expect(editCard).toBeVisible();
    await editCard.click();
    await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', /character_edit|create/, { timeout: 15000 });
    await expect(page.locator('#form_create')).toBeAttached();
    await page.screenshot({ path: info.outputPath('topbar-edit-card.png') });

    await page.evaluate(() => window.NeconyanShell.closeWorkspace());
    await expect(editCard).toBeVisible();
    await page.evaluate(() => window.NeconyanShell.activateMode('conversation'));
    await expect(editCard).toBeHidden();
});

test('Built-in Extensions omits Included Tools while their settings remain searchable', async ({ page }) => {
    await mockNativeSettings(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await safety.navigate(() => page.goto('/', { waitUntil: 'domcontentloaded' }));
    await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'extensions'));
    await page.getByRole('button', { name: 'Built-in', exact: true }).click();
    const entries = page.locator('.sb-extension-master-item');
    await expect(entries).toHaveCount(10);
    for (const name of ['BotSearcher', 'Dialogue Colors', 'Preset Tools', 'Prompt Tags', 'Time Machine', 'Meower', 'Story Mode', 'Pathfinder']) {
        await expect(entries.filter({ hasText: new RegExp(`^${name}$`) })).toHaveCount(0);
    }
    for (const name of ['TTS', 'Quick Reply', 'Quick Image Gen', 'Vector Storage']) {
        await expect(entries.filter({ hasText: new RegExp(`^${name}$`) })).toHaveCount(1);
    }
    // Pathfinder keeps its settings page through the Included Tools route.
    await page.evaluate(() => {
        const definition = window.NeconyanNativeTools.getDefinitions().find(tool => tool.label === 'Pathfinder');
        window.NeconyanNativeTools.openSettings(definition);
    });
    await expect(page.locator('#user-settings-block')).toHaveAttribute('data-sb-active-tab', 'included-tool');
    await expect(page.locator('.neconyan-included-tool-content .extension_container, .neconyan-included-tool-content > *').first()).toBeVisible();
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'extensions'));
    await page.evaluate(() => window.NeconyanExtensions.focusUnit('Dialogue Colors'));
    await expect(page.locator('#user-settings-block')).toHaveAttribute('data-sb-active-tab', 'included-tool');
    await expect(page.locator('#user-settings-block .sb-shell-title')).toHaveText('Dialogue Colors');
    await page.evaluate(() => { window.includedSearchProbe = document.querySelector('.neconyan-included-tool-content input'); });
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'extensions'));
    await page.evaluate(() => {
        const target = window.includedSearchProbe;
        target.dispatchEvent(new CustomEvent('sb:reveal-search-target', { bubbles: true, detail: { target } }));
    });
    await expect(page.locator('#user-settings-block')).toHaveAttribute('data-sb-active-tab', 'included-tool');
    expect(await page.evaluate(() => document.querySelector('.neconyan-included-tool-content').contains(window.includedSearchProbe))).toBe(true);
});

test.describe('Sidebar sizing', () => {
    test.use({ hasTouch: true });
    test('sidebar collapse keeps the active workspace and its draft open', async ({ page, browserName }) => {
        await mockNativeSettings(page);
        await page.setViewportSize({ width: 1280, height: 900 });
        await safety.navigate(() => page.goto('/', { waitUntil: 'domcontentloaded' }));
        await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
        const toggle = page.locator('#neconyan-sidebar-toggle');
        const rail = page.locator('#neconyan-workspace-rail');
        if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
        const cases = [
            ['characters', 'characters', '#right-nav-panel', 'data-menu-type'],
            ['characters', 'world-info', '#right-nav-panel', 'data-menu-type'],
            ['characters', 'persona', '#right-nav-panel', 'data-menu-type'],
            ['left', 'presets', '#left-nav-panel', 'data-sb-active-tab'],
            ['left', 'agents', '#left-nav-panel', 'data-sb-active-tab'],
            ['right', 'settings', '#user-settings-block', 'data-sb-active-tab'],
            ['right', 'extensions', '#user-settings-block', 'data-sb-active-tab'],
        ];
        for (const [side, tab, selector, attribute] of cases) {
            await page.evaluate(({ side, tab }) => window.NeconyanShell.openTab(side, tab), { side, tab });
            const workspace = page.locator(selector);
            await expect(workspace).toHaveClass(/openDrawer/);
            const openWidth = (await rail.boundingBox()).width;
            if (tab === 'characters') await page.locator('#character_search_bar').fill('Miso');
            await toggle.click();
            await expect(toggle).toHaveAttribute('aria-expanded', 'false');
            await expect(workspace).toHaveClass(/openDrawer/);
            await expect(workspace).toBeVisible();
            await expect(workspace).toHaveAttribute(attribute, tab);
            expect((await rail.boundingBox()).width).toBeLessThan(openWidth);
            if (tab === 'characters') await expect(page.locator('#character_search_bar')).toHaveValue('Miso');
            await toggle.focus();
            await page.keyboard.press('Enter');
            await expect(toggle).toHaveAttribute('aria-expanded', 'true');
            await expect(workspace).toHaveClass(/openDrawer/);
            await expect(workspace).toHaveAttribute(attribute, tab);
        }
        await page.setViewportSize({ width: 997, height: 900 });
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'agents'));
        await toggle.tap();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('#left-nav-panel')).toHaveClass(/openDrawer/);
        await toggle.tap();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(page.locator('#left-nav-panel')).toHaveClass(/openDrawer/);
        await page.screenshot({ path: `output/playwright/sidebar-collapse-${browserName}.png` });
    });
});

test('first-run tour is visible, recovers from a failed Skip, and remembers completion', async ({ page }, info) => {
    const settings = await mockNativeSettings(page, { tutorialStatus: '', homePanelMode: 'list' });
    await page.addInitScript(() => {
        localStorage.setItem('NeconyanTutorialStatus.v1', 'skipped');
        localStorage.setItem('WelcomePage_PanelMode', 'list');
    });
    await safety.navigate(() => page.goto('/', { waitUntil: 'domcontentloaded' }));
    const tour = page.locator('.welcomeTourPanel');
    await expect(tour).toHaveAttribute('data-tutorial-expanded', 'true', { timeout: 60000 });
    await expect(page.locator('.welcomePanel')).toHaveClass(/welcomePanel--listOnly/);
    const skip = tour.locator('.neconyan-tour-heading .tutorialSkip');
    for (const width of [1280, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(skip).toBeInViewport();
        await expect(tour.locator('.welcomeTourStep.is-active')).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await page.screenshot({ path: info.outputPath(`first-run-${width}.png`) });
    }
    settings.failSaves = true;
    await skip.click();
    await expect(tour).not.toHaveAttribute('data-tutorial-saving', 'true');
    await expect(tour).toHaveAttribute('data-tutorial-expanded', 'true');
    await expect(tour).toHaveAttribute('data-tutorial-index', '0');
    settings.failSaves = false;
    await skip.click();
    await expect(tour).toHaveAttribute('data-tutorial-expanded', 'false');
    expect(settings.lastSaved.accountStorage['NeconyanTutorialStatus.v1']).toBe('skipped');
    await safety.navigate(() => page.reload({ waitUntil: 'domcontentloaded' }));
    await expect(tour).toHaveAttribute('data-tutorial-expanded', 'false', { timeout: 60000 });
    await page.getByText('Home layout', { exact: true }).click();
    await page.getByRole('button', { name: 'Full home', exact: true }).click();
    await page.locator('.neconyan-home-help > summary').click();
    await tour.getByRole('button', { name: 'Start again', exact: true }).click();
    await expect(tour).toHaveAttribute('data-tutorial-expanded', 'true');
    for (let step = 0; step < 8; step++) {
        await expect(tour).toHaveAttribute('data-tutorial-index', String(step));
        await page.locator('[data-tour-coach-next]').click();
    }
    await expect(tour).toHaveAttribute('data-tutorial-expanded', 'false');
    expect(settings.lastSaved.accountStorage['NeconyanTutorialStatus.v1']).toBe('completed');
});

test('Extensions separates third-party panels and reveals hidden built-in search targets', async ({ page }) => {
    page.setDefaultTimeout(20000);
    const fixtures = [
        { name: 'third-party/neconyan-local-fixture', type: 'local', label: 'Local fixture', count: 2 },
        { name: 'third-party/neconyan-global-fixture', type: 'global', label: 'Global fixture', count: 1 },
        { name: 'third-party/neconyan-empty-fixture', type: 'global', label: 'No settings fixture', count: 0 },
    ];
    await page.route('**/api/extensions/discover', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, json: [...await response.json(), ...fixtures.map(({ name, type }) => ({ name, type }))] });
    });
    for (const fixture of fixtures) {
        await page.route('**/scripts/extensions/' + fixture.name + '/**', async route => {
            if (new URL(route.request().url()).pathname.endsWith('/manifest.json')) {
                await route.fulfill({ json: { display_name: fixture.label, author: 'Test fixture', version: '1.0.0', js: 'index.js', loading_order: 1000, requires: [], optional: [] } });
                return;
            }
            const script = '(' + (definition => {
                for (let index = 0; index < definition.count; index++) {
                    const unit = document.createElement('div');
                    unit.id = definition.type + '-fixture-' + index;
                    unit.className = 'extension_container';
                    unit.dataset.extensionName = definition.name;
                    const label = document.createElement('label');
                    label.textContent = definition.label + ' option ' + index;
                    const input = document.createElement('input');
                    input.id = unit.id + '-input';
                    input.className = 'text_pole';
                    label.htmlFor = input.id;
                    const drawer = document.createElement('div');
                    drawer.className = 'inline-drawer';
                    drawer.innerHTML = '<div class="inline-drawer-header inline-drawer-toggle"><b>Fixture settings</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"></div>';
                    drawer.lastElementChild.append(label, input);
                    unit.append(drawer);
                    document.getElementById(index ? 'extensions_settings2' : 'extensions_settings').append(unit);
                }
            }).toString() + ')(' + JSON.stringify(fixture) + ');';
            await route.fulfill({ contentType: 'text/javascript', body: script });
        });
    }
    await mockNativeSettings(page);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await safety.navigate(() => page.goto('/', { waitUntil: 'domcontentloaded' }));
    await expect(page.locator('#local-fixture-0-input')).toBeAttached({ timeout: 60000 });
    await expect(page.locator('#qig-input-btn')).toBeAttached();
    await page.evaluate(() => {
        const unit = document.createElement('div');
        unit.id = 'builtin-fixture';
        unit.className = 'extension_container';
        unit.innerHTML = '<h3>Built-in fixture</h3><label for="builtin-fixture-input">Hidden builtin probe control</label><input id="builtin-fixture-input" class="text_pole">';
        document.getElementById('extensions_settings').append(unit);
    });
    await page.getByRole('button', { name: 'Extensions', exact: true }).click();
    const thirdParty = page.locator('button[data-extensions-scope="third-party"]');
    const builtIn = page.locator('button[data-extensions-scope="built-in"]');
    const masters = page.locator('.sb-extension-master-item');
    await expect(thirdParty).toHaveAttribute('aria-pressed', 'true');
    await expect(masters).toHaveCount(3);
    await expect(page.locator('#builtin-fixture')).toBeHidden();
    await masters.filter({ hasText: /^Local fixture$/ }).click();
    await expect(page.locator('#local-fixture-0')).toBeVisible();
    await expect(page.locator('#local-fixture-1')).toBeVisible();
    await expect(page.locator('#global-fixture-0')).toBeHidden();
    const drawerToggle = page.locator('#local-fixture-0 .inline-drawer-icon');
    await expect(drawerToggle).toHaveAttribute('aria-expanded', 'true');
    await page.locator('#local-fixture-0-input').fill('Keep this setting.');
    await page.evaluate(() => {
        window.localFixtureInput = document.getElementById('local-fixture-0-input');
        window.globalFixtureButton = [...document.querySelectorAll('.sb-extension-master-item')].find(button => button.textContent === 'Global fixture');
        const late = document.createElement('div');
        late.id = 'local-fixture-late';
        late.className = 'extension_container';
        late.dataset.extensionName = 'third-party/neconyan-local-fixture';
        late.textContent = 'Late local setting';
        document.getElementById('extensions_settings2').append(late);
    });
    await expect(page.locator('#local-fixture-late')).toBeVisible();
    await expect(masters).toHaveCount(3);
    expect(await masters.filter({ hasText: /^Global fixture$/ }).evaluate(button => button === window.globalFixtureButton)).toBe(true);
    await expect(page.locator('#local-fixture-0-input')).toBeFocused();
    await drawerToggle.focus();
    await page.keyboard.press('Enter');
    await expect(drawerToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#local-fixture-0-input')).toBeHidden();
    await masters.filter({ hasText: /^Global fixture$/ }).click();
    await expect(page.locator('#global-fixture-0')).toBeVisible();
    await expect(page.locator('#local-fixture-0')).toBeHidden();
    await masters.filter({ hasText: /^No settings fixture$/ }).click();
    await expect(page.locator('.sb-extensions-empty')).toContainText('No settings are available');
    await expect(page.locator('#global-fixture-0')).toBeHidden();
    await builtIn.click();
    await masters.filter({ hasText: /^Built-in fixture$/ }).click();
    await expect(page.locator('#builtin-fixture-input')).toBeVisible();
    await expect(page.locator('#local-fixture-late')).toBeHidden();
    await thirdParty.click();
    await expect(page.locator('#builtin-fixture')).toBeHidden();

    await page.locator('#sb-shortcut-right').click();
    await page.locator('#sb-universal-search-input').fill('Hidden builtin probe control');
    await page.locator('.sb-search-result').filter({ hasText: 'Hidden builtin probe control' }).first().click();
    await expect(builtIn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#builtin-fixture-input')).toBeVisible();
    await page.locator('label[for="builtin-fixture-input"]').click();
    await expect(page.locator('#builtin-fixture-input')).toBeFocused();
    await thirdParty.click();
    await masters.filter({ hasText: /^Local fixture$/ }).click();
    await expect(drawerToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#local-fixture-0-input')).toBeHidden();
    await expect(page.locator('#local-fixture-0-input')).toHaveValue('Keep this setting.');
    expect(await page.evaluate(() => window.localFixtureInput === document.getElementById('local-fixture-0-input'))).toBe(true);
    const pinSaved = page.waitForResponse(response => response.url().endsWith('/api/settings/save') && response.ok());
    await page.getByRole('button', { name: 'Pin Local fixture', exact: true }).click();
    await expect(masters.first()).toHaveText('Local fixture');
    await expect(page.getByRole('button', { name: 'Unpin Local fixture', exact: true })).toBeFocused();
    await pinSaved;
    await safety.navigate(() => page.reload({ waitUntil: 'domcontentloaded' }));
    await expect(page.locator('#local-fixture-0-input')).toBeAttached({ timeout: 60000 });
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'extensions'));
    await expect(masters.first()).toHaveText('Local fixture');
    // Phones drop the picker: every extension in the active scope is listed as its own drawer.
    await page.setViewportSize({ width: 390, height: 900 });
    await expect(page.locator('.sb-extensions-select')).toBeHidden();
    await expect(page.locator('.sb-extension-mobile-pin')).toBeHidden();
    await expect(page.locator('#local-fixture-0-input')).toBeAttached();
    await expect(page.locator('#extensions_settings > :not([hidden]), #extensions_settings2 > :not([hidden])').first()).toBeVisible();
    expect(await page.locator('#extensions_settings > :not([hidden]), #extensions_settings2 > :not([hidden])').count()).toBeGreaterThan(1);
});

for (const width of [1280, 390, 320]) {
    test.describe(`native tools at ${width}px`, () => {
        test.use({ viewport: { width, height: 1000 }, isMobile: width < 768, hasTouch: width < 768 });
        for (const tone of ['dark', 'light']) {
            test(`${tone} native catalog and Story/Meower preserve the chat draft`, async ({ page }, info) => {
                page.setDefaultTimeout(20000);
                const { errors, modelRequests, googleFontRequests } = safety;
                await mockNativeSettings(page, { tone });
                await safety.navigate(() => page.goto('/', { waitUntil: 'domcontentloaded' }));
                await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
                await expect(page.locator('#qig-input-btn')).toBeAttached({ timeout: 60000 });
                await expect(page.locator('#toast-container .toast-warning')).toHaveCount(0);
                const fontState = await page.evaluate(async () => {
                    await document.fonts.load('400 16px Nunito');
                    await document.fonts.load('400 16px \'Fredoka One\'');
                    const family = value => String(value).replaceAll(String.fromCharCode(34), '').replaceAll(String.fromCharCode(39), '');
                    const loadedFaces = name => [...document.fonts].filter(face => family(face.family) === name && face.status === 'loaded').map(face => ({ style: face.style, weight: face.weight }));
                    const message = document.querySelector('.mes_text') || document.querySelector('#chat') || document.querySelector('#send_textarea');
                    const control = document.querySelector('#send_textarea');
                    const heading = document.querySelector('.sb-topbar-brand') || document.querySelector('h2');
                    const monospace = document.querySelector('#customCSS') || document.querySelector('.monospace');
                    return { nunito: loadedFaces('Nunito'), fredoka: loadedFaces('Fredoka One'), body: getComputedStyle(document.body).fontFamily, message: message && getComputedStyle(message).fontFamily, control: control && getComputedStyle(control).fontFamily, heading: heading && getComputedStyle(heading).fontFamily, monospace: monospace && getComputedStyle(monospace).fontFamily };
                });
                expect(fontState.nunito.some(face => face.style === 'normal')).toBe(true);
                expect(fontState.fredoka.some(face => face.style === 'normal')).toBe(true);
                expect(fontState.body).toContain('Nunito');
                expect(fontState.message).toContain('Nunito');
                expect(fontState.control).toContain('Nunito');
                expect(fontState.heading).toMatch(/^"?Fredoka One"?,/);
                expect(fontState.monospace).toMatch(/Noto Sans Mono|monospace/i);
                await page.evaluate(() => { const select = document.getElementById('google_font_preset'); select.value = 'Figtree'; select.dispatchEvent(new Event('change', { bubbles: true })); });
                await page.waitForFunction(() => document.getElementById('google-font-style')?.href.endsWith('/webfonts/Figtree/stylesheet.css?v=20260422b'));
                const explicitFontState = await page.evaluate(async () => {
                    await document.fonts.load('400 16px Figtree');
                    const family = value => String(value).replaceAll(String.fromCharCode(34), '').replaceAll(String.fromCharCode(39), '');
                    return [...document.fonts].some(face => family(face.family) === 'Figtree' && face.style === 'normal' && face.status === 'loaded');
                });
                expect(explicitFontState).toBe(true);
                await page.evaluate(() => { const select = document.getElementById('google_font_preset'); select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); });
                await expect(page.locator('body')).toHaveCSS('font-family', /Nunito/);
                expect(safety.fontRequests.filter(path => path.endsWith('/webfonts/Nunito/Nunito[wght].woff2'))).toHaveLength(1);
                expect(safety.fontRequests.filter(path => path.includes('/webfonts/FredokaOne/'))).toHaveLength(1);
                await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
                await expect(page.locator('body')).not.toHaveClass(/(?:^| )sbterm(?: |$)/);
                const discovered = await page.request.get('/api/extensions/discover');
                const native = (await discovered.json()).filter(entry => entry.type === 'native');
                expect(native).toHaveLength(17);
                expect(new Set(native.map(entry => entry.name)).size).toBe(17);

                await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
                await page.locator('#extensions_details').click();
                const catalog = page.locator('dialog.popup:visible .extension_native');
                await expect(catalog).toHaveCount(17);
                await expect(catalog.filter({ hasText: 'Meower' })).toHaveCount(1);
                await expect(catalog.locator('.btn_update, .btn_sync, .btn_reinstall, .btn_delete, .btn_move, .btn_branch')).toHaveCount(0);
                await expect(catalog.locator('.extension_missing')).toHaveCount(0);
                await expect(catalog.filter({ hasText: 'Story Mode' }).locator('.extension_origin')).toContainText('platberlitz');
                await page.screenshot({ path: info.outputPath('native-catalog.png') });
                await page.locator('dialog.popup:visible .popup-button-ok').click();
                await page.evaluate(() => window.NeconyanShell.closeWorkspace());
                const miso = page.locator('[data-assistant-personality="miso"]');
                await miso.locator('input[value="miso-male"]').check();
                await miso.locator('[data-assistant-open]').click();
                await page.waitForFunction(() => document.querySelector('[data-assistant-picker]')?.dataset.assistantBusy !== 'true');
                await dismissStoryHint(page);
                await page.locator('#send_textarea').fill('Keep this draft while I explore the native tools.');
                await expect(page.locator('#chat .mes_text').first()).toHaveCSS('font-family', /Nunito/);

                await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
                if (width === 320) {
                    for (const tab of ['characters', 'groups', 'world-info', 'persona', 'import']) {
                        await page.evaluate(tab => window.NeconyanShell.openTab('characters', tab), tab);
                        const header = page.locator('#right-nav-panel > .sb-character-shell-header');
                        const bounds = await header.boundingBox();
                        for (const control of await header.locator('#sb_character_shell_close, #sb_character_mode_toggle, #sbtw-launch-button, #sbstory-mode-button').all()) {
                            if (!await control.isVisible()) continue;
                            const box = await control.boundingBox();
                            expect(box.y, tab).toBeGreaterThanOrEqual(bounds.y);
                            expect(box.y + box.height, tab).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
                            expect(box.x + box.width, tab).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
                        }
                        await page.screenshot({ path: info.outputPath(`header-${tab}.png`) });
                    }
                    await page.evaluate(() => window.NeconyanShell.openTab('characters', 'characters'));
                }
                await expect(page.locator('#toast-container .toast')).toHaveCount(0);
                const story = await modeButton(page, width, 'story');
                const hopper = await modeButton(page, width, 'meower');
                for (const button of [story, hopper]) {
                    await expect(button).toBeVisible();
                    expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(width < 769 ? 44 : 34);
                }
                await page.screenshot({ path: info.outputPath('native-mode-controls.png') });
                if (await story.getAttribute('aria-pressed') === 'true') {
                    await (await modeButton(page, width, 'roleplay')).click();
                    await expect(page.locator('body')).not.toHaveClass(/sbstory/);
                    await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
                }
                await (await modeButton(page, width, 'story')).click();
                await expect(page.locator('body')).toHaveClass(/sbstory/);
                await expect(page.locator('#sbstory-bar')).toBeVisible();
                await dismissStoryHint(page);
                await expect(page.locator('#send_textarea')).toHaveValue('Keep this draft while I explore the native tools.');
                await page.screenshot({ path: info.outputPath('story-mode.png') });

                await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
                await (await modeButton(page, width, 'meower')).click();
                await expect(page.locator('#sheld')).toHaveAttribute('data-sbtw-mode', 'on');
                await expect(page.locator('.sbtw-shell')).toBeVisible();
                await expect(hopper.locator('i.fa-paw')).toHaveCount(1);
                const bounds = await page.locator('.sbtw-shell').boundingBox();
                const sidebar = await page.locator('#neconyan-workspace-rail').boundingBox();
                expect(bounds.x).toBeGreaterThanOrEqual(width > 768 ? sidebar.x + sidebar.width - 1 : 0);
                expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
                const navContrast = await page.locator('.sbtw-nav').evaluate(nav => {
                    const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => channel / 255)
                        .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
                        .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
                    const foreground = luminance(getComputedStyle(nav.querySelector('.sbtw-nav-item:not(.sbtw-nav-on)')).color);
                    const background = luminance(getComputedStyle(nav).backgroundColor);
                    return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
                });
                expect(navContrast).toBeGreaterThanOrEqual(4.5);
                await expect(page.locator('#sbstory-bar')).toBeHidden();
                await expect(page.locator('#send_textarea')).toHaveValue('Keep this draft while I explore the native tools.');
                await expect(page.locator('#toast-container .toast')).toHaveCount(0);
                await page.screenshot({ path: info.outputPath('meower.png') });
                await page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
                await (await modeButton(page, width, 'story')).click();
                await expect(page.locator('#sheld')).not.toHaveAttribute('data-sbtw-mode', 'on');
                await expect(page.locator('#sbstory-bar')).toBeVisible();
                await dismissStoryHint(page);
                await expect(page.locator('#send_textarea')).toHaveValue('Keep this draft while I explore the native tools.');
                const geometry = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
                expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
                expect(errors).toEqual([]);
                expect(modelRequests).toEqual([]);
                expect(googleFontRequests).toEqual([]);
                await safety.navigate(() => page.reload({ waitUntil: 'domcontentloaded' }));
                await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
                await miso.locator('input[value="miso-male"]').check();
                await miso.locator('[data-assistant-open]').click();
                await page.waitForFunction(() => document.querySelector('[data-assistant-picker]')?.dataset.assistantBusy !== 'true');
                await expect(page.locator('#sbstory-bar')).toBeVisible();
                expect(errors).toEqual([]);
            });
        }
    });
}

test('Included tool settings have their own pages and preserve late settings nodes', async ({ page }, info) => {
    page.setDefaultTimeout(20000);
    await mockNativeSettings(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await safety.navigate(() => page.goto('/', { waitUntil: 'domcontentloaded' }));
    await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
    const tools = page.locator('#neconyan-workspace-rail .neconyan-rail-tools');
    const openTool = async (label, unavailable = false) => {
        if (!await tools.evaluate(element => element.open)) await tools.locator(':scope > summary').click();
        const item = tools.locator('details[data-neconyan-native-tool]').filter({ has: page.locator('.neconyan-native-tool-name', { hasText: new RegExp(`^${label}$`) }) });
        if (!await item.evaluate(element => element.open)) await item.locator('summary').click();
        await item.getByRole('button', { name: `Settings ${label}`, exact: true }).click();
        await expect(page.locator('#user-settings-block')).toHaveAttribute('data-sb-active-tab', 'included-tool');
        await expect(page.locator('#user-settings-block .sb-shell-title')).toHaveText(label);
        if (unavailable) await expect(page.locator('.neconyan-included-tool-unavailable')).toBeVisible({ timeout: 10000 });
        else {
            await expect(page.locator('.neconyan-included-tool-content > *').first()).toBeVisible();
            await expect(page.locator('.neconyan-included-tool-unavailable')).toHaveCount(0);
            const body = page.locator('.neconyan-included-tool-content .inline-drawer-content').first();
            if (await body.count()) await expect(body).toBeVisible();
        }
        await expect(page.locator('.sb-extensions-master')).toBeHidden();
    };
    await openTool('Dialogue Colors');
    await page.evaluate(() => {
        const unit = document.createElement('div');
        unit.id = 'neconyan-tool-late-probe';
        unit.className = 'extension_container';
        unit.innerHTML = '<h3>Dialogue Colors</h3><input id="neconyan-tool-late-input" aria-label="Late tool setting">';
        window.neconyanLateToolUnit = unit;
        document.getElementById('extensions_settings2').append(unit);
    });
    await expect(page.locator('.neconyan-included-tool-content #neconyan-tool-late-input')).toBeVisible();
    await page.locator('#neconyan-tool-late-input').fill('Keep this draft');
    await openTool('Prompt Tags');
    await expect(page.locator('#extensions_settings2 #neconyan-tool-late-probe')).toBeAttached();
    await openTool('Dialogue Colors');
    await expect(page.locator('#neconyan-tool-late-input')).toHaveValue('Keep this draft');
    expect(await page.evaluate(() => document.getElementById('neconyan-tool-late-probe') === window.neconyanLateToolUnit)).toBe(true);
    const enabledLabels = await tools.locator('details[data-neconyan-native-tool]').evaluateAll(items => items
        .filter(item => item.querySelector('.neconyan-native-tool-state')?.dataset.state === 'enabled'
            && item.querySelector('[data-neconyan-native-tool-action="settings"]'))
        .map(item => item.querySelector('.neconyan-native-tool-name').textContent));
    for (const label of enabledLabels) {
        await openTool(label);
        await page.screenshot({ path: info.outputPath(`tool-${label.replace(/[^a-z0-9]+/gi, '-')}.png`) });
    }
    await openTool('Debugger', true);
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'extensions'));
    await expect(page.locator('button[data-extensions-scope="third-party"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#extensions_settings2 #neconyan-tool-late-probe')).toBeAttached();
    await expect(page.locator('#neconyan-tool-late-probe')).toHaveCount(1);
});

test.describe('native import report', () => {
    test.use({ viewport: { width: 320, height: 1000 }, isMobile: true, hasTouch: true });
    test('distinguishes retained native copies from custom extensions awaiting reload', async ({ page }, info) => {
        page.setDefaultTimeout(20000);
        await mockNativeSettings(page);
        let report = {
            readyCount: 0, warningCount: 0, failedCount: 0, shadowedCount: 1,
            results: [{ name: 'Neconyan-Hopper', displayName: 'Meower', version: '0.4.0', author: 'platberlitz', status: 'shadowed', copiedFiles: 3 }],
        };
        await page.route('**/api/users/import-sillytavern/extensions', route => route.fulfill({ json: report }));
        page.on('dialog', dialog => dialog.accept());
        await safety.navigate(() => page.goto('/', { waitUntil: 'domcontentloaded' }));
        await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
        await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'settings'));
        await page.locator('.sb-settings-category-select').selectOption('system-device');
        const section = page.locator('#SillyTavernImportSection');
        if (!await page.locator('#sb-import-path-input').isVisible()) await section.locator('.inline-drawer-toggle').first().click();
        await page.locator('#sb-import-path-input').fill('/example/SillyTavern');
        await section.getByRole('button', { name: 'Sync Extensions', exact: true }).click();
        await expect(section.locator('.sb-import-report .sb-server-pill')).toHaveText('Retained, inactive');
        await expect(section.locator('.sb-import-report-help')).toContainText('1 retained copy stays inactive');
        await expect(section.locator('.sb-import-report-help')).not.toContainText('Reload');
        report = { ...report, readyCount: 1, results: [...report.results, { name: 'CustomTool', displayName: 'Custom Tool', status: 'ready', copiedFiles: 2 }] };
        await section.getByRole('button', { name: 'Sync Extensions', exact: true }).click();
        await expect(section.locator('.sb-import-report .sb-server-pill')).toHaveText(['Retained, inactive', 'Ready']);
        await expect(section.locator('.sb-import-report-help')).toContainText('activate the synced custom extensions');
        await expect(section.locator('.sb-import-report-help')).toContainText('1 retained copy stays inactive');
        await page.screenshot({ path: info.outputPath('native-import-report.png') });
    });
});


test.describe('native Terminal UI', () => {
    test.use({ viewport: { width: 390, height: 1000 }, isMobile: true, hasTouch: true });
    test('keeps a fresh Terminal inactive and lets its settings enable and disable it', async ({ page }, info) => {
        page.setDefaultTimeout(20000);
        const errors = safety.errors;
        await mockNativeSettings(page, { resetTerminal: true });
        await safety.navigate(() => page.goto('/', { waitUntil: 'domcontentloaded' }));
        await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
        await expect(page.locator('body')).not.toHaveClass(/(?:^| )sbterm(?: |$)/);
        await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
        const labels = await page.locator('.sb-extensions-select option').allTextContents();
        expect(labels.filter(label => /^Silly(?:Bunny|Tavern)[-_]/.test(label))).toEqual([]);
        await page.locator('.sb-extensions-scope-button[data-extensions-scope="built-in"]').click();
        await page.locator('#extensions_details').click();
        const extensionToggle = page.locator('dialog.popup:visible input[data-name="third-party/Neconyan-Terminal-UI"]');
        if (!await extensionToggle.isChecked()) {
            await extensionToggle.check();
            await Promise.all([
                page.waitForEvent('domcontentloaded'),
                page.locator('dialog.popup:visible .popup-button-ok').click(),
            ]);
            await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
            await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
        } else {
            await page.locator('dialog.popup:visible .popup-button-ok').click();
        }
        // Terminal UI is an Included Tool, so its settings live on the tool page rather
        // than the Built-in Extensions list. The rail is hidden at this mobile width, so
        // open the same tool page the Included Tools buttons use.
        await page.evaluate(() => {
            const definition = window.NeconyanNativeTools.getDefinitions().find(tool => tool.label === 'Terminal UI');
            window.NeconyanNativeTools.openSettings(definition);
        });
        await expect(page.locator('#user-settings-block')).toHaveAttribute('data-sb-active-tab', 'included-tool');
        const enable = page.locator('#sbterm-enabled');
        if (!await enable.isVisible()) await page.locator('#sbterm-settings-drawer .inline-drawer-toggle').click();
        try {
            await expect(enable).not.toBeChecked();
            await expect(page.locator('#sbterm-palette')).toHaveValue('inherit');
            await enable.check();
            await expect(page.locator('body')).toHaveClass(/(?:^| )sbterm(?: |$)/);
            await expect(page.locator('.sbterm-mascot img').first()).toHaveAttribute('src', '/img/neconyan/cat-head.webp');
            await expect(page.locator('.sbterm-banner-title')).toHaveText('neconyan terminal');
            await page.screenshot({ path: info.outputPath('native-terminal.png') });
        } finally {
            if (await enable.count()) await enable.uncheck();
        }
        await expect(page.locator('body')).not.toHaveClass(/(?:^| )sbterm(?: |$)/);
        await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'extensions'));
        await page.locator('#extensions_details').click();
        await extensionToggle.uncheck();
        await Promise.all([page.waitForEvent('domcontentloaded'), page.locator('dialog.popup:visible .popup-button-ok').click()]);
        await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
        expect(errors).toEqual([]);
    });
});

test.describe('Conversation and native view transitions', () => {
    test.use({ viewport: { width: 320, height: 1000 }, isMobile: true, hasTouch: true });
    test('Home, Roleplay, Story and Meower preserve both composer drafts', async ({ page }, info) => {
        page.setDefaultTimeout(20000);
        const errors = safety.errors;
        const requests = safety.modelRequests;
        await mockNativeSettings(page);
        const openCharacters = () => page.evaluate(() => window.SillyBunnyShell.openTab('characters', 'characters'));
        const openConversation = async () => {
            await (await modeButton(page, 320, 'conversation')).click();
            await expect(page.locator('#sb_conversation_stage')).toBeVisible();
        };
        const checkDrafts = async () => {
            await expect(page.locator('#send_textarea')).toHaveValue('Roleplay draft across every view.');
            await expect(page.locator('#sb_conversation_input')).toHaveValue('Conversation draft across every view.');
        };
        await safety.navigate(() => page.goto('/', { waitUntil: 'domcontentloaded' }));
        await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
        const miso = page.locator('[data-assistant-personality="miso"]');
        await miso.locator('input[value="miso-male"]').check();
        await miso.locator('[data-assistant-open]').click();
        await page.waitForFunction(() => document.querySelector('[data-assistant-picker]')?.dataset.assistantBusy !== 'true');
        await page.locator('#send_textarea').fill('Roleplay draft across every view.');
        await openCharacters();
        if (await page.locator('body').evaluate(body => body.classList.contains('sbstory'))) {
            await (await modeButton(page, 320, 'roleplay')).click();
            await expect(page.locator('body')).not.toHaveClass(/sbstory/);
        }
        await openConversation();
        await page.locator('#sb_conversation_input').fill('Conversation draft across every view.');
        await page.getByRole('button', { name: 'Open menu', exact: true }).click();
        await page.locator('#neconyan-workspace-rail').getByRole('button', { name: 'Home', exact: true }).click();
        await expect(page.locator('[data-neconyan-cat]')).toBeVisible();
        await checkDrafts();
        await page.getByRole('button', { name: 'Continue your chat', exact: true }).click();
        await expect(page.locator('#sb_conversation_stage')).toBeVisible();
        await checkDrafts();
        await openCharacters();
        await (await modeButton(page, 320, 'roleplay')).click();
        await expect(page.locator('#sb_conversation_stage')).toBeHidden();
        await expect(page.locator('#sbstory-bar')).toBeHidden();
        await checkDrafts();
        await openConversation();
        await openCharacters();
        expect(await page.locator('#chat').evaluate(element => element.getClientRects().length)).toBe(0);
        await (await modeButton(page, 320, 'story')).click();
        await expect(page.locator('#sbstory-bar')).toBeVisible();
        await expect(page.locator('#sb_conversation_stage')).toBeHidden();
        await checkDrafts();
        await openConversation();
        await openCharacters();
        await (await modeButton(page, 320, 'meower')).click();
        await expect(page.locator('.sbtw-shell')).toBeVisible();
        await expect(page.locator('#sb_conversation_stage')).toBeHidden();
        await checkDrafts();
        await openConversation();
        await expect(page.locator('.sbtw-shell')).toBeHidden();
        await checkDrafts();
        await page.locator('[data-sb-conversation-action="open-connections"]').click();
        await expect(page.locator('#left-nav-panel')).toHaveAttribute('data-sb-active-tab', 'api');
        await checkDrafts();
        await page.screenshot({ path: info.outputPath('conversation-connections-drafts.png') });
        expect(errors).toEqual([]);
        expect(requests).toEqual([]);
    });
});


test('saved theme fonts remain local when an explicit font override is cleared', async ({ page }) => {
    const fixture = await mockNativeSettings(page, { mainFont: 'Figtree' });
    await safety.navigate(() => page.goto('/', { waitUntil: 'domcontentloaded' }));
    await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
    await expectLoadedFont(page, 'Figtree');
    await expect(page.locator('body')).toHaveCSS('font-family', /Figtree/);
    await page.evaluate(() => {
        document.getElementById('google_font_custom').value = 'Nunito';
        document.getElementById('apply_google_font').click();
    });
    await expectLoadedFont(page, 'Nunito');
    await expect(page.locator('body')).toHaveCSS('font-family', /Nunito/);
    const beforeClear = fixture.saves;
    await page.evaluate(() => {
        const select = document.getElementById('google_font_preset');
        select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // Default now always means the built-in pairing: Nunito body, Fredoka One headings.
    await expect(page.locator('body')).toHaveCSS('font-family', /Nunito/);
    await expectLoadedFont(page, 'Nunito');
    await expect.poll(() => fixture.saves).toBeGreaterThan(beforeClear);
    expect(fixture.lastSaved.power_user.google_font).toBe('');
    expect(fixture.lastSaved.extension_settings.CTSI.entries.mainFont).toBe('Figtree');
    const beforeReload = fixture.reads;
    await safety.navigate(() => page.reload({ waitUntil: 'domcontentloaded' }));
    await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
    expect(fixture.reads).toBeGreaterThan(beforeReload);
    await expect(page.locator('body')).toHaveCSS('font-family', /Nunito/);
    await expectLoadedFont(page, 'Nunito');
});

test('the login document loads local Fredoka One for account controls', async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.route('**/api/users/list', route => route.fulfill({ json: [{ handle: 'font-check', name: 'Font check', password: true, avatar: '/img/user-default.png' }] }));
    await safety.navigate(() => page.goto('/login.html', { waitUntil: 'domcontentloaded' }));
    await expect(page.locator('#normalLoginPrompt')).toBeVisible();
    await expectLoadedFont(page, 'Fredoka One');
    await expect(page.locator('body')).toHaveCSS('font-family', /Fredoka One/);
    await expect(page.locator('button').first()).toHaveCSS('font-family', /Fredoka One/);
    await page.screenshot({ path: info.outputPath('login-fredoka.png') });
});
