/* global window */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

test('the first reply reads setvar toggles placed below the prompt that uses them', async ({ app }) => {
    const account = await app.account({ activeConnection: true, configureSettings: settings => {
        const prompts = [
            { identifier: 'main', role: 'system', system_prompt: true, content: 'Main fixture instruction' },
            { identifier: 'chatHistory', marker: true, system_prompt: true },
            { identifier: 'fixture-formatting', role: 'system', system_prompt: false,
                content: 'Formatting: [{{getvar::writefor}}] [{{getvar::length}}]', injection_position: 1, injection_depth: 1 },
            { identifier: 'fixture-write-for-user', role: 'system', system_prompt: false,
                content: '{{setvar::writefor::Write for every character}}', injection_position: 0 },
            { identifier: 'fixture-length', role: 'system', system_prompt: false,
                content: '{{setvar::length::Any length}}', injection_position: 0 },
        ];
        const remaining = settings.oai_settings.prompts.filter(prompt => !prompts.some(item => item.identifier === prompt.identifier));
        Object.assign(settings.oai_settings, { prompts: [...prompts, ...remaining], prompt_order: [{ character_id: 100001,
            order: [...['main', 'fixture-formatting', 'chatHistory', 'fixture-write-for-user', 'fixture-length']
                .map(identifier => ({ identifier, enabled: true })),
            ...remaining.map(({ identifier }) => ({ identifier, enabled: false }))] }],
        squash_system_messages: false, new_chat_prompt: '', names_behavior: -1, send_if_empty: '',
        custom_prompt_post_processing: '' });
        settings.extension_settings.disabledExtensions.push('third-party/sillytavern-character-colors');
    } });
    const page = await account.open({ workspace: false });
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        const id = context.characters.findIndex(character => character.avatar === avatar);
        if (id < 0 || !await core.selectCharacterById(id, { switchMenu: false })) throw new Error('Fixture character unavailable');
        delete context.chatMetadata.variables;
    }, account.avatar);
    await page.locator('#send_textarea').fill('Fixture setvar question');
    await page.locator('#send_but').click();
    await expect.poll(() => app.provider.calls.filter(call => call.messages?.some(message => message.content === 'Fixture setvar question')).length,
        { timeout: 60000 }).toBe(1);
    const messages = app.provider.calls.find(call => call.messages?.some(message => message.content === 'Fixture setvar question')).messages;
    expect(messages.map(message => message.content)).toContain('Formatting: [Write for every character] [Any length]');
});
