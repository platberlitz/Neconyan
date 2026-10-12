/* global window, document, getComputedStyle, NodeFilter */
/* eslint-disable playwright/no-force-option -- Saved Appearance controls live in a closed drawer. */
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- Fixed viewport and control-family matrices. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

async function seed(page, avatar, count) {
    await page.evaluate(async ({ avatar, count }) => {
        const c = window.SillyTavern.getContext(); await c.getCharacters();
        await c.selectCharacterById(c.characters.findIndex(character => character.avatar === avatar));
        c.chat.splice(0, c.chat.length, ...[false, true, false].map((user, i) => {
            const mes = user ? 'He sat by the window.' : 'She returned with a pot of tea.';
            const date = '2026-10-11T00:00:00Z', swipes = count === 2 ? [mes, mes + '\n\nA second saved alternative.'] : [mes];
            return { name: user ? 'Brian' : 'Sara', is_user: user, is_system: false, send_date: date, mes: swipes.at(-1), swipes, swipe_id: count - 1,
                swipe_info: swipes.map(() => ({ send_date: date, extra: {} })), extra: {} };
        }));
        await c.saveChat(); await c.reloadCurrentChat(); await window.NeconyanShell.activateMode('roleplay');
    }, { avatar, count });
    await page.locator('#chat_display').selectOption('6', { force: true });
    await expect(page.locator('#chat > .mes.last_mes')).toHaveAttribute('mesid', '2');
}

async function controls(row) {
    return row.evaluate(el => {
        const box = node => node.getBoundingClientRect().toJSON();
        const visible = node => { const s = getComputedStyle(node), r = node.getBoundingClientRect(); return s.display !== 'none' && s.visibility === 'visible' && Number(s.opacity) > 0 && r.width && r.height; };
        const footer = el.querySelector('.nn-response-controls');
        const nameGap = el.querySelector('.name_text').getBoundingClientRect().top - el.getBoundingClientRect().top;
        return {
            footer: footer ? box(footer) : null, nameGap, cardBottom: el.getBoundingClientRect().bottom,
            items: [...el.querySelectorAll('.fa-chevron-left, .fa-chevron-right, .swipes-counter')].filter(visible).map(node => ({ ...box(node), counter: node.classList.contains('swipes-counter'), font: getComputedStyle(node).fontSize, opacity: getComputedStyle(node).opacity })),
            reading: { avatarWidth: box(el.querySelector('.mesAvatarWrapper')).width, portraitWidth: box(el.querySelector('.avatar img')).width,
                textWidth: box(el.querySelector('.mes_text')).width, textInset: box(el.querySelector('.mes_text')).left - box(el).left,
                marginTop: getComputedStyle(el).marginTop, marginBottom: getComputedStyle(el).marginBottom, columns: getComputedStyle(el).gridTemplateColumns },
            directLifts: [...el.querySelectorAll(':scope > .swipeRightBlock, :scope > .swipe_left, :scope > .deep-swipe-left-outer, :scope > .assistant-swipe-arrow')].map(node => getComputedStyle(node).translate),
            nestedRightLift: el.querySelector('.deep-swipe-right-block .deep-swipe-right') ? getComputedStyle(el.querySelector('.deep-swipe-right-block .deep-swipe-right')).translate : null,
        };
    });
}

test('Ripple equal detached controls preserve native reading columns and saved alternatives', async ({ app }, info) => {
    test.setTimeout(240000);
    for (const phone of [false, true]) {
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : { hasTouch: true } });
        if (phone) await installIPhoneSafari(account.context);
        const page = await account.open({ workspace: false });
        for (const width of phone ? [393, 768] : [769, 900, 1000, 1001, 1280]) {
            await page.setViewportSize({ width, height: phone ? 852 : 900 });
            for (const placement of width > 1000 ? ['inside', 'below'] : ['native']) {
                if (placement !== 'native') await page.locator('#desktop_response_controls').selectOption(placement, { force: true });
                for (const count of [1, 2]) {
                    await seed(page, account.avatar, count);
                    if (phone) await applyIOSOnlyCss(page);
                    const reading = new Map();
                    for (const all of [false, true]) {
                        await page.locator('#show_swipe_num_all_messages').evaluate((el, all) => { el.checked = all; el.dispatchEvent(new Event('input', { bubbles: true })); }, all);
                        const detached = [];
                        for (const id of ['0', '1', '2']) {
                            const row = page.locator('#chat > .mes[mesid="' + id + '"]');
                            await row.locator('.fa-chevron-right').filter({ visible: true }).scrollIntoViewIfNeeded();
                            const m = await controls(row), counter = m.items.find(item => item.counter), arrows = m.items.filter(item => !item.counter);
                            await info.attach([width, placement, count, all, id].join('-'), { body: JSON.stringify(m), contentType: 'application/json' });
                            const centre = item => item.y + item.height / 2;
                            expect(Math.max(...m.items.map(centre)) - Math.min(...m.items.map(centre))).toBeLessThan(0.6);
                            expect(counter.width).toBe(width > 1000 ? 44 : 38);
                            expect(arrows.every(arrow => arrow.font === '20px' && arrow.width === (width > 1000 ? 36 : 24) && arrow.height === (width > 1000 ? 36 : 24))).toBe(true);
                            expect(arrows.every(arrow => arrow.opacity === '1')).toBe(true);
                            expect(counter.height).toBe(width > 1000 ? 36 : 24);
                            expect(counter.opacity).toBe('1');
                            await expect(row.locator('.swipes-counter').filter({ visible: true })).toHaveText(count + '/' + count);
                            if (all) expect(m.reading).toEqual(reading.get(id));
                            else reading.set(id, m.reading);
                            if (placement === 'below') {
                                detached.push({ width: m.footer.width, height: m.footer.height });
                                expect(counter.x + counter.width / 2).toBeCloseTo(m.footer.x + m.footer.width / 2, 0);
                            }
                            if (width <= 1000) {
                                expect(m.directLifts.every(lift => lift === '0px')).toBe(true);
                                if (m.nestedRightLift !== null) expect(m.nestedRightLift).toBe('none');
                                for (const arrow of arrows) expect(m.cardBottom - arrow.bottom).toBeCloseTo(m.nameGap, 0);
                            }
                        }
                        if (placement === 'below') expect(detached).toEqual(Array(3).fill({ width: 138, height: 44 }));
                    }
                    if (count === 2) {
                        for (const id of ['0', '1', '2']) {
                            const row = page.locator('#chat > .mes[mesid="' + id + '"]');
                            for (const [direction, swipe] of [['left', 0], ['right', 1]]) {
                                await row.locator('.fa-chevron-' + direction).filter({ visible: true }).tap();
                                await page.waitForFunction(({ id, swipe }) => { const c = window.SillyTavern.getContext(); return c.chat[Number(id)].swipe_id === swipe && c.swipe.state() === 'none'; }, { id, swipe });
                            }
                            await expect(row.locator('.mes_text')).toContainText('A second saved alternative.');
                        }
                    }
                }
            }
        }
        await account.context.close();
    }
});

test('Ripple honours the existing-arrow single-alternative updater and restores available paint', async ({ app }, info) => {
    test.setTimeout(120000);
    const account = await app.account(), page = await account.open({ workspace: false });
    await seed(page, account.avatar, 2);
    const arrow = page.locator('#chat > .mes[mesid="0"] .deep-swipe-left-outer');
    for (const width of [1280, 900, 393]) {
        await page.setViewportSize({ width, height: 900 });
        await arrow.scrollIntoViewIfNeeded();
        for (const count of [1, 2]) {
            const state = await page.evaluate(async count => {
                const c = window.SillyTavern.getContext(), message = c.chat[0];
                const first = message.swipes[0];
                message.swipes = count === 1 ? [first] : [first, first + '\n\nA second saved alternative.'];
                message.swipe_id = count - 1;
                const arrow = document.querySelector('#chat > .mes[mesid="0"] .deep-swipe-left-outer');
                await (await import('/scripts/extensions/third-party/Neconyan-Deep-Swipe/ui.js')).updateMessageSwipeUI(0);
                return { sameArrow: arrow === document.querySelector('#chat > .mes[mesid="0"] .deep-swipe-left-outer'),
                    opacity: getComputedStyle(arrow).opacity, pointer: getComputedStyle(arrow).pointerEvents,
                    inline: arrow.getAttribute('style') };
            }, count);
            await info.attach('updater-' + width + '-' + count, { body: JSON.stringify(state), contentType: 'application/json' });
            expect(state.sameArrow).toBe(true);
            await expect(arrow).toHaveCSS('opacity', count === 1 ? '0.3' : '1');
            await expect(arrow).toHaveCSS('pointer-events', count === 1 ? 'none' : 'auto');
            await expect(arrow).toBeVisible();
        }
    }
    await account.context.close();
});

async function seedRich(page, avatar) {
    await page.evaluate(async avatar => {
        const c = window.SillyTavern.getContext(); await c.getCharacters();
        await c.selectCharacterById(c.characters.findIndex(character => character.avatar === avatar));
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        const snapshots = await import('/scripts/extensions/in-chat-agents/regex-snapshot-store.js');
        const template = await (await fetch('/scripts/extensions/in-chat-agents/templates/npc-profiles.json')).json();
        const bundles = await (await fetch('/scripts/extensions/in-chat-agents/templates/regex-bundles.json')).json();
        await store.saveAgent({ ...template, id: 'ripple-npc-profile', enabled: true, regexScripts: bundles[template.id] });
        const agent = store.getAgentById('ripple-npc-profile'), scripts = store.getAgentRegexScripts(agent);
        const inChatAgents = { activeAgentIds: [agent.id], regexScriptRefs: snapshots.buildRegexScriptRefsForAgent(agent.id, scripts), nativeRegexScripts: scripts.map(script => ({ agentId: agent.id, script })) };
        const { COMPANION_RESULTS_EXTRA_KEY } = await import('/scripts/extensions/in-chat-agents/companion/companion-shared.js');
        const npc = '[NPC:MAJOR|Sara]\nb: Sara | Adult | She/her | Bartender\na: Tall | Dark hair | Brown eyes | Green shirt\np: Wry | Direct | Patient\nh: She knows the neighbourhood\nr: She has just met Brian\n[/NPC]';
        const data = [[false, npc + '\n\nSara placed two glasses on the table.', 2], [true, 'Brian took off his coat.', 2], [false, 'There is no hurry.', 1], [true, 'He sat by the window.', 1], [false, 'She returned with a pot of tea.', 2]];
        c.chat.splice(0, c.chat.length, ...data.map(([user, mes, count], i) => {
            const extra = i === 0 ? { reasoning: 'Saved native reasoning.', reasoning_duration: 1000, inChatAgents,
                [COMPANION_RESULTS_EXTRA_KEY]: { note: { agentName: 'NPC Profile', status: 'done', content: 'Saved full-width Notes.', collapsed: false } } } : {};
            const date = `2026-10-11T00:00:0${i}Z`, swipes = count === 2 ? [mes, mes + '\n\nA second saved alternative.'] : [mes];
            return { name: user ? 'Brian' : 'Sara', is_user: user, is_system: false, send_date: date, mes: swipes.at(-1), swipes, swipe_id: count - 1,
                swipe_info: swipes.map(() => ({ send_date: date, extra: structuredClone(extra) })), extra };
        }));
        await c.saveChat(); await c.reloadCurrentChat(); await window.NeconyanShell.activateMode('roleplay');
        if (!agent.enabled || !store.getGlobalSettings().enabled) throw new Error('NPC Profile is not enabled');
    }, avatar);
    await page.locator('#chat_display').selectOption('6', { force: true });
    await expect(page.locator('#chat > .mes.last_mes')).toHaveAttribute('mesid', '4');
    await expect(page.locator('#chat > .mes[mesid="0"] .mes_text details summary')).toContainText('Sara');
}


test('Ripple edge placement preserves the previous inside flow and cleans every lifecycle exit', async ({ app }, info) => {
    test.setTimeout(180000);
    const account = await app.account(), page = await account.open({ workspace: false });
    await page.setViewportSize({ width: 1280, height: 900 });
    await seedRich(page, account.avatar);
    for (const content of ['short', 'long']) {
        if (content === 'long') await page.evaluate(async () => {
            const c = window.SillyTavern.getContext(), m = c.chat[2];
            m.mes = 'A long saved response.\n\n'.repeat(30); m.swipes = [m.mes]; m.swipe_id = 0;
            await c.saveChat(); await c.reloadCurrentChat();
        });
        for (const expanded of [false, true]) {
            await page.locator('#chat > .mes[mesid="0"] .mes_text details').evaluate((el, expanded) => { el.open = expanded; }, expanded);
            for (const all of [false, true]) {
                await page.locator('#show_swipe_num_all_messages').evaluate((el, all) => { el.checked = all; el.dispatchEvent(new Event('input', { bubbles: true })); }, all);
                await expect(page.locator('#chat > .mes[mesid="0"]')).toHaveClass(/nn-ripple-response-controls-inside/);
                for (const id of ['0', '1', '2', '3', '4']) {
                    const row = page.locator('#chat > .mes[mesid="' + id + '"]');
                    const result = await row.evaluate(el => {
                        const footer = el.querySelector(':scope > .nn-response-controls'), block = el.querySelector(':scope > .mes_block'), spacer = block.querySelector('.nn-response-controls-spacer');
                        const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left - el.getBoundingClientRect().left, top: r.top - el.getBoundingClientRect().top, width: r.width, height: r.height }; };
                        const geometry = () => ({ cardHeight: el.getBoundingClientRect().height, block: rect(block), header: rect(block.querySelector('.ch_name')),
                            text: rect(block.querySelector('.mes_text')), portrait: rect(el.querySelector('.avatar img')), avatar: rect(el.querySelector('.mesAvatarWrapper')),
                            notes: block.querySelector('.ica--companion-ledger') ? rect(block.querySelector('.ica--companion-ledger')) : null,
                            npc: block.querySelector('.mes_text details') ? rect(block.querySelector('.mes_text details')) : null });
                        const after = geometry(), footerBox = footer.getBoundingClientRect(), nameGap = block.querySelector('.name_text').getBoundingClientRect().top - el.getBoundingClientRect().top;
                        const controlGap = el.getBoundingClientRect().bottom - footerBox.bottom;
                        let contentBottom = -Infinity, paintedTextRects = 0;
                        for (const content of block.querySelectorAll('.mes_text, .ica--companion-ledger')) {
                            const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
                            for (let text; (text = walker.nextNode());) {
                                if (!text.textContent.trim()) continue;
                                let hidden = false;
                                for (let ancestor = text.parentElement; ancestor && ancestor !== content.parentElement; ancestor = ancestor.parentElement) {
                                    const paint = getComputedStyle(ancestor);
                                    if (paint.display === 'none' || paint.visibility === 'hidden' || paint.contentVisibility === 'hidden'
                                        || (ancestor.matches('details:not([open])') && !ancestor.querySelector(':scope > summary')?.contains(text))) { hidden = true; break; }
                                }
                                if (hidden) continue;
                                const range = document.createRange(); range.selectNodeContents(text);
                                for (const rect of range.getClientRects()) if (rect.width && rect.height) { contentBottom = Math.max(contentBottom, rect.bottom); paintedTextRects++; }
                            }
                        }
                        el.classList.remove('nn-ripple-response-controls-inside'); spacer.remove(); block.append(footer);
                        const before = geometry();
                        block.append(spacer); el.append(footer); el.classList.add('nn-ripple-response-controls-inside');
                        return { after, before, nameGap, controlGap, contentClearance: footerBox.top - contentBottom, footerTop: footerBox.top, contentBottom, paintedTextRects, spacerHeight: spacer.getBoundingClientRect().height, spacerMargin: getComputedStyle(spacer).marginTop };
                    });
                    await info.attach([content, expanded, all, id].join('-'), { body: JSON.stringify(result), contentType: 'application/json' });
                    expect(result.after).toEqual(result.before);
                    expect(result.controlGap).toBeCloseTo(result.nameGap, 0);
                    expect(result.paintedTextRects).toBeGreaterThan(0);
                    expect(result.contentClearance).toBeGreaterThanOrEqual(0);
                    expect(result.spacerHeight).toBe(36); expect(result.spacerMargin).toBe('8px');
                }
            }
        }
    }
    const first = page.locator('#chat > .mes[mesid="0"]');
    await first.evaluate(el => { window.rippleControlIdentity = el.querySelector('.deep-swipe-right'); });
    await page.locator('#desktop_response_controls').selectOption('below', { force: true });
    await expect(first.locator('.nn-response-controls-spacer')).toHaveCount(0);
    const clearance = await first.evaluate(el => el.querySelector(':scope > .nn-response-controls').getBoundingClientRect().top - el.getBoundingClientRect().bottom);
    expect(clearance).toBeCloseTo(5, 0);
    await page.locator('#desktop_response_controls').selectOption('inside', { force: true });
    await expect(first.locator('.nn-response-controls-spacer')).toHaveCount(1);
    const replacementBefore = await first.evaluate(el => ({ cardHeight: el.getBoundingClientRect().height,
        blockHeight: el.querySelector(':scope > .mes_block').getBoundingClientRect().height,
        portraitWidth: el.querySelector('.avatar img').getBoundingClientRect().width }));
    await first.evaluate(el => {
        const block = el.querySelector(':scope > .mes_block');
        const replacement = block.cloneNode(true);
        block.replaceWith(replacement);
    });
    // Let the manager process replacement before checking the cloned and owned spacer.
    await page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
    const replacementAfter = await first.evaluate(el => ({ cardHeight: el.getBoundingClientRect().height,
        blockHeight: el.querySelector(':scope > .mes_block').getBoundingClientRect().height,
        portraitWidth: el.querySelector('.avatar img').getBoundingClientRect().width }));
    await info.attach('ripple-block-replacement', { body: JSON.stringify({ before: replacementBefore, after: replacementAfter }), contentType: 'application/json' });
    await expect(first.locator(':scope > .mes_block > .nn-response-controls-spacer')).toHaveCount(1);
    await expect(first.locator(':scope > .nn-response-controls')).toHaveCount(1);
    expect(replacementAfter).toEqual(replacementBefore);
    expect(await first.evaluate(el => el.querySelector('.deep-swipe-right') === window.rippleControlIdentity)).toBe(true);
    for (const width of [1000, 393, 1001]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(first.locator('.nn-response-controls-spacer')).toHaveCount(width > 1000 ? 1 : 0);
        expect(await first.evaluate(el => el.querySelector('.deep-swipe-right') === window.rippleControlIdentity)).toBe(true);
    }
    await page.locator('#chat_display').selectOption('4', { force: true });
    await expect(first.locator('.nn-response-controls-spacer')).toHaveCount(0);
    await expect(first.locator('.mes_block > .nn-response-controls')).toHaveCount(1);
    await page.locator('#chat_display').selectOption('6', { force: true });
    await expect(first.locator('.nn-response-controls-spacer')).toHaveCount(1);
    await first.evaluate(el => { window.rippleLifecycleRow = el; });
    expect(await page.evaluate(() => window.NeconyanShell.activateMode('conversation'))).toBe(true);
    await expect(page.locator('body')).toHaveAttribute('data-neconyan-chat-mode', 'conversation');
    await expect(page.locator('#chat .nn-response-controls-spacer')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.rippleLifecycleRow.classList.contains('nn-ripple-response-controls-inside'))).toBe(false);
    expect(await page.evaluate(() => window.NeconyanShell.activateMode('roleplay'))).toBe(true);
    await expect(page.locator('body')).toHaveAttribute('data-neconyan-chat-mode', 'roleplay');
    await expect(first.locator('.nn-response-controls-spacer')).toHaveCount(1);
    await account.context.close();
});
