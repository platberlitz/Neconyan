import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { createImageReferenceHandler } = await import('../src/generation/image-reference-links.js');
const { generateQuickImageGenJobImage, quickImageGenSettingsFingerprint } = await import('../src/generation/quick-image-gen-job.js');
const { acceptJob, requestCancellation, updateJob, jobKey } = await import('../src/jobs/store.js');
const { roleplayStoreDirectory } = await import('../src/roleplay-store.js');
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

function prepared(t, mode = 'url_only', published = 'https://references.example') {
    const f = fixture(t);
    const directories = f.scope.directories;
    const old = process.env.SILLYTAVERN_MEDIA_REFERENCEBASEURL;
    process.env.SILLYTAVERN_MEDIA_REFERENCEBASEURL = published;
    t.after(() => { if (old === undefined) delete process.env.SILLYTAVERN_MEDIA_REFERENCEBASEURL; else process.env.SILLYTAVERN_MEDIA_REFERENCEBASEURL = old; });
    const source = 'https://source.example/reference.png?signed=original';
    const settings = { provider: 'proxy', proxyUrl: 'https://images.example/v1', proxyModel: 'test-image', proxyKey: 'private-provider-key',
        proxyRefImages: [source], proxyRefImageMode: mode, proxySeed: 37 };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({ extension_settings: { 'quick-image-gen': settings } }));
    const { job } = acceptJob(directories, { owner: f.scope.owner, type: 'media.images', submissionKey: 'reference-link-fixture', intent: { fixture: 'reference' } });
    const context = { directories, owner: f.scope.owner, job, signal: new AbortController().signal };
    return { ...f, directories, context, settings, source };
}

async function serve(t, f, userEnabled = async () => true) {
    const app = express();
    app.get('/api/media-reference/:store/:id/:token', createImageReferenceHandler({ dataRoot: () => path.dirname(f.directories.root),
        directoriesFor: owner => { assert.equal(owner, f.scope.owner); return f.directories; }, userEnabled }));
    app.use((_request, response) => response.sendStatus(401));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}`;
}

async function generate(f, onRequest) {
    return generateQuickImageGenJobImage(f.context, { effectId: 'reference', prompt: 'a clear view',
        settingsFingerprint: quickImageGenSettingsFingerprint(f.settings), fetch: async (url, init) => {
            if (url === f.source) return new Response(png, { headers: { 'Content-Type': 'image/png' } });
            onRequest(JSON.parse(init.body), init);
            return json({ data: [{ b64_json: png.toString('base64') }] });
        } });
}

test('URL-only image requests use an immutable single-image link across a real HTTP restart', async t => {
    const f = prepared(t);
    let link;
    await generate(f, (body, init) => { link = body.image_urls[0]; assert.equal(init.headers.Authorization, 'Bearer private-provider-key'); });
    assert.ok(link.startsWith('https://references.example/api/media-reference/'));
    assert.equal(link.includes('private-provider-key'), false);
    assert.equal(link.includes('signed=original'), false);
    const route = new URL(link).pathname;
    const base = await serve(t, f);
    let response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(base + '/api/jobs')).status, 401);
    assert.equal((await fetch(base + route.slice(0, -1) + (route.endsWith('a') ? 'b' : 'a'))).status, 404);
    const restarted = await serve(t, f);
    response = await fetch(restarted + route);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png, 'no in-memory link registry is needed after restart');
    await generateQuickImageGenJobImage(f.context, { effectId: 'reference', prompt: 'a clear view',
        settingsFingerprint: quickImageGenSettingsFingerprint(f.settings), fetch: () => assert.fail('saved image generation repeated') });
});

test('reference links refuse disabled owners, cancelled or pruned jobs, changed bytes and a lost signing key', async t => {
    const f = prepared(t);
    let link;
    await generate(f, body => { link = body.image_urls[0]; });
    const route = new URL(link).pathname;
    let enabled = true;
    const base = await serve(t, f, async () => enabled);
    enabled = false;
    assert.equal((await fetch(base + route)).status, 404);
    enabled = true;
    updateJob(f.directories, f.context.job.id, { state: 'running' });
    requestCancellation(f.directories, f.context.job.id);
    assert.equal((await fetch(base + route)).status, 404);
    updateJob(f.directories, f.context.job.id, { cancellation: null });
    const binary = path.join(f.directories.root, 'jobs/artifacts', jobKey(f.context.job.id), `${jobKey('input:quick-image:reference:proxy:reference:0')}.bin`);
    fs.writeFileSync(binary, Buffer.from('changed bytes'));
    assert.equal((await fetch(base + route)).status, 404);
    fs.writeFileSync(binary, png);
    const key = path.join(roleplayStoreDirectory(f.scope), 'references/link-key');
    fs.rmSync(key);
    assert.equal((await fetch(base + route)).status, 404);
    fs.rmSync(path.join(f.directories.root, 'jobs/index.json'));
    assert.equal((await fetch(base + route)).status, 404);
});

test('automatic proxy references use saved inline bytes and URL-only mode refuses missing publication config before network', async t => {
    const f = prepared(t, 'auto');
    await generate(f, body => assert.equal(body.image_urls[0], `data:image/png;base64,${png.toString('base64')}`));
    const missing = prepared(t, 'url_only', '');
    await assert.rejects(generateQuickImageGenJobImage(missing.context, { effectId: 'reference', prompt: 'scene',
        settingsFingerprint: quickImageGenSettingsFingerprint(missing.settings), fetch: () => assert.fail('URL-only work needs its saved public reference address first') }),
    { code: 'QIG_REFERENCE_LINK_INVALID' });
});
