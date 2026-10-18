/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const BASE = '../public/scripts/extensions/third-party/MacroEnhanced/src/';

function installContext({ withState = false } = {}) {
    const context = {
        userAvatar: 'me.png',
        extensionSettings: {
            MacroEnhanced: {
                settingsVersion: 5,
                customMacros: [],
                auditor: { manualCachingAtDepth: null },
                compatExpressions: false,
                fixImportedSyntax: false,
                pronouns: { personas: {} },
            },
        },
        chatId: 'chat-1',
        chatMetadata: withState ? { MacroEnhanced: { version: 3, frozen: {}, sticky: {}, daily: {}, rolls: {}, chatVars: {}, counters: {}, customMacros: [], pronouns: { user: '', char: '' } } } : {},
        characters: [{ name: 'Ren', data: { extensions: { MacroEnhanced: { customMacros: [] } } } }],
        characterId: 0,
        saveSettingsDebounced: jest.fn(),
        saveMetadataDebounced: jest.fn(),
        writeExtensionField: jest.fn(async () => {}),
    };
    globalThis.SillyTavern = { getContext: () => context };
    return context;
}

describe('Macro Enhanced reads and the change bus', () => {
    let context;
    let chatState;
    let dataEvents;

    beforeEach(async () => {
        jest.resetModules();
        context = installContext();
        chatState = await import(`${BASE}chat-state.js`);
        dataEvents = await import(`${BASE}data-events.js`);
    });

    test('peekChatState does not create the metadata block', () => {
        expect(chatState.peekChatState()).toBeNull();
        expect(context.chatMetadata).toEqual({});

        const created = chatState.getChatState();
        expect(created).not.toBeNull();
        expect(context.chatMetadata.MacroEnhanced).toBeDefined();
        expect(chatState.peekChatState()).toBe(created);
    });

    test('opening a Playground sandbox creates neither chat nor global variables', async () => {
        const { createSandbox } = await import(`${BASE}workbench/sandbox.js`);
        const sandbox = createSandbox({
            getLocalStore: () => context.chatMetadata?.variables ?? {},
            getGlobalStore: () => context.extensionSettings?.variables?.global ?? {},
            getChatState: () => chatState.peekChatState(),
        });

        expect(sandbox.run(() => 'preview', 'anything')).toBe('preview');
        expect(context.chatMetadata.variables).toBeUndefined();
        expect(context.chatMetadata.MacroEnhanced).toBeUndefined();
        expect(context.extensionSettings.variables).toBeUndefined();
    });

    test('custom macro readers do not create chat state', async () => {
        const store = await import(`${BASE}custom/store.js`);
        expect(store.getChatDefs()).toEqual([]);
        expect(store.getEffectiveDefs()).toEqual([]);
        expect(context.chatMetadata).toEqual({});
    });

    test('touchChatState saves and announces a value change', () => {
        const heard = [];
        dataEvents.onMacroDataChanged(kind => heard.push(kind));

        chatState.getChatState();
        chatState.touchChatState('values');

        expect(context.saveMetadataDebounced).toHaveBeenCalledTimes(1);
        expect(heard).toEqual(['values']);
    });

    test('every custom macro writer announces the macros change', async () => {
        const store = await import(`${BASE}custom/store.js`);
        const heard = [];
        dataEvents.onMacroDataChanged(kind => heard.push(kind));

        store.saveGlobalDefs([]);
        expect(store.getGlobalDefs()).toEqual([]);

        store.saveChatDefs([]);
        expect(chatState.peekChatState()?.customMacros).toEqual([]);

        await store.saveCharacterDefs([]);
        expect(context.writeExtensionField).toHaveBeenCalledWith(0, 'MacroEnhanced', { customMacros: [] });

        expect(heard).toEqual(['macros', 'macros', 'macros']);
        expect(context.saveSettingsDebounced).toHaveBeenCalledTimes(1);
        expect(context.saveMetadataDebounced).toHaveBeenCalledTimes(1);
    });
});
