/* global window, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [true, false]) {
    test(`Companion history controls share one row on ${phone ? 'phone' : 'desktop'}`, async ({ app }, info) => {
        test.setTimeout(120000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context);
        await account.post('/api/in-chat-agents/save', {
            id: 'history-row', name: 'Scene Notes', enabled: true,
            execution: 'companion', category: 'companion', prompt: 'Keep a separate scene note.',
            companion: { displayMode: 'panel', trigger: 'manual', includeAllChatHistory: true },
        });
        const page = await account.open({ workspace: false });
        const panel = page.locator('#ica--tracker-panel');
        await expect(panel).toBeAttached({ timeout: 60000 });
        await page.evaluate(async () => {
            (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel();
            window.toastr?.remove();
        });
        if (phone) await applyIOSOnlyCss(page, { inPlace: true });
        const row = panel.locator('[data-agent-id="history-row"] .ica--companion-quick-history');
        await expect(row).toBeVisible();
        await row.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../screenshots/companion-history-${phone ? 'phone' : 'desktop'}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
        const geometry = await row.evaluate(element => ({
            row: element.getBoundingClientRect().toJSON(),
            labels: [...element.children].map(label => ({
                ...label.getBoundingClientRect().toJSON(),
                text: label.textContent.trim(),
                font: getComputedStyle(label).fontSize,
                input: label.querySelector('input').getBoundingClientRect().toJSON(),
            })),
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
        }));
        await info.attach('history-row-geometry', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' });
        expect(new Set(geometry.labels.map(label => Math.round(label.top + label.height / 2))).size).toBe(1);
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
        for (const label of geometry.labels) {
            expect(label.left).toBeGreaterThanOrEqual(geometry.row.left);
            expect(label.right).toBeLessThanOrEqual(geometry.row.right + 1);
            expect(label.height).toBeGreaterThanOrEqual(phone ? 44 : 36);
        }
        const keep = row.getByRole('checkbox', { name: 'Keep in chat history', exact: true });
        const count = row.locator('[data-quick-depth]');
        const depth = row.locator('[data-quick-insert-depth]');
        await keep.check();
        await count.fill('12');
        await count.press('Tab');
        await depth.fill('3');
        await depth.press('Tab');
        await expect.poll(async () => {
            const agents = await account.post('/api/in-chat-agents/list');
            const { includeInChatHistory, chatHistoryDepth, chatHistoryInsertDepth } = agents.find(agent => agent.id === 'history-row').companion;
            return { includeInChatHistory, chatHistoryDepth, chatHistoryInsertDepth };
        }).toEqual({ includeInChatHistory: true, chatHistoryDepth: 12, chatHistoryInsertDepth: 3 });
        await expect(keep).toBeChecked();
        await expect(count).toHaveValue('12');
        await expect(depth).toHaveValue('3');
    });
}
