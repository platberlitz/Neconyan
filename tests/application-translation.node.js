import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { SECRET_KEYS, writeSecret } = await import('../src/endpoints/secrets.js');
const { acceptApplicationOperation, runOperation, listApplicationRecovery, recoverApplicationPublication } = await import('../src/operations/jobs.js');
await import('../src/operations/translation.js');
const { readOperation } = await import('../src/operations/store.js');
const { getJob, updateJob } = await import('../src/jobs/store.js');
const { withRoleplayAccount } = await import('../src/roleplay-store.js');
const { captureRoleplayStorageSourceLocked } = await import('../src/generation/roleplay-source.js');
const { commitSingleChatWriteLocked } = await import('../src/roleplay-lifecycle.js');
const { roleplayNativeHost } = await import('../src/endpoints/chats.js');

function prepared(t, owner = 'fixture') {
    const f = fixture(t, false, owner);
    const base = { owner, directories: f.scope.directories };
    const settings = { extension_settings: { translate: { provider: 'libre', target_language: 'fr', internal_language: 'en', translate_reasoning: true } } };
    fs.writeFileSync(path.join(base.directories.root, 'settings.json'), JSON.stringify(settings));
    writeSecret(base.directories, SECRET_KEYS.LIBRE_URL, 'https://translate.example.test/translate');
    const request = { user: { profile: { handle: owner }, directories: base.directories } };
    const context = job => ({ ...base, job: getJob(base.directories, job.id), signal: new AbortController().signal, progress: async () => {} });
    const chat = () => fs.readFileSync(f.filename, 'utf8').trim().split('\n').map(JSON.parse);
    const edit = (key, change) => withRoleplayAccount(base, null, lease => {
        const captured = captureRoleplayStorageSourceLocked(lease, f.locator);
        const records = structuredClone(captured.saved.records);
        change(records);
        return commitSingleChatWriteLocked(lease, { operationKey: key, mode: 'update', sourceKind: 'storage',
            source: captured.source, records, allowShrink: true, backup: { deferBackup: true } }, roleplayNativeHost);
    });
    return { f, base, settings, request, context, chat, edit };
}
const response = value => new Response(JSON.stringify({ translatedText: value }));

test('reasoning translation and selective clearing update only the selected swipe metadata', async t => {
    const p = prepared(t);
    p.edit('reasoning', records => {
        records[2].extra = { ...records[2].extra, reasoning: 'Because roses grow', display_text: 'Old body translation' };
        records[2].swipe_info[0].extra = { ...records[2].extra, keep: 'Selected note' };
        records[2].swipe_info[1].extra = { display_text: 'Other swipe translation' };
    });
    const before = p.chat()[2];
    const selected = { index: 1, original: before.mes, swipeId: before.swipe_id, reasoning: before.extra.reasoning };
    const accepted = await acceptApplicationOperation(p.request, { key: 'reasoning-only', kind: 'translation', mode: 'message',
        locator: p.f.locator, message: selected, fields: ['reasoning'] });
    let calls = 0;
    await runOperation(p.context(accepted.job), { fetchImpl: async () => { calls++; return response('Raisonnement'); } });
    const row = p.chat()[2];
    assert.equal(row.extra.display_text, 'Old body translation');
    assert.equal(row.swipe_info[0].extra.reasoning_display_text, 'Raisonnement');
    assert.equal(row.swipe_info[0].extra.keep, 'Selected note');
    assert.deepEqual(row.swipe_info[1], before.swipe_info[1]);
    assert.deepEqual(row.swipes, before.swipes);
    const clear = await acceptApplicationOperation(p.request, { key: 'clear-reasoning', kind: 'translation', mode: 'clear',
        locator: p.f.locator, message: selected, fields: ['reasoning'] });
    await runOperation(p.context(clear.job));
    assert.equal(p.chat()[2].extra.reasoning_display_text, undefined);
    assert.equal(p.chat()[2].swipe_info[0].extra.reasoning_display_text, undefined);
    assert.equal(p.chat()[2].extra.display_text, 'Old body translation');
    assert.equal(calls, 1);
});

test('outgoing translation retains the original display and records actual saved-model token counts', async t => {
    const p = prepared(t);
    Object.assign(p.settings, { main_api: 'openai', oai_settings: { chat_completion_source: 'openai', openai_model: 'gpt-4o' },
        power_user: { message_token_count_enabled: true } });
    fs.writeFileSync(path.join(p.base.directories.root, 'settings.json'), JSON.stringify(p.settings));
    const accepted = await acceptApplicationOperation(p.request, { key: 'input', kind: 'translation', mode: 'message', direction: 'input',
        fields: ['body'], locator: p.f.locator, message: { index: 0, original: 'Original', swipeId: null, reasoning: null } });
    await runOperation(p.context(accepted.job), { fetchImpl: async () => response('Translated user message') });
    const row = p.chat()[1];
    assert.equal(row.mes, 'Translated user message');
    assert.equal(row.extra.display_text, 'Original');
    assert.ok(row.extra.token_count > 0);
    assert.equal(row.extra.reasoning_tokens, 0);
    assert.equal(p.chat()[2].mes, 'Answer');
});

test('OneRing free text uses the configured target as its source when translating back', async t => {
    const p = prepared(t);
    p.settings.extension_settings.translate.provider = 'oneringtranslator';
    fs.writeFileSync(path.join(p.base.directories.root, 'settings.json'), JSON.stringify(p.settings));
    writeSecret(p.base.directories, SECRET_KEYS.ONERING_URL, 'https://translate.example.test/translate');
    const accepted = await acceptApplicationOperation(p.request, { key: 'back', kind: 'translation', mode: 'text', text: 'Bonjour', target: 'en' });
    await runOperation(p.context(accepted.job), { fetchImpl: async url => {
        assert.equal(new URL(url).searchParams.get('from_lang'), 'fr');
        assert.equal(new URL(url).searchParams.get('to_lang'), 'en');
        return new Response(JSON.stringify({ result: 'Hello' }));
    } });
    assert.equal(readOperation(p.base, 'back').result.text, 'Hello');
});

test('cancelled local translation publication recovers only from permanent local evidence', async t => {
    const p = prepared(t);
    const accepted = await acceptApplicationOperation(p.request, { key: 'cancelled-local', kind: 'translation', mode: 'chat', locator: p.f.locator });
    await assert.rejects(runOperation(p.context(accepted.job), { fetchImpl: async () => response('Saved'),
        afterTranslationPublication() { throw new Error('Lost write reply'); } }), /Lost write reply/);
    updateJob(p.base.directories, accepted.job.id, job => ({ ...job, state: 'cancelled', recoverySteps: ['keep-uncertainty'],
        cancellation: { requested: true, requestedAt: Date.now(), reason: 'user' } }));
    assert.equal(listApplicationRecovery(p.base)[0].key, 'cancelled-local');
    recoverApplicationPublication(p.base, 'cancelled-local');
    assert.deepEqual(getJob(p.base.directories, accepted.job.id).recoverySteps, ['keep-uncertainty']);
    fs.rmSync(p.f.filename);
    await runOperation(p.context(accepted.job), { fetchImpl: async () => assert.fail('No provider retry') });
    assert.equal(fs.existsSync(p.f.filename), false);
    assert.equal(readOperation(p.base, 'cancelled-local').state, 'completed');
    const unknown = await acceptApplicationOperation(p.request, { key: 'provider-only', kind: 'translation', mode: 'text', text: 'Wait' });
    updateJob(p.base.directories, unknown.job.id, job => ({ ...job, state: 'cancelled' }));
    assert.throws(() => recoverApplicationPublication(p.base, 'provider-only'), /No interrupted local publication/);
});

test('whole-chat translation retains swipes and later messages, and pruning cannot repeat it', async t => {
    const p = prepared(t);
    const body = { key: 'whole-chat', kind: 'translation', mode: 'chat', locator: p.f.locator };
    const accepted = await acceptApplicationOperation(p.request, body);
    p.edit('append', records => records.push({ name: 'User', is_user: true, mes: 'Later message' }));
    let calls = 0;
    const fetchImpl = async (_url, options) => { calls++; return response(`FR:${JSON.parse(options.body).q}`); };
    await runOperation(p.context(accepted.job), { fetchImpl });
    assert.equal(calls, 2);
    const saved = p.chat();
    assert.equal(saved[1].mes, 'Original');
    assert.equal(saved[1].extra.display_text, 'FR:Original');
    assert.deepEqual(saved[2].swipes, ['Answer', 'Other']);
    assert.equal(saved[2].swipe_id, 0);
    assert.equal(saved[3].mes, 'Later message');
    assert.equal(saved[3].extra?.display_text, undefined);
    p.edit('delete-translated-message', records => records.splice(2, 1));
    await runOperation(p.context(accepted.job), { fetchImpl });
    assert.equal(p.chat().length, 3);
    fs.rmSync(path.join(p.base.directories.root, 'jobs', 'index.json'));
    fs.rmSync(path.join(p.base.directories.root, 'jobs', 'artifacts'), { recursive: true, force: true });
    const repeated = await acceptApplicationOperation(p.request, body);
    assert.equal(repeated.created, false);
    assert.equal(repeated.job, null);
    assert.equal(repeated.record.state, 'completed');
    assert.equal(calls, 2);
});

test('an unknown translation result is never retried and the old chat stays untouched', async t => {
    const p = prepared(t);
    const accepted = await acceptApplicationOperation(p.request, { key: 'unknown', kind: 'translation', mode: 'chat', locator: p.f.locator });
    const before = p.chat();
    let calls = 0;
    const dependencies = { fetchImpl: async () => { calls++; throw new Error('Connection lost after sending'); } };
    await assert.rejects(runOperation(p.context(accepted.job), dependencies), /did not return/);
    await assert.rejects(runOperation(p.context(accepted.job), dependencies), /unknown/);
    assert.deepEqual(p.chat(), before);
    assert.equal(calls, 1);
});

test('a changed target during translation refuses publication without undoing the user edit', async t => {
    const p = prepared(t);
    const accepted = await acceptApplicationOperation(p.request, { key: 'changed', kind: 'translation', mode: 'chat', locator: p.f.locator });
    let calls = 0;
    await assert.rejects(runOperation(p.context(accepted.job), { fetchImpl: async () => {
        if (++calls === 1) p.edit('user-edit', records => { records[1].mes = 'User correction'; });
        return response('Translated');
    } }), /message or selected swipe changed/);
    assert.equal(p.chat()[1].mes, 'User correction');
    assert.equal(p.chat()[1].extra.display_text, undefined);
    assert.equal(calls, 1);
});

test('translation publication recovers its own write after the chat was deleted', async t => {
    const p = prepared(t);
    const accepted = await acceptApplicationOperation(p.request, { key: 'publish', kind: 'translation', mode: 'chat', locator: p.f.locator });
    let calls = 0;
    await assert.rejects(runOperation(p.context(accepted.job), { fetchImpl: async () => { calls++; return response('Saved translation'); },
        afterTranslationPublication() { throw new Error('Lost publication acknowledgement'); } }), /acknowledgement/);
    assert.equal(p.chat()[1].extra.display_text, 'Saved translation');
    fs.rmSync(p.f.filename);
    await runOperation(p.context(accepted.job), { fetchImpl: async () => { throw new Error('Must not call again'); } });
    assert.equal(fs.existsSync(p.f.filename), false);
    assert.equal(readOperation(p.base, 'publish').state, 'completed');
    assert.equal(calls, 2);
});

test('free text keeps image links, optional Libre keys and account isolation', async t => {
    const a = prepared(t, 'alice'), b = prepared(t, 'bob');
    const body = { key: 'same-key', kind: 'translation', mode: 'text', text: 'Hello ![photo](/photo.png) world', target: 'fr' };
    const first = await acceptApplicationOperation(a.request, body);
    const second = await acceptApplicationOperation(b.request, body);
    assert.notEqual(first.job.id, second.job.id);
    const calls = [];
    await runOperation(a.context(first.job), { fetchImpl: async (_url, options) => {
        const input = JSON.parse(options.body); calls.push(input.q);
        assert.ok(!input.api_key);
        return response(`[${input.q}]`);
    } });
    assert.equal(readOperation(a.base, body.key).result.text, '[Hello ]![photo](/photo.png)[ world]');
    assert.equal(readOperation(b.base, body.key).state, 'accepted');
    assert.deepEqual(calls, ['Hello ', ' world']);
});
