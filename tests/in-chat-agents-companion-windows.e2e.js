/* global document, window */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves } from './chat-scroll-regression-helpers.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(120000);

async function prepareAssistantPage(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 45000 });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    const assistant = page.locator('[data-assistant-personality="miso"]');
    await assistant.locator('input[value="miso-male"]').check();
    await assistant.locator('[data-assistant-open]').click();
    await page.waitForFunction(() => document.querySelector('[data-assistant-picker]')?.dataset.assistantBusy !== 'true');
    const skipTour = page.getByRole('region', { name: 'Neconyan interactive tutorial' }).getByRole('button', { name: 'Skip', exact: true });
    await skipTour.click({ timeout: 1000 }).catch(() => {});
}

function clearStoredWindows(settings) {
    settings.accountStorage = { ...settings.accountStorage };
    delete settings.accountStorage['ica--companion-windows-v1'];
}

async function createAgentFixture(page, id, name, note) {
    await page.evaluate(async ({ id, name, note }) => {
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        const companion = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        const context = window.SillyTavern.getContext();
        const agent = {
            ...store.createDefaultAgent(),
            id,
            name,
            execution: 'companion',
            category: 'companion',
            enabled: true,
            prompt: 'Return a note.',
            companion: { trigger: 'manual', displayMode: 'panel', format: 'html' },
        };
        await store.saveAgent(agent);
        const index = context.chat.findLastIndex(message => !message.is_user && !message.is_system);
        if (index < 0) throw new Error('No assistant reply available for the window fixture.');
        companion.setCompanionResult(context.chat[index], agent, { status: 'done', content: note, format: 'html' });
        await companion.emitCompanionResultsUpdated(index, id);
        return index;
    }, { id, name, note });
}

async function openPanel(page) {
    await page.evaluate(async () => {
        const panel = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
        panel.openCompanionPanel();
    });
    await expect(page.locator('#ica--tracker-panel')).toBeVisible();
}

for (const viewport of [{ width: 393, height: 852 }, { width: 1280, height: 900 }]) {
    test.describe(`Companion windows at ${viewport.width}px`, () => {
        test.use({ viewport, hasTouch: viewport.width < 769, isMobile: viewport.width < 769 });

        test('floats, collapses, moves and closes without running the companion', async ({ page }, info) => {
            page.setDefaultTimeout(15000);
            const id = `companion-window-${viewport.width}-${Date.now()}`;
            const generationRequests = [];
            page.on('request', request => {
                if (/\/api\/.*\/generate(?:-quiet)?(?:\?|$)/.test(request.url())) generationRequests.push(request.url());
            });
            await isolateSettingsSaves(page, clearStoredWindows);
            await prepareAssistantPage(page);

            try {
                await createAgentFixture(page, id, 'Floating Scene Notes', '<p>The floating note stays visible over the chat.</p>');
                await openPanel(page);

                const panel = page.locator('#ica--tracker-panel');
                await panel.locator(`[data-agent-id="${id}"] [data-action="panel-open-window"]`).click();
                const windowNode = page.locator(`.ica--cwin[data-agent-id="${id}"]`);
                await expect(windowNode).toBeVisible();
                await expect(panel).toBeHidden();
                await expect(windowNode).toHaveAttribute('role', 'region');
                await expect(windowNode).toHaveAccessibleName('Floating Scene Notes');
                await expect(windowNode).toContainText('The floating note stays visible over the chat.');
                await expect(windowNode.getByRole('button', { name: 'Run latest' })).toBeEnabled();
                await expect(windowNode.getByRole('button', { name: 'Write again' })).toBeEnabled();
                await expect(windowNode.getByRole('button', { name: 'Show in chat' })).toBeEnabled();

                const geometry = await windowNode.evaluate((element, phone) => {
                    const rect = element.getBoundingClientRect();
                    const layer = document.getElementById('ica--cwin-layer');
                    const composer = document.getElementById('form_sheld')?.getBoundingClientRect();
                    return {
                        left: rect.left,
                        right: rect.right,
                        top: rect.top,
                        bottom: rect.bottom,
                        width: rect.width,
                        viewportWidth: window.innerWidth,
                        viewportHeight: window.innerHeight,
                        composerTop: composer?.top ?? null,
                        bottomBound: phone && composer ? composer.top - 7 : window.innerHeight,
                        layerZ: layer ? Number(window.getComputedStyle(layer).zIndex) : null,
                        phone,
                    };
                }, viewport.width < 769);
                expect(geometry.left).toBeGreaterThanOrEqual(7.5);
                expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth - 7.5);
                expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
                expect(geometry.width).toBeCloseTo(viewport.width < 769 ? 360 : 320, 0);
                expect(geometry.layerZ).toBe(1099);
                expect(geometry.bottom).toBeLessThanOrEqual(geometry.bottomBound);

                const collapse = windowNode.getByRole('button', { name: 'Collapse Floating Scene Notes window' });
                await collapse.click();
                await expect(windowNode).toHaveAttribute('data-collapsed', 'true');
                const collapsed = await windowNode.boundingBox();
                expect(collapsed.width).toBeCloseTo(260, 0);
                expect(collapsed.height).toBeLessThan(70);

                await windowNode.getByRole('button', { name: 'Expand Floating Scene Notes window' }).click();
                const grip = windowNode.getByRole('button', { name: /Move Floating Scene Notes window/ });
                await grip.focus();
                const beforeMove = (await windowNode.boundingBox()).x;
                await page.keyboard.press('ArrowLeft');
                expect((await windowNode.boundingBox()).x).toBeLessThan(beforeMove);
                await page.keyboard.press('Escape');
                await expect(windowNode).toHaveAttribute('data-collapsed', 'true');
                await expect(windowNode.getByRole('button', { name: 'Expand Floating Scene Notes window' })).toBeFocused();

                await windowNode.getByRole('button', { name: 'Expand Floating Scene Notes window' }).evaluate(element => element.click());
                const head = windowNode.locator('.ica--cwin-head');
                const box = await head.boundingBox();
                const beforeDrag = await windowNode.boundingBox();
                await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                await page.mouse.down();
                await page.mouse.move(box.x + box.width / 2 - 32, box.y + box.height / 2 + 24, { steps: 5 });
                await page.mouse.up();
                const afterDrag = await windowNode.boundingBox();
                expect(afterDrag.y).toBeGreaterThan(beforeDrag.y);
                await page.screenshot({ path: info.outputPath('companion-windows.png') });

                await windowNode.getByRole('button', { name: 'Close Floating Scene Notes window' }).click();
                await expect(windowNode).toHaveCount(0);
                expect(generationRequests).toEqual([]);
            } finally {
                await page.evaluate(async id => {
                    for (const button of document.querySelectorAll('.ica--cwin [data-action="cwin-close"]')) button.click();
                    const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                    const companion = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
                    const context = window.SillyTavern.getContext();
                    for (const message of context.chat) companion.deleteCompanionResult(message, id);
                    await store.deleteAgent(id);
                }, id).catch(() => {});
            }
        });

        test('keeps two fresh default headers reachable and preserves note scroll and details', async ({ page }, info) => {
            page.setDefaultTimeout(15000);
            const stamp = Date.now();
            const firstId = `companion-stack-scene-${viewport.width}-${stamp}`;
            const secondId = `companion-stack-offscreen-${viewport.width}-${stamp}`;
            const longNote = '<details><summary>Scene detail</summary><p>The detail stays open.</p></details><div style="height:1200px">Tall note body.</div><button type="button" id="window-note-spoof" data-cwin-focus="close&quot;]">Spoof control</button>';
            await isolateSettingsSaves(page, clearStoredWindows);
            await prepareAssistantPage(page);

            try {
                // Store order is deliberately the reverse of open order: Off-Screen is index 0 in
                // getAgents, but Scene Tracker is opened first and saves the first default slot.
                await createAgentFixture(page, secondId, 'Off-Screen Companion', '<p>Second note.</p>');
                await createAgentFixture(page, firstId, 'Scene Tracker', longNote);
                const firstWindow = page.locator(`.ica--cwin[data-agent-id="${firstId}"]`);
                const secondWindow = page.locator(`.ica--cwin[data-agent-id="${secondId}"]`);

                await openPanel(page);
                await page.locator(`[data-agent-id="${firstId}"] [data-action="panel-open-window"]`).click();
                await expect(firstWindow).toBeVisible();
                await openPanel(page);
                await page.locator(`[data-agent-id="${secondId}"] [data-action="panel-open-window"]`).click();
                await expect(secondWindow).toBeVisible();

                const stack = await page.evaluate(({ firstId, secondId }) => {
                    const first = document.querySelector(`.ica--cwin[data-agent-id="${firstId}"]`);
                    const second = document.querySelector(`.ica--cwin[data-agent-id="${secondId}"]`);
                    const firstHead = first.querySelector('.ica--cwin-head').getBoundingClientRect();
                    const secondHead = second.querySelector('.ica--cwin-head').getBoundingClientRect();
                    const firstPoint = { x: firstHead.left + Math.min(firstHead.width / 2, 80), y: firstHead.top + firstHead.height / 2 };
                    const firstHit = document.elementFromPoint(firstPoint.x, firstPoint.y);
                    const close = first.querySelector('[data-action="cwin-close"]').getBoundingClientRect();
                    const closeHit = document.elementFromPoint(close.left + close.width / 2, close.top + close.height / 2);
                    const secondPoint = { x: secondHead.left + Math.min(secondHead.width / 2, 80), y: secondHead.top + secondHead.height / 2 };
                    const secondHit = document.elementFromPoint(secondPoint.x, secondPoint.y);
                    const secondClose = second.querySelector('[data-action="cwin-close"]').getBoundingClientRect();
                    const secondCloseHit = document.elementFromPoint(secondClose.left + secondClose.width / 2, secondClose.top + secondClose.height / 2);
                    return {
                        topGap: secondHead.top - firstHead.top,
                        firstHeaderHeight: firstHead.height,
                        firstHeaderHit: firstHit?.closest?.('.ica--cwin')?.dataset.agentId ?? '',
                        firstCloseHit: closeHit?.closest?.('.ica--cwin')?.dataset.agentId ?? '',
                        firstCloseAction: closeHit?.closest?.('[data-action]')?.dataset.action ?? '',
                        secondHeaderHit: secondHit?.closest?.('.ica--cwin')?.dataset.agentId ?? '',
                        secondCloseHit: secondCloseHit?.closest?.('.ica--cwin')?.dataset.agentId ?? '',
                        secondCloseAction: secondCloseHit?.closest?.('[data-action]')?.dataset.action ?? '',
                        firstHeaderTop: firstHead.top,
                        secondHeaderTop: secondHead.top,
                        viewportHeight: window.innerHeight,
                    };
                }, { firstId, secondId });

                expect(stack.topGap).toBeGreaterThanOrEqual(stack.firstHeaderHeight + 4);
                expect(stack.firstHeaderHit).toBe(firstId);
                expect(stack.firstCloseHit).toBe(firstId);
                expect(stack.firstCloseAction).toBe('cwin-close');
                expect(stack.secondHeaderHit).toBe(secondId);
                expect(stack.secondCloseHit).toBe(secondId);
                expect(stack.secondCloseAction).toBe('cwin-close');
                expect(stack.firstHeaderTop).toBeGreaterThanOrEqual(0);
                expect(stack.secondHeaderTop).toBeLessThan(stack.viewportHeight);

                const before = await firstWindow.evaluate(element => {
                    const body = element.querySelector('.ica--cwin-body');
                    const details = element.querySelector('.ica--cwin-body details');
                    body.scrollTop = 160;
                    details.open = true;
                    return { scrollTop: body.scrollTop, open: details.open, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight };
                });
                expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
                expect(before.scrollTop).toBeGreaterThan(0);

                const spoofFocus = await firstWindow.evaluate(element => {
                    const spoof = element.querySelector('.ica--cwin-note [data-cwin-focus]');
                    spoof?.focus({ preventScroll: true });
                    return { present: Boolean(spoof), active: document.activeElement === spoof };
                });
                expect(spoofFocus).toEqual({ present: true, active: true });

                const afterUnchangedRefresh = await page.evaluate(async id => {
                    const beforeElement = document.querySelector(`.ica--cwin[data-agent-id="${id}"]`);
                    const { refreshCompanionWindows } = await import('/scripts/extensions/in-chat-agents/companion/companion-windows.js');
                    refreshCompanionWindows();
                    const afterElement = document.querySelector(`.ica--cwin[data-agent-id="${id}"]`);
                    const body = afterElement.querySelector('.ica--cwin-body');
                    return {
                        sameElement: beforeElement === afterElement,
                        scrollTop: body.scrollTop,
                        open: afterElement.querySelector('.ica--cwin-body details')?.open === true,
                        spoofActive: document.activeElement === afterElement.querySelector('.ica--cwin-note [data-cwin-focus]'),
                    };
                }, firstId);
                expect(afterUnchangedRefresh).toEqual({
                    sameElement: true,
                    scrollTop: before.scrollTop,
                    open: true,
                    spoofActive: true,
                });

                await page.evaluate(async id => {
                    const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                    const companion = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
                    const chat = window.SillyTavern.getContext().chat;
                    await store.saveAgent(id, { update: draft => ({ ...draft, enabled: false }) });
                    const index = chat.findLastIndex(message => !message.is_user && !message.is_system);
                    await companion.emitCompanionResultsUpdated(index, id);
                }, firstId);
                await expect(firstWindow.locator('[data-role="cwin-status"]')).toHaveText('Off');
                const afterRebuild = await firstWindow.evaluate(element => {
                    const body = element.querySelector('.ica--cwin-body');
                    return { scrollTop: body.scrollTop, open: element.querySelector('.ica--cwin-body details')?.open === true };
                });
                expect(afterRebuild).toEqual({ scrollTop: before.scrollTop, open: true });

                await page.evaluate(async ({ firstId, secondId }) => {
                    const chat = window.SillyTavern.getContext().chat;
                    const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                    const { setCompanionResult } = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
                    const { eventSource, event_types } = await import('/scripts/events.js');
                    const message = { name: 'Miso', is_user: false, is_system: false, mes: 'Switched chat', extra: {} };
                    chat.splice(0, chat.length, message);
                    const first = store.getAgentById(firstId);
                    const second = store.getAgentById(secondId);
                    setCompanionResult(message, first, {
                        status: 'done',
                        content: '<details><summary>New detail</summary><p>New chat note.</p></details><div style="height:1200px">Switched note body.</div>',
                        format: 'html',
                    });
                    setCompanionResult(message, second, { status: 'done', content: '<p>Second switched note.</p>', format: 'html' });
                    await eventSource.emit(event_types.CHAT_CHANGED);
                }, { firstId, secondId });
                await expect(firstWindow).toContainText('Switched note body.');
                const afterChatSwitch = await firstWindow.evaluate(element => {
                    const body = element.querySelector('.ica--cwin-body');
                    return { scrollTop: body.scrollTop, open: element.querySelector('.ica--cwin-body details')?.open === true };
                });
                expect(afterChatSwitch).toEqual({ scrollTop: 0, open: false });
                await page.screenshot({ path: info.outputPath('companion-windows-stack.png') });
            } finally {
                await page.evaluate(async ids => {
                    for (const button of document.querySelectorAll('.ica--cwin [data-action="cwin-close"]')) button.click();
                    const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                    const companion = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
                    for (const message of window.SillyTavern.getContext().chat) {
                        for (const id of ids) companion.deleteCompanionResult(message, id);
                    }
                    for (const id of ids) await store.deleteAgent(id).catch(() => {});
                }, [firstId, secondId]).catch(() => {});
            }
        });

        test('keeps the dashboard open when there is no chat to display a window over', async ({ page }) => {
            page.setDefaultTimeout(15000);
            const id = `companion-no-chat-window-${viewport.width}-${Date.now()}`;
            await isolateSettingsSaves(page, clearStoredWindows);
            await prepareAssistantPage(page);

            try {
                await page.evaluate(async id => {
                    const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                    const agent = {
                        ...store.createDefaultAgent(),
                        id,
                        name: 'No Chat Window',
                        execution: 'companion',
                        category: 'companion',
                        enabled: true,
                        prompt: 'Return a note.',
                        companion: { trigger: 'manual', displayMode: 'panel' },
                    };
                    await store.saveAgent(agent);
                    const chat = window.SillyTavern.getContext().chat;
                    chat.splice(0, chat.length);
                    const dashboard = await import('/scripts/extensions/in-chat-agents/companion/companion-dashboard.js');
                    void dashboard.openCompanionDashboard();
                }, id);

                const dashboard = page.locator('dialog[open] .ica--cdash');
                await expect(dashboard).toBeVisible();
                await dashboard.locator(`[data-agent-id="${id}"] [data-action="window"]`).click();
                await expect(dashboard).toBeVisible();
                await expect(page.locator(`.ica--cwin[data-agent-id="${id}"]`)).toHaveCount(0);
                await expect(page.locator('#toast-container')).toContainText('Open a chat with at least one message');
            } finally {
                await page.evaluate(async id => {
                    const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                    await store.deleteAgent(id).catch(() => {});
                    document.querySelector('dialog[open] .popup-button-ok')?.click();
                }, id).catch(() => {});
            }
        });

        test('removes an open window when its agent is deleted from the live agent list', async ({ page }) => {
            page.setDefaultTimeout(15000);
            const stamp = Date.now();
            const id = `companion-delete-window-${viewport.width}-${stamp}`;
            const otherId = `companion-delete-survivor-${viewport.width}-${stamp}`;
            await isolateSettingsSaves(page, clearStoredWindows);
            await prepareAssistantPage(page);

            try {
                await createAgentFixture(page, id, 'Deleted Floating Notes', '<p>This window should disappear with its agent.</p>');
                await createAgentFixture(page, otherId, 'Surviving Floating Notes', '<p>The survivor keeps its own note.</p>');
                await openPanel(page);
                await page.locator(`[data-agent-id="${id}"] [data-action="panel-open-window"]`).click();
                const windowNode = page.locator(`.ica--cwin[data-agent-id="${id}"]`);
                await expect(windowNode).toBeVisible();
                await openPanel(page);
                await page.locator(`[data-agent-id="${otherId}"] [data-action="panel-open-window"]`).click();
                const survivorWindow = page.locator(`.ica--cwin[data-agent-id="${otherId}"]`);
                await expect(survivorWindow).toContainText('The survivor keeps its own note.');

                await page.evaluate(() => window.NeconyanShell.openTab('left', 'agents'));
                const tabControl = page.locator('#ica--agentTabs [data-tab="all"]:visible, #ica--agentViewSelect:visible');
                await tabControl.evaluate(element => {
                    if (element.tagName === 'SELECT') {
                        element.value = 'all';
                        element.dispatchEvent(new Event('change', { bubbles: true }));
                    } else {
                        element.click();
                    }
                });
                await page.waitForFunction(id => document.querySelector(`#ica--agentList [data-agent-id="${id}"]`), id);
                const card = page.locator(`#ica--agentList [data-agent-id="${id}"]`);
                await expect(card).toBeVisible();
                await card.locator('.ica--card-secondary > summary').click();
                await card.locator('.ica--btn-delete').click();
                await page.locator('dialog[open] .popup-button-ok').click();

                await expect(card).toHaveCount(0);
                await expect(windowNode).toHaveCount(0);
                await expect(survivorWindow).toContainText('The survivor keeps its own note.');
                await expect(survivorWindow.locator('.ica--cwin-head')).toBeVisible();
            } finally {
                await page.evaluate(async ids => {
                    const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                    const companion = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
                    for (const message of window.SillyTavern.getContext().chat) {
                        for (const id of ids) companion.deleteCompanionResult(message, id);
                    }
                    for (const id of ids) await store.deleteAgent(id).catch(() => {});
                }, [id, otherId]).catch(() => {});
            }
        });
    });
}
