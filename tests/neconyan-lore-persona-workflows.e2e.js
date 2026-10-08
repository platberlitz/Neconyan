/* global document, window */
import { expect } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import { openPersonaEditor, trackNavigationErrors } from './chat-scroll-regression-helpers.js';
import { test } from './neconyan-conversation-durable-fixture.js';

test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(90000);

async function appApi(page, route, body = {}) {
    return page.evaluate(async ({ route: apiRoute, body: apiBody }) => {
        const { getRequestHeaders } = await import('/script.js');
        const response = await fetch(apiRoute, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(apiBody),
        });
        if (!response.ok) throw new Error(`${apiRoute}: ${response.status}`);
        return response.json();
    }, { route, body });
}

async function openWorkspace(page, tab) {
    await page.evaluate(target => window.NeconyanShell.openTab('characters', target), tab);
    await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', tab);
}

async function openBook(page, name) {
    const selected = await page.locator('#world_editor_select').evaluate(element => element.selectedOptions[0]?.textContent);
    if (selected === name && await page.locator('#world_popup_entries_list').isVisible()) return;
    const back = page.locator('.neconyan-lorebook-back');
    if (await back.isVisible()) await back.click();
    await page.locator('.neconyan-lorebook-book-open').filter({ hasText: name }).click();
}

async function enableLock(button) {
    if (await button.getAttribute('aria-pressed') === 'true') await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
}

async function selectFixtureCharacter(page, avatar) {
    await page.waitForFunction(target => {
        const context = window.SillyTavern?.getContext?.();
        return document.body.classList.contains('neconyan-rail-ready')
            && context?.characters?.some(character => character.avatar === target);
    }, avatar);
    await page.evaluate(async target => {
        const context = window.SillyTavern.getContext();
        const id = context.characters.findIndex(character => character.avatar === target);
        if (id < 0 || !await context.selectCharacterById(id, { switchMenu: false })) {
            throw new Error('Could not open the fixture character');
        }
    }, avatar);
}

test('Lorebooks and Personas preserve edits, controls, and narrow layouts', async ({ app }, testInfo) => {
    test.setTimeout(180000);
    const account = await app.account();
    const saved = JSON.parse((await account.post('/api/settings/get')).settings);
    saved.power_user.personas[account.personaId] = 'Workshop visitor';
    saved.power_user.persona_descriptions[account.personaId] = {
        description: 'Repairs radios.', position: 0, depth: 4, role: 0,
        connections: [{ type: 'character', id: account.avatar }],
    };
    await account.post('/api/settings/save', saved);
    await account.post('/api/worldinfo/edit', { name: 'Audit workshop fixture', data: { entries: {
        0: { uid: 0, key: ['workshop'], keysecondary: [], content: 'A small repair workshop.', comment: 'Workshop',
            constant: false, selective: false, disable: false, order: 100, position: 0, depth: 4, probability: 100, useProbability: true },
    } } });
    const page = await account.open({ workspace: false });
    await page.setViewportSize({ width: 1280, height: 844 });

    const settingsResponse = await appApi(page, '/api/settings/get');
    const originalSettings = JSON.parse(settingsResponse.settings);
    const listedWorlds = await appApi(page, '/api/worldinfo/list');
    const worldNames = Array.isArray(settingsResponse.world_names)
        ? settingsResponse.world_names
        : (Array.isArray(listedWorlds) ? listedWorlds.map(item => item.file_id ?? item.name).filter(Boolean) : []);
    const worldName = worldNames.find(name => /Audit workshop/i.test(name)) ?? worldNames[0];
    expect(worldName, 'fixture must contain a lorebook').toBeTruthy();
    const originalBook = await appApi(page, '/api/worldinfo/get', { name: worldName });
    const avatarId = originalSettings.user_avatar ?? Object.keys(originalSettings.power_user?.personas ?? {})[0];
    expect(avatarId, 'fixture must contain a persona').toBeTruthy();
    const marker = `Neconyan browser edit ${Date.now()}`;
    const originalPersona = structuredClone(originalSettings.power_user.persona_descriptions?.[avatarId]);
    const characterConnection = originalPersona?.connections?.find(connection => connection.type === 'character');
    expect(characterConnection?.id, 'fixture must contain a character persona connection').toBeTruthy();
    await selectFixtureCharacter(page, characterConnection.id);

    const chatTarget = await page.evaluate(() => {
        const context = window.SillyTavern.getContext();
        const character = context.characters[context.characterId];
        return { avatar_url: character.avatar, file_name: character.chat };
    });
    const auditBook = structuredClone(originalBook);
    const extraUid = Math.max(-1, ...Object.keys(auditBook.entries).map(Number)) + 1;
    auditBook.entries[extraUid] = {
        ...structuredClone(Object.values(auditBook.entries)[0]),
        uid: extraUid,
        comment: 'Second entry selection check',
        content: 'Second entry selection check',
    };
    await appApi(page, '/api/worldinfo/edit', { name: worldName, data: auditBook });
    await page.evaluate(async name => (await import('/scripts/world-info.js')).worldInfoCache.delete(name), worldName);
    await openWorkspace(page, 'world-info');
    await expect(page.locator('#world_editor_select option').nth(1)).toBeAttached({ timeout: 30000 });
    await openBook(page, worldName);
    await expect(page.locator('#world_popup_entries_list .world_entry').first()).toBeVisible({ timeout: 30000 });

    const firstEntry = page.locator('#world_popup_entries_list .world_entry').first();
    const editedEntryUid = await firstEntry.getAttribute('uid');
    const secondEntry = page.locator(`#world_popup_entries_list .world_entry[uid="${extraUid}"]`);
    await secondEntry.locator('button.inline-drawer-toggle span').click();
    await expect(page.locator('#world_popup_editor_host textarea[name="content"]')).toHaveValue('Second entry selection check');
    await firstEntry.locator('button.inline-drawer-toggle').click();
    const content = page.locator('#world_popup_editor_host textarea[name="content"]');
    await expect(content).toBeVisible({ timeout: 15000 });
    const worldSave = page.waitForResponse(response => response.url().includes('/api/worldinfo/edit') && response.ok(), { timeout: 15000 });
    await content.fill(marker);

    await openWorkspace(page, 'persona');
    await openWorkspace(page, 'world-info');
    await openBook(page, worldName);
    await expect(page.locator('#world_popup_entries_list .world_entry').first()).toBeVisible({ timeout: 30000 });
    await page.locator('#world_popup_entries_list .world_entry').first().locator('button.inline-drawer-toggle').click();
    await worldSave;
    await expect(page.locator('#world_popup_editor_host textarea[name="content"]')).toHaveValue(marker, { timeout: 15000 });

    await openWorkspace(page, 'persona');
    await openPersonaEditor(page);
    await expect(page.locator('#persona_selected_masthead #persona_selected_avatar')).toBeVisible();
    await expect(page.locator('#persona_selected_masthead #persona_rename_button')).toBeVisible();
    await expect(page.locator('#persona_selected_masthead #persona_set_image_button')).toBeVisible();
    const description = page.locator('#persona_description');
    await description.fill(`Repairs radios. ${marker}`);
    await page.locator('#persona_description_position').selectOption('4');
    await page.locator('#persona_depth_value').fill('7');
    await page.locator('#persona_depth_role').selectOption('2');
    await page.locator('#persona_lore_choose_button').click();
    const loreDialog = page.locator('dialog[open]');
    await expect(loreDialog.locator('select.persona_world_info_selector')).toBeVisible();
    await loreDialog.locator('select.persona_world_info_selector').selectOption({ label: worldName });
    await loreDialog.locator('.popup-button-ok').click();

    await openPersonaEditor(page, 'connections');
    await enableLock(page.locator('#lock_persona_default'));
    await enableLock(page.locator('#lock_user_name'));
    const characterLock = page.locator('#lock_persona_to_char');
    await expect(characterLock).toBeEnabled();
    await enableLock(characterLock);
    await expect(page.locator('#lock_persona_default')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#lock_user_name')).toHaveAttribute('aria-pressed', 'true');

    await expect.poll(async () => JSON.parse((await appApi(page, '/api/settings/get')).settings), { timeout: 15000 }).toMatchObject({
        power_user: {
            persona_descriptions: {
                [avatarId]: {
                    description: `Repairs radios. ${marker}`,
                    position: 4,
                    depth: 7,
                    role: 2,
                    lorebook: worldName,
                },
            },
            default_persona: avatarId,
        },
    });
    const persistedSettings = JSON.parse((await appApi(page, '/api/settings/get')).settings);
    expect(persistedSettings.power_user.persona_descriptions[avatarId]).toMatchObject({ description: `Repairs radios. ${marker}` });
    expect(persistedSettings.power_user.persona_descriptions[avatarId].connections).toContainEqual(characterConnection);
    expect(persistedSettings.power_user.default_persona).toBe(avatarId);
    await expect.poll(async () => (await appApi(page, '/api/chats/get', chatTarget))[0]?.chat_metadata?.persona).toBe(avatarId);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('preloader'), null, { timeout: 60000 });
    await selectFixtureCharacter(page, characterConnection.id);
    await openWorkspace(page, 'persona');
    await openPersonaEditor(page);
    await expect(page.locator('#persona_description')).toHaveValue(`Repairs radios. ${marker}`);
    await expect(page.locator('#persona_lore_status')).toHaveText(worldName);
    await expect(page.locator('#persona_description_position')).toHaveValue('4');
    await expect(page.locator('#persona_depth_value')).toHaveValue('7');
    await expect(page.locator('#persona_depth_role')).toHaveValue('2');
    await openPersonaEditor(page, 'connections');
    for (const id of ['lock_persona_default', 'lock_user_name', 'lock_persona_to_char']) {
        await expect(page.locator(`#${id}`)).toHaveAttribute('aria-pressed', 'true');
    }
    await openPersonaEditor(page, 'tools');
    for (const selector of ['#sync_name_button', '#persona_to_character_button', '#persona_duplicate_button', '#persona_delete_button', '.user_stats_button', '#personas_backup', '#personas_restore']) {
        await expect(page.locator('#persona_editor_panel_tools').locator(selector)).toBeVisible();
    }

    for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        for (const tab of ['persona', 'world-info']) {
            await openWorkspace(page, tab);
            if (tab === 'persona') {
                await openPersonaEditor(page);
                if (width < 769) await page.getByRole('tab', { name: 'Browse', exact: true }).click();
                await expect(page.locator('#create_dummy_persona > span')).toBeVisible();
                // The rebuilt library keeps search, sort and the grid toggle on one row; touch screens raise the 40px controls to 44px.
                for (const selector of ['#create_dummy_persona', '#persona_search_bar', '#persona_sort_order', '#persona_grid_toggle']) {
                    const control = await page.locator(selector).boundingBox();
                    expect(control.width).toBeGreaterThanOrEqual(selector === '#persona_search_bar' ? 100 : 40);
                    expect(control.height).toBeGreaterThanOrEqual(40);
                    expect(control.x + control.width).toBeLessThanOrEqual(width);
                }
                await page.screenshot({ path: testInfo.outputPath(`persona-library-${width}.png`) });
                await openPersonaEditor(page);
            } else {
                await openBook(page, worldName);
                const entry = page.locator('#world_popup_entries_list .world_entry').first();
                await expect(entry).toBeVisible();
                const editedContent = page.locator(`#WorldInfo textarea[id="world_entry_content_${editedEntryUid}"]`);
                if (!(await editedContent.isVisible())) {
                    await entry.locator('button.inline-drawer-toggle').click();
                }
                await expect(editedContent).toHaveValue(marker);
            }
            const layout = await page.evaluate(currentTab => {
                const box = selector => document.querySelector(selector)?.getBoundingClientRect().toJSON();
                const header = box('#right-nav-panel .sb-character-shell-header');
                const close = box('#right-nav-panel .sb-character-shell-header .sb-shell-close');
                const mode = box('#sb_character_mode_toggle');
                const actions = currentTab === 'world-info'
                    ? [...document.querySelectorAll('#world_popup_entries_list .WIEntryHeaderActions .menu_button, #world_popup_entries_list .WIEntryHeaderMain button, #world_popup_entries_list .WIEntryTitleAndStatus :is(select, textarea)')]
                        .filter(element => element.getClientRects().length)
                        .map(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height, clipped: element.scrollWidth > element.clientWidth + 1 }))
                    : [];
                return { header, close, mode, actions, list: box('#world_popup_entries_column'), editor: box('#world_popup_editor_pane') };
            }, tab);
            if (width < 769) {
                // Neconyan's phone header contains only the 44 px close target.
                expect(layout.header.height).toBeGreaterThanOrEqual(44);
                expect(layout.close.width).toBeGreaterThanOrEqual(44);
                expect(layout.close.height).toBeGreaterThanOrEqual(44);
                expect(layout.close.top).toBeGreaterThanOrEqual(layout.header.top);
                expect(layout.close.bottom).toBeLessThanOrEqual(layout.header.bottom);
                if (layout.mode.width > 0) {
                    expect(layout.mode.top).toBeGreaterThanOrEqual(layout.header.top);
                    expect(layout.mode.bottom).toBeLessThanOrEqual(layout.header.bottom);
                    expect(layout.mode.right).toBeLessThanOrEqual(layout.close.left);
                }
            }
            if (tab === 'persona') {
                await expect(page.locator('#persona_pagination_container')).toBeHidden();
                // The tab strip stays in the document flow so it never covers the editor while scrolling.
                expect(['static', 'relative']).toContain(await page.locator('.persona-workspace-tabs').evaluate(element => window.getComputedStyle(element).position));
                if (width < 769) {
                    const tabs = await page.locator('.persona-workspace-tabs button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().top));
                    expect(tabs[0]).toBe(tabs[1]);
                }
            } else {
                await expect(page.locator('#world_info_pagination')).toBeHidden();
                await expect(page.locator('#WIEntryHeaderTitlesPC')).toHaveCount(0);
                if (width === 1280) expect(layout.list.right).toBeLessThanOrEqual(layout.editor.left);
                expect(layout.actions.length).toBeGreaterThan(0);
                for (const action of layout.actions) {
                    expect(action.width).toBeGreaterThanOrEqual(44);
                    expect(action.height).toBeGreaterThanOrEqual(44);
                    expect(action.clipped).toBe(false);
                }
                const libraryTools = page.locator('details.world_popup_action_group--library');
                await expect(libraryTools).toHaveJSProperty('open', false);
                await libraryTools.locator('summary').click();
                await expect(page.locator('#world_popup_export')).toBeVisible();
                await libraryTools.locator('summary').click();
                const entryTools = page.locator('.world_popup_action_group_details');
                await entryTools.locator('summary').click();
                if (width === 1280) {
                    await expect(page.locator('#OpenAllWIEntries')).toBeHidden();
                    await expect(page.locator('#CloseAllWIEntries')).toBeHidden();
                } else {
                    await page.locator('#CloseAllWIEntries').click();
                    await expect(page.locator('#world_popup_entries_list textarea[name="content"]:visible')).toHaveCount(0);
                    await page.locator('#OpenAllWIEntries').click();
                    await expect(page.locator('#world_popup_entries_list textarea[name="content"]:visible').first()).toBeVisible();
                }
                await entryTools.locator('summary').click();
                await page.locator('#world_popup_entries_list .world_entry').first().scrollIntoViewIfNeeded();
            }
            const overflow = await page.evaluate(() => {
                const panel = document.querySelector('#right-nav-panel');
                return {
                    document: document.documentElement.scrollWidth > document.documentElement.clientWidth,
                    panel: panel ? panel.scrollWidth > panel.clientWidth : false,
                };
            });
            expect(overflow).toEqual({ document: false, panel: false });
            await page.screenshot({ path: testInfo.outputPath(`${tab}-${width}.png`), fullPage: false });
        }
    }

    for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
        const shell = page.locator('.sb-shell-root-right.openDrawer');
        await expect(shell).toBeVisible();
        const header = await shell.locator('.sb-shell-header').boundingBox();
        const close = await shell.locator('.sb-shell-close').boundingBox();
        if (width === 1280) {
            const nav = await shell.locator('.sb-shell-nav-wrapper').boundingBox();
            expect(nav.width).toBeGreaterThanOrEqual(200);
            const label = await shell.locator('.sb-shell-tab-copy').first().boundingBox();
            expect(label.width).toBeGreaterThanOrEqual(100);
        } else {
            expect(close.y).toBeGreaterThanOrEqual(header.y);
            expect(close.y + close.height).toBeLessThanOrEqual(header.y + header.height);
            expect(close.height).toBeGreaterThanOrEqual(44);
        }
        await page.screenshot({ path: testInfo.outputPath(`settings-${width}.png`) });
    }
});

test('native Lorebook folders keep drafts and membership through failure, rename, reload and deletion', async ({ page }, info) => {
    test.setTimeout(180000);
    page.setDefaultTimeout(15000);
    const { errors, navigate } = trackNavigationErrors(page);
    await page.route(/\/api\/.*\/(?:generate|generate-quiet)(?:\?|$)/, route => route.fulfill({ status: 503, json: { error: 'No model calls in this check.' } }));
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    const initial = JSON.parse((await appApi(page, '/api/settings/get')).settings);
    const originalFolders = structuredClone(initial.world_info_settings.world_info.neconyanFolders);
    const name = `Native book ${Date.now()}`;
    const renamed = `${name} renamed`;
    let folderName = `Places ${Date.now()}`;
    const headers = await page.evaluate(() => window.SillyTavern.getContext().getRequestHeaders());
    const api = page.request;
    const book = { unknown: { keep: true }, entries: { 0: { uid: 0, key: ['audit'], comment: 'A note', content: 'Original note', constant: false, disable: false, order: 100, position: 0, unknown: 'keep entry metadata' } } };
    let renamedOnDisk = false;
    try {
        expect((await api.post('/api/worldinfo/edit', { headers, data: { name, data: book } })).ok()).toBe(true);
        await navigate(() => page.reload({ waitUntil: 'domcontentloaded' }));
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await openWorkspace(page, 'world-info');
        const library = page.locator('#neconyan-lorebook-library');
        await expect(library).toHaveAttribute('data-view', 'library');
        await expect(page.locator('#world_popup')).toBeHidden();
        page.once('dialog', dialog => dialog.accept(folderName));
        await library.getByRole('button', { name: 'New folder', exact: true }).click();
        const savedFolders = async () => JSON.parse((await appApi(page, '/api/settings/get')).settings).world_info_settings.world_info.neconyanFolders;
        await expect.poll(async () => (await savedFolders()).folders.some(folder => folder.name === folderName)).toBe(true);
        const folderId = (await savedFolders()).folders.find(folder => folder.name === folderName).id;
        const renamedFolder = `${folderName} renamed`;
        page.once('dialog', dialog => dialog.accept(renamedFolder));
        await library.locator('.neconyan-lorebook-folder-item').filter({ hasText: folderName }).getByRole('button', { name: 'Rename', exact: true }).click();
        await expect.poll(async () => (await savedFolders()).folders.find(folder => folder.id === folderId)?.name).toBe(renamedFolder);
        folderName = renamedFolder;
        const assignment = library.getByRole('combobox', { name: `Folder for ${name}`, exact: true });
        let failedMove = false;
        await page.route('**/api/settings/save', async route => {
            let bytes = route.request().postDataBuffer();
            if (route.request().headers()['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
            const payload = JSON.parse(bytes.toString());
            if (!failedMove && payload.world_info_settings?.world_info?.neconyanFolders?.assignments?.[name] === folderId) {
                failedMove = true;
                return route.fulfill({ status: 503, json: { error: 'Temporary settings failure' } });
            }
            return route.continue();
        });
        await assignment.selectOption(folderId);
        await expect.poll(() => failedMove).toBe(true);
        await expect(assignment).toHaveValue('');
        expect((await savedFolders()).assignments[name]).toBeUndefined();
        await page.unroute('**/api/settings/save');
        await assignment.selectOption(folderId);
        await expect.poll(async () => (await savedFolders()).assignments[name]).toBe(folderId);
        await library.getByRole('button', { name: `Open ${name}`, exact: true }).click();
        await expect(library).toHaveAttribute('data-view', 'book');
        await expect(library.locator('.neconyan-lorebook-books')).toBeHidden();
        const entry = page.locator('#world_popup_entries_list .world_entry').first();
        await entry.locator('button.inline-drawer-toggle').click();
        const content = page.locator('#WorldInfo textarea[name="content"]:visible').first();
        await content.fill('Draft kept while browsing folders.');
        await library.getByRole('button', { name: 'Back to library', exact: true }).click();
        await expect(library).toHaveAttribute('data-view', 'library');
        await library.getByRole('searchbox', { name: 'Search lorebooks' }).fill(name);
        await library.getByRole('button', { name: `Open ${name}`, exact: true }).click();
        await expect(library).toHaveAttribute('data-view', 'book');
        await expect(page.locator('#WorldInfo textarea[name="content"]:visible').first()).toHaveValue('Draft kept while browsing folders.');
        await library.locator('.world_popup_action_group--library > summary').click();
        await page.locator('#world_popup_name_button').click();
        const popup = page.locator('dialog.popup[open]').last();
        await popup.getByRole('textbox').fill(renamed);
        await popup.locator('.popup-button-ok').click();
        await expect.poll(async () => (await savedFolders()).assignments[renamed]).toBe(folderId);
        renamedOnDisk = true;
        expect((await savedFolders()).assignments[name]).toBeUndefined();
        await navigate(() => page.reload({ waitUntil: 'domcontentloaded' }));
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await openWorkspace(page, 'world-info');
        await expect(library.getByRole('combobox', { name: `Folder for ${renamed}`, exact: true })).toHaveValue(folderId);
        for (const width of [1280, 1024, 997, 768, 390, 320]) {
            await page.setViewportSize({ width, height: 900 });
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
            await expect(library.getByRole('button', { name: `Open ${renamed}`, exact: true })).toBeVisible();
            await page.screenshot({ path: info.outputPath(`folders-${width}.png`) });
        }
        const folder = library.locator('.neconyan-lorebook-folder-item').filter({ hasText: folderName });
        await folder.locator('.neconyan-lorebook-folder').click();
        page.once('dialog', dialog => dialog.accept());
        await folder.getByRole('button', { name: 'Delete', exact: true }).click();
        await expect.poll(async () => (await savedFolders()).folders.some(item => item.id === folderId)).toBe(false);
        await expect(library.getByRole('button', { name: `Open ${renamed}`, exact: true })).toBeVisible();
        const preserved = await appApi(page, '/api/worldinfo/get', { name: renamed });
        expect(preserved.unknown).toEqual({ keep: true });
        expect(preserved.entries[0]).toMatchObject({ content: 'Draft kept while browsing folders.', unknown: 'keep entry metadata' });
        expect(errors).toEqual([]);
    } finally {
        await page.close();
        await api.post('/api/worldinfo/delete', { headers, data: { name: renamedOnDisk ? renamed : name } });
        await api.post('/api/worldinfo/delete', { headers, data: { name: renamedOnDisk ? name : renamed } });
        const current = await api.post('/api/settings/get', { headers, data: {} });
        const settings = JSON.parse((await current.json()).settings);
        if (originalFolders === undefined) delete settings.world_info_settings.world_info.neconyanFolders;
        else settings.world_info_settings.world_info.neconyanFolders = originalFolders;
        expect((await api.post('/api/settings/save', { headers, data: settings })).ok()).toBe(true);
    }
});
