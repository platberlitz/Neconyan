/* global document, $ */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { installSyntheticLongChat } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const name = 'Kaveh & Alhaitham';
const text = 'The room falls quiet as he sets the book aside.\n\nHe looks towards the window, then turns back to continue their conversation.';
const chatStyles = { 0: 'flat', 1: 'bubbles', 2: 'document', 3: 'echo', 4: 'whisper', 5: 'hush', 6: 'ripple', 7: 'tide',
    8: 'messenger', 9: 'notebook', 10: 'screenplay', 11: 'compact', 12: 'storybook' };

test('phone message actions keep More, Edit, Delete and Copy on one row in every chat style', async ({ app }) => {
    test.setTimeout(240000);
    const account = await app.account({ phone: true, contextOptions: IPHONE_SAFARI_CONTEXT, configureSettings(saved) {
        saved.power_user.timestamp_model_name = true;
        saved.power_user.timestamp_reasoning_effort = true;
        saved.power_user.timestamp_model_icon = true;
    } });
    await installIPhoneSafari(account.context);
    const page = await account.open({ workspace: false, readyTimeout: 60000 });
    await applyIOSOnlyCss(page);
    await page.addStyleTag({ content: '#toast-container, #nn-update-toast { visibility: hidden; }' });
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, account.avatar);
    await installSyntheticLongChat(page, { messageCount: 6 });
    await expect(page.locator('#chat')).toBeVisible();

    for (const [style, label] of Object.entries(chatStyles)) {
        await page.evaluate(async ({ style, name, text }) => {
            $('#chat_display').val(style).trigger('change');
            const core = await import('/script.js');
            const index = core.chat.length - 1;
            const message = { name, mes: text, is_user: false, is_system: false, send_date: new Date().toISOString(),
                extra: { api: 'makersuite', model: 'gemini-4-carbon', reasoning_effort: 'low' }, swipes: [text], swipe_id: 0 };
            core.chat[index] = message;
            core.addOneMessage(message, { type: 'swipe', forceId: index, scroll: false });
            core.showSwipeButtons();
        }, { style, name, text });
        await expect.poll(() => page.evaluate(() => {
            const row = [...document.querySelectorAll('#chat .mes[mesid]')].at(-1);
            const actions = [...row.querySelectorAll('.mes_buttons > .neconyan-message-action')]
                .filter(button => button.getClientRects().length)
                .map(button => {
                    const box = button.getBoundingClientRect();
                    return { label: button.textContent.trim(), top: Math.round(box.top), height: Math.round(box.height) };
                });
            return {
                labels: actions.map(action => action.label),
                rows: new Set(actions.map(action => action.top)).size,
                shortest: Math.min(...actions.map(action => action.height)),
            };
        }), { message: `${label} action row` }).toEqual({ labels: ['More', 'Edit', 'Delete', 'Copy'], rows: 1, shortest: 44 });
    }
});
