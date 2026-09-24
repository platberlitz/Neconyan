/* global document, window */
import { expect, test } from '@playwright/test';
import { trackNavigationErrors } from './chat-scroll-regression-helpers.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(180000);

async function ready(page, navigate) {
    await navigate(() => page.goto('/', { waitUntil: 'domcontentloaded' }));
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    await expect(page.locator('#ica--run-status')).not.toHaveText('Ready', { timeout: 45000 });
}

async function invoke(page, name, input = {}) {
    return page.evaluate(async ({ name, input }) => {
        const { ToolManager } = await import('/scripts/tool-calling.js');
        return JSON.parse(await ToolManager.invokeFunctionTool(`Neconyan_Assistant_${name}`, JSON.stringify(input)));
    }, { name, input });
}

async function edit(page, name, input, before, after, { cancel = false } = {}) {
    input = { userConfirmed: true, ...input };
    await page.evaluate(({ name, input }) => {
        window.assistantToolSettled = '';
        window.assistantToolResult = import('/scripts/tool-calling.js')
            .then(({ ToolManager }) => ToolManager.invokeFunctionTool(`Neconyan_Assistant_${name}`, JSON.stringify(input)))
            .then(result => { window.assistantToolSettled = result; return result; });
    }, { name, input });
    await expect.poll(() => page.evaluate(() => document.querySelector('.neconyan-assistant-review') ? 'review' : window.assistantToolSettled || 'pending')).toBe('review');
    const popup = page.locator('dialog.popup[open]').filter({ has: page.locator('.neconyan-assistant-review') });
    await expect(popup).toBeVisible();
    await expect(popup.locator('pre').nth(0)).toHaveText(before);
    await expect(popup.locator('pre').nth(1)).toHaveText(after);
    await expect(popup.locator('.neconyan-assistant-review img')).toHaveCount(0);
    await popup.locator(cancel ? '.popup-button-cancel' : '.popup-button-ok').click();
    return page.evaluate(async () => JSON.parse(await window.assistantToolResult));
}

test('an active assistant reviews and persists real lorebook, agent, preset and visible character edits', async ({ page }, info) => {
    page.setDefaultTimeout(20000);
    const { errors, navigate } = trackNavigationErrors(page);
    await page.route(/\/api\/.*\/(?:generate|generate-quiet)(?:\?|$)/, route => route.fulfill({ status: 503, json: { error: 'Model generation is disabled in this fixture.' } }));
    await page.setViewportSize({ width: 1024, height: 900 });
    await ready(page, navigate);
    const api = page.request;
    const headers = await page.evaluate(() => window.SillyTavern.getContext().getRequestHeaders());
    const readSettings = async () => (await api.post('/api/settings/get', { headers, data: {} })).json();
    const original = JSON.parse((await readSettings()).settings);
    const suffix = Date.now();
    const book = ` Assistant book ${suffix}`;
    const agentId = `assistant-agent-${suffix}`;
    const baselineName = `Assistant baseline ${suffix}`;
    const presetName = `Assistant target ${suffix}`;
    let avatar;
    try {
        expect((await api.post('/api/worldinfo/edit', { headers, data: { name: book, data: {
            foreign: 'book metadata', entries: {
                0: { uid: 0, key: ['keyword'], content: 'Old lore', disable: true, order: 100, position: 0, foreign: 'entry metadata' },
                1: { uid: 1, comment: 'Private', content: 'Private entry', agentBlacklisted: true },
            },
        } } })).ok()).toBe(true);
        expect((await api.post('/api/in-chat-agents/save', { headers, data: {
            id: agentId, name: 'Assistant tool agent', category: 'custom', enabled: false, prompt: 'Old agent', foreign: { keep: true },
        } })).ok()).toBe(true);
        const created = await api.post('/api/characters/create', { headers, data: {
            ch_name: `Assistant tool card ${suffix}`, description: 'Old card', first_mes: 'Tool check ready.',
            json_data: JSON.stringify({ data: { extensions: { neconyan_assistant: { id: 'miso-male', version: 2 }, foreign: 'card metadata' } } }),
        } });
        expect(created.ok()).toBe(true);
        avatar = await created.text();
        await ready(page, navigate);
        await page.waitForFunction(avatar => window.SillyTavern.getContext().characters.some(character => character.avatar === avatar), avatar);
        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        }, avatar);
        const toolNames = () => page.evaluate(async () => {
            const { ToolManager } = await import('/scripts/tool-calling.js');
            const payload = {};
            await ToolManager.registerFunctionToolsOpenAI(payload);
            return (payload.tools || []).map(tool => tool.function.name).filter(name => name.startsWith('Neconyan_Assistant_'));
        });
        await expect.poll(async () => (await toolNames()).length).toBe(13);
        expect(await invoke(page, 'ListLorebooks')).toMatchObject({ books: expect.arrayContaining([{ name: book }]) });
        const entries = await invoke(page, 'ListLorebookEntries', { book });
        expect(entries.entries).toHaveLength(1);
        expect(entries.entries[0]).toMatchObject({ uid: 0, title: '', disabled: true });
        expect(await invoke(page, 'ReadLorebookEntry', { book, uid: 1 })).toMatchObject({ status: 'failure' });
        const literal = '<img src=x onerror=alert(1)> &\nKeep every line exactly.';
        expect(await edit(page, 'EditLorebookEntry', { book, uid: 0, field: 'content', value: literal }, 'Old lore', literal, { cancel: true })).toMatchObject({ status: 'cancelled' });
        expect((await (await api.post('/api/worldinfo/get', { headers, data: { name: book } })).json()).entries[0].content).toBe('Old lore');
        expect(await edit(page, 'EditLorebookEntry', { book, uid: 0, field: 'content', value: literal }, 'Old lore', literal)).toMatchObject({ status: 'success', committed: true });
        const savedBook = await (await api.post('/api/worldinfo/get', { headers, data: { name: book } })).json();
        expect(savedBook).toMatchObject({ foreign: 'book metadata', entries: { 0: { content: literal, disable: true, foreign: 'entry metadata' } } });
        expect(await edit(page, 'EditAgent', { id: agentId, field: 'prompt', value: 'New agent instructions' }, 'Old agent', 'New agent instructions')).toMatchObject({ status: 'success', committed: true });
        expect((await readSettings()).inChatAgents.find(agent => agent.id === agentId)).toMatchObject({ prompt: 'New agent instructions', foreign: { keep: true }, enabled: false });
        await page.evaluate(async ({ baselineName, presetName }) => {
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            const manager = getPresetManager('openai');
            await manager.savePreset(baselineName);
            await manager.savePreset(presetName, { ...manager.getPresetSettings(), temperature: 1, foreign: 'preset metadata', custom_include_headers: 'private fixture marker' }, { select: false });
        }, { baselineName, presetName });
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/preset-manager.js')).getPresetManager('openai').hasUnsavedChanges())).toBe(false);
        const readPreset = await invoke(page, 'ReadModelPreset', { apiId: 'openai', name: presetName });
        expect(readPreset.preset).not.toHaveProperty('custom_include_headers');
        expect(await edit(page, 'EditModelPreset', { apiId: 'openai', name: presetName, field: 'temperature', value: 0.73 }, '1', '0.73')).toMatchObject({ status: 'success', committed: true });
        const presetState = await page.evaluate(async name => {
            const manager = (await import('/scripts/preset-manager.js')).getPresetManager('openai');
            return { selected: manager.getSelectedPresetName(), target: manager.getCompletionPresetByName(name) };
        }, presetName);
        expect(presetState).toMatchObject({ selected: baselineName, target: { temperature: 0.73, foreign: 'preset metadata' } });
        await page.evaluate(() => window.NeconyanShell.openTab('characters', 'editor'));
        await page.locator('#sb_character_editor_tab_char_info').click();
        await expect(page.locator('#description_textarea')).toHaveValue('Old card');
        expect(await edit(page, 'EditCharacter', { avatar, field: 'description', value: 'New character instructions' }, 'Old card', 'New character instructions')).toMatchObject({ status: 'success', committed: true, refreshFailed: false });
        await expect(page.locator('#description_textarea')).toHaveValue('New character instructions');
        const savedCard = await (await api.post('/api/characters/get', { headers, data: { avatar_url: avatar } })).json();
        expect(savedCard.data).toMatchObject({ description: 'New character instructions', extensions: { foreign: 'card metadata', neconyan_assistant: { id: 'miso-male' } } });
        await page.screenshot({ path: info.outputPath('assistant-edited-card-1024.png') });
        await page.evaluate(async () => (await import('/script.js')).saveSettings(0, { returnResult: true }));
        await ready(page, navigate);
        const persistedPreset = await page.evaluate(async name => (await import('/scripts/preset-manager.js')).getPresetManager('openai').getCompletionPresetByName(name), presetName);
        expect(persistedPreset).toMatchObject({ temperature: 0.73, foreign: 'preset metadata' });
        expect(errors).toEqual([]);
    } finally {
        await page.close();
        await api.post('/api/worldinfo/delete', { headers, data: { name: book } });
        await api.post('/api/in-chat-agents/delete', { headers, data: { id: agentId } });
        for (const name of [baselineName, presetName]) await api.post('/api/presets/delete', { headers, data: { name, apiId: 'openai' } });
        if (avatar) await api.post('/api/characters/delete', { headers, data: { avatar_url: avatar, delete_chats: true } });
        const current = JSON.parse((await readSettings()).settings);
        for (const key of ['main_api', 'oai_settings', 'active_character', 'active_group']) current[key] = original[key];
        expect((await api.post('/api/settings/save', { headers, data: current })).ok()).toBe(true);
    }
});

test.describe('Assistant update on touch screens', () => {
    test.use({ hasTouch: true });
    test('installs an updated copy from Home while keeping the old card and chat', async ({ page }, info) => {
        page.setDefaultTimeout(20000);
        const { errors, navigate } = trackNavigationErrors(page);
        await page.setViewportSize({ width: 1280, height: 1000 });
        await ready(page, navigate);
        const api = page.request;
        const headers = await page.evaluate(() => window.SillyTavern.getContext().getRequestHeaders());
        const readSettings = async () => JSON.parse((await (await api.post('/api/settings/get', { headers, data: {} })).json()).settings);
        const original = await readSettings();
        const catalog = await (await api.get('/api/characters/assistants')).json();
        const variant = catalog.personalities.flatMap(personality => personality.variants.map(variant => ({ ...variant, name: personality.name }))).find(variant => variant.installed.length === 0);
        expect(variant, 'this disposable profile needs one unused assistant variant').toBeTruthy();
        let avatar;
        let updatedAvatar;
        try {
            const created = await api.post('/api/characters/create', { headers, data: {
                ch_name: `Old assistant ${Date.now()}`, description: 'My edited assistant instructions', first_mes: 'My original greeting',
                json_data: JSON.stringify({ data: { extensions: { neconyan_assistant: { id: variant.id, version: 0 }, foreign: 'keep old metadata' } } }),
            } });
            expect(created.ok()).toBe(true);
            avatar = await created.text();
            const originalCardBytes = await (await api.get(`/characters/${encodeURIComponent(avatar)}`)).body();
            const chatTarget = { avatar_url: avatar, file_name: 'Kept old chat' };
            expect((await api.post('/api/chats/save', { headers, data: { ...chatTarget, chat: [{ chat_metadata: {} }, { name: 'Old assistant', is_user: false, mes: 'Keep this old chat.' }] } })).ok()).toBe(true);
            await ready(page, navigate);
            const update = page.locator(`[data-assistant-update][data-assistant-id="${variant.id}"]`);
            await expect(update).toBeVisible();
            for (const width of [1280, 390, 320]) {
                await page.setViewportSize({ width, height: 1000 });
                await update.scrollIntoViewIfNeeded();
                const box = await update.boundingBox();
                expect(box.height).toBeGreaterThanOrEqual(44);
                const copy = await update.locator('xpath=ancestor::article').locator('.neconyan-assistant-copy').boundingBox();
                expect(copy.width).toBeGreaterThanOrEqual(width >= 768 ? 180 : 120);
                expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
                await page.locator('[data-assistant-picker] img').evaluateAll(images => Promise.all(images
                    .filter(image => image.getBoundingClientRect().top < window.innerHeight)
                    .map(image => image.decode())));
                await page.screenshot({ path: info.outputPath(`assistant-update-${width}.png`) });
            }
            await update.tap();
            let popup = page.locator('dialog.popup[open]').last();
            await expect(popup).toContainText('Your installed card and chats will be kept.');
            await expect(popup).toContainText(variant.name);
            await popup.locator('.popup-button-cancel').tap();
            await expect(update).toBeEnabled();
            await update.tap();
            popup = page.locator('dialog.popup[open]').last();
            const updated = page.waitForResponse(response => response.url().endsWith('/api/characters/assistants/update-copy') && response.request().method() === 'POST');
            await popup.locator('.popup-button-ok').tap();
            const response = await updated;
            expect(response.ok()).toBe(true);
            const result = await response.json();
            updatedAvatar = result.avatar;
            expect(updatedAvatar).not.toBe(avatar);
            await page.waitForFunction(avatar => {
                const context = window.SillyTavern.getContext();
                return context.characters[context.characterId]?.avatar === avatar;
            }, updatedAvatar);
            expect((await (await api.get(`/characters/${encodeURIComponent(avatar)}`)).body()).equals(originalCardBytes)).toBe(true);
            const old = await (await api.post('/api/characters/get', { headers, data: { avatar_url: avatar } })).json();
            expect(old.data).toMatchObject({ description: 'My edited assistant instructions', extensions: { foreign: 'keep old metadata', neconyan_assistant: { version: 1 } } });
            const oldChat = await (await api.post('/api/chats/get', { headers, data: chatTarget })).json();
            expect(oldChat.some(message => message.mes === 'Keep this old chat.')).toBe(true);
            const revised = await (await api.post('/api/characters/get', { headers, data: { avatar_url: updatedAvatar } })).json();
            expect(revised.data.extensions.neconyan_assistant).toMatchObject({ id: variant.id, version: 2 });
            await page.setViewportSize({ width: 1280, height: 1000 });
            await page.locator('#neconyan-workspace-rail [data-neconyan-route="home"]').click();
            await expect(page.locator('[data-neconyan-cat]')).toBeVisible();
            await expect(update).toHaveCount(0);
            expect(errors).toEqual([]);
        } finally {
            await page.close();
            if (updatedAvatar) await api.post('/api/characters/delete', { headers, data: { avatar_url: updatedAvatar, delete_chats: true } });
            if (avatar) await api.post('/api/characters/delete', { headers, data: { avatar_url: avatar, delete_chats: true } });
            const current = await readSettings();
            current.extension_settings.expressionOverrides = original.extension_settings.expressionOverrides;
            for (const key of ['active_character', 'active_group']) current[key] = original[key];
            for (const key of ['assistant', 'neconyanAssistantVariant']) {
                if (original.accountStorage[key] === undefined) delete current.accountStorage[key];
                else current.accountStorage[key] = original.accountStorage[key];
            }
            expect((await api.post('/api/settings/save', { headers, data: current })).ok()).toBe(true);
        }
    });
});
