/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const BASE = '../public/scripts/extensions/third-party/MacroEnhanced/src/';

function installContext() {
    const state = {
        version: 3,
        frozen: { hp: { value: '7', frozenAt: 1 } },
        sticky: {},
        daily: {},
        rolls: {},
        chatVars: { existing: 'yes' },
        counters: { userMessages: 2, charMessages: 1, swipes: 0, generations: 0, firstSeenAt: 1 },
        customMacros: [],
        pronouns: { user: '', char: '' },
    };
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
        chatMetadata: { MacroEnhanced: state },
        characters: [{ name: 'Ren', data: { extensions: {} } }],
        characterId: 0,
        saveSettingsDebounced: jest.fn(),
        saveMetadataDebounced: jest.fn(),
        writeExtensionField: jest.fn(async () => {}),
    };
    globalThis.SillyTavern = { getContext: () => context };
    return { context, state };
}

function macroContext(args, env = {}) {
    return {
        unnamedArgs: args,
        resolve: value => String(value ?? ''),
        warn: jest.fn(),
        raw: '',
        env,
    };
}

describe('Macro Enhanced state packs honour read-only previews and the sandbox', () => {
    let context;
    let state;
    let withReadOnlyVariables;
    let handlers;
    let pronounMacros;
    let stateMacros;
    let chatVarMacros;
    let chatState;

    beforeEach(async () => {
        jest.resetModules();
        ({ context, state } = installContext());
        ({ withReadOnlyVariables } = await import('../public/scripts/variable-read-only.js'));
        stateMacros = await import(`${BASE}state-macros.js`);
        chatVarMacros = await import(`${BASE}chatvar-macros.js`);
        pronounMacros = await import(`${BASE}pronoun-macros.js`);
        chatState = await import(`${BASE}chat-state.js`);
        handlers = new Map();
        const register = (name, options) => {
            handlers.set(name, options);
            return name;
        };
        stateMacros.registerStateMacros(register);
        chatVarMacros.registerChatVarMacros(register);
        pronounMacros.registerPronounMacros(register);
    });

    function invoke(name, args, env = {}) {
        const definition = handlers.get(name);
        expect(definition).toBeDefined();
        return definition.handler(macroContext(args, env));
    }

    test('a preview reads real values but stores nothing and saves nothing', () => {
        withReadOnlyVariables(() => {
            expect(invoke('freeze', ['hp', 'ignored'])).toBe('7');
            expect(invoke('freeze', ['mood', 'tense'])).toBe('tense');
            expect(state.frozen.mood).toBeUndefined();
        });

        expect(context.saveMetadataDebounced).not.toHaveBeenCalled();
        expect(state.frozen.hp.value).toBe('7');
    });

    test('sequenced writes inside one read-only build are visible to later macros, then vanish', () => {
        withReadOnlyVariables(() => {
            invoke('setchatvar', ['fresh', '1']);
            expect(invoke('getchatvar', ['fresh', 'fallback'])).toBe('1');
            invoke('addchatvar', ['fresh', '2']);
            expect(invoke('getchatvar', ['fresh', 'fallback'])).toBe('3');
        });

        expect(state.chatVars.fresh).toBeUndefined();
        expect(state.chatVars.existing).toBe('yes');
        expect(context.saveMetadataDebounced).not.toHaveBeenCalled();
    });

    test('a preview setpronouns changes a throwaway copy and fires no notice', () => {
        const heard = [];
        pronounMacros.onPronounsChanged(({ subject }) => heard.push(subject));

        withReadOnlyVariables(() => {
            invoke('setpronouns', ['she/her']);
            expect(invoke('sub', [])).toBe('she');
        });

        expect(state.pronouns.user).toBe('');
        expect(heard).toEqual([]);
        expect(context.saveMetadataDebounced).not.toHaveBeenCalled();
    });

    test('the real call outside read-only still writes, saves and announces', () => {
        const heard = [];
        pronounMacros.onPronounsChanged(({ subject }) => heard.push(subject));

        expect(invoke('setpronouns', ['he/him'])).toBe('');
        expect(state.pronouns.user).toBe('he/him');
        expect(heard).toEqual(['user']);
        expect(context.saveMetadataDebounced).toHaveBeenCalledTimes(1);

        invoke('setchatvar', ['live', '3']);
        expect(state.chatVars.live).toBe('3');
        expect(context.saveMetadataDebounced).toHaveBeenCalledTimes(2);
    });

    test('the Playground overlay wins over both live state and read-only previews', () => {
        const overlay = chatState.emptyState();
        const env = { extra: { meSandboxState: overlay } };

        invoke('setchatvar', ['boxed', '2'], env);
        invoke('freeze', ['sandboxed', 'value'], env);
        invoke('setpronouns', ['it/its'], env);

        expect(overlay.chatVars.boxed).toBe('2');
        expect(overlay.frozen.sandboxed.value).toBe('value');
        expect(overlay.pronouns.user).toBe('it/its');
        expect(state.chatVars.boxed).toBeUndefined();
        expect(state.frozen.sandboxed).toBeUndefined();
        expect(state.pronouns.user).toBe('');
        expect(context.saveMetadataDebounced).not.toHaveBeenCalled();

        withReadOnlyVariables(() => {
            invoke('setchatvar', ['readonly', '4'], env);
        });
        expect(overlay.chatVars.readonly).toBe('4');
        expect(state.chatVars.readonly).toBeUndefined();
    });
});
