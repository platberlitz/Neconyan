/* eslint playwright/expect-expect: off -- Node assertions verify bound captions, paid receipts and prompt inputs. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { captureRoleplayWorldInfo } = await import('../src/generation/world-info.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');
const { admitRoleplayJob } = await import('../src/roleplay-jobs.js');
const { getJob, recoverJobs, releaseJob, updateJob } = await import('../src/jobs/store.js');
const { providerStep, readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');
const { readRoleplayChat } = await import('../src/generation/roleplay-source.js');
const { SECRET_KEYS, writeSecret } = await import('../src/endpoints/secrets.js');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const controls = { prompts: [{ identifier: 'main', role: 'system', system_prompt: true, content: '' },
    { identifier: 'worldInfoBefore', marker: true, system_prompt: true },
    { identifier: 'chatHistory', marker: true, system_prompt: true }], prompt_order: [{ character_id: 100001,
    order: [{ identifier: 'main', enabled: true }, { identifier: 'worldInfoBefore', enabled: true }, { identifier: 'chatHistory', enabled: true }] }] };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

function prepared(t, { caption = {}, blank = false, gallery = false, secret, mutate } = {}) {
    const f = fixture(t);
    const directories = f.scope.directories;
    directories.userImages = path.join(directories.root, 'user', 'images');
    directories.worlds = path.join(directories.root, 'worlds');
    fs.mkdirSync(directories.userImages, { recursive: true });
    fs.mkdirSync(directories.worlds);
    fs.writeFileSync(path.join(directories.userImages, 'photo.png'), Buffer.from(PNG, 'base64'));
    f.records[1].mes = blank ? '' : 'Describe the upload.';
    const item = { url: '/user/images/photo.png', type: 'image', source: 'upload' };
    f.records[1].extra = { media: gallery ? [{ ...item, source: 'generated' }, item] : [item],
        media_display: gallery ? 'gallery' : 'list', media_index: gallery ? 1 : 0 };
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    const settings = { power_user: {}, world_info_settings: { world_info: { globalSelect: ['Caption lore'] }, world_info_budget: 200 },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1' },
        extension_settings: { caption: { auto_mode: true, source: 'local', ...caption }, connectionManager: { profiles: [
            { id: 'main', name: 'Main', api: 'custom', model: 'fixture', 'api-url': 'http://127.0.0.1:18000/v1' },
        ] } } };
    mutate?.(settings);
    const settingsFile = path.join(directories.root, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    fs.writeFileSync(path.join(directories.worlds, 'Caption lore.json'), JSON.stringify({ entries: {
        1: { uid: 1, comment: 'Ruby lore', key: ['ruby'], content: 'A ruby opens the hidden door.', position: 0, order: 100 },
    } }));
    if (secret) writeSecret(directories, SECRET_KEYS[secret], 'caption-private-key');
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = f.source();
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 4000, serverPrompt: true });
    const binding = { kind: 'profile', ...captureChatProfile(directories, 'main') };
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'native-caption', effect: 'append', source,
        request: { binding, maxTokens: 32, characterName: 'Nova', worldInfo, serverPrompt: true, messages: [] } });
    releaseJob(directories, jobId);
    const context = () => ({ job: getJob(directories, jobId), directories, owner: f.scope.owner, signal: new AbortController().signal });
    const run = (options = {}) => runRoleplayReplyJob(context(), { contextLimit: () => 4096,
        promptBackend: () => ({ backend: 'chat', active: controls, profile: { model: 'fixture' }, source: 'custom' }),
        generate: async ({ beforeDispatch }) => { beforeDispatch(); return { text: 'A saved answer.' }; }, ...options });
    return { f, directories, settings, settingsFile, account, source, worldInfo, jobId, context, run };
}

test('a saved local caption enters history and lore, then commits with its completed reply once', async t => {
    const f = prepared(t);
    const before = structuredClone(f.f.records[1]);
    let captions = 0;
    await f.run({ localCaption: async (config, image) => {
        captions++;
        assert.equal(config.source, 'local');
        assert.equal(image, `data:image/png;base64,${PNG}`);
        return 'a ruby on a desk';
    }, generate: async ({ beforeDispatch, messages }) => {
        beforeDispatch();
        assert.deepEqual(readRoleplayChat(f.f.scope, f.f.locator).records[1], before, 'the original stays intact until the reply is complete');
        assert.match(JSON.stringify(messages), /a ruby on a desk/);
        assert.match(JSON.stringify(messages), /A ruby opens the hidden door/);
        assert.doesNotMatch(JSON.stringify(messages), /data:image/);
        assert(readArtifact(f.directories, f.jobId, 'roleplay-captions'));
        return { text: 'A saved answer.' };
    } });
    assert.equal(captions, 1);
    const records = readRoleplayChat(f.f.scope, f.f.locator).records;
    assert.equal(records[1].mes, before.mes);
    assert.equal(records[1].extra.media[0].captioned, true);
    assert.equal(records[1].extra.media[0].append_title, true);
    assert.equal(records[1].extra.media[0].url, before.extra.media[0].url);
    assert.equal(records.at(-1).mes, 'A saved answer.');
    const result = readArtifact(f.directories, f.jobId, 'roleplay-captions');
    assert.match(result.results[0].title, /User sends Nova a picture that contains: a ruby/);
    assert.equal(readArtifact(f.directories, f.jobId, 'roleplay-prompt').captionsHash, result.hash);
    await f.run({ localCaption: () => { throw new Error('A completed caption repeated.'); } });
    const source = f.f.source();
    const worldInfo = captureRoleplayWorldInfo(f.f.scope, f.account, source, { avatar: 'Nova.png', maxContext: 4000, serverPrompt: true });
    assert.equal(worldInfo.captions, undefined, 'another accepted turn does not recaption a completed upload');
    assert.equal(worldInfo.images[0].captioned, true);
    const binding = { kind: 'profile', ...captureChatProfile(f.directories, 'main') };
    const { jobId } = admitRoleplayJob(f.f.scope, f.account, { operationKey: 'after-caption', effect: 'append', source,
        request: { binding, maxTokens: 32, characterName: 'Nova', worldInfo, serverPrompt: true, messages: [] } });
    releaseJob(f.directories, jobId);
    await runRoleplayReplyJob({ ...f.context(), job: getJob(f.directories, jobId) }, { contextLimit: () => 4096,
        promptBackend: () => ({ backend: 'chat', active: controls, profile: { model: 'fixture' }, source: 'custom' }),
        localCaption: () => assert.fail('a later turn repeated the caption'),
        generate: async ({ beforeDispatch, messages }) => { beforeDispatch(); assert.match(JSON.stringify(messages), /a ruby on a desk/); return { text: 'A second answer.' }; } });
});

test('caption dispatch accepts saved settings bookkeeping and subsequent bookkeeping-only changes', async t => {
    const f = prepared(t, { mutate: settings => {
        settings._version = 1;
        settings._settingsRevision = 'saved-revision';
        settings.accountStorage = { welcome: true };
        settings.extension_settings.neconyan_conversation = { enabled: true };
    } });
    f.settings._version = 2;
    f.settings._settingsRevision = 'next-revision';
    f.settings.accountStorage.welcome = false;
    f.settings.extension_settings.neconyan_conversation.enabled = false;
    fs.writeFileSync(f.settingsFile, JSON.stringify(f.settings));
    let calls = 0;
    await f.run({ localCaption: async () => { calls++; return 'a ruby'; } });
    assert.equal(calls, 1);
    assert.equal(readRoleplayChat(f.f.scope, f.f.locator).records[1].extra.media[0].captioned, true);
});

test('changed caption instructions refuse before dispatch', async t => {
    const f = prepared(t);
    f.settings.extension_settings.caption.prompt = 'Use different instructions.';
    fs.writeFileSync(f.settingsFile, JSON.stringify(f.settings));
    await assert.rejects(f.run({ localCaption: () => assert.fail('Changed instructions reached the provider.') }), /changed|differs/);
});

test('empty uploaded messages and selected gallery items receive only their own caption', async t => {
    const f = prepared(t, { blank: true, gallery: true, caption: { template: '{{char}} sees {{caption}}' } });
    assert.equal(f.worldInfo.captions.items[0].mediaIndex, 1);
    assert.equal(f.worldInfo.captions.items.length, 1);
    await f.run({ localCaption: async () => 'a ruby', generate: async ({ beforeDispatch, messages }) => {
        beforeDispatch();
        assert.match(JSON.stringify(messages), /Nova sees a ruby/);
        assert.doesNotMatch(JSON.stringify(messages), /data:image/);
        return { text: 'Saved.' };
    } });
    const saved = readRoleplayChat(f.f.scope, f.f.locator).records[1];
    assert.equal(saved.mes, 'Nova sees a ruby');
    assert.equal(saved.extra.media[0].captioned, undefined);
    assert.equal(saved.extra.media[1].captioned, true);
});

test('configured caption reviews are required before admission and disabled automatic captions add no work', t => {
    assert.throws(() => prepared(t, { caption: { refine_mode: true } }), { code: 'ROLEPLAY_CAPTION_REVIEW_REQUIRED' });
    assert.throws(() => prepared(t, { caption: { prompt_ask: true } }), { code: 'ROLEPLAY_CAPTION_REVIEW_REQUIRED' });
    const disabled = prepared(t, { caption: { auto_mode: false } });
    assert.equal(disabled.worldInfo.captions, undefined);
});

test('native multimodal caption uses the saved connection and keeps credentials out of accepted inputs', async t => {
    const f = prepared(t, { caption: { source: 'multimodal', multimodal_api: 'openai', multimodal_model: 'caption-model', prompt: 'Describe {{char}}\'s image.' }, secret: 'OPENAI' });
    assert(!JSON.stringify(f.worldInfo).includes('caption-private-key'));
    let calls = 0;
    await f.run({ captionFetch: async (url, options) => {
        calls++;
        assert.equal(url, 'https://api.openai.com/v1/chat/completions');
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers.Authorization, 'Bearer caption-private-key');
        const body = JSON.parse(options.body);
        assert.equal(body.model, 'caption-model');
        assert.equal(body.messages[0].content[0].text, 'Describe Nova\'s image.');
        assert.equal(body.messages[0].content[1].image_url.url, `data:image/png;base64,${PNG}`);
        return json({ choices: [{ message: { content: 'a ruby' } }] });
    } });
    assert.equal(calls, 1);
    for (const name of ['input:roleplay-caption:0:0', 'provider:roleplay-caption:0:0', 'roleplay-captions']) {
        assert(!JSON.stringify(readArtifact(f.directories, f.jobId, name)).includes('caption-private-key'));
    }
});

test('a missing paid caption result remains interrupted after restart and does not reach another provider', async t => {
    const f = prepared(t, { caption: { source: 'multimodal', multimodal_api: 'openai' }, secret: 'OPENAI' });
    updateJob(f.directories, f.jobId, { state: 'running' });
    let calls = 0;
    await assert.rejects(f.run({ captionFetch: async () => { calls++; throw new Error('lost paid response'); },
        generate: () => { throw new Error('Main provider reached.'); } }), { code: 'ROLEPLAY_CAPTION_PROVIDER' });
    recoverJobs(f.directories);
    assert.equal(getJob(f.directories, f.jobId).state, 'interrupted');
    await assert.rejects(f.run({ captionFetch: () => { throw new Error('Paid caption repeated.'); },
        generate: () => { throw new Error('Main provider reached.'); } }), { code: 'ROLEPLAY_CAPTION_RECOVERY' });
    assert.equal(calls, 1);
    assert.equal(readRoleplayChat(f.f.scope, f.f.locator).records.length, 3);
});

test('Horde resumes a saved interrogation by polling its ID without repeating its paid submission', async t => {
    const f = prepared(t, { caption: { source: 'horde' }, secret: 'HORDE' });
    updateJob(f.directories, f.jobId, { state: 'running' });
    let submissions = 0;
    let polls = 0;
    const captionFetch = async (url, options) => {
        if (url.endsWith('/async')) {
            submissions++;
            assert.equal(options.headers.apikey, 'caption-private-key');
            assert.equal(JSON.parse(options.body).source_image, PNG);
            return json({ id: 'saved-caption-id' });
        }
        polls++;
        assert.equal(url, 'https://aihorde.net/api/v2/interrogate/status/saved-caption-id');
        if (polls === 1) throw new Error('temporary read-only failure');
        return json({ state: 'done', forms: [{ form: 'caption', result: { caption: 'a ruby' } }] });
    };
    await assert.rejects(f.run({ captionFetch, captionWait: async () => {} }), { code: 'ROLEPLAY_CAPTION_POLL' });
    assert.equal(readArtifact(f.directories, f.jobId, 'provider:roleplay-caption:0:0:submit').id, 'saved-caption-id');
    recoverJobs(f.directories);
    await f.run({ captionFetch, captionWait: async () => {} });
    assert.equal(submissions, 1);
    assert.equal(polls, 2);
});

test('a changed caption key refuses before a paid request and a damaged completed result cannot be regenerated', async t => {
    const f = prepared(t, { caption: { source: 'multimodal', multimodal_api: 'openai' }, secret: 'OPENAI' });
    writeSecret(f.directories, SECRET_KEYS.OPENAI, 'replacement-key');
    await assert.rejects(f.run({ captionFetch: () => { throw new Error('Changed key reached a provider.'); } }), /changed|differs/);
    assert.notEqual(getJob(f.directories, f.jobId).recoverability, 'unknown-outcome');
    writeSecret(f.directories, SECRET_KEYS.OPENAI, 'caption-private-key');
    await assert.rejects(f.run({ captionFetch: async () => json({ choices: [{ message: { content: 'a ruby' } }] }),
        generate: async () => { throw new Error('known pre-main refusal'); } }), /known pre-main/);
    const saved = readArtifact(f.directories, f.jobId, 'roleplay-captions');
    saved.results[0].title = 'An unrelated image';
    writeArtifact(f.directories, f.jobId, 'roleplay-captions', saved);
    await assert.rejects(f.run({ captionFetch: () => { throw new Error('Paid caption repeated.'); } }), { code: 'ROLEPLAY_CAPTION_RECOVERY' });
});

test('completed main replies retain their caption evidence and never restart a caption provider', async t => {
    const f = prepared(t);
    let calls = 0;
    const mainStep = 'b'.repeat(64);
    await f.run({ localCaption: async () => { calls++; return 'a ruby'; }, generate: async ({ jobContext, onProviderStep, beforeDispatch }) => {
        onProviderStep(`provider:${mainStep}`);
        return providerStep(jobContext, mainStep, async () => { beforeDispatch(); return { text: 'Saved with caption.' }; });
    } });
    await f.run({ localCaption: () => { throw new Error('Caption was repeated.'); } });
    assert.equal(calls, 1);
    assert.equal(readRoleplayChat(f.f.scope, f.f.locator).records.at(-1).mes, 'Saved with caption.');
});

test('every bundled multimodal caption API uses its configured transport and response shape', async t => {
    const providers = [
        ['openrouter', 'OPENROUTER', 'openrouter.ai/api/v1/chat/completions'],
        ['mistral', 'MISTRALAI', 'api.mistral.ai/v1/chat/completions'],
        ['xai', 'XAI', 'api.x.ai/v1/chat/completions'],
        ['aimlapi', 'AIMLAPI', 'api.aimlapi.com/v1/chat/completions'],
        ['groq', 'GROQ', 'api.groq.com/openai/v1/chat/completions'],
        ['cohere', 'COHERE', 'api.cohere.ai/v2/chat'],
        ['moonshot', 'MOONSHOT', 'api.moonshot.ai/v1/chat/completions'],
        ['nanogpt', 'NANOGPT', 'nano-gpt.com/api/v1/chat/completions'],
        ['chutes', 'CHUTES', 'llm.chutes.ai/v1/chat/completions'],
        ['electronhub', 'ELECTRONHUB', 'api.electronhub.ai/v1/chat/completions'],
        ['pollinations', 'POLLINATIONS', 'gen.pollinations.ai/v1/chat/completions'],
        ['zai', 'ZAI', 'api.z.ai/api/paas/v4/chat/completions'],
        ['workers_ai', 'WORKERS_AI', 'api.cloudflare.com/client/v4/accounts/caption-account/ai/v1/chat/completions'],
        ['anthropic', 'CLAUDE', 'api.anthropic.com/v1/messages'],
        ['google', 'MAKERSUITE', 'generativelanguage.googleapis.com/v1beta/models/caption-model:generateContent'],
        ['vertexai', 'VERTEXAI', 'us-central1-aiplatform.googleapis.com/v1/publishers/google/models/caption-model:generateContent'],
        ['ollama', null, '127.0.0.1:18000/api/generate'],
        ['llamacpp', 'LLAMACPP', '127.0.0.1:18000/v1/chat/completions'],
        ['ooba', 'OOBA', '127.0.0.1:18000/v1/chat/completions'],
        ['koboldcpp', 'KOBOLDCPP', '127.0.0.1:18000/v1/chat/completions'],
        ['vllm', 'VLLM', '127.0.0.1:18000/v1/chat/completions'],
        ['custom', 'CUSTOM', '127.0.0.1:18000/v1/chat/completions'],
    ];
    for (const [api, secret, suffix] of providers) await t.test(api, async t => {
        const f = prepared(t, { caption: { source: 'multimodal', multimodal_api: api, multimodal_model: 'caption-model' }, secret,
            mutate: settings => {
                settings.textgenerationwebui_settings = { server_urls: Object.fromEntries(['ollama', 'llamacpp', 'ooba', 'koboldcpp', 'vllm'].map(name => [name, 'http://127.0.0.1:18000/v1'])) };
                settings.oai_settings.workers_ai_account_id = 'caption-account';
            } });
        let calls = 0;
        await f.run({ captionFetch: async (url, options) => {
            calls++;
            assert(url.endsWith(suffix), url);
            assert.equal(options.method, 'POST');
            assert.equal(options.redirect, 'error');
            const body = JSON.parse(options.body);
            if (api === 'anthropic') {
                assert.equal(options.headers['x-api-key'], 'caption-private-key');
                assert.equal(body.messages[0].content[0].source.data, PNG);
                return json({ content: [{ type: 'text', text: 'a ruby' }] });
            }
            if (['google', 'vertexai'].includes(api)) {
                assert.equal(options.headers['x-goog-api-key'], 'caption-private-key');
                assert.equal(body.contents[0].parts[1].inlineData.data, PNG);
                return json({ candidates: [{ content: { parts: [{ text: 'a ruby' }] } }] });
            }
            if (api === 'ollama') {
                assert.equal(body.images[0], PNG);
                assert.equal(body.stream, false);
                return json({ response: 'a ruby' });
            }
            assert.equal(options.headers.Authorization, 'Bearer caption-private-key');
            if (api === 'ooba') assert.match(body.messages.at(-1).image_url, /^data:image\/jpeg;base64,/);
            else if (api === 'koboldcpp') assert.match(body.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
            if (api === 'pollinations') assert(Number.isSafeInteger(body.seed));
            return api === 'cohere' ? json({ message: { content: [{ type: 'text', text: 'a ruby' }] } })
                : json({ choices: [{ message: { content: 'a ruby' } }] });
        } });
        assert.equal(calls, 1);
        const accepted = JSON.stringify(getJob(f.directories, f.jobId).intent);
        assert(!accepted.includes('caption-private-key'));
    });
});
