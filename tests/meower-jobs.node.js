import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { getChatFileLockPath } from '../src/chat-file-lock.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { acceptMeowerJob, createMeowerJobHandler, finalizeMeowerSubmission } = await import('../src/generation/meower-jobs.js');
const { readMeowerStore, mutateMeowerStore } = await import('../public/scripts/extensions/third-party/Neconyan-Hopper/server/index.js');
const { normalizeSettings, normalizeSession } = await import('../public/scripts/extensions/third-party/Neconyan-Hopper/src/core.js');
const { readArtifact, writeArtifact, providerStep, providerRefused } = await import('../src/jobs/artifacts.js');
const { getJob, updateJob, markProviderUncertain } = await import('../src/jobs/store.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { write: writeCard } = await import('../src/character-card-parser.js');
const { initialiseRoleplayAccount, resetRoleplayAccount, settleRoleplayAccountReset, roleplayStoreDirectory } = await import('../src/roleplay-store.js');
const { meowerMacros, checkMeowerReceipts, receiptKey, RECEIPT_LIMIT } = await import('../src/generation/meower-plan.js');
const { createMacroEnvironment } = await import('../src/macros/index.js');
after(() => cancelAutoSaves());
const roots = [];
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));

async function fixture(owner = 'tester', options = {}) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'meower-jobs-'));
    roots.push(parent);
    const root = path.join(parent, owner);
    fs.mkdirSync(root);
    const directories = { root };
    for (const name of ['characters', 'files', 'userImages']) {
        directories[name] = path.join(root, name);
        fs.mkdirSync(directories[name]);
    }
    const png = fs.readFileSync(new URL('../default/content/backgrounds/__transparent.png', import.meta.url));
    fs.writeFileSync(path.join(directories.characters, 'nova.png'), writeCard(png, JSON.stringify({ name: 'Nova', description: 'A friendly astronaut.' })));
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ _version: 0,
        power_user: { personas: { 'user.png': 'User' }, persona_descriptions: { 'user.png': { description: 'A botanist.', appendices: [{ id: 'note', name: 'Test', description: 'Growing roses.' }] } } },
        extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] } },
        oai_settings: { chat_completion_source: 'openai' } }));
    initialiseRoleplayAccount({ owner, directories });
    await mutateMeowerStore(directories, owner, store => {
        store.settings = normalizeSettings({ profileId: 'saved', profiles: { 'character:nova.png': { name: 'Nova', handle: 'nova', bio: 'Space', location: 'Moon' } },
            incremental: true, quotas: { posts: 1, replies: 0, reposts: 0, likes: 0 }, ...options });
        store.settings.sessions.one = normalizeSession({ id: 'one', invited: ['nova.png'], personaId: 'user.png', scenarioNoteIds: ['note'], ambient: false }, 'one');
        store.feeds.one = { version: 1, epoch: 'original', posts: [], interactions: [] };
    });
    const request = { user: { profile: { handle: owner }, directories } };
    const body = { sessionId: 'one', submissionKey: 'submit-1' };
    const accepted = await acceptMeowerJob(request, body);
    const context = { owner, directories, job: accepted.job, signal: new AbortController().signal,
        progress: async patch => updateJob(directories, accepted.job.id, { progress: patch }) };
    return { owner, directories, request, body, context };
}

const postText = JSON.stringify({ posts: [{ authorHandle: 'nova', tempId: 'post1', content: 'Moon garden', imagePrompt: null }], interactions: [], follows: [], strangers: [], trends: [] });
const getFeed = async fixture => (await readMeowerStore(fixture.directories, fixture.owner)).store.feeds.one;

test('Meower effort normalises legacy input and captures each explicit chat override', async () => {
    for (const invalid of [undefined, null, {}, [], 'XHigh', 'minimal', 'injected']) assert.equal(normalizeSettings({ reasoningEffort: invalid }).reasoningEffort, '');
    for (const effort of ['', 'auto', 'none', 'min', 'low', 'medium', 'high', 'xhigh', 'max']) {
        assert.equal(normalizeSettings({ reasoningEffort: effort }).reasoningEffort, effort);
        const f = await fixture('tester', { reasoningEffort: effort });
        assert.deepEqual(readArtifact(f.directories, f.context.job.id, 'plan').overridePayload, effort ? { reasoning_effort: effort } : {});
    }
});

for (const incremental of [false, true]) test(`captured local effort reaches ${incremental ? 'incremental posts/reactions' : 'batch and correction'} unchanged after settings edits`, async () => {
    const f = await fixture('tester', { reasoningEffort: 'xhigh', incremental, quotas: { posts: 1, replies: incremental ? 1 : 0, reposts: 0, likes: 0 } });
    await mutateMeowerStore(f.directories, f.owner, store => { store.settings.reasoningEffort = 'low'; });
    const records = [];
    const handler = createMeowerJobHandler({ generate: async options => {
        records.push(options);
        return { text: !incremental && records.length === 1 ? 'not JSON' : postText };
    } });
    await handler(f.context);
    assert.equal(records.length, 2);
    assert.ok(records.every(options => options.overridePayload.reasoning_effort === 'xhigh' && options.maxTokens === 32768 && options.rawOptions.includePreset === false));
    if (incremental) assert.ok(records.every(options => /meower:wave:/.test(options.stepNamespace)));
    else assert.match(records[1].messages.at(-1).content, /JSON|correct|format/i);
    await handler(f.context);
    assert.equal(records.length, 2, 'artifact/receipt reuse does not generate again');
});

for (const mode of ['persona', 'character', 'all']) test(`captured local effort reaches ${mode} profile generation`, async () => {
    const f = await fixture('tester', { reasoningEffort: 'high' });
    const accepted = await acceptMeowerJob(f.request, { ...f.body, submissionKey: `profile-${mode}`, mode, accountKey: 'character:nova.png' }, 'profile');
    await mutateMeowerStore(f.directories, f.owner, store => { store.settings.reasoningEffort = 'low'; });
    const records = [];
    await createMeowerJobHandler({ generate: async options => {
        records.push(options);
        return { text: JSON.stringify({ profiles: [{ entityId: mode === 'persona' ? 'user.png' : 'nova.png', name: 'Moon gardener', handle: 'moon_gardener', bio: 'Flowers', location: 'Moon' }] }) };
    } })({ ...f.context, job: accepted.job });
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].overridePayload, { reasoning_effort: 'high' });
    assert.equal(records[0].rawOptions.includePreset, false);
});

test('missing cast profiles and later activity share the captured local effort', async () => {
    const f = await fixture('tester', { reasoningEffort: 'high', profiles: {} });
    const records = [];
    await createMeowerJobHandler({ generate: async options => {
        records.push(options);
        return { text: options.stepNamespace.endsWith(':profiles') ? JSON.stringify({ profiles: [{ entityId: 'nova.png', name: 'Nova', handle: 'nova', bio: 'Space', location: 'Moon' }] }) : postText };
    } })(f.context);
    assert.equal(records.length, 2);
    assert.ok(records.every(options => options.overridePayload.reasoning_effort === 'high'));
});

test('accepting a text plan leaves the stored local chat effort inactive', async () => {
    const f = await fixture('tester', { reasoningEffort: 'xhigh' });
    const filename = path.join(f.directories.root, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(filename, 'utf8'));
    Object.assign(settings.extension_settings.connectionManager.profiles[0], { api: 'llamacpp', mode: 'tc', 'api-url': 'http://127.0.0.1:5000' });
    settings.max_context = 8192;
    settings.textgenerationwebui_settings = { type: 'llamacpp', banned_tokens: '', global_banned_tokens: '', dry_sequence_breakers: '[]', negative_prompt: '', logit_bias: [] };
    fs.writeFileSync(filename, JSON.stringify(settings));
    const accepted = await acceptMeowerJob(f.request, { ...f.body, submissionKey: 'text' });
    const plan = readArtifact(f.directories, accepted.job.id, 'plan');
    assert.equal(plan.binding.backend, 'text');
    assert.equal(plan.settings.reasoningEffort, 'xhigh');
    assert.deepEqual(plan.overridePayload, {});
});

test('a manual replacement gets current settings while both accepted identities remain idempotent', async () => {
    const f = await fixture();
    updateJob(f.directories, f.context.job.id, { state: 'failed', recoverability: 'settled', resume: null, recoveryStep: null, recoverySteps: [], error: { status: 400 } });
    await mutateMeowerStore(f.directories, f.owner, store => { store.settings.reasoningEffort = 'xhigh'; });
    const body = { ...f.body, submissionKey: 'replacement', previousJobId: f.context.job.id };
    const replacement = await acceptMeowerJob(f.request, body);
    assert.notEqual(replacement.job.id, f.context.job.id);
    assert.equal(readArtifact(f.directories, replacement.job.id, 'plan').overridePayload.reasoning_effort, 'xhigh');
    updateJob(f.directories, f.context.job.id, { state: 'running', recoverability: 'unknown-outcome' });
    assert.equal((await acceptMeowerJob(f.request, body)).job.id, replacement.job.id);
    assert.equal((await acceptMeowerJob(f.request, f.body)).job.id, f.context.job.id);
    await assert.rejects(acceptMeowerJob(f.request, { ...body, previousJobId: 'changed' }), /submission key/);
});

for (const patch of [
    { state: 'interrupted' }, { state: 'waiting' }, { state: 'running' },
    { recoverability: 'unknown-outcome' }, { recoverySteps: 'damaged' }, { recoverySteps: [42] },
    { resume: 'provider:missing' }, { recoverySteps: ['provider:missing'] },
    { type: 'other' }, { owner: 'someone-else' }, { target: { kind: 'meower', id: 'other' } },
    { state: 'cancelled', recoverability: 'unknown-outcome', recoverySteps: ['provider:missing'] },
]) test(`replacement retains unsafe or unrelated prior work: ${JSON.stringify(patch)}`, async () => {
    const f = await fixture();
    updateJob(f.directories, f.context.job.id, { state: 'failed', recoverability: 'settled', resume: null, recoveryStep: null, recoverySteps: [], ...patch });
    await assert.rejects(acceptMeowerJob(f.request, { ...f.body, submissionKey: 'replacement', previousJobId: f.context.job.id }), /Jobs|recovery|repair/i);
});

test('profile replacements cannot cross profile mode or chosen character identity', async () => {
    const f = await fixture();
    const prior = await acceptMeowerJob(f.request, { ...f.body, submissionKey: 'profile-old', mode: 'character', accountKey: 'character:nova.png' }, 'profile');
    updateJob(f.directories, prior.job.id, { state: 'failed', recoverability: 'settled', resume: null, recoveryStep: null, recoverySteps: [] });
    for (const input of [{ mode: 'all' }, { mode: 'persona' }, { mode: 'character', accountKey: 'character:other.png' }]) {
        await assert.rejects(acceptMeowerJob(f.request, { sessionId: 'one', submissionKey: JSON.stringify(input), previousJobId: prior.job.id, ...input }, 'profile'), /Jobs|recovery/i);
    }
});

for (const damaged of ['intent', 'receipt']) test(`replacement refuses damaged ${damaged} evidence without accepting a new key`, async () => {
    const f = await fixture();
    const previous = getJob(f.directories, f.context.job.id);
    updateJob(f.directories, previous.id, { state: 'failed', recoverability: 'settled', resume: null, recoveryStep: null, recoverySteps: [],
        ...(damaged === 'intent' ? { intent: { ...previous.intent, plan: { ...previous.intent.plan, settings: { ...previous.intent.plan.settings, reasoningEffort: 'low' } } } } : {}) });
    if (damaged === 'receipt') await mutateMeowerStore(f.directories, f.owner, (_store, receipts) => { receipts[receiptKey(f.owner, f.body.submissionKey)].requestHash = 'damaged'; });
    const before = (await readMeowerStore(f.directories, f.owner)).receipts;
    await assert.rejects(acceptMeowerJob(f.request, { ...f.body, submissionKey: 'replacement', previousJobId: previous.id }), /Jobs|recovery/i);
    assert.deepEqual((await readMeowerStore(f.directories, f.owner)).receipts, before);
});

test('a settled provider artifact permits replacement after partial successful activity', async () => {
    const f = await fixture();
    await createMeowerJobHandler({ generate: async () => ({ text: postText }) })(f.context);
    writeArtifact(f.directories, f.context.job.id, 'provider:successful-sibling', { text: postText });
    updateJob(f.directories, f.context.job.id, { state: 'failed', recoverability: 'resumable', resume: 'provider:successful-sibling', recoveryStep: null, recoverySteps: [] });
    const before = await getFeed(f);
    await acceptMeowerJob(f.request, { ...f.body, submissionKey: 'replacement', previousJobId: f.context.job.id });
    assert.deepEqual(await getFeed(f), before);
});

for (const partial of ['profiles', 'activity']) test(`real provider settlement permits manual replacement after saved ${partial} and a definite refusal`, async () => {
    const f = await fixture('tester', partial === 'profiles' ? { profiles: {} } : { concurrency: 2, quotas: { posts: 2, replies: 0, reposts: 0, likes: 0 } });
    let calls = 0;
    const handler = createMeowerJobHandler({ generate: options => providerStep(options.jobContext, options.stepNamespace, async () => {
        calls++;
        if (calls === 2) throw providerRefused(Object.assign(new Error('The selected effort is unavailable.'), { status: 400 }));
        return { text: partial === 'profiles' ? JSON.stringify({ profiles: [{ entityId: 'nova.png', name: 'Nova', handle: 'nova', bio: 'Saved before refusal', location: 'Moon' }] }) : postText };
    }) });
    await assert.rejects(handler(f.context), /selected effort/);
    const previous = getJob(f.directories, f.context.job.id);
    assert.equal(calls, 2);
    assert.notEqual(previous.recoverability, 'unknown-outcome');
    assert.deepEqual(previous.recoverySteps, []);
    assert.equal(previous.recoveryStep, null);
    if (previous.resume?.startsWith('provider:')) assert.notEqual(readArtifact(f.directories, previous.id, previous.resume), undefined);
    updateJob(f.directories, previous.id, { state: 'failed' });
    const before = (await readMeowerStore(f.directories, f.owner)).store;
    if (partial === 'profiles') assert.equal(before.settings.profiles['character:nova.png'].bio, 'Saved before refusal');
    else assert.equal(before.feeds.one.posts.length, 1);
    const replacement = await acceptMeowerJob(f.request, { ...f.body, submissionKey: 'replacement', previousJobId: previous.id });
    assert.equal(replacement.created, true);
    const after = (await readMeowerStore(f.directories, f.owner)).store;
    assert.deepEqual(after.feeds, before.feeds);
    assert.deepEqual(after.settings.profiles, before.settings.profiles);
});

test('a different process winning the Jobs lock before no-Labs replacement admission prevents replacement', async () => {
    const f = await fixture();
    updateJob(f.directories, f.context.job.id, { state: 'failed', recoverability: 'settled', resume: null, recoveryStep: null, recoverySteps: [] });
    assert.equal(fs.existsSync(path.join(roleplayStoreDirectory({ owner: f.owner, directories: f.directories }), 'labs')), false);
    // Resolve the production dependency, rather than Jest's independent tests/node_modules copy.
    const lockFs = createRequire(new URL('../src/chat-file-lock.js', import.meta.url))('graceful-fs');
    const originalMkdir = lockFs.mkdirSync;
    const lockPath = getChatFileLockPath(path.join(f.directories.root, 'jobs/index.json'));
    let childStatus;
    let changed = false;
    lockFs.mkdirSync = function (filename, ...args) {
        if (!changed && filename === lockPath) {
            changed = true;
            const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
                import { setConfigFilePath } from './src/util.js';
                setConfigFilePath(${JSON.stringify(fileURLToPath(new URL('../default/config.yaml', import.meta.url)))});
                const { updateJob, explicitRetryRecovery } = await import('./src/jobs/store.js');
                updateJob(${JSON.stringify(f.directories)}, ${JSON.stringify(f.context.job.id)}, job => ({ state: 'queued', ...explicitRetryRecovery(job) }));
            `], { cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 15000, encoding: 'utf8', windowsHide: true });
            childStatus = child.status;
            assert.equal(child.error, undefined);
            assert.equal(child.signal, null);
            assert.equal(child.status, 0, child.stderr);
        }
        return originalMkdir.call(this, filename, ...args);
    };
    const before = (await readMeowerStore(f.directories, f.owner)).receipts;
    try {
        await assert.rejects(acceptMeowerJob(f.request, { ...f.body, submissionKey: 'replacement', previousJobId: f.context.job.id }), /Jobs|recovery/i);
    } finally { lockFs.mkdirSync = originalMkdir; }
    assert.equal(changed, true, 'the production Jobs lock acquisition was intercepted');
    assert.equal(childStatus, 0, 'a real child performed the prior Jobs mutation');
    assert.equal(getJob(f.directories, f.context.job.id).state, 'queued');
    assert.deepEqual((await readMeowerStore(f.directories, f.owner)).receipts, before);
});

test('account reset retains Meower completion proof without retaining deleted feed content', async () => {
    const f = await fixture();
    let calls = 0;
    await createMeowerJobHandler({ generate: async () => { calls++; return { text: postText }; } })(f.context);
    const base = { owner: f.owner, directories: f.directories };
    resetRoleplayAccount(base, null, 'reset');
    assert.equal(fs.existsSync(path.join(f.directories.root, 'hopper')), false);
    const archive = path.join(roleplayStoreDirectory(base), 'meower-receipts');
    const saved = fs.readFileSync(path.join(archive, fs.readdirSync(archive)[0]), 'utf8');
    assert.equal(JSON.parse(saved).receipts[receiptKey(f.owner, f.body.submissionKey)].closed, true);
    assert.equal(saved.includes('Moon garden'), false, 'retained receipts do not keep the deleted post text');
    assert.equal(getJob(f.directories, f.context.job.id), null);
    await assert.rejects(acceptMeowerJob(f.request, f.body), /accepted before.*reset.*not be repeated/);
    assert.equal(calls, 1);
});

test('a delayed Meower writer cannot publish or remove a replacement lock after account reset', async () => {
    const f = await fixture();
    let release;
    let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const inside = new Promise(resolve => { entered = resolve; });
    const mutation = mutateMeowerStore(f.directories, f.owner, async store => {
        entered();
        await gate;
        store.settings.sessions.one.name = 'Old delayed edit';
    });
    const rejected = assert.rejects(mutation, /account or its saved data was replaced/i);
    await inside;
    resetRoleplayAccount({ owner: f.owner, directories: f.directories }, null, 'reset');
    const replacementLock = path.join(f.directories.root, 'hopper/store.lock');
    fs.mkdirSync(replacementLock, { recursive: true });
    fs.writeFileSync(path.join(replacementLock, 'owner.json'), 'replacement lock');
    release();
    await rejected;
    assert.equal(fs.readFileSync(path.join(replacementLock, 'owner.json'), 'utf8'), 'replacement lock');
    assert.equal(fs.existsSync(path.join(f.directories.root, 'hopper/store.json')), false);
});

test('an interrupted purge recovers from the durable Meower receipt checkpoint after the feed was removed', async () => {
    const f = await fixture();
    await createMeowerJobHandler({ generate: async () => ({ text: postText }) })(f.context);
    const base = { owner: f.owner, directories: f.directories };
    const remove = fs.rmSync;
    let interrupted = false;
    try {
        fs.rmSync = (filename, options) => {
            remove(filename, options);
            if (!interrupted && filename === path.join(f.directories.root, 'hopper')) {
                interrupted = true;
                throw new Error('Simulated stop after feed removal');
            }
        };
        assert.throws(() => resetRoleplayAccount(base, null, 'purge'), /Simulated stop/);
    } finally { fs.rmSync = remove; }
    assert.equal(settleRoleplayAccountReset(base), null);
    const archive = path.join(roleplayStoreDirectory(base), 'meower-receipts');
    const names = fs.readdirSync(archive);
    assert.equal(names.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(archive, names[0]), 'utf8')).receipts[receiptKey(f.owner, f.body.submissionKey)].closed, true);
});

test('damaged retired Meower evidence blocks a later reset before deleting replacement data', async () => {
    const f = await fixture();
    const base = { owner: f.owner, directories: f.directories };
    resetRoleplayAccount(base, null, 'reset');
    const archive = path.join(roleplayStoreDirectory(base), 'meower-receipts');
    const filename = path.join(archive, fs.readdirSync(archive)[0]);
    fs.writeFileSync(filename, '{damaged');
    const replacement = path.join(f.directories.root, 'replacement.txt');
    fs.writeFileSync(replacement, 'Keep this new data');
    assert.throws(() => resetRoleplayAccount(base, null, 'reset'), /Meower receipts are unreadable/);
    assert.equal(fs.readFileSync(replacement, 'utf8'), 'Keep this new data');
    assert.equal(fs.readFileSync(filename, 'utf8'), '{damaged');
});

test('native snapshots merge saved activity and profiles without discarding local edits', async () => {
    const f = await fixture();
    const { createStorageClient } = await import('../public/scripts/extensions/third-party/Neconyan-Hopper/src/storage-client.js');
    const pending = new Map();
    const client = createStorageClient({
        request: async method => {
            assert.equal(method, 'GET', 'observation must not write a stale store');
            return { ...(await readMeowerStore(f.directories, f.owner)).store, account: f.owner };
        },
        recovery: { list: async () => [], put: async entry => pending.set(entry.id, entry), remove: async entry => pending.delete(entry.id) },
        events: {},
    });
    try {
        await client.initialise();
        client.updateSettings({ ...client.settings, sessions: { ...client.settings.sessions,
            one: { ...client.settings.sessions.one, name: 'Unsaved name' } } });
        await createMeowerJobHandler({ generate: async () => ({ text: postText }) })(f.context);
        await mutateMeowerStore(f.directories, f.owner, store => { store.settings.profiles['character:nova.png'].bio = 'Saved bio'; });
        await client.syncStore();
        assert.equal(client.feed('one').posts[0].body, 'Moon garden');
        assert.equal(client.settings.profiles['character:nova.png'].bio, 'Saved bio');
        assert.equal(client.settings.sessions.one.name, 'Unsaved name');
        assert.ok(pending.size, 'the local edit keeps its recovery copy');
    } finally { await client.dispose(); }
});

test('a refresh saves exactly once and deleted posts stay deleted on replay', async () => {
    const f = await fixture();
    let calls = 0;
    const run = createMeowerJobHandler({ generate: async () => { calls++; return { text: postText }; } });
    const result = await run(f.context);
    assert.equal(result.posts, 1);
    assert.equal((await getFeed(f)).posts[0].body, 'Moon garden');
    assert.equal((await acceptMeowerJob(f.request, f.body)).job.id, f.context.job.id);
    await mutateMeowerStore(f.directories, f.owner, store => { store.feeds.one.posts = []; });
    await run(f.context);
    assert.equal(calls, 1);
    assert.equal((await getFeed(f)).posts.length, 0);
});

test('reset during the provider call preserves the replacement feed', async () => {
    const f = await fixture();
    const run = createMeowerJobHandler({ generate: async () => {
        await mutateMeowerStore(f.directories, f.owner, store => { store.feeds.one.epoch = 'replacement'; });
        return { text: postText };
    } });
    await assert.rejects(run(f.context), /deleted or reset/);
    assert.equal((await getFeed(f)).posts.length, 0);
    assert.ok(readArtifact(f.directories, f.context.job.id, 'wave:0:0:ready'));
});

test('a materialised response survives a crash before the store commit without another provider call', async () => {
    const f = await fixture();
    let calls = 0;
    const run = createMeowerJobHandler({ generate: async () => { calls++; return { text: postText }; } });
    await run(f.context);
    const ready = readArtifact(f.directories, f.context.job.id, 'wave:0:0:ready');
    await mutateMeowerStore(f.directories, f.owner, (store, receipts) => {
        store.feeds.one.posts = [];
        Object.values(receipts)[0].units = {};
        Object.values(receipts)[0].closed = false;
    });
    await run(f.context);
    assert.deepEqual((await getFeed(f)).posts, ready.posts);
    assert.equal(calls, 1);
});

test('unknown provider outcomes never dispatch again automatically', async () => {
    const f = await fixture();
    let calls = 0;
    const run = createMeowerJobHandler({ generate: options => providerStep(options.jobContext, options.stepNamespace, async () => {
        calls++;
        throw new Error('connection lost');
    }) });
    await assert.rejects(run(f.context), /connection lost/);
    await assert.rejects(run(f.context), /unknown.*automatically/);
    assert.equal(calls, 1);
    assert.equal(getJob(f.directories, f.context.job.id).recoverability, 'unknown-outcome');
});

test('images publish text on a definite failure but retain unknown outcomes for recovery', async () => {
    for (const unknown of [false, true]) {
        const f = await fixture('tester', { images: { enabled: true, perRefresh: 1 } });
        const run = createMeowerJobHandler({ generate: async () => ({ text: postText.replace('"imagePrompt":null', '"imagePrompt":"A moon garden"') }),
            image: async () => {
                if (unknown) markProviderUncertain(f.directories, f.context.job.id, { step: 'provider:image' });
                throw new Error('image failed');
            } });
        if (unknown) {
            await assert.rejects(run(f.context), /image failed/);
            assert.equal((await getFeed(f)).posts.length, 0);
        } else {
            await run(f.context);
            assert.equal((await getFeed(f)).posts[0].image, null);
            assert.match(readArtifact(f.directories, f.context.job.id, 'result').warnings.join(' '), /posted as text/);
        }
    }
});

test('profile edits win, while persona generation returns a draft without saving it', async () => {
    const f = await fixture();
    const runProfile = async (mode, generate) => {
        const accepted = await acceptMeowerJob(f.request, { sessionId: 'one', submissionKey: mode, mode, accountKey: 'character:nova.png' }, 'profile');
        return createMeowerJobHandler({ generate })({ ...f.context, job: accepted.job });
    };
    await assert.rejects(runProfile('character', async () => {
        await mutateMeowerStore(f.directories, f.owner, store => { store.settings.profiles['character:nova.png'].bio = 'My edit'; });
        return { text: JSON.stringify({ profiles: [{ entityId: 'nova.png', name: 'Nova', handle: 'nova2', bio: 'Generated', location: 'Moon' }] }) };
    }), /profiles changed/);
    const draft = await runProfile('persona', async () => ({ text: JSON.stringify({ profiles: [{ entityId: 'user.png', name: 'User', handle: 'botanist', bio: 'Draft', location: 'Home' }] }) }));
    assert.equal(draft.profile.bio, 'Draft');
    const { store } = await readMeowerStore(f.directories, f.owner);
    assert.equal(store.settings.profiles['character:nova.png'].bio, 'My edit');
    assert.notEqual(store.settings.sessions.one.personaProfile?.bio, 'Draft');
});

test('paused acceptance restores its plan and receipt after an acceptance crash', async () => {
    const f = await fixture();
    const plan = readArtifact(f.directories, f.context.job.id, 'plan');
    await mutateMeowerStore(f.directories, f.owner, (_store, receipts) => { for (const key of Object.keys(receipts)) delete receipts[key]; });
    updateJob(f.directories, f.context.job.id, { state: 'waiting', stage: 'preparing' });
    writeArtifact(f.directories, f.context.job.id, 'plan', null);
    await finalizeMeowerSubmission({ ...f.context, job: getJob(f.directories, f.context.job.id) });
    assert.deepEqual(readArtifact(f.directories, f.context.job.id, 'plan'), plan);
    assert.equal(getJob(f.directories, f.context.job.id).state, 'queued');
    assert.equal(Object.keys((await readMeowerStore(f.directories, f.owner)).receipts).length, 1);
});

test('account ownership and connection errors are checked before admission', async () => {
    const f = await fixture();
    await assert.rejects(readMeowerStore(f.directories, 'another'), /account/);
    await mutateMeowerStore(f.directories, f.owner, store => { store.settings.profileId = 'deleted'; });
    await assert.rejects(acceptMeowerJob(f.request, { ...f.body, submissionKey: 'new' }), /selected connection profile is unavailable/);
    await assert.rejects(acceptMeowerJob(f.request, { ...f.body, topic: 'another' }), /submission key/);
    assert.equal((await acceptMeowerJob(f.request, f.body)).job.id, f.context.job.id);
});

test('the accepted macro context contains character and persona descriptions', async () => {
    const f = await fixture();
    const plan = readArtifact(f.directories, f.context.job.id, 'plan');
    const environment = createMacroEnvironment(meowerMacros(plan));
    assert.equal(environment.evaluate('{{char}}'), 'Nova');
    assert.equal(environment.evaluate('{{description}}'), 'A friendly astronaut.');
    assert.match(environment.evaluate('{{persona}}'), /A botanist\./);
    assert.match(environment.evaluate('{{persona}}'), /Growing roses\./);
});

test('permanent receipt capacity refuses admission and retains existing evidence', async () => {
    const f = await fixture();
    await mutateMeowerStore(f.directories, f.owner, (_store, receipts) => {
        for (let i = 0; i < 15; i++) receipts[receiptKey(f.owner, `reserved-${i}`)] = { version: 1, jobId: `reserved-${i}`, units: {}, closed: false };
    });
    const before = (await readMeowerStore(f.directories, f.owner)).receipts;
    assert.equal(checkMeowerReceipts(before).reserved, 16 * RECEIPT_LIMIT);
    await assert.rejects(acceptMeowerJob(f.request, { ...f.body, submissionKey: 'overflow' }), /no room.*receipt/);
    assert.deepEqual((await readMeowerStore(f.directories, f.owner)).receipts, before);
});

test('successful concurrent activity commits beside an unknown sibling without repeating either', async () => {
    const f = await fixture('tester', { concurrency: 2, quotas: { posts: 2, replies: 0, reposts: 0, likes: 0 } });
    let entered = 0;
    let release;
    const both = new Promise(resolve => { release = resolve; });
    const run = createMeowerJobHandler({ generate: options => providerStep(options.jobContext, options.stepNamespace, async () => {
        entered++;
        const first = entered === 1;
        if (entered === 2) release();
        await both;
        if (first) throw new Error('unknown first request');
        return { text: postText };
    }) });
    await assert.rejects(run(f.context), /unknown first request/);
    assert.equal((await getFeed(f)).posts.length, 1);
    await assert.rejects(run(f.context), /unknown.*automatically/);
    assert.equal(entered, 2);
    assert.equal((await getFeed(f)).posts.length, 1);
    updateJob(f.directories, f.context.job.id, { state: 'failed' });
    await assert.rejects(acceptMeowerJob(f.request, { ...f.body, submissionKey: 'unsafe-replacement', previousJobId: f.context.job.id }), /Jobs|recovery/i);
    assert.equal((await getFeed(f)).posts.length, 1);
});

test('nonincremental malformed output fails after one known correction attempt', async () => {
    const f = await fixture('tester', { incremental: false });
    let calls = 0;
    const run = createMeowerJobHandler({ generate: async () => { calls++; return { text: 'not JSON' }; } });
    await assert.rejects(run(f.context), /correction attempt/);
    assert.equal(calls, 2);
    assert.equal((await getFeed(f)).posts.length, 0);
});

test('an image file failure retains the generated activity for recovery', async () => {
    const f = await fixture('tester', { images: { enabled: true, perRefresh: 1 } });
    const run = createMeowerJobHandler({ generate: async () => ({ text: postText.replace('"imagePrompt":null', '"imagePrompt":"A moon garden"') }),
        image: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } });
    await assert.rejects(run(f.context), /disk full/);
    assert.equal((await getFeed(f)).posts.length, 0);
    assert.ok(readArtifact(f.directories, f.context.job.id, 'wave:0:0:materialized'));
});

test('permanent acceptance survives deletion of retained jobs and artifacts', async () => {
    const f = await fixture();
    await createMeowerJobHandler({ generate: async () => ({ text: postText }) })(f.context);
    await mutateMeowerStore(f.directories, f.owner, store => { store.feeds.one.posts = []; });
    fs.rmSync(path.join(f.directories.root, 'jobs', 'index.json'));
    fs.rmSync(path.join(f.directories.root, 'jobs', 'artifacts'), { recursive: true });
    await assert.rejects(acceptMeowerJob(f.request, f.body), /already accepted.*will not be repeated/);
    assert.equal((await getFeed(f)).posts.length, 0);
    assert.equal(Object.keys((await readMeowerStore(f.directories, f.owner)).receipts).length, 1);
});

test('identical session and submission keys remain isolated between accounts', async () => {
    const alice = await fixture('alice');
    const bob = await fixture('bob');
    await createMeowerJobHandler({ generate: async () => ({ text: postText }) })(alice.context);
    assert.equal((await getFeed(alice)).posts.length, 1);
    assert.equal((await getFeed(bob)).posts.length, 0);
    assert.notEqual(alice.context.job.id, bob.context.job.id);
    await assert.rejects(acceptMeowerJob({ ...bob.request, get: () => 'alice' }, bob.body), /signed-in account changed/);
});

test('a deleted reaction target stays deleted while unrelated concurrent activity survives', async () => {
    const f = await fixture();
    await createMeowerJobHandler({ generate: async () => ({ text: postText }) })(f.context);
    const target = (await getFeed(f)).posts[0];
    await mutateMeowerStore(f.directories, f.owner, store => {
        store.settings.quotas = { posts: 0, replies: 1, reposts: 0, likes: 0 };
    });
    const accepted = await acceptMeowerJob(f.request, { ...f.body, submissionKey: 'reply' });
    await createMeowerJobHandler({ generate: async () => {
        await mutateMeowerStore(f.directories, f.owner, store => {
            store.feeds.one.posts = [{ ...target, id: 'unrelated', body: 'A concurrent manual post' }];
        });
        return { text: JSON.stringify({ posts: [], interactions: [{ type: 'reply', actorHandle: 'nova', targetPostId: target.id,
            targetTempId: null, parentInteractionId: null, content: 'Reply to a deleted post' }], follows: [], strangers: [], trends: [] }) };
    } })({ ...f.context, job: accepted.job });
    const feed = await getFeed(f);
    assert.deepEqual(feed.posts.map(post => post.id), ['unrelated']);
    assert.equal(feed.interactions.length, 0);
    assert.match(readArtifact(f.directories, accepted.job.id, 'result').warnings.join(' '), /target changed/);
});
