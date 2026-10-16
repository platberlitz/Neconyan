/* global window, document, getComputedStyle, DOMMatrixReadOnly */
/* eslint-disable playwright/no-force-option -- Saved Appearance controls live in a closed drawer. */
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- Fixed viewport matrices exercise native and managed layouts. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

async function seed(page, avatar) {
    await page.evaluate(async avatar => {
        const c = window.SillyTavern.getContext(); await c.getCharacters();
        await c.selectCharacterById(c.characters.findIndex(character => character.avatar === avatar));
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        const snapshots = await import('/scripts/extensions/in-chat-agents/regex-snapshot-store.js');
        const template = await (await fetch('/scripts/extensions/in-chat-agents/templates/npc-profiles.json')).json();
        const bundles = await (await fetch('/scripts/extensions/in-chat-agents/templates/regex-bundles.json')).json();
        await store.saveAgent({ ...template, id: 'hush-npc-profile', enabled: true, regexScripts: bundles[template.id] });
        const agent = store.getAgentById('hush-npc-profile'), scripts = store.getAgentRegexScripts(agent);
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
    await page.locator('#chat_display').selectOption('5', { force: true });
    await expect(page.locator('#chat > .mes.last_mes')).toHaveAttribute('mesid', '4');
    await expect(page.locator('#chat > .mes[mesid="0"] .mes_text details summary')).toContainText('Sara');
}

async function measure(row) {
    return row.evaluate(el => {
        const box = node => node.getBoundingClientRect().toJSON();
        const rgb = colour => { const c = document.createElement('canvas'), ctx = c.getContext('2d'); ctx.fillStyle = colour; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
        const visible = node => { const s = getComputedStyle(node), r = node.getBoundingClientRect(); return s.display !== 'none' && s.visibility === 'visible' && Number(s.opacity) > 0 && r.width && r.height; };
        const footer = el.querySelector('.nn-response-controls'), text = el.querySelector('.mes_text'), block = el.querySelector(':scope > .mes_block'), rs = getComputedStyle(el), bs = getComputedStyle(block);
        return { row: box(el), text: box(text), header: box(el.querySelector('.ch_name')), avatar: box(el.querySelector('.mesAvatarWrapper')), picture: box(el.querySelector('.mesAvatarWrapper > .avatar img')),
            notes: el.querySelector('.ica--companion-ledger') ? box(el.querySelector('.ica--companion-ledger')) : null,
            regex: el.querySelector('.mes_text details') ? box(el.querySelector('.mes_text details')) : null,
            ink: rgb(rs.getPropertyValue('--neco-ink')),
            controls: [...el.querySelectorAll('.fa-chevron-left, .fa-chevron-right, .swipes-counter')].filter(visible).map(n => ({ classes: n.className, colour: rgb(getComputedStyle(n).color), opacity: getComputedStyle(n).opacity, ...box(n) })),
            footer: footer ? box(footer) : null, translate: footer ? getComputedStyle(footer).translate : null,
            padding: parseFloat(rs.paddingBottom), margin: parseFloat(bs.marginBottom), displacement: new DOMMatrixReadOnly(bs.transform).m42,
            unused: el.getBoundingClientRect().bottom - block.getBoundingClientRect().bottom - parseFloat(rs.borderBottomWidth),
            inset: parseFloat(rs.paddingLeft) + parseFloat(rs.borderLeftWidth), textAlign: getComputedStyle(text).textAlign,
            chatWidth: el.parentElement.clientWidth, scrollWidth: el.parentElement.scrollWidth };
    });
}

test('Hush native, Deep Swipe and single-alternative tracks keep equal dimensions and saved taps', async ({ app }, info) => {
    test.setTimeout(240000);
    for (const phone of [false, true]) {
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : { hasTouch: true } });
        if (phone) await installIPhoneSafari(account.context);
        const page = await account.open({ workspace: false }); await seed(page, account.avatar);
        if (phone) await applyIOSOnlyCss(page);
        for (const width of phone ? [393] : [900, 1280]) {
            await page.setViewportSize({ width, height: phone ? 852 : 900 });
            for (const placement of width > 1000 ? ['inside', 'below'] : ['native']) {
                if (placement !== 'native') await page.locator('#desktop_response_controls').selectOption(placement, { force: true });
                for (const all of [false, true]) {
                    await page.locator('#show_swipe_num_all_messages').evaluate((el, all) => { el.checked = all; el.dispatchEvent(new Event('input', { bubbles: true })); }, all);
                    for (const id of ['0', '1', '2', '3', '4']) {
                        const row = page.locator(`#chat > .mes[mesid="${id}"]`), right = row.locator('.fa-chevron-right').filter({ visible: true });
                        await right.scrollIntoViewIfNeeded(); const m = await measure(row);
                        const counter = m.controls.find(c => c.classes.includes('swipes-counter')), arrows = m.controls.filter(c => c.classes.includes('chevron'));
                        const y = c => c.y + c.height / 2, x = c => c.x + c.width / 2;
                        expect(Math.max(...m.controls.map(y)) - Math.min(...m.controls.map(y))).toBeLessThan(0.6);
                        expect(arrows.every(a => a.width === (width > 1000 ? 36 : 24) && a.height === (width > 1000 ? 36 : 24))).toBe(true);
                        for (const arrow of arrows.filter(a => a.classes.includes('deep-swipe'))) { expect(arrow.colour).toEqual(m.ink); expect(arrow.opacity).toBe('1'); }
                        if (arrows.length === 2) expect(x(counter)).toBeCloseTo((x(arrows[0]) + x(arrows[1])) / 2, 0);
                        if (width > 1000) {
                            expect(m.translate).toBe('0px -4px'); expect(m.padding).toBe(m.notes ? 12 : 0); expect(Math.abs(m.unused - (m.notes ? 12 : 0))).toBeLessThan(1);
                            if (m.notes) {
                                expect(m.notes.left + m.notes.width / 2).toBeCloseTo(m.text.left + m.text.width / 2, 0);
                                expect(m.row.bottom - m.notes.bottom - 1).toBeCloseTo(placement === 'below' ? 12 : 56, 0);
                            }
                            if (placement === 'below') { expect(m.footer.width).toBe(138); expect(m.footer.height).toBe(44); expect(x(counter)).toBeCloseTo(m.footer.x + 69, 0); }
                        } else {
                            expect(m.padding).toBe(40); for (const a of arrows) expect(m.row.bottom - a.bottom).toBeCloseTo(13, 0);
                            expect(m.text.left).toBeCloseTo(m.picture.left + m.picture.width / 2, 0);
                            expect(m.row.right - m.text.right).toBeCloseTo(m.text.left - m.row.left, 0);
                        }
                        await info.attach(`${width}-${placement}-${all}-${id}`, { body: JSON.stringify(m), contentType: 'application/json' });
                    }
                }
                for (const id of ['0', '1', '4']) {
                    const row = page.locator(`#chat > .mes[mesid="${id}"]`);
                    for (const [direction, swipe] of [['left', 0], ['right', 1]]) {
                        await row.locator(`.fa-chevron-${direction}`).filter({ visible: true }).tap();
                        await page.waitForFunction(({ id, swipe }) => { const c = window.SillyTavern.getContext(); return c.chat[Number(id)].swipe_id === swipe && c.swipe.state() === 'none'; }, { id, swipe });
                    }
                    await expect(row.locator('.mes_text')).toContainText('A second saved alternative.');
                }
            }
            const row = page.locator('#chat > .mes[mesid="0"]');
            await row.locator('.mes_text details').evaluate(el => el.open = true);
            if (width <= 1000) {
                await row.locator('.mes_reasoning_details').evaluate(el => el.open = true);
                const m = await measure(row);
                expect(m.text.x).toBeCloseTo(m.picture.left + m.picture.width / 2, 0); expect(m.row.right - m.text.right).toBeCloseTo(m.text.left - m.row.left, 0);
                expect(m.text.top).toBeGreaterThanOrEqual(Math.max(m.header.bottom, m.avatar.bottom)); expect(m.textAlign).toBe('left');
                expect(m.notes.x).toBeCloseTo(m.text.x, 0); expect(m.notes.width).toBeCloseTo(m.text.width, 0);
                expect(m.regex.x).toBeCloseTo(m.text.x, 0); expect(m.regex.width).toBeCloseTo(m.text.width, 0);
                expect(m.scrollWidth).toBe(m.chatWidth);
                await row.locator('.mes_edit').dispatchEvent('click'); const editor = row.locator('.edit_textarea'); await expect(editor).toBeVisible();
                const content = await row.locator('.mes_text').evaluate(el => ({ left: el.getBoundingClientRect().left, width: el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft) - parseFloat(getComputedStyle(el).paddingRight) }));
                const e = await editor.boundingBox(); expect(e.x).toBeCloseTo(content.left, 0); expect(e.width).toBeCloseTo(content.width, 0);
                await row.locator('.mes_edit_cancel').dispatchEvent('click'); await expect(editor).toHaveCount(0);
            }
        }
        await account.context.close();
    }
});

test('Hush portrait-centred gutters survive narrow boundaries, custom and hidden portraits', async ({ app }, info) => {
    test.setTimeout(180000);
    const account = await app.account({ phone: true, contextOptions: IPHONE_SAFARI_CONTEXT });
    await installIPhoneSafari(account.context); const page = await account.open({ workspace: false }); await seed(page, account.avatar); await applyIOSOnlyCss(page);
    for (const width of [320, 393, 768, 769, 900, 1000, 1001]) {
        await page.setViewportSize({ width, height: 900 });
        for (const state of ['normal', 'rectangular', 'custom-column', 'custom-portrait', 'hidden']) {
            await page.locator('#avatar_style').selectOption(state === 'rectangular' ? '1' : '0', { force: true });
            await page.locator('#chat').evaluate((el, state) => {
                el.style.removeProperty('--custom-ChatAvatar'); el.style.removeProperty('--avatar-base-width');
                if (state === 'custom-column' || state === 'custom-portrait') el.style.setProperty('--custom-ChatAvatar', '72px');
                if (state === 'custom-portrait') el.style.setProperty('--avatar-base-width', '72px');
            }, state);
            await page.locator('#hideChatAvatarsEnabled').evaluate((el, hidden) => { el.checked = hidden; el.dispatchEvent(new Event('input', { bubbles: true })); }, state === 'hidden');
            await expect(page.locator('body')).toHaveClass(state === 'hidden' ? /hideChatAvatars/ : /^(?!.*hideChatAvatars)/);
            for (const id of ['0', '1', '4']) {
                const row = page.locator(`#chat > .mes[mesid="${id}"]`);
                const offset = m => m.text.left - (state === 'hidden' ? m.row.left + m.inset : m.picture.left + m.picture.width / 2);
                // A slow runner can measure the previous width's layout straight after a resize.
                if (width <= 1000) await expect.poll(async () => Math.abs(offset(await measure(row))) < 0.5, { message: `${width} ${state} ${id} settles` }).toBe(true);
                const m = await measure(row);
                expect(m.scrollWidth).toBe(m.chatWidth);
                if (width <= 1000) {
                    const anchor = state === 'hidden' ? m.row.left + m.inset : m.picture.left + m.picture.width / 2;
                    expect(m.text.left, `${width} ${state} ${id}`).toBeCloseTo(anchor, 0); expect(m.row.right - m.text.right).toBeCloseTo(m.text.left - m.row.left, 0);
                    if (m.regex) { expect(m.regex.left).toBeCloseTo(anchor, 0); expect(m.regex.width).toBeCloseTo(m.text.width, 0); }
                    expect(m.text.top).toBeGreaterThanOrEqual(Math.max(m.header.bottom, m.avatar.bottom));
                }
                await info.attach(`${width}-${state}-${id}`, { body: JSON.stringify(m), contentType: 'application/json' });
            }
        }
    }
});

test('Hush compensates avatar displacement and paints only suitable crossing cards', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account(), page = await account.open({ workspace: false }); await seed(page, account.avatar);
    const row = page.locator('#chat > .mes[mesid="4"]'), chat = page.locator('#chat'), cap = page.locator('#neconyan-bubbles-bottom-boundary');
    for (const placement of ['inside', 'below']) {
        await page.locator('#desktop_response_controls').selectOption(placement, { force: true });
        for (const size of [40, 72]) {
            await chat.evaluate((el, value) => el.style.setProperty('--custom-ChatAvatar', `${value}px`), size);
            for (const marked of [false, true]) {
                await row.evaluate((el, marked) => el.classList.toggle('lastInContext', marked), marked);
                await expect.poll(async () => Math.abs((await measure(row)).unused)).toBeLessThan(1);
                const m = await measure(row); expect(m.margin).toBeCloseTo(m.displacement, 1); expect(m.padding).toBe(0);
            }
        }
    }
    await row.evaluate(el => el.classList.remove('lastInContext')); await chat.evaluate(el => el.style.removeProperty('--custom-ChatAvatar'));
    await page.locator('#desktop_response_controls').selectOption('inside', { force: true });
    await page.evaluate(async () => { const c = window.SillyTavern.getContext(); c.chat[4].mes = 'HUSH START\n\n' + 'A real saved reading card continues through the cutoff.\n\n'.repeat(60) + 'HUSH END'; c.chat[4].swipes[1] = c.chat[4].mes; await c.saveChat(); await c.reloadCurrentChat(); });
    await row.evaluate(el => { const chat = el.parentElement; chat.scrollTop += el.getBoundingClientRect().top - chat.getBoundingClientRect().top - 40; });
    const wider = await row.evaluate(el => el.getBoundingClientRect().width > document.querySelector('#sb-bottom-chat-bar').getBoundingClientRect().width + 1);
    await expect.poll(() => cap.isVisible()).toBe(wider);
    const before = await chat.evaluate(el => ({ height: el.scrollHeight, top: el.scrollTop, row: document.querySelector('#chat > .mes[mesid="4"]').getBoundingClientRect().toJSON(), composer: document.querySelector('#send_form').getBoundingClientRect().toJSON() }));
    await chat.evaluate(el => el.style.clipPath = 'inset(0px)'); await expect(cap).toBeHidden();
    expect(await chat.evaluate(el => ({ height: el.scrollHeight, top: el.scrollTop, row: document.querySelector('#chat > .mes[mesid="4"]').getBoundingClientRect().toJSON(), composer: document.querySelector('#send_form').getBoundingClientRect().toJSON() }))).toEqual(before);
    await chat.evaluate(el => el.style.removeProperty('clip-path'));
    if (wider) {
        await expect(cap).toBeVisible();
        expect(await cap.evaluate(el => ({ bottom: el.getBoundingClientRect().bottom, bar: document.querySelector('#sb-bottom-chat-bar').getBoundingClientRect().top, pointer: getComputedStyle(el).pointerEvents }))).toMatchObject({ bottom: await page.locator('#sb-bottom-chat-bar').evaluate(el => el.getBoundingClientRect().top + 4), pointer: 'none' });
    }
    await chat.evaluate(el => { el.scrollTop = el.scrollHeight; }); await expect(cap).toBeHidden();
    for (const width of [1000, 900, 769, 768, 393]) {
        await page.setViewportSize({ width, height: 900 }); await expect(row.locator('.nn-response-controls')).toHaveCount(0);
        const m = await measure(row); expect(m.padding).toBe(40); expect(m.margin).toBe(0); expect(m.displacement).toBe(0);
        if (width <= 768) await expect(cap).toBeHidden();
    }
});
