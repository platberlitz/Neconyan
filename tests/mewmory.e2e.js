/* global document, window */
import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { trackNavigationErrors } from './chat-scroll-regression-helpers.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(180000);
// eslint-disable-next-line playwright/no-skipped-test -- This fixture must use an explicitly disposable server.
test.skip(process.env.NECONYAN_MEWMORY_TEST_DISPOSABLE !== '1', 'Use a disposable Neconyan server and the local Mewmory fixture provider.');

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/mewmory-gift.json', import.meta.url), 'utf8'));
const provider = process.env.MEWMORY_FIXTURE_URL || 'http://127.0.0.1:4491/v1';

test('native Mewmory setup, backfill, source inspection, correction, recall and writing work on desktop and mobile', async ({ page }, info) => {
    page.setDefaultTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 1000 });
    const { errors, navigate } = trackNavigationErrors(page);
    await navigate(() => page.goto('/', { waitUntil: 'domcontentloaded' }));
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    await info.attach('frontend-assets', {
        body: Buffer.from(JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('script[src]')].map(script => script.src)))),
        contentType: 'application/json',
    });
    const headers = await page.evaluate(() => window.SillyTavern.getContext().getRequestHeaders());
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
    for (const [name, role] of Object.entries(config.roles)) {
        Object.assign(role, { enabled: name !== 'fallback', endpoint: provider, model: name });
    }
    await post('/api/mewmory/config/save', { config });
    const workspace = page.locator('#mewmory-workspace');
    await page.locator('#neconyan-workspace-rail [data-neconyan-route="mewmory"]').click();
    await expect(workspace.getByRole('tab', { name: 'Now', exact: true })).toBeVisible();
    await workspace.getByRole('tab', { name: 'Settings', exact: true }).click();
    await workspace.getByLabel('Configure role').selectOption('fallback');
    await workspace.getByLabel('Enable this role', { exact: true }).check();
    await workspace.getByRole('button', { name: 'Save configuration', exact: true }).click();
    await expect.poll(async () => (await post('/api/mewmory/config/get')).config.roles.fallback.enabled).toBe(true);
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

    for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
        await workspace.getByRole('tab', { name: 'Settings', exact: true }).click();
        await workspace.getByLabel('Configure role').selectOption('extractor');
        await expect(workspace.getByLabel('OpenAI-compatible endpoint')).toHaveValue(provider);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
        const inputs = workspace.locator('input:not([type="checkbox"]):visible');
        for (let index = 0; index < await inputs.count(); index++) {
            const box = await inputs.nth(index).boundingBox();
            expect(box.x).toBeGreaterThanOrEqual(-1);
            expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
        }
        await workspace.getByRole('tab', { name: 'Pawspective', exact: true }).click();
        await page.screenshot({ path: info.outputPath('mewmory-mobile-' + width + '.png') });
    }

    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
    await page.locator('#main_api').selectOption('openai');
    await page.locator('#chat_completion_source').selectOption('custom');
    await page.locator('#custom_api_url_text').fill(provider);
    await page.locator('#custom_model_id').fill('mewmory-writer');
    await page.evaluate(async () => {
        const { oai_settings } = await import('/scripts/openai.js');
        Object.assign(oai_settings, { openai_max_context: 65536, openai_max_tokens: 512, stream_openai: false });
    });
    await page.locator('#api_button_openai').click();
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).online_status)).not.toBe('no_connection');
    await page.evaluate(() => window.NeconyanShell.closeWorkspace());
    await page.locator('#send_textarea').fill('You really kept the gift?');
    await page.locator('#send_but').click();
    await expect(page.locator('#chat')).toContainText('Of course I kept it.', { timeout: 60000 });
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
    expect(errors).toEqual([]);
});
