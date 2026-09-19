import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const { generateQuickImageGenImage, saveQuickImageToUserImages, testExports } = await import('../src/generation/quick-image-gen.js');
const { buildConversationImagePrompt, conversationReplyWantsImage, lastUserMessageText, testExports: imageTestExports } = await import('../src/generation/conversation-images.js');

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

const createdRoots = [];
after(() => { for (const root of createdRoots) fs.rmSync(root, { recursive: true, force: true }); });

function tempRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-qig-'));
    createdRoots.push(root);
    const directories = { root, userImages: path.join(root, 'user', 'images') };
    fs.mkdirSync(directories.userImages, { recursive: true });
    return directories;
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

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
        generateQuickImageGenImage({ directories, prompt: 'x', fetch: async () => jsonResponse({}), settings: { provider: 'novelai', naiKey: 'k' } }),
        error => error.status === 409 && error.recoverable === true && /novelai/.test(error.message),
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
    const relative = await saveQuickImageToUserImages(directories, { base64: PNG_BASE64, format: 'png', chName: 'Nova' });
    assert.ok(fs.existsSync(path.join(directories.root, relative)), `expected ${relative} to exist`);
    assert.match(relative, /Nova/);
    assert.match(relative, /\.png$/);
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
