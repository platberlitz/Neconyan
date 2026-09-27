/* eslint-env browser */
import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MODEL, test } from './neconyan-conversation-durable-fixture.js';

test.describe.configure({ mode: 'default' });
test.setTimeout(180000);
const book = { entries: { 3: { uid: 3, key: ['earth'], content: 'Earth is blue.', comment: 'Earth' } } };

async function openDistiller(account) {
    const page = await account.open({ workspace: false, readyTimeout: 60000 });
    await page.evaluate(async () => {
        const ctx = window.SillyTavern.getContext();
        await ctx.getCharacters();
        void (await import('/scripts/extensions/third-party/Neconyan-Lorebook-Distiller/src/ui.js')).openDistiller(window.SillyTavern.getContext());
    });
    await expect(page.getByRole('heading', { name: 'Lorebook Distiller', exact: true })).toBeVisible();
    const geometry = await page.locator('.sbld-root').evaluate(element => ({ width: element.getBoundingClientRect().width, display: getComputedStyle(element).display }));
    expect(geometry.width).toBeGreaterThan(250);
    expect(geometry.display).not.toBe('none');
    return page;
}

async function accepted(page, action, kind = null) {
    const pending = page.waitForResponse(response => response.url().endsWith('/api/labs/submit') && response.request().method() === 'POST'
        && (!kind || response.request().postDataJSON()?.kind === kind));
    await action();
    const response = await pending;
    expect(response.status(), await response.text()).toBe(202);
    return response.json();
}

async function openPrompting(account, tab = 'Compare prompts') {
    const page = await account.open({ workspace: false, readyTimeout: 60000 });
    await page.evaluate(async () => {
        await window.SillyTavern.getContext().getCharacters();
        const { mountRuntimeUi } = await import('/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/ui/runtime.js');
        mountRuntimeUi();
        document.getElementById('sbpl-menu-item').click();
    });
    await expect(page.locator('#sbpl-page')).toBeVisible();
    const mobileSections = page.locator('.sbpl-tab-select');
    if (await mobileSections.isVisible()) await mobileSections.selectOption({ label: tab });
    else await page.getByRole('tab', { name: ['Compare prompts', 'Compare models', 'Compare scenes'].includes(tab) ? `${tab}, uses tokens` : tab, exact: true }).click();
    const geometry = await page.locator('#sbpl-panel').evaluate(element => ({ width: element.getBoundingClientRect().width, display: getComputedStyle(element).display }));
    expect(geometry.width).toBeGreaterThan(250);
    expect(geometry.display).not.toBe('none');
    return page;
}

async function prepareComparison(page) {
    const panel = page.locator('.sbpl-experiment-tab');
    await panel.getByLabel('Prompt A', { exact: true }).fill('Describe a moon garden briefly.');
    await panel.getByLabel('Prompt B', { exact: true }).fill('Describe a moon garden warmly.');
    await expect(panel.getByLabel('Connection profile', { exact: true })).toContainText('Durable fixture');
    await panel.getByLabel('Connection profile', { exact: true }).selectOption('durable');
    return panel;
}

async function openWorldInfoLab(account, tab = 'scan') {
    const page = await account.open({ workspace: false, readyTimeout: 60000 });
    await page.evaluate(async () => {
        const { mountRuntimeUi } = await import('/scripts/extensions/third-party/Neconyan-WorldInfo-Lab/src/ui/runtime.js');
        mountRuntimeUi();
        document.getElementById('sbwil-menu-item').click();
    });
    await expect(page.locator('#sbwil-page')).toBeVisible();
    const panel = await selectWorldInfoTab(page, tab);
    const width = await panel.evaluate(element => element.getBoundingClientRect().width);
    expect(width).toBeGreaterThan(250);
    return { page, panel };
}

async function selectWorldInfoTab(page, tab) {
    const select = page.getByLabel('World Info Lab tool', { exact: true });
    if (await select.isVisible()) await select.selectOption(tab);
    else await page.locator(`#sbwil-tab-${tab}`).click();
    const panel = page.locator(`#sbwil-panel-${tab}`);
    await expect(panel).toBeVisible();
    return panel;
}

async function openLoreStitch(account) {
    const page = await account.open({ workspace: false, readyTimeout: 60000 });
    await page.evaluate(async () => {
        const world = await import('/scripts/world-info.js');
        await world.updateWorldInfoList();
        world.openWorldInfoEditor('Garden');
    });
    await expect(page.locator('#neco-lore-history-button')).toBeEnabled();
    await page.locator('#neco-lore-history-button').click();
    await page.getByRole('tab', { name: 'Search & replace', exact: true }).click();
    await expect(page.locator('#neconyan-lorebook-tools')).toBeVisible();
    expect(await page.locator('#neconyan-lorebook-tools').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(250);
    return page;
}

async function seedPrompting(account) {
    for (const [method, value] of [
        ['saveCase', { id: 'moon-case', name: 'Moon test', pins: { characterAvatar: account.avatar, connectionProfileId: 'durable' }, userMessage: 'Describe the moon garden.', assertions: [] }],
        ['saveSuite', { id: 'moon-suite', name: 'Moon suite', caseIds: ['moon-case'] }],
        ['saveDraft', { id: 'moon-draft', name: 'Moon published', apiId: 'openai', payload: { temperature: 0.37 } }],
    ]) {
        const saved = await account.post('/api/labs/submit', { key: `seed-${method}`, kind: 'prompting.storage', method, args: [value] });
        await account.settled(saved.job.id);
    }
}

async function closeAll(page, browser) {
    await page.close();
    expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
}

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} World Info saved test review, replay and health finish with pages closed`, async ({ app, browser }) => {
        test.setTimeout(300000);
        const account = await app.account({ phone, configureSettings: saved => {
            saved.world_info_settings = { ...saved.world_info_settings, world_info: { globalSelect: ['Garden'] } };
        } });
        await account.post('/api/worldinfo/edit', { name: 'Garden', data: book });
        const { page, panel } = await openWorldInfoLab(account);
        await panel.getByRole('radio', { name: 'Pasted text', exact: true }).check();
        await panel.locator('#sbwil-pasted-text').fill('Earth');
        const scan = await accepted(page, () => panel.getByRole('button', { name: 'Run scan', exact: true }).click(), 'world-info.scan');
        await page.evaluate(async () => {
            const { mountRuntimeUi } = await import('/scripts/extensions/third-party/Neconyan-WorldInfo-Lab/src/ui/runtime.js');
            mountRuntimeUi().refresh('settings-updated');
        });
        await account.settled(scan.job.id);
        await expect(panel).toContainText('Scan complete');
        await page.evaluate(async () => {
            const { mountRuntimeUi } = await import('/scripts/extensions/third-party/Neconyan-WorldInfo-Lab/src/ui/runtime.js');
            mountRuntimeUi().refresh('settings-updated');
        });
        const tests = await selectWorldInfoTab(page, 'tests');
        await tests.locator('.sbwil-test-name input').fill('Earth activation');
        await tests.getByLabel('Lorebook for saved test').selectOption('Garden');
        await tests.locator('.sbwil-test-consent input').check();
        const preview = await accepted(page, () => tests.getByRole('button', { name: 'Preview saving displayed scan as test', exact: true }).click(), 'world-info.case');
        await closeAll(page, browser);
        await account.settled(preview.job.id);
        expect(await account.post('/api/worldinfo/get', { name: 'Garden' })).toEqual(book);
        const review = await openWorldInfoLab(account, 'tests');
        await expect(review.panel.getByLabel('Saved server results', { exact: true })).toContainText('completed');
        await review.panel.getByLabel('Saved server results', { exact: true }).selectOption(preview.record.key);
        const applied = await accepted(review.page, () => review.panel.getByRole('button', { name: 'Apply reviewed test change', exact: true }).click(), 'apply');
        await closeAll(review.page, browser);
        await account.settled(applied.job.id);
        const replay = await openWorldInfoLab(account, 'tests');
        await expect(replay.panel.getByLabel('Saved test', { exact: true })).toContainText('Earth activation');
        const run = await accepted(replay.page, () => replay.panel.getByRole('button', { name: 'Run selected test', exact: true }).click(), 'world-info.tests');
        await closeAll(replay.page, browser);
        await account.settled(run.job.id);
        const result = await (await account.context.request.get(`${app.url}/api/labs/records/${run.record.key}`)).json();
        expect(result.result.passed).toBe(true);
        const health = await openWorldInfoLab(account, 'health');
        await health.panel.getByLabel('Lorebook to check').selectOption('Garden');
        const audit = await accepted(health.page, () => health.panel.getByRole('button', { name: 'Run health check', exact: true }).click(), 'world-info.health');
        await closeAll(health.page, browser);
        await account.settled(audit.job.id);
        const saved = await openWorldInfoLab(account, 'health');
        await expect(saved.panel.getByLabel('Saved server results', { exact: true })).toContainText('completed');
        await saved.panel.getByLabel('Saved server results', { exact: true }).selectOption(audit.record.key);
        await expect(saved.panel.getByRole('region', { name: 'Health check results', exact: true })).toContainText('Earth');
    });

    test(`${phone ? 'phone' : 'desktop'} saved prompt suites and preset publication finish without an open page`, async ({ app, browser }) => {
        test.setTimeout(300000);
        const account = await app.account({ phone });
        await seedPrompting(account);
        const page = await openPrompting(account, 'Run tests');
        const panel = page.locator('.sbpl-run-tab');
        await expect(panel.getByLabel('Suite to run', { exact: true })).toContainText('Moon suite');
        await panel.getByLabel('Suite to run', { exact: true }).selectOption('moon-suite');
        const run = await accepted(page, () => panel.getByRole('button', { name: 'Run suite', exact: true }).click(), 'prompting.suite');
        await closeAll(page, browser);
        await account.settled(run.job.id);
        const record = await (await account.context.request.get(`${app.url}/api/labs/records/${run.record.key}`)).json();
        expect(record.result.runs).toHaveLength(1);
        expect(record.result.runs[0].error).toBeNull();
        expect(record.result.runs[0].capture.tokenTable.total).toBeGreaterThan(0);
        const reopened = await openPrompting(account, 'Run tests');
        await expect(reopened.getByLabel('Saved server results', { exact: true })).toContainText('completed');
        await reopened.getByLabel('Saved server results', { exact: true }).selectOption(run.record.key);
        await expect(reopened.locator('.sbpl-run-tab')).toContainText('Saved prompt tests loaded.');
        await reopened.close();
        const presets = await openPrompting(account, 'Presets');
        const item = presets.locator('.sbpl-preset-item').filter({ has: presets.locator('.sbpl-preset-name', { hasText: /^Moon published$/ }) });
        await item.getByRole('button', { name: 'Edit', exact: true }).click();
        const published = await accepted(presets, () => presets.getByRole('button', { name: 'Publish to Neconyan', exact: true }).click(), 'prompting.publish');
        await closeAll(presets, browser);
        await account.settled(published.job.id);
        const payload = JSON.parse(await fs.readFile(path.join(app.directory, 'data/default-user/OpenAI Settings/Moon published.json'), 'utf8'));
        expect(payload.temperature).toBe(0.37);
        const draft = await account.post('/api/labs/prompting/read', { method: 'getDraft', args: ['moon-draft'] });
        expect(draft.value.publishedAs).toBe('Moon published');
        expect(app.provider.calls).toHaveLength(0);
    });

    test(`${phone ? 'phone' : 'desktop'} suite transfers and reviewed character tests survive page closure`, async ({ app, browser }) => {
        test.setTimeout(300000);
        const account = await app.account({ phone });
        await seedPrompting(account);
        const page = await openPrompting(account, 'Settings');
        const panel = page.locator('.sbpl-settings-tab');
        await expect(panel.getByLabel('Suite', { exact: true })).toContainText('Moon suite');
        await panel.getByLabel('Suite', { exact: true }).selectOption('moon-suite');
        const exported = await accepted(page, () => panel.getByRole('button', { name: 'Export suite', exact: true }).click(), 'prompting.transfer');
        await closeAll(page, browser);
        await account.settled(exported.job.id);
        const file = await (await account.context.request.get(`${app.url}/api/labs/records/${exported.record.key}`)).json();
        expect(JSON.parse(file.result.text).suite.name).toBe('Moon suite');
        const reopened = await openPrompting(account, 'Settings');
        const savedTransfers = reopened.getByLabel('Saved suite transfers', { exact: true });
        await expect(savedTransfers).toContainText('completed');
        await savedTransfers.selectOption(exported.record.key);
        await expect(reopened.getByRole('button', { name: 'Download saved suite export', exact: true })).toBeVisible();
        const imported = await accepted(reopened, () => reopened.getByLabel('Suite file to import').setInputFiles({ name: 'moon.json', mimeType: 'application/json', buffer: Buffer.from(file.result.text) }), 'prompting.transfer');
        await closeAll(reopened, browser);
        await account.settled(imported.job.id);
        expect((await account.post('/api/labs/prompting/read', { method: 'listSuites', args: [] })).value).toHaveLength(2);
        const cardPage = await openPrompting(account, 'Settings');
        await cardPage.getByLabel('Suite', { exact: true }).selectOption('moon-suite');
        const cardPath = path.join(app.directory, 'data/default-user/characters', account.avatar);
        const before = await fs.readFile(cardPath);
        const proposal = await accepted(cardPage, () => cardPage.getByRole('button', { name: 'Preview saving this suite into a character card', exact: true }).click(), 'prompting.embed');
        await closeAll(cardPage, browser);
        await account.settled(proposal.job.id);
        expect(await fs.readFile(cardPath)).toEqual(before);
        const review = await openPrompting(account, 'Settings');
        const proposals = review.getByLabel('Saved character test proposals', { exact: true });
        await expect(proposals).toContainText('completed');
        await proposals.selectOption(proposal.record.key);
        review.once('dialog', dialog => dialog.accept());
        const applied = await accepted(review, () => review.getByRole('button', { name: 'Apply reviewed character tests', exact: true }).click(), 'prompting.embed-apply');
        await closeAll(review, browser);
        await account.settled(applied.job.id);
        const { read } = await import('../src/character-card-parser.js');
        const card = JSON.parse(read(await fs.readFile(cardPath)));
        expect(card.data.extensions.SillyBunnyPromptingLab.cases).toHaveLength(1);
        expect(card.data.description).toContain('default-user');
    });
}

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} complete scene comparisons continue across presets and turns with every page closed`, async ({ app, browser }) => {
        const account = await app.account({ phone });
        const presets = path.join(app.directory, 'data/default-user/OpenAI Settings');
        await fs.copyFile(path.join(presets, 'Pura\'s Director Preset 16.0.json'), path.join(presets, 'Default.json'));
        await fs.copyFile(path.join(presets, 'Pura\'s Director Preset 16.0.json'), path.join(presets, 'Moon fixture.json'));
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: 'A saved scene reply.' } }] };
        app.provider.mode.hold = MODEL;
        const page = await openPrompting(account, 'Compare scenes');
        const panel = page.locator('.sbpl-scenes-tab');
        const character = panel.locator('.sbpl-picker-field').filter({ has: page.locator('.sbpl-field-label', { hasText: /^Character$/ }) });
        await character.locator('summary').click();
        await character.getByRole('button', { name: 'Durable Nova', exact: true }).click();
        await panel.getByRole('combobox', { name: 'Connection profile', exact: true }).selectOption('durable');
        await panel.getByRole('checkbox', { name: 'Default', exact: true }).check();
        await panel.getByRole('checkbox', { name: 'Moon fixture', exact: true }).check();
        await panel.getByLabel('Turn 1', { exact: true }).fill('Describe a moon garden.');
        await panel.getByLabel('Turn 2', { exact: true }).fill('What grows there?');
        const acceptedScene = await accepted(page, () => panel.getByRole('button', { name: 'Play the scene under each preset', exact: true }).click(), 'prompting.scene');
        await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(1);
        await page.close();
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
        await app.release();
        await account.settled(acceptedScene.job.id);
        expect(app.provider.calls).toHaveLength(4);
        const response = await account.context.request.get(`${app.url}/api/labs/records/${acceptedScene.record.key}`);
        const record = await response.json();
        expect(record.result.columns.map(column => column.turns.map(turn => turn.text))).toEqual([
            ['A saved scene reply.', 'A saved scene reply.'], ['A saved scene reply.', 'A saved scene reply.'],
        ]);
        const reopened = await openPrompting(account, 'Compare scenes');
        const saved = reopened.locator('.sbpl-scenes-tab').getByLabel('Saved server results', { exact: true });
        await expect(saved).toContainText('completed');
        await saved.selectOption(acceptedScene.record.key);
        await expect(reopened.locator('.sbpl-scenes-tab')).toContainText('Saved scene comparison loaded.');
        expect(app.provider.calls).toHaveLength(4);
    });

    test(`${phone ? 'phone' : 'desktop'} World Info retains closed-page scan and reviewed batch results`, async ({ app, browser }) => {
        const account = await app.account({ phone, configureSettings: saved => {
            saved.world_info_settings = { ...saved.world_info_settings, world_info: { globalSelect: ['Garden'] } };
        } });
        await account.post('/api/worldinfo/edit', { name: 'Garden', data: book });
        const { page, panel } = await openWorldInfoLab(account);
        await panel.getByRole('radio', { name: 'Pasted text', exact: true }).check();
        await panel.locator('#sbwil-pasted-text').fill('Earth');
        const scan = await accepted(page, () => panel.getByRole('button', { name: 'Run scan', exact: true }).click(), 'world-info.scan');
        await page.close();
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
        await account.settled(scan.job.id);
        const reopened = await openWorldInfoLab(account);
        await expect(reopened.panel.getByLabel('Saved server results')).toContainText('completed');
        await reopened.panel.getByLabel('Saved server results').selectOption(scan.record.key);
        await expect(reopened.panel).toContainText('Saved scan loaded.');
        const result = await account.context.request.get(`${app.url}/api/labs/records/${scan.record.key}`);
        expect((await result.json()).result.activated).toHaveLength(1);
        await reopened.page.close();
        const batch = await openWorldInfoLab(account, 'batch');
        await expect(batch.panel.getByLabel('Lorebook', { exact: true })).toContainText('Garden');
        await batch.panel.getByLabel('Lorebook', { exact: true }).selectOption('Garden');
        await batch.panel.getByLabel('Exact text to find').fill('blue');
        await batch.panel.getByLabel('Replacement content').fill('green');
        const preview = await accepted(batch.page, () => batch.panel.getByRole('button', { name: 'Preview changes', exact: true }).click(), 'world-info.batch');
        await batch.page.close();
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
        await account.settled(preview.job.id);
        expect(await account.post('/api/worldinfo/get', { name: 'Garden' })).toEqual(book);
        const review = await openWorldInfoLab(account, 'batch');
        await expect(review.panel.getByLabel('Saved server results')).toContainText('completed');
        await review.panel.getByLabel('Saved server results').selectOption(preview.record.key);
        await expect(review.panel.locator('.sbwil-preview-count')).toHaveText('1 entry would change.');
        await review.panel.getByRole('checkbox', { name: /I reviewed every proposed change/ }).check();
        const applied = await accepted(review.page, () => review.panel.getByRole('button', { name: 'Save these changes to the lorebook', exact: true }).click(), 'apply');
        await review.page.close();
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
        await account.settled(applied.job.id);
        expect((await account.post('/api/worldinfo/get', { name: 'Garden' })).entries[3].content).toBe('Earth is green.');
    });

    test(`${phone ? 'phone' : 'desktop'} LoreStitch retains its preview and reviewed apply after page closure`, async ({ app, browser }) => {
        const account = await app.account({ phone });
        await account.post('/api/worldinfo/edit', { name: 'Garden', data: book });
        const page = await openLoreStitch(account);
        await page.locator('#neco-lore-search-text').fill('blue');
        await page.locator('#neco-lore-replacement').fill('green');
        const preview = await accepted(page, () => page.locator('#neco-lore-search').getByRole('button', { name: 'Preview', exact: true }).click(), 'lorestitch');
        await page.close();
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
        await account.settled(preview.job.id);
        expect((await account.post('/api/worldinfo/get', { name: 'Garden' })).entries[3].content).toBe('Earth is blue.');
        const reopened = await openLoreStitch(account);
        await expect(reopened.getByLabel('Saved LoreStitch previews')).toContainText('completed');
        await reopened.getByLabel('Saved LoreStitch previews').selectOption(preview.record.key);
        const replace = reopened.getByRole('button', { name: 'Replace all', exact: true });
        await expect(replace).toBeEnabled();
        const applied = await accepted(reopened, () => replace.click(), 'apply');
        await reopened.close();
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
        await account.settled(applied.job.id);
        expect((await account.post('/api/worldinfo/get', { name: 'Garden' })).entries[3].content).toBe('Earth is green.');
    });
}

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} Prompting comparison finishes with all pages closed and reloads saved replies`, async ({ app, browser }) => {
        const account = await app.account({ phone });
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: 'Saved lunar roses.' } }] };
        app.provider.mode.hold = MODEL;
        const page = await openPrompting(account);
        const panel = await prepareComparison(page);
        const submission = await accepted(page, () => panel.getByRole('button', { name: 'Get both replies', exact: true }).click(), 'prompting.requests');
        await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(2);
        await page.close();
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
        await app.release();
        await account.settled(submission.job.id);
        const response = await account.context.request.get(`${app.url}/api/labs/records/${submission.record.key}`);
        expect(response.ok()).toBe(true);
        const record = await response.json();
        expect(record.result.map(reply => reply.text)).toEqual(['Saved lunar roses.', 'Saved lunar roses.']);
        const reopened = await openPrompting(account);
        const saved = reopened.locator('.sbpl-experiment-tab').getByLabel('Saved server results', { exact: true });
        await expect(saved).toContainText('completed');
        await saved.selectOption(submission.record.key);
        await expect(reopened.locator('.sbpl-experiment-tab .sbpl-ab-body')).toHaveText(['Saved lunar roses.', 'Saved lunar roses.']);
        expect(app.provider.calls).toHaveLength(2);
    });

    test(`${phone ? 'phone' : 'desktop'} reopened Prompting comparison confirms server Stop`, async ({ app, browser }) => {
        const account = await app.account({ phone });
        app.provider.mode.hold = MODEL;
        const page = await openPrompting(account);
        const panel = await prepareComparison(page);
        const submission = await accepted(page, () => panel.getByRole('button', { name: 'Get both replies', exact: true }).click(), 'prompting.requests');
        await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(2);
        await page.close();
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
        const reopened = await openPrompting(account);
        const saved = reopened.locator('.sbpl-experiment-tab').getByLabel('Saved server results', { exact: true });
        await expect(saved.locator(`option[value="${submission.record.key}"]`)).toHaveCount(1);
        await saved.selectOption(submission.record.key);
        await reopened.getByRole('button', { name: 'Stop saved work', exact: true }).click();
        await account.settled(submission.job.id, 'cancelled');
        await app.release();
        expect(app.provider.calls).toHaveLength(2);
    });
}

for (const phone of [false, true]) test(`${phone ? 'phone' : 'desktop'} Distiller retains closed-page proposals and separately applies reviewed entries`, async ({ app, browser }) => {
    const account = await app.account({ phone });
    await account.post('/api/worldinfo/edit', { name: 'Garden', data: book });
    const chatDirectory = path.join(app.directory, 'data/default-user/chats', account.avatar.replace(/\.png$/i, ''));
    await fs.mkdir(chatDirectory, { recursive: true });
    await fs.writeFile(path.join(chatDirectory, 'labs-scene.jsonl'), [
        { user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} },
        { name: 'Durable Nova', is_user: false, mes: 'The moon garden grows roses.', send_date: 1700000000000 },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: JSON.stringify([
        { title: 'Moon garden', keys: ['moon garden'], content: 'Roses grow on the moon.' },
    ]) } }] };
    app.provider.mode.hold = MODEL;
    const page = await openDistiller(account);
    await expect(page.getByLabel('Chat to distill')).toContainText('labs-scene');
    await page.getByLabel('Chat to distill').selectOption({ label: 'Durable Nova - labs-scene' });
    await page.getByRole('combobox', { name: 'Connection', exact: true }).selectOption('durable');
    await page.getByRole('combobox', { name: 'Write into', exact: true }).selectOption('Garden');
    const submission = await accepted(page, () => page.getByRole('button', { name: 'Distill this chat', exact: true }).click());
    await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(1);
    await page.close();
    expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
    await app.release();
    await account.settled(submission.job.id);
    expect(await account.post('/api/worldinfo/get', { name: 'Garden' })).toEqual(book);
    const reopened = await openDistiller(account);
    await expect(reopened.getByLabel('Saved distillations', { exact: true })).toContainText('completed');
    await reopened.getByLabel('Saved distillations', { exact: true }).selectOption(submission.record.key);
    await expect(reopened.getByLabel('Entry content', { exact: true })).toHaveValue('Roses grow on the moon.');
    await reopened.getByLabel('Entry content', { exact: true }).fill('Reviewed moon roses.');
    const applied = await accepted(reopened, () => reopened.getByRole('button', { name: 'Add selected entries', exact: true }).click());
    await reopened.close();
    expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
    await account.settled(applied.job.id);
    const saved = await account.post('/api/worldinfo/get', { name: 'Garden' });
    expect(Object.values(saved.entries).map(entry => entry.content).sort()).toEqual(['Earth is blue.', 'Reviewed moon roses.']);
    const final = await openDistiller(account);
    await expect(final.getByLabel('Saved distillations', { exact: true })).toContainText('completed');
    await final.getByLabel('Saved distillations', { exact: true }).selectOption(submission.record.key);
    await expect(final.locator('.sbld-status')).toContainText('no remaining');
    expect(app.provider.calls).toHaveLength(1);
});
