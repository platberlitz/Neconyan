/* global globalThis */
import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import * as chevrotain from 'chevrotain';

await jest.unstable_mockModule('../public/lib.js', () => ({ chevrotain }));

const BASE = '../public/scripts/extensions/third-party/MacroEnhanced/src/';
const { MacroParser } = await import('../public/scripts/macros/engine/MacroParser.js');
const { MacroEngine, MacroRegistry, createMacroEnvironment } = await import('../src/macros/index.js');
const { compileDef } = await import(`${BASE}custom/compile.js`);
const { registerStateMacros } = await import(`${BASE}state-macros.js`);
const { registerUtilityMacros } = await import(`${BASE}utility-macros.js`);
const { registerLogicMacros } = await import(`${BASE}logic-macros.js`);
const { TEMPLATE_PACKS } = await import(`${BASE}templates/index.js`);
const assistantPack = (await import(`${BASE}templates/assistants.js`)).default;

const EXPECTED_NAMES = [
    'misohello',
    'misostarter',
    'misocheer',
    'tarodebug',
    'tarocheck',
    'tarotrim',
    'taropun',
    'noritwist',
    'noriprank',
    'norisense',
    'noridare',
];

const PROSE_LISTS = ['misocheer', 'taropun', 'noritwist', 'norisense', 'noridare'];

function emptyChatState() {
    return {
        version: 3,
        frozen: {},
        sticky: {},
        daily: {},
        rolls: {},
        chatVars: {},
        counters: { userMessages: 0, charMessages: 0, swipes: 0, generations: 0, firstSeenAt: Date.now() },
        customMacros: [],
        pronouns: { user: '', char: '' },
    };
}

function installContext({ chatHash = 'chat-hash-a', state = emptyChatState() } = {}) {
    const context = {
        chatId: 'chat-a',
        chatMetadata: { MacroEnhanced: state, chat_id_hash: chatHash },
        extensionSettings: { MacroEnhanced: {} },
        macros: { registry: MacroRegistry },
        saveMetadataDebounced: jest.fn(),
    };
    globalThis.SillyTavern = { getContext: () => context };
    return context;
}

function makeEnvironment(overrides = {}) {
    const snapshot = {
        names: { user: 'Kris', char: 'Nova' },
        character: {},
        system: { model: 'test-model' },
        variables: { local: { hp: '7' }, global: {} },
        ...overrides,
        extra: {
            chat: [{ is_user: false, mes: 'one two three four' }],
            chatMetadata: {},
            powerUser: {},
            ...(overrides.extra ?? {}),
        },
    };
    return createMacroEnvironment(
        snapshot,
        { getMaxPromptTokens: () => 3000, getMaxContextTokens: () => 4096 },
        { dynamicMacros: {} },
    );
}

function templateFor(name) {
    return assistantPack.macros.find(macro => macro.name === name)?.template ?? '';
}

beforeAll(() => {
    installContext();
    createMacroEnvironment({ variables: { local: {}, global: {} }, extra: { powerUser: {} } }, {}, {});
    registerStateMacros();
    registerUtilityMacros();
    registerLogicMacros();

    for (const macro of assistantPack.macros) {
        MacroRegistry.registerMacro(macro.name, compileDef({
            ...macro,
            id: macro.name,
            enabled: true,
        }, { engine: MacroEngine }));
    }
});

afterEach(() => {
    jest.useRealTimers();
});

describe('the Miso, Taro & Nori template pack', () => {
    test('ships exactly eleven named, editable definitions as one gallery pack', () => {
        expect(TEMPLATE_PACKS).toContain(assistantPack);
        expect(assistantPack.id).toBe('assistants');
        expect(assistantPack.description).toContain('experimental macros');
        expect(assistantPack.description).toContain('browser');
        expect(assistantPack.description).toContain('refuse custom macros');
        expect(assistantPack.macros.map(macro => macro.name)).toEqual(EXPECTED_NAMES);
        expect(new Set(assistantPack.macros.map(macro => macro.name)).size).toBe(EXPECTED_NAMES.length);

        for (const macro of assistantPack.macros) {
            expect(typeof macro.description).toBe('string');
            expect(macro.description.length).toBeGreaterThan(0);
            expect(typeof macro.template).toBe('string');
            expect(macro.template.length).toBeGreaterThan(0);
            expect(Array.isArray(macro.args)).toBe(true);
        }
    });

    test('every template lexes and parses with the real macro parser', () => {
        for (const macro of assistantPack.macros) {
            const errors = MacroParser.parseDocument(macro.template).errors
                .map(error => String(error.message).split('\n')[0]);
            expect({ name: macro.name, errors }).toEqual({ name: macro.name, errors: [] });
        }
    });

    test('every template avoids pipes and argument names that shadow host roles', () => {
        const forbidden = new Set(['char', 'user', 'model']);
        for (const macro of assistantPack.macros) {
            expect({ name: macro.name, pipes: macro.template.includes('|') }).toEqual({ name: macro.name, pipes: false });
            for (const arg of macro.args) {
                expect({ macro: macro.name, arg: arg.name, forbidden: forbidden.has(arg.name) })
                    .toEqual({ macro: macro.name, arg: arg.name, forbidden: false });
            }
        }
    });

    test('every macro named in a template is registered', () => {
        for (const macro of assistantPack.macros) {
            const names = [...macro.template.matchAll(/\{\{(?!\/)([A-Za-z][\w-]*)/g)].map(match => match[1]);
            const argumentNames = new Set(macro.args.map(arg => arg.name));
            for (const name of names) {
                const registered = MacroRegistry.hasMacro(name) || argumentNames.has(name);
                expect({ macro: macro.name, name, registered })
                    .toEqual({ macro: macro.name, name, registered: true });
            }
        }
    });

    test('misohello greets the persona with the real time of day', () => {
        jest.useFakeTimers();
        const env = makeEnvironment();

        jest.setSystemTime(new Date(2026, 0, 1, 9, 0, 0));
        expect(env.evaluate('{{misohello}}')).toBe('Good morning, Kris. I hope the day is being kind to you so far.');

        jest.setSystemTime(new Date(2026, 0, 1, 14, 0, 0));
        expect(env.evaluate('{{misohello}}')).toBe('Good afternoon, Kris. How is the day treating you?');

        jest.setSystemTime(new Date(2026, 0, 1, 19, 0, 0));
        expect(env.evaluate('{{misohello}}')).toBe('Good evening, Kris. Ready to unwind?');

        jest.setSystemTime(new Date(2026, 0, 1, 1, 0, 0));
        expect(env.evaluate('{{misohello}}')).toBe('Still awake, Kris? I\'ll keep you company.');
    });

    test('misostarter matches genres case-insensitively and falls back to the general start', () => {
        const env = makeEnvironment();

        expect(env.evaluate('{{misostarter::Romance}}'))
            .toBe('Open on two people who want to speak and choose the wrong words.');
        expect(env.evaluate('{{misostarter::science fiction}}'))
            .toBe('Open on a routine that only makes sense on this world.');
        expect(env.evaluate('{{misostarter::western}}'))
            .toBe('Open in the middle of a scene already in motion, with one concrete detail and one thing left unsaid.');
    });

    test('tarodebug reports only live values and labels the token estimate', () => {
        const env = makeEnvironment({ extra: { chat: [{ is_user: false, mes: '12345678' }] } });

        expect(env.evaluate('{{tarodebug}}')).toBe(
            'Model: test-model; character: Nova; prompt limit: 3000 tokens; context limit: 4096 tokens; '
            + 'last message: about 2 tokens (estimate, roughly 4 characters per token).',
        );
    });

    test('tarocheck reads the host local variable store for existence and value', () => {
        const env = makeEnvironment();

        expect(env.evaluate('{{tarocheck::hp}}')).toBe('Local variable \'hp\' is set to \'7\'.');
        expect(env.evaluate('{{tarocheck::mana}}')).toBe('Local variable \'mana\' is not set in this chat.');
    });

    test('tarotrim compares the last message word count with the word budget', () => {
        const env = makeEnvironment({ extra: { chat: [{ is_user: false, mes: 'one two three four' }] } });

        expect(env.evaluate('{{tarotrim::3}}')).toBe(
            'The last message is 4 words. That is over the 3-word budget: '
            + 'trim repeated description first and keep the action and last line of dialogue.',
        );
        expect(env.evaluate('{{tarotrim::5}}')).toBe(
            'The last message is 4 words. That fits the 5-word budget; keep the next reply just as tight.',
        );
    });

    test('each prose list uses listpick with a semicolon separator and stays stable in a chat', () => {
        const env = makeEnvironment();

        for (const name of PROSE_LISTS) {
            expect({ name, listpick: templateFor(name).includes('{{listpick::'), semicolon: templateFor(name).includes('::;}}') })
                .toEqual({ name, listpick: true, semicolon: true });
            const first = env.evaluate(`{{${name}}}`);
            const second = env.evaluate(`{{${name}}}`);
            expect({ name, first, second }).toEqual({ name, first, second: first });
            expect(first.length).toBeGreaterThan(0);
        }
    });

    test('noriprank uses sticky on a one-turn period and keeps its value across a swipe', () => {
        const context = installContext();
        const env = makeEnvironment();
        const template = templateFor('noriprank');

        expect(template.startsWith('{{sticky::1::nori-prank::{{random::')).toBe(true);

        const first = env.evaluate('{{noriprank}}');
        const swipe = env.evaluate('{{noriprank}}');
        expect(swipe).toBe(first);
        expect(context.chatMetadata.MacroEnhanced.sticky['nori-prank'].atUserCount).toBe(0);

        context.chatMetadata.MacroEnhanced.counters.userMessages = 1;
        env.evaluate('{{noriprank}}');

        expect(context.chatMetadata.MacroEnhanced.sticky['nori-prank'].atUserCount).toBe(1);
    });
});
