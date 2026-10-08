/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

describe('Guided Correction', () => {
    let context;
    let eventSource;
    let eventTypes;
    let extensionSettings;
    let generate;
    let textarea;
    let workflows;

    beforeEach(async () => {
        jest.resetModules();

        class TestTextAreaElement {}
        globalThis.HTMLTextAreaElement = TestTextAreaElement;
        globalThis.Event = class Event {
            constructor(type, options = {}) {
                this.type = type;
                this.options = options;
            }
        };
        globalThis.toastr = {
            error: jest.fn(),
            warning: jest.fn(),
        };

        textarea = new TestTextAreaElement();
        textarea.value = 'make the reply more suspicious';
        textarea.dispatchEvent = jest.fn();

        eventTypes = {
            MESSAGE_EDITED: 'message_edited',
            MESSAGE_UPDATED: 'message_updated',
        };
        eventSource = { emit: jest.fn(async () => {}) };
        generate = jest.fn();
        extensionSettings = {
            'guided-generations': {
                injectionEndRole: 'system',
                depthPromptGuidedCorrection: 2,
                promptGuidedCorrection: 'CORRECT: {{input}}',
                depthPromptGuidedRegenerate: 1,
                promptGuidedRegenerate: 'REGENERATE: {{input}}',
            },
        };

        context = {
            chat: [],
            chatMetadata: { script_injects: {} },
            characters: [],
            groupId: null,
            executeSlashCommandsWithOptions: jest.fn(async (command) => {
                const injectMatch = String(command).match(/\/inject id=([^\s|]+)/);
                if (injectMatch) {
                    context.chatMetadata.script_injects[injectMatch[1]] = { value: command };
                }

                const flushMatch = String(command).match(/\/flushinject ([^\s|]+)/);
                if (flushMatch) {
                    delete context.chatMetadata.script_injects[flushMatch[1]];
                }
            }),
            deleteMessage: jest.fn(async (index) => context.chat.splice(index, 1)),
            redisplayChat: jest.fn(async () => {}),
            saveChat: jest.fn(async () => {}),
            updateMessageBlock: jest.fn(),
        };

        globalThis.document = {
            getElementById: jest.fn(id => id === 'send_textarea' ? textarea : null),
        };

        await jest.unstable_mockModule('../public/script.js', () => ({
            Generate: generate,
            eventSource,
            event_types: eventTypes,
            is_send_press: false,
        }));
        await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
            is_group_generating: false,
        }));
        await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
            extension_settings: extensionSettings,
            getContext: jest.fn(() => context),
        }));
        // The shell's named-workflow module is replaced so the browser path stays
        // deterministic and no real import outlives the test environment.
        workflows = {
            ready: false,
            capturePagePrompts: jest.fn(async () => []),
            isNativeRoleplayWorkflowReady: jest.fn(() => workflows.ready),
            resolvePageText: jest.fn(text => String(text ?? '').trim() || null),
            submitRoleplayWorkflow: jest.fn(async () => ({ key: 'guided-key', jobId: 'job-1' })),
        };
        await jest.unstable_mockModule('../public/scripts/neconyan-conversation/roleplay-workflows.js', () => ({
            capturePagePrompts: (...args) => workflows.capturePagePrompts(...args),
            isNativeRoleplayWorkflowReady: (...args) => workflows.isNativeRoleplayWorkflowReady(...args),
            resolvePageText: (...args) => workflows.resolvePageText(...args),
            submitRoleplayWorkflow: (...args) => workflows.submitRoleplayWorkflow(...args),
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/guided-generations/scripts/presetUtils.js', () => ({
            getCurrentProfile: jest.fn(async () => ''),
            getCurrentProfileId: jest.fn(async () => ''),
            getPresetsForApiType: jest.fn(async () => []),
            getProfileApiType: jest.fn(async () => ''),
            getProfileById: jest.fn(() => null),
            getProfileList: jest.fn(async () => []),
            handleSwitching: jest.fn(async () => ({ switch: jest.fn(), restore: jest.fn() })),
            resolveStoredProfile: jest.fn(() => null),
        }));
    });

    test('regeneration uses its own native workflow and leaves the composer alone', async () => {
        context.chat.push({ is_user: true, mes: 'Prompt' }, { name: 'Bot', mes: 'Old reply' });
        workflows.ready = true;
        const { guidedRegenerate } = await import('../public/scripts/extensions/guided-generations/scripts/guidedCorrection.js');
        await guidedRegenerate();
        expect(workflows.submitRoleplayWorkflow).toHaveBeenCalledWith({
            name: 'guided.regenerate',
            intent: { prompt: { text: 'REGENERATE: make the reply more suspicious', depth: 1, role: 'system', scan: true } },
            page: [],
        });
        expect(generate).not.toHaveBeenCalled();
        expect(context.executeSlashCommandsWithOptions).not.toHaveBeenCalled();
        expect(textarea.value).toBe('make the reply more suspicious');
    });

    test('empty regeneration submits the ordinary workflow without a guide', async () => {
        context.chat.push({ name: 'Bot', mes: 'Old reply' });
        textarea.value = '  ';
        workflows.ready = true;
        const { guidedRegenerate } = await import('../public/scripts/extensions/guided-generations/scripts/guidedCorrection.js');
        await guidedRegenerate();
        expect(workflows.submitRoleplayWorkflow).toHaveBeenCalledWith({ name: 'roleplay.correct', intent: {}, page: [] });
        expect(generate).not.toHaveBeenCalled();
    });

    test('switching chats while collecting native prompts does not regenerate in the new chat', async () => {
        context.chatId = 'original';
        context.chat.push({ name: 'Bot', mes: 'Old reply' });
        workflows.ready = true;
        workflows.capturePagePrompts.mockImplementationOnce(async () => {
            context = { ...context, chatId: 'different', chat: [{ name: 'Other', mes: 'Different reply' }] };
            textarea.value = 'Different draft';
            return [];
        });
        const { guidedRegenerate } = await import('../public/scripts/extensions/guided-generations/scripts/guidedCorrection.js');
        await guidedRegenerate();
        expect(workflows.submitRoleplayWorkflow).not.toHaveBeenCalled();
        expect(generate).not.toHaveBeenCalled();
        expect(textarea.value).toBe('Different draft');
        expect(context.chat[0].mes).toBe('Different reply');
    });

    test('a refused regeneration never falls back or mutates the chat', async () => {
        context.chat.push({ name: 'Bot', mes: 'Old reply' });
        workflows.ready = true;
        workflows.submitRoleplayWorkflow.mockRejectedValueOnce(new Error('The chat changed.'));
        const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
        const { guidedRegenerate } = await import('../public/scripts/extensions/guided-generations/scripts/guidedCorrection.js');
        await guidedRegenerate();
        quiet.mockRestore();
        expect(generate).not.toHaveBeenCalled();
        expect(context.saveChat).not.toHaveBeenCalled();
        expect(context.executeSlashCommandsWithOptions).not.toHaveBeenCalled();
        expect(context.chat[0].mes).toBe('Old reply');
    });

    test.each([false, true])('browser regeneration excludes the old reply and keeps trailing messages (group=%s)', async group => {
        context.chat.push({ is_user: true, mes: 'Prompt' }, { name: 'Bot', original_avatar: 'bot.png', mes: 'Old reply' },
            { is_user: true, mes: 'Later message' });
        if (group) {
            context.groupId = 'group';
            context.groups = [];
            context.characters = [{ name: 'Bot', avatar: 'bot.png' }];
        }
        textarea.value = 'left | right';
        generate.mockImplementation(async (type, options) => {
            expect(type).toBe('regenerate');
            expect(options).toEqual({ preserveLastMessage: false, ...(group ? { force_chid: 0 } : {}) });
            expect(context.chat).toHaveLength(2);
            expect(textarea.value).toBe(group ? '' : 'left | right');
            context.chat.splice(1, 1, { name: 'Bot', mes: 'Fresh reply' });
        });
        const { guidedRegenerate } = await import('../public/scripts/extensions/guided-generations/scripts/guidedCorrection.js');
        await guidedRegenerate();
        expect(context.chat.map(message => message.mes)).toEqual(['Prompt', 'Fresh reply', 'Later message']);
        expect(context.executeSlashCommandsWithOptions.mock.calls[0][0]).toContain('REGENERATE: left \\| right');
        expect(context.executeSlashCommandsWithOptions).toHaveBeenLastCalledWith('/flushinject gg-guided-regenerate');
        expect(textarea.value).toBe('left | right');
    });

    test.each(['failure', 'cancel'])('browser regeneration restores the old reply after %s', async outcome => {
        context.chat.push({ is_user: true, mes: 'Prompt' }, { name: 'Bot', mes: 'Old reply', swipes: ['Old reply'] });
        generate.mockImplementation(async () => {
            context.chat.pop();
            if (outcome === 'failure') throw new Error('Provider failed');
        });
        const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
        const { guidedRegenerate } = await import('../public/scripts/extensions/guided-generations/scripts/guidedCorrection.js');
        await guidedRegenerate();
        quiet.mockRestore();
        expect(context.chat.map(message => message.mes)).toEqual(['Prompt', 'Old reply']);
        expect(context.saveChat).toHaveBeenCalled();
        expect(context.chatMetadata.script_injects).toEqual({});
    });

    test('regeneration ignores a second click and does not restore into a different chat', async () => {
        context.chatId = 'original';
        context.chat.push({ name: 'Bot', mes: 'Old reply' });
        let finish;
        generate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        const { guidedRegenerate } = await import('../public/scripts/extensions/guided-generations/scripts/guidedCorrection.js');
        const first = guidedRegenerate();
        while (!finish) await new Promise(resolve => setTimeout(resolve, 0));
        await guidedRegenerate();
        const save = context.saveChat;
        context = { ...context, chatId: 'different', chat: [{ name: 'Bot', mes: 'Different reply' }] };
        textarea.value = 'Different draft';
        finish();
        await first;
        expect(generate).toHaveBeenCalledTimes(1);
        expect(save).not.toHaveBeenCalled();
        expect(textarea.value).toBe('Different draft');
        expect(context.chat[0].mes).toBe('Different reply');
    });

    test('regeneration requires an AI reply', async () => {
        context.chat.push({ is_user: true, mes: 'Prompt' });
        const { guidedRegenerate } = await import('../public/scripts/extensions/guided-generations/scripts/guidedCorrection.js');
        await guidedRegenerate();
        expect(generate).not.toHaveBeenCalled();
        expect(context.executeSlashCommandsWithOptions).not.toHaveBeenCalled();
        expect(globalThis.toastr.error).toHaveBeenCalledWith('No AI reply found to replace.', 'Guided Regenerate');
    });

    test('switching chats while isolating a group target keeps the new draft', async () => {
        context.groupId = 'original';
        context.chat.push({ name: 'Bot', mes: 'Old reply' }, { is_user: true, mes: 'Later message' });
        let finish;
        context.redisplayChat.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const { guidedRegenerate } = await import('../public/scripts/extensions/guided-generations/scripts/guidedCorrection.js');
        const pending = guidedRegenerate();
        while (!finish) await new Promise(resolve => setTimeout(resolve, 0));
        context = { ...context, groupId: 'different', chat: [] };
        textarea.value = 'Different draft';
        finish();
        await pending;
        expect(textarea.value).toBe('Different draft');
        expect(generate).not.toHaveBeenCalled();
    });

    test('keeps the target in context and replaces it with the appended correction', async () => {
        const target = {
            name: 'Bot',
            mes: 'Original reply',
            original_avatar: 'bot.png',
            send_date: 10,
            extra: { retained: true, model: 'old' },
            swipes: ['Original reply'],
        };
        const trailingMessage = { is_user: true, mes: 'Later user message' };
        context.chat.push({ is_user: true, mes: 'Prompt' }, target, trailingMessage);
        generate.mockImplementation(async (type, options) => {
            expect(type).toBe('regenerate');
            expect(options).toEqual({ preserveLastMessage: true });
            expect(context.chat).toEqual([expect.any(Object), target]);
            expect(target.mes).toBe('Original reply');
            expect(textarea.value).toBe('make the reply more suspicious');
            context.chat.push({
                name: 'Changed identity',
                mes: 'Corrected reply',
                original_avatar: 'changed.png',
                send_date: 20,
                extra: { model: 'new', generated: true },
                swipes: ['Corrected reply'],
            });
        });

        const { guidedCorrection } = await import('../public/scripts/extensions/guided-generations/scripts/guidedCorrection.js');
        await guidedCorrection();

        expect(context.chat).toEqual([
            expect.objectContaining({ is_user: true, mes: 'Prompt' }),
            target,
            trailingMessage,
        ]);
        expect(target).toEqual(expect.objectContaining({
            name: 'Bot',
            mes: 'Corrected reply',
            original_avatar: 'bot.png',
            send_date: 10,
            extra: { retained: true, model: 'new', generated: true },
            swipes: ['Corrected reply'],
        }));
        expect(context.updateMessageBlock).toHaveBeenCalledWith(1, target);
        expect(eventSource.emit).toHaveBeenNthCalledWith(1, eventTypes.MESSAGE_EDITED, 1);
        expect(eventSource.emit).toHaveBeenNthCalledWith(2, eventTypes.MESSAGE_UPDATED, 1);
        expect(context.deleteMessage).toHaveBeenCalledWith(2, undefined, false);
        expect(context.executeSlashCommandsWithOptions.mock.calls[0][0]).toContain('/inject id=gg-guided-correction position=chat ephemeral=true scan=true depth=2 role=system CORRECT: make the reply more suspicious |');
        expect(context.executeSlashCommandsWithOptions).toHaveBeenLastCalledWith('/flushinject gg-guided-correction');
        expect(textarea.value).toBe('make the reply more suspicious');
    });

    test('clears group input during generation and forces the original speaker', async () => {
        const target = { name: 'Second', mes: 'Original reply', original_avatar: 'second.png' };
        context.groupId = 'group';
        context.characters = [
            { name: 'First', avatar: 'first.png' },
            { name: 'Second', avatar: 'second.png' },
        ];
        context.chat.push({ is_user: true, mes: 'Prompt' }, target);
        generate.mockImplementation(async (type, options) => {
            expect(type).toBe('regenerate');
            expect(options).toEqual({ preserveLastMessage: true, force_chid: 1 });
            expect(textarea.value).toBe('');
            expect(context.chat).toEqual([expect.any(Object), target]);
            context.chat.push({ name: 'Second', mes: 'Corrected group reply' });
        });

        const { guidedCorrection } = await import('../public/scripts/extensions/guided-generations/scripts/guidedCorrection.js');
        await guidedCorrection();

        expect(context.chat).toHaveLength(2);
        expect(context.chat.some(message => message.mes === 'make the reply more suspicious')).toBe(false);
        expect(target.mes).toBe('Corrected group reply');
        expect(textarea.value).toBe('make the reply more suspicious');
        expect(textarea.dispatchEvent).toHaveBeenCalledTimes(2);
    });

    test('a server-owned chat submits the named correction without touching the saved messages', async () => {
        const target = { name: 'Bot', mes: 'Original reply', swipes: ['Original reply'] };
        context.chat.push({ is_user: true, mes: 'Prompt' }, target);
        workflows.ready = true;

        const { guidedCorrection } = await import('../public/scripts/extensions/guided-generations/scripts/guidedCorrection.js');
        await guidedCorrection();

        expect(workflows.submitRoleplayWorkflow).toHaveBeenCalledTimes(1);
        expect(workflows.submitRoleplayWorkflow).toHaveBeenCalledWith({
            name: 'guided.correction',
            intent: { prompt: { text: 'CORRECT: make the reply more suspicious', depth: 2, role: 'system', scan: true } },
            page: [],
        });
        expect(generate).not.toHaveBeenCalled();
        expect(context.executeSlashCommandsWithOptions.mock.calls.map(call => call[0])).toEqual([]);
        expect(context.deleteMessage).not.toHaveBeenCalled();
        expect(context.chat).toEqual([expect.objectContaining({ mes: 'Prompt' }), target]);
        expect(target.mes).toBe('Original reply');
    });

    test('a refused named correction is final and never falls back to a browser generation', async () => {
        context.chat.push({ is_user: true, mes: 'Prompt' }, { name: 'Bot', mes: 'Original reply' });
        workflows.ready = true;
        workflows.submitRoleplayWorkflow.mockRejectedValueOnce(new Error('The chat changed.'));
        const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});

        const { guidedCorrection } = await import('../public/scripts/extensions/guided-generations/scripts/guidedCorrection.js');
        await guidedCorrection();
        quiet.mockRestore();

        expect(workflows.submitRoleplayWorkflow).toHaveBeenCalledTimes(1);
        expect(generate).not.toHaveBeenCalled();
        expect(context.executeSlashCommandsWithOptions.mock.calls.map(call => call[0])).toEqual([]);
        expect(globalThis.toastr.error).toHaveBeenCalledWith('The chat changed.', 'Nothing was generated');
    });

    test('a page prompt addition the server cannot carry keeps the browser correction', async () => {
        context.chat.push({ is_user: true, mes: 'Prompt' }, { name: 'Bot', mes: 'Original reply' });
        workflows.ready = true;
        workflows.capturePagePrompts.mockResolvedValueOnce(null);
        generate.mockImplementation(async () => {
            context.chat.push({ name: 'Bot', mes: 'Browser correction' });
        });

        const { guidedCorrection } = await import('../public/scripts/extensions/guided-generations/scripts/guidedCorrection.js');
        await guidedCorrection();

        expect(workflows.submitRoleplayWorkflow).not.toHaveBeenCalled();
        expect(generate).toHaveBeenCalledTimes(1);
        expect(context.chat[1].mes).toBe('Browser correction');
    });
});
