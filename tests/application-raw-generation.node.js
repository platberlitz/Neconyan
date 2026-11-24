import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { acceptApplicationOperation, runOperation } = await import('../src/operations/jobs.js');
await import('../src/operations/raw-generation.js');
await import('../src/operations/archive.js');
const { readOperation } = await import('../src/operations/store.js');
const { initialiseRoleplayAccount, roleplayHash } = await import('../src/roleplay-store.js');
const { JOB_LIMIT, acceptJob, getJob, jobKey, mutateJobs, updateJob } = await import('../src/jobs/store.js');
const { providerStep } = await import('../src/jobs/artifacts.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const roots = [];
after(() => { cancelAutoSaves(); roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })); });

function prepared(owner = 'raw') {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-generation-'));
    roots.push(parent);
    const root = path.join(parent, owner);
    fs.mkdirSync(root);
    const directories = { root };
    for (const name of ['worlds', 'characters', 'groups', 'chats', 'groupChats', 'openAI_Settings']) {
        directories[name] = path.join(root, name);
        fs.mkdirSync(directories[name]);
    }
    const preset = JSON.parse(fs.readFileSync(new URL('./fixtures/openai-default-preset.json', import.meta.url), 'utf8'));
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ name1: 'User', main_api: 'openai', max_context: 4096,
        extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] } },
        oai_settings: { ...preset, chat_completion_source: 'openai', openai_model: 'gpt-4o' } }));
    const base = { owner, directories };
    initialiseRoleplayAccount(base);
    const request = { user: { profile: { handle: owner }, directories } };
    const context = accepted => ({ ...base, job: getJob(directories, accepted.job.id), signal: new AbortController().signal, progress: async () => {} });
    return { base, request, context };
}

const body = (key, extra = {}) => ({ key, kind: 'raw-generation', systemPrompt: 'Pick one colour.', prompt: 'Red or blue?', profileId: 'saved', ...extra });

test('a plain prompt finishes after the page closes and a lost answer is read back without a second call', async () => {
    const p = prepared();
    const accepted = await acceptApplicationOperation(p.request, body('raw'));
    let calls = 0;
    const generate = async options => {
        calls++;
        assert.deepEqual(options.messages, [{ role: 'system', content: 'Pick one colour.' }, { role: 'user', content: 'Red or blue?' }]);
        return { text: 'Blue' };
    };
    await runOperation(p.context(accepted), { generate });
    assert.equal(readOperation(p.base, 'raw').result.text, 'Blue');
    fs.rmSync(path.join(p.base.directories.root, 'jobs/index.json'));
    const again = await acceptApplicationOperation(p.request, body('raw'));
    assert.equal(again.job, null);
    assert.equal(again.record.state, 'completed');
    assert.equal(calls, 1);
});

test('an unknown model result is not sent again', async () => {
    const p = prepared();
    const accepted = await acceptApplicationOperation(p.request, body('unknown'));
    let calls = 0;
    const generate = options => providerStep(options.jobContext, options.stepNamespace, async () => { calls++; throw new Error('connection lost'); });
    await assert.rejects(runOperation(p.context(accepted), { generate }), /connection lost/);
    await assert.rejects(runOperation(p.context(accepted), { generate }), /unknown/i);
    assert.equal(calls, 1);
});

test('a plain prompt is accepted on the active Chat Completion connection', async () => {
    const p = prepared('active');
    const file = path.join(p.base.directories.root, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...settings, _settingsRevision: 3,
        active_generation: { api: 'openai', source: 'custom', model: 'fixture' },
        oai_settings: { ...settings.oai_settings, chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000/v1', custom_model: 'fixture' } }));
    const accepted = await acceptApplicationOperation(p.request, body('active', { profileId: '', acknowledgement: { settingsRevision: 3 } }));
    assert.equal(accepted.job.state, 'queued');
    let sent;
    await runOperation(p.context(accepted), { generate: async options => { sent = options.messages; return { text: 'Red' }; } });
    assert.deepEqual(sent, [{ role: 'system', content: 'Pick one colour.' }, { role: 'user', content: 'Red or blue?' }]);
    assert.equal(readOperation(p.base, 'active').result.text, 'Red');
});

test('a plain prompt can turn reasoning off for one request on the active Chat Completion connection', async () => {
    const p = prepared('effort');
    const file = path.join(p.base.directories.root, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...settings, _settingsRevision: 3,
        active_generation: { api: 'openai', source: 'custom', model: 'fixture' },
        oai_settings: { ...settings.oai_settings, chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000/v1', custom_model: 'fixture', reasoning_effort: 'high' } }));
    const accepted = await acceptApplicationOperation(p.request, body('effort', { profileId: '', reasoningEffort: 'none', acknowledgement: { settingsRevision: 3 } }));
    let rawOptions;
    await runOperation(p.context(accepted), { generate: async options => { rawOptions = options.rawOptions; return { text: 'Red' }; } });
    assert.deepEqual(rawOptions, { reasoningEffort: 'none' });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).oai_settings.reasoning_effort, 'high');
    await assert.rejects(acceptApplicationOperation(p.request, body('effort-bad', { profileId: '', reasoningEffort: 'lots', acknowledgement: { settingsRevision: 3 } })), /reasoning effort/);
    assert.equal(readOperation(p.base, 'effort-bad'), null);
});

test('the operation endpoint proves a stale active settings acknowledgement was refused before admission', async () => {
    const p = prepared('stale-active');
    const file = path.join(p.base.directories.root, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...settings, _settingsRevision: 3,
        active_generation: { api: 'openai', source: 'custom', model: 'fixture' },
        oai_settings: { ...settings.oai_settings, chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000/v1', custom_model: 'fixture' } }));
    const { router } = await import('../src/endpoints/operations.js');
    const app = express();
    app.use(express.json(), (req, _res, next) => { req.user = p.request.user; next(); });
    app.use('/api/operations', router);
    const server = app.listen(0, '127.0.0.1');
    try {
        await once(server, 'listening');
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/operations/submit`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body('stale-active', { profileId: '', acknowledgement: { settingsRevision: 2 } })),
        });
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), {
            code: 'active_settings_ack_required', notAccepted: true,
            error: 'The active connection settings are not acknowledged. Save them before generating a reply.',
        });
        const record = readOperation(p.base, 'stale-active');
        assert.equal(record.state, 'refused');
        assert.equal(record.jobId, '');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('a plain prompt is accepted on the active connection when a character\'s regex scripts are allowed', async () => {
    const p = prepared('allowed-regex');
    const file = path.join(p.base.directories.root, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...settings, _settingsRevision: 3,
        extension_settings: { ...settings.extension_settings, character_allowed_regex: ['Someone.png'] },
        active_generation: { api: 'openai', source: 'custom', model: 'fixture' },
        oai_settings: { ...settings.oai_settings, chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000/v1', custom_model: 'fixture' } }));
    const accepted = await acceptApplicationOperation(p.request, body('allowed', { profileId: '', acknowledgement: { settingsRevision: 3 } }));
    assert.equal(accepted.job.state, 'queued');
    let scope;
    await runOperation(p.context(accepted), { generate: async options => { scope = options.macroEnvironment.extra.characterScope; return { text: 'Red' }; } });
    assert.equal(scope, 'none');
    assert.equal(readOperation(p.base, 'allowed').result.text, 'Red');
});

test('an empty prompt is refused before any work is accepted', async () => {
    const p = prepared();
    await assert.rejects(acceptApplicationOperation(p.request, body('empty', { prompt: ' ', systemPrompt: '' })), /prompt/);
    assert.equal(readOperation(p.base, 'empty'), null);
});

test('failed, interrupted, cancelled and pruned accepted operations release storage reservations while keeping records', async () => {
    const p = prepared('release-reservations');
    const archives = [];
    for (let i = 0; i < 7; i++) {
        archives.push(await acceptApplicationOperation(p.request, { key: `arch-${i}`, kind: 'archive-inventory' }));
    }
    // 7 x 64 MiB = 448 MiB live; 4 live raw-generation jobs (4 x 16 MiB = 64 MiB) fit at 512 MiB, while a 5th does not.
    const raws = [];
    for (let i = 0; i < 4; i++) {
        raws.push(await acceptApplicationOperation(p.request, body(`raw-live-${i}`)));
    }
    await assert.rejects(acceptApplicationOperation(p.request, body('raw-full')), error => error.status === 413 && error.code === 'APPLICATION_WORK_CHANGED');

    // Mark the 7 archive jobs across every non-live state, including pruned from jobs/index.json.
    updateJob(p.base.directories, archives[0].job.id, { state: 'failed' });
    updateJob(p.base.directories, archives[1].job.id, { state: 'interrupted' });
    updateJob(p.base.directories, archives[2].job.id, { state: 'cancelled' });
    mutateJobs(p.base.directories, store => {
        for (let i = 3; i < 7; i++) delete store.jobs[jobKey(archives[i].job.id)];
        return { changed: true };
    });

    // All 7 permanent operation records remain intact on disk, and new raw-generation work succeeds.
    for (let i = 0; i < 7; i++) assert.equal(readOperation(p.base, `arch-${i}`).state, 'accepted');
    const afterRelease = await acceptApplicationOperation(p.request, body('raw-after-release'));
    assert.equal(afterRelease.job.state, 'queued');
    await runOperation(p.context(afterRelease), { generate: async () => ({ text: 'Green' }) });
    assert.equal(readOperation(p.base, 'raw-after-release').result.text, 'Green');
});

test('stale active settings refusal records durable proof even when less than a full operation reservation remains', async () => {
    const p = prepared('stale-near-full');
    const file = path.join(p.base.directories.root, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...settings, _settingsRevision: 10,
        active_generation: { api: 'openai', source: 'custom', model: 'fixture' },
        oai_settings: { ...settings.oai_settings, chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000/v1', custom_model: 'fixture' } }));
    // Fill 496 MiB of the 512 MiB cap (7 x 64 MiB + 3 x 16 MiB), leaving under 16 MiB free.
    for (let i = 0; i < 7; i++) await acceptApplicationOperation(p.request, { key: `fill-a-${i}`, kind: 'archive-inventory' });
    for (let i = 0; i < 3; i++) await acceptApplicationOperation(p.request, body(`fill-r-${i}`, { profileId: '', acknowledgement: { settingsRevision: 10 } }));
    const { router } = await import('../src/endpoints/operations.js');
    const app = express();
    app.use(express.json(), (req, _res, next) => { req.user = p.request.user; next(); });
    app.use('/api/operations', router);
    const server = app.listen(0, '127.0.0.1');
    try {
        await once(server, 'listening');
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/operations/submit`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body('stale-near-full', { profileId: '', acknowledgement: { settingsRevision: 9 } })),
        });
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), {
            code: 'active_settings_ack_required', notAccepted: true,
            error: 'The active connection settings are not acknowledged. Save them before generating a reply.',
        });
        assert.equal(readOperation(p.base, 'stale-near-full').state, 'refused');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('definite upstream 503 provider refusal marks raw-generation refused while PROVIDER_OUTCOME_UNKNOWN stays accepted', async () => {
    const p = prepared('provider-refusal');
    const refusedAccepted = await acceptApplicationOperation(p.request, body('upstream-503'));
    await assert.rejects(
        runOperation(p.context(refusedAccepted), {
            generate: async () => { throw Object.assign(new Error('Upstream overloaded'), { status: 502, providerStatus: 503 }); },
        }),
        error => error.operationRefused === true,
    );
    assert.equal(readOperation(p.base, 'upstream-503').state, 'refused');

    const unknownAccepted = await acceptApplicationOperation(p.request, body('unknown-503'));
    await assert.rejects(
        runOperation(p.context(unknownAccepted), {
            generate: async () => { throw Object.assign(new Error('The result from the AI service is unknown.'), { status: 503, code: 'PROVIDER_OUTCOME_UNKNOWN' }); },
        }),
        error => error.code === 'PROVIDER_OUTCOME_UNKNOWN' && error.operationRefused !== true,
    );
    assert.equal(readOperation(p.base, 'unknown-503').state, 'accepted');
});

test('retrying an interrupted application operation re-checks storage reservation', async () => {
    const p = prepared('retry-reservation');
    const target = await acceptApplicationOperation(p.request, body('retry-target'));
    updateJob(p.base.directories, target.job.id, { state: 'interrupted' });
    const kept = await acceptApplicationOperation(p.request, body('retry-kept'));
    await runOperation(p.context(kept), { generate: async () => ({ text: 'Kept' }) });
    const fillers = [];
    for (let i = 0; i < 7; i++) fillers.push(await acceptApplicationOperation(p.request, { key: `fill-retry-a-${i}`, kind: 'archive-inventory' }));
    for (let i = 0; i < 3; i++) fillers.push(await acceptApplicationOperation(p.request, body(`fill-retry-r-${i}`)));
    const { router: jobsRouter } = await import('../src/endpoints/jobs.js');
    const app = express();
    app.use(express.json(), (req, _res, next) => { req.user = p.request.user; next(); });
    app.use('/api/jobs', jobsRouter);
    const server = app.listen(0, '127.0.0.1');
    try {
        await once(server, 'listening');
        const blocked = await fetch(`http://127.0.0.1:${server.address().port}/api/jobs/${target.job.id}/retry`, { method: 'POST' });
        assert.equal(blocked.status, 413);
        assert.equal((await blocked.json()).code, 'APPLICATION_WORK_CHANGED');
        assert.equal(getJob(p.base.directories, target.job.id).state, 'interrupted');

        updateJob(p.base.directories, fillers[0].job.id, { state: 'cancelled' });
        const retried = await fetch(`http://127.0.0.1:${server.address().port}/api/jobs/${target.job.id}/retry`, { method: 'POST' });
        assert.equal(retried.status, 200);
        assert.equal(getJob(p.base.directories, target.job.id).state, 'queued');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('completing an already-open operation succeeds even if existing open records exceed the storage cap', async () => {
    const p = prepared('over-cap-close');
    const target = await acceptApplicationOperation(p.request, body('close-target'));
    const archives = [];
    for (let i = 0; i < 7; i++) archives.push(await acceptApplicationOperation(p.request, { key: `over-arch-${i}`, kind: 'archive-inventory' }));
    const roleplayRoot = path.join(path.dirname(p.base.directories.root), '_roleplay');
    const accountDir = fs.readdirSync(roleplayRoot).find(name => fs.existsSync(path.join(roleplayRoot, name, 'operations')));
    const opsDir = path.join(roleplayRoot, accountDir, 'operations');
    const firstArchiveFile = fs.readdirSync(opsDir).find(name => name.endsWith('.json') && JSON.parse(fs.readFileSync(path.join(opsDir, name), 'utf8')).key === 'over-arch-0');
    const extra = JSON.parse(fs.readFileSync(path.join(opsDir, firstArchiveFile), 'utf8'));
    extra.key = 'over-arch-legacy-duplicate';
    fs.writeFileSync(path.join(opsDir, `${roleplayHash(extra.key)}.json`), JSON.stringify(extra));
    await runOperation(p.context(target), { generate: async () => ({ text: 'Blue' }) });
    assert.equal(readOperation(p.base, 'close-target').state, 'completed');
    assert.equal(readOperation(p.base, 'close-target').result.text, 'Blue');
});

test('JOB_STORE_FULL during operation admission marks the preparing record refused and returns notAccepted true', async () => {
    const p = prepared('job-store-full');
    const seed = acceptJob(p.base.directories, { owner: p.base.owner, type: 'fixture.test', submissionKey: 'seed', intent: {} }).job;
    mutateJobs(p.base.directories, store => {
        store.jobs = Object.fromEntries(Array.from({ length: JOB_LIMIT }, (_, index) => {
            const job = { ...seed, id: `busy-${index}`, state: 'waiting' };
            return [jobKey(job.id), job];
        }));
        return { changed: true };
    });
    const { router } = await import('../src/endpoints/operations.js');
    const app = express();
    app.use(express.json(), (req, _res, next) => { req.user = p.request.user; next(); });
    app.use('/api/operations', router);
    const server = app.listen(0, '127.0.0.1');
    try {
        await once(server, 'listening');
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/operations/submit`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body('job-full-key')),
        });
        assert.equal(response.status, 503);
        const payload = await response.json();
        assert.equal(payload.code, 'JOB_STORE_FULL');
        assert.equal(payload.notAccepted, true);
        assert.equal(readOperation(p.base, 'job-full-key').state, 'refused');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
