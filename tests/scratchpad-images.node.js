import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Jimp } from '../src/jimp.js';
import { decodeServerImage } from '../src/media-codecs.js';
import { fixture, png } from './roleplay-transactions-fixture.js';
import * as store from '../src/scratchpad/store.js';
import { acceptScratchpadImage, prepareScratchpadAvatarReview, saveScratchpadPersonaAvatar, registerScratchpadImageJobs, readScratchpadImageAvailability, assertScratchpadAvatarWriteLocked, assertScratchpadImageRetry } from '../src/scratchpad/images.js';
import { generateQuickImageGenJobImage } from '../src/generation/quick-image-gen-job.js';
import { readArtifact, writeArtifact } from '../src/jobs/artifacts.js';
import { explicitRetryRecovery, getJob, jobKey, mutateJobs, requestCancellation, setJobResume, updateJob } from '../src/jobs/store.js';
import { resolveSavedImageFilters } from '../src/generation/quick-image-gen-filters.js';
import { createMacroEnvironment } from '../src/macros/index.js';
import { testExports as runner, setDirectoriesResolver } from '../src/jobs/runner.js';
import { decideJobApproval, readJobApproval } from '../src/generation/job-approvals.js';
import { resolveCharacterImageSettings } from '../public/scripts/extensions/quick-image-gen/lib/character-settings.js';
import { captureImageTargetsLocked, resolveImageTargetLocked } from '../src/scratchpad/image-targets.js';
import { write as writeCard } from '../src/character-card-parser.js';
import { imageChangeHash } from '../src/scratchpad/image-state.js';
import { normaliseChange } from '../public/scripts/scratchpad/proposals.js';

const SOURCE = { kind: 'general', key: 'general', label: 'General Scratchpad', avatar: 'Nova.png', contextMode: 'roleplay', personaId: 'User.png' };
const fence = change => '```scratchpad-change\n' + JSON.stringify(change) + '\n```';
let serial = 0;

function account(t, { change = {}, qig = {}, source = SOURCE, targets = [{ avatar: 'Nova.png', name: 'Nova' }], generatedImage = png, preceding = [], metadata = null } = {}) {
    const f = fixture(t, false, 'image-owner');
    const directories = f.scope.directories;
    directories.userImages = path.join(directories.root, 'user/images');
    directories.avatars = path.join(directories.root, 'User Avatars');
    directories.thumbnailsPersona = path.join(directories.root, 'thumbnails/persona');
    directories.thumbnailsPersonaMobile = path.join(directories.root, 'thumbnails/persona-mobile');
    fs.mkdirSync(directories.avatars, { recursive: true });
    fs.writeFileSync(path.join(directories.avatars, 'User.png'), png);
    const settings = { extension_settings: { 'quick-image-gen': { provider: 'together', togetherKey: 'not-a-real-provider-key', togetherModel: 'mock-image',
        width: 512, height: 768, seed: 37, style: 'none', appendQuality: true, qualityTags: 'QUALITY', useSTStyle: true, negativePrompt: 'BASE-NEGATIVE', reviewBeforeGenerate: false, ...qig },
    sd: { prompt_prefix: 'GLOBAL-STYLE', negative_prompt: 'GLOBAL-NEGATIVE' } }, power_user: { personas: { 'User.png': 'Kris' }, persona_descriptions: { 'User.png': { description: 'EXPLICIT-PERSONA' } } } };
    const saveSettings = () => fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify(settings));
    saveSettings();
    const request = { user: { profile: { handle: f.scope.owner }, directories }, get: () => undefined };
    const base = store.scratchpadAccountBase(request);
    const mutate = operation => store.mutateBucket(base, source, operation);
    const read = () => store.withScratchpad(base, lease => store.readBucketLocked(lease, source));
    const proposal = { type: 'image', action: 'generate', target: 'image', prompt: 'An observatory.', ...change };
    const session = mutate(bucket => {
        const session = store.createSession(bucket);
        session.messages.push(...structuredClone(preceding), { id: 'reply', role: 'assistant', state: 'done', text: fence(proposal), contextSource: source,
            targets, sharedAvatar: source.avatar, sharedPersona: { avatar: 'User.png', name: 'Kris' }, imageNames: { user: 'Kris', character: 'Nova' }, imagePersonaId: 'User.png' });
        return session;
    });
    const body = { source, sessionId: session.id, messageId: 'reply', index: 0, submissionKey: `image-${++serial}` };
    setDirectoriesResolver(() => directories);
    const calls = [];
    registerScratchpadImageJobs({ generate: (context, options) => generateQuickImageGenJobImage(context, { ...options,
        fetch: async (url, request) => {
            if (url.startsWith('data:')) return new Response(Buffer.from(url.split(',')[1], 'base64'), { headers: { 'Content-Type': 'image/png' } });
            if (url.endsWith('/endpoints')) return Response.json(metadata);
            const body = request.body instanceof FormData ? Object.fromEntries(request.body) : JSON.parse(request.body);
            calls.push({ url, body, headers: request.headers });
            return Response.json({ data: [{ b64_json: generatedImage.toString('base64') }], images: [generatedImage.toString('base64')],
                output: [{ type: 'image_generation_call', status: 'completed', result: generatedImage.toString('base64') }],
                candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: generatedImage.toString('base64') } }] } }] });
        } }) });
    const accept = extra => acceptScratchpadImage(request, { ...body, ...extra });
    const run = accepted => runner.runJob(getJob(directories, accepted.job.id));
    const image = () => read().sessions[0].messages.find(message => message.id === 'reply').images?.[0];
    return { f, directories, base, request, source, settings, saveSettings, mutate, read, session, body, accept, run, image, calls };
}

const attachedImage = { id: 'upload', role: 'user', state: 'done', text: 'Make the roof blue.', attachments: [
    { kind: 'image', name: 'observatory.png', size: png.length, dataUrl: `data:image/png;base64,${png.toString('base64')}` },
] };
const editSource = { messageId: 'upload', kind: 'attachment', index: 0 };
const gptSettings = { provider: 'gptimage', gptImageKey: 'fixture-image-key', gptImageModel: 'gpt-image-1' };

test('an attachment edit sends its exact pixels to GPT Image edits once and keeps saved settings', async t => {
    const a = account(t, { qig: gptSettings, preceding: [attachedImage], change: { action: 'edit', source: editSource } });
    const settingsBefore = fs.readFileSync(path.join(a.directories.root, 'settings.json'), 'utf8');
    assert.equal(readScratchpadImageAvailability(a.base).edit, true);
    const accepted = await a.accept({ sourceImage: 'https://ignored.invalid/image.png', prompt: 'Ignored browser prompt' });
    await a.run(accepted);
    assert.equal(getJob(a.directories, accepted.job.id).state, 'completed', a.image()?.error);
    assert.equal(a.calls.length, 1);
    assert.equal(a.calls[0].url, 'https://api.openai.com/v1/images/edits');
    assert.equal(a.calls[0].headers['Content-Type'], undefined);
    assert.deepEqual(Buffer.from(await a.calls[0].body.image.arrayBuffer()), png);
    assert.match(a.calls[0].body.prompt, /An observatory/);
    assert.doesNotMatch(a.calls[0].body.prompt, /Ignored/);
    assert.equal((await a.accept({ submissionKey: 'duplicate-edit' })).job.id, accepted.job.id);
    await a.run(accepted);
    assert.equal(a.calls.length, 1);
    assert.equal(fs.readFileSync(path.join(a.directories.root, 'settings.json'), 'utf8'), settingsBefore);
});

test('a saved image edit sends the full verified original through Responses and preserves it', async t => {
    const previousChange = normaliseChange({ type: 'image', action: 'generate', target: 'image', prompt: 'Original' });
    const url = '/user/images/Scratchpad/scratchpad-original.png';
    const prior = { id: 'original', role: 'assistant', state: 'done', text: fence(previousChange), images: { 0: {
        id: 'picture', state: 'done', target: 'image', url, imageHash: createHash('sha256').update(png).digest('hex'), changeHash: imageChangeHash(previousChange),
    } } };
    const a = account(t, { qig: { ...gptSettings, gptImageModel: 'smol-openai/gpt-image-2.6-flare', gptImageProxyUrl: 'https://images.example/v1' },
        preceding: [prior], change: { action: 'edit', source: { messageId: 'original', kind: 'generated', index: 0 } } });
    const file = path.join(a.directories.root, url.slice(1));
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, png);
    const accepted = await a.accept();
    fs.appendFileSync(file, 'changed source');
    await a.run(accepted);
    assert.equal(getJob(a.directories, accepted.job.id).state, 'failed');
    assert.equal(a.calls.length, 0);
    fs.writeFileSync(file, png);
    updateJob(a.directories, accepted.job.id, { state: 'queued', error: null, finishedAt: null, ...explicitRetryRecovery(getJob(a.directories, accepted.job.id)) });
    await a.run(accepted);
    assert.equal(getJob(a.directories, accepted.job.id).state, 'completed', a.image()?.error);
    assert.equal(a.calls[0].url, 'https://images.example/v1/responses');
    assert.equal(a.calls[0].body.tools[0].action, 'edit');
    assert.equal(a.calls[0].body.input[0].content.find(part => part.type === 'input_image').image_url, attachedImage.attachments[0].dataUrl);
    assert.deepEqual(fs.readFileSync(file), png);
    assert.notEqual(a.image().url, url);
});

test('changed, missing, future and cross-session image sources stop before a provider request', async t => {
    for (const source of [{ ...editSource, messageId: 'other-session' }, { ...editSource, messageId: 'reply' }, { ...editSource, index: 1 }, { ...editSource, kind: 'generated' }]) {
        const a = account(t, { qig: gptSettings, preceding: [attachedImage], change: { action: 'edit', source } });
        await assert.rejects(a.accept(), /source image is missing or changed/);
        assert.equal(a.calls.length, 0);
    }
    const a = account(t, { qig: gptSettings, preceding: [attachedImage], change: { action: 'edit', source: editSource } });
    const accepted = await a.accept();
    a.mutate(bucket => { bucket.sessions[0].messages[0].attachments = []; });
    await a.run(accepted);
    assert.equal(getJob(a.directories, accepted.job.id).state, 'failed');
    assert.equal(a.calls.length, 0);
});

test('unsupported routes reject editing rather than silently generating from text', async t => {
    for (const qig of [{}, { provider: 'gptimage', gptImageKey: 'fixture-key', gptImageModel: 'dall-e-3' },
        { provider: 'proxy', proxyUrl: 'https://proxy.example/v1', proxyModel: 'image-model', proxyPayloadMode: 'openai_strict' },
        { provider: 'proxy', proxyUrl: 'https://proxy.example/v1', proxyModel: 'image-model', proxyRefImageMode: 'url_only' }]) {
        const a = account(t, { qig, preceding: [attachedImage], change: { action: 'edit', source: editSource } });
        assert.equal(readScratchpadImageAvailability(a.base).edit, false);
        await assert.rejects(a.accept(), /does not support Scratchpad image editing/);
        assert.equal(a.calls.length, 0);
    }
});

test('NanoGPT validates current model image support before any paid edit', async t => {
    for (const supported of [false, true]) {
        const a = account(t, { qig: { provider: 'nanogpt', nanogptKey: 'fixture-key', nanogptModel: 'test-model' },
            preceding: [attachedImage], change: { action: 'edit', source: editSource },
            metadata: { endpoints: [{ capabilities: { image_to_image: supported } }] } });
        const accepted = await a.accept();
        await a.run(accepted);
        assert.equal(getJob(a.directories, accepted.job.id).state, supported ? 'completed' : 'failed', a.image()?.error);
        assert.equal(a.calls.length, supported ? 1 : 0);
        if (supported) assert.deepEqual(a.calls[0].body.input_references, [attachedImage.attachments[0].dataUrl]);
    }
});

for (const [name, qig, pixels] of [
    ['Gemini', { provider: 'nanobanana', nanobananaKey: 'fixture-key', nanobananaModel: 'gemini-3-pro-image' }, body => body.contents[0].parts[0].inlineData.data],
    ['A1111', { provider: 'local', localType: 'a1111', localUrl: 'http://127.0.0.1:7860', a1111IpAdapter: true }, body => body.init_images[0]],
    ['Custom', { provider: 'custom', customApiMode: 'json', customApiUrl: 'https://custom.example.com/image',
        customApiRequestTemplate: '{"prompt":"{{prompt}}","image":"{{firstReferenceImage}}"}', customApiResponsePath: '/images/0', customApiResponseType: 'base64' }, body => body.image.split(',')[1]],
    ['Proxy', { provider: 'proxy', proxyUrl: 'https://proxy.example/v1', proxyModel: 'image-model', proxyPayloadMode: 'extended' }, body => body.image[0].split(',')[1]],
    ['Proxy chat', { provider: 'proxy', proxyUrl: 'https://proxy.example/v1', proxyModel: 'image-model', proxyEndpointMode: 'chat_completions' }, body => body.messages[0].content.find(part => part.type === 'image_url').image_url.url.split(',')[1]],
    ['Proxy Responses', { provider: 'proxy', proxyUrl: 'https://proxy.example/v1', proxyModel: 'gpt-image-2.6-flare' }, body => body.input[0].content.find(part => part.type === 'input_image').image_url.split(',')[1]],
]) test(`${name} editing passes the selected attachment through the shared provider route`, async t => {
    const a = account(t, { qig, preceding: [attachedImage], change: { action: 'edit', source: editSource } });
    const accepted = await a.accept();
    await a.run(accepted);
    assert.equal(getJob(a.directories, accepted.job.id).state, 'completed', a.image()?.error);
    assert.equal(a.calls.length, 1);
    assert.equal(pixels(a.calls[0].body), png.toString('base64'));
    if (name === 'A1111') assert.match(a.calls[0].url, /\/sdapi\/v1\/img2img$/);
});

test('persona avatar uses global settings, preserves a backup and rejects changes after review', async t => {
    const a = account(t, { change: { target: 'persona-avatar', persona: 'Kris' } });
    const original = fs.readFileSync(path.join(a.directories.avatars, 'User.png'));
    const accepted = await a.accept();
    await a.run(accepted);
    assert.equal(getJob(a.directories, accepted.job.id).state, 'completed');
    assert.equal(a.calls[0].body.width, 512);
    const review = await prepareScratchpadAvatarReview(a.base, a.source, a.body);
    assert.equal(review.kind, 'persona');
    assert.deepEqual(fs.readFileSync(path.join(a.directories.root, review.currentUrl.slice(1))), original);
    fs.appendFileSync(path.join(a.directories.avatars, 'User.png'), 'changed');
    await assert.rejects(saveScratchpadPersonaAvatar(a.base, { ...a.body, avatar: 'User.png', revision: review.revision }), /changed after review/);
    fs.writeFileSync(path.join(a.directories.avatars, 'User.png'), original);
    await saveScratchpadPersonaAvatar(a.base, { ...a.body, avatar: 'User.png', revision: review.revision });
    assert.deepEqual(fs.readFileSync(path.join(a.directories.root, review.currentUrl.slice(1))), original);
    assert.equal(a.calls.length, 1);
});

test('persona image refuses revoked sharing, missing capture and renamed personas', async t => {
    const a = account(t, { change: { target: 'persona-avatar', persona: 'Kris' } });
    a.mutate(bucket => { bucket.sessions[0].settings.include.persona = false; });
    await assert.rejects(a.accept(), /original persona/);
    a.mutate(bucket => { bucket.sessions[0].settings.include.persona = true; delete bucket.sessions[0].messages[0].sharedPersona; });
    await assert.rejects(a.accept(), /original persona/);
    a.mutate(bucket => { bucket.sessions[0].messages[0].sharedPersona = { avatar: 'User.png', name: 'Kris' }; });
    a.settings.power_user.personas['User.png'] = 'Renamed'; a.saveSettings();
    await assert.rejects(a.accept(), /original persona/);
    assert.equal(a.calls.length, 0);
});

test('Scenario Note images keep their full saved picture and refuse stale or revoked notes', async t => {
    const generatedImage = await new Jimp({ width: 1200, height: 1600, color: 0x7799aaff }).getBuffer('image/png');
    const a = account(t, { change: { target: 'persona-note-avatar', persona: 'Kris', noteId: 'winter' }, generatedImage });
    const descriptor = a.settings.power_user.persona_descriptions['User.png'];
    descriptor.appendices = [{ id: 'winter', name: 'Winter', description: 'Snowy clothes' }];
    a.saveSettings();
    const accepted = await a.accept();
    await a.run(accepted);
    assert.equal(getJob(a.directories, accepted.job.id).state, 'completed');
    assert.equal(a.image().target, 'persona-note-avatar');
    const review = await prepareScratchpadAvatarReview(a.base, a.source, a.body);
    assert.equal(review.kind, 'persona-note');
    assert.equal(review.noteId, 'winter');
    assert.equal(review.avatarValue, '');
    assert.match(review.proposedAvatar, /^\/user\/images\/Scratchpad\/scratchpad-[a-z0-9-]+\.png$/);
    assert.equal(review.proposedAvatar, review.proposedUrl);
    assert.deepEqual(fs.readFileSync(path.join(a.directories.root, review.proposedAvatar.slice(1))), generatedImage);
    const decoded = await decodeServerImage(fs.readFileSync(path.join(a.directories.root, review.proposedAvatar.slice(1))));
    assert.equal(decoded.width, 1200);
    assert.equal(decoded.height, 1600);
    assert.equal((await prepareScratchpadAvatarReview(a.base, a.source, a.body)).proposedAvatar, review.proposedAvatar);
    assert.equal(descriptor.appendices[0].avatar, undefined);
    assert.deepEqual(fs.readFileSync(path.join(a.directories.avatars, 'User.png')), png);
    descriptor.appendices[0].avatar = review.proposedAvatar; a.saveSettings();
    const changed = await prepareScratchpadAvatarReview(a.base, a.source, a.body);
    assert.equal(changed.avatarValue, review.proposedAvatar);
    assert.notEqual(changed.revision, review.revision);
    a.mutate(bucket => { bucket.sessions[0].settings.include.persona = false; });
    await assert.rejects(prepareScratchpadAvatarReview(a.base, a.source, a.body), /original persona/);
    a.mutate(bucket => { bucket.sessions[0].settings.include.persona = true; });
    descriptor.appendices = []; a.saveSettings();
    await assert.rejects(prepareScratchpadAvatarReview(a.base, a.source, a.body), /no longer exists/);
    assert.equal(a.calls.length, 1);
});

test('explicit global settings restore the saved base, never the last selected card or its references', () => {
    const raw = { width: 1024, height: 1024, style: 'character-style', customApiRefImages: ['/user/images/private-card.png'],
        _charSettingsBaseState: { width: 512, height: 768, style: 'none', customApiRefImages: [] }, _backupCharSettings: { 'card:nova.png': { width: 256 } } };
    assert.deepEqual(resolveCharacterImageSettings(raw, { kind: 'global' }).customApiRefImages, []);
    assert.equal(resolveCharacterImageSettings(raw, { kind: 'global' }).width, 512);
    assert.equal(resolveCharacterImageSettings(raw, { avatar: 'Nova.png' }).width, 256);
    assert.equal(resolveCharacterImageSettings(raw), raw);
});

test('availability is server-derived, disabled and unsupported providers expose no secrets', t => {
    const a = account(t);
    assert.equal(readScratchpadImageAvailability(a.base).image, true);
    a.settings.extension_settings.disabledExtensions = ['quick-image-gen']; a.saveSettings();
    assert.equal(readScratchpadImageAvailability(a.base).image, false);
    assert.equal(JSON.stringify(readScratchpadImageAvailability(a.base)).includes('not-a-real-provider-key'), false);
    a.settings.extension_settings.disabledExtensions = [];
    a.settings.extension_settings['quick-image-gen'].provider = 'unsupported'; a.saveSettings();
    assert.equal(readScratchpadImageAvailability(a.base).image, false);
});

test('one saved proposal accepts once, completes without a chat file and survives reopening and edits', async t => {
    const a = account(t);
    fs.rmSync(a.directories.chats, { recursive: true });
    const before = fs.readFileSync(path.join(a.directories.characters, 'Nova.png'));
    const accepted = await a.accept();
    assert.equal((await a.accept()).job.id, accepted.job.id);
    assert.equal((await a.accept({ submissionKey: 'another-key' })).job.id, accepted.job.id);
    await a.run(accepted);
    assert.equal(getJob(a.directories, accepted.job.id).state, 'completed');
    assert.equal(a.calls.length, 1);
    assert.match(a.calls[0].body.prompt, /GLOBAL-STYLE.*QUALITY.*An observatory/);
    assert.doesNotMatch(a.calls[0].body.prompt, /Original|EXPLICIT-PERSONA/);
    assert.equal(a.calls[0].body.width, 512);
    assert.match(a.image().url, /^\/user\/images\/Scratchpad\/scratchpad-/);
    assert.equal(a.image().state, 'done');
    assert.equal(a.image().width, 1);
    assert.deepEqual(fs.readFileSync(path.join(a.directories.characters, 'Nova.png')), before);
    const filename = path.join(a.directories.root, a.image().url.slice(1));
    assert.deepEqual(fs.readFileSync(filename), png);
    a.mutate(bucket => store.updateMessage(bucket, a.session.id, 'reply', 'More prose.\n' + fence({ type: 'image', action: 'generate', target: 'image', prompt: 'An observatory.' })));
    assert.equal(a.image().url, '/' + path.relative(a.directories.root, filename));
    assert.throws(() => a.mutate(bucket => store.updateMessage(bucket, a.session.id, 'reply', fence({ type: 'image', action: 'generate', target: 'image', prompt: 'A different scene.' }))), /original order/);
    assert.equal(JSON.stringify(readArtifact(a.directories, accepted.job.id, 'request')).includes('not-a-real-provider-key'), false);
});

test('pending image work protects editing, deletion, clearing, temporary sessions and cleanup', async t => {
    const a = account(t);
    await a.accept();
    for (const operation of [bucket => store.deleteMessage(bucket, a.session.id, 'reply'), bucket => store.deleteSession(bucket, a.session.id),
        bucket => store.clearSession(bucket, a.session.id), bucket => store.updateMessage(bucket, a.session.id, 'reply', 'Changed.')]) {
        assert.throws(() => a.mutate(operation), { code: 'SCRATCHPAD_REPLY_PENDING' });
    }
    a.mutate(bucket => { bucket.sessions[0].temporary = true; store.createSession(bucket); });
    assert.equal(a.read().sessions.length, 2);
    const bucket = a.read();
    bucket.cleanup = { enabled: true, keep: 1 };
    store.applyCleanup(bucket);
    assert.ok(bucket.sessions.some(session => session.id === a.session.id));
});

test('a queued cancellation is projected and does not leave its proposal permanently pending', async t => {
    const a = account(t);
    const accepted = await a.accept();
    requestCancellation(a.directories, accepted.job.id, { reason: 'test' });
    const bucket = store.projectPending(a.read(), id => getJob(a.directories, id));
    assert.equal(bucket.sessions[0].messages[0].images[0].state, 'cancelled');
});

test('saved prompt review sees fully processed settings and no provider runs before approval', async t => {
    const a = account(t, { qig: { reviewBeforeGenerate: true }, change: { negative: 'EXTRA-NEGATIVE' } });
    const accepted = await a.accept();
    assert.equal(accepted.bucket.sessions[0].messages[0].images[0].review, true);
    await a.run(accepted);
    let job = getJob(a.directories, accepted.job.id);
    assert.equal(job.stage, 'approval');
    assert.equal(a.calls.length, 0);
    const approval = readJobApproval({ ...a.base, job }, job.result.approval.id);
    assert.match(approval.proposal.prompt, /GLOBAL-STYLE.*QUALITY.*An observatory/);
    assert.match(approval.proposal.negative, /BASE-NEGATIVE.*EXTRA-NEGATIVE/);
    decideJobApproval({ ...a.base, job }, { ...approval, decision: 'allow' });
    assert.equal(store.projectPending(a.read(), id => getJob(a.directories, id)).sessions[0].messages[0].images[0].review, false);
    await a.run(accepted);
    assert.equal(a.calls.length, 1);
    assert.equal(a.image().state, 'done');
});

test('declining prompt review keeps the card and costs no provider call', async t => {
    const a = account(t, { qig: { reviewBeforeGenerate: true } });
    const accepted = await a.accept(); await a.run(accepted);
    const job = getJob(a.directories, accepted.job.id);
    const approval = readJobApproval({ ...a.base, job }, job.result.approval.id);
    decideJobApproval({ ...a.base, job }, { ...approval, decision: 'deny' });
    await a.run(accepted);
    assert.equal(a.calls.length, 0);
    assert.equal(a.image().state, 'cancelled');
});

test('a cancelled attempt that never reached the provider starts a fresh job', async t => {
    const a = account(t);
    const first = await a.accept();
    requestCancellation(a.directories, first.job.id, { reason: 'test' });
    assert.equal(store.projectPending(a.read(), id => getJob(a.directories, id)).sessions[0].messages[0].images[0].state, 'cancelled');
    const second = await a.accept({ submissionKey: 'fresh-after-cancel' });
    assert.notEqual(second.job.id, first.job.id);
    await a.run(second);
    assert.equal(a.calls.length, 1);
    assert.equal(a.image().state, 'done');
    assert.equal(a.image().jobId, second.job.id);
});

test('a declined prompt review that never reached the provider starts a fresh job', async t => {
    const a = account(t, { qig: { reviewBeforeGenerate: true } });
    const first = await a.accept(); await a.run(first);
    const job = getJob(a.directories, first.job.id);
    const approval = readJobApproval({ ...a.base, job }, job.result.approval.id);
    decideJobApproval({ ...a.base, job }, { ...approval, decision: 'deny' });
    await a.run(first);
    assert.equal(a.image().state, 'cancelled');
    assert.equal(a.calls.length, 0);
    const second = await a.accept({ submissionKey: 'fresh-after-decline' });
    assert.notEqual(second.job.id, first.job.id);
    await a.run(second);
    const secondJob = getJob(a.directories, second.job.id);
    assert.equal(secondJob.stage, 'approval');
    const secondApproval = readJobApproval({ ...a.base, job: secondJob }, secondJob.result.approval.id);
    decideJobApproval({ ...a.base, job: secondJob }, { ...secondApproval, decision: 'allow' });
    await a.run(second);
    assert.equal(a.calls.length, 1);
    assert.equal(a.image().state, 'done');
});

test('a queued submission stopped while polling does not start a fresh paid job', async t => {
    const a = account(t);
    const first = await a.accept();
    // A queued provider saves its submit receipt and keeps polling; stopping leaves no final image.
    const request = readArtifact(a.directories, first.job.id, 'request');
    const submit = `provider:quick-image:${request.effectId}:submit`;
    writeArtifact(a.directories, first.job.id, submit, { id: 'queued-1', sourceHash: 'hash' });
    setJobResume(a.directories, first.job.id, submit);
    updateJob(a.directories, first.job.id, { state: 'cancelled', stage: null, finishedAt: Date.now() });
    assert.equal(store.projectPending(a.read(), id => getJob(a.directories, id)).sessions[0].messages[0].images[0].state, 'cancelled');
    const second = await a.accept({ submissionKey: 'fresh-after-queued-cancel' });
    assert.equal(second.created, false);
    assert.equal(second.job.id, first.job.id);
    assert.equal(a.calls.length, 0);
});

test('a pruned finished image cannot start a fresh paid job', async t => {
    const a = account(t);
    const first = await a.accept(); await a.run(first);
    assert.equal(a.image().state, 'done');
    assert.equal(a.image().providerReached, true);
    mutateJobs(a.directories, store_ => { delete store_.jobs[jobKey(first.job.id)]; });
    await assert.rejects(a.accept({ submissionKey: 'fresh-after-pruned-finished' }), /may already have been sent/);
    assert.equal(a.calls.length, 1);
});

test('a pruned unknown provider outcome cannot start a fresh paid job', async t => {
    const a = account(t);
    registerScratchpadImageJobs({ generate: (context, options) => generateQuickImageGenJobImage(context, { ...options,
        fetch: async () => { throw new Error('lost network'); } }) });
    const first = await a.accept(); await a.run(first);
    assert.equal(a.image().state, 'failed');
    assert.equal(a.image().providerReached, true);
    mutateJobs(a.directories, store_ => { delete store_.jobs[jobKey(first.job.id)]; });
    await assert.rejects(a.accept({ submissionKey: 'fresh-after-pruned-unknown' }), /may already have been sent/);
});

test('a pruned cancellation that never reached the provider may start a fresh job', async t => {
    const a = account(t);
    const first = await a.accept();
    assert.equal(a.image().providerReached, false);
    requestCancellation(a.directories, first.job.id, { reason: 'test' });
    mutateJobs(a.directories, store_ => { delete store_.jobs[jobKey(first.job.id)]; });
    const second = await a.accept({ submissionKey: 'fresh-after-pruned-free' });
    assert.equal(second.created, true);
    assert.notEqual(second.job.id, first.job.id);
    await a.run(second);
    assert.equal(a.calls.length, 1);
    assert.equal(a.image().state, 'done');
});

test('avatar generation does not change the card; review preserves its complete PNG and target revision', async t => {
    const a = account(t, { change: { target: 'avatar', character: 'Nova' } });
    const before = fs.readFileSync(path.join(a.directories.characters, 'Nova.png'));
    const accepted = await a.accept(); await a.run(accepted);
    assert.deepEqual(fs.readFileSync(path.join(a.directories.characters, 'Nova.png')), before);
    const review = await prepareScratchpadAvatarReview(a.base, a.source, a.body);
    assert.deepEqual(fs.readFileSync(path.join(a.directories.root, review.currentUrl.slice(1))), before);
    assert.equal(a.image().previousAvatarRevision, review.revision);
    // The writer installs the server's own saved proposal, never bytes sent by the browser.
    const proposedBytes = store.withScratchpad(a.base, lease => assertScratchpadAvatarWriteLocked(lease, JSON.stringify(a.body), 'Nova.png', review.revision));
    assert.deepEqual(proposedBytes, fs.readFileSync(path.join(a.directories.root, a.image().url.slice(1))));
    await assert.rejects(prepareScratchpadAvatarReview(a.base, { ...a.source, personaId: 'Other.png' }, a.body), /original General context/);
    a.mutate(bucket => store.updateSession(bucket, a.session.id, { settings: { include: { card: false } } }));
    assert.throws(() => store.withScratchpad(a.base, lease => assertScratchpadAvatarWriteLocked(lease, JSON.stringify(a.body), 'Nova.png', review.revision)), /Share the character/);
});

test('the reviewed avatar picture must be unchanged, present and readable before it can be installed', async t => {
    const a = account(t, { change: { target: 'avatar', character: 'Nova' } });
    await a.run(await a.accept());
    const review = await prepareScratchpadAvatarReview(a.base, a.source, a.body);
    const proposed = path.join(a.directories.root, review.proposedUrl.slice(1));
    const assertWrite = () => store.withScratchpad(a.base, lease => assertScratchpadAvatarWriteLocked(lease, JSON.stringify(a.body), 'Nova.png', review.revision));
    // A swapped file no longer matches the reviewed hash.
    fs.writeFileSync(proposed, writeCard(png, JSON.stringify({ name: 'Nova', description: 'Swapped.' })));
    assert.throws(assertWrite, /changed after review/);
    // A removed file is reported clearly.
    fs.unlinkSync(proposed);
    assert.throws(assertWrite, /no longer available/);
    // A symbolic link is never followed.
    const elsewhere = path.join(a.directories.root, 'elsewhere.png');
    fs.writeFileSync(elsewhere, png);
    fs.symlinkSync(elsewhere, proposed);
    assert.throws(assertWrite, /could not be read/);
});

test('missing, unshared, ambiguous and switched targets refuse before provider dispatch', async t => {
    for (const extra of [{ targets: [] }, { source: { ...SOURCE, avatar: 'Missing.png' }, targets: [{ avatar: 'Missing.png', name: 'Nova' }] },
        { targets: [{ avatar: 'Nova.png', name: 'Nova' }, { avatar: 'Nova.png', name: 'Nova' }] }]) {
        const a = account(t, { change: { target: 'avatar', character: 'Nova' }, ...extra });
        await assert.rejects(a.accept(), /share|character|unambiguous|original/i);
        assert.equal(a.calls.length, 0);
    }
});

test('chat targets are derived from canonical membership, not forged browser names or another card', t => {
    const a = account(t);
    fs.writeFileSync(path.join(a.directories.characters, 'Kit.png'), writeCard(png, JSON.stringify({ name: 'Kit' })));
    store.withScratchpad(a.base, lease => {
        // A forged target is ignored rather than thrown: it must never capture authority or block a text reply.
        assert.deepEqual(captureImageTargetsLocked(lease, SOURCE, [{ avatar: 'Kit.png', name: 'Kit' }]), []);
        assert.deepEqual(captureImageTargetsLocked(lease, SOURCE, [{ avatar: 'Nova.png', name: 'Forged' }]), []);
        assert.deepEqual(captureImageTargetsLocked(lease, SOURCE, [{ avatar: 'Nova.png', name: 'Nova' }]), [{ avatar: 'Nova.png', name: 'Nova' }]);
        assert.throws(() => resolveImageTargetLocked(lease, SOURCE, { targets: [{ avatar: 'Nova.png', name: 'Nova' }] }, 'Forged'), /did not share/);
    });
});

test('editing settings after acceptance refuses dispatch rather than using a different provider configuration', async t => {
    const a = account(t);
    const accepted = await a.accept();
    a.settings.extension_settings['quick-image-gen'].width = 1024; a.saveSettings();
    await a.run(accepted);
    assert.equal(a.calls.length, 0);
    assert.equal(a.image().state, 'failed');
});

test('a lost provider outcome is never purchased again by retrying its saved job', async t => {
    const a = account(t);
    let calls = 0;
    registerScratchpadImageJobs({ generate: (context, options) => generateQuickImageGenJobImage(context, { ...options, fetch: async () => { calls++; throw new Error('lost network'); } }) });
    const accepted = await a.accept(); await a.run(accepted);
    assert.throws(() => assertScratchpadImageRetry(a.directories, getJob(a.directories, accepted.job.id)), { code: 'SCRATCHPAD_IMAGE_OUTCOME_UNKNOWN' });
    assert.equal(calls, 1);
    assert.equal(a.image().state, 'failed');
});

test('imports retain only image prompt text, never receipts, target permissions, running jobs or previous pictures', t => {
    const a = account(t);
    const imported = a.mutate(bucket => store.createSession(bucket, { messages: [{ role: 'assistant', text: fence({ type: 'image', action: 'generate', target: 'image', prompt: 'Imported idea.' }),
        images: { 0: { state: 'pending', jobId: 'untrusted' } }, targets: [{ avatar: 'Nova.png', name: 'Nova' }], sharedAvatar: 'Nova.png' }] }));
    assert.equal(imported.messages[0].images, undefined);
    assert.equal(imported.messages[0].targets, undefined);
    assert.equal(imported.messages[0].sharedAvatar, undefined);
});

test('rejects non-canonical proposal indices so one proposal cannot purchase multiple retained images', async t => {
    const a = account(t);
    await assert.rejects(a.accept({ index: '00' }), /finished assistant/);
    assert.equal(a.calls.length, 0);
});

test('global filters ignore unrelated card/roster rules while named scopes retain their strict checks', () => {
    const settings = { _backupContextualFilters: [
        { id: 'global', scope: 'global', keywords: 'moon', positive: 'GLOBAL-FILTER', enabled: true },
        { id: 'card', scope: 'card', cardKey: 'private.png', keywords: 'moon', positive: 'PRIVATE-CARD', enabled: true },
        { id: 'roster', scope: 'char', charId: '4', keywords: 'moon', positive: 'PRIVATE-ROSTER', enabled: true },
    ] };
    const global = { quickImageGenCharacterScope: { kind: 'global' }, macros: { names: { user: 'User', char: '' }, messages: [], extra: {} } };
    const environment = createMacroEnvironment(global.macros, {}, { readOnly: true });
    assert.deepEqual(resolveSavedImageFilters(settings, global, 'moon', environment).keyword.map(filter => filter.id), ['global']);
    assert.throws(() => resolveSavedImageFilters(settings, { ...global, quickImageGenCharacterScope: { avatar: 'Nova.png' }, speaker: { avatar: 'Nova.png' } }, 'moon', environment), /roster ID/);
});

test('a saved binary result recovers failed local publication without another provider request, even after settings change', async t => {
    const a = account(t);
    const accepted = await a.accept();
    const outside = path.join(a.f.root, 'outside-images'); fs.mkdirSync(outside);
    fs.mkdirSync(path.dirname(a.directories.userImages), { recursive: true });
    fs.symlinkSync(outside, a.directories.userImages);
    await a.run(accepted);
    assert.equal(a.calls.length, 1);
    assert.equal(a.image().state, 'failed');
    fs.unlinkSync(a.directories.userImages);
    a.settings.extension_settings['quick-image-gen'].togetherKey = 'changed-not-real-key'; a.saveSettings();
    const failed = getJob(a.directories, accepted.job.id);
    assertScratchpadImageRetry(a.directories, failed);
    updateJob(a.directories, accepted.job.id, { state: 'queued', error: null, finishedAt: null, ...explicitRetryRecovery(failed) });
    await a.run(accepted);
    assert.equal(a.image().state, 'done');
    assert.equal(a.calls.length, 1);
});

test('a changed signed-in account cannot accept or review another account\'s image', async t => {
    const a = account(t);
    await assert.rejects(acceptScratchpadImage({ ...a.request, get: () => 'other-user' }, a.body), { code: 'ACCOUNT_CHANGED' });
    assert.equal(a.calls.length, 0);
});

test('group target permissions are rechecked atomically by avatar writes after a member is removed', async t => {
    const source = { kind: 'roleplay', key: 'group:group:Source', label: 'Group', scope: { kind: 'group', id: 'group' } };
    const a = account(t, { source, change: { target: 'avatar', character: 'Nova' } });
    const accepted = await a.accept(); await a.run(accepted);
    const review = await prepareScratchpadAvatarReview(a.base, source, a.body);
    fs.writeFileSync(path.join(a.directories.groups, 'group.json'), JSON.stringify({ id: 'group', members: [], chats: ['Source'] }));
    assert.throws(() => store.withScratchpad(a.base, lease => assertScratchpadAvatarWriteLocked(lease, JSON.stringify(a.body), 'Nova.png', review.revision)), /does not belong/);
});
