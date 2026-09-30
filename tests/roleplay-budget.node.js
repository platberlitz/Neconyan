/* eslint playwright/expect-expect: off -- Node assertions exercise prompt budgets. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './roleplay-transactions-fixture.js';
import { resolveChatTokenizerModel, getChatImageTokenCost } from '../public/scripts/chat-prompt-tokens.js';

const { createRoleplayChatCounter } = await import('../src/generation/roleplay-budget.js');
const { countOpenAIChatTokens } = await import('../src/endpoints/tokenizers.js');
const { getCounter } = await import('../src/mewmory/tokens.js');
const { captureGenerationBinding } = await import('../src/generation/profiles.js');
const { createMacroEnvironment } = await import('../src/macros/index.js');
const { runChatProfile } = await import('../src/generation/service.js');
const { admitRoleplayJob } = await import('../src/roleplay-jobs.js');
const { getJob, releaseJob } = await import('../src/jobs/store.js');

test('native chat counting includes role, name and message framing with the bound model', async () => {
    const count = await createRoleplayChatCounter({ source: 'custom', active: { custom_model: 'decoy' }, profile: { model: 'gpt-4o' } });
    const messages = [{ role: 'system', content: 'Rule' }, { role: 'user', name: 'Visitor', content: 'Hello' }];
    assert.equal(await count(messages), await countOpenAIChatTokens('gpt-4o', 'gpt-4o', messages));
    assert.ok(await count(messages) > (await getCounter('o200k_base')).count('Rule\nHello'));
});

test('native chat counting retains tool schema and saved image costs', async () => {
    const image = { url: 'data:image/png;base64,AAAA', width: 512, height: 512 };
    const count = await createRoleplayChatCounter({ source: 'custom', active: {}, profile: { model: 'gpt-4o' } }, { images: [image] });
    const text = { role: 'user', content: 'Look' };
    const rich = { ...text, content: [{ type: 'text', text: text.content }, { type: 'image_url', image_url: { url: image.url, detail: 'low' } }] };
    assert.equal(await count([rich]), await count([text]) + 85);
    const call = { role: 'assistant', tool_calls: [{ id: 'saved-tool', type: 'function', function: { name: 'lookup', arguments: '{"query":"harbour"}' } }] };
    assert.equal(await count([call]), await countOpenAIChatTokens('gpt-4o', 'gpt-4o', [{ ...call, tool_calls: JSON.stringify(call.tool_calls) }]));
    await assert.rejects(count([{ ...rich, content: [{ type: 'image_url', image_url: { url: 'unknown' } }] }]), { code: 'ROLEPLAY_INVALID' });
});

test('cached budget passes remain exact after message edits, removals and model changes', async () => {
    for (const model of ['gpt-4o', 'gpt-4', 'gpt-3.5-turbo-0301']) {
        const count = await createRoleplayChatCounter({ source: 'custom', active: {}, profile: { model } });
        const messages = [{ role: 'system', content: 'Shared rules' }, { role: 'user', name: 'Visitor', content: 'Hello' }];
        for (const change of [() => {}, () => { messages[1].content = 'Changed content'; }, () => { messages.shift(); }]) {
            change();
            assert.equal(await count(messages), await countOpenAIChatTokens(model, model, messages));
            assert.equal(await count(messages), await countOpenAIChatTokens(model, model, messages));
        }
    }
});

test('browser and server tokenizer selection uses the same provider and catalogue rules', () => {
    for (const source of ['openai', 'openai_responses']) assert.equal(resolveChatTokenizerModel({ chat_completion_source: source,
        openai_model: 'gpt-6-astra' }), 'gpt-6-astra');
    assert.equal(resolveChatTokenizerModel({ chat_completion_source: 'custom', custom_model: 'saved-model' }), 'saved-model');
    assert.equal(resolveChatTokenizerModel({ chat_completion_source: 'mistralai', mistralai_model: 'pixtral' }), 'nemo');
    assert.equal(resolveChatTokenizerModel({ chat_completion_source: 'openrouter', openrouter_model: 'saved-model' }, {
        model_list: [{ id: 'saved-model', architecture: { tokenizer: 'Llama3' } }],
    }), 'llama3');
    assert.equal(getChatImageTokenCost({ width: 512, height: 512 }), 85);
    assert.equal(getChatImageTokenCost({ width: 1024, height: 1024 }, 'high'), 765);
});

test('the final custom body is budgeted after saved overrides and before the provider receives it', async t => {
    const f = fixture(t);
    const model = 'gpt-4o';
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({ _settingsRevision: 1,
        main_api: 'openai', active_generation: { api: 'openai', source: 'custom', model },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000', custom_model: model,
            custom_include_body: JSON.stringify({ messages: [{ role: 'user', content: 'Oversized '.repeat(200) }] }) },
        power_user: { custom_stopping_strings: '[]' },
    }));
    const binding = captureGenerationBinding(f.scope.directories, { kind: 'active' }, { settingsRevision: 1 });
    const { jobId } = admitRoleplayJob(f.scope, { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch }, {
        operationKey: 'wire-budget', effect: 'append', source: f.source(),
    });
    releaseJob(f.scope.directories, jobId);
    const jobContext = { ...f.scope, job: getJob(f.scope.directories, jobId), signal: new AbortController().signal };
    const count = await createRoleplayChatCounter({ source: 'custom', active: {}, profile: { model } });
    let calls = 0;
    await assert.rejects(runChatProfile({ context: f.scope, binding, maxTokens: 16, jobContext,
        messages: [{ role: 'user', content: 'Small' }], macroEnvironment: createMacroEnvironment(),
        validatePrompt: async payload => { if (await count(payload.messages) > 100) throw new Error('Prompt budget exceeded'); },
        fetch: async () => {
            calls++;
            return new Response(JSON.stringify({ choices: [{ message: { content: 'Should not run' } }] }));
        },
    }), /Prompt budget exceeded/);
    assert.equal(calls, 0);
    assert.equal(getJob(f.scope.directories, jobId).recoveryStep, null);
    assert.notEqual(getJob(f.scope.directories, jobId).recoverability, 'unknown-outcome');
});
