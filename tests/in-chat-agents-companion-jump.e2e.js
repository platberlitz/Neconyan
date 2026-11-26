/* global document, requestAnimationFrame, window */
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
            const openSkipped = await page.evaluate(async ({ prefix, note }) => {
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

                // Wait frame-by-frame on open (well before the 450ms background hydration delay)
                // so Chromium's content-visibility: auto pass settles on both 393px and 1280px.
                const panel = document.getElementById('ica--tracker-panel');
                const painted = card => card.firstElementChild.checkVisibility({ contentVisibilityAuto: true });
                const cards = [...panel.querySelectorAll('.ica--tpanel-agent:not(.displayNone)')];
                let state = { first: false, last: true };
                for (let frame = 0; frame < 15; frame += 1) {
                    await new Promise(resolve => requestAnimationFrame(resolve));
                    state = { first: painted(cards[0]), last: painted(cards.at(-1)) };
                    if (state.first && !state.last) break;
                }
                return state;
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

            // Cards far below the fold are left unpainted on opening paint until background hydration or scroll brings them in.
            const skipped = () => panel.evaluate(element => {
                // A skipped card still reports itself visible; its contents are what go unpainted.
                const painted = card => card.firstElementChild.checkVisibility({ contentVisibilityAuto: true });
                const cards = [...element.querySelectorAll('.ica--tpanel-agent:not(.displayNone)')];
                return { first: painted(cards[0]), last: painted(cards.at(-1)) };
            });
            expect(openSkipped).toEqual({ first: true, last: false });

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
            // Unpainted cards only estimate their height, so the panel grows as they appear; wait until it lands at the real bottom with the last card painted.
            await expect.poll(async () => {
                const [{ scrollTop, maxScroll }, { last }] = await Promise.all([measure(), skipped()]);
                return maxScroll - scrollTop <= 1 && last;
            }).toBe(true);
            await expect(down).toHaveAttribute('aria-disabled', 'true');
            await expect(up).not.toHaveAttribute('aria-disabled', 'true');
            const end = await measure();
            expect(end.maxScroll - end.scrollTop).toBeLessThanOrEqual(1);
            expect((await skipped()).last).toBe(true);
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

    test(`companion panel hydrates in the background and stays steady across reopen, scroll-up, and live updates at ${width}px`, async ({ browser }) => {
        const phone = width === 393;
        const context = await browser.newContext({ viewport: { width, height: phone ? 852 : 900 }, hasTouch: phone, serviceWorkers: 'block', reducedMotion: 'reduce' });
        const page = await context.newPage();
        const prefix = `panel-steady-${width}-`;
        const cardCount = 24;
        try {
            await isolateSettingsSaves(page, settings => {
                settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', 'NeconyanTutorialHidden.v1': 'true' };
            });
            await page.goto('/');
            await page.waitForFunction(() => window.NeconyanShell && document.body.classList.contains('neconyan-rail-ready'));
            await expect(page.locator('#ica--run-status')).not.toHaveText('Loading your agents...');

            const openProbe = await page.evaluate(async ({ prefix, cardCount }) => {
                const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                const panelMod = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
                const { chat } = await import('/script.js');
                const results = {};
                const counts = [2, 16, 4, 22, 6, 18];
                for (let index = 0; index < cardCount; index++) {
                    const id = `${prefix}${String(index).padStart(2, '0')}`;
                    const name = `Steady ${String(index + 1).padStart(2, '0')}`;
                    const paragraphs = counts[index % counts.length];
                    const content = Array.from({ length: paragraphs }, (_, p) => `Entry ${index + 1}.${p + 1}: steady layout check for background hydration.`).join('\n\n');
                    await store.saveAgent({ id, name, enabled: true, execution: 'companion', category: 'companion', injection: { order: index * 10 }, companion: { displayMode: 'panel' } });
                    results[id] = { status: 'done', agentName: name, content };
                }
                chat.push({ is_user: false, mes: 'Steady panel reply.', extra: { inChatAgentCompanionResults: results } });
                panelMod.openCompanionPanel();

                // Let the opening paint settle while background hydration has not started yet.
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const panel = document.getElementById('ica--tracker-panel');
                const cards = [...panel.querySelectorAll('.ica--tpanel-agent:not(.displayNone)')];
                const painted = card => card.firstElementChild.checkVisibility({ contentVisibilityAuto: true });
                return {
                    count: cards.length,
                    firstPainted: painted(cards[0]),
                    lastPainted: painted(cards.at(-1)),
                    hydrated: cards.filter(card => card.classList.contains('is-hydrated')).length,
                };
            }, { prefix, cardCount });

            expect(openProbe.count).toBeGreaterThanOrEqual(cardCount);
            expect(openProbe.firstPainted).toBe(true);
            expect(openProbe.lastPainted).toBe(false);
            expect(openProbe.hydrated).toBe(0);

            const panel = page.locator('#ica--tracker-panel');
            // Background hydration runs progressively until every card is hydrated and has a cached content-box intrinsic height.
            await expect.poll(() => panel.evaluate(el => {
                const cards = [...el.querySelectorAll('.ica--tpanel-agent:not(.displayNone)')];
                const hydrated = cards.filter(card => card.classList.contains('is-hydrated')).length;
                const cached = cards.filter(card => card.style.getPropertyValue('contain-intrinsic-block-size').includes('px')).length;
                return { total: cards.length, hydrated, cached };
            })).toEqual({ total: openProbe.count, hydrated: openProbe.count, cached: openProbe.count });

            // Jump to the bottom, then close and reopen: cards unhydrate on close while preserving exact intrinsic sizes,
            // reopen keeps off-screen top cards skipped on frame 1, and lands on the exact same anchor without jump-bar clamping.
            const down = panel.getByRole('button', { name: 'Jump to bottom' });
            await down.click();
            await expect.poll(() => panel.evaluate(el => (el.scrollHeight - el.clientHeight) - el.scrollTop)).toBeLessThanOrEqual(1);

            const reopenResult = await page.evaluate(async () => {
                const panelMod = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
                const panel = document.getElementById('ica--tracker-panel');
                const readAnchor = () => {
                    const pr = panel.getBoundingClientRect();
                    for (const card of panel.querySelectorAll('.ica--tpanel-agent:not(.displayNone)')) {
                        const r = card.getBoundingClientRect();
                        if (r.bottom > pr.top && r.top < pr.bottom) {
                            return { id: card.dataset.agentId, top: r.top - pr.top };
                        }
                    }
                    return null;
                };
                const beforeAnchor = readAnchor();
                const beforeScrollTop = panel.scrollTop;
                const beforeMaxScroll = panel.scrollHeight - panel.clientHeight;

                panelMod.closeCompanionPanel();
                const closedCards = [...panel.querySelectorAll('.ica--tpanel-agent:not(.displayNone)')];
                const closedHydrated = closedCards.filter(card => card.classList.contains('is-hydrated')).length;
                const closedCached = closedCards.filter(card => card.style.getPropertyValue('contain-intrinsic-block-size').includes('px')).length;

                panelMod.openCompanionPanel();
                const openCards = [...panel.querySelectorAll('.ica--tpanel-agent:not(.displayNone)')];
                const firstPaintedOnReopen = openCards[0].firstElementChild.checkVisibility({ contentVisibilityAuto: true });
                const afterAnchor = readAnchor();
                const afterScrollTop = panel.scrollTop;
                const afterMaxScroll = panel.scrollHeight - panel.clientHeight;

                // Measure upward scroll steps immediately after reopen.
                const step = Math.max(120, Math.round(panel.clientHeight * 0.45));
                let maxScrollUpJump = 0;
                for (let i = 0; i < 16 && panel.scrollTop > 0; i++) {
                    const anchor = readAnchor();
                    const prevTop = panel.scrollTop;
                    const nextTop = Math.max(0, prevTop - step);
                    const intendedDelta = prevTop - nextTop;
                    panel.scrollTop = nextTop;
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    if (anchor) {
                        const el = panel.querySelector(`.ica--tpanel-agent[data-agent-id="${anchor.id}"]`);
                        const actualShift = (el.getBoundingClientRect().top - panel.getBoundingClientRect().top) - anchor.top;
                        maxScrollUpJump = Math.max(maxScrollUpJump, Math.abs(actualShift - intendedDelta));
                    }
                }

                return {
                    total: openCards.length,
                    closedHydrated,
                    closedCached,
                    firstPaintedOnReopen,
                    sameAnchor: beforeAnchor?.id === afterAnchor?.id,
                    landingErrorPx: beforeAnchor && afterAnchor ? Math.abs(afterAnchor.top - beforeAnchor.top) : 999,
                    bottomGapAfterReopen: Math.abs((afterMaxScroll - afterScrollTop) - (beforeMaxScroll - beforeScrollTop)),
                    maxScrollUpJump,
                };
            });

            expect(reopenResult.closedHydrated).toBe(0);
            expect(reopenResult.closedCached).toBe(reopenResult.total);
            expect(reopenResult.firstPaintedOnReopen).toBe(false);
            expect(reopenResult.sameAnchor).toBe(true);
            expect(reopenResult.landingErrorPx).toBeLessThanOrEqual(2);
            expect(reopenResult.bottomGapAfterReopen).toBeLessThanOrEqual(2);
            expect(reopenResult.maxScrollUpJump).toBeLessThanOrEqual(2);

            // Live companion update above the viewport while reading keeps the current card steady and preserves cached intrinsic height.
            await expect.poll(() => panel.evaluate(el => {
                const cards = [...el.querySelectorAll('.ica--tpanel-agent:not(.displayNone)')];
                return cards.every(card => card.classList.contains('is-hydrated'));
            })).toBe(true);

            const liveResult = await page.evaluate(async ({ prefix }) => {
                const { chat, eventSource } = await import('/script.js');
                const { COMPANION_RESULTS_UPDATED_EVENT } = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
                const panel = document.getElementById('ica--tracker-panel');
                const targetCard = panel.querySelector(`.ica--tpanel-agent[data-agent-id="${prefix}16"]`);
                panel.scrollTop = Math.max(0, targetCard.offsetTop - 40);
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

                const pr = panel.getBoundingClientRect();
                const beforeTop = targetCard.getBoundingClientRect().top - pr.top;
                const upperId = `${prefix}01`;
                const upperBeforeIntrinsic = panel.querySelector(`.ica--tpanel-agent[data-agent-id="${upperId}"]`)?.style.getPropertyValue('contain-intrinsic-block-size') || '';

                const msg = chat[chat.length - 1];
                msg.extra.inChatAgentCompanionResults[upperId] = {
                    ...msg.extra.inChatAgentCompanionResults[upperId],
                    content: `${msg.extra.inChatAgentCompanionResults[upperId].content}\n\nFresh live update paragraph.`,
                    timestamp: Date.now(),
                };
                await eventSource.emit(COMPANION_RESULTS_UPDATED_EVENT);
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

                const afterEl = panel.querySelector(`.ica--tpanel-agent[data-agent-id="${prefix}16"]`);
                const afterTop = afterEl.getBoundingClientRect().top - panel.getBoundingClientRect().top;
                const upperAfterIntrinsic = panel.querySelector(`.ica--tpanel-agent[data-agent-id="${upperId}"]`)?.style.getPropertyValue('contain-intrinsic-block-size') || '';
                return {
                    shiftPx: Math.abs(afterTop - beforeTop),
                    upperBeforeIntrinsic,
                    upperAfterIntrinsic,
                };
            }, { prefix });

            expect(liveResult.shiftPx).toBeLessThanOrEqual(2);
            expect(liveResult.upperBeforeIntrinsic).toMatch(/^auto \d/);
            expect(liveResult.upperAfterIntrinsic).toMatch(/^auto \d/);
        } finally {
            await page.evaluate(async prefix => {
                const { getAgents, deleteAgent } = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                for (const agent of getAgents().filter(agent => agent.id.startsWith(prefix))) await deleteAgent(agent.id);
            }, prefix).catch(() => {});
            await context.close();
        }
    });

    test(`companion panel reopens where it was after new notes arrive while closed at ${width}px`, async ({ browser }) => {
        const phone = width === 393;
        const context = await browser.newContext({ viewport: { width, height: phone ? 852 : 900 }, hasTouch: phone, serviceWorkers: 'block', reducedMotion: 'reduce' });
        const page = await context.newPage();
        const prefix = `panel-reopen-new-${width}-`;
        const cardCount = 16;
        const targetId = `${prefix}06`;
        const notes = (round, counts) => Object.fromEntries(Array.from({ length: cardCount }, (_, index) => {
            const content = Array.from({ length: counts[index % counts.length] }, (_, line) => `Entry ${index + 1}.${line + 1}: ${round} note for this turn.`).join('\n\n');
            return [`${prefix}${String(index).padStart(2, '0')}`, content];
        }));
        try {
            await isolateSettingsSaves(page, settings => {
                settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', 'NeconyanTutorialHidden.v1': 'true' };
            });
            await page.goto('/');
            await page.waitForFunction(() => window.NeconyanShell && document.body.classList.contains('neconyan-rail-ready'));
            await expect(page.locator('#ica--run-status')).not.toHaveText('Loading your agents...');
            await page.evaluate(async ({ firstNotes }) => {
                const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                const results = {};
                for (const [index, [id, content]] of Object.entries(firstNotes).entries()) {
                    const name = `Reopen ${String(index + 1).padStart(2, '0')}`;
                    await store.saveAgent({ id, name, enabled: true, execution: 'companion', category: 'companion', injection: { order: index * 10 }, companion: { displayMode: 'panel' } });
                    results[id] = { status: 'done', agentName: name, content };
                }
                const { chat } = await import('/script.js');
                chat.push({ is_user: false, mes: 'First reply.', extra: { inChatAgentCompanionResults: results } });
                (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel();
            }, { firstNotes: notes('first', [2, 8, 4, 10, 3, 9]) });

            const panel = page.locator('#ica--tracker-panel');
            await expect.poll(() => panel.evaluate(element => [...element.querySelectorAll('.ica--tpanel-agent:not(.displayNone)')]
                .every(card => card.classList.contains('is-hydrated')))).toBe(true);
            const targetTop = () => panel.evaluate((element, id) => {
                const card = element.querySelector(`.ica--tpanel-agent[data-agent-id="${id}"]`);
                return card.getBoundingClientRect().top - element.getBoundingClientRect().top;
            }, targetId);

            await panel.evaluate((element, id) => {
                element.scrollTop = element.querySelector(`.ica--tpanel-agent[data-agent-id="${id}"]`).offsetTop - 30;
            }, targetId);
            await page.waitForTimeout(400);
            const before = await targetTop();

            // Notes above the reading position get rewritten to new lengths while the panel is closed.
            await page.evaluate(async ({ secondNotes }) => {
                const panelModule = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
                const { chat, eventSource } = await import('/script.js');
                const { COMPANION_RESULTS_UPDATED_EVENT } = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
                panelModule.closeCompanionPanel();
                await new Promise(resolve => setTimeout(resolve, 300));
                const pending = Object.fromEntries(Object.keys(secondNotes).map((id, index) => [id, { status: 'pending', agentName: `Reopen ${String(index + 1).padStart(2, '0')}`, content: '' }]));
                chat.push({ is_user: true, mes: 'Next turn.' });
                chat.push({ is_user: false, mes: 'Second reply.', extra: { inChatAgentCompanionResults: pending } });
                await eventSource.emit(COMPANION_RESULTS_UPDATED_EVENT);
                for (const [id, content] of Object.entries(secondNotes)) {
                    pending[id] = { ...pending[id], status: 'done', content, timestamp: Date.now() };
                }
                await eventSource.emit(COMPANION_RESULTS_UPDATED_EVENT);
            }, { secondNotes: notes('second', [9, 3, 10, 2, 8, 4]) });

            await page.evaluate(async () => {
                (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel();
            });
            const reopened = await targetTop();
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const painted = await targetTop();
            await page.waitForTimeout(1500);
            const settled = await targetTop();

            expect(before).toBeGreaterThanOrEqual(28);
            expect(before).toBeLessThanOrEqual(32);
            expect(Math.abs(reopened - before)).toBeLessThanOrEqual(2);
            expect(Math.abs(painted - before)).toBeLessThanOrEqual(2);
            expect(Math.abs(settled - before)).toBeLessThanOrEqual(2);
        } finally {
            await page.evaluate(async prefix => {
                const { getAgents, deleteAgent } = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                for (const agent of getAgents().filter(agent => agent.id.startsWith(prefix))) await deleteAgent(agent.id);
            }, prefix).catch(() => {});
            await context.close();
        }
    });
}
