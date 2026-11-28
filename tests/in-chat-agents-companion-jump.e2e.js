/* global document, requestAnimationFrame, window */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves, openReadyChat } from './chat-scroll-regression-helpers.js';

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

    test(`companion panel reopens where it was after a server reply finishes its Agents at ${width}px`, async ({ browser }) => {
        const phone = width === 393;
        const context = await browser.newContext({ viewport: { width, height: phone ? 852 : 900 }, hasTouch: phone, serviceWorkers: 'block', reducedMotion: 'reduce' });
        const page = await context.newPage();
        const prefix = `panel-reopen-server-${width}-`;
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
            await openReadyChat(page);
            await expect(page.locator('#ica--run-status')).not.toHaveText('Loading your agents...');
            await page.evaluate(async ({ firstNotes }) => {
                const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                const results = {};
                for (const [index, [id, content]] of Object.entries(firstNotes).entries()) {
                    const name = `Server ${String(index + 1).padStart(2, '0')}`;
                    await store.saveAgent({ id, name, enabled: true, execution: 'companion', category: 'companion', injection: { order: 1000 + index * 10 }, companion: { displayMode: 'panel' } });
                    results[id] = { status: 'done', agentName: name, content };
                }
                const ctx = window.SillyTavern.getContext();
                const reply = { name: 'Miso', is_user: false, is_system: false, send_date: new Date().toISOString(), mes: 'First reply.', extra: { inChatAgentCompanionResults: results } };
                ctx.chat.push(reply);
                ctx.addOneMessage(reply, { scroll: false });
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

            // The next reply runs on the server: its notes show as pending while the panel is closed.
            const savedTail = await page.evaluate(async ({ secondNotes }) => {
                const panelModule = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
                const { eventSource } = await import('/script.js');
                const { COMPANION_RESULTS_UPDATED_EVENT } = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
                panelModule.closeCompanionPanel();
                await new Promise(resolve => setTimeout(resolve, 300));
                const ctx = window.SillyTavern.getContext();
                const names = Object.keys(secondNotes).map((_, index) => `Server ${String(index + 1).padStart(2, '0')}`);
                const pending = Object.fromEntries(Object.keys(secondNotes).map((id, index) => [id, { status: 'pending', agentName: names[index], content: '' }]));
                const turn = { name: ctx.name1, is_user: true, is_system: false, send_date: new Date().toISOString(), mes: 'Next turn.' };
                const reply = { name: 'Miso', is_user: false, is_system: false, send_date: new Date().toISOString(), mes: 'Second reply.', extra: { inChatAgentCompanionResults: pending } };
                for (const message of [turn, reply]) {
                    ctx.chat.push(message);
                    ctx.addOneMessage(message, { scroll: false });
                }
                await eventSource.emit(COMPANION_RESULTS_UPDATED_EVENT);
                const tail = ctx.chat.map(message => structuredClone(message));
                const done = Object.fromEntries(Object.entries(secondNotes)
                    .map(([id, content], index) => [id, { status: 'done', agentName: names[index], content, timestamp: Date.now() }]));
                const last = tail.at(-1);
                last.extra.inChatAgentCompanionResults = done;
                // Companion results are read from the active swipe first.
                const swipe = last.swipe_info?.[last.swipe_id ?? 0];
                if (swipe?.extra) {
                    swipe.extra.inChatAgentCompanionResults = structuredClone(done);
                }
                return tail;
            }, { secondNotes: notes('second', [9, 3, 10, 2, 8, 4]) });

            // The server saves the finished reply and the page adopts it, which rebuilds the same chat.
            await page.route('**/api/chats/get', async route => {
                const body = JSON.parse(route.request().postData() || '{}');
                const response = await route.fetch({ postData: JSON.stringify({ ...body, allow_create: true }) });
                const records = await response.json().catch(() => []);
                const header = Array.isArray(records) && records[0] && !('mes' in records[0]) ? records[0] : { chat_metadata: {} };
                const headers = { ...response.headers() };
                delete headers['content-length'];
                delete headers['content-encoding'];
                await route.fulfill({ status: 200, headers, body: JSON.stringify([header, ...savedTail]) });
            });
            await page.evaluate(async () => {
                const { refreshCurrentChatFromSaved } = await import('/script.js');
                await refreshCurrentChatFromSaved();
            });
            await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chat.at(-1)?.extra?.inChatAgentCompanionResults
                && Object.values(window.SillyTavern.getContext().chat.at(-1).extra.inChatAgentCompanionResults).every(result => result.status === 'done'))).toBe(true);

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

    test(`companion panel keeps a middle card steady across animated reopen and tall-card resizes at ${width}px`, async ({ browser }) => {
        test.setTimeout(90_000);
        const context = await browser.newContext({
            viewport: { width, height: 852 },
            reducedMotion: 'no-preference',
            serviceWorkers: 'block',
        });
        const page = await context.newPage();
        const prefix = `e2e-reopen-anim-${width}-${Date.now()}-`;
        const total = 24;
        const targetIndex = 12;
        const targetId = `${prefix}${String(targetIndex).padStart(2, '0')}`;
        try {
            await isolateSettingsSaves(page, settings => {
                settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', 'NeconyanTutorialHidden.v1': 'true' };
            });
            await page.goto('/');
            await page.waitForFunction(() => Boolean(window.NeconyanShell && document.body.classList.contains('neconyan-rail-ready')), { timeout: 60_000 });
            await page.waitForFunction(() => {
                const status = document.querySelector('#ica--run-status');
                return status && !status.textContent.includes('Loading your agents...');
            }, { timeout: 30_000 });

            await page.evaluate(async ({ prefix, total, targetIndex }) => {
                const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                const ctx = window.SillyTavern.getContext();
                const results = {};
                const block = (label, lines) => Array.from({ length: lines }, (_, line) => `<p>${label} line ${line + 1}: steady layout check across animated reopen.</p>`).join('');
                for (let i = 0; i < total; i++) {
                    const id = `${prefix}${String(i).padStart(2, '0')}`;
                    await store.saveAgent({
                        id,
                        name: i === targetIndex ? 'Chatroom' : `Companion ${String(i + 1).padStart(2, '0')}`,
                        enabled: true,
                        execution: 'companion',
                        category: 'companion',
                        // Past every bundled card, so the card right above Chatroom is one whose note changes.
                        injection: { order: 1000 + i * 10 },
                        companion: { displayMode: 'panel', format: 'html' },
                    });
                    const lines = i < targetIndex ? 22 : (i === targetIndex ? 14 : 6);
                    results[id] = { status: 'done', content: block(`Turn 1 #${i}`, lines), timestamp: Date.now() };
                }
                ctx.chat.push({
                    name: 'Assistant',
                    is_user: false,
                    is_system: false,
                    mes: 'Turn 1 reply.',
                    extra: { inChatAgentCompanionResults: results },
                });
                const panel = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
                panel.openCompanionPanel();
            }, { prefix, total, targetIndex });

            const panel = page.locator('#ica--tracker-panel');
            await expect(panel).toHaveClass(/is-open/);
            await expect.poll(() => page.evaluate(() => document.querySelectorAll('#ica--tracker-panel .ica--tpanel-agent.is-hydrated').length), { timeout: 15_000 })
                .toBeGreaterThanOrEqual(total);

            const measureTarget = () => page.evaluate(id => {
                const scroller = document.querySelector('#ica--tracker-panel');
                const card = scroller?.querySelector(`.ica--tpanel-agent[data-agent-id="${id}"]`);
                if (!scroller || !card) return null;
                const p = scroller.getBoundingClientRect();
                const c = card.getBoundingClientRect();
                return {
                    top: Math.round(c.top - p.top),
                    bottom: Math.round(c.bottom - p.top),
                    height: Math.round(c.height),
                    panelHeight: Math.round(p.height),
                };
            }, targetId);

            // Case 1: Cards above shrink sharply while closed, then reopen with slide-in animation.
            await page.evaluate(id => {
                const scroller = document.querySelector('#ica--tracker-panel');
                const card = scroller.querySelector(`.ica--tpanel-agent[data-agent-id="${id}"]`);
                scroller.scrollTop = Math.max(0, card.offsetTop - 30);
            }, targetId);
            await page.waitForTimeout(200);
            const case1Before = await measureTarget();

            await page.evaluate(async () => {
                const panel = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
                panel.closeCompanionPanel();
            });
            await expect(panel).not.toHaveClass(/is-open/, { timeout: 5_000 });

            await page.evaluate(async ({ prefix, total, targetIndex }) => {
                const ctx = window.SillyTavern.getContext();
                const results = {};
                const block = (label, lines) => Array.from({ length: lines }, (_, line) => `<p>${label} line ${line + 1}: updated companion note after reply.</p>`).join('');
                for (let i = 0; i < total; i++) {
                    const id = `${prefix}${String(i).padStart(2, '0')}`;
                    const lines = i < targetIndex ? 2 : (i === targetIndex ? 30 : 20);
                    results[id] = { status: 'done', content: block(`Turn 2 #${i}`, lines), timestamp: Date.now() };
                }
                ctx.chat.push({
                    name: 'Assistant',
                    is_user: false,
                    is_system: false,
                    mes: 'Turn 2 reply.',
                    extra: { inChatAgentCompanionResults: results },
                });
                const panel = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
                panel.openCompanionPanel();
            }, { prefix, total, targetIndex });

            await expect(panel).toHaveClass(/is-open/);
            await page.waitForTimeout(160);
            const case1MidAnim = await measureTarget();
            await page.waitForTimeout(1400);
            const case1Settled = await measureTarget();

            expect(Math.abs(case1MidAnim.top - case1Before.top)).toBeLessThanOrEqual(4);
            expect(Math.abs(case1Settled.top - case1Before.top)).toBeLessThanOrEqual(4);

            // Case 2: Scrolled partway down a tall Chatroom with the next card peeking,
            // Chatroom grows on Turn 3 -> stays anchored to Chatroom instead of jumping down.
            await expect.poll(() => page.evaluate(() => document.querySelectorAll('#ica--tracker-panel .ica--tpanel-agent.is-hydrated').length), { timeout: 15_000 })
                .toBeGreaterThanOrEqual(total);
            await page.evaluate(id => {
                const scroller = document.querySelector('#ica--tracker-panel');
                const card = scroller.querySelector(`.ica--tpanel-agent[data-agent-id="${id}"]`);
                const p = scroller.getBoundingClientRect();
                scroller.scrollTop = Math.max(0, card.offsetTop + card.offsetHeight - p.height + 110);
            }, targetId);
            await page.waitForTimeout(200);
            const case2Before = await measureTarget();
            expect(case2Before.top).toBeLessThan(-100);
            expect(case2Before.bottom).toBeLessThan(case2Before.panelHeight);

            await page.evaluate(async () => {
                const panel = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
                panel.closeCompanionPanel();
            });
            await expect(panel).not.toHaveClass(/is-open/, { timeout: 5_000 });

            await page.evaluate(async ({ prefix, total, targetIndex }) => {
                const ctx = window.SillyTavern.getContext();
                const results = {};
                const block = (label, lines) => Array.from({ length: lines }, (_, line) => `<p>${label} line ${line + 1}: taller chatroom turn.</p>`).join('');
                for (let i = 0; i < total; i++) {
                    const id = `${prefix}${String(i).padStart(2, '0')}`;
                    const lines = i === targetIndex ? 52 : 8;
                    results[id] = { status: 'done', content: block(`Turn 3 #${i}`, lines), timestamp: Date.now() };
                }
                ctx.chat.push({
                    name: 'Assistant',
                    is_user: false,
                    is_system: false,
                    mes: 'Turn 3 reply.',
                    extra: { inChatAgentCompanionResults: results },
                });
                const panel = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
                panel.openCompanionPanel();
            }, { prefix, total, targetIndex });

            await expect(panel).toHaveClass(/is-open/);
            await page.waitForTimeout(1400);
            const case2Settled = await measureTarget();
            expect(Math.abs(case2Settled.top - case2Before.top)).toBeLessThanOrEqual(4);

            // Case 3: Scrolled deep inside a tall Chatroom that then shrinks sharply on Turn 4
            // -> Chatroom stays on screen instead of disappearing above the top edge.
            await expect.poll(() => page.evaluate(() => document.querySelectorAll('#ica--tracker-panel .ica--tpanel-agent.is-hydrated').length), { timeout: 15_000 })
                .toBeGreaterThanOrEqual(total);
            await page.evaluate(id => {
                const scroller = document.querySelector('#ica--tracker-panel');
                const card = scroller.querySelector(`.ica--tpanel-agent[data-agent-id="${id}"]`);
                scroller.scrollTop = card.offsetTop + Math.round(card.offsetHeight * 0.45);
            }, targetId);
            await page.waitForTimeout(200);
            const case3Before = await measureTarget();
            expect(case3Before.top).toBeLessThan(-400);

            await page.evaluate(async () => {
                const panel = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
                panel.closeCompanionPanel();
            });
            await expect(panel).not.toHaveClass(/is-open/, { timeout: 5_000 });

            await page.evaluate(async ({ prefix, total, targetIndex }) => {
                const ctx = window.SillyTavern.getContext();
                const results = {};
                const block = (label, lines) => Array.from({ length: lines }, (_, line) => `<p>${label} line ${line + 1}: short chatroom turn.</p>`).join('');
                for (let i = 0; i < total; i++) {
                    const id = `${prefix}${String(i).padStart(2, '0')}`;
                    const lines = i === targetIndex ? 5 : 8;
                    results[id] = { status: 'done', content: block(`Turn 4 #${i}`, lines), timestamp: Date.now() };
                }
                ctx.chat.push({
                    name: 'Assistant',
                    is_user: false,
                    is_system: false,
                    mes: 'Turn 4 reply.',
                    extra: { inChatAgentCompanionResults: results },
                });
                const panel = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
                panel.openCompanionPanel();
            }, { prefix, total, targetIndex });

            await expect(panel).toHaveClass(/is-open/);
            await page.waitForTimeout(1400);
            const case3Settled = await measureTarget();
            expect(case3Settled.bottom).toBeGreaterThan(0);
            expect(case3Settled.top).toBeGreaterThanOrEqual(-case3Settled.height / 2);
            expect(case3Settled.top).toBeLessThan(case3Settled.panelHeight);
        } finally {
            await page.evaluate(async prefix => {
                const { getAgents, deleteAgent } = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                for (const agent of getAgents().filter(agent => agent.id.startsWith(prefix))) await deleteAgent(agent.id);
            }, prefix).catch(() => {});
            await context.close();
        }
    });
}

// The second case reads deep inside a long note, where the card's top is far above the panel.
const liveReopenCases = [
    { label: 'a middle card', targetLines: 0, offset: 30 },
    { label: 'the place inside a long middle card', targetLines: 80, offset: -1500 },
];
for (const { label, targetLines, offset } of liveReopenCases) for (const width of [393, 1280]) {
    test(`companion panel keeps ${label} in place while a new turn's notes finish after reopen at ${width}px`, async ({ browser }) => {
        const phone = width === 393;
        const context = await browser.newContext({
            viewport: { width, height: phone ? 852 : 900 },
            hasTouch: phone,
            reducedMotion: 'no-preference',
            serviceWorkers: 'block',
        });
        const page = await context.newPage();
        const prefix = `e2e-live-reopen-${width}-${targetLines}-${Date.now()}-`;
        const total = 24;
        const targetIndex = 12;
        const targetId = `${prefix}${String(targetIndex).padStart(2, '0')}`;

        try {
            await isolateSettingsSaves(page, settings => {
                settings.accountStorage = {
                    ...settings.accountStorage,
                    'NeconyanTutorialStatus.v1': 'skipped',
                    'NeconyanTutorialHidden.v1': 'true',
                };
            });
            await page.goto('/');
            await page.waitForFunction(() => Boolean(window.NeconyanShell && document.body.classList.contains('neconyan-rail-ready')), { timeout: 60_000 });
            await page.waitForFunction(() => {
                const status = document.querySelector('#ica--run-status');
                return status && !status.textContent.includes('Loading your agents...');
            }, { timeout: 30_000 });

            // Every note changes height from one turn to the next, so a height saved from the last turn is wrong for this one.
            await page.evaluate(async ({ prefix, total, targetIndex, targetLines }) => {
                const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                const ctx = window.SillyTavern.getContext();
                window.__liveReopenNote = (turn, index) => Array.from(
                    { length: index === targetIndex && targetLines ? targetLines : 4 + ((index * 7 + turn * 5) % 19) },
                    (_, line) => `<p>Turn ${turn} note ${index} line ${line + 1}: steady layout check.</p>`,
                ).join('');
                const results = {};
                for (let index = 0; index < total; index++) {
                    const id = `${prefix}${String(index).padStart(2, '0')}`;
                    const name = index === targetIndex ? 'Chatroom' : `Companion ${String(index + 1).padStart(2, '0')}`;
                    await store.saveAgent({
                        id,
                        name,
                        enabled: true,
                        execution: 'companion',
                        category: 'companion',
                        injection: { order: index * 10 },
                        companion: { displayMode: 'panel', format: 'html' },
                    });
                    results[id] = { status: 'done', agentName: name, content: window.__liveReopenNote(1, index), timestamp: Date.now() };
                }
                ctx.chat.push({ name: 'Assistant', is_user: false, is_system: false, mes: 'Turn 1 reply.', extra: { inChatAgentCompanionResults: results } });
                const panel = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
                panel.openCompanionPanel();
            }, { prefix, total, targetIndex, targetLines });

            const panel = page.locator('#ica--tracker-panel');
            await expect(panel).toHaveClass(/is-open/);
            await expect.poll(() => page.evaluate(() => document.querySelectorAll('#ica--tracker-panel .ica--tpanel-agent.is-hydrated').length), { timeout: 15_000 }).toBeGreaterThanOrEqual(total);

            const targetTop = () => page.evaluate(id => {
                const scroller = document.querySelector('#ica--tracker-panel');
                const card = scroller?.querySelector(`.ica--tpanel-agent[data-agent-id="${id}"]`);
                if (!scroller || !card) return null;
                return Math.round(card.getBoundingClientRect().top - scroller.getBoundingClientRect().top);
            }, targetId);
            const emitResultsUpdated = () => page.evaluate(async () => {
                const { COMPANION_RESULTS_UPDATED_EVENT } = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
                const ctx = window.SillyTavern.getContext();
                await ctx.eventSource.emit(COMPANION_RESULTS_UPDATED_EVENT, { messageIndex: ctx.chat.length - 1 });
            });

            await page.evaluate(({ id, offset }) => {
                const scroller = document.querySelector('#ica--tracker-panel');
                const card = scroller.querySelector(`.ica--tpanel-agent[data-agent-id="${id}"]`);
                scroller.scrollTop = Math.max(0, card.offsetTop - offset);
            }, { id: targetId, offset });
            await page.waitForTimeout(300);
            const before = await targetTop();
            expect(before).toBe(offset);

            await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).closeCompanionPanel());
            await expect(panel).not.toHaveClass(/is-open/, { timeout: 5_000 });

            // A new turn starts while the panel is closed: every note is waiting.
            await page.evaluate(({ prefix, total }) => {
                const ctx = window.SillyTavern.getContext();
                const previous = ctx.chat[ctx.chat.length - 1].extra.inChatAgentCompanionResults;
                const results = {};
                for (let index = 0; index < total; index++) {
                    const id = `${prefix}${String(index).padStart(2, '0')}`;
                    results[id] = { status: 'pending', agentName: previous[id].agentName, content: '', timestamp: Date.now() };
                }
                ctx.chat.push({ name: 'Assistant', is_user: false, is_system: false, mes: 'Turn 2 reply.', extra: { inChatAgentCompanionResults: results } });
            }, { prefix, total });
            await emitResultsUpdated();

            await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel());
            // No wait for the slide to end: the first notes land while the panel is still opening.
            await page.waitForTimeout(120);
            expect(Math.abs(await targetTop() - before), 'position right after reopening').toBeLessThanOrEqual(4);

            // The notes finish one at a time, above and below the reader, while the panel is open.
            for (let step = 0; step < total; step++) {
                const index = (step * 5) % total;
                await page.evaluate(({ prefix, index }) => {
                    const ctx = window.SillyTavern.getContext();
                    const results = ctx.chat[ctx.chat.length - 1].extra.inChatAgentCompanionResults;
                    const id = `${prefix}${String(index).padStart(2, '0')}`;
                    results[id] = { ...results[id], status: 'done', content: window.__liveReopenNote(2, index), timestamp: Date.now() };
                }, { prefix, index });
                await emitResultsUpdated();
                await page.waitForTimeout(90);
                expect(Math.abs(await targetTop() - before), `position after note ${index} finished`).toBeLessThanOrEqual(4);
            }

            await page.waitForTimeout(1500);
            expect(Math.abs(await targetTop() - before), 'position once everything settled').toBeLessThanOrEqual(4);
        } finally {
            await page.evaluate(async prefix => {
                const { getAgents, deleteAgent } = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                for (const agent of getAgents().filter(agent => agent.id.startsWith(prefix))) await deleteAgent(agent.id);
            }, prefix).catch(() => {});
            await context.close();
        }
    });
}
