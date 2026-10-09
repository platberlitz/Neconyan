/* global window, document, getComputedStyle */
/* eslint-disable playwright/no-force-option -- Native Appearance controls live in a closed drawer. */
import fs from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

test('Echo inside controls join reading paint and native editors retain the real lower edge', async ({ app }, info) => {
    test.setTimeout(180000);
    const account = await app.account(), page = await account.open({ workspace: false });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.route('**/echo-regression-portrait.png', async route => route.fulfill({ contentType: 'image/png', body: await fs.readFile(new URL('../default/content/assistants/miso-female/portrait.png', import.meta.url)) }));
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext(); await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar));
        const message = context.chat[0];
        message.mes = 'FIRST ECHO\n\n' + 'The native reading panel continues beneath its portrait.\n\n'.repeat(70);
        message.swipes = [message.mes, message.mes.replace('FIRST ECHO', 'SECOND ECHO')]; message.swipe_id = 0;
        message.force_avatar = '/echo-regression-portrait.png'; message.extra = { reasoning: 'Native saved reasoning.', reasoning_duration: 1000 };
        await context.saveChat(); await context.reloadCurrentChat();
    }, account.avatar);
    await page.locator('#chat_display').selectOption('3', { force: true });
    await page.locator('#desktop_response_controls').selectOption('inside', { force: true });
    const row = page.locator('#chat > .mes[mesid="0"]'), footer = row.locator('.nn-response-controls'), cap = page.locator('#neconyan-bubbles-bottom-boundary');
    const wheel = async delta => {
        const box = await page.locator('#chat').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, delta);
    };
    const atCutoff = async selector => {
        await wheel(1);
        await page.evaluate(() => new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
        await row.locator(selector).evaluate(element => {
            const chat = element.closest('.mes').parentElement, box = element.getBoundingClientRect();
            chat.scrollTop += box.top + box.height / 2 - chat.getBoundingClientRect().bottom + 1;
        });
    };
    const join = () => footer.evaluate(element => {
        const block = element.parentElement, notes = block.querySelector('.ica--companion-ledger'), text = block.querySelector('.mes_text');
        const previous = notes || text;
        return { gap: element.getBoundingClientRect().top - previous.getBoundingClientRect().bottom,
            finalChild: element === block.lastElementChild, inText: !!element.closest('.mes_text'),
            paint: getComputedStyle(element).backgroundColor, panelPaint: getComputedStyle(previous).backgroundColor,
            overlay: element.classList.contains('nn-echo-overlay-footer'),
            padding: parseFloat(getComputedStyle(previous).paddingBottom), height: element.getBoundingClientRect().height,
            bottom: previous.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom,
            previousRadius: getComputedStyle(previous).borderBottomRightRadius, radius: getComputedStyle(element).borderBottomRightRadius };
    });
    const assertInside = async () => {
        await expect(footer).toHaveClass(/nn-echo-reading-footer/);
        const result = await join();
        expect(result.finalChild).toBe(true); expect(result.inText).toBe(false);
        if (result.overlay) {
            expect(result.bottom).toBeGreaterThanOrEqual(0); expect(result.padding).toBeGreaterThan(result.height);
            expect(result.previousRadius).toBe('10px');
        } else {
            expect(Math.abs(result.gap)).toBeLessThan(1); expect(result.paint).toBe(result.panelPaint);
            expect(result.previousRadius).toBe('0px'); expect(result.radius).toBe('10px');
        }
        await info.attach('inside-footer-geometry', { body: JSON.stringify(result), contentType: 'application/json' });
    };
    await assertInside();
    await wheel(99999); await footer.locator('.swipe_right').click(); await expect(row.locator('.mes_text')).toContainText('SECOND ECHO');
    await footer.locator('.swipe_left').click(); await expect(row.locator('.mes_text')).toContainText('FIRST ECHO');
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        const { COMPANION_RESULTS_EXTRA_KEY } = await import('/scripts/extensions/in-chat-agents/companion/companion-shared.js');
        const { renderCompanionResultsForMessage } = await import('/scripts/extensions/in-chat-agents/companion/companion-ui.js');
        context.chat[0].extra[COMPANION_RESULTS_EXTRA_KEY] = { footer: { agentName: 'Native Notes', status: 'done', content: 'Notes continue the complete reading panel.\n\nFINAL FOLLOWUP NOTES', collapsed: false } };
        renderCompanionResultsForMessage(0);
    });
    await assertInside();
    await atCutoff('.nn-response-controls'); await expect(cap).toBeVisible();
    await page.locator('#desktop_response_controls').selectOption('below', { force: true });
    await expect(footer).not.toHaveClass(/nn-echo-reading-footer|nn-echo-footer-joined/);
    await expect.poll(() => footer.evaluate(el => el.parentElement.classList.contains('mes'))).toBe(true);
    await page.locator('#desktop_response_controls').selectOption('inside', { force: true });
    await assertInside();

    await row.locator('.mes_edit').dispatchEvent('click');
    const editor = row.locator('.edit_textarea'); await expect(editor).toBeVisible();
    await atCutoff('.edit_textarea'); await expect(cap).toBeVisible();
    const geometry = await editor.evaluate(element => {
        const chat = element.closest('.mes').parentElement, box = element.getBoundingClientRect();
        const lane = box.left + element.clientLeft + element.clientWidth + 2;
        return { chatScroll: chat.scrollTop, editorScroll: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
            editorBox: box.toJSON(), clientWidth: element.clientWidth, clientLeft: element.clientLeft,
            chatClip: getComputedStyle(chat).clipPath, capClip: getComputedStyle(document.querySelector('#neconyan-bubbles-bottom-boundary')).clipPath,
            laneTarget: document.elementFromPoint(lane, chat.getBoundingClientRect().bottom - 2) === element,
            capBottom: document.querySelector('#neconyan-bubbles-bottom-boundary').getBoundingClientRect().bottom,
            toolbarTop: document.querySelector('#sb-bottom-chat-bar').getBoundingClientRect().top };
    });
    await info.attach('native-editor-scrollbar-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
    expect(geometry.laneTarget).toBe(true); expect(geometry.capBottom).toBe(geometry.toolbarTop + 4);
    await editor.evaluate(element => { element.focus({ preventScroll: true }); element.setSelectionRange(12, 24); });
    await page.keyboard.press('ArrowRight');
    expect(await editor.evaluate(element => element.selectionStart)).toBe(24);
    await editor.press('Control+End');
    const beforeScroll = await editor.evaluate(element => ({ inner: element.scrollTop, outer: element.closest('.mes').parentElement.scrollTop }));
    const box = await editor.boundingBox(), chatBox = await page.locator('#chat').boundingBox();
    await page.mouse.move(box.x + box.width / 2, Math.min(box.y + box.height, chatBox.y + chatBox.height) - 40); await page.mouse.wheel(0, -120);
    await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBeLessThan(beforeScroll.inner);
    expect(await page.locator('#chat').evaluate(element => element.scrollTop)).toBe(beforeScroll.outer);
    await editor.fill('SAVED ECHO\n\n' + 'Native editor typing remains intact.\n\n'.repeat(90));
    await row.locator('.mes_edit_done').dispatchEvent('click'); await expect(editor).toHaveCount(0);
    await expect(row.locator('.mes_text')).toContainText('SAVED ECHO');
    await row.locator('.mes_edit').dispatchEvent('click'); await expect(editor).toBeVisible(); await editor.fill('UNSAVED ECHO');
    await row.locator('.mes_edit_cancel').dispatchEvent('click'); await expect(editor).toHaveCount(0);
    await expect(row.locator('.mes_text')).toContainText('SAVED ECHO');

    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        context.chat[0].extra.reasoning = 'A native reasoning editor occupies the header, outside the reading panel.\n\n'.repeat(60);
        context.chat[0].extra.files = [{ name: 'visible-fixture.txt', size: 200, url: '/not-downloaded.txt' }];
        context.chat[0].extra.media = [{ url: '/echo-regression-portrait.png', type: 'image', title: 'Native visible attachment', source: 'api' }];
        context.chat[0].extra.inline_image = true;
        context.chat[0].extra.bias = 'Native visible bias.';
        await context.saveChat(); await context.reloadCurrentChat();
    });
    await expect(row.locator('.mes_file_container')).toBeVisible();
    await expect(footer).not.toHaveClass(/nn-echo-footer-joined/);
    expect((await join()).finalChild).toBe(true);
    const containedFooter = async () => {
        await expect(footer).toHaveClass(/nn-echo-overlay-footer/);
        const geometry = await footer.evaluate(element => {
            const block = element.parentElement, panel = block.querySelector('.ica--companion-ledger') || block.querySelector('.mes_text');
            const box = panel.getBoundingClientRect(), control = element.getBoundingClientRect();
            return { top: control.top - box.top, bottom: box.bottom - control.bottom,
                left: control.left - box.left, right: box.right - control.right,
                padding: parseFloat(getComputedStyle(panel).paddingBottom), height: control.height,
                finalChild: element === block.lastElementChild };
        });
        expect(geometry.top).toBeGreaterThan(0); expect(geometry.bottom).toBeGreaterThanOrEqual(0);
        expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeGreaterThanOrEqual(0);
        expect(geometry.padding).toBeGreaterThan(geometry.height); expect(geometry.finalChild).toBe(true);
        await atCutoff('.nn-response-controls'); await expect(cap).toBeVisible();
    };
    await containedFooter();
    await footer.locator('.swipes-counter').click();
    await page.getByRole('button', { name: 'Keep swipe #1', exact: true }).click();
    await expect(page.locator('.swipe_picker')).toHaveCount(0);
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        const { COMPANION_RESULTS_EXTRA_KEY } = await import('/scripts/extensions/in-chat-agents/companion/companion-shared.js');
        delete context.chat[0].extra[COMPANION_RESULTS_EXTRA_KEY];
        for (const swipe of context.chat[0].swipe_info || []) delete swipe.extra?.[COMPANION_RESULTS_EXTRA_KEY];
        await context.saveChat(); await context.reloadCurrentChat();
    });
    await expect(row.locator('.ica--companion-ledger')).toHaveCount(0);
    await containedFooter();
    await atCutoff('.mes_file_wrapper'); await expect(cap).toBeHidden();
    await row.locator('.mes_reasoning_details').evaluate(element => element.open = true);
    await row.locator('.mes_reasoning_edit').dispatchEvent('click');
    await expect(row.locator('.reasoning_edit_textarea')).toBeVisible();
    await atCutoff('.reasoning_edit_textarea'); await expect(cap).toBeHidden();
    await row.locator('.mes_reasoning_edit_cancel').dispatchEvent('click');
    await expect(row.locator('.reasoning_edit_textarea')).toHaveCount(0);
    await page.setViewportSize({ width: 393, height: 852 });
    await expect(row).not.toHaveClass(/nn-echo-layout|nn-echo-footer-adjacent/);
    await expect(row.locator('.nn-echo-reading-footer, .nn-echo-joined-end, .nn-echo-overlay-footer, .nn-echo-reserves-footer')).toHaveCount(0);
    await expect(cap).toBeHidden();
});
