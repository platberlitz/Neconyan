import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { prepareConversationTarget, readConversationTarget, appendConversationJobMessage } = await import('../src/generation/conversation-effects.js');
const { saveConversationStore } = await import('../src/endpoints/conversation-store.js');
const { acceptJob, acceptChildJobs, updateJob } = await import('../src/jobs/store.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function setup(t) {
    const f = fixture(t);
    t.after(() => cancelAutoSaves());
    const directories = f.scope.directories;
    const owner = f.scope.owner;
    const request = { user: { directories, profile: { handle: owner } } };
    const target = { avatar: 'Nova.png', branchId: 'main' };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({ _version: 0, extension_settings: {
        neconyan_conversation: { version: 1, settings: {}, groups: [], reminders: [], characters: {
            'Nova.png': { activeBranchId: 'main', branches: { main: { id: 'main', createdAt: 1, messages: [] } } },
        } },
    } }));
    let sequence = 0;
    const append = async (state = 'completed', { child = false } = {}) => {
        const captured = await prepareConversationTarget(request, target);
        const { job: root } = acceptJob(directories, { owner, type: 'conversation.reply', submissionKey: `receipt:${sequence++}`, intent: { target: captured } });
        const job = child ? acceptChildJobs(directories, root.id, [{ participantKey: 'speaker', intent: {} }])[0] : root;
        const context = { owner, directories, job };
        const value = { role: 'character', name: 'Nova', mes: `Reply ${sequence}` };
        const replay = () => appendConversationJobMessage(context, captured, 'reply', value);
        const result = await replay();
        updateJob(directories, job.id, { state, finishedAt: Date.now() });
        if (child) updateJob(directories, root.id, { state: 'completed', finishedAt: Date.now() });
        return { root, job, key: digest(root.id), result, replay };
    };
    return { directories, request, target, append, read: () => readConversationTarget(request, target) };
}

test('a branch keeps at most 100 reply receipts', async t => {
    const f = setup(t);
    const replies = [];
    for (let index = 0; index < 150; index++) replies.push(await f.append());
    const { branch } = f.read();
    assert.equal(branch.messages.length, 150);
    assert.equal(Object.keys(branch.serverOperations).length, 100);
    for (const [index, reply] of replies.entries()) {
        assert.equal(Object.hasOwn(branch.serverOperations, reply.key), index >= 50);
        if (index >= 50) assert.ok(Number.isSafeInteger(branch.serverOperations[reply.key].at));
    }
    assert.deepEqual(await replies.at(-1).replay(), replies.at(-1).result);
    assert.equal(f.read().branch.messages.length, 150);
});

test('the receipt of an unfinished reply is never pruned', async t => {
    const f = setup(t);
    const unfinished = [];
    for (const state of ['queued', 'running', 'waiting', 'failed', 'interrupted']) unfinished.push(await f.append(state));
    const child = await f.append('failed', { child: true });
    unfinished.push(child);
    updateJob(f.directories, child.job.id, { dismissed: true });
    const legacy = await f.append();
    const current = f.read();
    for (const receipt of Object.values(current.branch.serverOperations)) delete receipt.at;
    assert.equal((await saveConversationStore(f.request, current.store, current.version, { trustedConversationEffects: true })).ok, true);
    for (let index = 0; index < 150; index++) await f.append();
    const { branch } = f.read();
    assert.equal(Object.keys(branch.serverOperations).length, 100);
    assert.equal(Object.hasOwn(branch.serverOperations, legacy.key), false, 'a finished legacy receipt is oldest');
    for (const reply of unfinished) {
        assert.ok(branch.serverOperations[reply.key], 'unfinished, retryable and child receipts stay protected, even without a timestamp');
        updateJob(f.directories, reply.job.id, { state: 'queued', dismissed: false });
        assert.deepEqual(await reply.replay(), reply.result);
    }
    assert.equal(f.read().branch.messages.length, 157, 'retrying every protected reply appends nothing');
});

test('protected receipts may exceed the cap until their replies finish', async t => {
    const f = setup(t);
    const replies = [];
    for (let index = 0; index < 105; index++) replies.push(await f.append('waiting'));
    assert.equal(Object.keys(f.read().branch.serverOperations).length, 105);
    for (const reply of replies.slice(0, 6)) updateJob(f.directories, reply.job.id, { state: 'completed' });
    const current = await f.append();
    const { branch } = f.read();
    assert.equal(Object.keys(branch.serverOperations).length, 100);
    assert.ok(branch.serverOperations[current.key]);
    for (const reply of replies.slice(6)) assert.ok(branch.serverOperations[reply.key]);
});
