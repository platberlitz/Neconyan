import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import {
    generateOpenAiCompatibleSpeech,
    generateOpenAiSpeech,
    getOpenAiTtsResponseFormat,
    generatePollinationsSpeech,
    listElevenLabsVoices,
    pollinationsModelVoices,
    synthesizeElevenLabs,
} from '../src/endpoints/speech-transports.js';

const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};
        if (parsed.model === 'fail') {
            response.writeHead(500);
            response.end('boom');
            return;
        }
        if (request.url === '/voices') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ voices: [{ name: 'Nova', voice_id: 'nova-id' }] }));
            return;
        }
        if (request.url.startsWith('/eleven/')) {
            response.writeHead(200, { 'content-type': 'audio/mpeg' });
            response.end('mp3bytes');
            return;
        }
        response.writeHead(200, { 'content-type': 'audio/wav' });
        response.end('wavbytes');
    });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const redirect = path => (url, options) => fetch(base + path, options);
test.after(() => new Promise(resolve => server.close(resolve)));

test('the response format defaults to wav and rejects unknown values', () => {
    assert.equal(getOpenAiTtsResponseFormat(undefined), 'wav');
    assert.equal(getOpenAiTtsResponseFormat('mp3'), 'mp3');
    assert.equal(getOpenAiTtsResponseFormat('exe'), 'wav');
});

test('rejecting provider HTML closes its body before returning', async () => {
    let destroyed = false;
    await assert.rejects(generateOpenAiCompatibleSpeech({ endpoint: `${base}/speech`, text: 'Hello' }, {
        fetchImpl: async () => ({ ok: true, headers: new Headers({ 'content-type': 'text/html' }),
            body: { destroy() { destroyed = true; } }, arrayBuffer: () => assert.fail('HTML must not be buffered') }),
    }), /non-audio content/);
    assert.equal(destroyed, true);
});

test('an OpenAI Compatible endpoint returns buffered audio with its content type', async () => {
    const result = await generateOpenAiCompatibleSpeech({ endpoint: `${base}/v1/audio/speech`, key: 'k', text: 'Hello', voice: 'nova' });
    assert.equal(result.mimeType, 'audio/wav');
    assert.equal(Buffer.from(result.base64, 'base64').toString(), 'wavbytes');
});

test('the native OpenAI transport reuses the injected fetch', async () => {
    const result = await generateOpenAiSpeech({ key: 'k', text: 'Hello', voice: 'alloy' }, { fetchImpl: redirect('/v1/audio/speech') });
    assert.equal(result.mimeType, 'audio/wav');
    assert.equal(Buffer.from(result.base64, 'base64').toString(), 'wavbytes');
});

test('ElevenLabs lists voices and buffers synthesized audio', async () => {
    const voices = await listElevenLabsVoices({ apiKey: 'k' }, { fetchImpl: redirect('/voices') });
    assert.deepEqual(voices, { voices: [{ name: 'Nova', voice_id: 'nova-id' }] });

    const result = await synthesizeElevenLabs({ apiKey: 'k', voiceId: 'nova-id', request: { text: 'Hello' } }, { fetchImpl: redirect('/eleven/nova-id') });
    assert.equal(result.mimeType, 'audio/mpeg');
    assert.equal(Buffer.from(result.base64, 'base64').toString(), 'mp3bytes');
});

test('a provider failure carries its status and body for the route to relay', async () => {
    await assert.rejects(
        generateOpenAiCompatibleSpeech({ endpoint: `${base}/v1/audio/speech`, text: 'Hello', model: 'fail' }),
        error => error.providerStatus === 500 && error.providerBody === 'boom',
    );
});

test('Pollinations default speech model reads voices from the free OpenAI audio model', async () => {
    const models = [
        { name: 'elevenlabs/eleven-v3', aliases: ['tts', 'tts-1'], voices: ['alloy', 'rachel'] },
        { name: 'openai/tts-1', aliases: [], voices: ['nova', 'echo'] },
        { name: 'hexgrad/kokoro-82m', aliases: ['kokoro'], voices: ['af_heart'] },
    ];
    assert.deepEqual(pollinationsModelVoices(models, 'openai-audio'), ['nova', 'echo']);
    assert.deepEqual(pollinationsModelVoices(models, undefined), ['nova', 'echo']);
    assert.deepEqual(pollinationsModelVoices(models, 'kokoro'), ['af_heart']);
    assert.equal(pollinationsModelVoices(models, 'missing'), null);
    assert.equal(pollinationsModelVoices({ error: 'down' }, 'openai-audio'), null);

    let sent;
    await generatePollinationsSpeech({ key: 'k', text: 'Hello', model: 'openai-audio', voice: 'nova' }, {
        fetchImpl: async (_url, options) => {
            sent = JSON.parse(options.body);
            return new Response(Buffer.from('mp3bytes'), { headers: { 'content-type': 'audio/mpeg' } });
        },
    });
    assert.equal(sent.model, 'openai/tts-1');
});
