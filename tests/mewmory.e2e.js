/* global document, window */
import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { trackNavigationErrors } from './chat-scroll-regression-helpers.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.describe.configure({ mode: 'default' });
test.setTimeout(180000);
// eslint-disable-next-line playwright/no-skipped-test -- This fixture must use an explicitly disposable server.
test.skip(process.env.NECONYAN_MEWMORY_TEST_DISPOSABLE !== '1', 'Use a disposable Neconyan server and the local Mewmory fixture provider.');

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/mewmory-gift.json', import.meta.url), 'utf8'));
const provider = process.env.MEWMORY_FIXTURE_URL || 'http://127.0.0.1:4491/v1';

test('native Mewmory setup, backfill, source inspection, correction, recall and writing work on desktop and mobile', async ({ page }, info) => {
    page.setDefaultTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 900 });
    const { errors, navigate } = trackNavigationErrors(page);
    await navigate(() => page.goto('/', { waitUntil: 'domcontentloaded' }));
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    const skipTour = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
    if (await skipTour.isVisible()) await skipTour.click();
    await expect(page.locator('#neconyan-tour-coachmark')).toHaveCount(0);
    await info.attach('frontend-assets', {
        body: Buffer.from(JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('script[src]')].map(script => script.src)))),
        contentType: 'application/json',
    });
    let headers = await page.evaluate(() => window.SillyTavern.getContext().getRequestHeaders());
    const post = async (route, data = {}) => {
        const response = await page.request.post(route, { headers, data });
        const body = await response.json();
        expect(response.ok(), JSON.stringify(body)).toBe(true);
        return body;
    };
    const suffix = Date.now();
    const created = await page.request.post('/api/characters/create', { headers, data: {
        ch_name: 'Mara Mewmory ' + suffix, description: 'Mara is an archivist with silver eyes and ink-stained fingers.',
        first_mes: fixture.messages[0].mes, mes_example: 'Mara: "Do not make a fuss."',
    } });
    expect(created.ok()).toBe(true);
    const avatar = await created.text();
    const chatName = 'Mewmory gift ' + suffix;
    const locator = { avatar, chat: chatName, group: false };
    const bookName = 'Mewmory lore ' + suffix;
    await page.request.post('/api/worldinfo/edit', { headers, data: { name: bookName, data: { entries: {
        0: { uid: 0, key: ['not-an-active-chat-keyword'], comment: 'True names', content: fixture.lore[0].text, disable: false },
        1: { uid: 1, key: ['gift'], comment: 'Disabled secret', content: fixture.lore[1].text, disable: true },
    } } } });
    await post('/api/chats/save', {
        avatar_url: avatar, file_name: chatName,
        chat: [{ chat_metadata: { world_info: bookName } }, ...fixture.messages],
    });
    await page.evaluate(async ({ avatar, chatName }) => {
        const app = await import('/script.js');
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        await app.openCharacterChat(chatName);
    }, { avatar, chatName });
    const configResult = await post('/api/mewmory/config/get');
    const config = configResult.config;
    config.autoUpdate = false;
    config.batchMessages = 3;
    config.writerTokenizer = 'cl100k_base';
    for (const role of Object.values(config.roles)) {
        Object.assign(role, { enabled: false, endpoint: '', model: '', profileId: '', modelOverride: '', tokenizer: 'auto' });
    }
    const initial = await post('/api/mewmory/config/save', { config });
    await page.evaluate(async endpoint => {
        const { extension_settings } = await import('/scripts/extensions.js');
        const manager = extension_settings.connectionManager;
        manager.profiles = manager.profiles.filter(profile => !profile.id.startsWith('mewmory-test-'));
        for (const name of ['extractor', 'pawspective', 'embedding', 'selector', 'fallback']) {
            manager.profiles.push({ id: 'mewmory-test-' + name, name: 'Mewmory test ' + name, api: 'custom',
                mode: 'cc', 'api-url': endpoint, ...(name === 'embedding' ? {} : { model: name }) });
        }
        await (await import('/script.js')).saveSettings();
    }, provider);
    const workspace = page.locator('#mewmory-workspace');
    await page.locator('#neconyan-workspace-rail [data-neconyan-route="mewmory"]').click();
    await expect(workspace.getByRole('tab', { name: 'Now', exact: true })).toBeVisible();
    await workspace.getByRole('tab', { name: 'Settings', exact: true }).click();
    for (const name of ['extractor', 'pawspective', 'embedding', 'selector', 'fallback']) {
        await workspace.getByLabel('Configure role').selectOption(name);
        await workspace.getByLabel('Enable this role', { exact: true }).check();
        await workspace.getByLabel('Connection profile', { exact: true }).selectOption('mewmory-test-' + name);
        await expect(workspace.getByLabel('Tokenizer for this role')).toHaveValue('auto');
        await expect(workspace.getByLabel('Timeout, seconds', { exact: true })).toHaveValue('300');
    }
    const settingsStatus = workspace.locator('#mewmory-settings-status');
    await expect(settingsStatus).toContainText('Unsaved changes');
    await workspace.getByRole('button', { name: 'Save configuration', exact: true }).click();
    await expect(settingsStatus).toContainText('Not saved: Embeddings:');
    await expect(settingsStatus).toContainText('no saved model');
    expect((await post('/api/mewmory/config/get')).config.revision).toBe(initial.config.revision);
    expect((await post('/api/mewmory/config/get')).config.roles.extractor.enabled).toBe(false);
    await workspace.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(settingsStatus).toContainText('Not saved: Embeddings:');
    await workspace.getByRole('tab', { name: 'Now', exact: true }).click();
    await workspace.getByRole('tab', { name: 'Settings', exact: true }).click();
    await expect(settingsStatus).toContainText('Not saved: Embeddings:');
    await workspace.getByLabel('Configure role').selectOption('embedding');
    await expect(workspace.getByLabel('Enable this role', { exact: true })).toBeChecked();
    await workspace.getByLabel('Model', { exact: true }).fill('text-embedding-3-small');
    await workspace.getByRole('button', { name: 'Save configuration', exact: true }).click();
    await expect(settingsStatus).toHaveText('Configuration saved.');
    await expect(workspace.getByText(/Auto uses gpt-3.5-turbo/)).toBeVisible();
    await navigate(() => page.reload({ waitUntil: 'domcontentloaded' }));
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    headers = await page.evaluate(() => window.SillyTavern.getContext().getRequestHeaders());
    await page.evaluate(async ({ avatar, chatName }) => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        await (await import('/script.js')).openCharacterChat(chatName);
        window.NeconyanShell.openTab('left', 'mewmory');
    }, { avatar, chatName });
    await workspace.getByRole('tab', { name: 'Settings', exact: true }).click();
    await workspace.getByLabel('Configure role').selectOption('embedding');
    await expect(workspace.getByLabel('Model', { exact: true })).toHaveValue('text-embedding-3-small');
    await expect(workspace.getByLabel('Enable this role', { exact: true })).toBeChecked();
    await expect(settingsStatus).toHaveText('Configuration saved.');
    const external = (await post('/api/mewmory/config/get')).config;
    external.batchMessages = 4;
    const changed = await post('/api/mewmory/config/save', { config: external });
    await workspace.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(workspace.getByLabel('Messages per update')).toHaveValue('4');
    await workspace.getByLabel('Messages per update').fill('3');
    changed.config.memoryTokens += 1;
    await post('/api/mewmory/config/save', { config: changed.config });
    await workspace.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(workspace.getByLabel('Messages per update')).toHaveValue('3');
    await expect(settingsStatus).toContainText('Settings were saved elsewhere');
    await workspace.getByRole('button', { name: 'Discard unsaved settings', exact: true }).click();
    await expect(workspace.getByLabel('Messages per update')).toHaveValue('4');
    await workspace.getByLabel('Messages per update').fill('3');
    await workspace.getByRole('button', { name: 'Save configuration', exact: true }).click();
    await expect(settingsStatus).toHaveText('Configuration saved.');
    await workspace.getByLabel('Use Mewmory in this chat').check();
    await workspace.getByRole('tab', { name: 'Now', exact: true }).click();
    await workspace.getByRole('button', { name: 'Update now', exact: true }).click();
    await expect.poll(async () => (await post('/api/mewmory/inspect', { locator })).health.pending, { timeout: 60000 }).toBe(0);
    await workspace.getByRole('tab', { name: 'Pawspective', exact: true }).click();
    await expect(workspace.getByText('Her objection has softened after learning the purchase date. This does not establish complete trust.', { exact: true })).toBeVisible();
    await expect(workspace.getByText('"I do not need pity." She grips the imaginary armchair.', { exact: true })).toBeVisible();
    await workspace.getByRole('button', { name: 'Message 3 · revision 1', exact: true }).first().click();
    await expect(workspace.locator('.mewmory-source-text')).toHaveText(fixture.messages[2].mes);
    await workspace.getByRole('button', { name: 'Close source', exact: true }).click();
    const originalInterview = workspace.locator('.mewmory-record').filter({ hasText: '"I do not need pity." She grips the imaginary armchair.' });
    await originalInterview.getByRole('button', { name: 'Edit', exact: true }).click();
    await workspace.getByLabel('Answer 1', { exact: true }).fill('Author correction: she remains guarded without gripping the armchair.');
    await workspace.getByRole('button', { name: 'Save memory', exact: true }).click();
    await expect(workspace.locator('#mewmory-editor')).toHaveCount(0);
    await workspace.getByRole('tab', { name: 'Now', exact: true }).click();
    await workspace.getByRole('button', { name: 'Update now', exact: true }).click();
    await expect.poll(async () => (await post('/api/mewmory/inspect', { locator })).health.pending, { timeout: 60000 }).toBe(0);
    const corrected = await post('/api/mewmory/inspect', { locator, kind: 'interview' });
    expect(corrected.records.some(record => record.authorOverride && record.interview[0].answer.startsWith('Author correction:'))).toBe(true);
    await workspace.getByRole('button', { name: 'Preview next memory', exact: true }).click();
    await expect(workspace.locator('.mewmory-prompt')).toContainText('Her objection has softened');
    await expect(workspace.locator('.mewmory-prompt')).not.toContainText('INSPECT ONLY');
    await expect(workspace.locator('.mewmory-prompt')).not.toContainText('SEARCH ONLY');
    await workspace.getByRole('tab', { name: 'Recall', exact: true }).click();
    await expect(workspace.getByText(/INSPECT ONLY:/)).toBeVisible();
    await page.screenshot({ path: info.outputPath('mewmory-desktop.png') });
    await workspace.getByRole('tab', { name: 'Archive', exact: true }).click();
    await workspace.getByLabel('Search memories and original passages').fill('true name');
    await workspace.getByRole('button', { name: 'Search archive', exact: true }).click();
    await expect(workspace.getByText(fixture.lore[0].text, { exact: false })).toBeVisible();
    await expect(workspace.getByText('DISABLED:', { exact: false })).toHaveCount(0);

    const touch = await page.context().newCDPSession(page);
    await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    for (const width of [393, 320]) {
        await page.setViewportSize({ width, height: 852 });
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
        await workspace.getByRole('tab', { name: 'Settings', exact: true }).click();
        await workspace.getByLabel('Configure role').selectOption('extractor');
        await expect(workspace.getByLabel('Connection profile', { exact: true })).toHaveValue('mewmory-test-extractor');
        await workspace.getByLabel('Tokenizer for this role').selectOption('cl100k_base');
        await expect(settingsStatus).toContainText('Unsaved changes');
        await workspace.getByRole('button', { name: 'Discard unsaved settings', exact: true }).click();
        await expect(workspace.getByLabel('Tokenizer for this role')).toHaveValue('auto');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
        const inputs = workspace.locator('input:not([type="checkbox"]):visible');
        for (let index = 0; index < await inputs.count(); index++) {
            const box = await inputs.nth(index).boundingBox();
            expect(box.x).toBeGreaterThanOrEqual(-1);
            expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
        }
        const tokenizer = workspace.getByLabel('Tokenizer for this role');
        expect((await tokenizer.boundingBox()).height).toBeGreaterThanOrEqual(44);
        await info.attach('mewmory-controls-' + width, {
            body: Buffer.from(JSON.stringify(await tokenizer.evaluate(element => ({
                fontSize: window.getComputedStyle(element).fontSize,
                height: element.getBoundingClientRect().height,
                touchPoints: window.navigator.maxTouchPoints,
            })))), contentType: 'application/json',
        });
        await workspace.getByRole('tab', { name: 'Pawspective', exact: true }).click();
        await page.screenshot({ path: info.outputPath('mewmory-mobile-' + width + '.png') });
    }

    await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await touch.detach();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
    await page.locator('#main_api').selectOption('openai');
    await page.locator('#chat_completion_source').selectOption('custom');
    await page.locator('#custom_api_url_text').fill(provider);
    await page.locator('#custom_model_id').fill('mewmory-writer');
    await page.evaluate(async () => {
        const { oai_settings } = await import('/scripts/openai.js');
        Object.assign(oai_settings, { openai_max_context: 65536, openai_max_tokens: 512, stream_openai: true });
    });
    await page.locator('#api_button_openai').click();
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).online_status)).not.toBe('no_connection');
    await page.evaluate(() => window.NeconyanShell.closeWorkspace());
    const fixtureUrl = provider.replace(/\/v1$/, '');
    const providerCalls = async () => (await page.request.get(fixtureUrl + '/fixture/calls')).json();
    const sendWhileMemoryBusy = async (message, label, heldRole) => {
        const before = await providerCalls();
        const extractions = before.filter(call => call.model === 'extractor').length;
        const replies = before.filter(call => call.model === 'mewmory-writer').length;
        const recalls = before.filter(call => call.model === heldRole).length;
        const inspections = (await post('/api/mewmory/inspect', { locator })).recalls.map(item => item.id);
        await page.request.post(fixtureUrl + '/fixture/hold', { data: { model: ['extractor', heldRole] } });
        try {
            await page.evaluate(async () => {
                const memory = await import('/scripts/mewmory/index.js');
                void memory.processMewmory({ checkpoint: true });
            });
            await expect.poll(async () => (await providerCalls()).filter(call => call.model === 'extractor').length).toBe(extractions + 1);
            const sentAt = Date.now();
            await page.locator('#send_textarea').fill(message);
            await page.locator('#send_but').click();
            await expect.poll(async () => (await providerCalls()).filter(call => call.model === 'mewmory-writer').length, { timeout: 30000 }).toBe(replies + 1);
            await expect.poll(() => page.evaluate(async () => (await import('/script.js')).is_send_press)).toBe(false);
            await expect(page.locator('#chat .mes').last()).toContainText('Of course I kept it.');
            await page.locator('#chat .mes').last().scrollIntoViewIfNeeded();
            await expect(page.locator('#chat .mes').last()).toBeInViewport();
            await expect.poll(async () => (await providerCalls()).filter(call => call.model === heldRole).length).toBe(recalls + 1);
            const pending = await providerCalls();
            expect(pending.findLast(call => call.model === heldRole).completedAt).toBeNull();
            const writer = pending.findLast(call => call.model === 'mewmory-writer');
            expect(writer.firstTokenAt).toBeGreaterThanOrEqual(sentAt);
            await info.attach('parallel-recall-' + label, { body: JSON.stringify({
                heldRole, sendToFirstTokenMs: writer.firstTokenAt - sentAt,
                visibleReplyWhileRecallHeld: true,
            }), contentType: 'application/json' });
            const during = await post('/api/mewmory/inspect', { locator });
            expect(during.health.jobs.at(-1).status).toBe('processing');
            await page.screenshot({ path: info.outputPath('mewmory-overlap-' + label + '.png') });
        } finally {
            await page.request.post(fixtureUrl + '/fixture/release', { data: {} });
        }
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/mewmory/index.js')).mewmory.busy)).toBe(false);
        await expect.poll(async () => (await post('/api/mewmory/inspect', { locator })).recalls
            .some(item => item.background && item.status === 'complete' && !inspections.includes(item.id))).toBe(true);
        const after = await post('/api/mewmory/inspect', { locator });
        expect(after.health.jobs.at(-1).status).toBe('complete');
        expect(after.recalls.length).toBeGreaterThan(0);
        expect(after.health.pending).toBeGreaterThan(0);
    };
    await sendWhileMemoryBusy('You really kept the gift?', 'desktop', 'selector');
    const overlapTouch = await page.context().newCDPSession(page);
    await overlapTouch.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await page.setViewportSize({ width: 393, height: 852 });
    await sendWhileMemoryBusy('And you still have the receipt?', 'phone', 'text-embedding-3-small');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(394);
    expect((await page.locator('#send_but').boundingBox()).height).toBeGreaterThanOrEqual(44);
    await overlapTouch.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await overlapTouch.detach();
    await page.setViewportSize({ width: 1280, height: 900 });
    const calls = await (await page.request.get(provider.replace(/\/v1$/, '') + '/fixture/calls')).json();
    const writer = calls.findLast(call => call.model === 'mewmory-writer');
    expect(writer).toBeTruthy();
    const writingPrompt = JSON.stringify(writer.messages);
    expect(writingPrompt).toContain('Mewmory: active NPC reference');
    expect(writingPrompt).toContain('Her objection has softened');
    expect(writingPrompt).not.toContain('INSPECT ONLY');
    expect(writingPrompt).not.toContain('SEARCH ONLY');
    const saved = await post('/api/chats/get', { avatar_url: avatar, file_name: chatName });
    expect(saved.slice(1, 8).map(message => message.mes)).toEqual(fixture.messages.map(message => message.mes));
    expect(JSON.stringify(saved)).not.toContain('Mewmory: retrieved story context');
    const callsBeforeOverflow = calls.filter(call => call.model === 'mewmory-writer').length;
    const capacityError = await page.evaluate(async () => {
        const app = await import('/script.js');
        const { oai_settings } = await import('/scripts/openai.js');
        Object.assign(oai_settings, { openai_max_context: 256, openai_max_tokens: 128 });
        try {
            await app.Generate('normal', { suppressUserMessage: true });
            return '';
        } catch (error) {
            return error.message;
        } finally {
            Object.assign(oai_settings, { openai_max_context: 65536, openai_max_tokens: 512 });
        }
    });
    expect(capacityError).not.toBe('');
    const afterOverflow = await (await page.request.get(provider.replace(/\/v1$/, '') + '/fixture/calls')).json();
    expect(afterOverflow.filter(call => call.model === 'mewmory-writer').length).toBe(callsBeforeOverflow);
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
    await page.locator('#main_api').selectOption('textgenerationwebui');
    await page.evaluate(async endpoint => {
        const textgen = await import('/scripts/textgen-settings.js');
        Object.assign(textgen.textgenerationwebui_settings, { type: 'ooba', streaming: false, bypass_status_check: true });
        textgen.textgenerationwebui_settings.server_urls.ooba = endpoint;
        const context = document.getElementById('max_context');
        context.value = '65536';
        context.dispatchEvent(new Event('input', { bubbles: true }));
        const { power_user } = await import('/scripts/power-user.js');
        power_user.tokenizer = 1;
        await textgen.getStatusTextgen();
        await (await import('/script.js')).Generate('normal', { suppressUserMessage: true });
    }, provider);
    const textCalls = await (await page.request.get(provider.replace(/\/v1$/, '') + '/fixture/calls')).json();
    const textWriter = textCalls.findLast(call => call.model === 'text-writer');
    expect(textWriter).toBeTruthy();
    expect(textWriter.prompt).toContain('Mewmory: active NPC reference');
    expect(textWriter.prompt).toContain('Owner: Mara');
    expect(textWriter.prompt).not.toContain('INSPECT ONLY');
    const automatic = (await post('/api/mewmory/config/get')).config;
    automatic.autoUpdate = true;
    await post('/api/mewmory/config/save', { config: automatic });
    const backgroundRequest = page.waitForRequest(request => request.url().endsWith('/api/mewmory/process'));
    await page.evaluate(() => window.dispatchEvent(new Event('mewmory:configured')));
    expect((await backgroundRequest).postDataJSON().checkpoint).toBe(true);
    await expect.poll(async () => (await post('/api/mewmory/inspect', { locator })).health.checkpointPending, { timeout: 60000 }).toBe(0);
    expect(errors).toEqual([]);
});

for (const width of [1280, 393]) {
    test(`native new chats and branches keep the selected Mewmory scope at ${width}px`, async ({ page }, info) => {
        page.setDefaultTimeout(20000);
        await page.setViewportSize({ width, height: width === 393 ? 852 : 900 });
        const touch = await page.context().newCDPSession(page);
        await touch.send('Emulation.setTouchEmulationEnabled', { enabled: width === 393 });
        const { errors, navigate } = trackNavigationErrors(page);
        await navigate(() => page.goto('/', { waitUntil: 'domcontentloaded' }));
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        const skipTour = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
        if (await skipTour.isVisible()) await skipTour.click();
        const headers = await page.evaluate(() => window.SillyTavern.getContext().getRequestHeaders());
        const post = async (url, data = {}) => {
            const response = await page.request.post(url, { headers, data });
            const body = await response.json();
            expect(response.ok(), JSON.stringify(body)).toBe(true);
            return body;
        };
        const config = (await post('/api/mewmory/config/get')).config;
        Object.assign(config, { autoUpdate: false, excludeHistory: false, writerTokenizer: 'cl100k_base' });
        for (const role of Object.values(config.roles)) Object.assign(role, {
            enabled: false, profileId: '', endpoint: '', model: '', modelOverride: '', tokenizer: 'cl100k_base',
        });
        Object.assign(config.roles.selector, { enabled: true, endpoint: provider, model: 'selector' });
        await post('/api/mewmory/config/save', { config });
        const marker = 'Mara promised to keep the brass bookmark.';
        const created = await page.request.post('/api/characters/create', { headers, data: {
            ch_name: `Mara scope ${width} ${Date.now()}`, description: 'Mara is an archivist with silver eyes.', first_mes: marker,
        } });
        expect(created.ok()).toBe(true);
        const avatar = await created.text();
        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        }, avatar);
        const scope = () => page.evaluate(async () => {
            const { getMewmoryLocator, mewmory } = await import('/scripts/mewmory/index.js');
            return { selected: getMewmoryLocator()?.chat, chat: mewmory.view?.locator.chat,
                group: mewmory.view?.locator.group, enabled: mewmory.view?.enabled,
                records: mewmory.view?.recordCount, branchId: mewmory.view?.branchId, error: mewmory.error };
        });
        const workspace = page.locator('#mewmory-workspace');
        const heading = workspace.locator('.mewmory-scope');
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
        await expect(workspace.getByLabel('Use Mewmory in this chat')).toBeVisible();
        const parent = await scope();
        await expect(heading).toHaveText(parent.selected);
        await workspace.getByLabel('Use Mewmory in this chat').check();
        await expect.poll(scope).toMatchObject({ chat: parent.selected, enabled: true, error: '' });
        await page.evaluate(async marker => {
            const { changeMewmory, mewmory } = await import('/scripts/mewmory/index.js');
            const source = mewmory.view.sources.find(source => source.type === 'chat');
            await changeMewmory('record/save', { record: { id: 'event:branch-bookmark', kind: 'event',
                text: marker, subjectIds: ['bookmark'], refs: [{ id: source.id, revision: source.revision }],
                evidenceStatus: 'established', pinned: true } });
        }, marker);
        await page.evaluate(() => window.NeconyanShell.closeWorkspace());
        await page.locator('#chat .mes').first().getByRole('button', { name: 'More message actions', exact: true }).click();
        await page.locator('#chat .mes').first().locator('.mes_create_branch').click();
        await expect.poll(async () => (await scope()).selected).not.toBe(parent.selected);
        const branch = (await scope()).selected;
        await expect.poll(scope).toMatchObject({ chat: branch, enabled: true, records: 1, error: '' });
        expect((await scope()).branchId).not.toBe(parent.branchId);

        // The first reply must inherit memory even though its Mewmory panel has never opened.
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
        await page.locator('#main_api').selectOption('openai');
        await page.locator('#chat_completion_source').selectOption('custom');
        await page.locator('#custom_api_url_text').fill(provider);
        await page.locator('#custom_model_id').fill('mewmory-writer');
        await page.evaluate(async () => Object.assign((await import('/scripts/openai.js')).oai_settings,
            { openai_max_context: 65536, openai_max_tokens: 512, stream_openai: true }));
        await page.locator('#api_button_openai').click();
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).online_status)).not.toBe('no_connection');
        await page.evaluate(() => window.NeconyanShell.closeWorkspace());
        await page.locator('#send_textarea').fill('Did you keep the bookmark?');
        await page.locator('#send_but').click();
        await expect(page.locator('#chat .mes .mes_text').last()).toContainText('Of course I kept it');
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).is_send_press)).toBe(false);
        const calls = await (await page.request.get(provider.replace(/\/v1$/, '') + '/fixture/calls')).json();
        const prompt = JSON.stringify(calls.findLast(call => call.model === 'mewmory-writer').messages);
        expect(prompt).toContain('Mewmory: retrieved story context');
        expect(prompt).toContain(marker);
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
        await expect(heading).toHaveText(branch);
        await expect(workspace.getByLabel('Use Mewmory in this chat')).toBeChecked();

        // Deliver an old inspection after native new-chat navigation has completed.
        const held = Promise.withResolvers();
        const release = Promise.withResolvers();
        let delayed = false;
        const delayPreviousChat = async route => {
            if (!delayed && route.request().postDataJSON().locator.chat === branch) {
                delayed = true;
                const response = await route.fetch();
                held.resolve();
                await release.promise;
                await route.fulfill({ response });
            } else await route.continue();
        };
        await page.route('**/api/mewmory/inspect', delayPreviousChat);
        await page.evaluate(async () => {
            window.mewmoryHeldRefresh = (await import('/scripts/mewmory/index.js')).refreshMewmory();
        });
        await held.promise;
        await page.evaluate(async () => (await import('/script.js')).doNewChat());
        const fresh = (await scope()).selected;
        expect(fresh).not.toBe(branch);
        await expect(heading).toHaveText(fresh);
        await expect.poll(scope).toMatchObject({ chat: fresh, enabled: false, records: 0, error: '' });
        release.resolve();
        await page.evaluate(() => window.mewmoryHeldRefresh);
        await page.unroute('**/api/mewmory/inspect', delayPreviousChat);
        await expect(heading).toHaveText(fresh);
        await expect(workspace.getByLabel('Use Mewmory in this chat')).not.toBeChecked();

        await page.evaluate(async avatar => {
            await (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar);
        }, avatar);
        await expect.poll(async () => (await scope()).selected).toBeUndefined();
        await page.evaluate(async () => {
            await (await import('/scripts/neconyan-conversation/chrome.js')).disableConversationModeForCurrentCharacter();
        });
        await expect.poll(scope).toMatchObject({ selected: fresh, chat: fresh, enabled: false, error: '' });
        await page.evaluate(() => window.NeconyanShell.closeWorkspace());
        await page.evaluate(() => document.getElementById('option_start_new_chat').click());
        await page.locator('.popup-button-ok').click();
        await expect.poll(async () => (await scope()).selected).not.toBe(fresh);
        const closedPanelChat = (await scope()).selected;
        await expect.poll(scope).toMatchObject({ chat: closedPanelChat, enabled: false, error: '' });

        const group = await post('/api/groups/create', {
            name: `Mewmory group ${Date.now()}`, members: [avatar], chat_id: '', chats: [],
        });
        await page.evaluate(async id => {
            const groups = await import('/scripts/group-chats.js');
            await groups.getGroups();
            await groups.openGroupById(id, { switchMenu: false });
        }, group.id);
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
        await expect.poll(scope).toMatchObject({ group: true, enabled: false, error: '' });
        const groupParent = (await scope()).selected;
        await expect(heading).toHaveText(groupParent);
        await workspace.getByLabel('Use Mewmory in this chat').check();
        await expect.poll(scope).toMatchObject({ enabled: true });
        await page.evaluate(async () => (await import('/scripts/bookmarks.js')).branchChat(0));
        await expect.poll(async () => (await scope()).selected).not.toBe(groupParent);
        const groupBranch = (await scope()).selected;
        await expect.poll(scope).toMatchObject({ chat: groupBranch, group: true, enabled: true, error: '' });
        await expect(heading).toHaveText(groupBranch);
        await page.evaluate(async () => (await import('/script.js')).doNewChat());
        await expect.poll(async () => (await scope()).selected).not.toBe(groupBranch);
        const groupFresh = (await scope()).selected;
        await expect.poll(scope).toMatchObject({ chat: groupFresh, group: true, enabled: false, error: '' });
        await expect(heading).toHaveText(groupFresh);
        const geometry = await workspace.evaluate(element => {
            const rect = element.getBoundingClientRect();
            return { width: rect.width, right: rect.right, scrollWidth: document.documentElement.scrollWidth,
                fontSize: window.getComputedStyle(element).fontSize, touchPoints: window.navigator.maxTouchPoints };
        });
        expect(geometry.scrollWidth).toBeLessThanOrEqual(width + 1);
        expect(geometry.right).toBeLessThanOrEqual(width + 1);
        expect(geometry.width).toBeGreaterThan(0);
        await info.attach('native-selection-layout', { body: Buffer.from(JSON.stringify(geometry)), contentType: 'application/json' });
        await info.attach('native-selection', { body: await page.screenshot(), contentType: 'image/png' });
        await touch.detach();
        expect(errors).toEqual([]);
    });
}
