import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const { createFreshnessGate } = await import('../src/generation/roleplay-freshness-gate.js');
const { readRoleplaySettingsJson } = await import('../src/generation/settings-cache.js');
const { readJsonShared } = await import('../src/mewmory/store.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');
const { acceptJob, getJob, jobKey, listJobs, readJobStore, setJobResume, updateJob } = await import('../src/jobs/store.js');
const { publishRoleplayPreview, subscribeRoleplayPreview } = await import('../src/generation/roleplay-preview.js');
const { createProviderScope, providerNotDispatched, providerRefused, providerStep, readArtifact, unresolvedProviderStep } = await import('../src/jobs/artifacts.js');
const { subscribeJobsChanged } = await import('../src/jobs/notifications.js');

const temporary = prefix => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return { root, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
};

test('five parallel callers share one freshness check, and later turns get a new one', async () => {
    let checks = 0;
    const gate = createFreshnessGate(() => { checks++; });
    const waiting = Array.from({ length: 5 }, () => gate());
    assert.equal(checks, 0, 'the check runs after the callers of this turn have queued');
    await Promise.all(waiting);
    assert.equal(checks, 1, 'all five callers waited for the same check');
    await gate();
    assert.equal(checks, 2, 'success is not cached into the next turn');
    await Promise.all([gate(), gate(), gate()]);
    assert.equal(checks, 3, 'a later group shares its own new check');
});

test('a shared freshness failure gives every caller its own copy with the same identity', async () => {
    const original = Object.assign(new Error('The Roleplay source changed.'), { code: 'ROLEPLAY_SOURCE_CHANGED', status: 409,
        imageIssue: { reason: 'vision-unavailable', index: 1 } });
    const gate = createFreshnessGate(() => { throw original; });
    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => gate()));
    const errors = settled.map(result => result.reason);
    assert.equal(errors.every(error => error instanceof Error), true);
    assert.equal(new Set(errors).size, 5, 'one caller mutating its error cannot affect another');
    for (const error of errors) {
        assert.notEqual(error, original);
        assert.equal(error.message, original.message);
        assert.equal(error.code, original.code);
        assert.equal(error.status, original.status);
        assert.deepEqual(error.imageIssue, original.imageIssue);
        assert.notEqual(error.imageIssue, original.imageIssue);
    }
    original.imageIssue.reason = 'changed-after-delivery';
    assert.ok(errors.every(error => error.imageIssue.reason === 'vision-unavailable'));
});

test('a preview frame reaches listeners before its display write and survives a failed write', t => {
    const area = temporary('neconyan-preview-order-');
    t.after(area.remove);
    const directories = { root: area.root };
    const owner = 'preview-order';
    const parent = acceptJob(directories, { owner, type: 'media.roleplay-workflow', submissionKey: randomUUID(),
        intent: { request: {} } }).job;
    const context = { owner, directories, job: { id: randomUUID(), intent: { request: { characterName: 'Nova',
        workflowCandidate: { parentJobId: parent.id } } } } };
    const events = [];
    const unsubscribe = subscribeRoleplayPreview(owner, parent.id, () => events.push('listener'));
    t.after(unsubscribe);
    const artifactDirectory = path.join(area.root, 'jobs', 'artifacts', jobKey(parent.id));
    const original = fs.openSync;
    t.mock.method(fs, 'openSync', function (filename, ...args) {
        if (path.dirname(String(filename)) === artifactDirectory) events.push('write');
        return original.call(this, filename, ...args);
    });
    publishRoleplayPreview(context, { stage: 'agents', text: 'Finished reply' });
    assert.deepEqual(events, ['listener', 'write'], 'the reader is told before the file is opened');
    assert.equal(fs.statSync(path.join(artifactDirectory, jobKey('roleplay-preview') + '.json')).isFile(), true);
    // Make the display artifact unwritable: a listener frame must still arrive.
    fs.rmSync(artifactDirectory, { recursive: true, force: true });
    fs.mkdirSync(path.join(artifactDirectory, jobKey('roleplay-preview') + '.json'), { recursive: true });
    events.length = 0;
    assert.doesNotThrow(() => publishRoleplayPreview(context, { stage: 'companions', text: 'Still delivered' }));
    assert.deepEqual(events, ['listener', 'write'], 'the failed write is after the listener and is swallowed');
});

test('the shared settings cache keeps object identity, reloads changed bytes and follows a replacement inode', t => {
    const area = temporary('neconyan-settings-cache-');
    t.after(area.remove);
    const filename = path.join(area.root, 'settings.json');
    fs.writeFileSync(filename, JSON.stringify({ revision: 1, nested: { value: 'first' } }));
    const first = readJsonShared(filename, {});
    const second = readJsonShared(filename, {});
    assert.equal(first, second, 'an unchanged file is parsed once');
    Object.freeze(first.nested);
    assert.equal(readJsonShared(filename, {}).nested.value, 'first');
    // An in-place update with different bytes must be visible on the next read.
    fs.writeFileSync(filename, JSON.stringify({ revision: 2, nested: { value: 'second-pass' } }));
    const changed = readJsonShared(filename, {});
    assert.notEqual(changed, first);
    assert.equal(changed.revision, 2);
    // A replacement through rename must be read again even if size and times match.
    const stat = fs.statSync(filename);
    const replacement = filename + '.replacement';
    fs.writeFileSync(replacement, JSON.stringify({ revision: 3, nested: { value: 'third-value' } }));
    fs.utimesSync(replacement, stat.atime, stat.mtime);
    fs.renameSync(replacement, filename);
    const replaced = readJsonShared(filename, {});
    assert.equal(replaced.revision, 3);
    assert.equal(readJsonShared(path.join(area.root, 'missing.json'), { fallback: true }).fallback, true);
    const damaged = path.join(area.root, 'damaged.json');
    fs.writeFileSync(damaged, '{broken');
    assert.throws(() => readJsonShared(damaged, {}), error => error.status === 409
        && /Mewmory could not read the saved memories/.test(error.message));
    // The shared object is read-only: capture a profile from a deep-frozen copy
    // so any hidden write in profile resolution fails this test.
    fs.writeFileSync(filename, JSON.stringify({ oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:1/v1' },
        power_user: {}, extension_settings: { connectionManager: { profiles: [{ id: 'main', name: 'Main', api: 'custom',
            model: 'fixture', 'api-url': 'http://127.0.0.1:1/v1' }] } } }));
    const freeze = value => {
        if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
        Object.freeze(value);
        for (const child of Object.values(value)) freeze(child);
        return value;
    };
    freeze(readJsonShared(path.join(area.root, 'settings.json'), {}));
    assert.doesNotThrow(() => captureChatProfile({ root: area.root }, 'main'));
});

test('protected settings reads keep link, size and parse semantics while reusing unchanged parses', t => {
    const area = temporary('neconyan-protected-settings-');
    t.after(area.remove);
    const filename = path.join(area.root, 'settings.json');
    fs.writeFileSync(filename, JSON.stringify({ value: 'first' }));
    const first = readRoleplaySettingsJson(filename, { limit: 1024 });
    const second = readRoleplaySettingsJson(filename, { limit: 1024 });
    assert.equal(first, second, 'an unchanged protected file reuses its parsed object');
    assert.equal(readRoleplaySettingsJson(filename, { limit: 64 * 1024 * 1024 }), first,
        'a larger caller limit reuses the same parsed object after its own checks');
    fs.writeFileSync(filename, JSON.stringify({ value: 'other' }));
    const changed = readRoleplaySettingsJson(filename, { limit: 1024 });
    assert.notEqual(changed, first);
    assert.equal(changed.value, 'other');
    assert.equal(readRoleplaySettingsJson(path.join(area.root, 'missing.json'), {}), null);

    fs.writeFileSync(filename, '{broken');
    assert.throws(() => readRoleplaySettingsJson(filename, { limit: 1024 }), SyntaxError);
    fs.writeFileSync(filename, 'x'.repeat(2048));
    assert.throws(() => readRoleplaySettingsJson(filename, { limit: 1024 }), { code: 'ROLEPLAY_STORE_DAMAGED' });

    const target = path.join(area.root, 'settings-target.json');
    fs.writeFileSync(target, JSON.stringify({ value: 'linked' }));
    const symbolic = path.join(area.root, 'settings-symbolic.json');
    fs.symlinkSync(target, symbolic);
    assert.throws(() => readRoleplaySettingsJson(symbolic, { limit: 1024 }), { code: 'ROLEPLAY_STORE_DAMAGED' });
    const hard = path.join(area.root, 'settings-hard.json');
    fs.linkSync(target, hard);
    assert.throws(() => readRoleplaySettingsJson(target, { limit: 1024 }), { code: 'ROLEPLAY_STORE_DAMAGED' });
});

test('parallel refused provider steps leave no never-sent resume key behind', async t => {
    const area = temporary('neconyan-refused-resume-');
    t.after(area.remove);
    const directories = { root: area.root };
    const job = acceptJob(directories, { owner: 'resume-owner', type: 'resume-check', submissionKey: 'refused-parallel', intent: {} }).job;
    const context = { directories, job, signal: new AbortController().signal };
    const shared = { ...context, providerScope: createProviderScope(context) };
    const refusal = Object.assign(new Error('The saved source changed.'), { code: 'ROLEPLAY_SOURCE_CHANGED', status: 409 });
    const gate = createFreshnessGate(() => { throw refusal; });
    const refused = async () => {
        try { await gate(); } catch (error) { throw providerNotDispatched(error); }
        return { text: 'never sent' };
    };
    const names = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
    const settled = await Promise.allSettled(names.map(name => providerStep(shared, name, refused)));
    assert.ok(settled.every(item => item.status === 'rejected' && item.reason.code === 'ROLEPLAY_SOURCE_CHANGED'));
    const after = getJob(directories, job.id);
    assert.equal(after.resume, null, 'no never-sent sibling is left as the resume key');
    assert.deepEqual(after.recoverySteps, []);
    assert.equal(unresolvedProviderStep(directories, job.id, { scope: createProviderScope(context) }), undefined);
    for (const name of names) assert.equal(readArtifact(directories, job.id, 'provider:' + name), undefined);
});

test('a pre-dispatch or definite provider refusal restores the ordinary checkpoint', async t => {
    const area = temporary('neconyan-checkpoint-');
    t.after(area.remove);
    const directories = { root: area.root };
    for (const [label, wrap] of [['predispatch', providerNotDispatched], ['providerRefused', providerRefused]]) {
        const job = acceptJob(directories, { owner: 'checkpoint-owner', type: 'checkpoint-check', submissionKey: label, intent: {} }).job;
        setJobResume(directories, job.id, 'mewmory');
        const context = { directories, job, signal: new AbortController().signal };
        await assert.rejects(providerStep(context, 'c'.repeat(64), async () => {
            throw wrap(Object.assign(new Error('refused'), { code: 'ROLEPLAY_SOURCE_CHANGED', status: 409, providerStatus: 429 }));
        }), { code: 'ROLEPLAY_SOURCE_CHANGED' });
        const after = getJob(directories, job.id);
        assert.equal(after.resume, 'mewmory', `${label} keeps the ordinary checkpoint`);
        assert.equal(after.recoverability, 'resumable');
        assert.deepEqual(after.recoverySteps, []);
    }
});

test('several parallel refusals keep the checkpoint from before the group', async t => {
    const area = temporary('neconyan-checkpoint-parallel-');
    t.after(area.remove);
    const directories = { root: area.root };
    const job = acceptJob(directories, { owner: 'checkpoint-owner', type: 'checkpoint-check', submissionKey: 'parallel', intent: {} }).job;
    setJobResume(directories, job.id, 'mewmory');
    const context = { directories, job, signal: new AbortController().signal };
    const shared = { ...context, providerScope: createProviderScope(context) };
    const gate = createFreshnessGate(() => { throw Object.assign(new Error('changed'), { code: 'ROLEPLAY_SOURCE_CHANGED', status: 409 }); });
    const refused = async () => {
        try { await gate(); } catch (error) { throw providerNotDispatched(error); }
        return { text: 'never sent' };
    };
    await Promise.allSettled(['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)].map(name => providerStep(shared, name, refused)));
    const after = getJob(directories, job.id);
    assert.equal(after.resume, 'mewmory');
    assert.equal(after.recoverability, 'resumable');
    assert.deepEqual(after.recoverySteps, []);
    assert.equal(unresolvedProviderStep(directories, job.id, { scope: createProviderScope(context) }), undefined);
});

test('a refused sibling neither clears nor restores a genuinely uncertain active step', async t => {
    const area = temporary('neconyan-mixed-resume-');
    t.after(area.remove);
    const directories = { root: area.root };
    const job = acceptJob(directories, { owner: 'resume-owner', type: 'resume-check', submissionKey: 'mixed', intent: {} }).job;
    const context = { directories, job, signal: new AbortController().signal };
    const shared = { ...context, providerScope: createProviderScope(context) };
    const refusal = Object.assign(new Error('The saved source changed.'), { code: 'ROLEPLAY_SOURCE_CHANGED', status: 409 });
    const gate = createFreshnessGate(() => { throw refusal; });
    const refused = async () => {
        try { await gate(); } catch (error) { throw providerNotDispatched(error); }
        return { text: 'never sent' };
    };
    let releaseUncertain;
    const uncertainHeld = new Promise(resolve => { releaseUncertain = resolve; });
    const uncertain = async () => {
        await uncertainHeld;
        throw Object.assign(new Error('Provider connection dropped.'), { status: 502 });
    };
    const names = { first: 'd'.repeat(64), second: 'e'.repeat(64), uncertain: 'f'.repeat(64) };
    const first = providerStep(shared, names.first, refused);
    const second = providerStep(shared, names.second, refused);
    const unknown = providerStep(shared, names.uncertain, uncertain);
    const refusedResults = await Promise.allSettled([first, second]);
    assert.ok(refusedResults.every(item => item.status === 'rejected' && item.reason.code === 'ROLEPLAY_SOURCE_CHANGED'));
    const during = getJob(directories, job.id);
    assert.ok(during.resume === null || during.resume === 'provider:' + names.uncertain,
        'no refused sibling becomes the active resume while the uncertain one is still in flight');
    assert.deepEqual(during.recoverySteps, ['provider:' + names.uncertain]);
    assert.equal(during.recoverability, 'unknown-outcome');
    releaseUncertain();
    await assert.rejects(unknown, /connection dropped/i);
    const after = getJob(directories, job.id);
    assert.deepEqual(after.recoverySteps, ['provider:' + names.uncertain]);
    assert.equal(unresolvedProviderStep(directories, job.id, { scope: createProviderScope(context) }), 'provider:' + names.uncertain);

    // A later start in a fresh scope is refused by the older real unknown
    // result, which stays recorded instead of being replaced by a sibling.
    const later = { ...context, providerScope: createProviderScope(context) };
    await assert.rejects(providerStep(later, '1'.repeat(64), refused), { code: 'PROVIDER_OUTCOME_UNKNOWN' });
    const restored = getJob(directories, job.id);
    assert.equal(restored.resume, 'provider:' + names.uncertain);
    assert.deepEqual(restored.recoverySteps, ['provider:' + names.uncertain]);
});

test('the parsed job ledger is shared read-only, invalidated by writes and replaced files, and announces its state', t => {
    const area = temporary('neconyan-ledger-cache-');
    t.after(area.remove);
    const directories = { root: area.root };
    const accepted = acceptJob(directories, { owner: 'cache-owner', type: 'cache-check', submissionKey: 'cache', intent: {},
        label: 'original' }).job;
    const first = getJob(directories, accepted.id);
    first.label = 'caller changed this copy';
    assert.equal(getJob(directories, accepted.id).label, 'original', 'a returned job is a private copy');
    const listed = listJobs(directories, { owner: 'cache-owner' });
    listed[0].label = 'listed copy';
    assert.equal(getJob(directories, accepted.id).label, 'original');
    const whole = readJobStore(directories);
    whole.jobs[jobKey(accepted.id)].label = 'store copy';
    assert.equal(getJob(directories, accepted.id).label, 'original');

    const changes = [];
    const unsubscribe = subscribeJobsChanged(change => changes.push(change));
    t.after(unsubscribe);
    updateJob(directories, accepted.id, { state: 'completed' });
    assert.equal(changes.at(-1).id, accepted.id);
    assert.equal(changes.at(-1).state, 'completed');
    assert.equal(getJob(directories, accepted.id).state, 'completed', 'a write is visible on the next read');

    // Replace the ledger from outside with a same-sized label and the same mtime.
    const ledger = path.join(area.root, 'jobs', 'index.json');
    const raw = fs.readFileSync(ledger, 'utf8');
    const stat = fs.statSync(ledger);
    const parsed = JSON.parse(raw);
    parsed.jobs[jobKey(accepted.id)].label = 'replaced';
    const text = JSON.stringify(parsed);
    assert.equal(Buffer.byteLength(text), Buffer.byteLength(raw));
    const replacement = ledger + '.replacement';
    fs.writeFileSync(replacement, text);
    fs.utimesSync(replacement, stat.atime, stat.mtime);
    fs.renameSync(replacement, ledger);
    assert.equal(getJob(directories, accepted.id).label, 'replaced', 'a new inode is read even with matching size and times');
});

test('both parsed caches stay bounded and rebuild an evicted entry', async t => {
    const area = temporary('neconyan-cache-eviction-');
    t.after(area.remove);
    const original = JSON.parse;
    const directories = [];
    for (let index = 0; index < 17; index++) {
        const root = path.join(area.root, `ledger-${index}`);
        fs.mkdirSync(root, { recursive: true });
        const entry = { root };
        directories.push(entry);
        acceptJob(entry, { owner: 'evict-owner', type: 'evict-check', submissionKey: `job-${index}`, intent: {} });
    }
    for (const entry of directories) getJob(entry, listJobs(entry, { owner: 'evict-owner' })[0].id);
    let parses = 0;
    t.mock.method(JSON, 'parse', function (...args) { parses++; return original.apply(this, args); });
    const first = listJobs(directories[0], { owner: 'evict-owner' })[0];
    parses = 0;
    getJob(directories[0], first.id);
    assert.ok(parses > 0, 'the oldest parsed ledger was evicted after 17 accounts');
    const afterFirst = parses;
    getJob(directories[0], first.id);
    assert.equal(parses, afterFirst, 'the rebuilt entry is cached again');

    const settings = [];
    for (let index = 0; index < 17; index++) {
        const filename = path.join(area.root, `settings-${index}.json`);
        fs.writeFileSync(filename, JSON.stringify({ index }));
        settings.push(filename);
        readRoleplaySettingsJson(filename, { limit: 1024 });
    }
    parses = 0;
    readRoleplaySettingsJson(settings[0], { limit: 1024 });
    assert.ok(parses > 0, 'the oldest parsed settings entry was evicted after 17 files');
    const afterSettings = parses;
    readRoleplaySettingsJson(settings[0], { limit: 1024 });
    assert.equal(parses, afterSettings, 'the rebuilt settings entry is cached again');
});
