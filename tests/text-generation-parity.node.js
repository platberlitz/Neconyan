import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createTextProviderParameters } from '../public/scripts/text-provider-parameters.js';
import { providerTypes, providerSettings, providerDependencies, providerDigests, instructSettings, promptMessages, expectedPrompts } from './fixtures/text-generation-baseline.js';
import { constructScopedTextPrompt, createRawPrompt, cleanScopedTextResponse } from '../public/scripts/generation-format.js';

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
