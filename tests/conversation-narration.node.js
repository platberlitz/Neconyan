import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const { createConversationNarrator } = await import('../src/generation/conversation-narration.js');
const { readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');
const { acceptJob, getJob, updateJob, recoverJobs } = await import('../src/jobs/store.js');
const { writeSecret, SECRET_KEYS } = await import('../src/endpoints/secrets.js');

const roots = [];
const speaker = { name: 'Nova' };
let submission = 0;

function makeContext(settings) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-narration-'));
    roots.push(root);
    if (settings !== undefined) {
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(settings));
    }
    const directories = { root };
    const { job } = acceptJob(directories, {
        owner: 'alice',
        type: 'conversation.reply',
        submissionKey: `narration-probe-${submission++}`,
        intent: {},
    });
    return { directories, job, signal: new AbortController().signal, owner: 'alice' };
}

function ttsSettings(overrides = {}) {
    return {
        extension_settings: {
            tts: {
                enabled: true,
                auto_generation: true,
                currentProvider: 'OpenAI Compatible',
                'OpenAI Compatible': {
                    provider_endpoint: 'https://tts.example/v1/audio/speech',
                    voiceMap: { Nova: 'nova' },
                    model: 'tts-1',
                    response_format: 'mp3',
                },
                ...overrides,
            },
        },
    };
}

function audioFetch(bytes = 'AUDIO', contentType = 'audio/mpeg') {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        return {
            ok: true,
            status: 200,
            headers: { get: () => contentType },
            arrayBuffer: async () => Buffer.from(bytes),
        };
    };
    return { fetchImpl, calls };
}

process.on('exit', () => {
    for (const root of roots) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('narration is skipped when automatic narration is off', async () => {
    const narrator = createConversationNarrator();
    assert.equal(await narrator(makeContext(undefined), {}, 'Hello.', speaker, {}), null);
    assert.equal(await narrator(makeContext(ttsSettings({ enabled: false })), {}, 'Hello.', speaker, {}), null);
    assert.equal(await narrator(makeContext(ttsSettings({ auto_generation: false })), {}, 'Hello.', speaker, {}), null);
});

test('Kokoro narrates in the page and never contacts a provider', async () => {
    const { fetchImpl, calls } = audioFetch();
    const narrator = createConversationNarrator({ fetchImpl });
    const record = await narrator(makeContext(ttsSettings({ currentProvider: 'Kokoro' })), {}, 'Hello there.', speaker, {});
    assert.deepEqual(record, { status: 'browser', provider: 'Kokoro' });
    assert.equal(calls.length, 0);
});

test('providers the server cannot reach are refused by name', async () => {
    const { fetchImpl, calls } = audioFetch();
    const narrator = createConversationNarrator({ fetchImpl });
    assert.deepEqual(await narrator(makeContext(ttsSettings({ currentProvider: 'System' })), {}, 'Hi.', speaker, {}), {
        status: 'refused', code: 'TTS_BROWSER_ONLY', provider: 'System',
    });
    assert.deepEqual(await narrator(makeContext(ttsSettings({ currentProvider: 'XTTSv2' })), {}, 'Hi.', speaker, {}), {
        status: 'refused', code: 'TTS_PROVIDER_UNSUPPORTED', provider: 'XTTSv2',
    });
    assert.deepEqual(await narrator(makeContext(ttsSettings({ multi_voice_enabled: true })), {}, 'Hi.', speaker, {}), {
        status: 'refused', code: 'TTS_MULTI_VOICE_UNSUPPORTED', provider: 'OpenAI Compatible',
    });
    assert.equal(calls.length, 0);
});

test('a prepared narration is written once and reused from its artifact', async () => {
    const { fetchImpl, calls } = audioFetch('RIFF-data', 'audio/mpeg');
    const narrator = createConversationNarrator({ fetchImpl });
    const context = makeContext(ttsSettings());
    const record = await narrator(context, {}, '"Say this."', speaker, { effectId: 'bubble:reply:0' });
    assert.equal(record.status, 'ready');
    assert.equal(record.job, context.job.id);
    assert.equal(record.artifact, 'provider:narration:bubble:reply:0');
    assert.equal(record.mimeType, 'audio/mpeg');
    const saved = readArtifact(context.directories, context.job.id, record.artifact);
    assert.equal(saved.mimeType, 'audio/mpeg');
    assert.equal(Buffer.from(saved.base64, 'base64').toString(), 'RIFF-data');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://tts.example/v1/audio/speech');
    const again = await narrator(context, {}, '"Say this."', speaker, { effectId: 'bubble:reply:0' });
    assert.equal(again.status, 'ready');
    assert.equal(calls.length, 1);
});

test('a missing key and a provider failure are reported without throwing', async () => {
    const { fetchImpl, calls } = audioFetch();
    const narrator = createConversationNarrator({ fetchImpl });
    const missingKey = ttsSettings({ currentProvider: 'OpenAI', OpenAI: { voiceMap: { Nova: 'NOVA' } } });
    const keyless = await narrator(makeContext(missingKey), {}, 'Hello.', speaker, { effectId: 'bubble:reply:0' });
    assert.equal(keyless.status, 'failed');
    assert.match(keyless.error, /key/i);
    assert.equal(calls.length, 0);

    const failing = createConversationNarrator({
        fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }),
    });
    const failed = await failing(makeContext(ttsSettings()), {}, 'Hello.', speaker, { effectId: 'bubble:reply:1' });
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /500/);
});

test('an unmapped or disabled voice is not narrated', async () => {
    const { fetchImpl, calls } = audioFetch();
    const narrator = createConversationNarrator({ fetchImpl });
    const unmapped = ttsSettings();
    unmapped.extension_settings.tts['OpenAI Compatible'].voiceMap = {};
    const unmappedRecord = await narrator(makeContext(unmapped), {}, 'Hello.', speaker, {});
    assert.equal(unmappedRecord.status, 'failed');
    assert.match(unmappedRecord.error, /voice/i);

    const disabled = ttsSettings();
    disabled.extension_settings.tts['OpenAI Compatible'].voiceMap = { Nova: 'disabled' };
    assert.equal(await narrator(makeContext(disabled), {}, 'Hello.', speaker, {}), null);

    assert.equal(await narrator(makeContext(ttsSettings()), {}, '', speaker, {}), null);
    assert.equal(calls.length, 0);
});

test('a disabled TTS extension is not narrated even when its saved settings stay enabled', async () => {
    const { fetchImpl, calls } = audioFetch();
    const narrator = createConversationNarrator({ fetchImpl });
    const settings = ttsSettings();
    settings.extension_settings.disabledExtensions = ['tts'];
    assert.equal(await narrator(makeContext(settings), {}, 'Hello.', speaker, {}), null);
    assert.equal(calls.length, 0);
});

test('provider settings and the provider deadline are passed to speech requests', async () => {
    const { fetchImpl, calls } = audioFetch('RIFF', 'audio/wav');
    const narrator = createConversationNarrator({ fetchImpl });
    const settings = ttsSettings();
    settings.extension_settings.tts['OpenAI Compatible'].speed = 1.5;
    const record = await narrator(makeContext(settings), {}, 'Read me.', speaker, { effectId: 'bubble:reply:3' });
    assert.equal(record.status, 'ready');
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.model, 'tts-1');
    assert.equal(body.response_format, 'mp3');
    assert.equal(body.speed, 1.5);
    assert.equal(body.input, 'Read me.');
    assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('a legacy string voice map is understood', async () => {
    const { fetchImpl, calls } = audioFetch('RIFF', 'audio/wav');
    const narrator = createConversationNarrator({ fetchImpl });
    const settings = ttsSettings();
    settings.extension_settings.tts['OpenAI Compatible'].voiceMap = 'Nova:nova';
    const record = await narrator(makeContext(settings), {}, 'Hello again.', speaker, { effectId: 'bubble:reply:4' });
    assert.equal(record.status, 'ready');
    assert.equal(JSON.parse(calls[0].options.body).voice, 'nova');
});

test('a character absent from the voice map inherits the configured default voice', async () => {
    const { fetchImpl, calls } = audioFetch('RIFF', 'audio/wav');
    const narrator = createConversationNarrator({ fetchImpl });
    const settings = ttsSettings();
    settings.extension_settings.tts['OpenAI Compatible'].voiceMap = { '[Default Voice]': 'nova' };
    const record = await narrator(makeContext(settings), {}, 'Hello default.', speaker, { effectId: 'bubble:reply:5' });
    assert.equal(record.status, 'ready');
    assert.equal(JSON.parse(calls[0].options.body).voice, 'nova');
});

test('recovery interrupts an accepted speech request with no saved result', async () => {
    const context = makeContext(ttsSettings());
    updateJob(context.directories, context.job.id, { state: 'running' });
    const controller = new AbortController();
    context.signal = controller.signal;
    let release;
    let calls = 0;
    const narrator = createConversationNarrator({ fetchImpl: async () => {
        calls++;
        return new Promise((resolve, reject) => { release = reject; });
    } });
    const pending = narrator(context, {}, 'Hello.', speaker, { effectId: 'bubble:reply:0' });
    assert.equal(calls, 1);
    assert.equal(getJob(context.directories, context.job.id).recoverability, 'unknown-outcome');
    recoverJobs(context.directories);
    assert.equal(getJob(context.directories, context.job.id).state, 'interrupted');
    assert.equal(calls, 1);
    controller.abort();
    release(controller.signal.reason);
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(readArtifact(context.directories, context.job.id, 'provider:narration:bubble:reply:0'), undefined);
});

test('failed speech is saved once, while damaged saved speech is refused without another request', async () => {
    const context = makeContext(ttsSettings());
    let calls = 0;
    const narrator = createConversationNarrator({ fetchImpl: async () => {
        calls++;
        return { ok: false, status: 500, text: async () => 'offline' };
    } });
    const delivery = { effectId: 'bubble:reply:0' };
    assert.equal((await narrator(context, {}, 'Hello.', speaker, delivery)).status, 'failed');
    assert.equal((await narrator(context, {}, 'Hello.', speaker, delivery)).status, 'failed');
    assert.equal(calls, 1);
    writeArtifact(context.directories, context.job.id, 'provider:narration:bubble:reply:0', { corrupt: true });
    await assert.rejects(() => narrator(context, {}, 'Hello.', speaker, delivery), { status: 409 });
    assert.equal(calls, 1);
});

test('provider HTML cannot become a ready audio artifact', async () => {
    const { fetchImpl } = audioFetch('<script>bad</script>', 'text/html');
    const narrator = createConversationNarrator({ fetchImpl });
    const record = await narrator(makeContext(ttsSettings()), {}, 'Hi.', speaker, { effectId: 'bubble:reply:0' });
    assert.equal(record.status, 'failed');
    assert.match(record.error, /text\/html/);
});

test('OpenAI character instructions expand the saved macro context', async () => {
    const { fetchImpl, calls } = audioFetch();
    const settings = ttsSettings({ currentProvider: 'OpenAI', OpenAI: {
        voiceMap: { Nova: 'nova' }, characterInstructions: { Nova: 'Speak as {{char}} to {{user}}.' },
    } });
    const context = makeContext(settings);
    writeSecret(context.directories, SECRET_KEYS.OPENAI, 'fake-test-key');
    const result = await createConversationNarrator({ fetchImpl })(context, { macros: { names: { char: 'Nova', user: 'Alex' } } }, 'Hi.', speaker, { effectId: 'bubble:reply:0' });
    assert.equal(result.status, 'ready');
    assert.equal(JSON.parse(calls[0].options.body).instructions, 'Speak as Nova to Alex.');
});

test('ElevenLabs reuses matching history across separate jobs and preserves MPEG', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(url);
        if (url.endsWith('/voices')) return { ok: true, json: async () => ({ voices: [{ voice_id: 'voice-1', name: 'Nova' }] }) };
        if (url.endsWith('/history')) return { ok: true, json: async () => ({ history: [{ text: 'Hi.', voice_id: 'voice-1', history_item_id: 'saved-1' }] }) };
        return { ok: true, headers: { get: () => 'audio/wav' }, arrayBuffer: async () => Buffer.from('saved speech') };
    };
    for (let i = 0; i < 2; i++) {
        const context = makeContext(ttsSettings({ currentProvider: 'ElevenLabs', ElevenLabs: { voiceMap: { Nova: 'Nova' } } }));
        writeSecret(context.directories, SECRET_KEYS.ELEVENLABS, 'fake-test-key');
        const result = await createConversationNarrator({ fetchImpl })(context, {}, 'Hi.', speaker, { effectId: 'bubble:reply:0' });
        assert.equal(result.status, 'ready');
        assert.equal(result.mimeType, 'audio/mpeg');
    }
    assert.equal(calls.filter(url => url.endsWith('/history/saved-1/audio')).length, 2);
    assert.equal(calls.some(url => url.includes('/text-to-speech/')), false);
});
