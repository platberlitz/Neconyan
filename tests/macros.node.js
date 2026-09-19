import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMacroEnvironment, MacroRegistry, evaluateLegacyMacros } from '../src/macros/index.js';
import { modern, legacy } from './fixtures/macro-baseline.js';

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
