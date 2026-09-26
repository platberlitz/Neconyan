import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { acceptMeowerJob, createMeowerJobHandler, finalizeMeowerSubmission } = await import('../src/generation/meower-jobs.js');
const { readMeowerStore, mutateMeowerStore } = await import('../public/scripts/extensions/third-party/Neconyan-Hopper/server/index.js');
const { normalizeSettings, normalizeSession } = await import('../public/scripts/extensions/third-party/Neconyan-Hopper/src/core.js');
const { readArtifact, writeArtifact, providerStep } = await import('../src/jobs/artifacts.js');
const { getJob, updateJob, markProviderUncertain } = await import('../src/jobs/store.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { write: writeCard } = await import('../src/character-card-parser.js');
const { initialiseRoleplayAccount } = await import('../src/roleplay-store.js');
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
    await mutateMeowerStore(directories, owner, store => {
        store.settings = normalizeSettings({ profileId: 'saved', profiles: { 'character:nova.png': { name: 'Nova', handle: 'nova', bio: 'Space', location: 'Moon' } },
            incremental: true, quotas: { posts: 1, replies: 0, reposts: 0, likes: 0 }, ...options });
        store.settings.sessions.one = normalizeSession({ id: 'one', invited: ['nova.png'], personaId: 'user.png', scenarioNoteIds: ['note'], ambient: false }, 'one');
        store.feeds.one = { version: 1, epoch: 'original', posts: [], interactions: [] };
    });
    const request = { user: { profile: { handle: owner }, directories } };
    initialiseRoleplayAccount({ owner, directories });
    const body = { sessionId: 'one', submissionKey: 'submit-1' };
    const accepted = await acceptMeowerJob(request, body);
    const context = { owner, directories, job: accepted.job, signal: new AbortController().signal,
        progress: async patch => updateJob(directories, accepted.job.id, { progress: patch }) };
    return { owner, directories, request, body, context };
}

const postText = JSON.stringify({ posts: [{ authorHandle: 'nova', tempId: 'post1', content: 'Moon garden', imagePrompt: null }], interactions: [], follows: [], strangers: [], trends: [] });
const getFeed = async fixture => (await readMeowerStore(fixture.directories, fixture.owner)).store.feeds.one;

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
