/* eslint-env browser */
import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(240000);

const ANSWER = 'The native reply remembered the lunar garden.';
const LORE = 'Vector-only lunar garden: the roses grow under glass.';

async function prepare(app, phone, world = false) {
    app.provider.mode.hold = [undefined];
    app.provider.mode.reply = body => body.input ? {
        data: (Array.isArray(body.input) ? body.input : [body.input]).map((_, index) => ({ index, embedding: [1, 0] })),
    } : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: ANSWER } }] };
    const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
        saved.oai_settings.openai_max_context = 8192;
        saved.oai_settings.openai_max_tokens = 256;
        saved.extension_settings.vectors = { source: 'llamacpp', use_alt_endpoint: true, alt_endpoint_url: app.provider.url,
            enabled_chats: false, enabled_files: false, enabled_world_info: world, enabled_for_all: false,
            summarize: false, protect: 1, insert: 2, message_chunk_size: 400, score_threshold: 0.5, max_entries: 5 };
        if (world) saved.world_info_settings = { ...saved.world_info_settings, world_info: { globalSelect: ['Vector Garden'] } };
    } });
    if (world) await account.post('/api/worldinfo/edit', { name: 'Vector Garden', data: { entries: {
        7: { uid: 7, key: ['not-mentioned-in-the-chat'], keysecondary: [], comment: 'Vector garden', content: LORE,
            disable: false, constant: false, selective: false, vectorized: true, position: 0, order: 100, probability: 100 },
    } } });
    const fields = { avatar_url: account.avatar, file_name: `Vector source ${world ? 'reply' : 'manual'}` };
    const response = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { ...fields, allow_create: true } });
    expect(response.ok(), await response.text()).toBe(true);
    const vacancy = JSON.parse(response.headers()['x-neconyan-roleplay']);
    const records = [{ user_name: 'User', character_name: 'Durable Nova', chat_metadata: { retained: true } },
        { name: 'Durable Nova', is_user: false, mes: 'Retained answer.', extra: {},
            swipes: ['Retained answer.', 'Retained alternative.'], swipe_id: 0 },
        { name: 'User', is_user: true, mes: 'Retained question.', extra: {} }];
    await account.post('/api/chats/save', { ...fields, chat: records,
        roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() } });
    const root = path.join(app.directory, 'data/default-user');
    const filename = path.join(root, 'chats', account.avatar.replace(/\.png$/i, ''), fields.file_name + '.jsonl');
    const index = path.join(root, 'vectors/llamacpp', fields.file_name, 'index.json');
    if (!world) {
        await fs.mkdir(path.dirname(index), { recursive: true });
        await fs.writeFile(index, JSON.stringify({ version: 1, metadata_config: {}, items: [
            { id: 'old-index-item', metadata: { hash: 999, text: 'Old index still usable.', index: 99 }, vector: [1, 0], norm: 1 },
        ] }));
    }
    return { account, fields, records, index, read: async () => (await fs.readFile(filename, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}

async function openChat(fixture) {
    const page = await fixture.account.open({ workspace: false, readyTimeout: 60000 });
    await page.evaluate(async ({ avatar_url, file_name }) => {
        const context = window.SillyTavern.getContext();
        const core = await import('/script.js');
        await context.getCharacters();
        await core.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar_url), { switchMenu: false });
        if (core.getCurrentChatId() !== file_name) await core.openCharacterChat(file_name);
    }, fixture.fields);
    await expect(page.locator('#chat .mes').first()).toContainText('Retained answer.');
    return page;
}

async function vectorControls(page, tab = 'work') {
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'extensions'));
    await page.getByRole('group', { name: 'Extension settings scope' }).getByRole('button', { name: 'Built-in', exact: true }).click();
    const container = page.locator('#vectors_container');
    const select = container.getByLabel('Saved vector work', { exact: true });
    if (!await container.locator('.vectors-nav').isVisible()) await container.locator('.inline-drawer-toggle').click();
    await container.locator(`[data-vectors-tab="${tab}"]`).click();
    await expect(container.locator(`#vectors-panel-${tab}`)).toBeVisible();
    const geometry = await container.locator('.vectors-nav').evaluate(element => ({ width: element.getBoundingClientRect().width, display: getComputedStyle(element).display }));
    expect(geometry.width).toBeGreaterThan(100);
    expect(geometry.display).not.toBe('none');
    return { container, select };
}

async function closeEveryPage(page, browser) {
    await page.close();
    expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`${viewport} Vectorization supports a Miso walkthrough, keyboard tabs and read-only scored search`, async ({ app }, info) => {
        const fixture = await prepare(app, phone);
        app.provider.mode.hold = [];
        const page = await openChat(fixture);
        const { container } = await vectorControls(page, 'connection');
        await expect(container.locator('[data-vectors-state]')).toContainText('Retrieval is off');
        await container.locator('#vectors_score_threshold').fill('0.333');
        await expect(container.locator('#vectors_score_threshold')).toHaveAttribute('aria-invalid', 'false');
        expect(await page.evaluate(() => window.SillyTavern.getContext().extensionSettings.vectors.score_threshold)).toBe(0.333);
        await container.locator('[data-vectors-miso]').scrollIntoViewIfNeeded();
        await expect(container.locator('[data-vectors-miso]')).toBeVisible();
        await expect.poll(() => container.locator('[data-vectors-miso]').evaluate(image => image.naturalWidth), { timeout: 15000 }).toBeGreaterThan(0);
        const geometry = await container.locator('.vectors-workspace').evaluate(element => ({
            width: element.getBoundingClientRect().width, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
            ink: getComputedStyle(element).color,
            targets: [...element.querySelectorAll('[role="tab"]')].map(button => button.getBoundingClientRect().height),
        }));
        expect(geometry.width).toBeGreaterThan(250);
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
        expect(geometry.targets.every(height => height >= 44)).toBe(true);
        await info.attach('Vectorization geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
        await container.locator('header').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `/tmp/opencode/vectorization-${viewport}-connection.png` });

        await container.getByRole('button', { name: 'Learn with Miso', exact: true }).click();
        await expect(container.locator('[data-vectors-guide-title]')).toBeFocused();
        await expect(container.locator('[data-vectors-guide-copy] p')).toHaveCount(2);
        await container.locator('[data-vectors-guide-next]').click();
        await container.locator('[data-vectors-guide-next]').click();
        await expect(container.getByRole('tab', { name: 'Chats', exact: true })).toHaveAttribute('aria-selected', 'true');
        await expect(container.locator('[data-vectors-guide-copy]')).toContainText('Rebuild chat');
        await container.locator('.vectors-guide').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `/tmp/opencode/vectorization-${viewport}-miso.png` });
        await container.locator('[data-vectors-guide-close]').click();
        await container.getByRole('button', { name: 'Continue with Miso', exact: true }).click();
        await expect(container.locator('[data-vectors-guide-progress]')).toHaveText('Step 3 of 7');
        for (let i = 0; i < 4; i++) await container.locator('[data-vectors-guide-next]').click();
        await expect(container.getByRole('tab', { name: 'Saved work', exact: true })).toHaveAttribute('aria-selected', 'true');
        await container.getByRole('button', { name: 'Finish', exact: true }).click();
        await expect(container.getByRole('button', { name: 'Replay Miso\'s guide', exact: true })).toBeVisible();

        await container.getByRole('tab', { name: 'Connection', exact: true }).click();
        await container.getByRole('tab', { name: 'Connection', exact: true }).press('ArrowRight');
        await expect(container.getByRole('tab', { name: 'Chats', exact: true })).toBeFocused();
        await expect(container.locator('#vectors_enabled_chats')).not.toBeChecked();
        await expect(container.locator('#vectors_vectorize_all')).toBeVisible();
        await container.locator('#vectors_protect').fill('-1');
        await expect(container.locator('#vectors_protect')).toHaveAttribute('aria-invalid', 'true');
        expect(await page.evaluate(() => window.SillyTavern.getContext().extensionSettings.vectors.protect)).toBe(1);
        await container.locator('#vectors_protect').fill('2');
        await expect(container.locator('#vectors_protect')).toHaveAttribute('aria-invalid', 'false');
        await container.locator('#vectors_vectorize_all').click();
        await expect(container.locator('#vectors_action_status')).toContainText('2 indexed chunks', { timeout: 30000 });
        await container.locator('#vectors_view_stats').click();
        await expect(container.locator('#vectors_chat_stats')).toHaveText('2 of 2 eligible messages indexed; 2 searchable chunks.', { timeout: 30000 });
        const acceptedRows = await fixture.read();
        const index = await fs.readFile(fixture.index, 'utf8');

        await container.getByRole('tab', { name: 'Try a search', exact: true }).click();
        await container.locator('#vectors_search_query').fill('Retained question');
        const submittedSearch = page.waitForResponse(response => response.url().endsWith('/api/operations/submit')
            && response.request().postDataJSON()?.action === 'query');
        await container.locator('#vectors_search').click();
        const search = await (await submittedSearch).json();
        await expect(container.locator('#vectors_search_results li')).toHaveCount(2, { timeout: 30000 });
        await page.evaluate(async () => {
            const { localizeControls } = await import('/scripts/ui-localization.js');
            localizeControls(document.querySelector('#vectors_search_results'), { 'Retained answer.': 'Changed by interface translation' });
        });
        await expect(container.locator('#vectors_search_results')).toContainText('Score 1.000');
        await expect(container.locator('#vectors_search_results')).toContainText('Retained answer.');
        expect(await fs.readFile(fixture.index, 'utf8')).toBe(index);
        expect(await fixture.read()).toEqual(acceptedRows);
        expect(app.provider.calls).toHaveLength(2);
        await container.locator('#vectors_search_results').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `/tmp/opencode/vectorization-${viewport}-search.png` });
        const overflow = await container.locator('.vectors-workspace').evaluate(element => element.scrollWidth - element.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);
        await container.getByRole('tab', { name: 'Saved work', exact: true }).click();
        const saved = container.getByLabel('Saved vector work', { exact: true });
        await saved.focus();
        await expect(saved.locator(`option[value="${search.record.key}"]`)).toHaveCount(1);
        await saved.selectOption(search.record.key);
        await expect(container.getByRole('list', { name: 'Saved search results', exact: true }).locator('li')).toHaveCount(2, { timeout: 30000 });
        expect(app.provider.calls).toHaveLength(2);
        await container.getByRole('tab', { name: 'Chats', exact: true }).click();
        await container.locator('#vectors_purge').click();
        await expect(container.locator('#vectors_action_status')).toHaveText('Indexes cleared. Source text kept.', { timeout: 30000 });
        expect(await fs.stat(fixture.index).then(() => true).catch(() => false)).toBe(false);
        expect(await fixture.read()).toEqual(acceptedRows);
    });

    test(`${viewport} whole vector indexing preserves the old index until completion with every page closed`, async ({ app, browser }) => {
        const fixture = await prepare(app, phone);
        const page = await openChat(fixture);
        await vectorControls(page, 'chats');
        const submitted = page.waitForResponse(response => response.url().endsWith('/api/operations/submit')
            && response.request().postDataJSON()?.kind === 'vectors' && response.request().postDataJSON()?.action === 'sync-chat');
        await page.locator('#vectors_enabled_chats').check();
        await page.locator('#vectors_vectorize_all').click();
        const response = await submitted;
        expect(response.status(), await response.text()).toBe(202);
        const accepted = await response.json();
        await expect.poll(() => app.provider.calls.length).toBe(1);
        expect(JSON.parse(await fs.readFile(fixture.index, 'utf8')).items[0].id).toBe('old-index-item');
        const acceptedRows = (await fixture.read()).slice(1);
        expect(acceptedRows).toMatchObject(fixture.records.slice(1));
        await closeEveryPage(page, browser);
        await app.release();
        await fixture.account.settled(accepted.job.id);
        const saved = JSON.parse(await fs.readFile(fixture.index, 'utf8'));
        expect(saved.items).toHaveLength(2);
        expect(saved.items.some(item => item.id === 'old-index-item')).toBe(false);
        expect((await fixture.read()).slice(1)).toEqual(acceptedRows);
        const reopened = await fixture.account.open({ workspace: false, readyTimeout: 60000 });
        const { container, select } = await vectorControls(reopened);
        await select.selectOption(accepted.record.key);
        await expect(container.getByText('1 saved vector collections ready.', { exact: true })).toBeVisible();
        expect(app.provider.calls).toHaveLength(1);
    });

    test(`${viewport} native reply owns vector retrieval after every page closes`, async ({ app, browser }) => {
        const fixture = await prepare(app, phone, true);
        const page = await openChat(fixture);
        const submitted = page.waitForResponse(response => response.url().endsWith('/api/roleplay/workflow/submit') && response.status() !== 409);
        await page.locator('#send_textarea').fill('Ask about lunar botany.');
        await page.locator('#send_textarea').press('Enter');
        const response = await submitted;
        expect(response.status(), await response.text()).toBe(202);
        const accepted = await response.json();
        await expect.poll(() => app.provider.calls.length).toBe(1);
        expect(app.provider.calls[0].input).toEqual([LORE]);
        expect(app.provider.calls.some(call => call.messages)).toBe(false);
        await closeEveryPage(page, browser);
        await app.release();
        await fixture.account.settled(accepted.jobId);
        const rows = await fixture.read();
        expect(rows[1].swipes).toEqual(fixture.records[1].swipes);
        expect(rows[1].swipe_id).toBe(0);
        expect(rows.at(-1).mes).toBe(ANSWER);
        const modelCalls = app.provider.calls.filter(call => call.messages);
        expect(modelCalls).toHaveLength(1);
        expect(JSON.stringify(modelCalls[0].messages)).toContain(LORE);
        expect(app.provider.calls).toHaveLength(3);
        const reopened = await openChat(fixture);
        await expect(reopened.locator('#chat .mes').last()).toContainText(ANSWER);
        expect(app.provider.calls).toHaveLength(3);
    });
}

test('embedding model refresh preserves saved choices and is not repeated for unrelated edits', async ({ app }) => {
    const fixture = await prepare(app, false);
    const page = await openChat(fixture);
    let calls = 0;
    await page.route('**/api/openrouter/models/embedding', route => {
        calls++;
        return route.fulfill({ status: calls === 1 ? 503 : 200, contentType: 'application/json',
            body: calls === 1 ? '{}' : JSON.stringify([{ id: 'new/model', name: 'New embedding model' }]) });
    });
    const { container } = await vectorControls(page, 'connection');
    await container.locator('#vectors_source').selectOption('openrouter');
    await expect(container.locator('#vectors_models_status')).toContainText('Could not load models');
    await expect(container.locator('#vectors_openrouter_model')).toHaveValue('openai/text-embedding-3-large');
    await container.locator('#vectors_query').fill('3');
    await container.locator('#vectors_include_wi').check();
    expect(calls).toBe(1);
    await container.locator('#vectors_refresh_models').click();
    await expect(container.locator('#vectors_models_status')).toContainText('1 models listed');
    await expect(container.locator('#vectors_openrouter_model')).toHaveValue('openai/text-embedding-3-large');
    await expect(container.locator('#vectors_openrouter_model option')).toHaveCount(2);
    await container.locator('#vectors_openrouter_model').selectOption('new/model');
    expect(await page.evaluate(() => window.SillyTavern.getContext().extensionSettings.vectors.openrouter_model)).toBe('new/model');
    await container.locator('#vectors_source').selectOption('palm');
    await expect(container.locator('#vectors_google_model option[value="gemini-embedding-2"]')).toHaveCount(1);
    await container.locator('#vectors_source').selectOption('vertexai');
    await expect(container.locator('#vectors_google_model option[value="gemini-embedding-2"]')).toHaveCount(0);
    await expect(container.locator('#vectors_google_model')).toHaveValue('gemini-embedding-001');
    await container.locator('#vectors_source').selectOption('openrouter');
    await expect(container.locator('#vectors_models_status')).toContainText('1 models listed');
    expect(calls).toBe(2);
});
