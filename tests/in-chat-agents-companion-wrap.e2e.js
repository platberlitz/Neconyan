/* global document, window */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves } from './chat-scroll-regression-helpers.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(120000);

const SHARD_NOTE = [
    '## Character Registry',
    '`Coco|courier-turned-envoy|short,freckled,auburn-braid,ink-stained-fingers|smug,upbeat,stubborn,quick-witted|forgery-detection,court-etiquette,lockpicking|alive,unharmed,carrying-signed-royal-warrant`',
    '## World State',
    '`political:crown-signed-warrants-override-chancellery-seals;chancellery-seal-forgery-is-a-hanging-offence;the-eastern-provinces-refuse-royal-couriers`',
    '## Sensory Anchors',
    [
        '| anchor | sense | events | significance |',
        '| --- | --- | --- | --- |',
        '| sealing-wax-and-bergamot-from-the-chancellery-writing-desk | olfactory | 1,3,5 | the smell Coco associates with power and with getting away with things |',
    ].join('\n'),
    '## Current State',
    '```\nPending: deliver-the-signed-royal-warrant-to-the-Queen\'s-secretary-before-the-evening-bell-rings|then-report-to-the-harbour-master\n```',
    'https://example.com/a/very/long/reference/link/that/the/model/pasted/without/any/spaces/at/all/whatsoever',
].join('\n\n');

for (const width of [393, 1280]) {
    test(`companion panel wraps long Memory Shard lines at ${width}px`, async ({ browser }) => {
        const phone = width === 393;
        const context = await browser.newContext({ viewport: { width, height: phone ? 852 : 900 }, hasTouch: phone, serviceWorkers: 'block', reducedMotion: 'reduce' });
        const page = await context.newPage();
        const prefix = `panel-wrap-${width}-`;
        try {
            await isolateSettingsSaves(page, settings => {
                settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', 'NeconyanTutorialHidden.v1': 'true' };
            });
            await page.goto('/');
            await page.waitForFunction(() => window.NeconyanShell && document.body.classList.contains('neconyan-rail-ready'));
            await expect(page.locator('#ica--run-status')).not.toHaveText('Loading your agents...');
            await page.evaluate(async ({ prefix, note }) => {
                const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                const id = `${prefix}shard`;
                await store.saveAgent({ id, name: 'Memory Shard', enabled: true, execution: 'companion', category: 'companion', injection: { order: 0 }, companion: { displayMode: 'panel' } });
                const { chat } = await import('/script.js');
                chat.push({ is_user: false, mes: 'A saved reply.', extra: { inChatAgentCompanionResults: { [id]: { status: 'done', agentName: 'Memory Shard', format: 'markdown', content: note } } } });
                (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel();
            }, { prefix, note: SHARD_NOTE });

            const panel = page.locator('#ica--tracker-panel');
            const body = panel.locator('.ica--tpanel-agent-body').first();
            await expect(body.locator('table')).toBeVisible();

            const layout = await panel.evaluate(element => {
                const body = element.querySelector('.ica--tpanel-agent-body');
                const bodyRect = body.getBoundingClientRect();
                const wide = [...body.querySelectorAll('code, pre, table, a, p')]
                    .filter(node => node.getBoundingClientRect().right > bodyRect.right + 8)
                    .map(node => node.tagName);
                const headingLines = [...body.querySelectorAll('th')].map(cell => {
                    const range = document.createRange();
                    range.selectNodeContents(cell);
                    return { text: cell.textContent.trim(), lines: new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size };
                });
                return { overflowX: element.scrollWidth > element.clientWidth + 1, wide, headingLines };
            });

            expect(layout.overflowX).toBe(false);
            expect(layout.wide).toEqual([]);
            for (const heading of layout.headingLines) expect(heading).toEqual({ text: heading.text, lines: 1 });
        } finally {
            await page.evaluate(async prefix => {
                const { getAgents, deleteAgent } = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                for (const agent of getAgents().filter(agent => agent.id.startsWith(prefix))) await deleteAgent(agent.id);
            }, prefix).catch(() => {});
            await context.close();
        }
    });
}
