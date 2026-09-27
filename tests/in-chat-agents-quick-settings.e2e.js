/* global window, document */
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', actionTimeout: 15000 });
test.setTimeout(180000);

for (const width of [393, 1280]) {
    test.describe(`Agent shortcuts at ${width}px`, () => {
        test.use({ viewport: { width, height: width === 393 ? 852 : 900 }, hasTouch: width === 393, isMobile: width === 393 });
        test('history, filtered batches, links and quick settings persist without opening the editor', async ({ page }, info) => {
            const errors = [];
            const timings = {};
            const storageRequests = [];
            page.on('request', request => {
                const path = new URL(request.url()).pathname;
                if (path.startsWith('/api/in-chat-agents/') || path === '/api/settings/get') storageRequests.push(path);
            });
            page.on('pageerror', error => errors.push(error.message));
            await page.route(/\/api\/.*\/(?:generate|generate-quiet)(?:\?|$)/, route => route.fulfill({ status: 503, json: { error: 'Generation disabled during UI verification.' } }));
            await page.goto('/', { waitUntil: 'domcontentloaded' });
            await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 45000 });
            await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
            const assistant = page.locator('[data-assistant-personality="miso"]');
            await assistant.locator('input[value="miso-male"]').check();
            await assistant.locator('[data-assistant-open]').click();
            await page.waitForFunction(() => document.querySelector('[data-assistant-picker]')?.dataset.assistantBusy !== 'true');
            const skip = page.getByRole('region', { name: 'Neconyan interactive tutorial' }).getByRole('button', { name: 'Skip', exact: true });
            if (await skip.isVisible()) await skip.click();
            const prefix = `shortcut-${width}-${Date.now()}`;
            const ids = ['a', 'b', 'inline', 'outside'].map(suffix => `${prefix}-${suffix}`);
            const readAgents = () => page.evaluate(async ids => {
                const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                return ids.map(id => store.getAgentById(id));
            }, ids);
            try {
                await page.evaluate(async ({ ids, prefix }) => {
                    const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                    const companion = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
                    const context = window.SillyTavern.getContext();
                    const index = context.chat.findLastIndex(message => !message.is_user && !message.is_system);
                    for (const [i, id] of ids.entries()) {
                        const agent = { ...store.createDefaultAgent(), id, name: `${prefix} ${i}`, execution: i === 2 ? 'inline' : 'companion', category: 'custom', prompt: 'Write a note.', connectionProfile: `missing-${i}`, modelOverride: `initial-${i}`, companion: { trigger: 'manual', batchAgentIds: i === 0 ? [ids[3]] : [] } };
                        await store.saveAgent(agent);
                        if (i < 2) companion.setCompanionResult(context.chat[index], store.getAgentById(id), { status: 'done', content: 'A retained test note.' });
                    }
                    await companion.emitCompanionResultsUpdated(index, ids[0]);
                    window.SillyBunnyShell.openTab('left', 'agents');
                }, { ids, prefix });
                await expect(page.locator('#ica--settings')).toBeVisible();
                await page.locator('#ica--search').fill(prefix);
                const cards = page.locator('#ica--agentList .ica--agent-card');
                const first = cards.filter({ has: page.locator(`.ica--card-name:text-is("${prefix} 0")`) });
                storageRequests.length = 0;
                const historyStart = Date.now();
                await first.getByRole('button', { name: 'Keep in history', exact: true }).click();
                await expect(first.getByRole('button', { name: 'In chat history', exact: true })).toHaveAttribute('aria-pressed', 'true');
                timings.history = { milliseconds: Date.now() - historyStart, requests: [...storageRequests] };
                expect(storageRequests.filter(path => path.startsWith('/api/in-chat-agents/'))).toEqual(['/api/in-chat-agents/save']);
                expect(await page.evaluate(async id => {
                    const companion = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
                    return window.SillyTavern.getContext().chat.some(message => companion.getCompanionResults(message)[id]?.includeInChatHistory);
                }, ids[0])).toBe(true);
                await first.getByRole('button', { name: 'Settings', exact: true }).click();
                const settings = page.getByRole('dialog', { name: 'Agent settings', exact: true });
                await settings.getByLabel('Keep all saved notes', { exact: true }).selectOption('false');
                await settings.getByLabel('Notes to keep when not keeping all').fill('3');
                await settings.getByLabel('Order', { exact: true }).fill('42');
                await page.route('**/api/in-chat-agents/save', async route => {
                    await page.unroute('**/api/in-chat-agents/save');
                    await route.fulfill({ status: 503, json: { error: 'Test save unavailable.' } });
                });
                await settings.getByRole('button', { name: 'Save changes' }).click();
                await expect(settings.getByRole('alert')).toBeVisible();
                await expect(settings.getByLabel('Notes to keep when not keeping all')).toHaveValue('3');
                expect((await readAgents())[0].companion.chatHistoryDepth).toBe(1);
                await settings.getByRole('button', { name: 'Save changes' }).click();
                await expect(settings).toHaveCount(0);
                expect((await readAgents())[0].companion).toMatchObject({ includeInChatHistory: true, includeAllChatHistory: false, chatHistoryDepth: 3 });
                expect((await readAgents())[0].injection.order).toBe(42);

                await page.locator('#ica--selectMode').click();
                await page.locator('#ica--agentTabs [data-tab="companion"]').click();
                await page.locator('#ica--search').fill(`${prefix} 0`);
                await first.evaluate(card => { card.dataset.selectionIdentity = 'retained'; });
                const selectionStart = Date.now();
                await page.locator('#ica--bulkSelectAll').click();
                await expect(first).toHaveAttribute('data-selection-identity', 'retained');
                await expect(first.locator('.ica--card-select')).toBeChecked();
                timings.selectShown = { milliseconds: Date.now() - selectionStart };
                await first.locator('.ica--card-select').uncheck();
                await expect(first).toHaveAttribute('data-selection-identity', 'retained');
                await expect(first.locator('.ica--card-select')).toBeFocused();
                await first.locator('.ica--card-select').check();
                await page.locator('#ica--search').fill(`${prefix} 1`);
                await page.locator('#ica--bulkSelectAll').click();
                await expect(page.locator('#ica--bulkCount')).toHaveText('2 selected');
                const bulkSizes = await page.locator('#ica--bulkBar > div > button').evaluateAll(buttons => buttons.map(button => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })));
                expect(bulkSizes.every(size => size.width >= 44 && size.height >= 44)).toBe(true);
                await page.screenshot({ path: info.outputPath('bulk-actions.png') });
                await page.locator('#ica--bulkConnect').click();
                const connections = page.getByRole('dialog', { name: 'Batch & connect', exact: true });
                await page.keyboard.press('Escape');
                await expect(page.locator('#ica--bulkConnect')).toBeFocused();
                await page.locator('#ica--bulkConnect').click();
                await connections.getByLabel('Batch in one request').selectOption('true');
                await connections.getByRole('button', { name: 'Save changes' }).click();
                await expect(connections).toHaveCount(0);
                const batched = await readAgents();
                expect(batched[0].companion.batchAgentIds).toEqual([ids[3], ids[1]]);
                expect(batched[1].companion.batchAgentIds).toEqual([ids[0]]);
                expect(batched[2].companion.batch).toBe(false);
                await page.locator('#ica--bulkHistory').click();
                await expect.poll(async () => (await readAgents())[1].companion.includeInChatHistory).toBe(true);
                await page.locator('#ica--bulkSettings').click();
                await settings.getByLabel('Connection profile', { exact: true }).selectOption('');
                await settings.getByLabel('Set model for selected agents', { exact: false }).check();
                await settings.getByLabel('Model override', { exact: true }).fill('shared-test-model');
                await settings.getByRole('button', { name: 'Save changes' }).click();
                await expect(settings).toHaveCount(0);
                const updated = await readAgents();
                expect(updated.slice(0, 2).map(agent => [agent.connectionProfile, agent.modelOverride, agent.companion.chatHistoryDepth])).toEqual([['', 'shared-test-model', 3], ['', 'shared-test-model', 1]]);
                expect(updated[2]).toMatchObject({ connectionProfile: 'missing-2', modelOverride: 'initial-2' });
                await page.locator('#ica--bulkConnect').click();
                await connections.getByLabel('Share latest notes').selectOption('true');
                await connections.getByRole('button', { name: 'Save changes' }).click();
                await expect(connections).toHaveCount(0);
                expect((await readAgents())[0].companion.contextRecipientAgentIds).toEqual([ids[1]]);

                await page.locator('#ica--bulkCancel').click();
                await page.locator('#ica--search').fill(`${prefix} 0`);
                await first.getByRole('button', { name: 'Batch & connect', exact: true }).click();
                const send = connections.getByRole('group', { name: 'Send notes to', exact: true });
                await send.getByLabel('Find a companion').fill(`${prefix} 1`);
                await send.getByRole('button', { name: 'Clear shown' }).click();
                await connections.getByRole('button', { name: 'Save changes' }).click();
                await expect(connections).toHaveCount(0);
                expect((await readAgents())[0].companion.contextRecipientAgentIds).toEqual([]);
                await first.getByRole('button', { name: 'Batch & connect', exact: true }).click();
                await connections.getByLabel('Send latest notes', { exact: true }).selectOption('false');
                await send.getByLabel('Find a companion').fill(`${prefix} 1`);
                await send.getByRole('button', { name: 'Select shown' }).click();
                await expect(connections.getByLabel('Send latest notes', { exact: true })).toHaveValue('true');
                await page.screenshot({ path: info.outputPath('agent-connections.png') });
                await connections.getByRole('button', { name: 'Save changes' }).click();
                await expect(connections).toHaveCount(0);
                expect((await readAgents())[0].companion.contextRecipientAgentIds).toEqual([ids[1]]);
                await first.getByRole('button', { name: 'Settings', exact: true }).click();
                const geometry = await settings.evaluate(root => ({
                    document: document.documentElement.scrollWidth, width: root.clientWidth, scroll: root.scrollWidth,
                    controls: [...root.querySelectorAll('.ica--quick-settings select, .ica--quick-settings input')].filter(el => el.getBoundingClientRect().width).map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, font: window.getComputedStyle(el).fontFamily })),
                }));
                expect(geometry.document).toBeLessThanOrEqual(width + 1);
                expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
                expect(geometry.controls.every(control => control.width >= 44 && control.height >= 44)).toBe(true);
                await page.screenshot({ path: info.outputPath('quick-settings.png') });
                await page.keyboard.press('Escape');
                await expect(settings).toHaveCount(0);
                await expect(first.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
                const cardSizes = await first.locator('.ica--card-primary-actions button').evaluateAll(buttons => buttons.map(button => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })));
                expect(cardSizes.every(size => size.width >= 44 && size.height >= 44)).toBe(true);
                await page.screenshot({ path: info.outputPath('agent-shortcuts.png') });
                await page.reload({ waitUntil: 'domcontentloaded' });
                await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready') && window.SillyTavern?.getContext);
                await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'agents'));
                await expect(page.locator('#ica--settings')).toBeVisible();
                await page.locator('#ica--search').fill(`${prefix} 0`);
                await expect(first.getByRole('button', { name: 'In chat history', exact: true })).toHaveAttribute('aria-pressed', 'true');
                expect((await readAgents())[0]).toMatchObject({ modelOverride: 'shared-test-model', companion: { batchAgentIds: [ids[3], ids[1]], contextRecipientAgentIds: [ids[1]], chatHistoryDepth: 3 } });
                await first.getByRole('button', { name: 'Settings', exact: true }).click();
                await settings.getByLabel('Model override', { exact: true }).fill('stale-dialog-model');
                await page.evaluate(async id => {
                    const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                    await store.saveAgent({ ...store.getAgentById(id), description: 'Changed while settings were open.' });
                }, ids[0]);
                await settings.getByRole('button', { name: 'Save changes' }).click();
                await expect(settings.getByRole('alert')).toHaveText('These agents changed. Cancel and reopen settings.');
                expect((await readAgents())[0]).toMatchObject({ description: 'Changed while settings were open.', modelOverride: 'shared-test-model' });
                await page.keyboard.press('Escape');
                expect(errors).toEqual([]);
            } finally {
                await info.attach('interaction-timings', { body: JSON.stringify(timings, null, 2), contentType: 'application/json' });
                console.log(`ICA ${width}px: ${JSON.stringify(timings)}`);
                await page.evaluate(async ids => {
                    const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                    const companion = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
                    for (const id of ids) {
                        for (const message of window.SillyTavern.getContext().chat) companion.deleteCompanionResult(message, id);
                        await store.deleteAgent(id);
                    }
                }, ids);
            }
        });
    });
}
