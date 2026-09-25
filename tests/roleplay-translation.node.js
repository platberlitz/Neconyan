import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { fixture } from './roleplay-transactions-fixture.js';

const { SECRET_KEYS, writeSecret } = await import('../src/endpoints/secrets.js');
const { captureRoleplayWorldInfo } = await import('../src/generation/world-info.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { captureRoleplaySource } = await import('../src/generation/roleplay-source.js');
const { admitRoleplayJob } = await import('../src/roleplay-jobs.js');
const { providerStep, readArtifact } = await import('../src/jobs/artifacts.js');
const { getJob, recoverJobs, releaseJob, updateJob } = await import('../src/jobs/store.js');

const controls = { prompts: [
    { identifier: 'main', role: 'system', system_prompt: true, content: '' },
    { identifier: 'chatHistory', marker: true, system_prompt: true },
], prompt_order: [{ character_id: 100001, order: [
    { identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true },
] }] };

function prepared(t, { provider = 'libre', autoMode = 'responses', effect = 'append', reasoning = false, pendingInput, pendingDisplay } = {}) {
    const f = fixture(t);
    f.records[1].extra = {};
    if (pendingInput !== undefined) f.records.push({ name: 'User', is_user: true, mes: pendingInput,
        extra: pendingDisplay === undefined ? {} : { display_text: pendingDisplay } });
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n') + '\n');
    const directories = f.scope.directories;
    const settings = {
        world_info_settings: { world_info: { globalSelect: [], charLore: [] }, world_info_budget: 200 },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1' },
        extension_settings: {
            connectionManager: { profiles: [{ id: 'main', name: 'Main', api: 'custom', model: 'fixture',
                'api-url': 'http://127.0.0.1:18000/v1' }] },
            translate: { auto_mode: autoMode, provider, target_language: 'fr', internal_language: 'en',
                translate_reasoning: reasoning },
        },
    };
    fs.writeFileSync(`${directories.root}/settings.json`, JSON.stringify(settings));
    if (provider === 'libre') {
        writeSecret(directories, SECRET_KEYS.LIBRE, 'private-libre-key');
        writeSecret(directories, SECRET_KEYS.LIBRE_URL, 'https://libre.example.test/translate');
    }
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = effect === 'continue'
        ? captureRoleplaySource(f.scope, { locator: f.locator, message: 1 }) : f.source();
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source,
        { avatar: 'Nova.png', maxContext: 4000, serverPrompt: true,
            trigger: { append: 'normal', continue: 'continue', swipe: 'swipe', replace: 'regenerate' }[effect] });
    const binding = { kind: 'profile', ...captureChatProfile(directories, 'main') };
    const { jobId } = admitRoleplayJob(f.scope, account, {
        operationKey: `translation-${randomUUID()}`, effect, source,
        request: { binding, maxTokens: 32, characterName: 'Nova', worldInfo, serverPrompt: true, messages: [] },
    });
    releaseJob(directories, jobId);
    const context = () => ({ job: getJob(directories, jobId), directories,
        owner: f.scope.owner, signal: new AbortController().signal });
    const run = (options = {}) => runRoleplayReplyJob(context(), {
        contextLimit: () => 4096,
        promptBackend: () => ({ backend: 'chat', active: controls, profile: { model: 'fixture' }, source: 'custom' }),
        ...options,
    });
    return { f, account, source, worldInfo, jobId, settings, context, run };
}

const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const chat = f => fs.readFileSync(f.filename, 'utf8').trim().split('\n').map(JSON.parse);

test('incoming translation policy binds its settings and secrets without storing credentials', t => {
    const { f, worldInfo, settings } = prepared(t);
    assert.equal(worldInfo.translation.provider, 'libre');
    assert.equal(worldInfo.translation.target, 'fr');
    assert.match(worldInfo.translation.credentialsHash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(worldInfo).includes('private-libre-key'));
    assert.ok(!JSON.stringify(worldInfo).includes('libre.example.test'));
    settings.extension_settings.translate.auto_mode = 'none';
    fs.writeFileSync(`${f.scope.directories.root}/settings.json`, JSON.stringify(settings));
    const disabled = captureRoleplayWorldInfo(f.scope, { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch },
        f.source(), { avatar: 'Nova.png', maxContext: 4000, serverPrompt: true });
    assert.equal(disabled.translation, undefined);
});

test('incoming Libre translation adds display and reasoning text without changing the model reply or image links', async t => {
    const { f, jobId, run } = prepared(t, { reasoning: true });
    const calls = [];
    await run({
        generate: async ({ beforeDispatch }) => {
            beforeDispatch();
            return { text: 'Hello ![photo](/user/images/photo.png) world',
                response: { choices: [{ message: { reasoning_content: 'Thinking' } }] } };
        },
        translationFetch: async (url, options) => {
            assert.equal(url, 'https://libre.example.test/translate');
            const body = JSON.parse(options.body);
            assert.equal(body.api_key, 'private-libre-key');
            assert.equal(body.target, 'fr');
            calls.push(body.q);
            return response({ translatedText: `FR(${body.q})` });
        },
    });
    const reply = chat(f).at(-1);
    assert.equal(reply.mes, 'Hello ![photo](/user/images/photo.png) world');
    assert.equal(reply.extra.display_text, 'FR(Hello )![photo](/user/images/photo.png)FR( world)');
    assert.equal(reply.extra.reasoning_display_text, 'FR(Thinking)');
    assert.deepEqual(calls, ['Hello ', ' world', 'Thinking']);
    const input = readArtifact(f.scope.directories, jobId, 'input:translation:display_text:0:0');
    assert.equal(input.provider, 'libre');
    assert.ok(!JSON.stringify(input).includes('private-libre-key'));
    assert.equal(readArtifact(f.scope.directories, jobId, 'provider:translation:display_text:1:0'), undefined);
    assert.equal(readArtifact(f.scope.directories, jobId, 'provider:translation:display_text:2:0').text, 'FR( world)');
    assert.ok(readArtifact(f.scope.directories, jobId, 'roleplay-output'));
});

test('continuation translation uses the protected original message plus the generated suffix', async t => {
    const { f, run } = prepared(t, { provider: 'deeplx', effect: 'continue' });
    const calls = [];
    await run({
        generate: async ({ beforeDispatch }) => { beforeDispatch(); return { text: ' again' }; },
        translationFetch: async (_url, options) => {
            const body = JSON.parse(options.body);
            calls.push(body.text);
            return response({ data: `FR(${body.text})` });
        },
    });
    assert.deepEqual(calls, ['Answer again']);
    const original = chat(f)[2];
    assert.equal(original.mes, 'Answer again');
    assert.equal(original.extra.display_text, 'FR(Answer again)');
});

test('changed saved translation settings or secret refuse before any translation provider request', async t => {
    for (const change of ['settings', 'secret']) {
        const { f, run, settings } = prepared(t);
        let calls = 0;
        await assert.rejects(run({
            generate: async ({ beforeDispatch }) => {
                beforeDispatch();
                if (change === 'settings') {
                    settings.extension_settings.translate.target_language = 'es';
                    fs.writeFileSync(`${f.scope.directories.root}/settings.json`, JSON.stringify(settings));
                } else writeSecret(f.scope.directories, SECRET_KEYS.LIBRE, 'changed-key');
                return { text: 'Hello' };
            },
            translationFetch: () => { calls++; return assert.fail('Translation sent after source change'); },
        }));
        assert.equal(calls, 0);
        assert.equal(chat(f).length, 3);
    }
});

test('an unknown paid translation result interrupts without repeating the saved main reply', async t => {
    const { f, jobId, run } = prepared(t);
    const directories = f.scope.directories;
    updateJob(directories, jobId, { state: 'running' });
    let mainCalls = 0;
    let translationCalls = 0;
    const mainStep = 'a'.repeat(64);
    const main = async ({ jobContext, beforeDispatch, onProviderStep }) => {
        onProviderStep(`provider:${mainStep}`);
        return providerStep(jobContext, mainStep, async () => {
            beforeDispatch();
            mainCalls++;
            return { text: 'Hello' };
        });
    };
    await assert.rejects(run({ generate: main, translationFetch: async () => {
        translationCalls++;
        throw new Error('unknown provider result');
    } }));
    assert.equal(mainCalls, 1);
    assert.equal(translationCalls, 1);
    assert.equal(getJob(directories, jobId).recoverability, 'unknown-outcome');
    recoverJobs(directories);
    assert.equal(getJob(directories, jobId).state, 'interrupted');
    await assert.rejects(run({ generate: () => assert.fail('Main provider repeated'),
        translationFetch: () => assert.fail('Translation repeated') }));
    assert.equal(mainCalls, 1);
    assert.equal(translationCalls, 1);
    assert.equal(chat(f).length, 3);
});

test('completed translation chunks resume from saved results after a known source refusal', async t => {
    const { f, jobId, run, settings } = prepared(t, { provider: 'deeplx' });
    const directories = f.scope.directories;
    updateJob(directories, jobId, { state: 'running' });
    const originalSettings = JSON.stringify(settings);
    const longReply = 'a'.repeat(3100);
    let mainCalls = 0;
    let chunks = 0;
    const mainStep = 'a'.repeat(64);
    const main = async ({ jobContext, beforeDispatch, onProviderStep }) => {
        onProviderStep(`provider:${mainStep}`);
        return providerStep(jobContext, mainStep, async () => {
            beforeDispatch();
            mainCalls++;
            return { text: longReply };
        });
    };
    const translate = async (_url, options) => {
        const body = JSON.parse(options.body);
        chunks++;
        if (chunks === 1) {
            settings.extension_settings.translate.internal_language = 'de';
            fs.writeFileSync(`${directories.root}/settings.json`, JSON.stringify(settings));
        }
        return response({ data: `FR(${body.text.length})` });
    };
    await assert.rejects(run({ generate: main, translationFetch: translate }));
    assert.equal(chunks, 1);
    assert.equal(mainCalls, 1);
    assert.ok(readArtifact(directories, jobId, 'provider:translation:display_text:0:0'));
    assert.notEqual(getJob(directories, jobId).recoverability, 'unknown-outcome');
    fs.writeFileSync(`${directories.root}/settings.json`, originalSettings);
    recoverJobs(directories);
    await run({ generate: () => assert.fail('Main provider repeated'), translationFetch: translate });
    assert.equal(mainCalls, 1);
    assert.equal(chunks, 3);
    assert.equal(chat(f).at(-1).extra.display_text, 'FR(1500)FR(1500)FR(100)');
});

test('new user input is translated before lore and the main prompt, then saved with its original display text', async t => {
    const { f, worldInfo, jobId, run } = prepared(t, { autoMode: 'both', pendingInput: 'Bonjour' });
    assert.equal(worldInfo.inputTranslation.item.index, 2);
    assert.equal(worldInfo.inputTranslation.policy.target, 'en');
    const calls = [];
    await run({ translationFetch: async (_url, options) => {
        const body = JSON.parse(options.body);
        calls.push([body.q, body.target]);
        return response({ translatedText: body.target === 'en' ? 'Hello' : 'Réponse' });
    }, generate: async ({ beforeDispatch, messages }) => {
        beforeDispatch();
        assert.match(JSON.stringify(messages), /Hello/);
        assert.doesNotMatch(JSON.stringify(messages), /Bonjour/);
        assert(readArtifact(f.scope.directories, jobId, 'roleplay-history-input').promptChat.some(text => text.includes('Hello')));
        assert.equal(chat(f)[3].mes, 'Bonjour', 'The original remains intact until the complete reply is ready.');
        return { text: 'Answer back' };
    } });
    assert.deepEqual(calls, [['Bonjour', 'en'], ['Answer back', 'fr']]);
    const saved = chat(f);
    assert.equal(saved[3].mes, 'Hello');
    assert.equal(saved[3].extra.display_text, 'Bonjour');
    assert.deepEqual(saved.slice(1, 3), f.records.slice(1, 3));
    assert.equal(saved[0].unknown, f.records[0].unknown);
    assert.equal(saved[4].mes, 'Answer back');
    assert.equal(saved[4].extra.display_text, 'Réponse');
    const translated = readArtifact(f.scope.directories, jobId, 'roleplay-input-translation');
    assert.equal(readArtifact(f.scope.directories, jobId, 'roleplay-prompt').inputTranslationHash, translated.hash);
    await run({ generate: () => assert.fail('A completed reply repeated.'), translationFetch: () => assert.fail('A completed translation repeated.') });
});

test('an unknown outgoing translation cannot reach the model or change the saved user input after restart', async t => {
    const { f, jobId, run } = prepared(t, { autoMode: 'inputs', pendingInput: 'Bonjour' });
    updateJob(f.scope.directories, jobId, { state: 'running' });
    let calls = 0;
    await assert.rejects(run({ translationFetch: async () => { calls++; throw new Error('lost result'); },
        generate: () => assert.fail('The main model ran after an unknown input translation.') }), { code: 'ROLEPLAY_TRANSLATION_PROVIDER' });
    assert.equal(chat(f)[3].mes, 'Bonjour');
    assert.equal(chat(f).length, 4);
    recoverJobs(f.scope.directories);
    await assert.rejects(run({ translationFetch: () => assert.fail('The outgoing translation repeated.'),
        generate: () => assert.fail('The main model ran.') }), { code: 'ROLEPLAY_TRANSLATION_RECOVERY' });
    assert.equal(calls, 1);
});

test('saved user translation survives a main-provider interruption without another translation request', async t => {
    const { f, jobId, run } = prepared(t, { autoMode: 'inputs', pendingInput: 'Bonjour' });
    updateJob(f.scope.directories, jobId, { state: 'running' });
    let translations = 0;
    await assert.rejects(run({ translationFetch: async () => { translations++; return response({ translatedText: 'Hello' }); },
        generate: async ({ beforeDispatch }) => { beforeDispatch(); throw new Error('known refusal before main dispatch'); } }), /known refusal/);
    assert.equal(chat(f)[3].mes, 'Bonjour');
    assert(readArtifact(f.scope.directories, jobId, 'roleplay-input-translation'));
    await run({ translationFetch: () => assert.fail('Saved user translation repeated.'),
        generate: async ({ beforeDispatch, messages }) => { beforeDispatch(); assert.match(JSON.stringify(messages), /Hello/); return { text: 'Reply' }; } });
    assert.equal(translations, 1);
    assert.equal(chat(f)[3].mes, 'Hello');
});

test('input translation does not retranslate older user history or an already translated input', t => {
    const old = prepared(t, { autoMode: 'inputs' });
    assert.equal(old.worldInfo.inputTranslation, undefined);
    const pending = prepared(t, { autoMode: 'inputs', pendingInput: 'Hello', pendingDisplay: 'Bonjour' });
    assert.equal(pending.worldInfo.inputTranslation, undefined);
});
