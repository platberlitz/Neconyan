/* global window, document */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} real Roleplay Send preserves custom and shared depth prompt ordering`, async ({ app }) => {
        const account = await app.account({ phone, activeConnection: true, configureSettings: settings => {
            const prompts = [
                { identifier: 'main', role: 'system', system_prompt: true, content: 'Main fixture instruction' },
                { identifier: 'chatHistory', marker: true, system_prompt: true },
                { identifier: 'fixture-before', role: 'assistant', system_prompt: false, content: 'Before fixture history', injection_position: 0 },
                { identifier: 'fixture-near', role: 'system', system_prompt: false, content: 'Near fixture depth',
                    injection_position: 1, injection_depth: 1, injection_order: 10 },
                { identifier: 'fixture-far', role: 'system', system_prompt: false, content: 'Far fixture depth',
                    injection_position: 1, injection_depth: 1, injection_order: 100 },
                { identifier: 'fixture-after', role: 'user', system_prompt: false, content: 'After fixture history', injection_position: 0 },
            ];
            const remaining = settings.oai_settings.prompts.filter(prompt => !prompts.some(item => item.identifier === prompt.identifier));
            Object.assign(settings.oai_settings, { prompts: [...prompts, ...remaining], prompt_order: [{ character_id: 100001,
                order: [...['fixture-before', 'main', 'fixture-near', 'fixture-far', 'chatHistory', 'fixture-after']
                    .map(identifier => ({ identifier, enabled: true })),
                ...remaining.map(({ identifier }) => ({ identifier, enabled: false }))] }],
            squash_system_messages: false, new_chat_prompt: '', names_behavior: -1, send_if_empty: '',
            custom_prompt_post_processing: '' });
            settings.extension_settings.disabledExtensions.push('third-party/sillytavern-character-colors');
            Object.assign(settings.extension_settings.note, { default: 'Remember fixture rain', defaultInterval: 1,
                defaultDepth: 0, defaultPosition: 1, defaultRole: 0 });
        } });
        const page = await account.open({ workspace: false });
        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            const id = context.characters.findIndex(character => character.avatar === avatar);
            if (id < 0 || !await core.selectCharacterById(id, { switchMenu: false })) throw new Error('Fixture character unavailable');
        }, account.avatar);
        await page.locator('#send_textarea').fill('Fixture prompt question');
        await page.locator('#send_but').click();
        await expect.poll(() => app.provider.calls.filter(call => call.messages?.some(message => message.content === 'Fixture prompt question')).length,
            { timeout: 60000 }).toBe(1);
        const messages = app.provider.calls.find(call => call.messages?.some(message => message.content === 'Fixture prompt question')).messages;
        expect(messages.map(message => message.content)).toEqual([
            'Before fixture history', 'Main fixture instruction', 'Hello.', 'Near fixture depth', 'Far fixture depth',
            'Fixture prompt question', 'Remember fixture rain', 'After fixture history',
        ]);
        expect(messages[0].role).toBe('assistant');
        expect(messages.at(-1).role).toBe('user');
        const geometry = await page.locator('#send_textarea').evaluate(element => {
            const bounds = element.getBoundingClientRect();
            return { width: bounds.width, left: bounds.left, right: bounds.right, viewport: window.innerWidth,
                overflow: document.documentElement.scrollWidth > window.innerWidth };
        });
        expect(geometry.width).toBeGreaterThan(100);
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
        expect(geometry.overflow).toBe(false);
        await page.close();
    });
}
