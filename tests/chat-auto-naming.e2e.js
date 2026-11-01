/* global window */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { acknowledgeActiveSettings, MODEL, test } from './neconyan-conversation-durable-fixture.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(240000);

const LABEL_PROMPT = 'You create short, clean chat titles';
const DATED = /^Durable Nova - \d{4}-\d{2}-\d{2}(?:@\d{2}h\d{2}m\d{2}s\d{3}ms| \d{2}-\d{2}-\d{2})$/;
const SCREENSHOTS = process.env.NECONYAN_AUTO_NAME_SCREENSHOTS || '';

const isLabelCall = call => JSON.stringify(call.messages || '').includes(LABEL_PROMPT);

function useProvider(app) {
    let replies = 0;
    let titles = 0;
    app.provider.mode.reply = body => {
        const content = JSON.stringify(body.messages || '').includes(LABEL_PROMPT)
            ? JSON.stringify({ title: `Moonlit Garden Chapter ${++titles}` })
            : `Nova answers ${++replies}.`;
        return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] };
    };
    return { labelCalls: () => app.provider.calls.filter(isLabelCall) };
}

async function openChat(account) {
    const page = await account.open({ workspace: false });
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, account.avatar);
    await acknowledgeActiveSettings(page);
    await expect(page.locator('#chat .mes[mesid="0"]')).toContainText('Hello.');
    return page;
}

const chatId = page => page.evaluate(async () => (await import('/script.js')).getCurrentChatId());
const isIdle = page => page.evaluate(async () => {
    const core = await import('/script.js');
    return !core.is_send_press && !core.streamingProcessor;
});

async function exchange(page, text, answerNumber) {
    await page.locator('#send_textarea').fill(text);
    await page.locator('#send_textarea').press('Enter');
    await expect(page.locator('#chat .mes[mesid]').last()).toContainText(`Nova answers ${answerNumber}.`, { timeout: 30000 });
    await expect.poll(() => isIdle(page)).toBe(true);
}

async function chatFiles(app, account) {
    const directory = path.join(app.dataRoot, 'default-user', 'chats', path.parse(account.avatar).name);
    return { directory, names: (await fs.readdir(directory)).filter(name => name.endsWith('.jsonl')).map(name => name.slice(0, -6)) };
}

async function readChat(directory, name) {
    return (await fs.readFile(path.join(directory, `${name}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

async function openChatSettings(page) {
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
    await page.locator('#sb-settings-tabs .sb-settings-tab-btn').filter({ hasText: 'Chat & Writing' }).click();
    if (!(await page.locator('#auto_label_chat_threshold').isVisible())) await page.locator('#ChatCharactersSection > .inline-drawer-header').click();
    await page.locator('#auto_label_chat_threshold').scrollIntoViewIfNeeded();
}

async function closeSettings(page) {
    await page.locator('.sb-shell-close:visible').first().click();
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';

    test(`${viewport} names a timestamp chat once after six messages, when the reply and saves have finished`, async ({ app }) => {
        const provider = useProvider(app);
        const account = await app.account({ phone, activeConnection: true });
        const page = await openChat(account);
        const original = await chatId(page);
        expect(original).toMatch(DATED);

        await openChatSettings(page);
        await expect(page.locator('#auto_label_chat')).toBeChecked();
        await expect(page.locator('#auto_label_chat_threshold')).toHaveValue('6');
        const bounds = await page.locator('#auto_label_chat_threshold').boundingBox();
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        expect(bounds.height).toBeGreaterThanOrEqual(phone ? 44 : 32);
        if (SCREENSHOTS) await page.screenshot({ path: path.join(SCREENSHOTS, `settings-after-${viewport}.png`) });
        await closeSettings(page);

        await exchange(page, 'Show me the moonlit garden.', 1);
        await exchange(page, 'Which roses bloom at night?', 2);
        // Five messages, greeting included: below the default of six.
        await page.waitForTimeout(3000);
        expect(provider.labelCalls()).toHaveLength(0);
        expect(await chatId(page)).toBe(original);
        if (SCREENSHOTS) await page.screenshot({ path: path.join(SCREENSHOTS, `chat-before-${viewport}.png`) });

        const replyCalls = () => app.provider.calls.filter(call => !isLabelCall(call));
        await exchange(page, 'Let us follow the silver path.', 3);
        await page.locator('#chat .mes[mesid="1"]').evaluate(node => { node.dataset.autoNameProbe = 'kept'; });
        await expect.poll(() => chatId(page), { timeout: 30000 }).toBe('Durable Nova - Moonlit Garden Chapter 1');
        // The sixth message was the user's: the title waited for Nova's reply instead of racing it.
        const label = provider.labelCalls()[0];
        expect(label.startedAt).toBeGreaterThanOrEqual(replyCalls()[2].completedAt);
        expect(JSON.stringify(label.messages)).toContain('Let us follow the silver path.');
        expect(JSON.stringify(label.messages)).toContain('Nova answers 3.');

        const { directory, names } = await chatFiles(app, account);
        expect(names).toEqual(['Durable Nova - Moonlit Garden Chapter 1']);
        expect((await readChat(directory, names[0])).slice(1).map(message => message.mes)).toEqual([
            'Hello.', 'Show me the moonlit garden.', 'Nova answers 1.', 'Which roses bloom at night?', 'Nova answers 2.',
            'Let us follow the silver path.', 'Nova answers 3.',
        ]);
        // Naming happens quietly, without save notices, and without a full reload:
        // the messages on screen are the same nodes as before the rename.
        await expect(page.locator('#toast-container .toast').filter({ hasText: /Saving chat|Chat saved|not renamed/ })).toHaveCount(0);
        await expect(page.locator('#chat .mes[mesid="1"][data-auto-name-probe="kept"]')).toHaveCount(1);
        await expect(page.locator('#sb-bottom-chat-bar, #top-bar').filter({ hasText: 'Moonlit Garden Chapter 1' }).first()).toBeAttached();
        if (SCREENSHOTS) await page.screenshot({ path: path.join(SCREENSHOTS, `chat-after-${viewport}.png`) });

        // Later messages keep saving to the renamed file, and it is never named twice.
        await exchange(page, 'One more step along the path.', 4);
        await expect.poll(async () => (await readChat(directory, 'Durable Nova - Moonlit Garden Chapter 1')).at(-1).mes, { timeout: 20000 }).toBe('Nova answers 4.');
        await page.waitForTimeout(3000);
        expect(provider.labelCalls()).toHaveLength(1);
        expect((await chatFiles(app, account)).names).toEqual(['Durable Nova - Moonlit Garden Chapter 1']);
        await expect(page.locator('.toast-error')).toHaveCount(0);
    });
}

test('the switch, a custom count and a manual name are respected', async ({ app }) => {
    const provider = useProvider(app);
    const account = await app.account({ activeConnection: true, configureSettings(saved) {
        saved.power_user.auto_label_chat = false;
    } });
    const page = await openChat(account);
    await openChatSettings(page);
    await expect(page.locator('#auto_label_chat')).not.toBeChecked();
    await expect(page.locator('#auto_label_chat_threshold')).toBeDisabled();
    await expect(page.locator('#auto_label_chat_threshold')).toHaveValue('6');
    await closeSettings(page);

    await exchange(page, 'First question.', 1);
    await exchange(page, 'Second question.', 2);
    await exchange(page, 'Third question.', 3);
    await page.waitForTimeout(3000);
    expect(provider.labelCalls()).toHaveLength(0);
    expect(await chatId(page)).toMatch(DATED);

    // A user-chosen name that happens to look like a date is still the user's name.
    const manual = 'Durable Nova - 2026-01-01@01h01m01s001ms';
    await page.evaluate(async ([oldName, newName]) => (await import('/script.js')).renameChat(oldName, newName), [await chatId(page), manual]);
    await expect.poll(() => chatId(page)).toBe(manual);
    const { directory: manualDirectory } = await chatFiles(app, account);
    expect((await readChat(manualDirectory, manual))[0].chat_metadata.neconyan_manual_chat_name).toBe(true);

    await openChatSettings(page);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/save')
        && response.request().postDataJSON()?.power_user?.auto_label_chat_threshold === 8
        && response.request().postDataJSON()?.power_user?.auto_label_chat === true);
    await page.locator('label[for="auto_label_chat"]').click();
    await expect(page.locator('#auto_label_chat_threshold')).toBeEnabled();
    await page.locator('#auto_label_chat_threshold').fill('8');
    expect((await saved).ok()).toBe(true);
    await closeSettings(page);

    await exchange(page, 'Fourth question.', 4);
    await page.waitForTimeout(3000);
    expect(provider.labelCalls()).toHaveLength(0);
    expect(await chatId(page)).toBe(manual);

    // A fresh chat with the new count of eight gets named after its fourth exchange.
    await page.evaluate(async () => (await import('/script.js')).doNewChat({ deleteCurrentChat: false }));
    await expect.poll(() => chatId(page)).toMatch(DATED);
    for (const [index, text] of ['Fifth.', 'Sixth.', 'Seventh.'].entries()) await exchange(page, text, 5 + index);
    await page.waitForTimeout(3000);
    expect(provider.labelCalls()).toHaveLength(0);
    await exchange(page, 'Eighth.', 8);
    await expect.poll(() => chatId(page), { timeout: 30000 }).toBe('Durable Nova - Moonlit Garden Chapter 1');
    expect((await chatFiles(app, account)).names.sort()).toEqual([manual, 'Durable Nova - Moonlit Garden Chapter 1'].sort());
});

test('a new message during the file rename keeps saving under the new name without losing the reply', async ({ app }) => {
    useProvider(app);
    const account = await app.account({ activeConnection: true, configureSettings(saved) {
        saved.power_user.auto_label_chat_threshold = 3;
    } });
    const page = await openChat(account);
    let release;
    let renamedOnServer = false;
    const held = new Promise(resolve => { release = resolve; });
    await page.route('**/api/chats/rename', async route => {
        const response = await route.fetch();
        renamedOnServer = true;
        await held;
        await route.fulfill({ response });
    });
    try {
        await exchange(page, 'Begin the story.', 1);
        await expect.poll(() => renamedOnServer, { timeout: 20000 }).toBe(true);
        await page.locator('#send_textarea').fill('Keep every word of this reply.');
        await page.locator('#send_textarea').press('Enter');
        await page.waitForTimeout(500);
        release();
        await expect(page.locator('#chat .mes[mesid]').last()).toContainText('Nova answers 2.', { timeout: 30000 });
        await expect.poll(() => isIdle(page)).toBe(true);
        await expect.poll(() => chatId(page), { timeout: 20000 }).toBe('Durable Nova - Moonlit Garden Chapter 1');
        const { directory, names } = await chatFiles(app, account);
        expect(names).toEqual(['Durable Nova - Moonlit Garden Chapter 1']);
        await expect.poll(async () => (await readChat(directory, names[0])).slice(1).map(message => message.mes), { timeout: 20000 }).toEqual([
            'Hello.', 'Begin the story.', 'Nova answers 1.', 'Keep every word of this reply.', 'Nova answers 2.',
        ]);
        await expect(page.locator('.toast-error')).toHaveCount(0);
    } finally {
        release();
    }
});

test('a group chat is named once its reply has finished and continues saving', async ({ app }) => {
    const provider = useProvider(app);
    const account = await app.account({ activeConnection: true, configureSettings(saved) {
        saved.power_user.auto_label_chat_threshold = 3;
    } });
    const original = '2026-10-31@12h00m00s000ms';
    const group = await account.post('/api/groups/create', {
        name: 'Garden party', members: [account.avatar], chat_id: original, chats: [original],
        allow_self_responses: false, activation_strategy: 0, generation_mode: 0,
    });
    const page = await account.open({ workspace: false });
    await page.evaluate(async id => {
        await (await import('/scripts/group-chats.js')).openGroupById(id, { switchMenu: false });
    }, group.id);
    await acknowledgeActiveSettings(page);
    await exchange(page, 'Start our group scene.', 1);
    await expect.poll(() => chatId(page), { timeout: 25000 }).toBe('Moonlit Garden Chapter 1');
    await exchange(page, 'Keep the group scene going.', 2);
    const directory = path.join(app.dataRoot, 'default-user', 'group chats');
    await expect.poll(async () => (await readChat(directory, 'Moonlit Garden Chapter 1')).at(-1).mes, { timeout: 20000 }).toBe('Nova answers 2.');
    expect(provider.labelCalls()).toHaveLength(1);
    await expect(page.locator('.toast-error')).toHaveCount(0);
});

test('a message sent while the title is being written cancels it, and the next quiet moment tries again', async ({ app }) => {
    const provider = useProvider(app);
    const account = await app.account({ activeConnection: true, configureSettings(saved) {
        saved.power_user.auto_label_chat_threshold = 3;
    } });
    const page = await openChat(account);
    app.provider.mode.hold = MODEL;
    await page.locator('#send_textarea').fill('Begin the story.');
    await page.locator('#send_textarea').press('Enter');
    await expect.poll(() => app.provider.calls.length).toBe(1);
    // Release the reply only, so the title request that follows it is held.
    await app.release();
    app.provider.mode.hold = MODEL;
    await expect(page.locator('#chat .mes[mesid]').last()).toContainText('Nova answers 1.');
    await expect.poll(() => provider.labelCalls().length, { timeout: 20000 }).toBe(1);

    app.provider.mode.hold = '';
    await exchange(page, 'Keep going.', 2);
    await expect.poll(() => provider.labelCalls().length, { timeout: 20000 }).toBe(2);
    await expect.poll(() => chatId(page), { timeout: 30000 }).toBe('Durable Nova - Moonlit Garden Chapter 1');

    // The abandoned answer arrives late (the provider numbers titles as it answers) and changes nothing.
    await app.release();
    await page.waitForTimeout(2000);
    expect(await chatId(page)).toBe('Durable Nova - Moonlit Garden Chapter 1');
    expect((await chatFiles(app, account)).names).toEqual(['Durable Nova - Moonlit Garden Chapter 1']);
    expect(provider.labelCalls()).toHaveLength(2);
});

test('switching chats while the title is being written leaves the chat alone until it is used again', async ({ app }) => {
    const provider = useProvider(app);
    const account = await app.account({ activeConnection: true, configureSettings(saved) {
        saved.power_user.auto_label_chat_threshold = 3;
    } });
    const page = await openChat(account);
    const first = await chatId(page);
    app.provider.mode.hold = MODEL;
    await page.locator('#send_textarea').fill('Begin the story.');
    await page.locator('#send_textarea').press('Enter');
    await expect.poll(() => app.provider.calls.length).toBe(1);
    await app.release();
    app.provider.mode.hold = MODEL;
    await expect(page.locator('#chat .mes[mesid]').last()).toContainText('Nova answers 1.');
    await expect.poll(() => provider.labelCalls().length, { timeout: 20000 }).toBe(1);

    await page.evaluate(async () => (await import('/script.js')).doNewChat({ deleteCurrentChat: false }));
    await expect.poll(() => chatId(page)).not.toBe(first);
    const second = await chatId(page);
    app.provider.mode.hold = '';
    await app.release();
    await page.waitForTimeout(2500);
    expect((await chatFiles(app, account)).names.sort()).toEqual([first, second].sort());
    expect(await chatId(page)).toBe(second);

    await page.evaluate(async name => (await import('/script.js')).openCharacterChat(name), first);
    await expect.poll(() => chatId(page)).toBe(first);
    // Opening it again is not activity; the next exchange is.
    await page.waitForTimeout(2500);
    expect(provider.labelCalls()).toHaveLength(1);
    await exchange(page, 'Back again.', 2);
    await expect.poll(() => chatId(page), { timeout: 30000 }).toBe('Durable Nova - Moonlit Garden Chapter 2');
    expect((await chatFiles(app, account)).names.sort()).toEqual([second, 'Durable Nova - Moonlit Garden Chapter 2'].sort());
});
