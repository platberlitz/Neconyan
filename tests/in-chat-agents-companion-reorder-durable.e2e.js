/* global document, window */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(120000);

for (const phone of [true, false]) {
    test(`companion order survives a result refresh and page reload on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        const account = await app.account({ phone });
        const page = await account.open({ workspace: false });
        await page.waitForFunction(async () => (await import('/scripts/extensions/in-chat-agents/agent-store.js')).areAgentsLoaded());
        await page.evaluate(async () => {
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            for (const [order, id] of ['reorder-a', 'reorder-b', 'reorder-c'].entries()) {
                const agent = store.createDefaultAgent();
                Object.assign(agent, { id, name: id, execution: 'companion', category: 'companion', enabled: true, prompt: 'Return a note.' });
                Object.assign(agent.companion, { trigger: 'manual', displayMode: 'panel' });
                agent.injection.order = order;
                await store.saveAgent(agent);
            }
            (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel();
        });
        const panel = page.locator('#ica--tracker-panel');
        await expect(panel).toBeVisible();
        const sections = panel.locator('.ica--tpanel-agent');
        const order = () => sections.evaluateAll(nodes => nodes.map(node => node.dataset.agentId));
        await expect.poll(order).toEqual(['reorder-a', 'reorder-b', 'reorder-c']);
        // Measure the grip only once the panel has finished sliding in and startup notices are gone.
        await expect.poll(() => panel.evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
        await page.evaluate(() => window.toastr?.remove());
        const grip = sections.first().locator('.ica--tpanel-drag-handle');
        const draggedHandle = await grip.elementHandle();
        expect(await grip.evaluate(node => window.getComputedStyle(node).touchAction)).toBe('none');
        const handle = await grip.boundingBox();
        const target = await sections.nth(1).boundingBox();
        const x = handle.x + handle.width / 2;
        const y = handle.y + handle.height / 2;
        const targetY = target.y + target.height / 2;
        let release;
        if (phone) {
            const cdp = await page.context().newCDPSession(page);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
            for (let step = 1; step <= 12; step++) {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (targetY - y) * step / 12 }] });
            }
            release = async () => {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                await cdp.detach();
            };
        } else {
            await page.mouse.move(x, y);
            await page.mouse.down();
            await page.mouse.move(x, targetY, { steps: 12 });
            release = () => page.mouse.up();
        }
        await expect(panel.locator('.ui-sortable-helper')).toHaveCount(1);
        await page.evaluate(async () => {
            await (await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js')).emitCompanionResultsUpdated(0, 'reorder-a');
        });
        await expect(panel.locator('.ui-sortable-helper')).toHaveCount(1);
        await release();
        await expect.poll(order).toEqual(['reorder-b', 'reorder-a', 'reorder-c']);
        // The panel renders again only after the complete batch save, including
        // its recovery-record cleanup, has finished.
        await expect.poll(() => draggedHandle.evaluate(node => node.isConnected)).toBe(false);
        await page.waitForFunction(async () => {
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            return store.getAgentById('reorder-b').injection.order < store.getAgentById('reorder-a').injection.order;
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await page.waitForFunction(async () => (await import('/scripts/extensions/in-chat-agents/agent-store.js')).areAgentsLoaded());
        await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel());
        await expect(panel).toBeVisible();
        await expect.poll(order).toEqual(['reorder-b', 'reorder-a', 'reorder-c']);
    });
}
