/* global window */
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

async function openSimpleRoleplay(app, phone = false) {
    const account = await app.account({ phone, activeConnection: true, configureSettings(settings) {
        settings.accountStorage['NeconyanSimpleMode.v1'] = 'on';
        settings.accountStorage['NeconyanTutorialStatus.v1'] = 'completed';
        // These tools have their own first-start flows and are not needed for guided drafts.
        settings.extension_settings.disabledExtensions.push('in-chat-agents', 'quick-image-gen');
    } });
    const name = 'Guided shortcuts';
    if (phone) {
        // A greeting in an untouched chat cycles through alternate greetings, not generated replies.
        const fields = { avatar_url: account.avatar, file_name: name };
        const source = await account.context.request.post('/api/chats/get', {
            headers: account.headers, data: { ...fields, allow_create: true },
        });
        const vacancy = JSON.parse(source.headers()['x-neconyan-roleplay']);
        await account.post('/api/chats/save', { ...fields,
            chat: [{ user_name: 'User', character_name: 'Durable Nova', chat_metadata: {} },
                { name: 'User', is_user: true, mes: 'What do you see?', extra: {} },
                { name: 'Durable Nova', is_user: false, mes: 'The door is shut.', extra: {}, swipes: ['The door is shut.'], swipe_id: 0 }],
            roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() },
        });
    }
    const page = await account.open({ workspace: false, waitForFirstStart: false });
    await page.evaluate(async ({ avatar, chat }) => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        if (chat && core.getCurrentChatId() !== chat) await core.openCharacterChat(chat);
        await window.NeconyanShell.activateMode('roleplay');
    }, { avatar: account.avatar, chat: phone ? name : null });
    return page;
}

function guidedButtons(page) {
    const bar = page.locator('#sb-bottom-chat-bar');
    return {
        swipe: bar.getByRole('button', { name: 'Guided Swipe', exact: true }),
        impersonate: bar.getByRole('button', { name: 'Guided Impersonate', exact: true }),
        picker: bar.getByRole('button', { name: 'Switch chat', exact: true }),
        collapse: bar.locator('.sb-bottom-chat-collapse-toggle'),
    };
}

test('the guided shortcuts fit in the collapsed phone bar and use the existing actions', async ({ app }) => {
    const page = await openSimpleRoleplay(app, true);
    const { swipe, impersonate, picker, collapse } = guidedButtons(page);
    if (await collapse.getAttribute('aria-expanded') === 'true') await collapse.tap();
    await expect(collapse).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#sb-bottom-chat-secondary-row')).toBeHidden();
    await expect(page.locator('#gg-action-button-container')).toBeHidden();
    await expect(swipe).toBeVisible();
    await expect(impersonate).toBeVisible();

    const boxes = await Promise.all([picker, swipe, impersonate, collapse].map(button => button.boundingBox()));
    for (const [index, box] of boxes.entries()) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(393);
        if (index) expect(box.x).toBeGreaterThanOrEqual(boxes[index - 1].x + boxes[index - 1].width);
        if (index === 1 || index === 2) {
            expect(box.width).toBeGreaterThanOrEqual(44);
            expect(box.height).toBeGreaterThanOrEqual(44);
        }
        expect(Math.abs(box.y + box.height / 2 - (boxes[0].y + boxes[0].height / 2))).toBeLessThan(2);
    }

    const messages = page.locator('#chat > .mes .mes_text');
    const reply = messages.last();
    const composer = page.locator('#send_textarea');
    await expect(reply).toHaveText('The door is shut.');
    await composer.fill('Guide the new alternative towards the window.');
    await swipe.tap();
    await expect(reply).toContainText('Durable first reply.');
    await expect(composer).toHaveValue('Guide the new alternative towards the window.');
    expect(await page.evaluate(() => window.SillyTavern.getContext().chat.at(-1).swipes[0])).toBe('The door is shut.');
    await expect(page.locator('body')).not.toHaveAttribute('data-generating', /.+/);

    await composer.fill('Draft my character opening the window.');
    await impersonate.tap();
    await expect(composer).toHaveValue(/Durable first reply\./);
    await expect(messages).toHaveCount(2);
    await expect(reply).toContainText('Durable first reply.');
});

test('desktop switches between the two placements and honours Guided Generations settings', async ({ app }) => {
    const page = await openSimpleRoleplay(app);
    const { swipe, impersonate, picker } = guidedButtons(page);
    await expect(swipe).toBeVisible();
    await expect(impersonate).toBeVisible();
    const [pickerBox, swipeBox, impersonateBox] = await Promise.all([picker, swipe, impersonate].map(button => button.boundingBox()));
    expect(swipeBox.x).toBeGreaterThanOrEqual(pickerBox.x + pickerBox.width);
    expect(impersonateBox.x).toBeGreaterThanOrEqual(swipeBox.x + swipeBox.width);
    expect(impersonateBox.x + impersonateBox.width).toBeLessThanOrEqual(1280);

    const setSimpleMode = enabled => page.evaluate(async value => {
        (await import('/scripts/neconyan-simple-mode.js')).setSimpleModeEnabled(value);
    }, enabled);
    await setSimpleMode(false);
    await expect(swipe).toBeHidden();
    await expect(impersonate).toBeHidden();
    await expect(page.locator('#gg_swipe_button')).toBeVisible();
    await expect(page.locator('#gg_impersonate_button')).toBeVisible();
    await expect(page.locator('[data-sb-bottom-unit="scroll"]')).toBeVisible();

    // These controls are in the Extensions settings drawer. Exercise the actual setting listeners.
    await page.locator('#gg_showGuidedSwipe').evaluate(input => input.click());
    await setSimpleMode(true);
    await expect(swipe).toBeHidden();
    await expect(impersonate).toBeVisible();
    await page.locator('#gg_showImpersonate1stPerson').evaluate(input => input.click());
    await expect(page.locator('#sb-bottom-chat-guided-actions')).toBeEmpty();

    await page.locator('#gg_showGuidedSwipe').evaluate(input => input.click());
    await expect(swipe).toBeVisible();
    await page.evaluate(async () => (await import('/scripts/extensions.js')).disableExtension('guided-generations', false));
    await expect(page.locator('#sb-bottom-chat-guided-actions')).toBeEmpty();
});
