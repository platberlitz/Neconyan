import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { fixture } from './roleplay-transactions-fixture.js';

const { captureSpeechRequest, admitSpeechJob, runSpeechJob, generateSavedSpeech } = await import('../src/generation/speech-jobs.js');
const { captureRoleplaySource } = await import('../src/generation/roleplay-source.js');
const { getJob, releaseJob, recoverJobs, updateJob, jobKey } = await import('../src/jobs/store.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');
const { pcmWave, readAudioArtifact } = await import('../src/jobs/audio-artifacts.js');
const { writeSecret, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
const { synthesizeEdgeSpeech } = await import('../src/generation/speech-edge.js');
const { roleplayHash } = await import('../src/roleplay-store.js');
const WAVE = pcmWave(Buffer.alloc(480, 1));
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const audio = () => new Response(WAVE, { headers: { 'Content-Type': 'audio/wav' } });

function prepared(t, { provider = 'OpenAI', text = 'Read this aloud.', controls = {}, options = {}, entry = 'nova', keys = [], lockedPersona = false } = {}) {
    const f = fixture(t);
    f.records[2].mes = text;
    f.records[2].swipes[0] = text;
    if (lockedPersona) f.records[0].chat_metadata.persona = 'locked.png';
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n') + '\n');
    const directories = f.scope.directories;
    directories.files = path.join(directories.root, 'user', 'files');
    const settings = { extension_settings: { tts: { enabled: true, auto_generation: true, currentProvider: provider,
        [provider]: { voiceMap: { Nova: entry }, ...controls }, ...options } }, power_user: {} };
    if (lockedPersona) {
        directories.avatars = path.join(directories.root, 'User Avatars');
        fs.mkdirSync(directories.avatars);
        fs.copyFileSync(path.join(directories.characters, 'Nova.png'), path.join(directories.avatars, 'locked.png'));
        settings.username = 'Global user';
        settings.power_user = { persona_description: 'The unrelated global persona.', personas: { 'locked.png': 'Ari' },
            persona_descriptions: { 'locked.png': { description: 'The selected fox persona.', position: 0 } } };
    }
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify(settings));
    const required = { OpenAI: ['OPENAI'], 'OpenAI Compatible': ['CUSTOM_OPENAI_TTS'], ElevenLabs: ['ELEVENLABS'], Pollinations: ['POLLINATIONS'],
        Azure: ['AZURE_TTS'], Chutes: ['CHUTES'], Novel: ['NOVEL'], 'Electron Hub': ['ELECTRONHUB'], MiniMax: ['MINIMAX', 'MINIMAX_GROUP_ID'],
        Volcengine: ['VOLCENGINE_APP_ID', 'VOLCENGINE_ACCESS_KEY'], 'Google Gemini TTS': ['MAKERSUITE'] }[provider] || [];
    for (const key of [...required, ...keys]) writeSecret(directories, SECRET_KEYS[key], `private-${key}`);
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator, message: 1 });
    const request = captureSpeechRequest(f.scope, account, source);
    const admission = admitSpeechJob(f.scope, account, { operationKey: 'speech-fixture', source, request });
    releaseJob(directories, admission.jobId);
    const context = () => ({ directories, owner: f.scope.owner, job: getJob(directories, admission.jobId), signal: new AbortController().signal });
    return { ...f, directories, account, source, request, admission, context, settings };
}

test('native speech binds source, controls and credentials, then retains its saved audio after job pruning', async t => {
    const f = prepared(t, { controls: { speed: 1.25, model: 'gpt-4o-mini-tts', characterInstructions: { Nova: 'Speak as {{char}}.' } } });
    let paid = 0;
    const before = fs.readFileSync(f.filename);
    const result = await runSpeechJob(f.context(), { fetchImpl: async (url, init) => {
        paid++;
        assert.equal(url, 'https://api.openai.com/v1/audio/speech');
        assert.equal(init.headers.Authorization, 'Bearer private-OPENAI');
        assert.deepEqual(JSON.parse(init.body), { input: 'Read this aloud.', voice: 'nova', model: 'gpt-4o-mini-tts', speed: 1.25,
            response_format: 'wav', instructions: 'Speak as Nova.' });
        return audio();
    } });
    assert.equal(paid, 1);
    assert.equal(result.result.narration.status, 'ready');
    assert.deepEqual(fs.readFileSync(path.join(f.directories.root, result.result.files[0].url.slice(1))), WAVE);
    assert.deepEqual(fs.readFileSync(f.filename), before);
    assert.equal(JSON.stringify(f.request).includes('private-OPENAI'), false);
    const artifactDir = path.join(f.directories.root, 'jobs', 'artifacts', jobKey(f.admission.jobId));
    for (const filename of fs.readdirSync(artifactDir).filter(file => file.endsWith('.json'))) {
        assert.equal(fs.readFileSync(path.join(artifactDir, filename), 'utf8').includes('private-OPENAI'), false);
    }
    fs.rmSync(path.join(f.directories.root, 'jobs', 'index.json'));
    fs.rmSync(path.join(f.directories.root, 'jobs', 'artifacts'), { recursive: true });
    assert.deepEqual(admitSpeechJob(f.scope, f.account, { operationKey: 'speech-fixture', source: f.source, request: f.request }).result, result.result);
});

test('manual speech uses the protected chat persona and refuses a replaced persona identity before paying', async t => {
    const controls = { characterInstructions: { Nova: 'Speak to {{user}}. {{persona}}' } };
    const f = prepared(t, { lockedPersona: true, controls });
    assert.equal(f.request.snapshot.macros.names.user, 'Ari');
    assert.equal(f.request.snapshot.macros.character.persona, 'The selected fox persona.');
    await runSpeechJob(f.context(), { fetchImpl: async (_url, init) => {
        assert.equal(JSON.parse(init.body).instructions, 'Speak to Ari. The selected fox persona.');
        return audio();
    } });
    const changed = prepared(t, { lockedPersona: true, controls });
    const avatar = path.join(changed.directories.avatars, 'locked.png');
    fs.renameSync(avatar, `${avatar}.old`);
    fs.copyFileSync(`${avatar}.old`, avatar);
    await assert.rejects(runSpeechJob(changed.context(), { fetchImpl: () => assert.fail('replaced persona spent on speech') }), { code: 'TTS_SOURCE_CHANGED' });
    assert.equal(readArtifact(changed.directories, changed.admission.jobId, 'provider:speech:manual:0'), undefined);
});

test('missing synthesis output addresses never become a fabricated download or repeat the request', async t => {
    const f = prepared(t, { provider: 'AllTalk', entry: 'nova.wav', controls: { provider_endpoint: 'http://localhost:7851' } });
    let paid = 0;
    await assert.rejects(runSpeechJob(f.context(), { fetchImpl: async (url) => {
        if (url.endsWith('/voices')) return json({ voices: ['nova.wav'] });
        assert.ok(url.endsWith('/tts-generate'), 'an absent address cannot cause a download');
        paid++;
        return json({});
    } }), { code: 'TTS_PROVIDER' });
    await assert.rejects(runSpeechJob(f.context(), { fetchImpl: () => assert.fail('an unknown synthesis response repeated') }), { code: 'TTS_RESULT_RECOVERY' });
    assert.equal(paid, 1);
});

test('multiple saved voices produce an ordered playlist and resume only uncompleted parts', async t => {
    const f = prepared(t, { text: '*waves* "Hello." Then smiles.', options: { multi_voice_enabled: true, pass_asterisks: true },
        controls: { voiceMap: { 'Nova (*Text inside asterisks*)': 'alloy', 'Nova ("Quotes")': 'nova', 'Nova (Other text)': 'echo' } } });
    let paid = 0;
    const bodies = [];
    await assert.rejects(runSpeechJob(f.context(), { fetchImpl: async (_url, init) => {
        paid++; bodies.push(JSON.parse(init.body));
        if (paid === 1) {
            const edited = structuredClone(f.settings);
            edited.extension_settings.tts.OpenAI.speed = 2;
            fs.writeFileSync(path.join(f.directories.root, 'settings.json'), JSON.stringify(edited));
        }
        return audio();
    } }), { code: 'TTS_SOURCE_CHANGED' });
    assert.equal(paid, 1);
    fs.writeFileSync(path.join(f.directories.root, 'settings.json'), JSON.stringify(f.settings));
    const result = await runSpeechJob(f.context(), { fetchImpl: async (_url, init) => { paid++; bodies.push(JSON.parse(init.body)); return audio(); } });
    assert.deepEqual(bodies.map(body => [body.voice, body.input]), [['alloy', 'waves'], ['nova', 'Hello.'], ['echo', 'Then smiles.']]);
    assert.equal(result.result.narration.artifacts.length, 3);
    assert.equal(paid, 3);
});

test('speech unknown results remain interrupted after process recovery and cannot pay again', async t => {
    const f = prepared(t);
    updateJob(f.directories, f.admission.jobId, { state: 'running' });
    let calls = 0;
    await assert.rejects(runSpeechJob(f.context(), { fetchImpl: async () => { calls++; throw new Error('lost private-OPENAI'); } }), { code: 'TTS_PROVIDER' });
    recoverJobs(f.directories);
    assert.equal(getJob(f.directories, f.admission.jobId).state, 'interrupted');
    await assert.rejects(runSpeechJob(f.context(), { fetchImpl: () => assert.fail('unknown synthesis repeated') }), { code: 'TTS_RESULT_RECOVERY' });
    assert.equal(calls, 1);
});

test('saved audio corruption cannot cause another provider call', async t => {
    const f = prepared(t);
    const args = { ...f.request, effectId: 'corruption' };
    const result = await generateSavedSpeech(f.context(), args, { fetchImpl: async () => audio() });
    const filename = path.join(f.directories.root, 'jobs', 'artifacts', jobKey(f.admission.jobId), `${jobKey(result.artifact)}.audio`);
    fs.writeFileSync(filename, pcmWave(Buffer.alloc(480, 2)));
    await assert.rejects(generateSavedSpeech(f.context(), args, { fetchImpl: () => assert.fail('saved audio must not repeat synthesis') }), { code: 'TTS_RESULT_RECOVERY' });
});

test('a definite speech refusal fails softly once, and without soft failure leaves no unknown step', async t => {
    const f = prepared(t);
    let calls = 0;
    const refused = async () => { calls++; return new Response('busy', { status: 503 }); };
    const args = { ...f.request, effectId: 'refused', failSoft: true };
    const failed = await generateSavedSpeech(f.context(), args, { fetchImpl: refused });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.code, 'TTS_PROVIDER');
    assert.deepEqual(await generateSavedSpeech(f.context(), args, { fetchImpl: () => assert.fail('a failed narration must not ask again') }), failed);
    const html = await generateSavedSpeech(f.context(), { ...f.request, effectId: 'html', failSoft: true },
        { fetchImpl: async () => { calls++; return new Response(WAVE, { headers: { 'Content-Type': 'text/html' } }); } });
    assert.equal(html.status, 'failed');
    assert.equal(html.code, 'TTS_INVALID_AUDIO');
    await assert.rejects(generateSavedSpeech(f.context(), { ...f.request, effectId: 'strict' }, { fetchImpl: refused }), { code: 'TTS_PROVIDER' });
    const job = getJob(f.directories, f.admission.jobId);
    assert.notEqual(job.recoverability, 'unknown-outcome');
    assert.equal((await generateSavedSpeech(f.context(), { ...f.request, effectId: 'strict' }, { fetchImpl: async () => { calls++; return audio(); } })).status, 'ready');
    assert.equal(calls, 4);
});

test('saved synthesis URL survives a failed download without another AllTalk generation', async t => {
    const f = prepared(t, { provider: 'AllTalk', entry: 'nova.wav', controls: { provider_endpoint: 'http://localhost:7851', rvc_character_voice: 'nova.pth', rvc_character_pitch: 3 } });
    let paid = 0, downloads = 0;
    const fetchImpl = async (url, init) => {
        if (url.endsWith('/voices')) return json({ voices: ['nova.wav'] });
        if (url.endsWith('/tts-generate')) {
            paid++;
            const body = new URLSearchParams(init.body);
            assert.equal(body.get('rvccharacter_voice_gen'), 'nova.pth');
            assert.equal(body.get('rvccharacter_pitch'), '3');
            return json({ output_file_url: '/audio/saved.wav' });
        }
        assert.equal(url, 'http://localhost:7851/audio/saved.wav');
        downloads++;
        if (downloads === 1) throw new Error('download stopped');
        return audio();
    };
    await assert.rejects(runSpeechJob(f.context(), { fetchImpl }));
    assert.equal(readArtifact(f.directories, f.admission.jobId, 'provider:speech:manual:0').url, 'http://localhost:7851/audio/saved.wav');
    assert.equal((await runSpeechJob(f.context(), { fetchImpl })).result.files.length, 1);
    assert.equal(paid, 1);
    assert.equal(downloads, 2);
});

test('local SpeechT5 records the selected speaker samples and playable PCM output', async t => {
    const speaker = Buffer.alloc(2048);
    for (let i = 0; i < 512; i++) speaker.writeFloatLE(i / 1000, i * 4);
    const f = prepared(t, { provider: 'SpeechT5', entry: 'uploaded', controls: { speakers: [{ name: 'uploaded', voice_id: 'uploaded', data: speaker.toString('base64') }] } });
    let calls = 0;
    const result = await runSpeechJob(f.context(), { localSynthesis: async segment => {
        calls++;
        assert.equal(segment.voice.data, speaker.toString('base64'));
        return { audio: new Float32Array([0, 0.5, -0.5]), sampling_rate: 16000 };
    }, fetchImpl: () => assert.fail('SpeechT5 must remain local') });
    assert.equal(calls, 1);
    const saved = readAudioArtifact(f.directories, f.admission.jobId, result.result.narration.artifact);
    assert.equal(Buffer.from(saved.base64, 'base64').readUInt32LE(24), 16000);
});

test('Kokoro is the explicit page-open exception, while unavailable OS voices never substitute another voice', async t => {
    const f = prepared(t, { provider: 'Kokoro' });
    assert.equal((await runSpeechJob(f.context(), { fetchImpl: () => assert.fail('browser Kokoro contacted a provider') })).result.narration.status, 'browser');
    const system = prepared(t, { provider: 'System', entry: 'missing OS voice' });
    await assert.rejects(runSpeechJob(system.context(), { systemVoices: async () => [{ id: 'other', name: 'other' }],
        systemSynthesis: () => assert.fail('the selected OS voice was silently replaced') }), { code: 'TTS_VOICE_MISSING' });
});

test('Edge requires an explicit completed speech turn and retains its saved rate and voice', async () => {
    const segment = { id: roleplayHash('edge test'), text: 'Hello <Nova>.', voice: { id: 'en-US-AriaNeural' } };
    const config = { settings: { rate: 20 } };
    const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4]);
    const connect = complete => (url, options) => {
        assert.match(url, /^wss:\/\/speech\.platform\.bing\.com/);
        assert.equal(options.followRedirects, false);
        const socket = new EventEmitter();
        const messages = [];
        socket.close = () => {};
        socket.terminate = () => {};
        socket.send = message => {
            messages.push(message);
            if (messages.length !== 2) return;
            assert.match(message, /rate='\+20%'/);
            assert.match(message, /en-US-AriaNeural/);
            assert.match(message, /Hello &lt;Nova&gt;/);
            const header = Buffer.from('Path:audio\r\nContent-Type:audio/mpeg\r\n');
            const prefix = Buffer.alloc(2); prefix.writeUInt16BE(header.length);
            socket.emit('message', Buffer.concat([prefix, header, mp3]), true);
            socket.emit('message', Buffer.from(`Path:${complete ? 'turn.end' : 'turn.start'}\r\n\r\n`), false);
            if (!complete) socket.emit('close');
        };
        queueMicrotask(() => socket.emit('open'));
        return socket;
    };
    assert.deepEqual(await synthesizeEdgeSpeech(config, segment, new AbortController().signal, { socketFactory: connect(true), now: 0 }), mp3);
    await assert.rejects(synthesizeEdgeSpeech(config, segment, new AbortController().signal, { socketFactory: connect(false), now: 0 }), { code: 'TTS_RESULT_RECOVERY' });
});

const providerCases = [
    { provider: 'OpenAI Compatible', controls: { provider_endpoint: 'http://localhost:7777/v1/audio/speech', available_voices: ['saved-voice'], model: 'custom-tts', speed: 0.75 }, entry: 'saved-voice',
        path: '/v1/audio/speech', header: ['Authorization', 'Bearer private-CUSTOM_OPENAI_TTS'], body: { voice: 'saved-voice', model: 'custom-tts', speed: 0.75 } },
    { provider: 'ElevenLabs', entry: 'Account voice', controls: { model: 'eleven_multilingual_v2', style_exaggeration: 0.4, speaker_boost: false },
        discovery: { '/v1/voices': { voices: [{ name: 'Account voice', voice_id: 'voice-42' }] }, '/v1/history': { history: [] } },
        path: '/v1/text-to-speech/voice-42', header: ['xi-api-key', 'private-ELEVENLABS'], body: { model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.75, similarity_boost: 0.75, speed: 1, style: 0.4, use_speaker_boost: false } } },
    { provider: 'Pollinations', entry: 'nova', discovery: { '/audio/models': [{ name: 'elevenlabs/eleven-v3', aliases: ['tts-1'], voices: ['rachel'] }, { name: 'openai/tts-1', aliases: [], voices: ['nova'] }] },
        path: '/v1/audio/speech', header: ['Authorization', 'Bearer private-POLLINATIONS'], body: { model: 'openai/tts-1', voice: 'nova' } },
    { provider: 'Azure', entry: 'en-US-AriaNeural', controls: { region: 'eastus' },
        discovery: { '/cognitiveservices/voices/list': [{ ShortName: 'en-US-AriaNeural', Locale: 'en-US' }] },
        path: '/cognitiveservices/v1', header: ['Ocp-Apim-Subscription-Key', 'private-AZURE_TTS'],
        verify: (_url, init) => { assert.match(init.body, /<voice name='en-US-AriaNeural'>Read this aloud\.<\/voice>/); assert.equal(init.headers['X-Microsoft-OutputFormat'], 'webm-24khz-16bit-mono-opus'); } },
    { provider: 'Chutes', entry: 'Heart (Female) - Default', controls: { speed: 1.5 }, path: '/speak',
        header: ['Authorization', 'Bearer private-CHUTES'], body: { voice: 'af_heart', speed: 1.5 } },
    { provider: 'Novel', entry: 'Saved seed voice', path: '/ai/generate-voice', method: 'GET', header: ['Authorization', 'Bearer private-NOVEL'],
        verify: url => { assert.equal(url.searchParams.get('seed'), 'Saved seed voice'); assert.equal(url.searchParams.get('version'), 'v2'); assert.equal(url.searchParams.get('text'), 'Read this aloud.'); } },
    { provider: 'Google Translate', entry: 'en', path: '/_/TranslateWebserverUi/data/batchexecute',
        verify: (_url, init) => { const frame = JSON.parse(new URLSearchParams(init.body).get('f.req'))[0][0]; assert.equal(frame[0], 'jQ1olc'); assert.deepEqual(JSON.parse(frame[1]), ['Read this aloud.', 'en', true]); },
        response: () => new Response(`)]}'\n\n${JSON.stringify([['wrb.fr', 'jQ1olc', JSON.stringify([WAVE.toString('base64')]), null, null, '0']])}\n`) },
    { provider: 'Google Gemini TTS', entry: 'Puck', path: '/v1beta/models/gemini-2.5-flash-preview-tts:generateContent', header: ['x-goog-api-key', 'private-MAKERSUITE'],
        body: { contents: [{ role: 'user', parts: [{ text: 'Read this aloud.' }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } } } },
        response: () => json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=16000', data: Buffer.alloc(240).toString('base64') } }] } }] }) },
    { provider: 'Electron Hub', entry: 'speaker', controls: { model: 'microsoft-fixture', top_p: 0.6, speech_rate: 4, pitch_adjustment: 2, emotional_style: 'cheerful' },
        discovery: { '/v1/models': { data: [{ id: 'microsoft-fixture', voices: ['speaker'], parameters: ['top_p', 'emotional_style'] }] } }, path: '/v1/audio/speech',
        header: ['Authorization', 'Bearer private-ELECTRONHUB'], body: { model: 'microsoft-fixture', voice: 'speaker', top_p: 0.6, speech_rate: 4, pitch_adjustment: 2, emotional_style: 'cheerful' } },
    { provider: 'MiniMax', entry: 'Unrestrained Young Man', controls: { format: 'wav', audioSampleRate: 24000, pitch: 2 }, path: '/v1/t2a_v2', header: ['Authorization', 'Bearer private-MINIMAX'],
        body: { model: 'speech-02-hd', voice_setting: { voice_id: 'Chinese (Mandarin)_Unrestrained_Young_Man', speed: 1, vol: 1, pitch: 2 }, audio_setting: { sample_rate: 24000, bitrate: 128000, format: 'wav', channel: 1 } },
        verify: url => assert.equal(url.searchParams.get('GroupId'), 'private-MINIMAX_GROUP_ID'),
        response: () => json({ base_resp: { status_code: 0 }, data: { audio: WAVE.toString('hex') } }) },
    { provider: 'Volcengine', entry: 'zh_female_xiaohe_uranus_bigtts', controls: { resource_id: 'resource', speed: 15 }, path: '/api/v3/tts/unidirectional',
        header: ['X-Api-Access-Key', 'private-VOLCENGINE_ACCESS_KEY'], verify: (_url, init) => { const body = JSON.parse(init.body); assert.equal(body.req_params.speaker, 'zh_female_xiaohe_uranus_bigtts'); assert.equal(body.req_params.audio_params.speech_rate, 15); },
        response: () => new Response(`${JSON.stringify({ code: 0, data: WAVE.toString('base64') })}\n${JSON.stringify({ code: 20000000 })}\n`) },
    { provider: 'Silero', entry: 'speaker', discovery: { '/tts/speakers': [{ name: 'speaker', voice_id: 'speaker-id' }] }, path: '/tts/generate', body: { speaker: 'speaker-id', session: 'sillytavern' } },
    { provider: 'XTTSv2', entry: 'speaker', controls: { temperature: 0.3, speed: 1.2, language: 'fr' }, discovery: { '/speakers': ['speaker'] }, path: '/tts_to_audio/',
        settingsPath: '/set_tts_settings', body: { text: 'Read this aloud.', speaker_wav: 'speaker', language: 'fr' },
        settingsBody: { temperature: 0.3, length_penalty: 1, repetition_penalty: 5, top_k: 50, top_p: 0.85, speed: 1.2, enable_text_splitting: true, stream_chunk_size: 100 } },
    { provider: 'VITS', entry: '[BERT-VITS2] Speaker (en)', controls: { style_text: 'quiet', style_weight: 0.7 },
        discovery: { '/voice/speakers': { 'BERT-VITS2': [{ id: 3, name: 'Speaker', lang: ['en'] }] } }, path: '/voice/bert-vits2',
        verify: (_url, init) => { const body = new URLSearchParams(init.body); assert.equal(body.get('id'), '3'); assert.equal(body.get('style_text'), 'quiet'); assert.equal(body.get('style_weight'), '0.7'); assert.equal(body.get('format'), 'wav'); } },
    { provider: 'GSVI', entry: 'Nova', controls: { top_k: 4, stream: true }, discovery: { '/character_list': { Nova: {} } }, path: '/tts', method: 'GET',
        verify: url => { assert.equal(url.searchParams.get('cha_name'), 'Nova'); assert.equal(url.searchParams.get('top_k'), '4'); assert.equal(url.searchParams.get('stream'), 'true'); } },
    { provider: 'SBVits2', entry: 'Speaker (Soft-tone)', controls: { assist_text: 'softly', assist_text_weight: 0.4 },
        discovery: { '/models/info': { 2: { spk2id: { Speaker: 3 }, style2id: { 'Soft-tone': 0 } } } }, path: '/voice',
        verify: url => { assert.equal(url.searchParams.get('model_id'), '2'); assert.equal(url.searchParams.get('speaker_id'), '3'); assert.equal(url.searchParams.get('style'), 'Soft-tone'); assert.equal(url.searchParams.get('assist_text_weight'), '0.4'); } },
    { provider: 'GPT-SoVITS-Adapter', entry: 'speaker', controls: { media_type: 'wav', text_lang: 'en' }, discovery: { '/speakers': [{ name: 'speaker', voice_id: 'selected' }] }, path: '/',
        body: { card_name: 'Nova', target_voice: 'selected', use_st_adapter: true, text_lang: 'en', media_type: 'wav', streaming_mode: 'true' } },
    { provider: 'GPT-SoVITS-V2 (Unofficial)', entry: 'speaker', controls: { text_lang: 'en', prompt_lang: 'en' }, discovery: { '/speakers': [{ name: 'speaker', voice_id: '[en]Reference' }] }, path: '/',
        body: { prompt_text: 'Reference', ref_audio_path: './参考音频/[en]Reference.wav', text_lang: 'en', prompt_lang: 'en', media_type: 'ogg', streaming_mode: 'true' } },
    { provider: 'CosyVoice (Unofficial)', entry: 'speaker', controls: { streaming: true }, discovery: { '/speakers': ['speaker'] }, path: '/', body: { speaker: 'speaker', streaming: 1 } },
    { provider: 'TTS WebUI', entry: 'voice', controls: { seed: 184, max_length: 300, cpu_offload: true, chunk_overlap_method: 'linear' }, discovery: { '/v1/audio/voices/chatterbox': { voices: [{ value: 'saved-file', label: 'voice' }] } }, path: '/v1/audio/speech',
        verify: (_url, init) => { const body = JSON.parse(init.body); assert.equal(body.voice, 'saved-file'); assert.equal(body.params.seed, 184); assert.equal(body.params.max_length, 300); assert.equal(body.params.cpu_offload, true); assert.equal(body.params.chunk_overlap_method, 'linear'); } },
    { provider: 'Chatterbox', entry: '[Clone] saved.wav', controls: { seed: 188, exaggeration: 0.7 }, discovery: { '/get_predefined_voices': [], '/get_reference_files': ['saved.wav'] }, path: '/tts',
        body: { voice_mode: 'clone', reference_audio_filename: 'saved.wav', seed: 188, exaggeration: 0.7, output_format: 'wav' } },
];

for (const example of providerCases) test(`saved ${example.provider} speech uses its selected voice and configured request`, async t => {
    const f = prepared(t, example);
    let paid = 0, settingsCalls = 0;
    const fetchImpl = async (address, init) => {
        const url = new URL(address);
        if (Object.hasOwn(example.discovery ?? {}, url.pathname)) {
            assert.equal(init.method, 'GET');
            return json(example.discovery[url.pathname]);
        }
        if (example.settingsPath === url.pathname) {
            settingsCalls++;
            assert.deepEqual(JSON.parse(init.body), example.settingsBody);
            return json({ ok: true });
        }
        paid++;
        assert.equal(url.pathname, example.path);
        assert.equal(init.method, example.method ?? 'POST');
        assert.equal(init.redirect, 'error');
        if (example.header) assert.equal(init.headers[example.header[0]], example.header[1]);
        if (example.body) {
            const body = JSON.parse(init.body);
            for (const [key, value] of Object.entries(example.body)) assert.deepEqual(body[key], value);
        }
        example.verify?.(url, init);
        return example.response ? example.response() : audio();
    };
    const result = await runSpeechJob(f.context(), { fetchImpl });
    assert.equal(paid, 1);
    assert.equal(settingsCalls, example.settingsPath ? 1 : 0);
    assert.equal(result.result.files.length, 1);
    assert.equal(result.result.narration.status, 'ready');
    const artifactDir = path.join(f.directories.root, 'jobs', 'artifacts', jobKey(f.admission.jobId));
    for (const filename of fs.readdirSync(artifactDir).filter(file => file.endsWith('.json'))) {
        assert.equal(fs.readFileSync(path.join(artifactDir, filename), 'utf8').includes('private-'), false);
    }
    assert.deepEqual(await runSpeechJob(f.context(), { fetchImpl: () => assert.fail('completed speech contacted its provider again') }), result);
});

test('a truncated speech stream remains unknown rather than producing a playable success', async t => {
    const f = prepared(t, { provider: 'Volcengine', entry: 'zh_female_xiaohe_uranus_bigtts', controls: { resource_id: 'resource' } });
    updateJob(f.directories, f.admission.jobId, { state: 'running' });
    await assert.rejects(runSpeechJob(f.context(), { fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: WAVE.toString('base64') })) }), { code: 'TTS_PROVIDER' });
    recoverJobs(f.directories);
    await assert.rejects(runSpeechJob(f.context(), { fetchImpl: () => assert.fail('incomplete stream repeated') }), { code: 'TTS_RESULT_RECOVERY' });
    assert.equal(readArtifact(f.directories, f.admission.jobId, 'result'), undefined);
});
