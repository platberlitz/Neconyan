import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { generatedImageReceipts, prepareGeneratedImageHistory, MAX_GENERATED_HISTORY_BYTES } = await import('../src/scratchpad/image-history.js');
const { imageChangeHash } = await import('../src/scratchpad/image-state.js');
const { encodeServerImage } = await import('../src/media-codecs.js');
const { buildScratchpadMessages } = await import('../src/scratchpad/prompt.js');
const material = { source: 'openai', profile: { model: 'gpt-4o' }, active: { media_inlining: true } };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function setup(t, bytes = png) {
    const { scope } = fixture(t);
    const url = '/user/images/Scratchpad/scratchpad-result.png';
    const filename = path.join(scope.directories.root, url.slice(1));
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
    const change = { type: 'image', action: 'generate', target: 'image', prompt: 'An observatory.', negative: '', reason: '' };
    const message = { role: 'assistant', state: 'done', assistant: 'taro', assistantName: 'Taro', text: '```scratchpad-change\n' + JSON.stringify(change) + '\n```',
        images: { 0: { state: 'done', target: 'image', changeHash: imageChangeHash(change), imageHash: hash(bytes), url } } };
    const history = [{ role: 'user', text: 'Draw an observatory.' }, { ...message, generatedImages: generatedImageReceipts(message) }];
    return { context: scope, filename, history, message, material };
}

const images = history => history.flatMap(message => message.generatedImageContent ?? []).filter(part => part.type === 'image_url');

test('generated images follow the selected model, saved preset and media setting', async t => {
    const input = setup(t);
    assert.equal(images(await prepareGeneratedImageHistory(input)).length, 1);
    for (const selected of [
        { ...material, profile: { model: 'gpt-3.5-turbo' } },
        { ...material, backend: 'text' },
        { ...material, active: { media_inlining: false } },
        { ...material, preset: { media_inlining: false } },
    ]) assert.equal(images(await prepareGeneratedImageHistory({ ...input, material: selected })).length, 0);
    assert.equal(images(await prepareGeneratedImageHistory({ ...input, material: { ...material, active: { media_inlining: false }, preset: { media_inlining: true } } })).length, 1);
    assert.equal(input.history.some(message => message.generatedImageContent), false);
});

test('catalogue vision uses this speaker connection and unavailable catalogues preserve a text reply', async t => {
    const input = setup(t);
    const selected = { source: 'openrouter', profile: { model: 'provider/vision', 'secret-id': 'selected-key' }, active: { media_inlining: true, openrouter_model: 'other' } };
    let calls = 0;
    const fetchModels = async request => {
        assert.equal(request.material, selected);
        assert.equal(request.context, input.context);
        calls++;
        return [{ id: 'provider/vision', architecture: { input_modalities: ['text', 'image'] } }];
    };
    assert.equal(images(await prepareGeneratedImageHistory({ ...input, material: selected, fetchModels })).length, 1);
    assert.equal(calls, 1);
    assert.equal(images(await prepareGeneratedImageHistory({ ...input, material: selected, fetchModels: async () => [] })).length, 0);
    assert.equal(images(await prepareGeneratedImageHistory({ ...input, material: selected, fetchModels: async () => { throw new Error('Offline'); } })).length, 0);
});

test('only matching completed receipts supply pixels; unavailable files keep the feedback usable', async t => {
    const input = setup(t);
    for (const patch of [{ state: 'pending' }, { state: 'failed' }, { imageHash: '' }, { changeHash: '0'.repeat(64) }, { url: '/user/images/Scratchpad/../../settings.json' }, { url: 'https://example.com/image.png' }]) {
        const message = structuredClone(input.message);
        Object.assign(message.images[0], patch);
        assert.deepEqual(generatedImageReceipts(message), []);
    }
    fs.writeFileSync(input.filename, Buffer.from('changed'));
    const changed = await prepareGeneratedImageHistory(input);
    assert.equal(images(changed).length, 0);
    assert.match(changed[1].generatedImageContent[0].text, /not attached/);
    fs.unlinkSync(input.filename);
    assert.equal(images(await prepareGeneratedImageHistory(input)).length, 0);
    const outside = path.join(input.context.directories.root, 'outside.png');
    fs.writeFileSync(outside, png);
    fs.symlinkSync(outside, input.filename);
    assert.equal(images(await prepareGeneratedImageHistory(input)).length, 0);
});

test('recent generated pictures are bounded and peers retain their image attribution', async t => {
    const input = setup(t);
    input.history = [input.history[0], ...Array.from({ length: 7 }, (_, index) => ({ ...input.history[1], assistantName: `Speaker ${index}` }))];
    const result = await prepareGeneratedImageHistory(input);
    assert.equal(images(result).length, 4);
    assert.equal(images(result.slice(0, 4)).length, 0);
    assert.equal(images(result.slice(-4)).length, 4);
    assert.ok(Buffer.byteLength(JSON.stringify(result.map(message => message.generatedImageContent))) < MAX_GENERATED_HISTORY_BYTES);
    assert.equal(images(await prepareGeneratedImageHistory({ ...input, maxBytes: 128 })).length, 0);
    const messages = buildScratchpadMessages({ system: '', history: result, text: 'Make it blue.', assistant: 'miso' });
    const imageMessage = messages.findLast(message => Array.isArray(message.content));
    assert.equal(imageMessage.role, 'user');
    assert.match(imageMessage.content[0].text, /Speaker 6, proposal 1/);
    assert.equal(messages.at(-1).content, 'Make it blue.');
});

test('large generated PNGs become bounded vision previews without changing the saved original', async t => {
    const width = 1024;
    const data = randomBytes(width * width * 4);
    for (let index = 3; index < data.length; index += 4) data[index] = 255;
    const bytes = await encodeServerImage({ width, height: width, data });
    const input = setup(t, bytes);
    const result = await prepareGeneratedImageHistory(input);
    assert.equal(images(result).length, 1);
    assert.match(images(result)[0].image_url.url, /^data:image\/jpeg;base64,/);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < MAX_GENERATED_HISTORY_BYTES);
    assert.equal(hash(fs.readFileSync(input.filename)), hash(bytes));
});
