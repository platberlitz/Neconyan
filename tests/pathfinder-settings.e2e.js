/* global document, window */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { dismissOnboardingIfPresent, dismissOpenDialogIfPresent } from './chat-scroll-regression-helpers.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce', hasTouch: true });
test.setTimeout(120000);

const MANUAL_BOOK = 'Pathfinder test memory';
const ATTACHED_BOOK = 'Attached Pathfinder lorebook with a long name '.repeat(4).trim();

async function openSettings(page, baseURL) {
    const origin = new URL(baseURL).origin;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    const state = { saveMode: 'success', saves: [], heldSaves: [], generation: [], reads: [], writes: [], keys: [], failBookWrite: false };
    const books = new Map([MANUAL_BOOK, ATTACHED_BOOK].map(name => [name, {
        entries: { 0: { uid: 0, comment: 'Saved summary', content: 'Saved memory.', key: ['summary'], disable: false, constant: false } },
    }]));
    const bookRevision = name => createHash('sha256').update(JSON.stringify(books.get(name))).digest('hex');
    await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/api/in-chat-agents/pathfinder/key') {
            state.keys.push(request.postDataJSON());
            return route.fulfill({ json: { hasKey: Boolean(request.postDataJSON().key) } });
        }
        if (url.pathname === '/__pathfinder-test-generation') {
            state.generation.push(route);
            return;
        }
        if (url.pathname === '/api/in-chat-agents/save') {
            const agent = request.postDataJSON();
            if (agent.id === 'pf-e2e-agent') {
                state.saves.push(agent);
                if (state.saveMode === 'hold') {
                    state.heldSaves.push(route);
                    return;
                }
                if (state.saveMode === 'fail') return route.fulfill({ status: 503, json: {} });
            }
            return route.fulfill({ json: {} });
        }
        if (url.pathname === '/api/worldinfo/get') {
            const name = request.postDataJSON().name;
            if (books.has(name)) {
                state.reads.push(name);
                return route.fulfill({ json: books.get(name), headers: { 'X-World-Info-Revision': bookRevision(name) } });
            }
        }
        if (url.pathname === '/api/worldinfo/edit') {
            const { name, data, revision } = request.postDataJSON();
            state.writes.push({ name, data });
            if (state.failBookWrite) return route.fulfill({ status: 503, json: {} });
            if (revision !== bookRevision(name)) return route.fulfill({ status: 409, json: { error: 'The lorebook changed.' } });
            books.set(name, data);
            return route.fulfill({ json: { ok: true, name, revision: bookRevision(name) } });
        }
        // Browser tests never send inference, secrets, or mutations to a real service.
        if (url.pathname.startsWith('/api/backends/')) return route.fulfill({ json: { data: [] } });
        if (/^\/api\/.*\/(save|delete|create|edit|rename|update|import|upload|restore|duplicate|write|set)$/.test(url.pathname)) {
            return route.fulfill({ json: {} });
        }
        return route.continue();
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('preloader'), null, { timeout: 60000 });
    await dismissOnboardingIfPresent(page);
    const onboardingSave = page.locator('dialog[open]:has(.onboarding) .popup-button-ok');
    if (await onboardingSave.isVisible()) await onboardingSave.click();
    await dismissOpenDialogIfPresent(page);
    await page.addLocatorHandler(page.locator('#qig-setup-wizard'), async wizard => {
        await wizard.getByRole('button', { name: 'Skip', exact: true }).click();
    });
    await page.waitForFunction(async () => (await import('/script.js')).settingsReady, null, { timeout: 60000 });
    await page.waitForFunction(() => typeof window.SillyTavern?.getContext === 'function');
    await page.waitForFunction(() => typeof window.NeconyanAgents?.mountPathfinderSettings === 'function', null, { timeout: 60000 });

    await page.evaluate(async ({ manualBook, attachedBook }) => {
        const ui = await import('/scripts/extensions/in-chat-agents/pathfinder-settings-ui.js');
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        const tree = await import('/scripts/extensions/in-chat-agents/pathfinder/tree-store.js');
        const runner = await import('/scripts/extensions/in-chat-agents/agent-runner.js');
        const pathfinder = await import('/scripts/extensions/in-chat-agents/pathfinder-init.js');
        const world = await import('/scripts/world-info.js');
        const memory = await import('/scripts/extensions/in-chat-agents/pathfinder/summary-memory-store.js');
        const ctx = window.SillyTavern.getContext();
        ctx.chatMetadata.world_info = attachedBook;
        ctx.powerUserSettings.persona_description_lorebook = '';
        for (const character of ctx.characters) {
            character.data = { ...character.data, character_book: undefined, extensions: { ...character.data?.extensions, world: '' } };
        }
        if (ctx.worldInfoSettings) ctx.worldInfoSettings.charLore = [];
        ctx.chat.splice(0, ctx.chat.length, { mes: 'The test characters reach the harbour.', name: 'Test character', is_user: false });
        world.world_names.splice(0, world.world_names.length, manualBook, attachedBook);
        const CMRS = ctx.ConnectionManagerRequestService;
        ctx.extensionSettings.connectionManager ??= {};
        ctx.extensionSettings.connectionManager.profiles = [{ id: 'pf-test-profile', name: 'Pathfinder test profile', api: 'custom' }];
        CMRS.getSupportedProfiles = () => [{ id: 'pf-test-profile', name: 'Pathfinder test profile' }];
        CMRS.sendRequest = async (_profile, messages, _tokens, { signal }) => {
            const response = await fetch('/__pathfinder-test-generation', { method: 'POST', body: JSON.stringify(messages), signal });
            return response.text();
        };
        const tools = pathfinder.getPathfinderToolDefinitions();
        store.setGlobalSettings({ enabled: true, pathfinderEnabled: true, separateRecentChats: false });
        store.loadAgents([{
            id: 'pf-e2e-agent', name: 'Pathfinder', category: 'tool', sourceTemplateId: 'tpl-pathfinder', enabled: true, tools,
            settings: {
                pipelineEnabled: true, sidecarEnabled: false, connectionProfile: 'pf-test-profile',
                enabledLorebooks: [manualBook], selectedLorebook: manualBook,
                toolStates: Object.fromEntries(tools.map(tool => [tool.name, tool.name === 'Pathfinder_Search'])),
                bookPermissions: { [attachedBook]: { read: 'readwrite', write: 'readwrite', delete: 'none' } },
            },
        }]);
        tree.replaceSettings(store.getAgentById('pf-e2e-agent').settings);
        pathfinder.initPathfinder(ctx);
        runner.syncToolAgentRegistrations();
        memory.setSummaryMemoryCreated({ title: 'Saved summary', content: 'Saved memory.', bookName: manualBook, uid: 0 });
        ui.closePathfinderSettings();
        document.querySelectorAll('#pf--settings').forEach(element => element.remove());

        const host = document.createElement('div');
        host.id = 'pf-e2e-host';
        host.style.cssText = 'position:fixed;inset:0 0 0 auto;width:min(434px,100%);padding:12px;box-sizing:border-box;overflow:auto;z-index:10000;background:var(--SmartThemeBlurTintColor)';
        document.body.append(host);
        const panel = await ui.openPathfinderSettings(store.getAgentById('pf-e2e-agent'));
        panel.filter('#pf--settings').addClass('pf--settings-embedded');
        host.append(...panel.toArray());
    }, { manualBook: MANUAL_BOOK, attachedBook: ATTACHED_BOOK });
    await expect(page.locator('#pf-e2e-host #pf--master-enable')).toBeVisible();
    return state;
}

test('Pawthfinder Jev presets, threshold and protected key controls', async ({ page, baseURL }) => {
    const state = await openSettings(page, baseURL);
    {
        await page.getByLabel('Jev / decision model preset', { exact: true }).selectOption('open-jev-9b');
        await expect(page.getByLabel('Retrieval connection', { exact: true })).toHaveValue('manual');
        await expect(page.getByLabel('Model / model override', { exact: true })).toHaveValue('ZefanCai/Open-Jev-9B');
        await expect(page.getByLabel('Decision score threshold', { exact: true })).toHaveValue('0.1');
        await page.getByLabel('Decision score threshold', { exact: true }).fill('0');
        await page.getByLabel('Decision score threshold', { exact: true }).press('Tab');
        await expect.poll(() => state.saves.at(-1)?.settings.decisionThreshold).toBe(0);
        await page.getByLabel('API key for this endpoint', { exact: true }).fill('test-only-key');
        await page.getByRole('button', { name: 'Save API key', exact: true }).click();
        await expect(page.locator('#pf--model-key-status')).toHaveText('API key saved.');
        expect(JSON.stringify(state.saves)).not.toContain('test-only-key');
        await page.getByLabel('Jev / decision model preset', { exact: true }).selectOption('jev-1.14');
        await expect(page.getByLabel('Decision score threshold', { exact: true })).toHaveValue('0.5');
        await page.getByLabel('Jev / decision model preset', { exact: true }).selectOption('jev-latest');
        await expect(page.getByLabel('Model / model override', { exact: true })).toHaveValue('jev-latest');
        await expect(page.locator('#pf--model-endpoint')).toHaveValue('https://api.typesafe.ai/v1/systemone');
        await expect.poll(() => state.saves.at(-1)?.settings.modelOverride).toBe('jev-latest');
    }
    const directory = path.resolve('../screenshots');
    fs.mkdirSync(directory, { recursive: true });
    for (const viewport of [{ width: 393, height: 852 }, { width: 1280, height: 900 }]) {
        await page.setViewportSize(viewport);
        await page.locator('#pf--retrieval-model').scrollIntoViewIfNeeded();
        const overflow = await page.locator('#pf-e2e-host').evaluate(host => host.scrollWidth > host.clientWidth);
        expect(overflow).toBe(false);
        await page.screenshot({ path: path.join(directory, `pawthfinder-jev-after-${viewport.width}.png`) });
    }
    {
        for (const accent of [null, 'rgba(245, 235, 215, 1)', 'rgba(48, 24, 76, 1)']) {
            const contrasts = await page.evaluate(async colour => {
                if (colour) for (const id of ['sb-accent-primary-picker', 'sb-accent-secondary-picker']) {
                    document.getElementById(id).dispatchEvent(new CustomEvent('change', { detail: { rgba: colour } }));
                }
                await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 1;
                const ctx = canvas.getContext('2d');
                const luminance = rgb => rgb.slice(0, 3).map(value => {
                    value /= 255;
                    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
                }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
                return [...document.querySelectorAll('#pf--model-key-save, #pf--model-key-clear')].map(button => {
                    const ancestors = [];
                    for (let element = button; element; element = element.parentElement) ancestors.unshift(element);
                    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1, 1);
                    for (const element of ancestors) { ctx.fillStyle = window.getComputedStyle(element).backgroundColor; ctx.fillRect(0, 0, 1, 1); }
                    const background = luminance([...ctx.getImageData(0, 0, 1, 1).data]);
                    ctx.fillStyle = window.getComputedStyle(button).color; ctx.fillRect(0, 0, 1, 1);
                    const foreground = luminance([...ctx.getImageData(0, 0, 1, 1).data]);
                    return (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
                });
            }, accent);
            expect(contrasts).toHaveLength(2);
            for (const contrast of contrasts) expect(contrast).toBeGreaterThanOrEqual(4.5);
        }
    }
});

for (const width of [393, 1280]) {
    test(`server retrieval log survives reopening at ${width}px`, async ({ page, baseURL }) => {
        await page.setViewportSize({ width, height: width === 393 ? 852 : 900 });
        await openSettings(page, baseURL);
        const requests = [];
        await page.route('**/api/in-chat-agents/pathfinder/activity', route => {
            requests.push(route.request().postDataJSON());
            return route.fulfill({ json: { activity: {
                type: 'pathfinder_retrieval_detail', timestamp: Date.now(), mode: 'pipeline', books: [MANUAL_BOOK],
                selectedEntries: [{ bookName: MANUAL_BOOK, uid: 0, name: 'Entry 0' }],
                stageResults: [{ stageIndex: 0, promptId: 'candidate-selection', success: true, entriesFound: 1,
                    scores: [{ id: 'entry-0', score: 0.84 }], threshold: 0.5 }],
                injectedPrompt: 'The lighthouse keeper remembers the visitor.',
                metadata: { serverJobId: 'fixture-job', serverState: 'succeeded', serverRetrievalCompleted: true },
            } } });
        });
        await page.evaluate(async () => {
            const script = await import('/script.js');
            const ctx = window.SillyTavern.getContext();
            ctx.characters.push({ name: 'Retrieval fixture', avatar: 'retrieval-fixture.png', chat: 'Retrieval fixture chat' });
            script.setCharacterId(ctx.characters.length - 1);
        });
        await page.locator('[aria-controls="pf--retrieval-log-body"]').click();
        const output = page.locator('#pf--retrieval-log-output');
        await expect(output).toContainText('No Pawthfinder retrieval activity recorded yet');
        const screenshots = fileURLToPath(new URL('../screenshots/', import.meta.url));
        fs.mkdirSync(screenshots, { recursive: true });
        await page.screenshot({ path: path.join(screenshots, `jev-server-log-before-${width}.png`) });
        await page.locator('#pf--refresh-log').click();
        await expect(output).toContainText('entry-0: 0.84');
        await expect(output).toContainText('Server run: succeeded');
        expect(requests.at(-1)).toEqual({ agentId: 'pf-e2e-agent', locator: { chat: 'Retrieval fixture chat', avatar: 'retrieval-fixture.png', group: false } });
        await page.evaluate(async () => {
            const ui = await import('/scripts/extensions/in-chat-agents/pathfinder-settings-ui.js');
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            const activity = await import('/scripts/extensions/in-chat-agents/pathfinder/activity-feed.js');
            ui.closePathfinderSettings();
            activity.clearFeed();
            document.getElementById('pf-e2e-host').replaceChildren();
            const panel = await ui.openPathfinderSettings(store.getAgentById('pf-e2e-agent'));
            document.getElementById('pf-e2e-host').append(...panel.toArray());
        });
        await expect(output).toContainText('entry-0: 0.84');
        await output.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(screenshots, `jev-server-log-after-${width}.png`) });
    });
}

test('Jev browser pipeline keeps candidate identities and handles an empty selection', async ({ page, baseURL }) => {
    await openSettings(page, baseURL);
    await page.route('**/api/worldinfo/get', route => route.fulfill({ json: { entries: {
        1: { uid: 1, comment: 'Harbour', content: 'The harbour has a lighthouse.', key: ['harbour'], disable: false, constant: false },
    } } }));
    const requests = [];
    let accept = true;
    await page.route('**/api/in-chat-agents/pathfinder/retrieve', async route => {
        const input = route.request().postDataJSON();
        requests.push(input);
        const selected = accept ? input.candidates.map(candidate => candidate.id) : [];
        await route.fulfill({ json: { protocol: 'decision', selected, text: JSON.stringify(selected), threshold: 0.1,
            scores: input.candidates.map(candidate => ({ id: candidate.id, score: accept ? 0.9 : 0 })) } });
    });
    const run = () => page.evaluate(async manualBook => {
        const tree = await import('/scripts/extensions/in-chat-agents/pathfinder/tree-store.js');
        const { runPipeline } = await import('/scripts/extensions/in-chat-agents/pathfinder/prompts/pipeline-runner.js');
        tree.replaceSettings({ ...tree.getSettings(), modelConnection: 'manual', modelEndpoint: 'http://127.0.0.1:8000/v1/systemone',
            modelOverride: 'ZefanCai/Open-Jev-9B', decisionMode: 'decision', decisionThreshold: 0.1 });
        tree.saveTree(manualBook, { id: 'node_harbour', name: 'Harbour', entries: [1], children: [] });
        return runPipeline('default', [{ name: 'User', mes: 'Remember the harbour.', is_user: true }], 10, null, [manualBook]);
    }, MANUAL_BOOK);
    const result = await run();
    expect(result.success).toBe(true);
    expect(result.selectedEntryData).toEqual(expect.arrayContaining([expect.objectContaining({ bookName: MANUAL_BOOK, uid: 1 })]));
    expect(requests).toHaveLength(2);
    expect(requests[1].candidates.map(candidate => candidate.id)).toEqual(requests[0].candidates.map(candidate => candidate.id));
    expect(result.stageResults[0].scores[0].score).toBe(0.9);
    accept = false;
    const empty = await run();
    expect(empty.success).toBe(true);
    expect(empty.selectedEntryData).toEqual([]);
});

test('Pathfinder uses native keyboard disclosures, labelled controls and narrow layouts', async ({ page, baseURL }, testInfo) => {
    const state = await openSettings(page, baseURL);
    expect(state.reads).toEqual([]);
    expect(state.writes).toEqual([]);
    const header = page.locator('#pf--lorebook-section > button');
    await header.focus();
    await page.keyboard.press('Space');
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#pf--lorebook-body')).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('checkbox', { name: ATTACHED_BOOK, exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: `${ATTACHED_BOOK} Read`, exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: `${ATTACHED_BOOK} Write`, exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Automatically include attached lorebooks, aside from excluded lorebooks', exact: true })).toBeChecked();
    await expect(page.getByLabel('Pipeline Type', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Allow summary memory tool', { exact: true })).not.toBeChecked();
    await expect(page.locator('#pf--permission-matrix')).toBeVisible();
    await expect(page.locator('#pf--confirm-tool-list')).toBeVisible();

    for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const fontSize of [15, 30]) {
            await page.locator('#pf-e2e-host').evaluate((host, size) => host.style.setProperty('--mainFontSize', `${size}px`), fontSize);
            const layout = await page.locator('#pf-e2e-host').evaluate(host => {
                const controls = [...host.querySelectorAll('button, select, input, textarea')]
                    .filter(element => element.getClientRects().length)
                    .map(element => element.matches('input[type="checkbox"]') ? element.closest('label') : element);
                return {
                    overflow: host.scrollWidth > host.clientWidth,
                    smallestControl: Math.min(...controls.map(element => element.getBoundingClientRect().height)),
                    bookFontSize: parseFloat(window.getComputedStyle(host.querySelector('.pf--lorebook-name')).fontSize),
                };
            });
            expect(layout.overflow).toBe(false);
            expect(layout.smallestControl).toBeGreaterThanOrEqual(width < 768 ? 44 : 38);
            expect(layout.bookFontSize).toBeCloseTo(fontSize * 0.87, 1);
        }
        await page.locator('#pf-e2e-host').evaluate(host => {
            host.style.setProperty('--mainFontSize', '15px');
            host.scrollTop = 0;
        });
        await page.screenshot({ path: testInfo.outputPath(`pathfinder-${width}.png`) });
    }
});

test('Pathfinder saves rapid toggles in order and an unticked attached book stays excluded', async ({ page, baseURL }) => {
    const state = await openSettings(page, baseURL);
    state.saveMode = 'hold';
    await page.locator('#pf--enable-tools').check();
    await expect.poll(() => state.heldSaves.length).toBe(1);
    await page.locator('#pf--auto-summary').check();
    expect(state.saves).toHaveLength(1);
    expect(await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/pathfinder/tree-store.js')).getSettings().sidecarEnabled)).toBe(false);
    state.saveMode = 'success';
    await state.heldSaves[0].fulfill({ json: {} });
    await expect(page.locator('#pf--settings-save-status')).toHaveText('Saved!');
    await expect.poll(() => state.saves.length).toBe(2);
    expect(state.saves[0].settings.autoSummary).not.toBe(true);
    expect(state.saves[1].settings).toMatchObject({ sidecarEnabled: true, autoSummary: true, toolStates: { Pathfinder_Summarize: true } });

    await page.getByRole('checkbox', { name: ATTACHED_BOOK, exact: true }).uncheck();
    await expect(page.locator('#pf--settings-save-status')).toHaveText('Saved!');
    const access = await page.evaluate(async () => {
        const bridge = await import('/scripts/extensions/in-chat-agents/pathfinder/pathfinder-tool-bridge.js');
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        return { readable: bridge.getReadableBooks(), writable: bridge.getWritableBooks(), permissions: store.getAgentById('pf-e2e-agent').settings.bookPermissions };
    });
    expect(access.readable).not.toContain(ATTACHED_BOOK);
    expect(access.writable).not.toContain(ATTACHED_BOOK);
    expect(access.permissions[ATTACHED_BOOK]).toEqual({ enabled: false, read: 'readwrite', write: 'readwrite', delete: 'none' });
    await page.locator('#pf--refresh-lorebooks').click();
    await expect(page.getByRole('checkbox', { name: ATTACHED_BOOK, exact: true })).not.toBeChecked();
});

test('Pathfinder preserves failed prompt and summary drafts, including an empty summary', async ({ page, baseURL }) => {
    const state = await openSettings(page, baseURL);
    await page.locator('#pf--prompt-editor-section > button').click();
    await page.getByLabel('Select Prompt to Edit', { exact: true }).selectOption('candidate-selector');
    await page.getByLabel('System Prompt', { exact: true }).fill('A test prompt draft');
    state.saveMode = 'fail';
    await page.locator('#pf--prompt-save').click();
    await expect(page.locator('#pf--prompt-status')).toContainText('Save failed:');
    await expect(page.getByLabel('System Prompt', { exact: true })).toHaveValue('A test prompt draft');
    state.saveMode = 'success';
    await page.locator('#pf--settings-retry').click();
    await expect(page.locator('#pf--settings-save-status')).toHaveText('Saved!');

    const editor = page.getByLabel('Latest memory summary', { exact: true });
    await editor.fill('An unsaved summary draft');
    await page.locator('#pf--summary-save').focus();
    await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/pathfinder/summary-memory-store.js')).markSummaryMemoryInjected({ mode: 'pipeline' }));
    await expect(editor).toHaveValue('An unsaved summary draft');
    state.failBookWrite = true;
    await page.locator('#pf--summary-save').click();
    await expect(page.locator('#pf--summary-save-status')).toContainText('Save failed:');
    await expect(editor).toHaveValue('An unsaved summary draft');
    state.failBookWrite = false;
    await editor.fill('');
    await expect(page.locator('#pf--summary-save-entry')).toBeDisabled();
    await page.locator('#pf--summary-save').click();
    await expect(page.locator('#pf--summary-save-status')).toHaveText('Saved!');
    await expect(editor).toHaveValue('');
    expect(state.writes.at(-1).data.entries[0].content).toBe('');
});

test('Stop cancels a real auxiliary request without saving a late summary', async ({ page, baseURL }) => {
    const state = await openSettings(page, baseURL);
    await page.getByLabel('Jev / decision model preset', { exact: true }).selectOption('open-jev-9b');
    await expect(page.locator('#pf--settings-save-status')).toHaveText('Saved!');
    await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/pathfinder/summary-memory-store.js')).setSummaryMemoryCreated({ title: '', content: '', bookName: '', uid: null }));
    await page.locator('#pf--summary-create').click();
    await expect.poll(() => state.generation.length).toBe(1);
    await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/agent-runner.js')).cancelAgentGeneration());
    await expect(page.locator('#pf--summary-save-status')).toHaveText('Cancelled');
    await state.generation[0].fulfill({ body: '{"title":"Late","content":"This must not be stored."}' }).catch(() => {});
    expect(state.writes).toEqual([]);
    await expect(page.locator('#pf--summary-create')).toBeEnabled();
});
