/* eslint playwright/expect-expect: off -- Node assertions exercise saved input policies. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';
import { supportsChatImages, supportsChatTools, supportsChatSignatures, selectToolHistoryReasoning } from '../public/scripts/chat-input-capabilities.js';

const { prepareRoleplayCapabilities } = await import('../src/generation/roleplay-capabilities.js');
const { admitRoleplayJob } = await import('../src/roleplay-jobs.js');
const { getJob } = await import('../src/jobs/store.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');
const { buildRoleplaySavedHistory } = await import('../src/generation/roleplay-prompt.js');

test('selected model input capabilities are saved once without unrelated catalogue fields', async t => {
    const f = fixture(t);
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'capabilities', effect: 'append', source: f.source() });
    const context = { ...f.scope, job: getJob(f.scope.directories, jobId), signal: new AbortController().signal };
    const material = { source: 'openrouter', profile: { model: 'vendor/vision' }, active: { media_inlining: true, function_calling: true } };
    const binding = { profileId: 'saved', fingerprint: 'bound' };
    let calls = 0;
    const options = { fetchModels: async () => {
        calls++;
        return [{ id: 'other', secret: 'DO-NOT-SAVE' }, { id: 'vendor/vision', secret: 'DO-NOT-SAVE',
            architecture: { input_modalities: ['text', 'image'], tokenizer: 'Llama3', private: 'DO-NOT-SAVE' },
            metadata: { vision: true, private: 'DO-NOT-SAVE' }, supported_parameters: ['tools'] }];
    } };
    const first = await prepareRoleplayCapabilities(context, material, binding, options);
    assert.equal(supportsChatImages(first.settings, { model_list: first.models }), true);
    assert.equal(supportsChatTools(first.settings, material.profile.model, { model_list: first.models }), true);
    assert.deepEqual(await prepareRoleplayCapabilities(context, material, binding, options), first);
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(readArtifact(f.scope.directories, jobId, 'roleplay-model-capabilities')), /DO-NOT-SAVE/);
    await assert.rejects(prepareRoleplayCapabilities(context, material, { ...binding, fingerprint: 'changed' }, options),
        { code: 'ROLEPLAY_RECOVERY_REQUIRED' });
    assert.equal(calls, 1);
});

test('saved signatures are forwarded only to the matching capable API and model', () => {
    const records = [{ user_name: 'User' }, { name: 'Nova', is_user: false, mes: 'Reply',
        extra: { api: 'makersuite', model: 'gemini-2.5-pro', reasoning_signature: 'signature' } }];
    const policy = { source: 'makersuite', model: 'gemini-2.5-pro', include: true };
    assert.equal(supportsChatSignatures({ chat_completion_source: 'makersuite' }), true);
    assert.equal(buildRoleplaySavedHistory(records, { signaturePolicy: policy })[0].signature, 'signature');
    assert.equal(buildRoleplaySavedHistory(records, { signaturePolicy: { ...policy, model: 'different' } })[0].signature, undefined);
    assert.equal(buildRoleplaySavedHistory(records, { signaturePolicy: { ...policy, include: false } })[0].signature, undefined);
});

test('completed tool history survives a model change while provider-bound signatures do not', () => {
    const records = [{ user_name: 'User' }, { name: 'System', is_user: false, is_system: true, mes: 'Tools', mewmory_id: 'tool-row',
        extra: { api: 'makersuite', model: 'previous-model', tool_invocations: [
            { id: 'call-1', name: 'lookup', parameters: '{}', result: 'Known result', signature: 'old-signature' },
        ] } }];
    const result = buildRoleplaySavedHistory(records, { toolHistory: true,
        signaturePolicy: { source: 'openai', model: 'gpt-4o', include: false } });
    assert.equal(result[0].tool_calls[0].signature, undefined);
    assert.equal(result[1].content, 'Known result');
    assert.equal(records[1].extra.tool_invocations[0].signature, 'old-signature');
});

test('tool reasoning stops at the same chain and user boundaries in browser and native prompts', () => {
    const messages = [{ role: 'user', content: 'Question' }, { role: 'assistant', content: 'Plan', reasoning: 'Earlier thought' },
        { role: 'assistant', content: 'Latest text', reasoning: '' }, { role: 'assistant', invocations: [] },
        { role: 'tool', content: 'Result' }, { role: 'assistant', invocations: [] }];
    assert.equal(selectToolHistoryReasoning(messages, 5, 0, 'active_chain'), '');
    assert.equal(selectToolHistoryReasoning(messages, 5, 0, 'since_last_user'), 'Earlier thought');
    assert.equal(selectToolHistoryReasoning(messages, 5, 4, 'since_last_user'), '');
});

test('solo saved history honours content names and explicit send-as avatars', () => {
    const records = [{ user_name: 'User' }, { name: 'User', is_user: true, mes: 'Question' },
        { name: 'Other', is_user: false, force_avatar: 'avatar.png', mes: 'Answer' },
        { name: 'Narrator', is_user: false, mes: 'Rain', extra: { type: 'narrator' } }];
    assert.deepEqual(buildRoleplaySavedHistory(records, { namesBehavior: 2 }).map(message => message.content),
        ['User: Question', 'Other: Answer', 'Rain']);
    assert.deepEqual(buildRoleplaySavedHistory(records, { namesBehavior: 0 }).map(message => message.content),
        ['Question', 'Other: Answer', 'Rain']);
});
