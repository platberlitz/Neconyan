import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { captureCaptionRequest, admitCaptionJob, runCaptionJob } = await import('../src/generation/caption-jobs.js');
const { captureRoleplaySource, readRoleplayChat } = await import('../src/generation/roleplay-source.js');
const { captureRoleplayWorldInfo } = await import('../src/generation/world-info.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');
const { admitRoleplayJob } = await import('../src/roleplay-jobs.js');
const { readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');
const { getJob, releaseJob, updateJob, recoverJobs } = await import('../src/jobs/store.js');
const { SECRET_KEYS, writeSecret } = await import('../src/endpoints/secrets.js');
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const videoBytes = Buffer.concat([Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex'), Buffer.alloc(2 * 1024 * 1024)]);

function prepared(t, { video = false, api, caption = {}, blank = false, selectedMedia = 0 } = {}) {
    const f = fixture(t);
    const directories = f.scope.directories;
    directories.userImages = path.join(directories.root, 'user/images');
    directories.worlds = path.join(directories.root, 'worlds');
    fs.mkdirSync(directories.userImages, { recursive: true });
    fs.mkdirSync(directories.worlds);
    fs.writeFileSync(path.join(directories.userImages, 'photo.png'), png);
    if (video) fs.writeFileSync(path.join(directories.userImages, 'clip.mp4'), videoBytes);
    const selected = { url: video ? '/user/images/clip.mp4' : '/user/images/photo.png', type: video ? 'video' : 'image', source: 'upload' };
    f.records[1].mes = blank ? '' : 'Original';
    f.records[1].extra = { media_display: 'gallery', media_index: selectedMedia,
        media: [{ url: '/user/images/photo.png', type: 'image', source: 'generated' }, selected] };
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    const settings = { power_user: {}, oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1', vertexai_express: true },
        extension_settings: { caption: { auto_mode: false, source: api ? 'multimodal' : 'local', multimodal_api: api || 'openai', multimodal_model: 'fixture', ...caption },
            connectionManager: { profiles: [{ id: 'main', api: 'custom', model: 'fixture', 'api-url': 'http://127.0.0.1:18000/v1' }] } } };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify(settings));
    if (api) writeSecret(directories, SECRET_KEYS[{ openai: 'OPENAI', google: 'MAKERSUITE', vertexai: 'VERTEXAI', zai: 'ZAI' }[api]], 'private-caption-key');
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator, message: 0 });
    const capture = options => captureCaptionRequest(f.scope, account, source, { avatar: 'Nova.png', mediaIndex: 1, ...options });
    const admit = request => {
        const { jobId } = admitCaptionJob(f.scope, account, { operationKey: 'manual-caption', source, request });
        releaseJob(directories, jobId);
        return { jobId, context: () => ({ directories, owner: f.scope.owner, job: getJob(directories, jobId), signal: new AbortController().signal }) };
    };
    return { ...f, directories, account, source, settings, capture, admit };
}

test('a manual caption atomically changes only its selected saved media and keeps a permanent completion', async t => {
    const f = prepared(t);
    const request = f.capture();
    const { jobId, context } = f.admit(request);
    let calls = 0;
    const original = structuredClone(f.records);
    const result = await runCaptionJob(context(), { localCaption: async () => {
        calls++;
        assert.deepEqual(readRoleplayChat(f.scope, f.locator).records[1], original[1]);
        return 'a blue vase';
    } });
    const saved = readRoleplayChat(f.scope, f.locator).records;
    assert.equal(saved.length, original.length, 'captioning adds no assistant reply');
    assert.equal(saved[1].mes, 'Original');
    assert.deepEqual(saved[1].extra.media[0], original[1].extra.media[0]);
    assert.equal(saved[1].extra.media[1].captioned, true);
    assert.match(saved[1].extra.media[1].title, /User sends Nova a picture that contains: a blue vase/);
    assert.deepEqual(saved[2], original[2]);
    assert.equal(getJob(f.directories, jobId).intent.effect, 'caption');
    const accepted = context();
    fs.rmSync(path.join(f.directories.root, 'jobs/index.json'));
    fs.rmSync(path.join(f.directories.root, 'jobs/artifacts'), { recursive: true });
    const replay = await runCaptionJob(accepted, { localCaption: () => assert.fail('permanent completion repeated a caption') });
    assert.deepEqual(replay.result, result.result);
    assert.equal(admitCaptionJob(f.scope, f.account, { operationKey: 'manual-caption', source: f.source, request }).jobId, jobId);
    assert.equal(calls, 1);
});

test('a saved manual caption result survives interruption before its exact message write', async t => {
    const f = prepared(t, { api: 'openai', blank: true });
    const { context, jobId } = f.admit(f.capture());
    let calls = 0;
    await assert.rejects(runCaptionJob(context(), { fetchImpl: async () => { calls++; return json({ choices: [{ message: { content: 'a red coat' } }] }); },
        beforeCompletion: () => { throw new Error('delivery paused'); } }), /delivery paused/);
    assert.equal(readRoleplayChat(f.scope, f.locator).records[1].mes, '');
    assert(readArtifact(f.directories, jobId, 'caption-output'));
    await runCaptionJob(context(), { fetchImpl: () => assert.fail('saved paid caption repeated') });
    assert.match(readRoleplayChat(f.scope, f.locator).records[1].mes, /a red coat/);
    assert.equal(calls, 1);
});

test('manual caption review is completed before admission and never triggers another model call', async t => {
    const f = prepared(t, { caption: { refine_mode: true, prompt_ask: true } });
    assert.throws(() => f.capture(), { code: 'ROLEPLAY_CAPTION_REVIEW_REQUIRED' });
    const { context } = f.admit(f.capture({ reviewed: { caption: 'owner-edited detail', title: 'Chosen caption title' } }));
    await runCaptionJob(context(), { localCaption: () => assert.fail('reviewed caption must not be regenerated') });
    assert.equal(readRoleplayChat(f.scope, f.locator).records[1].extra.media[1].title, 'Chosen caption title');
});

test('a lost manual caption result stays interrupted and cannot repeat a paid request', async t => {
    const f = prepared(t, { api: 'openai' });
    const { context, jobId } = f.admit(f.capture());
    updateJob(f.directories, jobId, { state: 'running' });
    let calls = 0;
    await assert.rejects(runCaptionJob(context(), { fetchImpl: async () => { calls++; throw new Error('lost response'); } }),
        { code: 'ROLEPLAY_CAPTION_PROVIDER' });
    recoverJobs(f.directories);
    assert.equal(getJob(f.directories, jobId).state, 'interrupted');
    await assert.rejects(runCaptionJob(context(), { fetchImpl: () => assert.fail('unknown caption repeated') }), { code: 'ROLEPLAY_CAPTION_RECOVERY' });
    assert.equal(calls, 1);
    assert.deepEqual(readRoleplayChat(f.scope, f.locator).records[1], f.records[1]);
});

test('manual caption refuses replaced source files and damaged saved completion evidence', async t => {
    const f = prepared(t);
    const request = f.capture();
    const { context, jobId } = f.admit(request);
    const imageFile = path.join(f.directories.userImages, 'photo.png');
    fs.renameSync(imageFile, imageFile + '.old');
    fs.writeFileSync(imageFile, png);
    await assert.rejects(runCaptionJob(context(), { localCaption: () => assert.fail('replaced source reached a caption provider') }), { code: 'ROLEPLAY_CAPTION_INVALID' });
    fs.rmSync(imageFile);
    fs.renameSync(imageFile + '.old', imageFile);
    await assert.rejects(runCaptionJob(context(), { localCaption: async () => 'a saved object', beforeCompletion: () => { throw new Error('paused'); } }), /paused/);
    const output = readArtifact(f.directories, jobId, 'caption-output');
    output.captions[0].title = 'unrelated text';
    writeArtifact(f.directories, jobId, 'caption-output', output);
    await assert.rejects(runCaptionJob(context(), { localCaption: () => assert.fail('damaged result retried') }), { code: 'ROLEPLAY_CAPTION_INVALID' });
});

for (const api of ['google', 'vertexai', 'zai']) {
    test(`${api} captions a bound saved video with durable bytes and no repeated provider request`, async t => {
        const f = prepared(t, { api, video: true });
        const request = f.capture();
        assert.ok(Buffer.byteLength(JSON.stringify(request)) < 2 * 1024 * 1024, 'video bytes are a separate bounded durable input');
        const { context, jobId } = f.admit(request);
        let calls = 0;
        await runCaptionJob(context(), { fetchImpl: async (_url, init) => {
            calls++;
            const body = JSON.parse(init.body);
            if (api === 'zai') {
                assert.equal(body.messages[0].content[1].type, 'video_url');
                assert.equal(body.messages[0].content[1].video_url.url, `data:video/mp4;base64,${videoBytes.toString('base64')}`);
            } else {
                assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'video/mp4');
                assert.equal(body.contents[0].parts[1].inlineData.data, videoBytes.toString('base64'));
            }
            return json(api === 'zai' ? { choices: [{ message: { content: 'a bird flying over water' } }] }
                : { candidates: [{ content: { parts: [{ text: 'a bird flying over water' }] } }] });
        } });
        assert.equal(calls, 1);
        const media = request.worldInfo.images[0];
        assert.equal(readArtifact(f.directories, jobId, `input:caption-media:${media.rawHash}`).byteLength, videoBytes.length);
        await runCaptionJob(context(), { fetchImpl: () => assert.fail('completed video caption repeated') });
    });
}

test('automatic video captioning completes before a text-only Roleplay prompt and is retained for the next turn', async t => {
    const f = prepared(t, { api: 'google', video: true, caption: { auto_mode: true }, selectedMedia: 1 });
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const snapshot = captureRoleplayWorldInfo(f.scope, f.account, source, { avatar: 'Nova.png', maxContext: 4000, serverPrompt: true });
    assert.equal(snapshot.captions.items[0].mediaIndex, 1);
    const binding = { kind: 'profile', ...captureChatProfile(f.directories, 'main') };
    const controls = { prompts: [{ identifier: 'chatHistory', marker: true, system_prompt: true }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] }] };
    const reply = async (operationKey, current, worldInfo, captionFetch) => {
        const { jobId } = admitRoleplayJob(f.scope, f.account, { operationKey, effect: 'append', source: current,
            request: { binding, serverPrompt: true, maxTokens: 32, characterName: 'Nova', messages: [], worldInfo } });
        releaseJob(f.directories, jobId);
        await runRoleplayReplyJob({ directories: f.directories, owner: f.scope.owner, job: getJob(f.directories, jobId), signal: new AbortController().signal },
            { contextLimit: () => 4096, promptBackend: () => ({ backend: 'chat', active: controls, profile: { model: 'fixture' }, source: 'custom' }),
                generate: async ({ messages, beforeDispatch }) => {
                    beforeDispatch(); assert.match(JSON.stringify(messages), /a flying bird/); assert.doesNotMatch(JSON.stringify(messages), /data:video/);
                    return { text: 'A reply.' };
                }, captionFetch });
    };
    let calls = 0;
    await reply('caption-video', source, snapshot, async () => { calls++; return json({ candidates: [{ content: { parts: [{ text: 'a flying bird' }] } }] }); });
    const current = captureRoleplaySource(f.scope, { locator: f.locator });
    const next = captureRoleplayWorldInfo(f.scope, f.account, current, { avatar: 'Nova.png', maxContext: 4000, serverPrompt: true });
    assert.equal(next.captions, undefined);
    assert.equal(next.images[0].captioned, true);
    await reply('after-video', current, next, () => assert.fail('a committed video caption cannot repeat'));
    assert.equal(calls, 1);
});
