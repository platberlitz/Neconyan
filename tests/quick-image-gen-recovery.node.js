import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { generateQuickImageGenJobImage, quickImageGenSettingsFingerprint } = await import('../src/generation/quick-image-gen-job.js');
const { writeImageArtifact } = await import('../src/jobs/image-artifacts.js');
const { readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');
const { acceptJob, getJob, jobKey, recoverJobs, updateJob } = await import('../src/jobs/store.js');
const { withRoleplayAccount } = await import('../src/roleplay-store.js');
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

function prepared(t, overrides = {}) {
    const f = fixture(t);
    const directories = f.scope.directories;
    const settings = { provider: 'together', togetherKey: 'review-private-key', togetherModel: 'fixture', seed: 37, ...overrides };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({ extension_settings: { 'quick-image-gen': settings } }));
    const { job } = acceptJob(directories, { owner: f.scope.owner, type: 'media.images', submissionKey: 'image-review', intent: {} });
    const context = { directories, owner: f.scope.owner, job, signal: new AbortController().signal };
    const run = options => generateQuickImageGenJobImage(context, { effectId: 'review', prompt: 'saved image',
        settingsFingerprint: quickImageGenSettingsFingerprint(settings), wait: async () => {}, ...options });
    return { ...f, directories, settings, job, context, run };
}

test('image evidence is immutable, physical and idempotent instead of repairing conflicting bytes', t => {
    const f = prepared(t);
    const image = { base64: png.toString('base64'), format: 'png' };
    const filename = path.join(f.directories.root, 'jobs/artifacts', jobKey(f.job.id), `${jobKey('reference')}.bin`);
    const write = value => withRoleplayAccount(f.scope, f.scope, () => writeImageArtifact(f.directories, f.job.id, 'reference', value));
    write(image);
    const before = fs.statSync(filename, { bigint: true });
    write(image);
    assert.equal(fs.statSync(filename, { bigint: true }).ino, before.ino);
    assert.throws(() => write({ ...image, base64: Buffer.concat([png, Buffer.from('different')]).toString('base64') }), { code: 'QIG_RESULT_RECOVERY' });
    fs.writeFileSync(filename, 'corrupt');
    assert.throws(() => write(image), { code: 'QIG_RESULT_RECOVERY' });
    assert.equal(fs.readFileSync(filename, 'utf8'), 'corrupt');
    fs.writeFileSync(filename, png);
    writeArtifact(f.directories, f.job.id, 'reference', { ...readArtifact(f.directories, f.job.id, 'reference'), digest: '0'.repeat(64) });
    assert.throws(() => write(image), { code: 'QIG_RESULT_RECOVERY' });
    fs.rmSync(path.join(f.directories.root, 'jobs/artifacts', jobKey(f.job.id), `${jobKey('reference')}.json`));
    fs.rmSync(filename);
    const outside = path.join(f.directories.root, 'outside.png');
    fs.writeFileSync(outside, png);
    fs.symlinkSync(outside, filename);
    assert.throws(() => write(image), { code: 'QIG_RESULT_RECOVERY' });
    assert.deepEqual(fs.readFileSync(outside), png);
});

const custom = { provider: 'custom', customApiMode: 'async', customApiUrl: 'https://custom.example/jobs',
    customApiAuthType: 'bearer', customApiKey: 'custom-private-key', customApiRequestTemplate: '{"prompt":"{{prompt}}","seed":"{{seed}}"}',
    customApiJobIdPath: '/id', customApiPollUrl: 'https://custom.example/jobs/{{jobId}}', customApiPollMethod: 'GET',
    customApiStatusPath: '/status', customApiSuccessValues: 'done', customApiFailureValues: 'failed', customApiResponsePath: '/image', customApiResponseType: 'base64' };

test('Custom API async IDs are saved before polling and resume without another submission', async t => {
    const f = prepared(t, custom);
    updateJob(f.directories, f.job.id, { state: 'running' });
    let submissions = 0, polls = 0;
    const fetch = async (url, init) => {
        if (url.startsWith('data:')) return new Response(png, { headers: { 'Content-Type': 'image/png' } });
        assert.equal(init.redirect, 'error');
        assert.equal(init.headers.Authorization, 'Bearer custom-private-key');
        if (init.method === 'POST') { submissions++; return json({ id: 'remote-42' }); }
        assert.equal(url, 'https://custom.example/jobs/remote-42');
        polls++;
        if (polls === 1) throw new Error('read-only poll lost');
        return json({ status: 'done', image: png.toString('base64') });
    };
    await assert.rejects(f.run({ fetch }), { code: 'QIG_CUSTOM_FAILED' });
    const receipt = readArtifact(f.directories, f.job.id, 'provider:quick-image:review:custom-submit');
    assert.equal(receipt.jobId, 'remote-42');
    assert.equal(JSON.stringify(receipt).includes('custom-private-key'), false);
    recoverJobs(f.directories);
    assert.equal(getJob(f.directories, f.job.id).state, 'queued');
    assert.equal((await f.run({ fetch })).base64, png.toString('base64'));
    assert.equal(submissions, 1);
    assert.equal(polls, 2);
    await f.run({ fetch: () => assert.fail('completed Custom API result repeated') });
});

test('Custom API unknown submission is interrupted, while an immediate saved image is reusable', async t => {
    const unknown = prepared(t, custom);
    updateJob(unknown.directories, unknown.job.id, { state: 'running' });
    let calls = 0;
    await assert.rejects(unknown.run({ fetch: async () => { calls++; throw new Error('unknown private result'); } }), { code: 'QIG_CUSTOM_FAILED' });
    recoverJobs(unknown.directories);
    assert.equal(getJob(unknown.directories, unknown.job.id).state, 'interrupted');
    await assert.rejects(unknown.run({ fetch: () => assert.fail('unknown Custom API submission repeated') }), { code: 'QIG_RESULT_RECOVERY' });
    assert.equal(calls, 1);
    const immediate = prepared(t, custom);
    await immediate.run({ fetch: async () => new Response(png, { headers: { 'Content-Type': 'image/png' } }) });
    assert.equal(readArtifact(immediate.directories, immediate.job.id, 'provider:quick-image:review:custom-submit').image, true);
    const name = 'provider:quick-image:review';
    fs.rmSync(path.join(immediate.directories.root, 'jobs/artifacts', jobKey(immediate.job.id), `${jobKey(name)}.json`));
    fs.rmSync(path.join(immediate.directories.root, 'jobs/artifacts', jobKey(immediate.job.id), `${jobKey(name)}.bin`));
    assert.equal((await immediate.run({ fetch: () => assert.fail('the immediate saved image repeated') })).base64, png.toString('base64'));
});

test('a provider redirect cannot silently resend a paid image POST', async t => {
    let first = 0, followed = 0;
    const server = http.createServer((request, response) => {
        request.resume();
        if (request.url === '/second') { followed++; response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); }
        else { first++; response.writeHead(307, { Location: '/second' }); response.end(); }
    }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const f = prepared(t, { provider: 'gptimage', gptImageKey: 'private-redirect-key', gptImageProxyUrl: `http://127.0.0.1:${server.address().port}/v1` });
    await assert.rejects(f.run({}), error => !error.message.includes('private-redirect-key'));
    assert.equal(first, 1);
    assert.equal(followed, 0);
});

test('provider errors and malformed caption JSON cannot expose credentials through image job errors', async t => {
    for (const settings of [{ ...custom, customApiMode: 'json' }, { provider: 'nanobanana', nanobananaKey: 'banana-private-key' }]) {
        const f = prepared(t, settings);
        const secret = settings.customApiKey || settings.nanobananaKey;
        await assert.rejects(f.run({ fetch: async () => new Response(`invalid JSON including ${secret}`, {
            status: settings.provider === 'custom' ? 502 : 200, headers: { 'Content-Type': 'application/json' },
        }) }), error => !error.message.includes(secret) && !error.message.includes('invalid JSON including'));
        const directory = path.join(f.directories.root, 'jobs/artifacts', jobKey(f.job.id));
        for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
            assert.equal(fs.readFileSync(path.join(directory, name), 'utf8').includes(secret), false);
        }
    }
});
