/* global window, document, getComputedStyle */
/* eslint-disable playwright/no-force-option -- Native Appearance controls are in a closed drawer. */
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- Fixed viewport matrices assert the expected geometry for each supported range. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';
import { PNG } from 'pngjs';

const captures = path.resolve('..', 'screenshots', 'whisper-style-investigation', 'content');
const phase = process.env.WHISPER_CAPTURE_PHASE || 'after';

async function seed(page, avatar) {
    await page.evaluate(async avatar => {
        const c = window.SillyTavern.getContext(); await c.getCharacters();
        await c.selectCharacterById(c.characters.findIndex(character => character.avatar === avatar));
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        const snapshots = await import('/scripts/extensions/in-chat-agents/regex-snapshot-store.js');
        const template = await (await fetch('/scripts/extensions/in-chat-agents/templates/npc-profiles.json')).json();
        const bundles = await (await fetch('/scripts/extensions/in-chat-agents/templates/regex-bundles.json')).json();
        await store.saveAgent({ ...template, id: 'whisper-npc-profile', enabled: true, regexScripts: bundles[template.id] });
        const agent = store.getAgentById('whisper-npc-profile'), scripts = store.getAgentRegexScripts(agent);
        const inChatAgents = { activeAgentIds: [agent.id], regexScriptRefs: snapshots.buildRegexScriptRefsForAgent(agent.id, scripts),
            nativeRegexScripts: scripts.map(script => ({ agentId: agent.id, script })) };
        const npc = '[NPC:MAJOR|Sara]\nb: Sara | Adult | She/her | Bartender\na: Tall | Dark hair | Brown eyes | Green shirt\np: Wry | Direct | Patient\nh: She knows the neighbourhood\nr: She has just met Brian\n[/NPC]';
        const prose = 'WHISPER FIRST\n\n' + npc + '\n\n' + 'Sara stopped beside the table. The message should use the available card width.\n\n'.repeat(24) + 'WHISPER FINAL';
        c.chat.splice(0, c.chat.length,
            { name: 'Sara', is_user: false, is_system: false, send_date: '2026-10-10T00:00:00Z', mes: prose,
                swipes: [prose, prose.replace('WHISPER FIRST', 'WHISPER ALTERNATIVE')], swipe_id: 0,
                gen_started: '2026-10-10T00:00:00Z', gen_finished: '2026-10-10T00:01:58.200Z',
                extra: { reasoning: 'Saved native reasoning alongside a generated NPC profile.', reasoning_duration: 118200, inChatAgents } },
            { name: 'Brian', is_user: true, is_system: false, send_date: '2026-10-10T00:00:01Z', mes: 'A short user reply.\n\nIts body uses the same left edge.', extra: {} },
            { name: 'Sara', is_user: false, is_system: false, send_date: '2026-10-10T00:00:02Z', mes: 'A final short reply.', extra: {} });
        await c.saveChat(); await c.reloadCurrentChat(); await window.NeconyanShell.activateMode('roleplay');
        if (!agent.enabled || !store.getGlobalSettings().enabled) throw new Error('NPC Profile agent is not enabled');
    }, avatar);
    await page.locator('#chat_display').selectOption('4', { force: true });
    await expect(page.locator('#chat > .mes[mesid="0"] .mes_text details summary')).toContainText('Sara');
}

async function geometry(row) {
    return row.evaluate(el => {
        const box = node => node.getBoundingClientRect().toJSON(), rs = getComputedStyle(el);
        const block = el.querySelector(':scope > .mes_block'), avatar = el.querySelector('.mesAvatarWrapper');
        const header = block.querySelector('.ch_name'), text = block.querySelector('.mes_text'), cat = el.querySelector(':scope > .neconyan-message-sleeper');
        return { row: box(el), block: box(block), avatar: box(avatar), header: box(header), text: box(text), cat: box(cat),
            headerStyle: { display: getComputedStyle(header).display, direction: getComputedStyle(header).flexDirection, gridColumn: getComputedStyle(header).gridColumn },
            textAlign: getComputedStyle(text).textAlign, inset: parseFloat(rs.paddingLeft) + parseFloat(rs.borderLeftWidth),
            catRight: getComputedStyle(cat).right, chatWidth: el.parentElement.clientWidth, chatScrollWidth: el.parentElement.scrollWidth };
    });
}

async function captureRegex(page, width, placement, open) {
    if (width === 1280 && placement === 'inside') await page.screenshot({ path: path.join(captures, `${phase}-regex-${width}-${open ? 'open' : 'closed'}.png`) });
}

test('Whisper phone body spans the card below native header and badges with real agent regex', async ({ app }, info) => {
    test.setTimeout(180000);
    const account = await app.account({ phone: true, contextOptions: IPHONE_SAFARI_CONTEXT });
    await installIPhoneSafari(account.context); const page = await account.open({ workspace: false });
    await seed(page, account.avatar); await applyIOSOnlyCss(page); await fs.mkdir(captures, { recursive: true });
    const row = page.locator('#chat > .mes[mesid="0"]'), details = row.locator('.mes_text details');
    await page.locator('#chat').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: path.join(captures, `${phase}-phone-393.png`) });
    const before = await geometry(row); await info.attach('phone geometry', { body: JSON.stringify(before), contentType: 'application/json' });
    expect(Math.abs(before.text.left - before.row.left - before.inset)).toBeLessThan(1);
    expect(before.text.right).toBeCloseTo(before.row.right - before.inset, 0);
    expect(before.textAlign).toBe('left');
    expect(before.text.top).toBeGreaterThanOrEqual(Math.max(before.avatar.bottom, before.header.bottom));
    const headerFits = await row.locator('.ch_name').evaluate(el => {
        const right = el.closest('.mes').getBoundingClientRect().right;
        return [...el.querySelectorAll('.mes_buttons > .neconyan-message-action')].filter(node => node.getBoundingClientRect().width > 0)
            .every(node => node.getBoundingClientRect().right <= right);
    });
    expect(headerFits).toBe(true);
    for (const open of [true, false]) {
        await details.evaluate((el, open) => { el.open = open; }, open);
        await expect(details).toHaveJSProperty('open', open);
        const g = await geometry(row); expect(g.chatScrollWidth).toBe(g.chatWidth);
        expect(await details.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    await row.locator('.mes_edit').dispatchEvent('click');
    await expect(row.locator('.edit_textarea')).toBeVisible();
    const editor = await row.locator('.edit_textarea').boundingBox();
    expect(editor.x).toBeCloseTo(before.text.left, 0); expect(editor.width).toBeCloseTo(before.text.width, 0);
    await row.locator('.mes_edit_cancel').dispatchEvent('click'); await expect(row.locator('.edit_textarea')).toHaveCount(0);
    await page.evaluate(async () => {
        const c = window.SillyTavern.getContext();
        const { COMPANION_RESULTS_EXTRA_KEY } = await import('/scripts/extensions/in-chat-agents/companion/companion-shared.js');
        const { renderCompanionResultsForMessage } = await import('/scripts/extensions/in-chat-agents/companion/companion-ui.js');
        c.chat[0].extra[COMPANION_RESULTS_EXTRA_KEY] = { note: { agentName: 'Layout Notes', status: 'done', content: 'FULL WIDTH NOTES', collapsed: false } };
        renderCompanionResultsForMessage(0);
    });
    const notes = row.locator('.ica--companion-ledger'); await expect(notes).toContainText('FULL WIDTH NOTES');
    expect((await notes.boundingBox()).x).toBeCloseTo((await geometry(row)).text.left, 0);
    expect((await notes.boundingBox()).y).toBeGreaterThanOrEqual((await geometry(row)).text.bottom);
    await page.locator('#chat').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: path.join(captures, `${phase}-phone-393.png`) });
    for (const width of [320, 768]) {
        await page.setViewportSize({ width, height: 852 });
        await expect.poll(async () => { const g = await geometry(row); return Math.abs(g.text.left - g.row.left - g.inset); }).toBeLessThan(1);
    }
});

test('Whisper user cat moves inward and agent panels preserve desktop and tablet lower edges', async ({ app }, info) => {
    test.setTimeout(180000);
    const account = await app.account(), page = await account.open({ workspace: false }); await seed(page, account.avatar);
    await fs.mkdir(captures, { recursive: true });
    const row = page.locator('#chat > .mes[mesid="0"]'), user = page.locator('#chat > .mes[mesid="1"]');
    for (const width of [1280, 900, 393]) {
        await page.setViewportSize({ width, height: width === 393 ? 852 : 900 });
        await user.evaluate(el => { el.parentElement.scrollTop += el.getBoundingClientRect().top - el.parentElement.getBoundingClientRect().top - 65; });
        await page.screenshot({ path: path.join(captures, `${phase}-user-${width}.png`) });
        const g = await geometry(user); await info.attach(`user-${width}`, { body: JSON.stringify(g), contentType: 'application/json' });
        expect(g.catRight).toBe('-13px');
    }
    for (const width of [1280, 1001, 1000, 900, 769]) {
        await page.setViewportSize({ width, height: 900 });
        for (const placement of ['inside', 'below']) {
            await page.locator('#desktop_response_controls').selectOption(placement, { force: true });
            for (const open of [false, true]) {
                await row.locator('.mes_text details').evaluate((el, open) => { el.open = open; }, open);
                await page.locator('#chat').evaluate(el => { el.scrollTop = 0; });
                const cap = page.locator('#neconyan-bubbles-bottom-boundary');
                const wider = await row.evaluate(el => el.getBoundingClientRect().width > document.querySelector('#sb-bottom-chat-bar').getBoundingClientRect().width + 1);
                await expect.poll(() => cap.isVisible()).toBe(wider);
                const g = await geometry(row); expect(g.chatScrollWidth).toBe(g.chatWidth);
                if (width <= 1000) {
                    expect(g.text.left).toBeCloseTo(g.row.left + g.inset, 0);
                    expect(g.text.right).toBeCloseTo(g.row.right - g.inset, 0);
                    expect(g.text.top).toBeGreaterThanOrEqual(Math.max(g.header.bottom, g.avatar.bottom));
                    expect(g.textAlign).toBe('left');
                }
                const clearance = await row.evaluate(el => ({ padding: getComputedStyle(el).paddingBottom,
                    unused: el.getBoundingClientRect().bottom - el.querySelector('.mes_block').getBoundingClientRect().bottom - parseFloat(getComputedStyle(el).borderBottomWidth) }));
                expect(clearance.padding).toBe(width > 1000 ? '0px' : '40px');
                expect(Math.abs(clearance.unused - (width > 1000 ? 0 : 40))).toBeLessThan(1);
                await captureRegex(page, width, placement, open);
            }
        }
    }
});

function iconInkCentre(buffer) {
    const png = PNG.sync.read(buffer), background = [...png.data.slice(0, 3)];
    let top = png.height, bottom = -1;
    for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
            const offset = (y * png.width + x) * 4;
            const difference = background.reduce((sum, colour, channel) => sum + Math.abs(png.data[offset + channel] - colour), 0);
            if (difference > 90) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
        }
    }
    expect(bottom).toBeGreaterThanOrEqual(top);
    return (top + bottom + 1) / 2 - png.height / 2;
}

for (const phone of [true, false]) {
    test(`Whisper ${phone ? 'phone' : 'tablet and desktop'} swipe ink, counters and saved alternatives stay aligned`, async ({ app }, info) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : { hasTouch: true } });
        if (phone) await installIPhoneSafari(account.context);
        const page = await account.open({ workspace: false }); await seed(page, account.avatar);
        await page.evaluate(async () => {
            const c = window.SillyTavern.getContext(), first = c.chat[0].mes;
            c.chat[0].mes = first.slice(first.indexOf('[NPC:'), first.indexOf('[/NPC]') + 6) + '\n\nSara set down the glass. "Your turn," she said.';
            for (const message of c.chat) {
                const original = message.mes;
                message.swipes = [original, original + '\n\nSecond alternative.'];
                message.swipe_info = message.swipes.map(() => ({ send_date: message.send_date, extra: structuredClone(message.extra) }));
                message.swipe_id = 1; message.mes = message.swipes[1];
            }
            await c.saveChat(); await c.reloadCurrentChat();
        });
        if (phone) await applyIOSOnlyCss(page);
        await page.evaluate(() => document.fonts.ready);
        const ids = ['2', '1', '0'];
        await expect(page.locator('#chat > .mes[mesid="2"]')).toHaveClass(/\blast_mes\b/);
        for (const width of phone ? [393] : [769, 900, 1000, 1001, 1280]) {
            await page.setViewportSize({ width, height: phone ? 852 : 900 });
            for (const placement of width > 1000 ? ['inside', 'below'] : ['native']) {
                if (placement !== 'native') await page.locator('#desktop_response_controls').selectOption(placement, { force: true });
                const widths = [];
                for (const all of [false, true]) {
                    await page.locator('#show_swipe_num_all_messages').evaluate((el, value) => { el.checked = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, all);
                    for (const id of ids) {
                        const row = page.locator(`#chat > .mes[mesid="${id}"]`);
                        await expect(row.locator('.nn-response-controls')).toHaveCount(width > 1000 ? 1 : 0);
                        const left = row.locator('.fa-chevron-left').filter({ visible: true }), right = row.locator('.fa-chevron-right').filter({ visible: true });
                        await expect(left).toHaveCount(1); await expect(right).toHaveCount(1);
                        await right.scrollIntoViewIfNeeded();
                        await page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
                        const measures = await row.evaluate(el => {
                            const box = n => n.getBoundingClientRect().toJSON(), row = box(el), style = getComputedStyle(el);
                            const visible = n => { const s = getComputedStyle(n), r = n.getBoundingClientRect(); return s.display !== 'none' && s.visibility === 'visible' && Number(s.opacity) > 0 && r.width && r.height; };
                            const controls = [...el.querySelectorAll('.fa-chevron-left, .fa-chevron-right, .swipes-counter')].filter(visible).map(n => ({ classes: n.className, ...box(n) }));
                            const footer = el.querySelector('.nn-response-controls');
                            return { row, controls, footer: footer ? box(footer) : null, translate: footer ? getComputedStyle(footer).translate : null, padding: parseFloat(style.paddingBottom) };
                        });
                        const counter = measures.controls.find(c => c.classes.includes('swipes-counter'));
                        const arrows = measures.controls.filter(c => c.classes.includes('chevron'));
                        const centre = c => c.top + c.height / 2;
                        const centres = measures.controls.map(centre);
                        expect(Math.max(...centres) - Math.min(...centres)).toBeLessThan(0.6);
                        expect(counter.width).toBe(width > 1000 ? 44 : 38);
                        expect(measures.padding).toBe(width > 1000 ? 0 : 40);
                        if (width > 1000) {
                            expect(counter.left + counter.width / 2).toBeCloseTo((arrows[0].left + arrows[0].width / 2 + arrows[1].left + arrows[1].width / 2) / 2, 0);
                            expect(measures.translate).toBe('0px -4px');
                            if (placement === 'below') widths.push(measures.footer.width);
                        } else for (const arrow of arrows) expect(measures.row.bottom - arrow.bottom).toBeCloseTo(13, 0);
                        const leftInk = iconInkCentre(await left.screenshot({ scale: 'css' }));
                        const rightInk = iconInkCentre(await right.screenshot({ scale: 'css' }));
                        expect(Math.abs(leftInk - rightInk)).toBeLessThanOrEqual(0.5);
                        await info.attach(`${width}-${placement}-${all}-${id}`, { body: JSON.stringify({ ...measures, leftInk, rightInk }), contentType: 'application/json' });
                    }
                }
                if (width > 1000 && placement === 'below') expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(0.6);
                if ([393, 900, 1280].includes(width)) {
                    for (const id of ids) {
                        const row = page.locator(`#chat > .mes[mesid="${id}"]`);
                        for (const [direction, swipe] of [['left', 0], ['right', 1]]) {
                            await row.locator(`.fa-chevron-${direction}`).filter({ visible: true }).tap();
                            await page.waitForFunction(({ id, swipe }) => { const c = window.SillyTavern.getContext(); return c.chat[Number(id)]?.swipe_id === swipe && c.swipe.state() === 'none'; }, { id, swipe });
                        }
                        await expect(row.locator('.mes_text')).toContainText('Second alternative.');
                    }
                }
            }
        }
    });
}
