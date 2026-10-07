/* global window, document */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves, trackNavigationErrors } from './chat-scroll-regression-helpers.js';

test.use({ serviceWorkers: 'block' });
test.setTimeout(180000);

// Earlier tests can leave the account on another Agents section, so every test opens on Manage agents.
const openOnManage = settings => {
    delete settings.accountStorage?.['ica--workspace-view'];
};

test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(15000);
    await isolateSettingsSaves(page, openOnManage);
    await page.route('**/api/server-admin/**', route => route.fulfill({ status: 403, json: { error: 'Administration is disabled during agent UI checks.' } }));
    await page.route(/\/api\/.*\/generate-quiet(?:\?|$)/, route => route.fulfill({ status: 503, json: { error: 'Generation is disabled during agent UI checks.' } }));
});

async function openAgents(page, withChat = false, navigate = action => action()) {
    await navigate(() => page.goto('/', { waitUntil: 'domcontentloaded' }));
    await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 45000 });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    await expect(page.locator('#ica--run-status')).not.toHaveText('Ready', { timeout: 45000 });
    if (withChat) {
        const assistant = page.locator('[data-assistant-personality="miso"]');
        await assistant.locator('input[value="miso-male"]').check();
        await assistant.locator('[data-assistant-open]').click();
        await page.waitForFunction(() => document.querySelector('[data-assistant-picker]')?.dataset.assistantBusy !== 'true');
        const skipTour = page.getByRole('region', { name: 'Neconyan interactive tutorial' }).getByRole('button', { name: 'Skip', exact: true });
        if (await skipTour.isVisible()) await skipTour.click();
    }
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'agents'));
    await expect(page.locator('#ica--settings')).toBeVisible({ timeout: 45000 });
}

async function headers(page) {
    return page.evaluate(() => window.SillyTavern.getContext().getRequestHeaders());
}

async function capture(page, info, name) {
    await page.evaluate(() => window.toastr?.remove());
    await page.screenshot({ path: info.outputPath(`${name}.png`) });
}

async function checkClose(page, root = '#left-nav-panel') {
    const container = page.locator(`${root} .sb-shell-header`);
    await expect(container).toBeVisible();
    const parent = await container.boundingBox();
    const close = await container.locator('.sb-shell-close').boundingBox();
    expect(close.y).toBeGreaterThanOrEqual(parent.y);
    expect(close.y + close.height).toBeLessThanOrEqual(parent.y + parent.height + 1);
    expect(close.x + close.width).toBeLessThanOrEqual(parent.x + parent.width + 1);
}

async function checkSelectText(select) {
    const size = await select.evaluate(element => {
        const style = window.getComputedStyle(element);
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const text = element.selectedOptions[0]?.textContent || '';
        return {
            text: context.measureText(text).width,
            available: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - (style.appearance === 'none' ? 0 : 20),
        };
    });
    expect(size.text).toBeLessThanOrEqual(size.available);
}

async function chooseEditorSection(page, section) {
    // Phones show the labelled editor tab row too, so the section buttons are the
    // one control at every width and the section dropdown stays desktop-hidden.
    await page.locator(`[data-editor-tab="${section}"]`).click();
}

const WIDTHS = [1280, 1024, 997, 768, 390, 393, 320];

for (const width of [1280, 393]) {
    test.describe(`Reply rewrite settings at ${width}px`, () => {
        test.use({ viewport: { width, height: width === 393 ? 852 : 900 }, isMobile: width === 393, hasTouch: width === 393 });
        test('length and recent context survive quick settings, editor changes and reloads', async ({ page }, info) => {
            await openAgents(page);
            const skipTour = page.getByRole('region', { name: 'Neconyan interactive tutorial' }).getByRole('button', { name: 'Skip', exact: true });
            if (await skipTour.isVisible()) {
                await skipTour.click();
                await page.evaluate(() => window.NeconyanShell.openTab('left', 'agents'));
            }
            const template = JSON.parse(readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/length-trimmer.json', import.meta.url)));
            const agent = { ...template, id: `rewrite-settings-${width}-${Date.now()}`, sourceTemplateId: template.id,
                name: 'Reply rewrite settings check', settings: { ...template.settings, auditMarker: 'preserve' } };
            const requestHeaders = await headers(page);
            expect((await page.request.post('/api/in-chat-agents/save', { headers: requestHeaders, data: agent })).ok()).toBe(true);
            try {
                await openAgents(page);
                await page.locator('#ica--search').fill(agent.name);
                await page.locator('#ica--agentList .ica--btn-settings').click();
                const quick = page.locator('.ica--quick-settings');
                const length = quick.getByLabel('Target length', { exact: true });
                const context = quick.getByLabel('Recent messages to read', { exact: true });
                await expect(length).toHaveValue('About 300 to 450 words');
                await expect(context).toHaveValue('0');
                await length.fill('Two short paragraphs');
                await context.fill('6');
                for (const control of [length, context]) {
                    await control.scrollIntoViewIfNeeded();
                    const box = await control.boundingBox();
                    expect(box.x).toBeGreaterThanOrEqual(0);
                    expect(box.x + box.width).toBeLessThanOrEqual(width);
                    expect(await control.evaluate(element => window.getComputedStyle(element).visibility)).toBe('visible');
                }
                await capture(page, info, 'rewrite-quick-settings');
                await page.locator('dialog.popup:visible .popup-button-ok').click();
                await expect(quick).toBeHidden();
                await openAgents(page);
                await page.locator('#ica--search').fill(agent.name);
                await page.locator('#ica--agentList .ica--btn-edit').click();
                const editor = page.locator('#ica--editor');
                await chooseEditorSection(page, 'instructions');
                await expect(editor.locator('#ica--editor-length-target')).toHaveValue('Two short paragraphs');
                await editor.locator('#ica--editor-length-target').fill('');
                await chooseEditorSection(page, 'reply');
                const editorContext = editor.locator('#ica--editor-pp-promptContextMessages');
                await expect(editorContext).toHaveValue('6');
                await editorContext.fill('0');
                await editorContext.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
                const editorGeometry = await editorContext.evaluate(element => {
                    const box = element.getBoundingClientRect();
                    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
                        unobscured: document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === element };
                });
                expect(editorGeometry.left).toBeGreaterThanOrEqual(0);
                expect(editorGeometry.right).toBeLessThanOrEqual(width);
                expect(editorGeometry.top).toBeGreaterThanOrEqual(0);
                expect(editorGeometry.bottom).toBeLessThanOrEqual(page.viewportSize().height);
                expect(editorGeometry.unobscured).toBe(true);
                await capture(page, info, 'rewrite-editor');
                await page.locator('dialog.popup:visible .popup-button-ok').click();
                await expect(editor).toBeHidden();
                await openAgents(page);
                await page.locator('#ica--search').fill(agent.name);
                await page.locator('#ica--agentList .ica--btn-settings').click();
                await expect(length).toHaveValue('About 300 to 450 words');
                await expect(context).toHaveValue('0');
                const response = await page.request.post('/api/settings/get', { headers: requestHeaders, data: {} });
                const saved = (await response.json()).inChatAgents.find(item => item.id === agent.id);
                expect(saved.settings.auditMarker).toBe('preserve');
                expect(saved.enabled).toBe(false);
            } finally {
                await page.request.post('/api/in-chat-agents/delete', { headers: requestHeaders, data: { id: agent.id } });
            }
        });
    });
}

for (const width of [1280, 393]) {
    test.describe(`Companion note clean-up at ${width}px`, () => {
        test.use({ viewport: { width, height: width === 393 ? 852 : 900 }, isMobile: width === 393, hasTouch: width === 393 });
        test('automatic clean-up is opt-in, configurable and saved without changing agents or notes', async ({ page }, info) => {
            await openAgents(page);
            const skipTour = page.getByRole('region', { name: 'Neconyan interactive tutorial' }).getByRole('button', { name: 'Skip', exact: true });
            if (await skipTour.isVisible()) {
                await skipTour.click();
                await page.evaluate(() => window.NeconyanShell.openTab('left', 'agents'));
                await expect(page.locator('#ica--settings')).toBeVisible();
            }
            await page.locator('.ica--workspace-tab[data-workspace-view="connections"]').click();
            const enabled = page.locator('#ica--companionAutoCleanupEnabled');
            const count = page.locator('#ica--companionAutoCleanupOlderNotes');
            await expect(enabled).not.toBeChecked();
            await expect(count).toBeDisabled();
            await expect(count).toHaveValue('3');
            const before = await page.evaluate(async () => {
                const context = window.SillyTavern.getContext();
                const { getAgents } = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                return JSON.stringify({ chat: context.chat, agents: getAgents() });
            });
            await enabled.check();
            await expect(count).toBeEnabled();
            const savedSetting = page.waitForResponse(response => response.url().endsWith('/api/settings/save') && response.ok()
                && response.request().postDataJSON()?.extension_settings?.inChatAgents?.globalSettings?.companionAutoCleanupOlderNotes === 0);
            await count.fill('0');
            await count.blur();
            await expect(count).toHaveValue('0');
            await expect(page.locator('#ica--cleanup-help')).toContainText('cannot');
            await page.locator('#ica--cleanup-group-title').scrollIntoViewIfNeeded();
            await count.scrollIntoViewIfNeeded();
            await count.click();
            const geometry = await count.evaluate(element => {
                const box = element.getBoundingClientRect(), style = window.getComputedStyle(element);
                return { left: box.left, right: box.right, width: box.width, visibility: style.visibility, viewport: window.innerWidth };
            });
            expect(geometry.left).toBeGreaterThanOrEqual(0);
            expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
            expect(geometry.width).toBeGreaterThan(40);
            expect(geometry.visibility).toBe('visible');
            await capture(page, info, 'companion-note-cleanup');
            await savedSetting;
            await openAgents(page);
            await page.locator('.ica--workspace-tab[data-workspace-view="connections"]').click();
            await expect(enabled).toBeChecked();
            await expect(count).toHaveValue('0');
            await enabled.uncheck();
            await expect(count).toBeDisabled();
            expect(await page.evaluate(async () => {
                const context = window.SillyTavern.getContext();
                const { getAgents } = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                return JSON.stringify({ chat: context.chat, agents: getAgents() });
            })).toBe(before);
        });
    });
}

test.describe('Agents navigation with an open chat', () => {
    // Every width opens and saves the same Miso chat, so run them one after another.
    test.describe.configure({ mode: 'default' });
    for (const width of WIDTHS) {
        test.describe(`Agents at ${width}px`, () => {
            test.use({ viewport: { width, height: width === 393 ? 852 : width === 1280 ? 900 : 1000 }, isMobile: width < 769, hasTouch: width < 769 });
            test('navigation, filters, library and recoverable editor save', async ({ page }, info) => {
                const createdIds = new Set();
                const modelRequests = [];
                const pageErrors = [];
                page.on('pageerror', error => pageErrors.push(error.message));
                await page.route(/\/api\/.*\/generate(?:\?|$)/, route => {
                    modelRequests.push(route.request().url());
                    return route.fulfill({ status: 503, json: { error: 'Generation disabled for UI test' } });
                });
                await openAgents(page, true);
                const requestHeaders = await headers(page);
                try {
                    await checkClose(page);
                    if (width < 769) {
                        await expect(page.locator('#ica--workspaceNav [role="tablist"]')).toBeVisible();
                        await expect(page.locator('#ica--workspaceSelect')).toBeHidden();
                        await page.locator('.ica--workspace-tab[data-workspace-view="connections"]').click();
                        await expect(page.locator('[data-ica-view="connections"]')).toBeVisible();
                        await page.locator('.ica--workspace-tab[data-workspace-view="manage"]').click();
                        await expect(page.locator('#ica--agentTabs')).toBeVisible();
                        await page.locator('#ica--agentTabs .ica--agent-tab[data-tab="quick"]').click();
                        await page.locator('#ica--agentTabs .ica--agent-tab[data-tab="all"]').click();
                    } else {
                        const tabs = page.locator('.ica--workspace-tab');
                        const top = await tabs.nth(0).boundingBox();
                        const bottom = await tabs.nth(1).boundingBox();
                        if (width <= 1100) {
                            expect(Math.abs(bottom.y - top.y)).toBeLessThanOrEqual(top.height + 8);
                        } else {
                            expect(bottom.y).toBeGreaterThan(top.y + top.height);
                        }
                        await tabs.nth(0).focus();
                        await page.keyboard.press('ArrowDown');
                        await expect(page.locator('[data-ica-view="connections"]')).toBeVisible();
                        await page.keyboard.press('Home');
                        await expect(page.locator('[data-ica-view="manage"]')).toBeVisible();
                        if (width <= 1100) {
                            await expect(page.locator('#ica--agentViewSelect')).toBeVisible();
                        } else {
                            const filters = page.locator('.ica--agent-tab');
                            const first = await filters.first().boundingBox();
                            const last = await filters.last().boundingBox();
                            expect(last.y).toBeGreaterThan(first.y + first.height);
                        }
                    }
                    const geometry = await page.evaluate(() => ({
                        documentWidth: document.documentElement.scrollWidth,
                        viewportWidth: window.innerWidth,
                        panelWidth: document.querySelector('#ica--settings')?.getBoundingClientRect().width ?? 0,
                    }));
                    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
                    expect(geometry.panelWidth).toBeGreaterThan(0);
                    await page.locator('#ica--search').fill('no-match-for-this-agent-audit');
                    await expect(page.locator('.ica--clear-agent-filters')).toBeVisible();
                    await page.locator('.ica--clear-agent-filters').click();
                    await expect(page.locator('#ica--search')).toHaveValue('');
                    const settingsGeometry = await page.locator('#ica--settings').evaluate(root => ({ width: root.clientWidth, scrollWidth: root.scrollWidth }));
                    expect(settingsGeometry.scrollWidth).toBeLessThanOrEqual(settingsGeometry.width + 1);
                    await page.locator('#ica--moreTools > summary').click();
                    const toolButtons = page.locator('.ica--more-tools-menu .menu_button:visible');
                    for (let index = 0; index < await toolButtons.count(); index++) {
                        await toolButtons.nth(index).scrollIntoViewIfNeeded();
                        expect(await toolButtons.nth(index).evaluate(element => {
                            const box = element.getBoundingClientRect();
                            const panel = document.querySelector('#ica--settings').getBoundingClientRect();
                            const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                            return box.left >= panel.left - 1 && box.right <= panel.right + 1 && (element === hit || element.contains(hit));
                        })).toBe(true);
                    }
                    await page.locator('#ica--moreTools > summary').click();
                    await capture(page, info, 'manage');

                    await page.locator('#ica--templates').click();
                    const library = page.locator('.ica--template-browser');
                    await expect(library).toBeVisible();
                    await library.locator('.ica--template-search').fill('no-template-with-this-name');
                    await expect(library.locator('.ica--template-empty button')).toBeVisible();
                    await library.locator('.ica--template-empty button').click();
                    if (width < 769) await library.locator('.ica--template-category-select').selectOption('content');
                    else await library.locator('.ica--template-pill[data-category="content"]').click();
                    await expect(library.locator('.ica--library-kits')).toBeHidden();
                    await library.locator('.ica--template-search').fill('Grounded Prose');
                    const groundedProseCard = library.locator('.ica--template-card[data-id="tpl-grounded-prose"]');
                    await expect(groundedProseCard).toHaveCount(1);
                    await expect(groundedProseCard.locator('.ica--template-card-name')).toHaveText('Grounded Prose');
                    await capture(page, info, 'library');
                    const templateId = 'tpl-grounded-prose';
                    let addedPayload;
                    await page.route('**/api/in-chat-agents/save', async route => {
                        const payload = route.request().postDataJSON();
                        if (payload?.sourceTemplateId !== templateId) return route.continue();
                        addedPayload = payload;
                        return route.fulfill({ status: 200, body: '' });
                    });
                    const added = page.waitForResponse(response => response.url().endsWith('/api/in-chat-agents/save') && response.request().postDataJSON()?.sourceTemplateId === templateId);
                    await groundedProseCard.locator('.ica--template-add').click();
                    const addedResponse = await added;
                    expect(addedResponse.ok()).toBe(true);
                    expect(addedPayload).toEqual(expect.objectContaining({
                        name: 'Grounded Prose',
                        sourceTemplateId: templateId,
                        enabled: false,
                        phase: 'pre',
                    }));
                    createdIds.add(addedResponse.request().postDataJSON().id);
                    await page.unroute('**/api/in-chat-agents/save');
                    await expect(library.locator('.ica--template-pill.is-active')).toHaveAttribute('data-category', 'content');
                    await page.locator('dialog.popup:visible .popup-button-ok').click();
                    await expect(library).toBeHidden();

                    await page.locator('#ica--addAgent').click();
                    const editor = page.locator('#ica--editor');
                    const popup = page.locator('dialog.popup:visible').filter({ has: editor });
                    await expect(editor).toBeVisible();
                    for (const id of ['ica--companion-view', 'ica--tracker-builder-view', 'ica--when-view']) {
                        await expect(editor.locator(`#${id}`)).toHaveCount(1);
                    }
                    const name = `UI audit ${width} ${Date.now()}`;
                    await editor.locator('#ica--editor-name').fill(name);
                    await editor.locator('#ica--editor-description').fill('Keep this draft through an unavailable server.');
                    await editor.locator('#ica--editor-execution').selectOption('companion');
                    await popup.locator('.popup-button-ok').click();
                    await expect(editor.locator('#ica--editor-save-error')).toContainText('Add instructions');
                    await expect(editor.locator('#ica--editor-prompt')).toBeFocused();
                    await editor.locator('#ica--editor-prompt').fill('Write one short note about the scene.');
                    await chooseEditorSection(page, 'companion');
                    await expect(editor.locator('#ica--companion-view')).toBeVisible();
                    await editor.locator('#ica--editor-companion-trigger').selectOption('manual');
                    await chooseEditorSection(page, 'when');
                    await expect(editor.locator('#ica--tracker-builder-view')).toBeHidden();
                    await chooseEditorSection(page, 'basics');
                    await checkSelectText(editor.locator('#ica--editor-execution'));
                    await capture(page, info, 'editor');

                    let saves = 0;
                    let releaseSave;
                    const saveGate = new Promise(resolve => { releaseSave = resolve; });
                    await page.route('**/api/in-chat-agents/save', async route => {
                        const data = route.request().postDataJSON();
                        if (data.name !== name) return route.continue();
                        createdIds.add(data.id);
                        saves++;
                        if (saves === 1) return route.fulfill({ status: 503, json: { error: 'Temporary storage outage' } });
                        await saveGate;
                        return route.continue();
                    });
                    await popup.locator('.popup-button-ok').click();
                    await expect(editor.locator('#ica--editor-save-error')).toContainText('Your changes are still here');
                    await expect(editor.locator('#ica--editor-name')).toHaveValue(name);
                    await expect(editor.locator('#ica--editor-description')).toHaveValue('Keep this draft through an unavailable server.');
                    await popup.locator('.popup-button-ok').click();
                    await expect(popup).toHaveAttribute('aria-busy', 'true');
                    await expect(popup.locator('.popup-button-ok')).toHaveAttribute('aria-disabled', 'true');
                    await popup.locator('.popup-button-ok').dispatchEvent('click');
                    await page.keyboard.press('Escape');
                    await expect(popup).toBeVisible();
                    expect(saves).toBe(2);
                    releaseSave();
                    await expect(editor).toBeHidden();
                    await page.unroute('**/api/in-chat-agents/save');
                    await page.locator('#ica--search').fill(name);
                    await expect(page.locator('#ica--agentList .ica--agent-card')).toHaveCount(1);

                    const settingsResponse = await page.request.post('/api/settings/get', { headers: await headers(page), data: {} });
                    const saved = (await settingsResponse.json()).inChatAgents.find(agent => agent.name === name);
                    expect(saved.companion.trigger).toBe('manual');
                    const seeded = { ...saved, settings: { ...saved.settings, auditMarker: 'keep unknown settings' } };
                    expect((await page.request.post('/api/in-chat-agents/save', { headers: await headers(page), data: seeded })).ok()).toBe(true);
                    await openAgents(page, true);
                    await page.locator('#ica--search').fill(name);
                    await expect(page.locator('#ica--agentList .ica--agent-card')).toHaveCount(1);
                    // The filtered card can sit below the phone viewport's setup controls.
                    await page.locator('#ica--agentList .ica--btn-edit').scrollIntoViewIfNeeded();
                    await expect(page.locator('#ica--agentList .ica--btn-edit')).toBeInViewport();
                    expect(await page.locator('#ica--agentList .ica--btn-edit').evaluate(element => {
                        const box = element.getBoundingClientRect();
                        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                        return element === hit || element.contains(hit);
                    })).toBe(true);
                    await page.locator('#ica--agentList .ica--btn-edit').click();
                    await chooseEditorSection(page, 'basics');
                    await expect(editor.locator('#ica--editor-name')).toHaveValue(name);
                    await expect(editor.locator('#ica--editor-description')).toHaveValue('Keep this draft through an unavailable server.');
                    await editor.locator('#ica--editor-description').fill('Saved after reloading.');
                    const updatedAgent = page.waitForResponse(response => response.url().endsWith('/api/in-chat-agents/save')
                        && response.request().postDataJSON()?.description === 'Saved after reloading.');
                    await page.locator('dialog.popup:visible .popup-button-ok').click();
                    expect((await updatedAgent).ok()).toBe(true);
                    await expect(editor).toBeHidden();
                    const reloaded = await page.request.post('/api/settings/get', { headers: await headers(page), data: {} });
                    const persisted = (await reloaded.json()).inChatAgents.find(agent => agent.id === saved.id);
                    expect(persisted.description).toBe('Saved after reloading.');
                    expect(persisted.settings.auditMarker).toBe('keep unknown settings');
                    expect(persisted.prompt).toBe('Write one short note about the scene.');

                    const master = page.locator('#ica--globalEnabled');
                    if (await master.getAttribute('aria-pressed') !== 'true') await master.click();
                    await master.click();
                    await expect(master).toHaveAttribute('aria-pressed', 'false');
                    for (const run of await page.locator('#ica--agentList .ica--btn-run, #ica--agentList .ica--btn-run-target').all()) await expect(run).toBeDisabled();
                    await master.click();
                    await expect(master).toHaveAttribute('aria-pressed', 'true');
                    await expect(page.locator('#ica--agentList .ica--btn-run')).toBeEnabled();
                    expect(modelRequests).toEqual([]);
                    expect(pageErrors).toEqual([]);
                } finally {
                    for (const id of createdIds) await page.request.post('/api/in-chat-agents/delete', { headers: requestHeaders, data: { id } });
                }
            });
        });
    }
});

for (const width of WIDTHS) {
    test.describe(`Agents at ${width}px`, () => {
        test.use({ viewport: { width, height: width === 393 ? 852 : width === 1280 ? 900 : 1000 }, isMobile: width < 769, hasTouch: width < 769 });

        test('light surfaces keep Manage, Library and Editor readable', async ({ page }, info) => {
            const { name, ...theme } = JSON.parse(readFileSync(new URL('../default/content/themes/Neconyan Calico.json', import.meta.url), 'utf8'));
            await isolateSettingsSaves(page, settings => {
                openOnManage(settings);
                Object.assign(settings.power_user, theme, { theme: name });
            });
            await openAgents(page);
            await checkClose(page);
            for (const [shell, tab, root] of [['left', 'api', '#left-nav-panel'], ['right', 'settings', '#user-settings-block'], ['right', 'extensions', '#user-settings-block']]) {
                await page.evaluate(([shell, tab]) => window.NeconyanShell.openTab(shell, tab), [shell, tab]);
                await checkClose(page, root);
            }
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'agents'));
            await capture(page, info, 'manage-light');
            await page.locator('#ica--templates').click();
            await expect(page.locator('.ica--template-browser')).toBeVisible();
            await capture(page, info, 'library-light');
            await page.locator('dialog.popup:visible .popup-button-ok').click();
            await page.locator('#ica--addAgent').click();
            await expect(page.locator('#ica--editor')).toBeVisible();
            await capture(page, info, 'editor-light');
            await page.keyboard.press('Escape');
            await expect(page.locator('#ica--editor')).toBeHidden();
        });
    });
}

test('empty workspace and failed library load can be recovered without losing the page', async ({ page }) => {
    let mode = 'fail';
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await isolateSettingsSaves(page, openOnManage, data => { data.inChatAgents = []; });
    await page.route(/\/in-chat-agents\/templates\/index\.json(?:\?|$)/, async route => {
        if (mode === 'fail') return route.fulfill({ status: 503, json: {} });
        if (mode === 'delay') await gate;
        return route.continue();
    });
    try {
        await openAgents(page);
        await expect(page.locator('.ica--empty-state')).toContainText('No agents yet');
        await page.locator('#ica--templates').click();
        await expect(page.locator('.toast-error')).toContainText('Could not load the library');
        await expect(page.locator('#ica--templates')).toBeEnabled();
        mode = 'delay';
        await page.locator('#ica--templates').click();
        await expect(page.locator('#ica--templates')).toHaveAttribute('aria-busy', 'true');
        await expect(page.locator('#ica--templates')).toBeDisabled();
        release();
        await expect(page.locator('.ica--template-browser')).toBeVisible();
        await expect(page.locator('.ica--template-card').first()).toBeVisible();
    } finally { release(); }
});

test('saved agent setups survive reload and recover from a failed load without deleting agents', async ({ page }, info) => {
    const { errors, navigate } = trackNavigationErrors(page);
    await page.route(/\/api\/.*\/(?:generate|generate-quiet)(?:\?|$)/, route => route.fulfill({ status: 503, json: { error: 'No model calls during setup checks.' } }));
    await page.setViewportSize({ width: 1024, height: 900 });
    await openAgents(page, false, navigate);
    const api = page.request;
    const requestHeaders = await headers(page);
    const initial = await (await api.post('/api/settings/get', { headers: requestHeaders, data: {} })).json();
    const initialSettings = JSON.parse(initial.settings);
    const originalGlobals = structuredClone(initialSettings.extension_settings.inChatAgents?.globalSettings);
    const originalSelection = initialSettings.accountStorage?.['ica--selected-setup'];
    const id = `setup-ui-agent-${Date.now()}`;
    const name = `Setup UI ${Date.now()}`;
    const agent = { id, name, prompt: 'Saved instructions', enabled: false, category: 'custom', settings: { secretId: 'saved-reference', customOption: 42 }, customSchema: { properties: { password: { type: 'string' } } } };
    let presetId;
    try {
        expect((await api.post('/api/in-chat-agents/save', { headers: requestHeaders, data: agent })).ok()).toBe(true);
        await openAgents(page, false, navigate);
        page.once('dialog', dialog => dialog.accept(name));
        await page.locator('#ica--setupSave').click();
        await expect(page.locator('#ica--setupStatus')).toHaveAttribute('data-tone', 'saved');
        await expect(page.locator('#ica--setupSelect')).not.toHaveValue('');
        presetId = await page.locator('#ica--setupSelect').inputValue();
        await openAgents(page, false, navigate);
        await expect(page.locator('#ica--setupSelect')).toHaveValue(presetId);
        const savedPresets = async () => (await api.post('/api/in-chat-agents/presets/list', { headers: await headers(page), data: {} })).json();
        const saved = (await savedPresets()).find(preset => preset.id === presetId);
        expect(saved.agents.find(item => item.id === id)).toMatchObject({ settings: agent.settings, customSchema: agent.customSchema });
        expect((await api.post('/api/in-chat-agents/save', { headers: await headers(page), data: { ...agent, prompt: 'Changed after saving' } })).ok()).toBe(true);
        await openAgents(page, false, navigate);
        await page.locator('#ica--setupSelect').selectOption(presetId);
        let failed = false;
        await page.route('**/api/in-chat-agents/save', async route => {
            const payload = route.request().postDataJSON();
            if (!failed && payload.id === id && payload.prompt === agent.prompt) {
                failed = true;
                return route.fulfill({ status: 503, body: 'Temporary failure' });
            }
            return route.continue();
        });
        await page.locator('#ica--setupLoad').click();
        await expect(page.locator('#ica--setupStatus')).toHaveAttribute('data-tone', 'error');
        expect(failed).toBe(true);
        const readAgent = async () => (await (await api.post('/api/settings/get', { headers: await headers(page), data: {} })).json()).inChatAgents.find(item => item.id === id);
        expect((await readAgent()).prompt).toBe('Changed after saving');
        await page.locator('#ica--setupLoad').click();
        await expect(page.locator('#ica--setupStatus')).toHaveAttribute('data-tone', 'saved');
        expect(await readAgent()).toMatchObject({ prompt: agent.prompt, settings: agent.settings, customSchema: agent.customSchema });
        expect((await savedPresets()).filter(preset => preset.recoveryFor === presetId)).toEqual([]);
        for (const width of [1280, 1024, 768, 390, 320]) {
            await page.setViewportSize({ width, height: 900 });
            await page.locator('#ica--setupSelect').scrollIntoViewIfNeeded();
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
            await page.screenshot({ path: info.outputPath(`setups-${width}.png`) });
        }
        page.once('dialog', dialog => dialog.accept());
        await page.locator('#ica--setupDelete').click();
        await expect(page.locator('#ica--setupSelect')).toHaveValue('');
        expect((await savedPresets()).some(preset => preset.id === presetId)).toBe(false);
        expect((await readAgent()).prompt).toBe(agent.prompt);
        expect(errors).toEqual([]);
    } finally {
        await page.close();
        await api.post('/api/in-chat-agents/delete', { headers: requestHeaders, data: { id } });
        if (presetId) await api.post('/api/in-chat-agents/presets/delete', { headers: requestHeaders, data: { id: presetId } });
        for (const original of initial.inChatAgents) await api.post('/api/in-chat-agents/save', { headers: requestHeaders, data: original });
        const response = await api.post('/api/settings/get', { headers: requestHeaders, data: {} });
        const settings = JSON.parse((await response.json()).settings);
        if (originalGlobals === undefined) delete settings.extension_settings.inChatAgents.globalSettings;
        else settings.extension_settings.inChatAgents.globalSettings = originalGlobals;
        if (originalSelection === undefined) delete settings.accountStorage['ica--selected-setup'];
        else settings.accountStorage['ica--selected-setup'] = originalSelection;
        expect((await api.post('/api/settings/save', { headers: requestHeaders, data: settings })).ok()).toBe(true);
    }
});

test('setup controls wait for a slow agent library and retry a failed initial load', async ({ page }) => {
    page.setDefaultTimeout(15000);
    await openAgents(page);
    const api = page.request;
    const requestHeaders = await headers(page);
    const initial = await (await api.post('/api/settings/get', { headers: requestHeaders, data: {} })).json();
    const preset = { id: `library-ready-${Date.now()}`, name: 'Library readiness check', version: 1, agents: initial.inChatAgents, globalSettings: {} };
    expect((await api.post('/api/in-chat-agents/presets/save', { headers: requestHeaders, data: preset })).ok()).toBe(true);
    let release;
    let pending = false;
    const held = new Promise(resolve => { release = resolve; });
    try {
        // Several extensions read this shared endpoint during boot. Tag the
        // actual agent-library caller instead of relying on request order.
        await page.addInitScript(() => {
            const fetch = window.fetch;
            window.fetch = function (input, init) {
                if (input === '/api/settings/get' && new Error().stack.includes('/extensions/in-chat-agents/')) {
                    init = { ...init, headers: { ...init?.headers, 'X-Neconyan-Agent-Library-Test': '1' } };
                }
                return fetch.call(this, input, init);
            };
        });
        await page.route('**/api/settings/get', async route => {
            if (pending || route.request().headers()['x-neconyan-agent-library-test'] !== '1') return route.fallback();
            pending = true;
            await held;
            return route.fulfill({ status: 503, body: 'Temporary library failure' });
        });
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await expect.poll(() => pending, { timeout: 45000 }).toBe(true);
        await page.waitForFunction(() => typeof window.NeconyanShell?.openTab === 'function');
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'agents'));
        await expect(page.locator(`#ica--setupSelect option[value="${preset.id}"]`)).toHaveCount(1, { timeout: 15000 });
        await expect(page.locator('#ica--setupSave')).toBeDisabled();
        await expect(page.locator('#ica--setupLoad')).toBeDisabled();
        await expect(page.locator('#ica--setupDelete')).toBeDisabled();
        await expect(page.locator('#ica--setupSelect')).toBeDisabled();
        release();
        await expect(page.locator('#ica--setupRefresh')).toBeVisible();
        await expect(page.locator('#ica--setupSave')).toBeDisabled();
        await expect(page.locator('#ica--setupStatus')).toContainText('could not be loaded');
        const saved = await (await api.post('/api/in-chat-agents/presets/list', { headers: requestHeaders, data: {} })).json();
        expect(saved.find(item => item.id === preset.id).agents).toEqual(initial.inChatAgents);
        await page.locator('#ica--setupRefresh').click();
        await expect(page.locator('#ica--setupSave')).toBeEnabled();
        await expect(page.locator('#ica--setupSelect')).toBeEnabled();
        await expect(page.locator('#ica--setupRefresh')).toBeHidden();
    } finally {
        release();
        await page.close();
        await api.post('/api/in-chat-agents/presets/delete', { headers: requestHeaders, data: { id: preset.id } });
    }
});
