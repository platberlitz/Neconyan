/* global globalThis */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';
import { createRawPrompt } from '../public/scripts/generation-format.js';
import { SCRATCHPAD_MACRO_GUIDANCE, scratchpadMacroEnvironment } from '../src/scratchpad/macros.js';
import { createMacroEnvironment, MacroRegistry } from '../src/macros/index.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { buildScratchpadMessages, buildScratchpadSystemPrompt } = await import('../src/scratchpad/prompt.js');

test('all Scratchpad assistants receive literal reusable-content guidance, including custom prompts and round tables', () => {
    for (const assistant of ['miso', 'taro', 'nori']) {
        for (const customPrompt of [undefined, 'Be a concise card editor.']) {
            const { text } = buildScratchpadSystemPrompt({ assistant, userName: 'Kris', characterName: 'Nova',
                participants: ['miso', 'taro', 'nori'], customPrompt });
            assert.ok(text.includes(SCRATCHPAD_MACRO_GUIDANCE));
            assert.ok(text.includes('{{char}} holds the door for {{user}}.'));
            assert.ok(text.includes('{{Sub}} {{pverb::is::are}} holding {{poss}} coat.'));
            assert.ok(text.includes('{{listpick::opening-weather::sunny, rainy, misty}}'));
            assert.ok(text.includes('{{if {{eq::{{getvar::relationship}}::friend}}}}'));
            assert.ok(text.includes('target IDs and other proposal routing fields concrete'));
            assert.ok(text.includes('Custom macros must be defined or installed before use'));
            if (customPrompt) assert.ok(text.startsWith(customPrompt));
        }
    }
});

test('the suggested Enhanced snippets expand with the installed macros', async t => {
    const base = '../public/scripts/extensions/third-party/MacroEnhanced/src/';
    const { emptyState } = await import(`${base}chat-state.js`);
    const { registerPronounMacros } = await import(`${base}pronoun-macros.js`);
    const { registerStateMacros } = await import(`${base}state-macros.js`);
    const { registerLogicMacros } = await import(`${base}logic-macros.js`);
    const { teardownRegistrations } = await import(`${base}registration.js`);
    const context = { macros: { registry: MacroRegistry }, chatMetadata: { chat_id_hash: 'scratchpad-example' } };
    const previous = globalThis.SillyTavern;
    globalThis.SillyTavern = { getContext: () => context };
    t.after(() => {
        teardownRegistrations();
        if (previous === undefined) delete globalThis.SillyTavern;
        else globalThis.SillyTavern = previous;
    });
    const state = emptyState();
    const env = createMacroEnvironment({ names: { user: 'Kris', char: 'Nova' }, extra: { meSandboxState: state } });
    registerPronounMacros();
    registerStateMacros();
    registerLogicMacros();
    const expand = snippet => {
        assert.ok(SCRATCHPAD_MACRO_GUIDANCE.includes(snippet), 'exercise the actual suggested syntax');
        return env.evaluate(snippet);
    };
    const pronouns = '{{char}} notices {{user}} at the door. {{Sub}} {{pverb::is::are}} holding {{poss}} coat.';
    for (const [spec, sentence] of [['he/him', 'He is holding his coat.'], ['she/her', 'She is holding her coat.'], ['they/them', 'They are holding their coat.']]) {
        state.pronouns.user = spec;
        assert.equal(expand(pronouns), `Nova notices Kris at the door. ${sentence}`);
    }
    const greeting = '{{if {{eq::{{getvar::relationship}}::friend}}}}Welcome back, {{user}}.{{else}}Good evening, stranger.{{/if}}';
    assert.equal(expand(greeting), 'Good evening, stranger.');
    env.extra.variables.local.set('relationship', 'friend');
    assert.equal(expand(greeting), 'Welcome back, Kris.');
    for (const [snippet, expected] of [
        ['{{listpick::opening-weather::sunny, rainy, misty}}', /^(sunny|rainy|misty)$/],
        ['{{freeze::opening-weather::{{random::stormy::misty::clear}}}}', /^(stormy|misty|clear)$/],
        ['{{rollonce::starting-luck::1d20}}', /^([1-9]|1\d|20)$/],
        ['{{sticky::10::mood::{{random::tense::playful::quiet}}}}', /^(tense|playful|quiet)$/],
        ['{{daily::forecast::{{random::sunny::overcast::drizzly}}}}', /^(sunny|overcast|drizzly)$/],
    ]) {
        const result = expand(snippet);
        assert.match(result, expected);
        assert.equal(expand(snippet), result, 'repeated prompt builds keep the selected value');
    }
});

for (const legacy of [false, true]) {
    for (const api of ['textgenerationwebui', 'kobold', 'novel']) {
        test(`${api}, legacy=${legacy}: formatting expands but draft macros and state changes remain literal`, () => {
            const system = buildScratchpadSystemPrompt({ assistant: 'taro', userName: 'Kris', characterName: 'Nova' }).text;
            const context = 'Card draft: {{char}} greets {{user}}. {{setvar::relationship::friend}}';
            const text = 'Keep {{sub}} and {{freeze::weather::{{random::rain::sun}}}} in the greeting. {{isMobile}}';
            const messages = buildScratchpadMessages({ system, context, history: [], text });
            const env = scratchpadMacroEnvironment({ user: 'Kris', char: 'Taro' }, messages);
            for (const environment of [env, env.fork(), env.fork().fork()]) {
                const options = { legacy, strictCapabilities: true };
                assert.equal(environment.evaluate('Speaker: {{char}}', options), 'Speaker: Taro');
                const prompt = createRawPrompt(structuredClone(messages), api, false, false, undefined, undefined, {
                    name1: 'Kris', name2: 'Taro',
                    instruct: { enabled: true, input_sequence: 'User: {{user}}\n', output_sequence: 'Assistant: {{char}}\n', wrap: true },
                    substitute: value => environment.evaluate(value, options),
                });
                assert.ok(prompt.includes(SCRATCHPAD_MACRO_GUIDANCE));
                assert.ok(prompt.includes(context));
                assert.ok(prompt.includes(text));
                assert.equal(environment.extra.variables.local.has('relationship'), false);
                assert.equal(environment.extra.characterScope, 'none');
                assert.throws(() => environment.evaluate('Setting: {{isMobile}}', options), /unavailable browser context/,
                    'only message contents are exempt from connection validation');
            }
        });
    }
}
