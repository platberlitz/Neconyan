import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMacroEnvironment, MacroRegistry, evaluateLegacyMacros } from '../src/macros/index.js';
import { modern, legacy } from './fixtures/macro-baseline.js';
import { capturedBrowserMacros } from '../src/macros/browser-only.js';

function snapshot(user = 'User') {
    return {
        content: '', names: { user, char: 'Char', group: 'Char', groupNotMuted: 'Char', notChar: user },
        character: { description: 'D', firstMessage: 'Hi', alternateGreetings: ['Alt'] }, system: { model: 'test-model' },
        variables: { local: {}, global: {} }, original: 'original',
        extra: {
            chatMetadata: { chat_id_hash: 12345 }, chat: [], bannedWords: [], mainApi: 'textgenerationwebui', extensionPrompts: {},
            powerUser: { instruct: { enabled: true, input_sequence: 'USER:' }, sysprompt: { enabled: true, content: 'SYS' }, context: { example_separator: 'SEP', chat_start: 'START' } },
            generationState: { lastGenerationType: user },
        },
    };
}
const capabilities = {
    getCurrentChatId: () => 'chat', getInput: () => 'input', getMaxPromptTokens: () => 1000,
    getMaxContextTokens: () => 1300, getMaxResponseTokens: () => 300, getFirstDisplayedMessageId: () => null,
    isMobile: () => false, findExtension: () => ({ enabled: true }), populateEnv: () => {},
};

test('strict server hosts reject the extension vocabulary in modern and legacy prompts', () => {
    const env = createMacroEnvironment(snapshot());
    for (const legacy of [false, true]) {
        for (const input of ['{{switch::x::x=yes::default=no}}', '{{getchatvar::n_yseult}}', '{{setchatvar::n_yseult::1}}',
            '{{usermsgcount}}', '{{ME-UPPER::x}}', '{{chatvarexists::x}}', '{{if::1}}{{freeze::key}}x{{/freeze}}{{/if}}']) {
            assert.throws(() => env.evaluate(input, { legacy, strictCapabilities: true }), { code: 'MACRO_BROWSER_ONLY', status: 409 }, input);
        }
    }
    assert.equal(env.evaluate('{{user}} / {{char}} / {{reverse::abc}}', { strictCapabilities: true }), 'User / Char / cba');
    assert.equal(env.evaluate('{{// {{getchatvar::x}} }}', { strictCapabilities: true }), '');
    assert.equal(MacroRegistry.hasMacro('switch'), false);
    for (const condition of ['usermsgcount', '!usermsgcount', '{{reverse::tnuocgsmresu}}']) {
        assert.throws(() => env.evaluate(`{{if::${condition}}}yes{{/if}}`, { strictCapabilities: true }), { code: 'MACRO_BROWSER_ONLY' });
    }
});

test('custom vocabulary and syntax settings stay private while server lore overrides remain available', () => {
    const browserMacros = capturedBrowserMacros({ MacroEnhanced: { customMacros: [{ name: 'privateGreeting', enabled: true }] } }, {}, {});
    const env = createMacroEnvironment({ ...snapshot(), browserMacros }, {}, { dynamicMacros: {
        lore: { unnamedArgs: [{ name: 'entry' }, { name: 'book' }], handler: () => 'Saved lore' },
    } });
    assert.throws(() => env.evaluate('{{privateGreeting}}', { strictCapabilities: true }), { code: 'MACRO_BROWSER_ONLY' });
    assert.equal(createMacroEnvironment().evaluate('{{privateGreeting}}', { strictCapabilities: true }), '{{privateGreeting}}');
    assert.equal(env.evaluate('{{lore::book::key}}', { strictCapabilities: true }), 'Saved lore');
    for (const [setting, input] of [['compatExpressions', '{{if::1 > 0}}yes{{/if}}'], ['fixImportedSyntax', '{{@name}}']]) {
        const syntax = createMacroEnvironment({ browserMacroSyntax: { [setting]: true } });
        assert.throws(() => syntax.evaluate(input, { strictCapabilities: true }), { code: 'MACRO_BROWSER_ONLY' });
    }
});

test('page-captured bundled macros resolve from the snapshot, survive forks, and refuse when missing', () => {
    const captured = createMacroEnvironment({ ...snapshot(), dynamicMacros: { dialoguecolors: 'INSTRUCTION' } });
    assert.equal(captured.evaluate('before {{dialoguecolors}} after', { strictCapabilities: true }), 'before INSTRUCTION after');
    assert.equal(captured.fork().evaluate('{{dialoguecolors}}', { strictCapabilities: true }), 'INSTRUCTION');
    for (const legacy of [false, true]) {
        const env = createMacroEnvironment({ ...snapshot(), writableScopes: ['local'], dynamicMacros: { dialoguecolors: 'INSTRUCTION' } });
        assert.equal(env.evaluate('{{dialoguecolors}}', { strictCapabilities: true, legacy }), 'INSTRUCTION');
    }
    const empty = createMacroEnvironment({ ...snapshot(), dynamicMacros: { dialoguecolors: '' } });
    assert.equal(empty.evaluate('[{{dialoguecolors}}]', { strictCapabilities: true }), '[]');
    assert.equal(createMacroEnvironment({ ...snapshot(), writableScopes: ['local'] })
        .evaluate('{{unrelatedunknown}}', { strictCapabilities: true }), '{{unrelatedunknown}}');
});

test('a missing bundled capture stays literal in generic strict hosts and refuses only in an opted-in Roleplay snapshot', () => {
    for (const legacy of [false, true]) {
        // Generic strict evaluation, including a saved Roleplay-shaped snapshot such as Prompting Lab or a manual Agent.
        for (const generic of [createMacroEnvironment(snapshot()), createMacroEnvironment({ ...snapshot(), writableScopes: ['local'] })]) {
            assert.equal(generic.evaluate('x {{dialoguecolors}} y', { legacy, strictCapabilities: true }), 'x {{dialoguecolors}} y');
            assert.equal(generic.fork().evaluate('{{dialoguecolors}}', { legacy, strictCapabilities: true }), '{{dialoguecolors}}');
        }
        const missing = createMacroEnvironment({ ...snapshot(), writableScopes: ['local'], requireBundledMacros: true });
        assert.throws(() => missing.evaluate('x {{dialoguecolors}} y', { legacy, strictCapabilities: true }),
            { code: 'MACRO_BUNDLED_MISSING', status: 409 });
        assert.throws(() => missing.fork().evaluate('{{DialogueColors}}', { legacy, strictCapabilities: true }),
            { code: 'MACRO_BUNDLED_MISSING' });
        // A comment never asks for the instruction.
        assert.doesNotThrow(() => missing.evaluate('{{// {{dialoguecolors}} }}ok', { legacy, strictCapabilities: true }));
    }
    assert.equal(createMacroEnvironment({ ...snapshot(), requireBundledMacros: true })
        .evaluate('{{// {{dialoguecolors}} }}ok', { strictCapabilities: true }), 'ok');
    const missing = createMacroEnvironment({ ...snapshot(), writableScopes: ['local'], requireBundledMacros: true });
    for (const input of ['{{if::dialoguecolors}}yes{{/if}}', '{{reverse::{{dialoguecolors}}}}', '{{setvar::k::{{dialoguecolors}}}}']) {
        assert.throws(() => missing.evaluate(input, { strictCapabilities: true }), { code: 'MACRO_BUNDLED_MISSING' }, input);
    }
    // A placeholder produced at run time is refused too, not sent literally.
    const produced = createMacroEnvironment({ ...snapshot(), writableScopes: ['local'], requireBundledMacros: true,
        variables: { local: { held: '{{dialoguecolors}}' }, global: {} } });
    assert.throws(() => produced.evaluate('{{getvar::held}}', { strictCapabilities: true }), { code: 'MACRO_BUNDLED_MISSING' });
    // A nested evaluation that a handler swallows still fails the outer operation.
    const nested = createMacroEnvironment({ writableScopes: ['local'], requireBundledMacros: true }, {}, { dynamicMacros: {
        inner: () => { try { return nested.evaluate('{{dialoguecolors}}', { strictCapabilities: true }); } catch { return 'swallowed'; } },
    } });
    assert.throws(() => nested.evaluate('{{inner}}', { strictCapabilities: true }), { code: 'MACRO_BUNDLED_MISSING' });
    // With the capture, the opted-in snapshot resolves it, explicit empty included.
    const captured = createMacroEnvironment({ ...snapshot(), requireBundledMacros: true, dynamicMacros: { dialoguecolors: '' } });
    assert.equal(captured.fork().evaluate('[{{if::dialoguecolors}}y{{/if}}{{dialoguecolors}}]', { strictCapabilities: true }), '[y]');
});

test('Roleplay variable policy refuses unsaveable writes, including read-only forks', () => {
    const state = { ...snapshot(), writableScopes: ['local'] };
    const env = createMacroEnvironment(state);
    assert.equal(env.evaluate('{{setvar::weather::rain}}{{getvar::weather}}', { strictCapabilities: true }), 'rain');
    assert.throws(() => env.evaluate('{{setglobalvar::weather::rain}}', { strictCapabilities: true }), { code: 'MACRO_WRITE_UNSUPPORTED' });
    for (const legacy of [false, true]) {
        const readOnly = createMacroEnvironment(state, {}, { readOnly: true }).fork();
        assert.throws(() => readOnly.evaluate('{{setvar::weather::rain}}', { strictCapabilities: true, legacy }), { code: 'MACRO_WRITE_UNSUPPORTED' });
        assert.equal(readOnly.extra.variables.local.get('weather'), '');
    }
});

test('nested dynamic evaluation cannot swallow a server macro policy error', () => {
    const env = createMacroEnvironment({ writableScopes: ['local'] }, {}, { dynamicMacros: {
        nested: () => env.evaluate('{{setglobalvar::x::1}}', { strictCapabilities: true }),
        innocent: () => env.evaluate('{{user}}'),
    } });
    assert.throws(() => env.evaluate('{{nested}}{{innocent}}', { strictCapabilities: true }), { code: 'MACRO_WRITE_UNSUPPORTED' });
    assert.equal(env.evaluate('{{setvar::x::ok}}{{getvar::x}}', { strictCapabilities: true }), 'ok');
});
function evaluate(input, env) {
    return env.evaluate(input);
}
function legacyEnv() { return { user: 'User', char: 'Char', group: 'Char', obj: { x: 1 }, 'a.b': 'literal' }; }

test('shared evaluator matches historical browser bytes and variable mutations', () => {
    const env = createMacroEnvironment(snapshot(), capabilities);
    for (const [input, output] of modern) assert.equal(evaluate(input, env), output, input);
    assert.equal(env.extra.variables.local.get('probe'), 3);
    for (const [input, output] of legacy) assert.equal(evaluateLegacyMacros(input, legacyEnv(), env.extra), output, input);
    assert.equal(env.extra.variables.local.get('probe'), 16);
});

test('two overlapping accounts retain private variables, metadata, state and callbacks', async () => {
    const a = snapshot('Alice');
    const b = snapshot('Bob');
    a.extra.chatMetadata = {};
    b.extra.chatMetadata = {};
    const pristine = structuredClone([a, b]);
    const aWrites = [], bWrites = [], hashes = [];
    const envB = createMacroEnvironment(b, capabilities, { onVariableChange: write => bWrites.push(write), onMetadataChange: write => hashes.push(['B', write]) });
    const envA = createMacroEnvironment(a, capabilities, {
        onVariableChange: write => aWrites.push(write), onMetadataChange: write => hashes.push(['A', write]),
        dynamicMacros: { nested: () => evaluate('{{user}}:{{incvar::counter}}', envB) },
    });
    const count = MacroRegistry.getAllMacros().length;
    const results = await Promise.all([
        Promise.resolve().then(() => evaluate('{{user}}:{{incvar::counter}}/{{nested}}/{{user}}:{{getvar::counter}}', envA)),
        Promise.resolve().then(() => evaluate('{{user}}:{{incvar::counter}}', envB)),
    ]);
    assert.deepEqual(results, ['Alice:1/Bob:1/Alice:1', 'Bob:2']);
    assert.equal(evaluate('{{lastGenerationType}}/{{incglobalvar::counter}}', envA), 'Alice/1');
    assert.equal(evaluate('{{lastGenerationType}}/{{getglobalvar::counter}}', envB), 'Bob/');
    evaluate('{{banned::A}}{{pick::only}}', envA);
    evaluate('{{banned::B}}{{pick::only}}', envB);
    assert.deepEqual(envA.extra.bannedWords, ['A']);
    assert.deepEqual(envB.extra.bannedWords, ['B']);
    assert.equal(aWrites.length, 2);
    assert.equal(bWrites.length, 2);
    assert.deepEqual(hashes.map(([account]) => account), ['A', 'B']);
    assert.deepEqual([a, b], pristine);
    assert.equal(MacroRegistry.getAllMacros().length, count);
});

test('captured environments select historical legacy behaviour without changing modern defaults', () => {
    const env = createMacroEnvironment(snapshot(), capabilities, { dynamicMacros: { obj: { x: 1 }, 'a.b': 'literal' } });
    for (const [input, output] of modern) assert.equal(env.evaluate(input), output, input);
    for (const [input, output] of legacy) assert.equal(env.evaluate(input, { legacy: true }), output, input);
    assert.equal(env.extra.variables.local.get('probe'), 16);
    assert.equal(env.evaluate('{{description}}/{{model}}/{{original}}/{{original}}', { legacy: true }), 'D/test-model/original/');
});

test('legacy mobile macros use the captured capability or refuse it explicitly', () => {
    const options = { legacy: true, strictCapabilities: true };
    assert.throws(() => createMacroEnvironment().evaluate('{{isMobile}}', options), /unavailable browser context/);
    assert.equal(createMacroEnvironment({}, { isMobile: () => true }).evaluate('{{isMobile}}', options), 'true');
    assert.equal(createMacroEnvironment({}, { isMobile: () => false }).evaluate('{{isMobile}}', options), 'false');
    assert.equal(createMacroEnvironment().evaluate('{{unknownLegacyValue}}', options), '{{unknownLegacyValue}}');
});

test('persistent sinks survive operations while read-only capture emits no writes', () => {
    const data = snapshot();
    const writes = [];
    const onVariableChange = write => { data.variables[write.scope][write.name] = write.value; writes.push(write); };
    assert.equal(evaluate('{{incvar::counter}}', createMacroEnvironment(data, capabilities, { onVariableChange })), '1');
    assert.equal(evaluate('{{incvar::counter}}', createMacroEnvironment(data, capabilities, { onVariableChange })), '2');
    const env = createMacroEnvironment(data, capabilities, { readOnly: true, onVariableChange });
    assert.equal(evaluate('{{setvar::counter::9}}{{incvar::counter}}{{.counter++}}{{getvar::counter}}', env), '2');
    assert.equal(evaluateLegacyMacros('{{incvar::counter}}{{getvar::counter}}', legacyEnv(), env.extra), '2');
    assert.equal(data.variables.local.counter, 2);
    assert.equal(writes.length, 2);
});

test('all definition categories, arrays, formatted numbers and safe variable keys', () => {
    const env = createMacroEnvironment(snapshot(), capabilities);
    assert.equal(evaluate('{{input}}/{{maxPrompt}}/{{maxContext}}/{{maxResponse}}/{{instructUserPrefix}}/{{systemPrompt}}/{{chatStart}}/{{hasExtension::x}}/{{isMobile}}/{{greeting::1}}', env), 'input/1000/1300/300/USER:/SYS/START/true/false/Alt');
    assert.equal(evaluate('{{setvar::a::007}}{{getvar::a}}', env), '007');
    assert.equal(evaluate('{{setvar::a::[1]}}{{addvar::a::x}}{{getvar::a}}', env), '[1,"x"]');
    assert.equal(evaluate('{{setvar::__proto__::safe}}{{getvar::__proto__}}{{deletevar::__proto__}}{{hasvar::__proto__}}', env), 'safefalse');
    assert.equal(evaluate('{{original}}/{{original}}', env), 'original/');
});

test('legacy keeps instruct aliases, per-replacement processing, nonce and per-pattern catches', () => {
    const env = createMacroEnvironment(snapshot(), capabilities);
    const nonces = [];
    const values = { ...legacyEnv(), f: nonce => { nonces.push(nonce); return '<x>'; }, bad: () => { throw new Error('expected'); } };
    assert.equal(evaluateLegacyMacros('raw {{f}} {{f}} {{char}}', values, env.extra, value => `[${value}]`), 'raw [<x>] [<x>] [Char]');
    assert.equal(nonces.length, 2);
    assert.ok(nonces[0]);
    assert.equal(nonces[0], nonces[1]);
    assert.equal(evaluateLegacyMacros('{{bad}} {{reverse:abc}}', values, env.extra), '{{bad}} cba');
    assert.equal(evaluateLegacyMacros('{{instructInput}}/{{systemPrompt}}/{{chatSeparator}}/{{chatStart}}', values, env.extra), 'USER:/SYS/SEP/START');
});

test('reused environments reset per-string state and default hosts retain historical timestamps', () => {
    const env = createMacroEnvironment(snapshot());
    assert.equal(env.evaluate('{{original}}/{{original}}'), 'original/');
    assert.equal(env.evaluate('{{original}}'), 'original');
    for (const input of ['{{pick::a::b::c}}', 'different {{pick::a::b::c}}']) {
        assert.equal(env.evaluate(input), createMacroEnvironment(snapshot()).evaluate(input));
    }
    const minimal = createMacroEnvironment({ extra: { getInput: () => 'capability' } });
    assert.equal(minimal.evaluate('{{original}}!'), '{{original}}!');
    assert.equal(minimal.evaluate('{{input}}'), 'capability');
    assert.equal(evaluateLegacyMacros('{{char}}/{{input}}/{{pick::only}}', { char: 'Char' }, minimal.extra), 'Char/capability/only');
    assert.equal(minimal.extra.timestampToMoment('2024-07-12@01h31m37s123ms').toISOString(), '2024-07-12T01:31:37.123Z');
});
