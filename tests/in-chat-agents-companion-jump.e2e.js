/* global document, window */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves } from './chat-scroll-regression-helpers.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(120000);

const LONG_NOTE = Array.from({ length: 14 }, (_, index) => `Line ${index + 1} of the watch report.`).join('\n\n');

for (const width of [393, 1280]) {
    test(`companion panel jumps to its top and bottom at ${width}px`, async ({ browser }) => {
        const phone = width === 393;
        const context = await browser.newContext({ viewport: { width, height: phone ? 852 : 900 }, hasTouch: phone, serviceWorkers: 'block', reducedMotion: 'reduce' });
        const page = await context.newPage();
        const prefix = `panel-jump-${width}-`;
        try {
            await isolateSettingsSaves(page, settings => {
                settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', 'NeconyanTutorialHidden.v1': 'true' };
            });
            await page.goto('/');
            await page.waitForFunction(() => window.NeconyanShell && document.body.classList.contains('neconyan-rail-ready'));
            await expect(page.locator('#ica--run-status')).not.toHaveText('Loading your agents...');
            await page.evaluate(async ({ prefix, note }) => {
                const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                const results = {};
                for (const [index, name] of ['Harbour', 'Lantern', 'Orchard', 'Belfry', 'Compass', 'Quarry', 'Meadow', 'Signal'].entries()) {
                    const id = `${prefix}${index}`;
                    await store.saveAgent({ id, name, enabled: true, execution: 'companion', category: 'companion', injection: { order: index * 10 }, companion: { displayMode: 'panel' } });
                    results[id] = { status: 'done', agentName: name, content: note };
                }
                const { chat } = await import('/script.js');
                chat.push({ is_user: false, mes: 'A saved reply.', extra: { inChatAgentCompanionResults: results } });
                (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel();
            }, { prefix, note: LONG_NOTE });

            const panel = page.locator('#ica--tracker-panel');
            const group = panel.getByRole('group', { name: 'Jump through the panel' });
            const up = panel.getByRole('button', { name: 'Jump to top' });
            const down = panel.getByRole('button', { name: 'Jump to bottom' });
            await expect(group).toBeVisible();
            await expect(up).toHaveAttribute('aria-disabled', 'true');
            await expect(down).not.toHaveAttribute('aria-disabled', 'true');

            const measure = () => panel.evaluate(element => {
                const panelRect = element.getBoundingClientRect();
                const style = element.ownerDocument.defaultView.getComputedStyle(element);
                const upRect = element.querySelector('[data-action="panel-scroll-top"]').getBoundingClientRect();
                const downRect = element.querySelector('[data-action="panel-scroll-bottom"]').getBoundingClientRect();
                const cards = [...element.querySelectorAll('.ica--tpanel-agent:not(.displayNone)')];
                const lastCard = cards.at(-1).getBoundingClientRect();
                return {
                    scrollTop: element.scrollTop,
                    maxScroll: element.scrollHeight - element.clientHeight,
                    panelRight: panelRect.right - parseFloat(style.paddingRight),
                    panelBottom: Math.min(panelRect.bottom, window.innerHeight),
                    up: { top: upRect.top, bottom: upRect.bottom, right: upRect.right, width: upRect.width, height: upRect.height },
                    down: { top: downRect.top, bottom: downRect.bottom, right: downRect.right, width: downRect.width, height: downRect.height },
                    lastCardBottom: lastCard.bottom,
                    overflowX: element.scrollWidth > element.clientWidth + 1,
                };
            });

            // Cards far below the fold are left unpainted until they scroll near, so a busy panel opens without freezing.
            const skipped = () => panel.evaluate(element => {
                // A skipped card still reports itself visible; its contents are what go unpainted.
                const painted = card => card.firstElementChild.checkVisibility({ contentVisibilityAuto: true });
                const cards = [...element.querySelectorAll('.ica--tpanel-agent:not(.displayNone)')];
                return { first: painted(cards[0]), last: painted(cards.at(-1)) };
            });
            await expect.poll(skipped).toEqual({ first: true, last: false });

            const start = await measure();
            expect(start.maxScroll).toBeGreaterThan(200);
            expect(start.overflowX).toBe(false);
            expect(start.up.bottom).toBeLessThanOrEqual(start.down.top);
            expect(Math.abs(start.down.right - start.panelRight)).toBeLessThanOrEqual(1);
            expect(start.down.bottom).toBeLessThanOrEqual(start.panelBottom);
            expect(start.panelBottom - start.down.bottom).toBeLessThanOrEqual(24);
            for (const rect of [start.up, start.down]) {
                expect(rect.width).toBeGreaterThanOrEqual(phone ? 44 : 36);
                expect(rect.height).toBeGreaterThanOrEqual(phone ? 44 : 36);
            }

            await down.click();
            // Unpainted cards only estimate their height, so the panel grows as they appear; it must still end at the real bottom.
            await expect.poll(async () => {
                const { scrollTop, maxScroll } = await measure();
                return maxScroll - scrollTop;
            }).toBeLessThanOrEqual(1);
            expect((await skipped()).last).toBe(true);
            await expect(down).toHaveAttribute('aria-disabled', 'true');
            await expect(up).not.toHaveAttribute('aria-disabled', 'true');
            const end = await measure();
            expect(end.lastCardBottom).toBeLessThanOrEqual(end.up.top);
            expect(Math.abs(end.down.bottom - start.down.bottom)).toBeLessThanOrEqual(1);

            await up.click();
            await expect.poll(async () => (await measure()).scrollTop).toBe(0);
            await expect(up).toHaveAttribute('aria-disabled', 'true');
            await expect(panel).toBeVisible();

            const search = panel.getByRole('searchbox', { name: 'Search companions and notes' });
            await search.fill('no such companion');
            await expect(panel.locator('[data-role="panel-search-empty"]')).toBeVisible();
            await expect(group).toBeHidden();
            await search.fill('');
            await expect(group).toBeVisible();
        } finally {
            await page.evaluate(async prefix => {
                const { getAgents, deleteAgent } = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                for (const agent of getAgents().filter(agent => agent.id.startsWith(prefix))) await deleteAgent(agent.id);
            }, prefix).catch(() => {});
            await context.close();
        }
    });
}
