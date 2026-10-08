/* global window, document, getComputedStyle */
/* eslint-disable playwright/no-force-option -- Exercise Appearance controls without opening the drawer each time. */
/* eslint-disable playwright/no-standalone-expect -- Geometry helpers assert rendered layout. */
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

const bundle = JSON.parse(fs.readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/regex-bundles.json', import.meta.url), 'utf8'));
const panel = bundle['tpl-world-detail'][0].replaceString.replaceAll('$1', 'HOW IT WORKS').replaceAll('$2', 'Lower City pantry').replaceAll('$3', 'Supplies arrive at dawn. The keeper records every delivery.');
const prose = 'The pantry opened onto a quiet courtyard. A ledger lay beside the window.\n\nThe shelves were full.\n\n' + panel;

async function geometry(page) {
    return page.locator('#chat > .mes').evaluateAll(rows => rows.map(row => {
        const rect = element => element?.getBoundingClientRect().toJSON();
        const block = row.querySelector('.mes_block'), cat = row.querySelector(':scope > .neconyan-message-sleeper');
        const text = row.querySelector('.mes_text'), details = text.querySelector('details'), footer = row.querySelector('.nn-response-controls');
        const b = rect(block), c = rect(cat), t = rect(text), p = rect(details), s = getComputedStyle(block);
        const ds = details && getComputedStyle(details);
        return { user: row.getAttribute('is_user') === 'true', last: row.classList.contains('last_mes'), block: b, text: t, panel: p, cat: c, footer: rect(footer),
            mode: document.body.dataset.neconyanChatMode, body: document.body.className, messagePaddingTop: getComputedStyle(row).paddingTop, catTop: getComputedStyle(cat).top,
            pawError: c.top + 41 - b.top, overhang: row.getAttribute('is_user') === 'true' ? c.right - b.right : b.left - c.left,
            expectedInset: 16 * parseFloat(getComputedStyle(document.body).getPropertyValue('--messageMarginScale') || '1'),
            insets: [t.left - b.left - parseFloat(s.borderLeftWidth), b.right - t.right - parseFloat(s.borderRightWidth)],
            padding: [s.paddingTop, s.paddingBottom], panelStyle: ds && Object.fromEntries(['backgroundColor', 'color', 'fontFamily', 'fontSize', 'boxShadow', 'marginTop', 'marginBottom'].map(key => [key, ds[key]])) };
    }));
}
function aligned(rows, { footer = true } = {}) {
    for (const row of rows) {
        expect.soft(Math.abs(row.pawError), 'paws meet the rendered panel').toBeLessThanOrEqual(1);
        expect.soft(row.overhang, 'tail overhang').toBeCloseTo(17, 0);
        expect.soft(row.insets[0], 'symmetric content inset').toBeCloseTo(row.insets[1], 0);
        expect.soft(row.insets[0], 'content inset follows the margin scale').toBeCloseTo(row.expectedInset, 0);
        expect.soft(row.padding).toEqual(['8px', '8px']);
        if (row.panel) {
            expect.soft(row.panel.left).toBeCloseTo(row.text.left, 0);
            expect.soft(row.panel.right).toBeCloseTo(row.text.right, 0);
        }
        if (footer && row.footer) expect.soft(row.footer.right, 'detached footer right edge').toBeCloseTo(row.block.right, 0);
    }
}

test('Document content, cats and detached controls follow both roles and live row transitions', async ({ app }) => {
    test.setTimeout(240000);
    const account = await app.account();
    const page = await account.open({ workspace: false });
    await page.evaluate(async () => { await (await import('/scripts/extensions.js')).enableExtension('third-party/Neconyan-Terminal-UI', false); });
    await page.reload();
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(async ({ avatar, prose }) => {
        const c = window.SillyTavern.getContext();
        await c.getCharacters();
        await c.selectCharacterById(c.characters.findIndex(character => character.avatar === avatar));
        c.chat.splice(0, c.chat.length, ...[false, true, false, true].map(is_user => ({ name: is_user ? 'You' : 'Miso', is_user, is_system: false, send_date: Date.now(), mes: prose, swipes: [prose, 'Another response.'], swipe_id: 0, extra: {} })));
        await c.saveChat(); await c.reloadCurrentChat();
        window.NeconyanShell.applyTheme('calico');
        document.body.classList.add('swipeAllMessages');
    }, { avatar: account.avatar, prose });
    await page.locator('#chat_display').selectOption('2', { force: true });
    await expect(page.locator('body')).toHaveAttribute('data-neconyan-chat-mode', 'roleplay');
    await page.locator('#desktop_response_controls').selectOption('below', { force: true });
    for (const theme of ['Neconyan Calico', 'Neconyan Calico Dark']) {
        await page.locator('#themes').selectOption({ label: theme }, { force: true });
        for (const open of [false, true]) {
            await page.locator('#chat .mes_text details').evaluateAll((nodes, open) => nodes.forEach(node => { node.open = open; }), open);
            await expect.poll(async () => (await geometry(page)).length).toBe(4);
            aligned(await geometry(page));
        }
    }
    for (const width of [769, 1000, 1001, 1280, 1600]) {
        await page.setViewportSize({ width, height: 900 });
        await expect.poll(async () => page.locator('#chat .nn-response-controls').count()).toBe(width > 1000 ? 4 : 0);
        aligned(await geometry(page), { footer: width > 1000 });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#message_margin_size').evaluate(el => { el.value = '0.8'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
    // Native append/delete keeps the old DOM row, exercising its change of status.
    for (const is_user of [false, true]) {
        await page.evaluate(({ is_user, prose }) => { const c = window.SillyTavern.getContext(); const m = { name: is_user ? 'You' : 'Miso', is_user, is_system: false, mes: prose, send_date: Date.now(), extra: {} }; c.chat.push(m); c.addOneMessage(m, { scroll: false }); }, { is_user, prose });
        aligned(await geometry(page));
        await page.evaluate(async () => { const c = window.SillyTavern.getContext(); await c.deleteMessage(c.chat.length - 1, undefined, false); });
        aligned(await geometry(page));
    }
    // Exercise the extension's real settings handler; Terminal cats retain their outer-row anchor.
    await page.locator('#sbterm-enabled').evaluate(el => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await expect(page.locator('body')).toHaveClass(/sbterm/);
    const terminal = await page.locator('#chat > .mes').evaluateAll(rows => rows.map(row => {
        const m = row.getBoundingClientRect(), c = row.querySelector('.neconyan-message-sleeper').getBoundingClientRect();
        return { pawError: c.top + 41 - m.top, overhang: row.getAttribute('is_user') === 'true' ? c.right - m.right : m.left - c.left };
    }));
    for (const row of terminal) {
        expect(Math.abs(row.pawError)).toBeLessThanOrEqual(1);
        expect(row.overhang).toBeCloseTo(17, 0);
    }
    await page.locator('#sbterm-enabled').evaluate(el => { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await expect(page.locator('body')).not.toHaveClass(/sbterm/);
    await expect(page.locator('body')).toHaveAttribute('data-neconyan-chat-mode', 'roleplay');
    aligned(await geometry(page));
    // Hold the block size constant through native last/earlier transitions, for both roles.
    await page.addStyleTag({ content: '#chat .mes .mes_buttons { display:none!important } #chat .mes .mes_text { height:100px; overflow:hidden }' });
    for (const is_user of [false, true]) {
        await page.evaluate(({ is_user, prose }) => { const c = window.SillyTavern.getContext(); const m = { name: is_user ? 'You' : 'Miso', is_user, is_system: false, mes: prose, send_date: Date.now(), extra: {} }; c.chat.push(m); c.addOneMessage(m, { scroll: false }); }, { is_user, prose });
        const id = await page.locator('#chat > .last_mes').getAttribute('mesid');
        const target = page.locator(`#chat > .mes[mesid='${id}']`);
        await expect(target.locator('.neconyan-message-sleeper')).toHaveCount(1);
        const height = await target.locator('.mes_block').evaluate(el => el.getBoundingClientRect().height);
        await page.evaluate(() => { const c = window.SillyTavern.getContext(); const m = { name: 'Miso', is_user: false, is_system: false, mes: 'A following row.', send_date: Date.now(), extra: {} }; c.chat.push(m); c.addOneMessage(m, { scroll: false }); });
        await expect(target).not.toHaveClass(/last_mes/);
        for (const last of [false, true]) {
            if (last) {
                await page.evaluate(async () => { const c = window.SillyTavern.getContext(); await c.deleteMessage(c.chat.length - 1, undefined, false); });
                await expect(target).toHaveClass(/last_mes/);
            }
            expect(await target.locator('.mes_block').evaluate(el => el.getBoundingClientRect().height)).toBe(height);
            const measured = await geometry(page);
            const measurementPath = test.info().outputPath(`same-size-${is_user ? 'user' : 'assistant'}-${last ? 'last' : 'earlier'}.json`);
            fs.writeFileSync(measurementPath, JSON.stringify(measured, null, 2));
            await test.info().attach('same-size-geometry', { path: measurementPath, contentType: 'application/json' });
            aligned(measured);
        }
        await page.evaluate(async () => { const c = window.SillyTavern.getContext(); await c.deleteMessage(c.chat.length - 1, undefined, false); });
    }
});
