import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { captureSpriteRequest, admitSpriteJob, runSpriteJob } = await import('../src/generation/sprite-jobs.js');
const { withNativeMediaReceipt } = await import('../src/generation/media-jobs.js');
const { roleplayHash, roleplayStoreDirectory } = await import('../src/roleplay-store.js');
const { getJob, releaseJob, recoverJobs, updateJob } = await import('../src/jobs/store.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');
const { decodeServerImage, encodeServerImage } = await import('../src/media-codecs.js');
const { cleanSpriteBitmap, splitSpriteBitmap } = await import('../public/scripts/extensions/expressions/sprite-pixels.js');
const { write: writeCard } = await import('../src/character-card-parser.js');

function bitmap(width = 16, height = 16, colour = [255, 20, 30, 255]) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set(colour, i);
    return { width, height, data };
}

async function prepared(t, { mode = 'individual', labels = ['joy'], replacements, sprites = {}, settings: overrides = {}, sheetImage, folderName = 'Nova' } = {}) {
    const f = fixture(t);
    const directories = f.scope.directories;
    directories.userImages = path.join(directories.root, 'user', 'images');
    fs.mkdirSync(directories.userImages, { recursive: true });
    const folder = path.join(directories.characters, folderName);
    if (Object.keys(sprites).length) fs.mkdirSync(folder, { recursive: true });
    for (const [name, bytes] of Object.entries(sprites)) fs.writeFileSync(path.join(folder, name), bytes);
    if (sheetImage) fs.writeFileSync(path.join(directories.userImages, 'sheet.png'), sheetImage);
    const settings = { extension_settings: { expressions: { agentSpriteRemoveBackground: false, ...overrides },
        'quick-image-gen': { provider: 'together', togetherKey: 'sprite-secret', togetherModel: 'fixture-image', seed: -1 } } };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify(settings));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = f.source();
    const request = captureSpriteRequest(f.scope, account, source, { avatar: 'Nova.png', labels, mode, replacements, folder: folderName,
        ...(sheetImage ? { sheetImage: '/user/images/sheet.png' } : {}) });
    const admission = admitSpriteJob(f.scope, account, { operationKey: 'sprite-fixture', source, request });
    releaseJob(directories, admission.jobId);
    const context = () => ({ directories, owner: f.scope.owner, job: getJob(directories, admission.jobId), signal: new AbortController().signal });
    return { ...f, directories, folder, account, source, request, admission, settings, context };
}

function imageResponse(bytes) { return new Response(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }), { headers: { 'Content-Type': 'application/json' } }); }

test('native sprites freeze the card prompt, publish once and retain ownership after job pruning', async t => {
    const f = await prepared(t);
    const bytes = await encodeServerImage(bitmap());
    let calls = 0;
    const beforeChat = fs.readFileSync(f.filename);
    const result = await runSpriteJob(f.context(), { fetchImpl: async (_url, init) => {
        calls++;
        const body = JSON.parse(init.body);
        assert.match(body.prompt, /Original/);
        assert.match(body.prompt, /Expression to show: joy/);
        assert.ok(Number.isSafeInteger(body.seed));
        return imageResponse(bytes);
    } });
    assert.equal(calls, 1);
    assert.equal(result.result.outputs[0].url, '/characters/Nova/joy.png');
    assert.equal((await decodeServerImage(fs.readFileSync(path.join(f.folder, 'joy.png')))).width, 16);
    assert.deepEqual(fs.readFileSync(f.filename), beforeChat);
    assert.equal(JSON.stringify(f.request).includes('sprite-secret'), false);
    const receipts = path.join(roleplayStoreDirectory(f.scope), 'media');
    assert.equal(fs.readdirSync(receipts).length, 1);
    assert.equal(fs.readFileSync(path.join(receipts, fs.readdirSync(receipts)[0]), 'utf8').includes('sprite-secret'), false);
    assert.deepEqual(await runSpriteJob(f.context(), { fetchImpl: () => assert.fail('a completed sprite cannot pay again') }), result);
    fs.rmSync(path.join(f.directories.root, 'jobs', 'index.json'), { force: true });
    fs.rmSync(path.join(f.directories.root, 'jobs', 'artifacts'), { recursive: true, force: true });
    const replay = admitSpriteJob(f.scope, f.account, { operationKey: 'sprite-fixture', source: f.source, request: f.request });
    assert.equal(replay.created, false);
    assert.equal(replay.jobId, f.admission.jobId);
    assert.deepEqual(replay.result, result.result);
});

test('a native sprite target cannot absorb another intent while its accepted work is unfinished', async t => {
    const f = await prepared(t);
    const changed = { ...f.request, negative: 'another intention' };
    assert.throws(() => admitSpriteJob(f.scope, f.account, { operationKey: 'sprite-fixture', source: f.source, request: changed }), { code: 'MEDIA_INTENT_CONFLICT' });
    assert.throws(() => admitSpriteJob(f.scope, f.account, { operationKey: 'another-key', source: f.source, request: changed }), { code: 'MEDIA_TARGET_BUSY' });
});

test('shared-card jobs capture the selected member, custom label and independent folder', async t => {
    const f = fixture(t);
    const directories = f.scope.directories;
    const members = [
        { id: 'mira', name: 'Mira', folder: 'cast/mira', description: 'Silver hair.' },
        { id: 'sol', name: 'Sol', folder: 'cast/sol', description: 'Red hair.' },
    ];
    fs.writeFileSync(path.join(directories.characters, 'Nova.png'), writeCard(png, JSON.stringify({ data: { name: 'Mira and Sol',
        description: 'Two companions.', extensions: { expression_sets: { members, active: 'mira' } } } })));
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({ extension_settings: {
        expressions: { custom: ['joy-soft'] }, 'quick-image-gen': { provider: 'together', togetherKey: 'fixture-key' },
    } }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch }, source = f.source();
    const capture = options => captureSpriteRequest(f.scope, account, source, { avatar: 'Nova.png', labels: ['joy-soft'], ...options });
    const mira = capture({});
    const sol = capture({ memberId: 'sol' });
    assert.equal(mira.folder, 'cast/mira');
    assert.equal(sol.folder, 'cast/sol');
    assert.match(mira.prompts[0], /Draw only Mira/);
    assert.match(sol.prompts[0], /Appearance of Sol: Red hair/);
    assert.equal(sol.targets[0].name, 'joy-soft');
    assert.throws(() => capture({ memberId: 'missing' }), /unavailable/);
    assert.throws(() => capture({ memberId: 'sol', folder: 'cast/mira' }), /does not belong/);
});

test('sprite sheets generate once and split exact row-major cells without adjacent content', async t => {
    const f = await prepared(t, { mode: 'sheet', labels: ['joy', 'anger'] });
    const pixels = bitmap(42, 20);
    for (let y = 0; y < 20; y++) for (let x = 21; x < 42; x++) pixels.data.set([20, 30, 255, 255], (y * 42 + x) * 4);
    const bytes = await encodeServerImage(pixels);
    let calls = 0;
    const result = await runSpriteJob(f.context(), { fetchImpl: async (_url, init) => {
        calls++;
        assert.match(JSON.parse(init.body).prompt, /2 columns by 1 rows/);
        return imageResponse(bytes);
    } });
    assert.equal(calls, 1);
    assert.equal(result.result.outputs.length, 2);
    const joy = await decodeServerImage(fs.readFileSync(path.join(f.folder, 'joy.png')));
    const anger = await decodeServerImage(fs.readFileSync(path.join(f.folder, 'anger.png')));
    assert.equal(joy.width, 21);
    assert.deepEqual([...joy.data.slice(0, 4)], [255, 20, 30, 255]);
    assert.deepEqual([...anger.data.slice(0, 4)], [20, 30, 255, 255]);
});

test('a saved imported sheet is split without any model request', async t => {
    const pixels = bitmap(32, 16);
    const f = await prepared(t, { mode: 'split', labels: ['joy', 'anger'], sheetImage: await encodeServerImage(pixels) });
    const result = await runSpriteJob(f.context(), { fetchImpl: () => assert.fail('splitting a saved sheet is local work') });
    assert.equal(result.result.outputs.length, 2);
});

test('sprite cleanup removes edge background and centres retained content without removing enclosed white detail', () => {
    const pixels = bitmap(16, 16, [255, 255, 255, 255]);
    for (let y = 1; y <= 6; y++) for (let x = 1; x <= 6; x++) pixels.data.set([200, 15, 20, 255], (y * 16 + x) * 4);
    pixels.data.set([255, 255, 255, 255], (3 * 16 + 3) * 4);
    cleanSpriteBitmap(pixels, { removeBackground: true });
    assert.equal(pixels.data[3], 0);
    assert.deepEqual([...pixels.data.slice((7 * 16 + 7) * 4, (7 * 16 + 7) * 4 + 4)], [255, 255, 255, 255]);
    assert.equal(pixels.data[(5 * 16 + 5) * 4 + 3], 255);
    assert.equal(pixels.data[(11 * 16 + 11) * 4 + 3], 0);
    assert.throws(() => splitSpriteBitmap(bitmap(1, 1), { columns: 2, rows: 1 }, 2), /grid/);
});

test('transparent sprite corners are not evidence for removing opaque white details', () => {
    const pixels = bitmap(16, 16, [255, 255, 255, 0]);
    for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) pixels.data.set([200, 15, 20, 255], (y * 16 + x) * 4);
    const white = (7 * 16 + 7) * 4;
    pixels.data.set([255, 255, 255, 255], white);
    cleanSpriteBitmap(pixels, { removeBackground: true });
    assert.deepEqual([...pixels.data.slice(white, white + 4)], [255, 255, 255, 255]);
    assert.equal(pixels.data[3], 0);
});

test('all 64 long-named sprite replacements fit their reserved permanent receipt', async t => {
    const labels = Array.from({ length: 64 }, (_, index) => `mood${String.fromCharCode(97 + Math.floor(index / 26), 97 + index % 26)}`);
    const bytes = await encodeServerImage(bitmap(8, 8), 'jpeg');
    const names = labels.map(label => `${label}-${'n'.repeat(165)}`);
    const f = await prepared(t, { mode: 'cleanup', labels, folderName: `${'f'.repeat(120)}/${'g'.repeat(100)}`,
        sprites: Object.fromEntries(names.map(name => [`${name}.jpg`, bytes])) });
    const result = await runSpriteJob(f.context(), { fetchImpl: () => assert.fail('saved sprite cleanup must not contact a provider') });
    assert.equal(result.result.outputs.length, 64);
    assert.ok(Buffer.byteLength(JSON.stringify(result.result)) > 32 * 1024, 'the accepted completion exceeds the former limit');
    const receipt = withNativeMediaReceipt(f.context(), ({ value }) => structuredClone(value));
    assert.ok(Buffer.byteLength(JSON.stringify(receipt)) > 64 * 1024, 'the complete receipt exceeds the former reserved size');
    assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 512 * 1024);
    assert.ok(names.every(name => fs.existsSync(path.join(f.folder, `${name}.png`)) && !fs.existsSync(path.join(f.folder, `${name}.jpg`))));
    fs.rmSync(path.join(f.directories.root, 'jobs', 'index.json'));
    fs.rmSync(path.join(f.directories.root, 'jobs', 'artifacts'), { recursive: true });
    assert.deepEqual(admitSpriteJob(f.scope, f.account, { operationKey: 'sprite-fixture', source: f.source, request: f.request }).result, result.result);
});

test('a sprite replacement retains the old format until the new file and receipt are durable', async t => {
    const old = await encodeServerImage(bitmap(8, 8), 'jpeg');
    const f = await prepared(t, { sprites: { 'joy.jpg': old }, replacements: { joy: 'joy' } });
    const bytes = await encodeServerImage(bitmap(12, 12, [40, 150, 20, 255]));
    let calls = 0;
    await assert.rejects(runSpriteJob(f.context(), { fetchImpl: async () => { calls++; return imageResponse(bytes); },
        afterPublication: () => { throw new Error('simulated interruption after publication'); } }), /simulated interruption/);
    assert.deepEqual(fs.readFileSync(path.join(f.folder, 'joy.jpg')), old);
    assert.equal(fs.existsSync(path.join(f.folder, 'joy.png')), true);
    const result = await runSpriteJob(f.context(), { fetchImpl: () => assert.fail('the paid image is already saved') });
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(path.join(f.folder, 'joy.jpg')), false);
    assert.equal(result.result.outputs.length, 1);
});

test('unknown sprite image outcomes remain interrupted and cannot repeat after recovery', async t => {
    const f = await prepared(t);
    updateJob(f.directories, f.admission.jobId, { state: 'running' });
    let calls = 0;
    await assert.rejects(runSpriteJob(f.context(), { fetchImpl: async () => { calls++; throw new Error('connection lost'); } }));
    recoverJobs(f.directories);
    assert.equal(getJob(f.directories, f.admission.jobId).state, 'interrupted');
    await assert.rejects(runSpriteJob(f.context(), { fetchImpl: () => assert.fail('unknown image work must not repeat') }));
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(path.join(f.folder, 'joy.png')), false);
});

test('sprite source replacement before dispatch refuses and saves no paid outcome', async t => {
    const bytes = await encodeServerImage(bitmap());
    const f = await prepared(t, { sprites: { 'joy.png': bytes }, replacements: { joy: 'joy' } });
    const filename = path.join(f.folder, 'joy.png');
    fs.renameSync(filename, `${filename}.old`);
    fs.writeFileSync(filename, bytes);
    await assert.rejects(runSpriteJob(f.context(), { fetchImpl: () => assert.fail('changed sprite must refuse') }), { code: 'SPRITE_SOURCE_CHANGED' });
    assert.equal(readArtifact(f.directories, f.admission.jobId, 'provider:quick-image:sprite:0'), undefined);
});

test('native media refuses symlink destinations and keeps original files on source changes', async t => {
    const f = await prepared(t);
    fs.symlinkSync(f.directories.userImages, f.folder);
    await assert.rejects(runSpriteJob(f.context(), { fetchImpl: () => assert.fail('a symlink must refuse') }), { code: 'MEDIA_SOURCE_CHANGED' });
    assert.deepEqual(fs.readdirSync(f.directories.userImages), []);
});

test('completed sprite files are tied to their saved physical identity during unfinished delivery', async t => {
    const f = await prepared(t);
    const bytes = await encodeServerImage(bitmap());
    await assert.rejects(runSpriteJob(f.context(), { fetchImpl: async () => imageResponse(bytes),
        afterPublication: () => { throw new Error('delivery interrupted'); } }), /delivery interrupted/);
    const receipt = withNativeMediaReceipt(f.context(), ({ value }) => structuredClone(value));
    assert.equal(receipt.effects[roleplayHash(['write', 'characters/Nova/joy.png'])].state, 'done');
    const filename = path.join(f.folder, 'joy.png');
    fs.renameSync(filename, `${filename}.old`);
    fs.writeFileSync(filename, bytes);
    await assert.rejects(runSpriteJob(f.context(), { fetchImpl: () => assert.fail('saved output must not regenerate') }), { code: 'SPRITE_SOURCE_CHANGED' });
});

test('interrupted binding of an existing sprite directory resumes only its exact accepted directory', async t => {
    const image = await encodeServerImage(bitmap());
    const f = await prepared(t, { sprites: { 'old.png': image } });
    withNativeMediaReceipt(f.context(), ({ value, save }) => {
        for (const parent of f.request.parents) value.effects[roleplayHash(['directory', parent.relative])] = { ...parent, state: 'creating' };
        save();
    });
    const result = await runSpriteJob(f.context(), { fetchImpl: async () => imageResponse(image) });
    assert.equal(result.result.outputs.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(f.folder, 'old.png')), image);
});
