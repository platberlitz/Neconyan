/* global document, window */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves } from './chat-scroll-regression-helpers.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(120000);

for (const width of [393, 1280]) {
    test(`companion search preserves drafts, focus and filtered order at ${width}px`, async ({ browser }) => {
        const context = await browser.newContext({ viewport: { width, height: width === 393 ? 852 : 900 }, hasTouch: width === 393, serviceWorkers: 'block', reducedMotion: 'reduce' });
        const page = await context.newPage();
        const prefix = `panel-search-${width}-`;
        try {
            await isolateSettingsSaves(page, settings => {
                settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', 'NeconyanTutorialHidden.v1': 'true' };
            });
            await page.goto('/');
            await page.waitForFunction(() => window.NeconyanShell && document.body.classList.contains('neconyan-rail-ready'));
            await expect(page.locator('#ica--run-status')).not.toHaveText('Ready');
            await page.evaluate(async prefix => {
                const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                for (const [index, name] of ['Search Scout', 'Private chat', 'Search Guide'].entries()) {
                    await store.saveAgent({ id: `${prefix}${index}`, name, enabled: true, execution: 'companion', category: 'companion', sourceTemplateId: index === 1 ? 'tpl-chat-only-companion' : '', injection: { order: index * 10 }, companion: { displayMode: 'panel' } });
                }
                const { chat } = await import('/script.js');
                chat.push({ is_user: false, mes: 'A saved reply.', extra: { inChatAgentCompanionResults: {
                    [`${prefix}0`]: { status: 'done', agentName: 'Search Scout', content: 'The observatory is quiet.' },
                } } });
                (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel();
            }, prefix);
            const panel = page.locator('#ica--tracker-panel');
            const search = panel.getByRole('searchbox', { name: 'Search companions and notes' });
            const draft = panel.locator(`[data-agent-id="${prefix}1"] [data-role="chat-only-input"]`);
            await draft.fill('Keep my unfinished aside');
            await search.fill('  OBSERVATORY ');
            await expect(panel.locator('.ica--tpanel-agent:visible')).toHaveCount(1);
            await expect(panel.locator('.ica--tpanel-agent:visible')).toHaveAttribute('data-agent-id', `${prefix}0`);
            await expect(search).toBeFocused();
            await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).refreshCompanionPanel());
            await expect(search).toHaveValue('  OBSERVATORY ');
            await expect(search).toBeFocused();
            await expect(panel.locator('.ica--tpanel-agent:visible')).toHaveCount(1);
            await search.fill('no such companion');
            await expect(panel.locator('[data-role="panel-search-empty"]')).toBeVisible();
            await search.press('Escape');
            await expect(panel).toBeVisible();
            await expect(search).toHaveValue('');
            await expect(draft).toHaveValue('Keep my unfinished aside');
            await search.fill('search');
            await panel.locator(`[data-agent-id="${prefix}0"] .ica--tpanel-drag-handle`).press('ArrowDown');
            await expect.poll(() => page.evaluate(async prefix => {
                const { getAgents } = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                return getAgents().filter(agent => agent.id.startsWith(prefix)).sort((a, b) => a.injection.order - b.injection.order).map(agent => agent.id);
            }, prefix)).toEqual([`${prefix}2`, `${prefix}1`, `${prefix}0`]);
            await panel.getByRole('button', { name: 'Clear companion search' }).click();
            await expect(search).toBeFocused();
            await expect(draft).toHaveValue('Keep my unfinished aside');
            expect((await search.boundingBox()).height).toBeGreaterThanOrEqual(44);
            expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        } finally {
            await page.evaluate(async prefix => {
                const { getAgents, deleteAgent } = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                for (const agent of getAgents().filter(agent => agent.id.startsWith(prefix))) await deleteAgent(agent.id);
            }, prefix).catch(() => {});
            await context.close();
        }
    });
}
