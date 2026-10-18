/* global globalThis */
import { jest } from '@jest/globals';
import * as chevrotain from 'chevrotain';

await jest.unstable_mockModule('../public/lib.js', () => ({ chevrotain }));

const BASE = '../public/scripts/extensions/third-party/MacroEnhanced/src/';
const { createMacroEnvironment, MacroEngine, MacroRegistry } = await import('../src/macros/index.js');
const { applySandboxEnvironment, createSandbox } = await import(`${BASE}workbench/sandbox.js`);
const { compileDef } = await import(`${BASE}custom/compile.js`);

function installContext({ local, globalRoot } = {}) {
    const context = {
        chatMetadata: {},
        extensionSettings: { MacroEnhanced: { settingsVersion: 5, customMacros: [], auditor: { manualCachingAtDepth: null }, compatExpressions: false, fixImportedSyntax: false, pronouns: { personas: {} } } },
        saveMetadataDebounced: jest.fn(),
        saveSettingsDebounced: jest.fn(),
        writeExtensionField: jest.fn(async () => {}),
    };
    if (local !== undefined) {
        context.chatMetadata.variables = local;
    }
    if (globalRoot !== undefined) {
        context.extensionSettings.variables = globalRoot;
    }
    globalThis.SillyTavern = { getContext: () => context };
    return context;
}

function makeSandbox(context) {
    return createSandbox({
        getLocalStore: () => context.chatMetadata?.variables ?? {},
        getGlobalStore: () => context.extensionSettings?.variables?.global ?? {},
        getChatState: () => null,
    });
}

function makeEnvironment(sandbox) {
    const env = createMacroEnvironment({
        names: { user: 'Kris', char: 'Nova' },
        character: {},
        system: {},
        variables: { local: {}, global: {} },
        extra: { powerUser: {}, chatMetadata: {} },
    }, {}, { dynamicMacros: sandbox.dynamicMacros });
    return applySandboxEnvironment(env, sandbox);
}

describe('Macro Enhanced sandbox evaluator', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('applySandboxEnvironment attaches the same copy-on-write stores and keeps other extras', () => {
        const context = installContext();
        const sandbox = makeSandbox(context);
        const env = { extra: { keep: 'yes', variables: { local: {}, global: {} } } };

        expect(applySandboxEnvironment(env, sandbox)).toBe(env);
        expect(env.extra.keep).toBe('yes');
        expect(env.extra.variables.local).toBe(sandbox.local);
        expect(env.extra.variables.global).toBe(sandbox.global);
        expect(env.extra.meSandboxState).toBe(sandbox.chatState);
    });

    test('registry setvar and shorthand read the same store in both directions', () => {
        const context = installContext();
        const sandbox = makeSandbox(context);
        const env = makeEnvironment(sandbox);

        expect(env.evaluate('{{setvar::hp::5}}{{.hp}}')).toBe('5');
        expect(env.evaluate('{{.hp = 6}}{{getvar::hp}}')).toBe('6');
        expect(env.evaluate('{{setvar::hp::7}}{{.hp = 8}}{{getvar::hp}}{{.hp}}{{.hp++}}')).toBe('889');
        expect(env.evaluate('{{.hp = 9}}{{setvar::hp::10}}{{.hp}}')).toBe('10');
    });

    test('local and global inc, add, delete and defaults all share the sandbox', () => {
        const context = installContext();
        const sandbox = makeSandbox(context);
        const env = makeEnvironment(sandbox);

        expect(env.evaluate('{{.hp = 5}}{{.hp++}}{{.hp}}')).toBe('66');
        expect(env.evaluate('{{.hp = 5}}{{.hp += 2}}{{.hp}}')).toBe('7');
        expect(env.evaluate('{{$score = 5}}{{$score++}}{{$score}}')).toBe('66');
        expect(env.evaluate('{{$score = 5}}{{$score += 2}}{{$score}}')).toBe('7');
        expect(env.evaluate('{{.hp = 5}}{{deletevar::hp}}{{.hp}}')).toBe('');
        expect(env.evaluate('{{getvar::missing}}')).toBe('');
        expect(env.evaluate('{{getglobalvar::missing}}')).toBe('');
    });

    test('nested custom macro templates keep the sandbox variable stores', () => {
        const context = installContext();
        const sandbox = makeSandbox(context);
        const env = makeEnvironment(sandbox);
        MacroRegistry.registerMacro('sandboxwrap', compileDef({
            id: 'sandbox-wrap',
            name: 'sandboxwrap',
            description: 'Wraps sandbox variable writes.',
            template: '{{setvar::hp::7}}{{.hp}} / {{.hp = 8}}{{getvar::hp}}',
            args: [],
            enabled: true,
        }, { engine: MacroEngine }));

        expect(env.evaluate('{{sandboxwrap}}')).toBe('7 / 8');
    });

    test('existing variable objects keep their identity and values, and no host setter or save runs', () => {
        const local = { hp: '1' };
        const global = { gold: '2' };
        const globalRoot = { global, other: 'kept' };
        const context = installContext({ local, globalRoot });
        const sandbox = makeSandbox(context);
        const env = makeEnvironment(sandbox);

        expect(env.evaluate('{{setvar::hp::5}}{{.hp = 6}}{{getvar::hp}}{{.hp}}')).toBe('66');
        expect(context.chatMetadata.variables).toBe(local);
        expect(local).toEqual({ hp: '1' });
        expect(context.extensionSettings.variables).toBe(globalRoot);
        expect(globalRoot.global).toBe(global);
        expect(global).toEqual({ gold: '2' });
        expect(globalRoot.other).toBe('kept');
        expect(context.saveMetadataDebounced).not.toHaveBeenCalled();
        expect(context.saveSettingsDebounced).not.toHaveBeenCalled();
        expect(context.writeExtensionField).not.toHaveBeenCalled();
    });

    test('a chat with no variable stores stays without them and still returns the sandbox result', () => {
        const context = installContext();
        const sandbox = makeSandbox(context);
        const env = makeEnvironment(sandbox);

        expect(env.evaluate('{{.hp = 9}}{{.hp}} / {{$gold = 4}}{{$gold}}')).toBe('9 / 4');

        expect('variables' in context.chatMetadata).toBe(false);
        expect('variables' in context.extensionSettings).toBe(false);
        expect(sandbox.pendingChanges().local.get('hp')).toEqual({ before: undefined, after: '9' });
        expect(sandbox.pendingChanges().global.get('gold')).toEqual({ before: undefined, after: '4' });
    });

    test('sandbox.run still keeps its fallback snapshot layer around the evaluated text', () => {
        const context = installContext();
        const sandbox = makeSandbox(context);
        const env = makeEnvironment(sandbox);

        const output = sandbox.run(() => env.evaluate('{{setvar::hp::5}}{{.hp}}'), '{{setvar::hp::5}}{{.hp}}');

        expect(output).toBe('5');
        expect('variables' in context.chatMetadata).toBe(false);
        expect('variables' in context.extensionSettings).toBe(false);
        expect(sandbox.pendingChanges().local.get('hp')).toEqual({ before: undefined, after: '5' });
    });
});
