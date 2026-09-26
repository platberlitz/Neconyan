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
        // Only the routine cleanup of an inject that was never written runs.
        expect(context.executeSlashCommandsWithOptions.mock.calls.map(call => call[0])).toEqual(['/flushinject gg-guided-correction']);
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
        expect(context.executeSlashCommandsWithOptions.mock.calls.map(call => call[0])).toEqual(['/flushinject gg-guided-correction']);
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
