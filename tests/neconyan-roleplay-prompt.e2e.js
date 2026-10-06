/* global window, document */
import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';
import { setConfigFilePath } from '../src/util.js';
import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { roleplayAccountStamp } = await import('../src/roleplay-store.js');
const { captureRoleplaySource, readRoleplayChat } = await import('../src/generation/roleplay-source.js');
const { captureRoleplayWorldInfo } = await import('../src/generation/world-info.js');
const { captureGenerationBinding, getChatProfileContextLimit } = await import('../src/generation/profiles.js');
const { getSettingsRevision } = await import('../src/settings-version.js');
const { admitRoleplayJob } = await import('../src/roleplay-jobs.js');
const { releaseJob } = await import('../src/jobs/store.js');

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

function submitPrivateFollowup(app, account, chatName) {
    const owner = 'default-user';
    const directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE)
        .map(([key, relative]) => [key, path.join(app.directory, 'data', owner, relative)]));
    const base = { owner, directories };
    const { accountId, dataEpoch } = roleplayAccountStamp(base);
    const stamp = { accountId, dataEpoch };
    const scope = { ...base, ...stamp };
    const locator = { group: false, avatar: account.avatar, chat: chatName };
    const source = captureRoleplaySource(scope, { locator });
    const savedSettings = JSON.parse(fs.readFileSync(path.join(directories.root, 'settings.json'), 'utf8'));
    const binding = captureGenerationBinding(directories, { kind: 'active' }, { settingsRevision: getSettingsRevision(savedSettings) });
    const maxTokens = 64;
    const intent = { operationKey: 'private-prompt-followup', effect: 'append', source,
        request: { binding, serverPrompt: true, messages: [], maxTokens, characterName: 'Durable Nova',
            worldInfo: captureRoleplayWorldInfo(base, stamp, source, { avatar: account.avatar,
                maxContext: getChatProfileContextLimit(directories, binding) - maxTokens, serverPrompt: true }) } };
    const { jobId } = admitRoleplayJob(base, stamp, intent);
    releaseJob(directories, jobId);
    return { scope, locator, base, stamp, intent, jobId };
}

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} Roleplay Send accepts an empty Main Prompt marker`, async ({ app }, info) => {
        const account = await app.account({ phone, activeConnection: true, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {},
            configureSettings: settings => {
                Object.assign(settings.oai_settings.prompts.find(prompt => prompt.identifier === 'main'), { marker: true, content: '' });
                for (const order of settings.oai_settings.prompt_order) {
                    for (const prompt of order.order) prompt.enabled = ['main', 'chatHistory'].includes(prompt.identifier);
                }
                Object.assign(settings.oai_settings, { squash_system_messages: false, new_chat_prompt: '', names_behavior: -1,
                    send_if_empty: '', custom_prompt_post_processing: '' });
                settings.extension_settings.note.default = '';
                settings.extension_settings.disabledExtensions.push('third-party/sillytavern-character-colors');
            } });
        if (phone) await installIPhoneSafari(account.context);
        const page = await account.open({ workspace: false });
        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await (await import('/script.js')).selectCharacterById(context.characters.findIndex(character => character.avatar === avatar),
                { switchMenu: false });
        }, account.avatar);
        if (phone) await applyIOSOnlyCss(page);
        await page.locator('#send_textarea').fill('Empty main question');
        await page.locator('#send_but').click();
        await expect(page.locator('#chat .mes').last()).toContainText('Durable first reply.', { timeout: 60000 });
        expect(app.provider.calls).toHaveLength(1);
        expect(app.provider.calls[0].messages).toEqual([
            { role: 'assistant', content: 'Hello.' }, { role: 'user', content: 'Empty main question' },
        ]);
        const bounds = await page.locator('#send_textarea').boundingBox();
        expect(bounds.width).toBeGreaterThan(100);
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        await page.screenshot({ path: info.outputPath('empty-main-reply.png') });
    });

    test(`${phone ? 'phone' : 'desktop'} text Roleplay uses shared instruct formatting before and after every page closes`, async ({ app }) => {
        app.provider.mode.reply = { content: 'Text fixture reply' };
        const account = await app.account({ phone, textProfile: true, activeConnection: true, configureSettings: settings => {
            settings.power_user.tokenizer = 1;
            settings.power_user.strip_examples = true;
            settings.power_user.instruct = { enabled: true, wrap: false, names_behavior: 'none', input_sequence: '<U>',
                output_sequence: '<A>', first_output_sequence: '<FIRST_A>', last_input_sequence: '<LAST>', last_output_sequence: '<NEXT>',
                input_suffix: '</U>', output_suffix: '</A>', story_string_prefix: '<S>', story_string_suffix: '</S>' };
            settings.power_user.context = { story_string: '{{description}}', story_string_position: 0, chat_start: '' };
            settings.extension_settings.note.default = '';
            settings.extension_settings.disabledExtensions.push('third-party/sillytavern-character-colors');
        } });
        const page = await account.open({ workspace: false });
        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await (await import('/script.js')).selectCharacterById(context.characters.findIndex(character => character.avatar === avatar),
                { switchMenu: false });
        }, account.avatar);
        await page.locator('#send_textarea').fill('Fixture text question');
        await page.locator('#send_but').click();
        await expect(page.locator('#chat .mes').last()).toContainText('Text fixture reply', { timeout: 60000 });
        const prefix = '<S>Nova belongs to account default-user.</S><FIRST_A>Hello.</A><LAST>Fixture text question</U>';
        expect(app.provider.calls).toHaveLength(1);
        expect(app.provider.calls[0].prompt).toBe(prefix + '<NEXT>');
        const chatName = await page.evaluate(async () => {
            if (!await (await import('/script.js')).flushPendingChatSavesForNavigation()) throw new Error('Chat save failed');
            return window.SillyTavern.getContext().getCurrentChatId();
        });
        await page.close();
        const { jobId, scope, locator } = submitPrivateFollowup(app, account, chatName);
        expect(account.context.pages()).toHaveLength(0);
        await account.settled(jobId);
        expect(app.provider.calls).toHaveLength(2);
        expect(app.provider.calls[1].prompt).toBe(prefix + '<A>Text fixture reply</A><NEXT>');
        expect(readRoleplayChat(scope, locator).records.at(-1).mes).toBe('Text fixture reply');
    });

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
        await expect(page.locator('#chat .mes').last()).toContainText('Durable first reply.');
        const chatName = await page.evaluate(async () => {
            const core = await import('/script.js');
            if (!await core.flushPendingChatSavesForNavigation()) throw new Error('The browser chat was not saved');
            return window.SillyTavern.getContext().getCurrentChatId();
        });
        await page.close();
        const { scope, locator, base, stamp, intent, jobId } = submitPrivateFollowup(app, account, chatName);
        expect(account.context.pages()).toHaveLength(0);
        await account.settled(jobId);
        const saved = readRoleplayChat(scope, locator).records;
        expect(saved.at(-1).mes).toContain('Durable first reply.');
        expect(app.provider.calls).toHaveLength(2);
        const native = app.provider.calls[1].messages;
        expect(native[0]).toEqual({ role: 'assistant', content: 'Before fixture history' });
        expect(native.at(-1)).toEqual({ role: 'user', content: 'After fixture history' });
        expect(native.some(message => message.content.includes('Remember fixture rain'))).toBe(true);
        expect(admitRoleplayJob(base, stamp, intent).jobId).toBe(jobId);
        await app.restart();
        const reopened = await account.open({ workspace: false });
        await reopened.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await (await import('/script.js')).selectCharacterById(context.characters.findIndex(character => character.avatar === avatar),
                { switchMenu: false });
        }, account.avatar);
        await expect(reopened.locator('#chat .mes').last()).toContainText('Durable first reply.');
        expect(readRoleplayChat(scope, locator).records).toEqual(saved);
        expect(app.provider.calls).toHaveLength(2);
        await reopened.close();
    });
}
