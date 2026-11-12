import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const store = await import('../src/scratchpad/store.js');
const { acceptScratchpadReply, registerScratchpadJobs, normaliseReplyRequest } = await import('../src/scratchpad/jobs.js');
const { getJob } = await import('../src/jobs/store.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');
const { setDirectoriesResolver, testExports: { runJob } } = await import('../src/jobs/runner.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { REHEARSAL_REQUEST } = await import('../public/scripts/scratchpad/rehearsal.js');
const { exportReply, replySwipes } = await import('../public/scripts/scratchpad/swipes.js');
const { captureReplyNotebookProposalsLocked } = await import('../src/scratchpad/notebooks.js');
after(() => cancelAutoSaves());

let counter = 0;
function account(t, kind = 'roleplay') {
    const f = fixture(t, false, 'scratch-rehearsal');
    const directories = f.scope.directories;
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({
        _version: 0, extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] } },
        oai_settings: { chat_completion_source: 'openai' },
    }));
    const source = { kind, key: kind === 'roleplay' ? 'character:Nova.png:Source' : 'conversation:test' };
    const request = body => ({ user: { profile: { handle: f.scope.owner }, directories }, get: () => undefined, body });
    const base = store.scratchpadAccountBase(request({}));
    const session = store.mutateBucket(base, source, bucket => store.createSession(bucket, {
        pinnedNote: 'Keep the key secret.', settings: { connection: { kind: 'profile', profileId: 'saved' } },
    }));
    const read = () => store.withScratchpad(base, lease => store.findSession(store.readBucketLocked(lease, source), session.id));
    const accept = extra => {
        const body = { source, sessionId: session.id, submissionKey: `rehearsal-${++counter}`, rehearsal: true, text: '',
            context: 'SHARED-STORY: Nova waits by the ferry.', names: { user: 'Me', character: 'Nova' }, ...extra };
        return acceptScratchpadReply(request(body), body);
    };
    setDirectoriesResolver(() => directories);
    return { f, directories, source, base, session, read, accept };
}

for (const kind of ['roleplay', 'conversation']) {
    test(`${kind} rehearsal is a tool-free draft and retries keep its mode without changing the story`, async t => {
        const a = account(t, kind);
        const original = fs.readFileSync(a.f.filename);
        const calls = [];
        const reply = 'Nova raises a hand.\n```scratchpad-change\n{"type":"authors-note","action":"replace","value":"Wrong"}\n```';
        registerScratchpadJobs({ generate: async options => { calls.push(options); return { text: reply }; } });
        const accepted = await a.accept();
        const prepared = readArtifact(a.directories, accepted.job.id, 'request');
        assert.equal(prepared.rehearsal, true);
        assert.deepEqual(prepared.functionTools, []);
        await runJob(getJob(a.directories, accepted.job.id));
        assert.equal(getJob(a.directories, accepted.job.id).state, 'completed');
        assert.equal(a.read().messages[0].text, REHEARSAL_REQUEST);
        assert.ok(a.read().messages.every(message => message.rehearsal));
        assert.match(calls[0].messages[0].content, /rehearsal/i);
        assert.ok(calls[0].messages.some(message => String(message.content).includes('SHARED-STORY')));
        assert.ok(calls[0].messages.some(message => String(message.content).includes('Keep the key secret.')));
        assert.ok(!calls[0].messages[0].content.includes('scratchpad-change'));
        const first = a.read().messages.at(-1);
        const retry = await a.accept({ regenerate: first.id, rehearsal: false });
        await runJob(getJob(a.directories, retry.job.id));
        assert.equal(a.read().messages.length, 2);
        assert.ok(replySwipes(a.read().messages.at(-1)).every(message => message.rehearsal));
        assert.deepEqual(calls[1].functionTools, []);
        assert.match(calls[1].messages[0].content, /rehearsal/i);
        assert.deepEqual(fs.readFileSync(a.f.filename), original);
        const exported = exportReply(a.read().messages.at(-1));
        assert.equal(exported.rehearsal, true);
        assert.ok(exported.swipes.every(message => message.rehearsal));
        store.withScratchpad(a.base, lease => {
            const bucket = store.readBucketLocked(lease, a.source);
            assert.deepEqual(captureReplyNotebookProposalsLocked(lease, bucket, store.findSession(bucket, a.session.id), first), []);
        });
        const replyId = a.read().messages.at(-1).id;
        const branch = store.mutateBucket(a.base, a.source, bucket => store.branchSession(bucket, a.session.id, replyId));
        assert.ok(branch.session.messages.every(message => message.rehearsal));
        const ordinary = await a.accept({ rehearsal: false, text: 'Discuss the draft.' });
        await runJob(getJob(a.directories, ordinary.job.id));
        assert.ok(calls.at(-1).messages.some(message => String(message.content).includes('Rehearsal only, not an event')));
        assert.equal(a.read().messages.at(-1).rehearsal, undefined);
    });
}

test('rehearsal rejects non-story sources and discussion mode, and directions stay intact', () => {
    const input = { source: { kind: 'general', key: 'general' }, sessionId: 'a'.repeat(24), submissionKey: 'one', rehearsal: true, text: '' };
    assert.throws(() => normaliseReplyRequest(input), { code: 'SCRATCHPAD_REHEARSAL_INVALID' });
    const story = { ...input, source: { kind: 'roleplay', key: 'character:Nova.png:Source' } };
    assert.throws(() => normaliseReplyRequest({ ...story, discuss: true }), { code: 'SCRATCHPAD_REHEARSAL_INVALID' });
    assert.equal(normaliseReplyRequest({ ...story, text: 'Make it quieter.' }).text, 'Make it quieter.');
});
