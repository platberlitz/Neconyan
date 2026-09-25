import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, png as PNG } from './roleplay-transactions-fixture.js';

const { captureQuickImageRequest } = await import('../src/generation/quick-image-gen-request.js');
const { admitQuickImageJob, runQuickImageJob } = await import('../src/generation/quick-image-gen-workflow.js');
const { captureRoleplaySource } = await import('../src/generation/roleplay-source.js');
const { captureChatProfile, captureProfilePresetBinding, resolveGenerationProfile } = await import('../src/generation/profiles.js');
const { roleplayHash, roleplayStoreDirectory } = await import('../src/roleplay-store.js');
const { getJob, releaseJob, recoverJobs, updateJob } = await import('../src/jobs/store.js');
const { readArtifact, providerStep } = await import('../src/jobs/artifacts.js');
const { resolveCharacterImageSettings } = await import('../public/scripts/extensions/quick-image-gen/lib/character-settings.js');

const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const image = () => json({ data: [{ b64_json: PNG.toString('base64') }] });

function prepared(t, { qig = {}, mode = 'manual', messageIndex, requestOptions = {}, settings: overrides = {}, records, beforeCapture } = {}) {
    const f = fixture(t);
    const directories = f.scope.directories;
    Object.assign(directories, { userImages: path.join(directories.root, 'user/images'), openAI_Settings: path.join(directories.root, 'OpenAI Settings'),
        textGen_Settings: path.join(directories.root, 'TextGen Settings'), worlds: path.join(directories.root, 'worlds') });
    for (const directory of [directories.userImages, directories.openAI_Settings, directories.textGen_Settings, directories.worlds]) fs.mkdirSync(directory, { recursive: true });
    f.records[1].extra = {};
    f.records[1].mes = 'Look at the orchard';
    if (records) f.records.splice(1, f.records.length - 1, ...records);
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n') + '\n');
    fs.writeFileSync(path.join(directories.userImages, 'reference.png'), PNG);
    fs.writeFileSync(path.join(directories.openAI_Settings, 'Primary.json'), JSON.stringify({ openai_max_context: 8192, temp_openai: 0.7 }));
    fs.writeFileSync(path.join(directories.openAI_Settings, 'Image.json'), JSON.stringify({ openai_max_context: 16000, temp_openai: 0.23 }));
    fs.writeFileSync(path.join(directories.worlds, 'Orchard.json'), JSON.stringify({ entries: { 1: { uid: 1, key: ['orchard'], keysecondary: [],
        comment: 'Orchard', content: 'Silver fruit hang from every tree.', constant: false, selective: false, position: 0, order: 100, probability: 100, useProbability: false } } }));
    const settings = { username: 'Ari', power_user: { persona_description: 'A fox with silver ears.' },
        world_info_settings: { world_info: { globalSelect: ['Orchard'] }, world_info_budget: 100, world_info_depth: 5 },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1' },
        ...overrides, extension_settings: { connectionManager: { profiles: [
            { id: 'main', api: 'custom', model: 'fixture', 'api-url': 'http://127.0.0.1:18000/v1', preset: 'Primary' },
            { id: 'aux', api: 'custom', model: 'image-writer', 'api-url': 'http://127.0.0.1:18001/v1', preset: 'Primary' },
        ] }, sd: {}, ...overrides.extension_settings,
        'quick-image-gen': { provider: 'together', togetherKey: 'image-workflow-secret', togetherModel: 'image-model',
            prompt: '{{char}}, {sun|moon}, detailed', seed: 41, appendQuality: false, useSTStyle: false, batchCount: 1, ...qig } } };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify(settings));
    beforeCapture?.({ ...f, directories, settings });
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = messageIndex === undefined ? f.source() : captureRoleplaySource(f.scope, { locator: f.locator, message: messageIndex });
    const options = { avatar: 'Nova.png', mode, connection: { kind: 'profile', profileId: 'main' },
        ...(messageIndex !== undefined ? { messageIndex } : {}), ...requestOptions };
    const request = captureQuickImageRequest(f.scope, account, source, options);
    const admission = admitQuickImageJob(f.scope, account, { operationKey: 'image-workflow', source, request });
    releaseJob(directories, admission.jobId);
    const context = () => ({ directories, owner: f.scope.owner, job: getJob(directories, admission.jobId), signal: new AbortController().signal });
    return { ...f, root: directories.root, directories, account, source, request, settings, options, admission, context };
}

function paidText(call) {
    return async ({ messages, binding, jobContext, beforeDispatch, onProviderStep, maxTokens }) => {
        const step = roleplayHash({ messages, binding, maxTokens });
        onProviderStep(`provider:${step}`);
        return providerStep(jobContext, step, async () => { beforeDispatch(); return { text: await call({ messages, binding, maxTokens }) }; });
    };
}

test('missing image credentials refuse before a configured paid prompt or classifier can run', t => {
    assert.throws(() => prepared(t, { qig: { togetherKey: '', useLLMPrompt: true, twoStepPrompt: true,
        _backupContextualFilters: [{ id: 'paid-filter', enabled: true, matchMode: 'LLM', description: 'A portrait.', positive: 'detail' }] } }),
    { code: 'QIG_MISSING_KEY' });
});

test('manual images freeze batch seeds and wildcards, keep partial files and retain completion after pruning', async t => {
    const f = prepared(t, { qig: { batchCount: 3, sequentialSeeds: true } });
    const before = fs.readFileSync(f.filename);
    const calls = [];
    const fetchImpl = async (_url, init) => { calls.push(JSON.parse(init.body)); return image(); };
    await assert.rejects(runQuickImageJob(f.context(), { fetchImpl, random: () => 0,
        afterPublication: index => { if (index === 0) throw new Error('stop after saved file'); } }), /stop after saved file/);
    const plan = readArtifact(f.directories, f.admission.jobId, 'image:batch');
    assert.deepEqual(plan.items.map(item => item.seed), [41, 42, 43]);
    assert.ok(plan.items.every(item => item.positive === 'Nova, sun, detailed'));
    assert.equal(fs.readdirSync(f.directories.userImages).filter(name => name.startsWith('qig-')).length, 1);
    const result = await runQuickImageJob(f.context(), { fetchImpl, random: () => assert.fail('saved choices cannot be redrawn') });
    assert.deepEqual(calls.map(body => body.seed), [41, 42, 43]);
    assert.equal(result.result.outputs.length, 3);
    for (const output of result.result.outputs) assert.deepEqual(fs.readFileSync(path.join(f.root, output.url)), PNG);
    assert.deepEqual(fs.readFileSync(f.filename), before);
    assert.equal(JSON.stringify(f.request).includes('image-workflow-secret'), false);
    const receiptDirectory = path.join(roleplayStoreDirectory(f.scope), 'media');
    assert.equal(fs.readFileSync(path.join(receiptDirectory, fs.readdirSync(receiptDirectory)[0]), 'utf8').includes('image-workflow-secret'), false);
    fs.rmSync(path.join(f.root, 'jobs/index.json'));
    fs.rmSync(path.join(f.root, 'jobs/artifacts'), { recursive: true });
    const repeated = admitQuickImageJob(f.scope, f.account, { operationKey: 'image-workflow', source: f.source, request: f.request });
    assert.equal(repeated.created, false);
    assert.deepEqual(repeated.result, result.result);
});

test('saved character image settings select the exact card, restore the global base and isolate provider references', () => {
    const base = { provider: 'local', localType: 'a1111', prompt: 'another character', width: 1024, localRefImage: 'another reference',
        _charSettingsBaseState: { prompt: 'global portrait', width: 512, height: 512, localRefImage: 'global reference' },
        _backupCharSettings: { 'card:nova.png': { prompt: 'Nova portrait', width: 768, provider: 'stability', localRefImage: 'ignored stale ref' },
            'Nova.png': { prompt: 'legacy portrait' } },
        _backupCharRefImages: { 'card:nova.png': { localRefImage: '/user/images/nova.png', proxyRefImages: ['https://other-provider.example/image.png'] } } };
    const saved = structuredClone(base);
    const nova = resolveCharacterImageSettings(base, { avatar: 'Nova.png' });
    assert.equal(nova.prompt, 'Nova portrait');
    assert.equal(nova.provider, 'local');
    assert.equal(nova.width, 768);
    assert.equal(nova.localRefImage, '/user/images/nova.png');
    assert.deepEqual(nova.proxyRefImages, []);
    const other = resolveCharacterImageSettings(base, { avatar: 'Someone.png' });
    assert.equal(other.prompt, 'global portrait');
    assert.equal(other.localRefImage, 'global reference');
    assert.deepEqual(base, saved);
    assert.strictEqual(resolveCharacterImageSettings(base), base, 'old accepted inputs keep their original setting identity');
    assert.throws(() => resolveCharacterImageSettings({ _backupCharSettings: { 0: { prompt: 'ambiguous' } } }, { avatar: 'Nova.png' }),
        { code: 'QIG_CHARACTER_SETTINGS_INVALID' });
});

test('a native image job applies its saved character prompt, size and exact reference before the paid request', async t => {
    const f = prepared(t, { qig: { provider: 'local', localType: 'a1111', localUrl: 'http://127.0.0.1:7860',
        prompt: 'wrong active character', localRefImage: '/user/images/missing-other.png', width: 1024, height: 1024,
        _charSettingsBaseState: { prompt: 'global scene', negativePrompt: '', width: 512, height: 512, localRefImage: '' },
        _backupCharSettings: { 'card:nova.png': { prompt: '{{char}} in a blue coat', negativePrompt: 'crowded', width: 640, height: 768 } },
        _backupCharRefImages: { 'card:nova.png': { localRefImage: '/user/images/reference.png' } } } });
    assert.equal(f.request.scene, 'Nova in a blue coat');
    assert.deepEqual(f.request.snapshot.quickImageGenCharacterScope, { avatar: 'Nova.png' });
    let calls = 0;
    await runQuickImageJob(f.context(), { fetchImpl: async (url, init) => {
        calls++;
        assert.equal(url, 'http://127.0.0.1:7860/sdapi/v1/img2img');
        const body = JSON.parse(init.body);
        assert.equal(body.prompt, 'Nova in a blue coat');
        assert.equal(body.negative_prompt, 'crowded');
        assert.equal(body.width, 640);
        assert.equal(body.height, 768);
        assert.equal(body.init_images[0], PNG.toString('base64'));
        return json({ images: [PNG.toString('base64')] });
    } });
    assert.equal(calls, 1);
    const input = readArtifact(f.directories, f.admission.jobId, 'input:quick-image:image:0');
    assert.deepEqual(input.characterScope, { avatar: 'Nova.png' });
    await runQuickImageJob(f.context(), { fetchImpl: () => assert.fail('the accepted character image is already saved') });
});

test('changing a saved character override after image admission refuses before any provider', async t => {
    const f = prepared(t, { qig: { _backupCharSettings: { 'card:nova.png': { prompt: 'accepted character scene' } } } });
    f.settings.extension_settings['quick-image-gen']._backupCharSettings['card:nova.png'].prompt = 'changed character scene';
    fs.writeFileSync(path.join(f.root, 'settings.json'), JSON.stringify(f.settings));
    await assert.rejects(runQuickImageJob(f.context(), { fetchImpl: () => assert.fail('changed character settings cannot be paid') }),
        { code: 'QIG_SETTINGS_CHANGED' });
    assert.equal(getJob(f.directories, f.admission.jobId).recoveryStep, undefined);
});

test('a replaced local reference refuses before either Text AI or image generation starts', async t => {
    const f = prepared(t, { qig: { provider: 'local', localType: 'a1111', localUrl: 'http://127.0.0.1:7860',
        localRefImage: '/user/images/reference.png', useLLMPrompt: true } });
    const evidence = f.request.snapshot.quickImageGenReferenceSources;
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].relative, 'user/images/reference.png');
    const filename = path.join(f.directories.userImages, 'reference.png');
    fs.renameSync(filename, filename + '.original');
    fs.writeFileSync(filename, PNG);
    await assert.rejects(runQuickImageJob(f.context(), { generateText: () => assert.fail('changed image reference cannot start Text AI'),
        fetchImpl: () => assert.fail('changed image reference cannot start image generation') }), { code: 'QIG_REFERENCE_SOURCE_CHANGED' });
    assert.equal(getJob(f.directories, f.admission.jobId).recoveryStep, undefined);
});

test('every image in a resumed batch uses the reference bytes frozen before the first prompt request', async t => {
    const f = prepared(t, { qig: { provider: 'local', localType: 'a1111', localUrl: 'http://127.0.0.1:7860',
        localRefImage: '/user/images/reference.png', useLLMPrompt: true, batchCount: 2, sequentialSeeds: true } });
    let prompts = 0;
    let images = 0;
    const filename = path.join(f.directories.userImages, 'reference.png');
    const generateText = paidText(async () => {
        prompts++;
        fs.writeFileSync(filename, 'changed after the accepted bytes were saved');
        return 'Nova, fine detail';
    });
    const fetchImpl = async (_url, init) => {
        images++;
        assert.equal(JSON.parse(init.body).init_images[0], PNG.toString('base64'));
        return json({ images: [PNG.toString('base64')] });
    };
    await assert.rejects(runQuickImageJob(f.context(), { generateText, fetchImpl,
        afterPublication: index => { if (index === 0) throw new Error('saved first batch image'); } }), /saved first batch image/);
    await runQuickImageJob(f.context(), { generateText: () => assert.fail('the prompt is already saved'), fetchImpl });
    assert.equal(prompts, 1);
    assert.equal(images, 2);
    const input = readArtifact(f.directories, f.admission.jobId, 'input:quick-image:image:1');
    assert.equal(input.referenceSourcesHash, roleplayHash(f.request.snapshot.quickImageGenReferenceSources));
});

test('reference capture rejects normalised traversal instead of accepting another saved file', t => {
    assert.throws(() => prepared(t, { qig: { provider: 'local', localType: 'a1111', localUrl: 'http://127.0.0.1:7860',
        localRefImage: '/user/images/another/../reference.png' } }), { code: 'QIG_INVALID_REFERENCE' });
});

for (const provider of ['nanogpt', 'nanobanana', 'custom']) {
    test(`${provider} receives the frozen account reference chosen for the saved character`, async t => {
        const field = { nanogpt: 'nanogptRefImages', nanobanana: 'nanobananaRefImages', custom: 'customApiRefImages' }[provider];
        const f = prepared(t, { qig: { provider, nanogptKey: 'nano-key', nanogptModel: 'model-x', nanobananaKey: 'banana-key',
            customApiUrl: 'https://custom.example/image', customApiRequestTemplate: '{"prompt":"{{prompt}}","references":"{{referenceImages}}"}',
            customApiResponsePath: '/data/0/b64_json', customApiResponseType: 'base64', customApiMode: 'direct',
            _backupCharSettings: { 'card:nova.png': { prompt: 'Nova in a coat' } },
            _backupCharRefImages: { 'card:nova.png': { [field]: ['/user/images/reference.png'] } } } });
        let paid = 0;
        await runQuickImageJob(f.context(), { fetchImpl: async (url, init) => {
            if (url.startsWith('data:')) return new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
            if (url.endsWith('/endpoints')) return json({ endpoints: [{ capabilities: { image_to_image: true },
                input_reference_constraints: { max_items: 1, formats: ['image/png'] }, supported_parameters: { seed: true } }] });
            paid++;
            const body = JSON.parse(init.body);
            const reference = provider === 'nanogpt' ? body.input_references[0] : provider === 'custom' ? body.references[0]
                : `data:${body.contents[0].parts[0].inlineData.mimeType};base64,${body.contents[0].parts[0].inlineData.data}`;
            assert.equal(reference, `data:image/png;base64,${PNG.toString('base64')}`);
            return image();
        } });
        assert.equal(paid, 1);
        await runQuickImageJob(f.context(), { fetchImpl: () => assert.fail('saved account reference cannot trigger a new paid result') });
    });
}

test('two saved Text AI passes use exact scene, lore, auxiliary preset, history role and prefill before images', async t => {
    const f = prepared(t, { mode: 'scene', qig: { useLLMPrompt: true, twoStepPrompt: true, useWorldInfo: true,
        messageRange: 'last2', llmOverrideEnabled: true, llmOverrideProfileId: 'aux', llmOverridePreset: 'Image',
        llmOverrideMaxTokens: 123, llmOverrideChatDepth: 2, llmRequestRole: 'system', llmPrefill: 'Tags:', llmAddArtist: true,
        style: 'cinematic', appendQuality: true, qualityTags: 'quality', useSTStyle: true },
    settings: { extension_settings: { sd: { prompt_prefix: '{prompt}, canvas', negative_prompt: 'cropped' } } } });
    const savedSettings = fs.readFileSync(path.join(f.root, 'settings.json'));
    const passes = [];
    const generateText = paidText(async value => {
        passes.push(value);
        assert.equal(value.binding.profileId, 'aux');
        assert.equal(value.binding.presetOverride, 'Image');
        assert.equal(resolveGenerationProfile(f.directories, value.binding).preset.temp_openai, 0.23);
        assert.equal(value.maxTokens, 123);
        assert.equal(value.messages[0].role, 'system');
        assert.match(value.messages[0].content, /Silver fruit hang from every tree/);
        return passes.length === 1 ? 'Plain visual description: Nova in the orchard.' : 'Tags: Nova, orchard, fine detail, fine detail';
    });
    const results = [];
    await runQuickImageJob(f.context(), { generateText, random: () => 0, fetchImpl: async (_url, init) => { results.push(JSON.parse(init.body)); return image(); } });
    assert.equal(passes.length, 2);
    assert.match(passes[0].messages[0].content, /Ari: Look at the orchard|User: Look at the orchard/);
    assert.match(passes[1].messages[0].content, /Nova in the orchard/);
    assert.deepEqual(passes[1].messages.at(-1), { role: 'assistant', content: 'Tags:' });
    assert.match(results[0].prompt, /quality, cinematic, movie still, Nova, orchard, fine detail, dramatic lighting, anamorphic, canvas/);
    assert.equal(results[0].prompt.split('fine detail').length - 1, 1);
    assert.ok(readArtifact(f.directories, f.admission.jobId, 'image:world-info').selection.activated.length);
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'settings.json')), savedSettings);
    await runQuickImageJob(f.context(), { generateText: () => assert.fail('saved passes cannot repeat'), fetchImpl: () => assert.fail('saved image cannot repeat') });
});

test('unknown second Text AI outcome cannot repeat the first pass, enter another provider or publish images', async t => {
    const f = prepared(t, { mode: 'scene', qig: { useLLMPrompt: true, twoStepPrompt: true } });
    updateJob(f.directories, f.admission.jobId, { state: 'running' });
    let calls = 0;
    await assert.rejects(runQuickImageJob(f.context(), { generateText: paidText(() => {
        if (++calls === 1) return 'Nova beside an orchard tree.';
        throw new Error('lost paid prompt response');
    }), fetchImpl: () => assert.fail('image work must wait for a complete prompt') }), /lost paid prompt response/);
    assert.equal(calls, 2);
    recoverJobs(f.directories);
    assert.equal(getJob(f.directories, f.admission.jobId).state, 'interrupted');
    await assert.rejects(runQuickImageJob(f.context(), { generateText: () => assert.fail('unknown model result repeated'), fetchImpl: () => assert.fail('unknown prompt reached image') }), { code: 'QIG_RESULT_RECOVERY' });
    assert.equal(calls, 2);
    assert.equal(fs.readdirSync(f.directories.userImages).filter(name => name.startsWith('qig-')).length, 0);
});

test('a separate preset is bound by physical identity and never mutates the original saved profile', async t => {
    const f = prepared(t, { qig: { useLLMPrompt: true, llmOverrideEnabled: true, llmOverrideProfileId: 'aux', llmOverridePreset: 'Image' } });
    const original = captureChatProfile(f.directories, 'aux');
    assert.equal(resolveGenerationProfile(f.directories, original).preset.temp_openai, 0.7);
    const selected = f.request.snapshot.quickImageGenTextAI.binding;
    assert.equal(resolveGenerationProfile(f.directories, selected).preset.temp_openai, 0.23);
    const filename = path.join(f.directories.openAI_Settings, 'Image.json');
    fs.renameSync(filename, filename + '.old');
    fs.copyFileSync(filename + '.old', filename);
    assert.throws(() => resolveGenerationProfile(f.directories, selected), /preset or connection changed/);
    await assert.rejects(runQuickImageJob(f.context(), { generateText: () => assert.fail('a replaced preset cannot be paid'), fetchImpl: () => assert.fail('no image') }), /preset or connection changed/);
    assert.deepEqual(captureChatProfile(f.directories, 'aux'), original);
});

test('reviewed final prompts honour configured confirmation before admission and bypass paid prompt writers', async t => {
    const f = prepared(t, { qig: { reviewBeforeGenerate: true, confirmBeforeGenerate: true, useLLMPrompt: true,
        appendQuality: true, style: 'cinematic' }, requestOptions: { confirmed: true, reviewed: { positive: 'Approved final', negative: 'cut off' } } });
    assert.throws(() => captureQuickImageRequest(f.scope, f.account, f.source, { avatar: 'Nova.png', mode: 'manual' }), /review/);
    await runQuickImageJob(f.context(), { generateText: () => assert.fail('the already reviewed prompt cannot be regenerated'), fetchImpl: async (_url, init) => {
        assert.equal(JSON.parse(init.body).prompt, 'Approved final');
        return image();
    } });
});

test('proxy Chat Image binds selected saved image references, personality and the batch seed', async t => {
    const f = prepared(t, { mode: 'scene', messageIndex: 0, records: [{ name: 'Ari', is_user: true, mes: 'A fox under the moon',
        extra: { media: [{ type: 'image', url: '/user/images/reference.png', source: 'upload' }], media_display: 'gallery', media_index: 0 } }],
    qig: { provider: 'proxy', proxyUrl: 'https://proxy.example/v1', proxyModel: 'fixture', proxyKey: 'proxy-fixture-key', proxySeed: 73,
        proxyChatImageMode: true, proxyChatImageIncludePersonality: true, proxyRefImages: [], proxyRefImageMode: 'inline_or_url' } });
    let calls = 0;
    await runQuickImageJob(f.context(), { fetchImpl: async (url, init) => {
        calls++;
        assert.equal(url, 'https://proxy.example/v1/chat/completions');
        assert.equal(init.headers.Authorization, 'Bearer proxy-fixture-key');
        const body = JSON.parse(init.body);
        assert.match(body.messages[0].content, /Original/);
        assert.match(body.messages[0].content, /A fox with silver ears/);
        assert.match(body.messages[1].content[0].image_url.url, /^data:image\/png;base64,/);
        assert.equal(body.seed, 73);
        return image();
    } });
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(f.request).includes('proxy-fixture-key'), false);
});

test('ComfyUI workflows receive each saved batch index and count without enlarging one paid request', async t => {
    const f = prepared(t, { qig: { provider: 'local', localType: 'comfyui', localUrl: 'http://127.0.0.1:8188',
        batchCount: 2, sequentialSeeds: true, comfyWorkflow: JSON.stringify({ 1: { class_type: 'Fixture', inputs: {
            text: '%prompt%', seed: '%seed%', index: '%batch_index%', count: '%batch_count%',
        } } }) } });
    const submissions = [];
    await runQuickImageJob(f.context(), { wait: async () => {}, fetchImpl: async (url, init) => {
        if (url.endsWith('/prompt')) {
            submissions.push(JSON.parse(init.body).prompt['1'].inputs);
            return json({ prompt_id: String(submissions.length) });
        }
        if (url.includes('/history/')) return json({ [url.split('/').at(-1)]: { status: { status_str: 'success', completed: true },
            outputs: { 9: { images: [{ filename: 'image.png', subfolder: '', type: 'output' }] } } } });
        if (url.includes('/view?')) return new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
        assert.fail(`Unexpected ComfyUI fixture request: ${url}`);
    } });
    assert.deepEqual(submissions.map(body => [body.index, body.count, body.seed]), [[0, 2, 41], [1, 2, 42]]);
});

test('image target conflicts and protected source edits refuse before any model or image call', async t => {
    const f = prepared(t);
    assert.throws(() => admitQuickImageJob(f.scope, f.account, { operationKey: 'image-workflow', source: f.source,
        request: { ...f.request, negative: 'different' } }), { code: 'MEDIA_INTENT_CONFLICT' });
    assert.throws(() => admitQuickImageJob(f.scope, f.account, { operationKey: 'other', source: f.source, request: f.request }), { code: 'MEDIA_TARGET_BUSY' });
    f.records[1].mes = 'A different source';
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n') + '\n');
    await assert.rejects(runQuickImageJob(f.context(), { generateText: () => assert.fail('source changed'), fetchImpl: () => assert.fail('source changed') }), /changed|differs/);
});

test('a saved Text Completion auxiliary preset is independent of its named profile and detects replacement', t => {
    const f = prepared(t, { settings: { max_context: 4096, textgenerationwebui_settings: { type: 'ooba' } },
        beforeCapture: ({ directories, settings }) => {
            settings.extension_settings.connectionManager.profiles.push({ id: 'text', mode: 'tc', api: 'ooba', model: 'text-model', 'api-url': 'http://127.0.0.1:5000' });
            fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify(settings));
            fs.writeFileSync(path.join(directories.textGen_Settings, 'TextImage.json'), JSON.stringify({ max_context: 8192, temperature: 0.21 }));
        } });
    const original = { kind: 'profile', ...captureChatProfile(f.directories, 'text') };
    const selected = captureProfilePresetBinding(f.directories, original, 'TextImage');
    assert.equal(resolveGenerationProfile(f.directories, selected).preset.temperature, 0.21);
    assert.equal(resolveGenerationProfile(f.directories, original).preset, undefined);
    fs.writeFileSync(path.join(f.directories.textGen_Settings, 'TextImage.json'), JSON.stringify({ max_context: 8192, temperature: 0.9 }));
    assert.throws(() => resolveGenerationProfile(f.directories, selected), /preset or connection changed/);
});
