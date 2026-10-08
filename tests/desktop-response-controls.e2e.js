/* global window, document */
/* eslint-disable playwright/no-force-option -- Exercise the style matrix without repeatedly opening Appearance. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test('desktop response placement persists, preserves swipe actions, and restores narrow layouts', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account();
    const page = await account.open({ workspace: false });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar));
        context.chat[0].mes = 'First response.\n\n<details><summary>World details</summary><p>Expanded panel.</p></details>';
        context.chat[0].swipes = [context.chat[0].mes, 'Second response.'];
        context.chat[0].swipe_id = 0;
        await context.saveChat();
        await context.reloadCurrentChat();
    }, account.avatar);
    const message = page.locator('#chat .last_mes');
    const footer = message.locator('.nn-response-controls');
    const preference = page.locator('#desktop_response_controls');
    await expect(preference).toHaveValue('inside');
    await expect(message.locator('.mes_block > .nn-response-controls')).toHaveCount(1);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('#sb-avatar-chat-styles-drawer > .inline-drawer-toggle').click();
    await expect(preference).toBeVisible();
    await preference.selectOption('below');
    await preference.selectOption('inside');
    await page.locator('.sb-shell-root:visible .sb-shell-close').click();

    // The actual controls retain their click handlers and the existing response history.
    await footer.locator('.swipe_right').click();
    await expect(message.locator('.mes_text')).toContainText('Second response.');
    await footer.locator('.swipe_left').click();
    await expect(message.locator('.mes_text')).toContainText('First response.');
    await message.locator('.mes_text summary').click();

    for (const style of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']) {
        await page.locator('#chat_display').selectOption(style, { force: true });
        for (const position of ['inside', 'below']) {
            await preference.selectOption(position, { force: true });
            await expect.poll(() => footer.evaluate(element => element.parentElement.classList.contains('mes_block'))).toBe(position === 'inside');
            const geometry = await footer.evaluate(element => {
                const message = element.closest('.mes');
                const bubble = message.querySelector('.mes_block').getBoundingClientRect();
                const box = element.getBoundingClientRect();
                const text = message.querySelector('.mes_text').getBoundingClientRect();
                const controls = [...element.querySelectorAll('.swipe_left, .swipe_right, .swipes-counter')].map(control => control.getBoundingClientRect().toJSON());
                return { bubble: bubble.toJSON(), box: box.toJSON(), text: text.toJSON(), controls };
            });
            expect(geometry.box.top, `style ${style}, ${position}: content clearance`).toBeGreaterThanOrEqual(geometry.text.bottom - 1);
            expect(geometry.box.right).toBeLessThanOrEqual(1280);
            expect(geometry.controls.every(control => control.top >= geometry.box.top - 1 && control.bottom <= geometry.box.bottom + 1)).toBe(true);
            expect(position === 'inside' ? geometry.box.bottom <= geometry.bubble.bottom + 1 : geometry.box.top >= geometry.bubble.bottom).toBe(true);
        }
    }

    await page.evaluate(async () => {
        if (!await (await import('/script.js')).saveSettings(0, { returnResult: true })) throw new Error('Settings were not saved');
    });
    await page.reload();
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
    await expect(preference).toHaveValue('below');
    await expect(page.locator('body')).toHaveAttribute('data-desktop-response-controls', 'below');
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar));
    }, account.avatar);
    await expect(footer).toHaveCount(1);

    // Save references, then cross the breakpoint repeatedly: no clones, lost listeners or duplicate groups.
    await message.evaluate(element => { window.responseControl = element.querySelector('.swipe_right'); });
    for (const width of [1000, 393, 1001, 1280, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(footer).toHaveCount(width > 1000 ? 1 : 0);
        expect(await message.evaluate(element => element.querySelector('.swipe_right') === window.responseControl)).toBe(true);
    }
    await preference.selectOption('inside', { force: true });
    await expect(message.locator('.mes_block > .nn-response-controls')).toHaveCount(1);

    // Deep Swipe inserts its arrow immediately before the native block, even when that block is in the footer.
    await message.evaluate(element => {
        const arrow = document.createElement('div');
        arrow.className = 'deep-swipe-right assistant-swipe-arrow';
        element.querySelector('.swipeRightBlock').before(arrow);
        window.extensionResponseControl = arrow;
    });
    await expect(footer.locator('.assistant-swipe-arrow')).toHaveCount(1);
    await page.setViewportSize({ width: 393, height: 852 });
    await expect(footer).toHaveCount(0);
    expect(await message.evaluate(element => element.querySelector(':scope > .assistant-swipe-arrow') === window.extensionResponseControl)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(footer.locator('.assistant-swipe-arrow')).toHaveCount(1);

    // A content-block replacement must not discard native controls whose original positions still exist.
    await message.evaluate(element => {
        const block = element.querySelector('.mes_block');
        const replacement = block.cloneNode(true);
        replacement.querySelector('.nn-response-controls').remove();
        block.replaceWith(replacement);
    });
    await expect(footer.locator('.swipeRightBlock')).toHaveCount(1);
    expect(await message.evaluate(element => element.querySelector('.swipe_right') === window.responseControl)).toBe(true);
});

test('last response controls stay above the toolbar at the bottom of a long chat', async ({ app }, info) => {
    test.setTimeout(180000);
    const account = await app.account();
    const page = await account.open({ workspace: false });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar));
        const response = 'A long response fills the chat before its controls.\n\n'.repeat(50)
            + '<details open><summary>World details</summary><p>The expanded panel ends here.</p></details>';
        context.chat[0].mes = response;
        context.chat[0].swipes = [response, response + '\n\nSecond response.'];
        context.chat[0].swipe_id = 0;
        await context.saveChat();
        await context.reloadCurrentChat();
    }, account.avatar);
    const footer = page.locator('#chat .last_mes .nn-response-controls');
    await expect(page.locator('#sb-bottom-chat-bar')).toBeVisible();

    for (const style of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']) {
        await page.locator('#chat_display').selectOption(style, { force: true });
        for (const position of ['below', 'inside']) {
            await page.locator('#desktop_response_controls').selectOption(position, { force: true });
            await expect.poll(() => footer.evaluate(element => element.parentElement.classList.contains('mes_block'))).toBe(position === 'inside');
            // Style changes can reflow the message after the first scroll attempt.
            await expect.poll(() => footer.evaluate(element => {
                const scroller = document.getElementById('chat');
                scroller.scrollTop = scroller.scrollHeight;
                const chat = scroller.getBoundingClientRect();
                const toolbar = document.getElementById('sb-bottom-chat-bar').getBoundingClientRect();
                const box = element.getBoundingClientRect();
                const arrows = [...element.querySelectorAll('.swipe_left, .swipe_right')].filter(arrow => arrow.getBoundingClientRect().width);
                return {
                    bottom: box.bottom,
                    visibleBottom: Math.min(chat.bottom, toolbar.top),
                    fits: box.bottom <= Math.min(chat.bottom, toolbar.top),
                    arrowsReachable: arrows.every(arrow => {
                        const rect = arrow.getBoundingClientRect();
                        return arrow.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
                    }),
                };
            }), { message: `style ${style}, ${position}: controls clear the toolbar and receive clicks` }).toMatchObject({ fits: true, arrowsReachable: true });
            await page.screenshot({ path: info.outputPath(`desktop-${style}-${position}.png`) });
        }
    }
    await page.locator('#desktop_response_controls').selectOption('below', { force: true });
    await footer.locator('.swipe_right').click();
    await expect(page.locator('#chat .last_mes .mes_text')).toContainText('Second response.');
    await footer.locator('.swipe_left').click();
    await expect(page.locator('#chat .last_mes .mes_text')).not.toContainText('Second response.');
});
