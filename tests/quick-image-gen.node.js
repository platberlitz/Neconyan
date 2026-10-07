import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import test, { after } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const { generateQuickImageGenImage, saveQuickImageToUserImages, testExports } = await import('../src/generation/quick-image-gen.js');
const { generateQuickImageGenJobImage, quickImageGenSettingsFingerprint } = await import('../src/generation/quick-image-gen-job.js');
const { prepareConversationScopedImagePrompt } = await import('../src/generation/quick-image-gen-scoped.js');
const { buildConversationImagePrompt, conversationReplyWantsImage, createConversationImageGenerator, lastUserMessageText, testExports: imageTestExports } = await import('../src/generation/conversation-images.js');
const { providerStep, readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');
const { readImageArtifact, writeImageArtifact } = await import('../src/jobs/image-artifacts.js');
const { acceptJob, getJob, jobKey, recoverJobs, updateJob } = await import('../src/jobs/store.js');
const { captureConversationTarget } = await import('../src/generation/conversation-effects.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { initialiseRoleplayAccount, roleplayAccountStamp } = await import('../src/roleplay-store.js');
const { buildSelfieImagePromptTemplate } = await import('../public/scripts/neconyan-conversation/generation-utils.js');
const { DEFAULT_SETTINGS } = await import('../public/scripts/neconyan-conversation/constants.js');

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

function novelaiZip(png, compressed = true) {
    const filename = Buffer.from('images/0.png');
    const data = compressed ? deflateRawSync(png) : png;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(compressed ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(png.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(compressed ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(png.length, 24);
    central.writeUInt16LE(filename.length, 28);
    const offset = local.length + filename.length + data.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + filename.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([local, filename, data, central, filename, end]);
}

const createdRoots = [];
after(() => {
    cancelAutoSaves();
    for (const root of createdRoots) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-qig-'));
    createdRoots.push(parent);
    const root = path.join(parent, 'alice');
    fs.mkdirSync(root);
    const directories = { root, userImages: path.join(root, 'user', 'images') };
    fs.mkdirSync(directories.userImages, { recursive: true });
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ _version: 0,
        extension_settings: { 'quick-image-gen': togetherSettings } }));
    initialiseRoleplayAccount({ owner: 'alice', directories });
    return directories;
}

function savedImageInput(directories, options) {
    return { ...options, owner: 'alice', account: roleplayAccountStamp({ owner: 'alice', directories }) };
}

function saveImageSettings(directories, settings) {
    const file = path.join(directories.root, 'settings.json');
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    current.extension_settings['quick-image-gen'] = settings;
    fs.writeFileSync(file, JSON.stringify(current));
}

function saveSDSettings(directories, sd) {
    const file = path.join(directories.root, 'settings.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.extension_settings.sd = sd;
    fs.writeFileSync(file, JSON.stringify(saved));
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let submission = 0;
function jobContext(directories) {
    const { job } = acceptJob(directories, { owner: 'alice', type: 'conversation.participant', submissionKey: `image-${submission++}`, intent: {} });
    return { directories, job, signal: new AbortController().signal, owner: 'alice' };
}

const togetherSettings = { provider: 'together', togetherKey: 'private-key', togetherModel: 'test-image', seed: -1 };
const imageRequest = { effectId: 'image:0:0', prompt: 'Nova under the stars', negative: 'blur',
    settingsFingerprint: quickImageGenSettingsFingerprint(togetherSettings) };

function scopedSnapshot(directories) {
    const extensions = JSON.parse(fs.readFileSync(path.join(directories.root, 'settings.json'), 'utf8')).extension_settings;
    return { speaker: { avatar: 'Nova.png', name: 'Nova' }, target: { groupId: null },
        quickImageGenSettingsFingerprint: quickImageGenSettingsFingerprint(extensions['quick-image-gen']),
        quickImageGenSDSettingsFingerprint: quickImageGenSettingsFingerprint(extensions.sd || {}),
        macros: { names: { char: 'Nova', user: 'Ari' }, variables: { global: {}, local: {} },
            extra: { characterAvatar: 'Nova.png', character: { name: 'Nova', avatar: 'Nova.png',
                data: { name: 'Nova', extensions: {} } } } },
    };
}

test('scoped Conversation images save style, quality and character SD prompts before paying', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    const settings = { ...togetherSettings, style: 'cinematic', qualityTags: 'high quality, clear detail',
        appendQuality: true, useSTStyle: true };
    const sd = { prompt_prefix: 'painted {prompt}, {{char}}', negative_prompt: 'no grain',
        character_prompts: { Nova: 'silver hair' }, character_negative_prompts: { Nova: 'no watermark' } };
    saveImageSettings(directories, settings);
    saveSDSettings(directories, sd);
    const snapshot = scopedSnapshot(directories);
    const input = { effectId: 'scoped:style', prompt: 'gentle portrait', negative: 'fog', snapshot };
    const staged = await prepareConversationScopedImagePrompt(context, input);
    assert.match(staged.prompt, /cinematic.*gentle portrait/i);
    assert.match(staged.prompt, /high quality, clear detail/);
    assert.match(staged.prompt, /silver hair/);
    assert.match(staged.prompt, /Nova/);
    assert.match(staged.negative, /fog.*no grain.*no watermark/);
    const saved = readArtifact(directories, context.job.id, 'input:quick-image:scoped:style:scoped');
    assert.equal(saved.prompt, staged.prompt);
    assert.ok(!JSON.stringify(saved).includes('private-key'));
    let paid = 0;
    const image = await generateQuickImageGenJobImage(context, { effectId: input.effectId,
        prompt: staged.prompt, negative: staged.negative, settingsFingerprint: snapshot.quickImageGenSettingsFingerprint,
        expectedAccount: staged.account, assertSourceLocked: staged.assertSourceLocked,
        fetch: async (_url, options) => {
            paid++;
            const body = JSON.parse(options.body);
            assert.equal(body.prompt, staged.prompt);
            return jsonResponse({ data: [{ b64_json: PNG_BASE64 }] });
        } });
    assert.equal(image.base64, PNG_BASE64);
    assert.equal(paid, 1);
    saveImageSettings(directories, { ...settings, togetherKey: 'changed-provider-key' });
    saveSDSettings(directories, { ...sd, negative_prompt: 'changed-style' });
    const replay = await prepareConversationScopedImagePrompt(context, input);
    assert.equal(replay.prompt, staged.prompt);
    assert.deepEqual(await generateQuickImageGenJobImage(context, { effectId: input.effectId,
        prompt: replay.prompt, negative: replay.negative, settingsFingerprint: snapshot.quickImageGenSettingsFingerprint,
        expectedAccount: replay.account, assertSourceLocked: replay.assertSourceLocked,
        fetch: () => assert.fail('Cached paid scoped image repeated') }), image);
});

test('changing saved SD style before a scoped provider call refuses as a known pre-dispatch change', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    saveSDSettings(directories, { prompt_prefix: 'original {prompt}' });
    const snapshot = scopedSnapshot(directories);
    const input = { effectId: 'scoped:changed', prompt: 'portrait', snapshot };
    const staged = await prepareConversationScopedImagePrompt(context, input);
    saveSDSettings(directories, { prompt_prefix: 'different {prompt}' });
    await assert.rejects(generateQuickImageGenJobImage(context, { effectId: input.effectId,
        prompt: staged.prompt, negative: staged.negative, settingsFingerprint: snapshot.quickImageGenSettingsFingerprint,
        expectedAccount: staged.account, assertSourceLocked: staged.assertSourceLocked,
        fetch: () => assert.fail('Changed SD style dispatched') }), { code: 'QIG_SETTINGS_CHANGED' });
    assert.notEqual(getJob(directories, context.job.id).recoverability, 'unknown-outcome');
    assert.equal(readArtifact(directories, context.job.id, 'provider:quick-image:scoped:changed'), undefined);
    await assert.rejects(prepareConversationScopedImagePrompt(context, input), { code: 'QIG_SETTINGS_CHANGED' });
});

test('old accepted Conversation image snapshots keep their original unstyled prompts', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    saveImageSettings(directories, { ...togetherSettings, style: 'cinematic', appendQuality: true });
    const snapshot = scopedSnapshot(directories);
    delete snapshot.quickImageGenSDSettingsFingerprint;
    const staged = await prepareConversationScopedImagePrompt(context, {
        effectId: 'scoped:legacy', prompt: 'unchanged image', negative: 'fog', snapshot,
    });
    assert.equal(staged.prompt, 'unchanged image');
    assert.equal(staged.negative, 'fog');
});

test('enabled saved contextual filters require an admitted model connection before a scoped image', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    saveImageSettings(directories, { ...togetherSettings,
        _backupContextualFilters: [{ id: 'saved-filter', enabled: true, matchMode: 'LLM',
            description: 'A portrait of the character', keywords: 'portrait' }],
        _backupActiveFilterPoolIdsGlobal: ['qig_pool_default_global'] });
    const snapshot = scopedSnapshot(directories);
    await assert.rejects(prepareConversationScopedImagePrompt(context, {
        effectId: 'scoped:filters', prompt: 'portrait', snapshot,
    }), { code: 'QIG_CLASSIFIER_BINDING' });
    assert.equal(readArtifact(directories, context.job.id, 'provider:quick-image:scoped:filters'), undefined);
    assert.notEqual(getJob(directories, context.job.id).recoverability, 'unknown-outcome');
});

test('saved image filter classifier applies selected text and the highest-priority seed once', async () => {
    const directories = tempRoot();
    const settings = { ...togetherSettings, appendQuality: false, useSTStyle: false,
        _backupContextualFilters: [
            { id: 'keyword', enabled: true, matchMode: 'OR', keywords: 'scene',
                positive: 'base detail', priority: 1, seedOverride: 5 },
            { id: 'selected', enabled: true, matchMode: 'LLM', name: 'Fine texture',
                description: 'soft cloth', positive: 'fine texture', negative: 'no dust',
                priority: 9, seedOverride: 139 },
        ], _backupActiveFilterPoolIdsGlobal: ['qig_pool_default_global'] };
    saveImageSettings(directories, settings);
    const saved = JSON.parse(fs.readFileSync(path.join(directories.root, 'settings.json'), 'utf8'));
    saved.extension_settings.connectionManager = { profiles: [{ id: 'classifier-saved', api: 'custom',
        model: 'classifier-fixture', 'api-url': 'http://127.0.0.1:5000' }] };
    saved.oai_settings = { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:5000/v1' };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify(saved));
    const snapshot = scopedSnapshot(directories);
    snapshot.quickImageGenLLMBinding = { kind: 'profile', ...captureChatProfile(directories, 'classifier-saved') };
    const context = jobContext(directories);
    let requests = 0;
    const generateClassifier = async ({ binding, messages, beforeDispatch, onProviderStep, jobContext: paidContext }) => {
        requests++;
        assert.deepEqual(binding, snapshot.quickImageGenLLMBinding);
        assert.match(JSON.stringify(messages), /soft cloth/);
        onProviderStep('provider:classifier-fixture:positive');
        return providerStep(paidContext, 'classifier-fixture:positive', async () => {
            beforeDispatch();
            return { text: '1' };
        });
    };
    const input = { effectId: 'scoped:classifier-positive', prompt: 'scene', snapshot, generateClassifier };
    const final = await prepareConversationScopedImagePrompt(context, input);
    assert.match(final.prompt, /scene, base detail, fine texture/);
    assert.equal(final.negative, 'no dust');
    assert.equal(final.seedOverride, 139);
    assert.equal(requests, 1);
    const instruction = readArtifact(directories, context.job.id, 'input:quick-image:scoped:classifier-positive:filter-classifier');
    assert.match(JSON.stringify(instruction.messages), /Given the following scene/);
    assert.ok(!JSON.stringify(instruction).includes('private-key'));
    assert.ok(readArtifact(directories, context.job.id, 'quick-image:scoped:classifier-positive:filter-classifier-result'));
    assert.ok(readArtifact(directories, context.job.id, 'input:quick-image:scoped:classifier-positive:scoped:draft'));
    const replay = await prepareConversationScopedImagePrompt(context, { ...input,
        generateClassifier: () => assert.fail('The saved classifier repeated paid work') });
    assert.deepEqual(replay.prompt, final.prompt);
    assert.deepEqual(replay.negative, final.negative);
    assert.equal(requests, 1);
});

test('an unknown paid image filter classification cannot silently produce an image or repeat', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    updateJob(directories, context.job.id, { state: 'running' });
    const settings = { ...togetherSettings, appendQuality: false,
        _backupContextualFilters: [{ id: 'paid-classifier', enabled: true, matchMode: 'LLM',
            name: 'snow', description: 'Snow is falling', positive: 'snowflakes' }] };
    saveImageSettings(directories, settings);
    const saved = JSON.parse(fs.readFileSync(path.join(directories.root, 'settings.json'), 'utf8'));
    saved.extension_settings.connectionManager = { profiles: [{ id: 'classifier-saved', api: 'custom',
        model: 'classifier-fixture', 'api-url': 'http://127.0.0.1:5000' }] };
    saved.oai_settings = { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:5000/v1' };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify(saved));
    const snapshot = scopedSnapshot(directories);
    snapshot.binding = { kind: 'profile', ...captureChatProfile(directories, 'classifier-saved') };
    let paidCalls = 0;
    const generation = { effectId: 'scoped:unknown-classification', prompt: 'snowy scene', snapshot,
        generateClassifier: async ({ jobContext, beforeDispatch, onProviderStep }) => {
            onProviderStep('provider:classifier-fixture:unknown');
            return providerStep(jobContext, 'classifier-fixture:unknown', async () => {
                beforeDispatch();
                paidCalls++;
                throw new Error('Classifier result lost after dispatch');
            });
        } };
    await assert.rejects(prepareConversationScopedImagePrompt(context, generation),
        /Classifier result lost after dispatch/);
    assert.equal(paidCalls, 1);
    assert.equal(getJob(directories, context.job.id).recoverability, 'unknown-outcome');
    assert.ok(readArtifact(directories, context.job.id, 'input:quick-image:scoped:unknown-classification:scoped:draft'));
    assert.equal(readArtifact(directories, context.job.id, 'input:quick-image:scoped:unknown-classification:scoped'), undefined);
    assert.equal(readArtifact(directories, context.job.id, 'provider:quick-image:scoped:unknown-classification'), undefined);
    recoverJobs(directories);
    assert.equal(getJob(directories, context.job.id).state, 'interrupted');
    await assert.rejects(prepareConversationScopedImagePrompt(context, { ...generation,
        generateClassifier: () => assert.fail('Unknown classifier result repeated') }),
    { code: 'QIG_RESULT_RECOVERY' });
    assert.equal(paidCalls, 1);
});

test('saved image keyword filters apply card scope, AND priority, removals and a stable paid seed', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    const settings = { ...togetherSettings, appendQuality: false, useSTStyle: false,
        _backupContextualFilters: [
            { id: 'and-filter', enabled: true, scope: 'global', matchMode: 'AND',
                keywords: 'portrait, silver hair', priority: 8, positive: 'soft light, {{char}}',
                negative: 'no text', removePositive: '<lora:Ink:0.8>', removeMode: 'moveToNegative', seedOverride: 123 },
            { id: 'or-subset', enabled: true, scope: 'global', matchMode: 'OR',
                keywords: 'portrait', priority: 7, positive: 'should not be included' },
            { id: 'card-filter', enabled: true, scope: 'card', cardKey: 'nova.png',
                keywords: 'portrait', priority: 9, poolIds: ['nova-pool'], positive: 'card only' },
            { id: 'other-card', enabled: true, scope: 'card', cardKey: 'other.png',
                keywords: 'portrait', priority: 10, positive: 'other card only' },
        ],
        _backupActiveFilterPoolIdsGlobal: ['qig_pool_default_global'],
        _backupActiveFilterPoolIdsByCard: { 'nova.png': ['nova-pool'] },
    };
    saveImageSettings(directories, settings);
    const snapshot = scopedSnapshot(directories);
    const input = { effectId: 'scoped:keyword', prompt: 'portrait, <lora:Ink:0.3>, silver hair', snapshot };
    const staged = await prepareConversationScopedImagePrompt(context, input);
    assert.match(staged.prompt, /card only.*soft light, Nova/);
    assert.doesNotMatch(staged.prompt, /should not be included|other card only|<lora:Ink/i);
    assert.match(staged.negative, /<lora:Ink:0\.3>.*no text/);
    assert.equal(staged.seedOverride, 123);
    assert.equal(readArtifact(directories, context.job.id, 'input:quick-image:scoped:keyword:scoped').seedOverride, 123);
    let paid = 0;
    const image = await generateQuickImageGenJobImage(context, { effectId: input.effectId,
        prompt: staged.prompt, negative: staged.negative, seedOverride: staged.seedOverride,
        settingsFingerprint: snapshot.quickImageGenSettingsFingerprint,
        expectedAccount: staged.account, assertSourceLocked: staged.assertSourceLocked,
        fetch: async (_url, options) => {
            paid++;
            assert.equal(JSON.parse(options.body).seed, 123);
            return jsonResponse({ data: [{ b64_json: PNG_BASE64 }] });
        } });
    assert.equal(image.base64, PNG_BASE64);
    assert.equal(paid, 1);
    assert.equal(readArtifact(directories, context.job.id, 'input:quick-image:scoped:keyword').seedOverride, 123);
});

test('disabled saved filter pools cannot add scoped image prompts', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    saveImageSettings(directories, { ...togetherSettings, appendQuality: false, useSTStyle: false,
        _backupContextualFilters: [{ id: 'inactive', enabled: true, keywords: 'portrait', positive: 'not selected' }],
        _backupActiveFilterPoolIdsGlobal: [] });
    const staged = await prepareConversationScopedImagePrompt(context, { effectId: 'scoped:pool',
        prompt: 'portrait', snapshot: scopedSnapshot(directories) });
    assert.equal(staged.prompt, 'portrait');
    assert.equal(staged.seedOverride, undefined);
});

test('the default global pool selects a saved filter when no active-pool list was recorded', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    saveImageSettings(directories, { ...togetherSettings, appendQuality: false, useSTStyle: false,
        _backupContextualFilters: [{ id: 'default-pool', enabled: true, keywords: 'portrait', positive: 'sunlight' }] });
    const staged = await prepareConversationScopedImagePrompt(context, { effectId: 'scoped:default-pool',
        prompt: 'portrait', snapshot: scopedSnapshot(directories) });
    assert.equal(staged.prompt, 'portrait, sunlight');
});

test('a saved character-scoped image filter without exact browser roster identity refuses before provider work', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    saveImageSettings(directories, { ...togetherSettings,
        _backupContextualFilters: [{ id: 'bound-character', enabled: true, scope: 'char',
            charId: '17', keywords: 'portrait', positive: 'only for roster id 17' }] });
    await assert.rejects(prepareConversationScopedImagePrompt(context, { effectId: 'scoped:ambiguous',
        prompt: 'portrait', snapshot: scopedSnapshot(directories) }), { code: 'QIG_INVALID_FILTER' });
    assert.equal(readArtifact(directories, context.job.id, 'provider:quick-image:scoped:ambiguous'), undefined);
    assert.notEqual(getJob(directories, context.job.id).recoverability, 'unknown-outcome');
});

test('a configured hosted provider produces inline image bytes', async (t) => {
    const directories = tempRoot(t);
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return jsonResponse({ data: [{ b64_json: PNG_BASE64 }] });
    };
    const image = await generateQuickImageGenImage({
        directories,
        prompt: 'a test prompt',
        negative: 'blur',
        fetch: fetchImpl,
        settings: { provider: 'together', togetherKey: 'secret', togetherModel: 'model-x', width: 512, height: 768 },
    });
    assert.equal(image.format, 'png');
    assert.equal(image.base64, PNG_BASE64);
    assert.equal(calls[0].url, 'https://api.together.xyz/v1/images/generations');
    assert.equal(calls[0].body.prompt, 'a test prompt');
    assert.equal(calls[0].body.width, 512);
});

test('binary image receipts save provider outputs larger than the JSON job budget without a second request', () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    const image = Buffer.alloc(54 + 2200 * 2000 * 3);
    image.write('BM', 0);
    image.writeUInt32LE(image.length, 2);
    image.writeUInt32LE(54, 10);
    image.writeUInt32LE(40, 14);
    image.writeInt32LE(2200, 18);
    image.writeInt32LE(2000, 22);
    image.writeUInt16LE(1, 26);
    image.writeUInt16LE(24, 28);
    const result = { base64: image.toString('base64'), format: 'bmp' };
    assert.ok(Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 * 1024);
    writeImageArtifact(directories, context.job.id, 'provider:quick-image:large', result);
    assert.deepEqual(readImageArtifact(directories, context.job.id, 'provider:quick-image:large'), result);
    const receipt = readArtifact(directories, context.job.id, 'provider:quick-image:large');
    assert.equal(receipt.byteLength, image.length);
    assert.equal(receipt.format, 'bmp');
    assert.ok(JSON.stringify(receipt).length < 1024);
    const blob = path.join(directories.root, 'jobs', 'artifacts', jobKey(context.job.id), `${jobKey('provider:quick-image:large')}.bin`);
    fs.writeFileSync(blob, Buffer.from(PNG_BASE64, 'base64'));
    assert.throws(() => readImageArtifact(directories, context.job.id, 'provider:quick-image:large'), { code: 'QIG_RESULT_RECOVERY' });
});

test('a saved image result symlink cannot be used as a provider receipt', () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    const name = 'provider:quick-image:link';
    writeImageArtifact(directories, context.job.id, name, { base64: PNG_BASE64, format: 'png' });
    const blob = path.join(directories.root, 'jobs', 'artifacts', jobKey(context.job.id), `${jobKey(name)}.bin`);
    const external = path.join(directories.root, 'outside.png');
    fs.writeFileSync(external, Buffer.from(PNG_BASE64, 'base64'));
    fs.unlinkSync(blob);
    fs.symlinkSync(external, blob);
    assert.throws(() => readImageArtifact(directories, context.job.id, name), { code: 'QIG_RESULT_RECOVERY' });
});

test('Chutes preserves the saved seed and accepts both binary and JSON image results', async () => {
    const directories = tempRoot();
    const settings = { provider: 'chutes', chutesKey: 'chutes-private-key', chutesModel: 'example-model', seed: -1 };
    saveImageSettings(directories, settings);
    const context = jobContext(directories);
    let calls = 0;
    const first = await generateQuickImageGenJobImage(context, { effectId: 'chutes:0', prompt: 'stars',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), fetch: async (url, options) => {
            calls++;
            assert.equal(url, 'https://image.chutes.ai/generate');
            assert.equal(options.headers.Authorization, 'Bearer chutes-private-key');
            assert.equal(JSON.parse(options.body).seed, readArtifact(directories, context.job.id, 'input:quick-image:chutes:0').seed);
            return new Response(Buffer.from(PNG_BASE64, 'base64'), { headers: { 'content-type': 'image/png' } });
        } });
    assert.equal(first.base64, PNG_BASE64);
    assert.deepEqual(await generateQuickImageGenJobImage(context, { effectId: 'chutes:0', prompt: 'stars',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), fetch: () => assert.fail('Chutes replayed') }), first);
    assert.equal(calls, 1);
    const jsonImage = await generateQuickImageGenImage({ directories, prompt: 'moon', settings,
        fetch: async () => jsonResponse({ data: [{ b64_json: PNG_BASE64 }] }) });
    assert.equal(jsonImage.base64, PNG_BASE64);
    assert.ok(!JSON.stringify(readArtifact(directories, context.job.id, 'provider:quick-image:chutes:0')).includes(settings.chutesKey));
});

test('Replicate saves its one paid submission, polls for the image and keeps its key away from the CDN', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    const settings = { provider: 'replicate', replicateKey: 'replicate-private-key', seed: -1 };
    saveImageSettings(directories, settings);
    const calls = [];
    let polls = 0;
    const input = { effectId: 'replicate:0', prompt: 'moonlight', negative: 'fog',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), wait: async () => {},
        fetch: async (url, options) => {
            calls.push({ url, options });
            if (options.method === 'POST') return jsonResponse({ id: 'prediction-123' }, 201);
            if (url.endsWith('/prediction-123')) return polls++ ? jsonResponse({ status: 'succeeded',
                output: ['https://cdn.replicate.delivery/image.png'] }) : jsonResponse({ status: 'processing' });
            return new Response(Buffer.from(PNG_BASE64, 'base64'), { status: 200 });
        } };
    const image = await generateQuickImageGenJobImage(context, input);
    assert.equal(image.base64, PNG_BASE64);
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
    const submitted = JSON.parse(calls[0].options.body);
    assert.match(submitted.version, /^stability-ai\/sdxl:/);
    assert.equal(submitted.input.seed, readArtifact(directories, context.job.id, 'input:quick-image:replicate:0').seed);
    assert.deepEqual(calls.map(call => call.options.headers?.Authorization), [
        'Bearer replicate-private-key', 'Bearer replicate-private-key', 'Bearer replicate-private-key', undefined,
    ]);
    assert.equal(readArtifact(directories, context.job.id, 'provider:quick-image:replicate:0:submit').id, 'prediction-123');
    assert.ok(!JSON.stringify(readArtifact(directories, context.job.id, 'input:quick-image:replicate:0:queued')).includes(settings.replicateKey));
    assert.ok(!JSON.stringify(readArtifact(directories, context.job.id, 'provider:quick-image:replicate:0:submit')).includes(settings.replicateKey));
    saveImageSettings(directories, { ...settings, replicateKey: 'rotated-key' });
    assert.deepEqual(await generateQuickImageGenJobImage(context, { ...input, fetch: () => assert.fail('Replicate replayed') }), image);
    assert.equal(calls.length, 4);
});

test('Replicate resumes read-only polling after an interrupted response without submitting again', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    updateJob(directories, context.job.id, { state: 'running' });
    const settings = { provider: 'replicate', replicateKey: 'replicate-private-key', seed: 9 };
    saveImageSettings(directories, settings);
    let submits = 0;
    let polls = 0;
    const input = { effectId: 'replicate:retry', prompt: 'night',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), wait: async () => {},
        fetch: async (_url, options) => {
            if (options.method === 'POST') {
                submits++;
                return jsonResponse({ id: 'prediction-retry' }, 201);
            }
            if (++polls === 1) throw new Error('Polling connection lost');
            return options.method === 'GET' && options.headers?.Authorization
                ? jsonResponse({ status: 'succeeded', output: [PNG_DATA_URL] })
                : assert.fail('Unexpected image download');
        } };
    await assert.rejects(generateQuickImageGenJobImage(context, input), /Polling connection lost/);
    assert.equal(submits, 1);
    assert.equal(getJob(directories, context.job.id).recoverability, 'resumable');
    assert.ok(recoverJobs(directories).recoverable.some(item => item.id === context.job.id));
    const image = await generateQuickImageGenJobImage(context, input);
    assert.equal(image.base64, PNG_BASE64);
    assert.equal(submits, 1);
    assert.equal(polls, 2);
});

test('an unknown queued image submission cannot repeat, even if called directly', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    updateJob(directories, context.job.id, { state: 'running' });
    const settings = { provider: 'replicate', replicateKey: 'replicate-private-key' };
    saveImageSettings(directories, settings);
    let submits = 0;
    const input = { effectId: 'replicate:unknown', prompt: 'stars',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), wait: async () => {},
        fetch: async () => { submits++; throw new Error('Submission response lost'); } };
    await assert.rejects(generateQuickImageGenJobImage(context, input), /Submission response lost/);
    assert.equal(submits, 1);
    assert.equal(getJob(directories, context.job.id).recoverability, 'unknown-outcome');
    assert.equal(readArtifact(directories, context.job.id, 'provider:quick-image:replicate:unknown:submit'), undefined);
    recoverJobs(directories);
    assert.equal(getJob(directories, context.job.id).state, 'interrupted');
    await assert.rejects(generateQuickImageGenJobImage(context, { ...input, fetch: () => assert.fail('Unknown submit replayed') }),
        { code: 'QIG_RESULT_RECOVERY' });
    assert.equal(submits, 1);
});

test('CivitAI saves a workflow ID and downloads a validated 308 CDN redirect without its key', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    const settings = { provider: 'civitai', civitaiKey: 'civitai-private-key',
        civitaiModel: 'urn:air:sdxl:checkpoint:123', sampler: 'euler_a', seed: 12 };
    saveImageSettings(directories, settings);
    const calls = [];
    const input = { effectId: 'civitai:0', prompt: 'village',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), wait: async () => {},
        fetch: async (url, options) => {
            calls.push({ url, options });
            if (url.endsWith('?wait=0')) return jsonResponse({ id: 'workflow-123' }, 201);
            if (url.endsWith('/workflow-123')) return jsonResponse({ status: 'succeeded', steps: [{ output: {
                images: [{ url: 'https://orchestration.civitai.com/output/123' }],
            } }] });
            if (url.endsWith('/output/123')) return new Response('', { status: 308,
                headers: { location: 'https://cdn.civitai.com/image.png' } });
            return new Response(Buffer.from(PNG_BASE64, 'base64'), { status: 200 });
        } };
    const image = await generateQuickImageGenJobImage(context, input);
    assert.equal(image.base64, PNG_BASE64);
    assert.equal(JSON.parse(calls[0].options.body).steps[0].input.seed, 12);
    assert.deepEqual(calls.map(call => call.options.headers?.Authorization), [
        'Bearer civitai-private-key', 'Bearer civitai-private-key', 'Bearer civitai-private-key', undefined,
    ]);
    assert.equal(calls[2].options.redirect, 'manual');
    assert.equal(calls[3].options.redirect, 'error');
    assert.equal(readArtifact(directories, context.job.id, 'provider:quick-image:civitai:0:submit').id, 'workflow-123');
    assert.ok(!JSON.stringify(readArtifact(directories, context.job.id, 'input:quick-image:civitai:0:queued')).includes(settings.civitaiKey));
});

test('unsupported queued model and workflow settings refuse before paid submission', async () => {
    for (const settings of [
        { provider: 'replicate', replicateKey: 'key', replicateModel: 'black-forest-labs/flux-schnell' },
        { provider: 'civitai', civitaiKey: 'key', civitaiModel: 'urn:air:sdxl:checkpoint:123', sampler: 'unknown' },
    ]) {
        const directories = tempRoot();
        const context = jobContext(directories);
        saveImageSettings(directories, settings);
        await assert.rejects(generateQuickImageGenJobImage(context, { effectId: 'queued:invalid', prompt: 'trees',
            settingsFingerprint: quickImageGenSettingsFingerprint(settings), fetch: () => assert.fail('Invalid request dispatched') }));
        assert.notEqual(getJob(directories, context.job.id).recoverability, 'unknown-outcome');
    }
});

for (const provider of ['replicate', 'civitai']) {
    for (const interruption of ['cancel', 'timeout']) {
        test(`${provider} keeps ${interruption} active while downloading the image body`, async t => {
            const directories = tempRoot();
            const controller = new AbortController();
            const context = { ...jobContext(directories), signal: controller.signal };
            const settings = { provider, replicateKey: 'replicate-private-key', civitaiKey: 'civitai-private-key',
                civitaiModel: 'urn:air:sdxl:checkpoint:123', sampler: 'euler_a', hostedTimeout: 30, seed: 12 };
            saveImageSettings(directories, settings);
            t.mock.timers.enable({ apis: ['setTimeout'] });
            const downloading = Promise.withResolvers();
            let downloadSignal;
            let streamController;
            const imageUrl = provider === 'replicate'
                ? 'https://cdn.replicate.delivery/image.png' : 'https://cdn.civitai.com/image.png';
            const pending = generateQuickImageGenJobImage(context, {
                effectId: `${provider}:${interruption}`, prompt: 'village',
                settingsFingerprint: quickImageGenSettingsFingerprint(settings), wait: async () => {},
                fetch: async (url, options) => {
                    if (options.method === 'POST') return jsonResponse({ id: 'queued-image' }, 201);
                    if (url.endsWith('/queued-image')) return jsonResponse({ status: 'succeeded',
                        output: [imageUrl], steps: [{ output: { images: [{ url: imageUrl }] } }] });
                    assert.equal(url, imageUrl);
                    downloadSignal = options.signal;
                    return new Response(new ReadableStream({
                        start(stream) {
                            streamController = stream;
                            stream.enqueue(Buffer.from(PNG_BASE64, 'base64'));
                            options.signal.addEventListener('abort', () => stream.error(options.signal.reason), { once: true });
                            downloading.resolve();
                        },
                    }));
                },
            });
            // Observe errors immediately, including when the response body aborts.
            const outcome = pending.then(image => ({ image }), error => ({ error }));
            await downloading.promise;
            await nextTurn();
            if (interruption === 'cancel') controller.abort(new DOMException('Generation cancelled', 'AbortError'));
            else t.mock.timers.tick(30_000);
            // Finish a broken implementation's stream too, so a regression fails rather than hangs.
            if (!downloadSignal.aborted) streamController.close();
            const result = await outcome;
            assert.equal(downloadSignal.aborted, true, 'the final download must retain the job deadline and cancellation');
            assert.equal(result.error?.name, interruption === 'cancel' ? 'AbortError' : 'TimeoutError');
            assert.equal(result.image, undefined);
        });
    }
}

function comfySuccess(promptId = 'prompt-1') {
    return jsonResponse({ [promptId]: { status: { status_str: 'success', completed: true },
        outputs: { 9: { images: [{ filename: 'output.png', subfolder: '', type: 'output' }] } } } });
}

test('ComfyUI saves one workflow submission and resumes read-only history without paying twice', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    updateJob(directories, context.job.id, { state: 'running' });
    const settings = { provider: 'local', localType: 'comfyui', localUrl: 'http://127.0.0.1:8188',
        localModel: 'checkpoint.safetensors', seed: -1, sampler: 'euler_a', comfyClipSkip: 2,
        comfyLoras: 'detail.safetensors:0.7', comfyUpscale: true, comfyUpscaleModel: '4x.pth',
        comfyOutputNodeIds: '9', comfyOutputImageIndex: 0 };
    saveImageSettings(directories, settings);
    let posts = 0;
    let polls = 0;
    const calls = [];
    const input = { effectId: 'comfy:basic', prompt: 'quiet garden', negative: 'fog',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), wait: async () => {},
        fetch: async (url, options) => {
            calls.push({ url, options });
            if (url.endsWith('/prompt')) {
                posts++;
                const body = JSON.parse(options.body);
                assert.equal(body.prompt['3'].inputs.seed, readArtifact(directories, context.job.id, 'input:quick-image:comfy:basic').seed);
                assert.equal(body.prompt['3'].inputs.sampler_name, 'euler_ancestral');
                assert.ok(Object.values(body.prompt).some(node => node.class_type === 'LoraLoader'
                    && node.inputs.lora_name === 'detail.safetensors'));
                assert.ok(Object.values(body.prompt).some(node => node.class_type === 'ImageUpscaleWithModel'));
                return jsonResponse({ prompt_id: 'prompt-1' });
            }
            if (url.endsWith('/history/prompt-1')) {
                if (++polls === 1) throw new Error('private-history-error-token');
                return comfySuccess();
            }
            if (url.includes('/view?filename=output.png')) return new Response(Buffer.from(PNG_BASE64, 'base64'));
            return assert.fail(`Unexpected ComfyUI URL: ${url}`);
        } };
    await assert.rejects(generateQuickImageGenJobImage(context, input), /history polling did not return an image/);
    assert.equal(posts, 1);
    assert.equal(getJob(directories, context.job.id).recoverability, 'resumable');
    assert.equal(readArtifact(directories, context.job.id, 'provider:quick-image:comfy:basic:comfy-submit').promptId, 'prompt-1');
    assert.ok(recoverJobs(directories).recoverable.some(item => item.id === context.job.id));
    const image = await generateQuickImageGenJobImage(context, input);
    assert.equal(image.base64, PNG_BASE64);
    assert.equal(posts, 1);
    assert.equal(polls, 2);
    assert.ok(!JSON.stringify(readArtifact(directories, context.job.id, 'input:quick-image:comfy:basic:comfy')).includes('private-history-error-token'));
    assert.equal(calls.filter(call => call.url.includes('/view?')).length, 1);
    saveImageSettings(directories, { ...settings, localUrl: 'http://other-host:8188' });
    assert.deepEqual(await generateQuickImageGenJobImage(context, { ...input,
        fetch: () => assert.fail('ComfyUI replayed') }), image);
});

test('ComfyUI custom workflow freezes a saved account reference and uploads it only once', async () => {
    const directories = tempRoot();
    const folder = path.join(directories.userImages, 'Nova');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'reference.png'), Buffer.from(PNG_BASE64, 'base64'));
    const settings = { provider: 'local', localType: 'comfyui', localUrl: 'http://127.0.0.1:8188/base',
        comfyWorkflow: JSON.stringify({ 1: { class_type: 'LoadImage', inputs: { image: '%reference_image%' } },
            2: { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['1', 0] } },
            9: { class_type: 'SaveImage', inputs: { filename_prefix: 'qig', images: ['2', 0] } } }),
        localRefImage: '/user/images/Nova/reference.png', seed: 31 };
    saveImageSettings(directories, settings);
    const context = jobContext(directories);
    const calls = [];
    const image = await generateQuickImageGenJobImage(context, { effectId: 'comfy:reference', prompt: 'flower',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), wait: async () => {},
        fetch: async (url, options) => {
            calls.push({ url, options });
            if (url.endsWith('/upload/image')) {
                const file = options.body.get('image');
                assert.equal(file.size, Buffer.from(PNG_BASE64, 'base64').length);
                assert.equal(options.headers, undefined);
                return jsonResponse({ name: file.name, subfolder: 'qig', type: 'input' });
            }
            if (url.endsWith('/prompt')) {
                const body = JSON.parse(options.body);
                assert.match(body.prompt['1'].inputs.image, /^qig\/qig_ref_[a-f0-9]{24}\.png$/);
                assert.equal(body.prompt['2'].inputs.text, 'flower');
                return jsonResponse({ prompt_id: 'prompt-custom' });
            }
            if (url.endsWith('/history/prompt-custom')) return comfySuccess('prompt-custom');
            if (url.includes('/view?')) return new Response(Buffer.from(PNG_BASE64, 'base64'));
            return assert.fail(`Unexpected ComfyUI URL: ${url}`);
        } });
    assert.equal(image.base64, PNG_BASE64);
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 2);
    assert.equal(readImageArtifact(directories, context.job.id, 'input:quick-image:comfy:reference:comfy:reference').base64, PNG_BASE64);
    const source = readArtifact(directories, context.job.id, 'input:quick-image:comfy:reference:comfy:reference:source');
    assert.match(source.evidence.rawHash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(readArtifact(directories, context.job.id, 'provider:quick-image:comfy:reference:comfy-upload')).includes(settings.localRefImage));
});

test('an unknown ComfyUI reference upload cannot repeat or submit a workflow', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    updateJob(directories, context.job.id, { state: 'running' });
    const settings = { provider: 'local', localType: 'comfyui', localUrl: 'http://127.0.0.1:8188',
        localRefImage: PNG_DATA_URL, comfyDenoise: 0.7, seed: 1 };
    saveImageSettings(directories, settings);
    let uploads = 0;
    const input = { effectId: 'comfy:unknown-upload', prompt: 'moon',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), wait: async () => {},
        fetch: async url => {
            assert.ok(url.endsWith('/upload/image'));
            uploads++;
            throw new Error('Unknown upload result');
        } };
    await assert.rejects(generateQuickImageGenJobImage(context, input), /Unknown upload result/);
    assert.equal(uploads, 1);
    assert.equal(getJob(directories, context.job.id).recoverability, 'unknown-outcome');
    assert.equal(readArtifact(directories, context.job.id, 'provider:quick-image:comfy:unknown-upload:comfy-upload'), undefined);
    recoverJobs(directories);
    assert.equal(getJob(directories, context.job.id).state, 'interrupted');
    await assert.rejects(generateQuickImageGenJobImage(context, { ...input, fetch: () => assert.fail('Unknown upload retried') }),
        { code: 'QIG_RESULT_RECOVERY' });
    assert.equal(uploads, 1);
});

test('an unknown ComfyUI workflow submission never repeats after a saved upload', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    updateJob(directories, context.job.id, { state: 'running' });
    const settings = { provider: 'local', localType: 'comfyui', localUrl: 'http://127.0.0.1:8188',
        localRefImage: PNG_DATA_URL, comfyDenoise: 0.7, seed: 1 };
    saveImageSettings(directories, settings);
    let uploads = 0;
    let submits = 0;
    const input = { effectId: 'comfy:unknown-submit', prompt: 'moon',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), wait: async () => {},
        fetch: async (url, options) => {
            if (url.endsWith('/upload/image')) {
                uploads++;
                return jsonResponse({ name: options.body.get('image').name });
            }
            if (url.endsWith('/prompt')) { submits++; throw new Error('Unknown prompt ID'); }
            return assert.fail('Unexpected ComfyUI step');
        } };
    await assert.rejects(generateQuickImageGenJobImage(context, input), /Unknown prompt ID/);
    assert.equal(uploads, 1);
    assert.equal(submits, 1);
    assert.ok(readArtifact(directories, context.job.id, 'provider:quick-image:comfy:unknown-submit:comfy-upload'));
    recoverJobs(directories);
    assert.equal(getJob(directories, context.job.id).state, 'interrupted');
    await assert.rejects(generateQuickImageGenJobImage(context, { ...input,
        fetch: () => assert.fail('Unknown submission or saved upload repeated') }), { code: 'QIG_RESULT_RECOVERY' });
    assert.equal(uploads, 1);
    assert.equal(submits, 1);
});

test('invalid ComfyUI workflow and reference paths refuse before a paid image request', async () => {
    for (const settings of [
        { provider: 'local', localType: 'comfyui', localUrl: 'ftp://remote-host', comfyWorkflow: '{}' },
        { provider: 'local', localType: 'comfyui', localUrl: 'http://127.0.0.1:8188', comfyWorkflow: '{' },
        { provider: 'local', localType: 'comfyui', localUrl: 'http://127.0.0.1:8188', comfyDenoise: 0.7,
            localRefImage: '/user/images/Nova/../../../wrong-account.png' },
    ]) {
        const directories = tempRoot();
        const context = jobContext(directories);
        saveImageSettings(directories, settings);
        await assert.rejects(generateQuickImageGenJobImage(context, { effectId: 'comfy:invalid', prompt: 'stars',
            settingsFingerprint: quickImageGenSettingsFingerprint(settings), fetch: () => assert.fail('Invalid ComfyUI dispatched') }));
        assert.notEqual(getJob(directories, context.job.id).recoverability, 'unknown-outcome');
    }
});

for (const variant of ['sunburst', 'flare']) {
    test(`GPT Image ${variant} uses Responses and saves the paid result without repeating it`, async () => {
        const directories = tempRoot();
        const context = jobContext(directories);
        const settings = { provider: 'gptimage', gptImageProxyUrl: 'https://proxy.example.test/openai',
            gptImageProxyKey: 'private-image-key', gptImageModel: `gpt-image-2.5-${variant}`,
            gptImageQuality: 'high', width: 768, height: 1024 };
        saveImageSettings(directories, settings);
        const input = { effectId: `responses:${variant}`, prompt: 'cat portrait', negative: 'blur',
            settingsFingerprint: quickImageGenSettingsFingerprint(settings) };
        let calls = 0;
        const image = await generateQuickImageGenJobImage(context, { ...input, fetch: async (url, options) => {
            calls++;
            assert.equal(url, 'https://proxy.example.test/openai/responses');
            assert.equal(options.headers.Authorization, 'Bearer private-image-key');
            assert.equal(options.redirect, 'error');
            const body = JSON.parse(options.body);
            assert.equal(body.model, 'gpt-5.5');
            assert.deepEqual(body.tools, [{ type: 'image_generation', model: settings.gptImageModel,
                size: '1024x1536', quality: 'high', action: 'generate' }]);
            assert.deepEqual(body.tool_choice, { type: 'image_generation' });
            assert.match(body.input[0].content[0].text, /cat portrait.*\n\nAvoid in the image: blur/);
            return jsonResponse({ object: 'response', status: 'completed', output: [
                { type: 'image_generation_call', status: 'completed', result: PNG_BASE64 },
            ] });
        } });
        assert.equal(image.base64, PNG_BASE64);
        assert.equal(calls, 1);
        assert.deepEqual(await generateQuickImageGenJobImage(context, { ...input,
            fetch: () => assert.fail('Paid Responses image repeated') }), image);
    });
}

test('Responses proxy sends frozen reference bytes and chat instructions without extended image fields', async () => {
    const directories = tempRoot();
    fs.writeFileSync(path.join(directories.userImages, 'reference.png'), Buffer.from(PNG_BASE64, 'base64'));
    const settings = { provider: 'proxy', proxyUrl: 'https://proxy.example.test/openai/v1/chat/completions',
        proxyModel: 'gpt-image-2.5-sunburst', proxyKey: 'reference-key', proxyChatImageMode: true,
        proxyChatImageSystemPrompt: 'Keep the character recognisable.', proxyChatImageIncludePersonality: true,
        proxyPayloadMode: 'extended', proxyRefImages: ['/user/images/reference.png'], proxyExtraInstructions: 'Keep the hat.',
        width: 768, height: 1024, proxySse: 'on', proxySteps: 25, proxySeed: 7 };
    saveImageSettings(directories, settings);
    const image = await generateQuickImageGenJobImage(jobContext(directories), { effectId: 'responses:reference',
        prompt: 'portrait', negative: 'blur', proxyContext: 'Nova has silver hair.',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), fetch: async (url, options) => {
            assert.equal(url, 'https://proxy.example.test/openai/v1/responses');
            const body = JSON.parse(options.body);
            assert.deepEqual(Object.keys(body).sort(), ['input', 'instructions', 'model', 'tool_choice', 'tools']);
            assert.equal(body.input[0].content[1].image_url, PNG_DATA_URL);
            assert.equal(body.tools[0].action, 'edit');
            assert.match(body.input[0].content[0].text, /Keep the hat/);
            assert.match(body.instructions, /Keep the character recognisable.*\n\nNova has silver hair/);
            return jsonResponse({ output: [{ type: 'image_generation_call', result: PNG_BASE64 }] });
        } });
    assert.equal(image.base64, PNG_BASE64);
});

test('a failed Responses image request is never retried with another endpoint', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    const settings = { provider: 'gptimage', gptImageProxyUrl: 'https://proxy.example.test/v1',
        gptImageProxyKey: 'private-key', gptImageModel: 'gpt-image-2.5-flare' };
    saveImageSettings(directories, settings);
    let calls = 0;
    const input = { effectId: 'responses:failed', prompt: 'portrait', settingsFingerprint: quickImageGenSettingsFingerprint(settings) };
    await assert.rejects(generateQuickImageGenJobImage(context, { ...input, fetch: async () => {
        calls++;
        return jsonResponse({ error: { message: 'unsupported' } }, 400);
    } }), /HTTP 400/);
    assert.equal(calls, 1);
    await assert.rejects(generateQuickImageGenJobImage(context, { ...input,
        fetch: () => assert.fail('Uncertain image request repeated') }), { code: 'QIG_RESULT_RECOVERY' });
});

test('image proxy saves its own seed and scopes credentials to its output origin', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    const settings = { provider: 'proxy', proxyUrl: 'https://images.example.test/v1', proxyModel: 'image-model',
        proxyKey: 'proxy-secret', proxySeed: -1, seed: 81, proxyPayloadMode: 'extended', width: 640, height: 768 };
    saveImageSettings(directories, settings);
    let posted = 0;
    let downloaded = 0;
    const image = await generateQuickImageGenJobImage(context, { effectId: 'proxy:images', prompt: 'cat portrait',
        negative: 'blur', settingsFingerprint: quickImageGenSettingsFingerprint(settings),
        fetch: async (url, options) => {
            if (options.method === 'POST') {
                posted++;
                assert.equal(url, 'https://images.example.test/v1/images/generations');
                assert.equal(options.headers.Authorization, 'Bearer proxy-secret');
                const body = JSON.parse(options.body);
                assert.equal(body.size, '640x768');
                assert.equal(body.seed, readArtifact(directories, context.job.id, 'input:quick-image:proxy:images').proxySeed);
                assert.ok(body.seed >= 0);
                assert.equal(body.negative_prompt, 'blur');
                return jsonResponse({ data: [{ url: 'https://images.example.test/output.png' }] });
            }
            downloaded++;
            assert.equal(url, 'https://images.example.test/output.png');
            assert.equal(options.headers.Authorization, 'Bearer proxy-secret');
            return new Response(Buffer.from(PNG_BASE64, 'base64'));
        } });
    assert.equal(image.base64, PNG_BASE64);
    assert.equal(posted, 1);
    assert.equal(downloaded, 1);
    const saved = readArtifact(directories, context.job.id, 'input:quick-image:proxy:images:proxy');
    assert.match(saved.bodyDigest, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(saved).includes('proxy-secret'));
    saveImageSettings(directories, { ...settings, proxyKey: 'changed' });
    assert.deepEqual(await generateQuickImageGenJobImage(context, { effectId: 'proxy:images', prompt: 'cat portrait',
        negative: 'blur', settingsFingerprint: quickImageGenSettingsFingerprint(settings),
        fetch: () => assert.fail('Paid image proxy replayed') }), image);
});

test('image proxy accepts a final SSE image, not a provisional preview', async () => {
    const directories = tempRoot();
    const settings = { provider: 'proxy', proxyUrl: 'https://proxy.example.test/v1', proxyModel: 'image-model',
        proxySse: 'on', proxySeed: 91 };
    saveImageSettings(directories, settings);
    const context = jobContext(directories);
    const preview = 'data:image/png;base64,not-a-real-image';
    const body = `data: ${JSON.stringify({ status: 'preview', image: preview })}\n\n`
        + `data: ${JSON.stringify({ status: 'completed', data: [{ url: PNG_DATA_URL }] })}\n\n`;
    const image = await generateQuickImageGenJobImage(context, { effectId: 'proxy:sse', prompt: 'mountain',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings),
        fetch: async (_url, options) => {
            assert.equal(options.method, 'POST');
            return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
        } });
    assert.equal(image.base64, PNG_BASE64);
    assert.equal(readImageArtifact(directories, context.job.id, 'provider:quick-image:proxy:sse').base64, PNG_BASE64);
});

test('image proxy Chat Image saves account-local reference bytes before requesting the image', async () => {
    const directories = tempRoot();
    fs.writeFileSync(path.join(directories.userImages, 'reference.png'), Buffer.from(PNG_BASE64, 'base64'));
    const settings = { provider: 'proxy', proxyUrl: 'https://proxy.example.test/v1', proxyModel: 'gemini-image',
        proxyChatImageMode: true, proxyPayloadMode: 'openai_strict', proxyRefImages: ['/user/images/reference.png'],
        proxyKey: 'private-chat-key', proxySeed: -1 };
    saveImageSettings(directories, settings);
    const context = jobContext(directories);
    let posted = 0;
    const image = await generateQuickImageGenJobImage(context, { effectId: 'proxy:chat', prompt: 'Nova',
        negative: 'text', settingsFingerprint: quickImageGenSettingsFingerprint(settings),
        fetch: async (url, options) => {
            posted++;
            assert.equal(url, 'https://proxy.example.test/v1/chat/completions');
            assert.equal(options.headers.Authorization, 'Bearer private-chat-key');
            const body = JSON.parse(options.body);
            assert.equal(body.messages[0].role, 'system');
            assert.equal(body.messages[1].content[0].image_url.url, PNG_DATA_URL);
            assert.match(body.messages[1].content[1].text, /Nova.*Avoid: text/s);
            assert.equal(body.max_tokens, 16384);
            assert.equal(body.seed, undefined);
            return jsonResponse({ choices: [{ message: { content: PNG_DATA_URL } }] });
        } });
    assert.equal(image.base64, PNG_BASE64);
    assert.equal(posted, 1);
    assert.equal(readImageArtifact(directories, context.job.id, 'input:quick-image:proxy:chat:proxy:reference:0').base64, PNG_BASE64);
    assert.ok(!JSON.stringify(readArtifact(directories, context.job.id, 'input:quick-image:proxy:chat:proxy')).includes('private-chat-key'));
});

test('image proxy may download only exact configured private origin, never forward its key elsewhere', async () => {
    const settings = { provider: 'proxy', proxyUrl: 'http://127.0.0.1:9000/v1',
        proxyModel: 'local-image', proxyKey: 'private-local-key', proxySeed: 45 };
    const directories = tempRoot();
    saveImageSettings(directories, settings);
    const context = jobContext(directories);
    const calls = [];
    const image = await generateQuickImageGenJobImage(context, { effectId: 'proxy:local', prompt: 'sky',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings),
        fetch: async (url, options) => {
            calls.push({ url, options });
            if (options.method === 'POST') return jsonResponse({ data: [{ url: 'http://127.0.0.1:9000/result.png' }] });
            assert.equal(url, 'http://127.0.0.1:9000/result.png');
            assert.equal(options.headers.Authorization, 'Bearer private-local-key');
            return new Response(Buffer.from(PNG_BASE64, 'base64'));
        } });
    assert.equal(image.base64, PNG_BASE64);
    assert.equal(calls.length, 2);
    const rejected = jobContext(directories);
    await assert.rejects(generateQuickImageGenJobImage(rejected, { effectId: 'proxy:foreign', prompt: 'sky',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings),
        fetch: async (url, options) => {
            assert.equal(options.method, 'POST');
            return jsonResponse({ data: [{ url: 'http://127.0.0.1:9001/result.png' }] });
        } }), { code: 'QIG_UNSAFE_IMAGE_URL' });
    assert.ok(!JSON.stringify(getJob(directories, rejected.job.id)).includes('private-local-key'));
});

test('mutating Comfy image proxy GET is never repeated after an unknown result', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    updateJob(directories, context.job.id, { state: 'running' });
    const settings = { provider: 'proxy', proxyUrl: 'https://comfy-proxy.example.test', proxyKey: 'query-token',
        proxySeed: -1, proxyComfyMode: true };
    saveImageSettings(directories, settings);
    let calls = 0;
    const input = { effectId: 'proxy:comfy', prompt: 'star field',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings),
        fetch: async (url, options) => {
            calls++;
            assert.equal(options.method, undefined);
            assert.match(url, /\/prompt\/star%20field\?token=query-token$/);
            throw new Error('query-token response lost');
        } };
    await assert.rejects(generateQuickImageGenJobImage(context, input), { code: 'QIG_PROXY_ERROR' });
    assert.equal(getJob(directories, context.job.id).recoverability, 'unknown-outcome');
    assert.ok(!JSON.stringify(getJob(directories, context.job.id)).includes('query-token'));
    recoverJobs(directories);
    assert.equal(getJob(directories, context.job.id).state, 'interrupted');
    await assert.rejects(generateQuickImageGenJobImage(context, { ...input,
        fetch: () => assert.fail('Mutating GET proxy replayed') }), { code: 'QIG_RESULT_RECOVERY' });
    assert.equal(calls, 1);
});

test('image proxy refuses strict references, relative URLs and personality without saved context before dispatch', async () => {
    for (const settings of [
        { provider: 'proxy', proxyUrl: 'https://proxy.example.test/v1', proxyRefImages: [PNG_DATA_URL],
            proxyPayloadMode: 'openai_strict' },
        { provider: 'proxy', proxyUrl: '/v1', proxyModel: 'image-model' },
        { provider: 'proxy', proxyUrl: 'https://proxy.example.test/v1', proxyChatImageMode: true,
            proxyChatImageIncludePersonality: true },
    ]) {
        const directories = tempRoot();
        const context = jobContext(directories);
        saveImageSettings(directories, settings);
        await assert.rejects(generateQuickImageGenJobImage(context, { effectId: 'proxy:invalid', prompt: 'stars',
            settingsFingerprint: quickImageGenSettingsFingerprint(settings),
            fetch: () => assert.fail('Invalid proxy request reached network') }));
        assert.notEqual(getJob(directories, context.job.id).recoverability, 'unknown-outcome');
    }
});

test('NanoGPT saves model controls and reference bytes before its one paid request', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    const settings = { provider: 'nanogpt', nanogptKey: 'nano-private-key', nanogptModel: 'model-x',
        width: 768, height: 1024, steps: 31, cfgScale: 5, seed: -1,
        nanogptRefImages: ['https://images.example.com/source.png'], nanogptStrength: 0.65 };
    saveImageSettings(directories, settings);
    const calls = [];
    const input = { effectId: 'nano:0', prompt: 'mountains', negative: 'fog',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), fetch: async (url, options) => {
            calls.push({ url, options });
            if (url.endsWith('/endpoints')) return jsonResponse({ endpoints: [{
                supported_parameters: { seed: true, steps: true, guidance: true, strength: true },
                input_reference_constraints: { max_items: 1, formats: ['image/png'] },
                capabilities: { image_to_image: true },
            }] });
            if (url === settings.nanogptRefImages[0]) {
                assert.equal(options.redirect, 'error');
                assert.equal(options.headers, undefined);
                return new Response(Buffer.from(PNG_BASE64, 'base64'));
            }
            assert.equal(url, 'https://nano-gpt.com/api/v1/images');
            assert.equal(options.headers.Authorization, 'Bearer nano-private-key');
            return jsonResponse({ data: [{ b64_json: PNG_BASE64 }] });
        } };
    const first = await generateQuickImageGenJobImage(context, input);
    assert.equal(first.base64, PNG_BASE64);
    assert.deepEqual(calls.map(call => call.url), [
        'https://nano-gpt.com/api/v1/images/models/model-x/endpoints', settings.nanogptRefImages[0], 'https://nano-gpt.com/api/v1/images',
    ]);
    const body = JSON.parse(calls[2].options.body);
    assert.equal(body.model, 'model-x');
    assert.equal(body.steps, 31);
    assert.equal(body.guidance, 5);
    assert.equal(body.strength, 0.65);
    assert.equal(body.input_references[0], `data:image/png;base64,${PNG_BASE64}`);
    assert.equal(body.seed, readArtifact(directories, context.job.id, 'input:quick-image:nano:0').seed);
    const saved = readArtifact(directories, context.job.id, 'input:quick-image:nano:0:nanogpt');
    assert.deepEqual(saved.body, body);
    assert.ok(!JSON.stringify(saved).includes(settings.nanogptKey));
    saveImageSettings(directories, { ...settings, nanogptKey: 'another-key' });
    assert.deepEqual(await generateQuickImageGenJobImage(context, { ...input, fetch: () => assert.fail('Paid NanoGPT request repeated') }), first);
    assert.equal(calls.length, 3);
});

test('NanoGPT refuses private or unsupported references before claiming a paid result', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    const settings = { provider: 'nanogpt', nanogptKey: 'nano-private-key', nanogptModel: 'model-x',
        nanogptRefImages: ['https://127.0.0.1/private.png'] };
    saveImageSettings(directories, settings);
    const calls = [];
    await assert.rejects(generateQuickImageGenJobImage(context, { effectId: 'nano:blocked', prompt: 'mountains',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), fetch: async url => {
            calls.push(url);
            return jsonResponse({ endpoints: [{ capabilities: { image_to_image: true } }] });
        } }), { code: 'QIG_INVALID_INPUT' });
    assert.deepEqual(calls, ['https://nano-gpt.com/api/v1/images/models/model-x/endpoints']);
    assert.equal(readArtifact(directories, context.job.id, 'provider:quick-image:nano:blocked'), undefined);
    assert.notEqual(getJob(directories, context.job.id).recoverability, 'unknown-outcome');
});

test('Nanobanana saves reference bytes and director settings before its one Gemini request', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    const reference = 'https://images.example.com/source.png?secret=signed-reference-token';
    const settings = { provider: 'nanobanana', nanobananaKey: 'gemini-private-key',
        nanobananaModel: 'gemini-3-pro-image', width: 512, height: 768,
        nanobananaRefImages: [reference], nanobananaNbpMode: true, nanobananaNbpPreset: 'preservation' };
    saveImageSettings(directories, settings);
    const calls = [];
    const input = { effectId: 'banana:gemini', prompt: 'a new village', negative: 'fog',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), fetch: async (url, options) => {
            calls.push({ url, options });
            if (url === reference) {
                assert.equal(options.headers, undefined);
                assert.equal(options.redirect, 'error');
                return new Response(Buffer.from(PNG_BASE64, 'base64'));
            }
            assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent');
            assert.equal(options.headers['x-goog-api-key'], 'gemini-private-key');
            return jsonResponse({ candidates: [{ finishReason: 'STOP', content: {
                parts: [{ inlineData: { mimeType: 'image/png', data: PNG_BASE64 } }],
            } }] });
        } };
    const first = await generateQuickImageGenJobImage(context, input);
    assert.equal(first.base64, PNG_BASE64);
    assert.equal(calls.length, 2);
    const payload = JSON.parse(calls[1].options.body);
    assert.equal(payload.contents[0].parts[0].inlineData.data, PNG_BASE64);
    assert.match(payload.contents[0].parts[1].text, /localized preservation edit/);
    assert.match(payload.contents[0].parts[1].text, /Avoid: fog/);
    assert.equal(payload.generationConfig.imageConfig.aspectRatio, '2:3');
    assert.equal(payload.generationConfig.imageConfig.imageSize, '1K');
    assert.equal(readImageArtifact(directories, context.job.id, 'input:quick-image:banana:gemini:nanobanana:reference:0').base64, PNG_BASE64);
    for (const name of ['input:quick-image:banana:gemini', 'input:quick-image:banana:gemini:nanobanana',
        'input:quick-image:banana:gemini:nanobanana:request', 'provider:quick-image:banana:gemini']) {
        const saved = JSON.stringify(readArtifact(directories, context.job.id, name));
        assert.ok(!saved.includes(settings.nanobananaKey));
        assert.ok(!saved.includes('signed-reference-token'));
    }
    saveImageSettings(directories, { ...settings, nanobananaKey: 'rotated-key' });
    assert.deepEqual(await generateQuickImageGenJobImage(context, { ...input,
        fetch: () => assert.fail('Nanobanana paid request repeated') }), first);
    assert.equal(calls.length, 2);
});

test('Nanobanana proxy scopes its key to the configured origin and rejects other output hosts', async () => {
    const directories = tempRoot();
    const settings = { provider: 'nanobanana', nanobananaProxyUrl: 'https://proxy.example.com/v1/chat/completions',
        nanobananaProxyKey: 'proxy-private-key', nanobananaModel: 'gemini-3-pro-image' };
    saveImageSettings(directories, settings);
    const calls = [];
    const image = await generateQuickImageGenJobImage(jobContext(directories), { effectId: 'banana:proxy', prompt: 'night',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), fetch: async (url, options) => {
            calls.push({ url, options });
            if (options.method === 'POST') {
                assert.equal(url, settings.nanobananaProxyUrl);
                assert.equal(options.headers.Authorization, 'Bearer proxy-private-key');
                assert.equal(JSON.parse(options.body).messages[0].content, 'Generate an image: night');
                return jsonResponse({ choices: [{ message: { content: 'https://proxy.example.com/generated.png' } }] });
            }
            assert.equal(url, 'https://proxy.example.com/generated.png');
            assert.equal(options.headers.Authorization, 'Bearer proxy-private-key');
            return new Response(Buffer.from(PNG_BASE64, 'base64'));
        } });
    assert.equal(image.base64, PNG_BASE64);
    assert.equal(calls.length, 2);
    let outbound = 0;
    const unsafe = jobContext(directories);
    await assert.rejects(generateQuickImageGenJobImage(unsafe, { effectId: 'banana:untrusted', prompt: 'night',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), fetch: async (url) => {
            outbound++;
            if (url === settings.nanobananaProxyUrl) return jsonResponse({ choices: [{ message: {
                content: 'https://other.example.com/private.png',
            } }] });
            return assert.fail('An untrusted output host received a request');
        } }), { code: 'QIG_UNSAFE_IMAGE_URL' });
    assert.equal(outbound, 1);
    assert.equal(getJob(directories, unsafe.job.id).recoverability, 'unknown-outcome');
});

test('Nanobanana keeps saved references through a read-only failure and refuses private sources', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    const references = ['https://images.example.com/first.png', 'https://images.example.com/second.png'];
    const settings = { provider: 'nanobanana', nanobananaKey: 'gemini-private-key', nanobananaRefImages: references };
    saveImageSettings(directories, settings);
    const calls = [];
    let secondAttempt = 0;
    const input = { effectId: 'banana:resume', prompt: 'trees', settingsFingerprint: quickImageGenSettingsFingerprint(settings),
        fetch: async url => {
            calls.push(url);
            if (url === references[1] && !secondAttempt++) throw new Error('Reference connection lost');
            if (references.includes(url)) return new Response(Buffer.from(PNG_BASE64, 'base64'));
            return jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_BASE64 } }] } }] });
        } };
    await assert.rejects(generateQuickImageGenJobImage(context, input), /reference image could not be downloaded/);
    assert.notEqual(getJob(directories, context.job.id).recoverability, 'unknown-outcome');
    assert.equal(readImageArtifact(directories, context.job.id, 'input:quick-image:banana:resume:nanobanana:reference:0').base64, PNG_BASE64);
    assert.equal((await generateQuickImageGenJobImage(context, input)).base64, PNG_BASE64);
    assert.equal(calls.filter(url => url === references[0]).length, 1);
    assert.equal(calls.filter(url => url === references[1]).length, 2);
    const blocked = jobContext(directories);
    const privateSettings = { ...settings, nanobananaRefImages: ['https://127.0.0.1/private.png'] };
    saveImageSettings(directories, privateSettings);
    await assert.rejects(generateQuickImageGenJobImage(blocked, { effectId: 'banana:private', prompt: 'trees',
        settingsFingerprint: quickImageGenSettingsFingerprint(privateSettings), fetch: () => assert.fail('Private reference contacted') }),
    { code: 'QIG_INVALID_INPUT' });
    assert.notEqual(getJob(directories, blocked.job.id).recoverability, 'unknown-outcome');
});

test('NovelAI native ZIP and V4 embedded PNG use saved dimensions, sampler, seed and one paid request', async () => {
    const directories = tempRoot();
    const settings = { provider: 'novelai', naiKey: 'novelai-private-key', naiModel: 'nai-diffusion-4-5-curated',
        width: 800, height: 576, sampler: 'ddim', steps: 28, cfgScale: 5, seed: -1 };
    saveImageSettings(directories, settings);
    const context = jobContext(directories);
    const calls = [];
    const input = { effectId: 'novelai:zip', prompt: 'a starry mountain', negative: 'fog',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), fetch: async (url, options) => {
            calls.push({ url, options });
            assert.equal(url, 'https://image.novelai.net/ai/generate-image');
            return new Response(novelaiZip(Buffer.from(PNG_BASE64, 'base64')), { status: 200 });
        } };
    const image = await generateQuickImageGenJobImage(context, input);
    assert.equal(image.base64, PNG_BASE64);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer novelai-private-key');
    const { model, parameters } = JSON.parse(calls[0].options.body);
    assert.equal(model, settings.naiModel);
    assert.deepEqual([parameters.width, parameters.height, parameters.sampler], [832, 576, 'ddim_v3']);
    assert.equal(parameters.v4_prompt.caption.base_caption, input.prompt);
    assert.equal(parameters.seed, readArtifact(directories, context.job.id, 'input:quick-image:novelai:zip').seed);
    assert.ok(!JSON.stringify(readArtifact(directories, context.job.id, 'provider:quick-image:novelai:zip')).includes(settings.naiKey));
    saveImageSettings(directories, { ...settings, naiKey: 'rotated-key' });
    assert.deepEqual(await generateQuickImageGenJobImage(context, { ...input,
        fetch: () => assert.fail('NovelAI paid request repeated') }), image);
    assert.equal(calls.length, 1);
    const embedded = await generateQuickImageGenImage({ directories, prompt: 'mountain', settings: { ...settings, seed: 3 },
        fetch: async () => new Response(Buffer.concat([Buffer.from('msgpack:'), Buffer.from(PNG_BASE64, 'base64')])) });
    assert.equal(embedded.base64, PNG_BASE64);
});

test('NovelAI chat and generate proxies keep their saved key on the exact origin only', async () => {
    const directories = tempRoot();
    const settings = { provider: 'novelai', naiProxyUrl: 'https://proxy.example.com/v1', naiProxyKey: 'proxy-private-key',
        naiModel: 'nai-diffusion-4-5-curated', width: 768, height: 512 };
    saveImageSettings(directories, settings);
    const calls = [];
    const image = await generateQuickImageGenJobImage(jobContext(directories), { effectId: 'novelai:chat', prompt: 'stars',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), fetch: async (url, options) => {
            calls.push({ url, options });
            if (options.method === 'POST') return jsonResponse({ choices: [{ message: { content: 'https://proxy.example.com/image.png' } }] });
            return new Response(Buffer.from(PNG_BASE64, 'base64'));
        } });
    assert.equal(image.base64, PNG_BASE64);
    assert.equal(calls[0].url, 'https://proxy.example.com/v1/chat/completions');
    assert.equal(calls[1].url, 'https://proxy.example.com/image.png');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer proxy-private-key');
    assert.equal(calls[1].options.headers.Authorization, 'Bearer proxy-private-key');
    assert.match(JSON.parse(calls[0].options.body).size, /^\d+:\d+$/);
    const generator = { ...settings, naiProxyUrl: 'https://proxy.example.com/generate', seed: 2 };
    const response = await generateQuickImageGenImage({ directories, prompt: 'stars', settings: generator,
        fetch: async (url, options) => url.endsWith('/generate')
            ? jsonResponse({ data: [{ b64_json: PNG_BASE64 }] }) : assert.fail(`Unexpected NovelAI URL: ${url}`) });
    assert.equal(response.base64, PNG_BASE64);
    const blocked = jobContext(directories);
    await assert.rejects(generateQuickImageGenJobImage(blocked, { effectId: 'novelai:other', prompt: 'stars',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), fetch: async (url) => url.endsWith('/chat/completions')
            ? jsonResponse({ choices: [{ message: { content: 'https://other.example.com/image.png' } }] })
            : assert.fail('NovelAI sent its key to another origin') }), { code: 'QIG_UNSAFE_IMAGE_URL' });
    assert.equal(getJob(directories, blocked.job.id).recoverability, 'unknown-outcome');
});

test('NovelAI invalid proxy and provider response cannot leak keys into an image job', async () => {
    const directories = tempRoot();
    const settings = { provider: 'novelai', naiProxyUrl: 'http://example.com/image', naiProxyKey: 'novelai-private-key' };
    saveImageSettings(directories, settings);
    const context = jobContext(directories);
    await assert.rejects(generateQuickImageGenJobImage(context, { effectId: 'novelai:invalid', prompt: 'stars',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), fetch: () => assert.fail('Invalid proxy dispatched') }), /HTTPS|safe/i);
    assert.notEqual(getJob(directories, context.job.id).recoverability, 'unknown-outcome');
    saveImageSettings(directories, { ...settings, naiProxyUrl: 'https://proxy.example.com/v1' });
    const failed = jobContext(directories);
    await assert.rejects(generateQuickImageGenJobImage(failed, { effectId: 'novelai:error', prompt: 'stars',
        fetch: async () => new Response('novelai-private-key in provider error', { status: 500 }) }),
    error => error.message.includes('NovelAI request failed') && !error.message.includes('novelai-private-key'));
    assert.ok(!JSON.stringify(getJob(directories, failed.job.id)).includes('novelai-private-key'));
});

test('hosted image downloads accept only the provider’s trusted hosts and send no provider key', async () => {
    const directories = tempRoot();
    const settings = { provider: 'together', togetherKey: 'never-send-to-image-host' };
    let requestedImage = false;
    await assert.rejects(generateQuickImageGenImage({ directories, prompt: 'x', settings,
        fetch: async (url) => {
            if (url === 'https://api.together.xyz/v1/images/generations') return jsonResponse({ data: [{ url: 'https://images.example.com/private.png' }] });
            requestedImage = true;
            throw new Error('An untrusted image host was contacted');
        },
    }), { code: 'QIG_UNSAFE_IMAGE_URL' });
    assert.equal(requestedImage, false);
    const calls = [];
    const image = await generateQuickImageGenImage({ directories, prompt: 'x', settings,
        fetch: async (url, options) => {
            calls.push({ url, options });
            return url === 'https://api.together.xyz/v1/images/generations'
                ? jsonResponse({ data: [{ url: 'https://cdn.together.xyz/private.png' }] })
                : new Response(Buffer.from(PNG_BASE64, 'base64'), { status: 200 });
        },
    });
    assert.equal(image.base64, PNG_BASE64);
    assert.equal(calls[1].url, 'https://cdn.together.xyz/private.png');
    assert.equal(calls[1].options?.headers, undefined);
});

test('a configured Custom API request saves its one provider result without persisting its key', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    const settings = { provider: 'custom', customApiMode: 'json', customApiUrl: 'https://custom.example.com/image',
        customApiAuthType: 'bearer', customApiKey: 'custom-private-key',
        customApiRequestTemplate: JSON.stringify({ prompt: '{{prompt}}', negative: '{{negative}}', seed: '{{seed}}' }),
        customApiResponsePath: '/images/0', customApiResponseType: 'base64', seed: -1 };
    saveImageSettings(directories, settings);
    const calls = [];
    const input = { effectId: 'custom:0', prompt: 'the moon', negative: 'blur',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), fetch: async (url, options) => {
            if (url.startsWith('data:')) {
                return new Response(Buffer.from(url.split(',')[1], 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
            }
            calls.push({ url, options });
            return jsonResponse({ images: [PNG_BASE64] });
        } };
    const first = await generateQuickImageGenJobImage(context, input);
    assert.equal(first.base64, PNG_BASE64);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, settings.customApiUrl);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer custom-private-key');
    assert.equal(JSON.parse(calls[0].options.body).prompt, 'the moon');
    const savedInput = readArtifact(directories, context.job.id, 'input:quick-image:custom:0');
    assert.equal(JSON.parse(calls[0].options.body).seed, savedInput.seed);
    assert.ok(!JSON.stringify(savedInput).includes(settings.customApiKey));
    assert.ok(!JSON.stringify(readArtifact(directories, context.job.id, 'provider:quick-image:custom:0')).includes(settings.customApiKey));
    saveImageSettings(directories, { provider: 'custom', customApiKey: 'different-key' });
    assert.deepEqual(await generateQuickImageGenJobImage(context, { ...input, fetch: () => assert.fail('Custom API replayed') }), first);
    assert.equal(calls.length, 1);
});

test('a malformed Custom API request refuses before claiming an unknown paid outcome', async () => {
    const directories = tempRoot();
    const context = jobContext(directories);
    const settings = { provider: 'custom', customApiUrl: 'https://custom.example.com/image',
        customApiRequestTemplate: '{ not valid JSON', customApiKey: 'private-custom-key' };
    saveImageSettings(directories, settings);
    await assert.rejects(generateQuickImageGenJobImage(context, { effectId: 'bad-template', prompt: 'the moon',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), fetch: () => assert.fail('Invalid template dispatched') }),
    /Request template must be valid JSON/);
    assert.notEqual(getJob(directories, context.job.id).recoverability, 'unknown-outcome');
    assert.equal(readArtifact(directories, context.job.id, 'provider:quick-image:bad-template'), undefined);
    assert.ok(!JSON.stringify(readArtifact(directories, context.job.id, 'input:quick-image:bad-template')).includes(settings.customApiKey));
});

test('pollinations without a key downloads image bytes', async () => {
    const directories = tempRoot(t => t);
    let requested = '';
    const image = await generateQuickImageGenImage({
        directories,
        prompt: 'sunset',
        fetch: async url => { requested = url; return new Response(Buffer.from(PNG_BASE64, 'base64'), { status: 200 }); },
        settings: { provider: 'pollinations', pollinationsModel: 'flux', width: 256, height: 256 },
    });
    assert.equal(image.format, 'png');
    assert.match(requested, /^https:\/\/image\.pollinations\.ai\/prompt\/sunset\?/);
});

test('a provider without a server implementation is refused, not substituted', async () => {
    const directories = tempRoot(t => t);
    await assert.rejects(
        generateQuickImageGenImage({ directories, prompt: 'x', fetch: async () => jsonResponse({}), settings: { provider: 'bogus' } }),
        error => error.status === 409 && error.recoverable === true && /bogus/.test(error.message),
    );
});

test('a missing provider key fails loudly', async () => {
    const directories = tempRoot(t => t);
    await assert.rejects(
        generateQuickImageGenImage({ directories, prompt: 'x', fetch: async () => jsonResponse({}), settings: { provider: 'together' } }),
        error => /Together AI API key/.test(error.message) && error.recoverable === true,
    );
});

test('an upstream failure is recoverable', async () => {
    const directories = tempRoot(t => t);
    await assert.rejects(
        generateQuickImageGenImage({
            directories, prompt: 'x',
            fetch: async () => new Response('boom', { status: 500 }),
            settings: { provider: 'stability', stabilityKey: 'k' },
        }),
        error => error.recoverable === true && /Stability request failed/.test(error.message),
    );
});

test('saveQuickImageToUserImages writes under userImages and returns a relative path', async (t) => {
    const directories = tempRoot(t);
    const relative = await saveQuickImageToUserImages(directories, savedImageInput(directories, { base64: PNG_BASE64, format: 'png', chName: 'Nova' }));
    assert.ok(fs.existsSync(path.join(directories.root, relative)), `expected ${relative} to exist`);
    assert.match(relative, /Nova/);
    assert.match(relative, /\.png$/);
});

test('a named image never overwrites a different existing file, including a symlink', async () => {
    const directories = tempRoot();
    const input = savedImageInput(directories, { base64: PNG_BASE64, format: 'png', filename: 'qig-fixed', chName: 'Nova' });
    const relative = await saveQuickImageToUserImages(directories, input);
    assert.equal(await saveQuickImageToUserImages(directories, input), relative);
    const original = fs.readFileSync(path.join(directories.root, relative));
    await assert.rejects(saveQuickImageToUserImages(directories, { ...input, base64: Buffer.from('different').toString('base64') }), { code: 'QIG_IMAGE_CONFLICT' });
    assert.deepEqual(fs.readFileSync(path.join(directories.root, relative)), original);
    fs.unlinkSync(path.join(directories.root, relative));
    const outside = path.join(directories.root, 'outside.png');
    fs.writeFileSync(outside, original);
    fs.symlinkSync(outside, path.join(directories.root, relative));
    await assert.rejects(saveQuickImageToUserImages(directories, input), { code: 'QIG_IMAGE_CONFLICT' });
    assert.ok(fs.readdirSync(path.dirname(path.join(directories.root, relative))).every(name => !name.startsWith('.qig-')));
});

test('an image cannot be written through an existing account folder symlink', async () => {
    const directories = tempRoot();
    const outside = path.join(directories.root, 'outside');
    fs.mkdirSync(outside);
    const input = savedImageInput(directories, { base64: PNG_BASE64, format: 'png', filename: 'qig-fixed', chName: 'Nova' });
    fs.symlinkSync(outside, path.join(directories.userImages, 'Nova'), 'dir');
    await assert.rejects(saveQuickImageToUserImages(directories, input), { code: 'QIG_UNSAFE_IMAGE_PATH' });
    assert.deepEqual(fs.readdirSync(outside), []);
    fs.unlinkSync(path.join(directories.userImages, 'Nova'));
    fs.rmdirSync(directories.userImages);
    fs.symlinkSync(outside, directories.userImages, 'dir');
    await assert.rejects(saveQuickImageToUserImages(directories, input), { code: 'QIG_UNSAFE_IMAGE_PATH' });
    assert.deepEqual(fs.readdirSync(outside), []);
});

test('image publication and saved provider results require the same protected account', async () => {
    const directories = tempRoot();
    const input = savedImageInput(directories, { base64: PNG_BASE64, format: 'png', filename: 'qig-protected' });
    await assert.rejects(saveQuickImageToUserImages(directories, { ...input, owner: 'other' }), { code: 'QIG_UNSAFE_IMAGE_PATH' });
    await assert.rejects(saveQuickImageToUserImages(directories, { ...input,
        account: { ...input.account, dataEpoch: input.account.dataEpoch + 1 } }), { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
    assert.deepEqual(fs.readdirSync(directories.userImages), []);
    const context = jobContext(directories);
    await generateQuickImageGenJobImage(context, { ...imageRequest, fetch: async () => jsonResponse({ data: [{ b64_json: PNG_BASE64 }] }) });
    const artifact = 'input:quick-image:image:0:0';
    const saved = readArtifact(directories, context.job.id, artifact);
    writeArtifact(directories, context.job.id, artifact, { ...saved, account: {
        ...saved.account, dataEpoch: saved.account.dataEpoch + 1,
    } });
    await assert.rejects(generateQuickImageGenJobImage(context, { ...imageRequest,
        fetch: () => assert.fail('A replaced account dispatched paid work') }), { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
});

test('a generated image and its random seed are saved before delivery and never requested twice', async () => {
    const context = jobContext(tempRoot());
    let calls = 0;
    const fetchImpl = async (_url, options) => {
        calls++;
        assert.equal(JSON.parse(options.body).seed, readArtifact(context.directories, context.job.id, 'input:quick-image:image:0:0').seed);
        return jsonResponse({ data: [{ b64_json: PNG_BASE64 }] });
    };
    const first = await generateQuickImageGenJobImage(context, { ...imageRequest, fetch: fetchImpl });
    assert.equal(first.base64, PNG_BASE64);
    assert.ok(readArtifact(context.directories, context.job.id, 'provider:quick-image:image:0:0'));
    const saved = readArtifact(context.directories, context.job.id, 'input:quick-image:image:0:0');
    assert.ok(saved.seed >= 0);
    assert.equal(saved.settingsFingerprint, imageRequest.settingsFingerprint);
    assert.ok(!JSON.stringify(saved).includes(togetherSettings.togetherKey));
    assert.equal(calls, 1);
    saveImageSettings(context.directories, { provider: 'stability', stabilityKey: 'different-secret' });
    const second = await generateQuickImageGenJobImage(context, { ...imageRequest, fetch: fetchImpl });
    assert.deepEqual(second, first);
    assert.equal(calls, 1);
});

test('an unknown image-provider outcome stays interrupted after restart', async () => {
    const context = jobContext(tempRoot());
    updateJob(context.directories, context.job.id, { state: 'running' });
    let calls = 0;
    await assert.rejects(generateQuickImageGenJobImage(context, { ...imageRequest, fetch: async () => {
        calls++;
        throw new Error('The response was lost after dispatch.');
    } }), { code: 'QIG_PROVIDER_ERROR' });
    assert.equal(calls, 1);
    assert.ok(readArtifact(context.directories, context.job.id, 'input:quick-image:image:0:0'));
    assert.equal(getJob(context.directories, context.job.id).recoverability, 'unknown-outcome');
    assert.equal(readArtifact(context.directories, context.job.id, 'provider:quick-image:image:0:0'), undefined);
    assert.ok(!recoverJobs(context.directories).recoverable.some(item => item.id === context.job.id));
    assert.equal(getJob(context.directories, context.job.id).state, 'interrupted');
    await assert.rejects(generateQuickImageGenJobImage(context, { ...imageRequest, fetch: () => assert.fail('Provider replayed') }), { code: 'QIG_RESULT_RECOVERY' });
    assert.equal(calls, 1);
});

test('a known image configuration refusal does not claim an unknown paid outcome', async () => {
    const context = jobContext(tempRoot());
    const settings = { provider: 'together' };
    saveImageSettings(context.directories, settings);
    await assert.rejects(generateQuickImageGenJobImage(context, { ...imageRequest,
        settingsFingerprint: quickImageGenSettingsFingerprint(settings) }), { code: 'QIG_MISSING_KEY' });
    assert.notEqual(getJob(context.directories, context.job.id).recoverability, 'unknown-outcome');
    assert.equal(readArtifact(context.directories, context.job.id, 'provider:quick-image:image:0:0'), undefined);
});

test('changing an image API key before dispatch refuses the source without saving the secret', async () => {
    const context = jobContext(tempRoot());
    saveImageSettings(context.directories, { ...togetherSettings, togetherKey: 'changed-private-key' });
    await assert.rejects(generateQuickImageGenJobImage(context, { ...imageRequest,
        fetch: () => assert.fail('Changed settings dispatched') }), { code: 'QIG_SETTINGS_CHANGED' });
    assert.equal(readArtifact(context.directories, context.job.id, 'input:quick-image:image:0:0'), undefined);
    assert.ok(!fs.readFileSync(path.join(context.directories.root, 'jobs', 'index.json'), 'utf8').includes('changed-private-key'));
});

test('a damaged saved image result refuses delivery without contacting the provider', async () => {
    const context = jobContext(tempRoot());
    await generateQuickImageGenJobImage(context, { ...imageRequest, fetch: async () => jsonResponse({ data: [{ b64_json: PNG_BASE64 }] }) });
    writeArtifact(context.directories, context.job.id, 'provider:quick-image:image:0:0', { base64: PNG_BASE64, format: 'jpg' });
    await assert.rejects(generateQuickImageGenJobImage(context, { ...imageRequest, fetch: () => assert.fail('Provider replayed') }), { code: 'QIG_RESULT_RECOVERY' });
});

test('a Conversation image resumes from its saved provider result without paying or skipping for cooldown', async () => {
    const directories = tempRoot();
    const branch = { id: 'main', name: 'Main', createdAt: 1, messages: [{ id: 'm1', role: 'user', name: 'User', mes: 'Hello' }] };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({
        _version: 0,
        extension_settings: { 'quick-image-gen': togetherSettings, neconyan_conversation: {
            version: 1, settings: {}, groups: [], reminders: [],
            characters: { 'nova.png': { settings: {}, activeBranchId: 'main', branches: { main: branch } } },
        } },
    }));
    const request = { user: { directories, profile: { handle: 'alice' } } };
    const context = jobContext(directories);
    const snapshot = {
        target: captureConversationTarget(request, { avatar: 'nova.png', groupId: '', personaId: '', branchId: 'main' }),
        speaker: { avatar: 'nova.png', name: 'Nova' }, settings: { image_gen_enabled: true, image_gen_cooldown: 30 },
        quickImageGenSettingsFingerprint: quickImageGenSettingsFingerprint(togetherSettings),
        macros: { extra: { character: { name: 'Nova', description: 'silver hair' } } },
    };
    const speaker = snapshot.speaker;
    let calls = 0;
    const generateImage = createConversationImageGenerator({ fetchImpl: async () => { calls++; return jsonResponse({ data: [{ b64_json: PNG_BASE64 }] }); } });
    // Simulate a restart after the provider result was durably saved but before
    // the image URL and cooldown marker were recorded.
    const prompt = buildConversationImagePrompt(
        buildSelfieImagePromptTemplate('', DEFAULT_SETTINGS.selfie_prompt, 'a casual selfie in the current moment'),
        'a casual selfie in the current moment', snapshot.macros.extra.character);
    await generateQuickImageGenJobImage(context, { effectId: 'image:0:0', prompt, negative: '',
        settingsFingerprint: snapshot.quickImageGenSettingsFingerprint,
        fetch: async () => { calls++; return jsonResponse({ data: [{ b64_json: PNG_BASE64 }] }); } });
    const changed = JSON.parse(fs.readFileSync(path.join(directories.root, 'settings.json'), 'utf8'));
    changed.extension_settings.neconyan_conversation.characters['nova.png'].branches.main.sessionMarkers = { image_at: Date.now() };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify(changed));
    assert.equal(await generateImage(context, snapshot, '', speaker), true);
    assert.equal(calls, 1);
    const result = readArtifact(directories, context.job.id, 'image:0:0');
    assert.ok(fs.existsSync(path.join(directories.root, result.url)));
    assert.equal(await generateImage(context, snapshot, '', speaker), true);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directories.root, 'settings.json'), 'utf8'))
        .extension_settings.neconyan_conversation.characters['nova.png'].branches.main.messages.length, 2);
});

test('image prompt builder and keyword detector match the browser policy', () => {
    const prompt = buildConversationImagePrompt('raw photo of {{char}}, {{scene}}', 'at the beach', { name: 'Nova', description: 'silver hair' });
    assert.match(prompt, /raw photo of Nova, at the beach/);
    assert.match(prompt, /Depict Nova specifically/);
    assert.equal(conversationReplyWantsImage({ image_gen_enabled: false, spontaneous_selfies: true }, 'send pic'), false);
    assert.equal(conversationReplyWantsImage({ image_gen_enabled: true, spontaneous_selfies: false }, 'show me a picture'), true);
    assert.equal(conversationReplyWantsImage({ image_gen_enabled: true, spontaneous_selfies: false }, 'just chatting'), false);
    assert.equal(lastUserMessageText([{ role: 'system', mes: 's' }, { role: 'user', mes: 'first' }, { role: 'character', mes: 'reply' }, { role: 'user', mes: 'second' }]), 'second');
    assert.equal(lastUserMessageText([{ role: 'user', mes: 'one' }, { role: 'user', mes: 'two' }]), 'one\n\ntwo');
    const now = 1_000_000;
    assert.equal(imageTestExports.cooldownRemainingMs({ sessionMarkers: { image_at: String(now - 60_000) } }, { image_gen_cooldown: 10 }, now), 9 * 60 * 1000);
    assert.equal(imageTestExports.cooldownRemainingMs({ sessionMarkers: { image_at: String(now - 60_000) } }, { image_gen_cooldown: 0 }, now), 0);
    assert.equal(imageTestExports.cooldownRemainingMs({}, { image_gen_cooldown: 10 }, now), 0);
});

test('the local A1111 request maps the sampler and checkpoint', async () => {
    const directories = tempRoot();
    let body = null;
    const image = await generateQuickImageGenImage({
        directories, prompt: 'x',
        fetch: async (url, options) => { body = JSON.parse(options.body); return jsonResponse({ images: [PNG_BASE64] }); },
        settings: { provider: 'local', localUrl: 'https://a1111.example', localType: 'stable-diffusion', a1111Model: 'nova.safetensors', sampler: 'euler_a' },
    });
    assert.equal(image.format, 'png');
    assert.equal(body.sampler_name, 'Euler a');
    assert.equal(body.scheduler, 'Automatic');
    assert.deepEqual(body.override_settings, { sd_model_checkpoint: 'nova.safetensors' });
});

test('a prototype property is refused, not treated as a provider', async () => {
    const directories = tempRoot();
    await assert.rejects(
        generateQuickImageGenImage({ directories, prompt: 'x', fetch: async () => jsonResponse({}), settings: { provider: 'constructor' } }),
        error => error.status === 409 && error.code === 'QIG_PROVIDER_UNSUPPORTED',
    );
});

test('an untrusted image URL from a provider is refused', async () => {
    const directories = tempRoot();
    await assert.rejects(
        generateQuickImageGenImage({
            directories, prompt: 'x',
            fetch: async () => jsonResponse({ data: [{ url: 'http://127.0.0.1/secret.png' }] }),
            settings: { provider: 'together', togetherKey: 'k' },
        }),
        error => error.code === 'QIG_UNSAFE_IMAGE_URL',
    );
});

test('the seed resolver never returns a negative seed', () => {
    assert.equal(testExports.resolveSeed(42), 42);
    assert.ok(testExports.resolveSeed(-1) >= 0);
    assert.ok(testExports.resolveSeed('nope') >= 0);
});
