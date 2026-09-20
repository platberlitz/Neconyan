import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createTextProviderParameters } from '../public/scripts/text-provider-parameters.js';
import { providerTypes, providerSettings, providerDependencies, providerDigests, instructSettings, promptMessages, expectedPrompts } from './fixtures/text-generation-baseline.js';
import { constructScopedTextPrompt, createRawPrompt, cleanScopedTextResponse, cleanGeneratedText, fixGeneratedMarkdown } from '../public/scripts/generation-format.js';

for (const [index, type] of providerTypes.entries()) {
    test(`text provider ${type} preserves the recorded browser request`, () => {
        const payload = createTextProviderParameters({ ...providerSettings, type }, 'fixture-model', 'Prompt', 73, {
            ...providerDependencies, resolveStoppingStrings: () => providerDependencies.stoppingStrings,
        });
        assert.equal(createHash('sha256').update(JSON.stringify(payload)).digest('hex'), providerDigests[index]);
        assert.equal(payload.max_tokens, 73);
        assert.equal(payload.max_new_tokens, 73);
        assert.equal(payload.api_server, providerDependencies.apiServer);
    });
}

test('scoped and raw prompts preserve their distinct recorded browser formats', () => {
    const options = { instruct: instructSettings, name1: 'Sam', name2: 'Ada', substitute: providerDependencies.substitute };
    assert.equal(constructScopedTextPrompt(structuredClone(promptMessages), instructSettings, options), expectedPrompts.scoped);
    assert.equal(createRawPrompt(structuredClone(promptMessages), 'textgenerationwebui', false, true, ' Story {{char}} ', ' {{user}} ', options), expectedPrompts.raw);
    assert.equal(createRawPrompt(structuredClone(promptMessages), 'textgenerationwebui', true, false, ' Story {{char}} ', ' {{user}} ', options), expectedPrompts.plain);
    assert.deepEqual(createRawPrompt(structuredClone(promptMessages), 'openai', false, false, ' Story {{char}} ', ' {{user}} ', options), expectedPrompts.chat);
    assert.equal(constructScopedTextPrompt([{ role: 'assistant', content: 'untouched', ignoreInstruct: true }], instructSettings, options), 'untouched');
    assert.equal(cleanScopedTextResponse('<last>Answer   \nnext<sto', ['<stop>'], instructSettings), 'Answer\nnext');
    assert.equal(cleanScopedTextResponse('Answer<stop>leaked text', [], instructSettings), 'Answer');
});

test('stateful macro evaluation retains the browser call order', () => {
    const calls = [];
    let state = 0;
    const payload = createTextProviderParameters({ ...providerSettings, type: 'ooba', dry_sequence_breakers: '["set"]', negative_prompt: 'read' }, 'model', 'Prompt', 73, {
        ...providerDependencies,
        substitute(value) {
            calls.push(value);
            if (value === 'set') state = 1;
            return String(state);
        },
        resolveStoppingStrings() {
            calls.push('stop');
            return [String(state++)];
        },
    });
    assert.deepEqual(calls, ['set', 'stop', 'stop', 'read', 'stop']);
    assert.deepEqual(payload.stopping_strings, ['1']);
    assert.deepEqual(payload.stop, ['2']);
    assert.equal(payload.negative_prompt, '3');
});

test('raw cleanup preserves names, instruct boundaries, group trimming and markdown spacing', () => {
    const options = { power: { instruct: { ...instructSettings, sequences_as_stop_strings: true }, collapse_newlines: true,
        auto_fix_generated_markdown: true, trim_spaces: true }, mainApi: 'textgenerationwebui', name1: 'Sam', name2: 'Ada',
    groupNames: ['Ada', 'Kit (guest)'], displayIncompleteSentences: true };
    assert.equal(cleanGeneratedText(' Ada: * hello *  \n\nnext<stop>discard', options), 'Ada: *hello*\nnext');
    assert.equal(cleanGeneratedText('Ada: * hello *  \n\nnext<stop>discard', options), '*hello*\nnext');
    assert.equal(cleanGeneratedText('Sam: wrong speaker', options), '');
    assert.equal(cleanGeneratedText('Answer\nSam: wrong speaker', options), 'Answer');
    assert.equal(cleanGeneratedText('Answer\nKit (guest): another speaker', options), 'Answer');
    assert.equal(cleanGeneratedText('Answer\nKit (guest): another speaker', { ...options, power: { ...options.power, disable_group_trimming: true } }), 'Answer\nKit (guest): another speaker');
    assert.equal(cleanGeneratedText('Answer<|endoftext|>discard', options), 'Answer');
    assert.equal(cleanGeneratedText('Answer<user {{name}}>discard', options), 'Answer');
    assert.equal(cleanGeneratedText('<last>Answer', options), 'Answer');
    assert.equal(cleanGeneratedText(' partial ', { ...options, reasoningPrefix: 'open' }), ' partial');
    assert.equal(cleanGeneratedText('Sam: Answer\nAda: wrong', { ...options, isImpersonate: true }), 'Answer');
    assert.equal(fixGeneratedMarkdown('A * broken * and ** bold ** then *unfinished'), 'A *broken* and **bold** then *unfinished');
});
