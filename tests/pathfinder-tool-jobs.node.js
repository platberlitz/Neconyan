/* eslint playwright/expect-expect: off -- Native tool transactions use Node assertions. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { fixture } from './roleplay-transactions-fixture.js';

const { capturePathfinderToolRequest, admitPathfinderToolJob, runPathfinderToolJob } = await import('../src/generation/pathfinder-tool-jobs.js');
const { decideJobApproval, readJobApproval } = await import('../src/generation/job-approvals.js');
const { releaseJob, getJob } = await import('../src/jobs/store.js');
const { readRoleplayFile, roleplayHash } = await import('../src/roleplay-store.js');
const { readRoleplayChat } = await import('../src/generation/roleplay-source.js');
const { pathfinderTreeForBook } = await import('../src/generation/pathfinder-retrieval.js');
const { router: worldInfoRouter } = await import('../src/endpoints/worldinfo.js');

function prepared(t, { confirm = false, permissions = {}, sidecarEnabled = true } = {}) {
    const f = fixture(t);
    const directories = f.scope.directories;
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    directories.worlds = path.join(directories.root, 'worlds');
    directories.inChatAgents = path.join(directories.root, 'InChatAgents');
    fs.mkdirSync(directories.worlds);
    fs.mkdirSync(directories.inChatAgents);
    const bookFile = path.join(directories.worlds, 'Manual.json');
    fs.writeFileSync(bookFile, JSON.stringify({ entries: { 12: { uid: 12, comment: 'Location: Observatory',
        key: ['telescope'], content: 'The old telescope is broken.' } }, originalData: { entries: [], extensions: {} }, originalDataUidMap: {} }));
    const agentFile = path.join(directories.inChatAgents, 'pathfinder.json');
    fs.writeFileSync(agentFile, JSON.stringify({ id: 'pathfinder', category: 'tool', name: 'Pathfinder', enabled: true,
        sourceTemplateId: 'tpl-pathfinder', settings: { sidecarEnabled, pipelineEnabled: false, enabledLorebooks: ['Manual'],
            includeContextualLorebooks: false, bookPermissions: { Manual: permissions },
            confirmTools: { Pathfinder_Remember: confirm, Pathfinder_Update: confirm, Pathfinder_Forget: confirm } } }));
    const settingsFile = path.join(directories.root, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ extension_settings: { inChatAgents: { globalSettings: { enabled: true } } } }));
    const source = f.source();
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const capture = (name, args, callId = 'model-tool-1') => capturePathfinderToolRequest(f.scope, account, source,
        { avatar: 'Nova.png', agentId: 'pathfinder', name, args, callId });
    const admit = (request, operationKey = 'tool-1') => {
        const { jobId } = admitPathfinderToolJob(f.scope, account, { operationKey, source, request });
        releaseJob(directories, jobId);
        return { jobId, context: () => ({ owner: f.scope.owner, directories, job: getJob(directories, jobId),
            signal: new AbortController().signal }) };
    };
    return { f, directories, account, source, bookFile, agentFile, settingsFile, capture, admit };
}

test('a read-only Pathfinder search is bound to the exact allowed saved book and leaves chat untouched', async t => {
    const f = prepared(t);
    const request = f.capture('Pathfinder_Search', { book: 'Manual' });
    const { context } = f.admit(request);
    const result = await runPathfinderToolJob(context());
    assert.equal(result.result.status, 'done');
    assert.equal(result.result.result.bookName, 'Manual');
    assert.equal(result.result.result.children.length > 0, true);
    assert.equal(readRoleplayChat(f.f.scope, f.f.locator).records.at(-1).mes, 'Answer');
    assert.deepEqual((await runPathfinderToolJob(context())).result, result.result);
});

test('a model confirmation flag cannot authorise Remember; an exact saved owner decision can', async t => {
    const f = prepared(t, { confirm: true });
    const request = f.capture('Pathfinder_Remember', { book: 'Manual', title: 'West tower',
        content: 'Its telescope has been repaired.', userConfirmed: true });
    assert.equal(JSON.stringify(request).includes('private-key'), false);
    const { context, jobId } = f.admit(request);
    const waiting = await runPathfinderToolJob(context());
    assert.equal(waiting.waiting, true);
    assert.equal(getJob(f.directories, jobId).state, 'waiting');
    assert.equal(fs.existsSync(f.bookFile), true);
    assert.equal(JSON.parse(fs.readFileSync(f.bookFile, 'utf8')).entries[0], undefined);
    const approval = readJobApproval(context(), waiting.approval.id);
    assert.equal(approval.proposal.book, 'Manual');
    assert.equal(approval.proposal.after.title, 'West tower');
    assert.throws(() => decideJobApproval(context(), { id: waiting.approval.id, proposalHash: 'wrong', decision: 'allow' }),
        { code: 'JOB_APPROVAL_CHANGED' });
    decideJobApproval(context(), { id: waiting.approval.id, proposalHash: approval.proposalHash, decision: 'allow' });
    const done = await runPathfinderToolJob(context());
    assert.equal(done.result.status, 'done');
    assert.equal(JSON.parse(fs.readFileSync(f.bookFile, 'utf8')).entries[0].comment, 'West tower');
    const evidence = readRoleplayFile(f.bookFile, 8 * 1024 * 1024);
    assert.deepEqual((await runPathfinderToolJob(context())).result, done.result);
    assert.deepEqual(readRoleplayFile(f.bookFile, 8 * 1024 * 1024).physical, evidence.physical);
    assert.equal(readRoleplayChat(f.f.scope, f.f.locator).records.at(-1).mes, 'Answer');
});

test('prepared authoring evidence recovers after the file rename without duplicating a lorebook entry', async t => {
    const f = prepared(t);
    const request = f.capture('Pathfinder_Remember', { title: 'Eastern hall', content: 'Still quiet.', book: 'Manual' });
    const { context } = f.admit(request);
    let calls = 0;
    await assert.rejects(runPathfinderToolJob(context(), { beforePublish: () => { calls++; throw new Error('stop before book rename'); } }),
        /stop before book rename/);
    assert.equal(calls, 1);
    assert.equal(Object.values(JSON.parse(fs.readFileSync(f.bookFile, 'utf8')).entries).length, 1);
    const done = await runPathfinderToolJob(context());
    assert.equal(done.result.status, 'done');
    assert.equal(Object.values(JSON.parse(fs.readFileSync(f.bookFile, 'utf8')).entries).length, 2);
    assert.equal(calls, 1);
});

test('an exact physical lorebook replacement or permission change refuses before mutation', async t => {
    const stale = prepared(t);
    const request = stale.capture('Pathfinder_Update', { book: 'Manual', uid: 12, title: 'Changed' });
    const { context } = stale.admit(request);
    const bytes = fs.readFileSync(stale.bookFile);
    fs.unlinkSync(stale.bookFile);
    fs.writeFileSync(stale.bookFile, bytes);
    await assert.rejects(runPathfinderToolJob(context()), { code: 'PATHFINDER_TOOL_SOURCE_CHANGED' });

    const permission = prepared(t);
    const waitingRequest = permission.capture('Pathfinder_Remember', { title: 'North', content: 'Cold.', book: 'Manual' });
    const admitted = permission.admit(waitingRequest);
    const settings = JSON.parse(fs.readFileSync(permission.agentFile, 'utf8'));
    settings.settings.bookPermissions.Manual.write = 'none';
    fs.writeFileSync(permission.agentFile, JSON.stringify(settings));
    await assert.rejects(runPathfinderToolJob(admitted.context()), { code: 'PATHFINDER_TOOL_SOURCE_CHANGED' });
});

test('an actual denied review closes without changing the book', async t => {
    const f = prepared(t, { confirm: true });
    const request = f.capture('Pathfinder_Forget', { book: 'Manual', uid: 12 });
    const { context } = f.admit(request);
    const waiting = await runPathfinderToolJob(context());
    const before = readRoleplayFile(f.bookFile, 8 * 1024 * 1024);
    decideJobApproval(context(), { id: waiting.approval.id, proposalHash: waiting.approval.proposalHash, decision: 'deny' });
    const result = await runPathfinderToolJob(context());
    assert.equal(result.result.status, 'denied');
    assert.deepEqual(readRoleplayFile(f.bookFile, 8 * 1024 * 1024).physical, before.physical);
});

test('ordinary lorebook authoring cannot overwrite an accepted Pathfinder target while its approval is pending', async t => {
    const f = prepared(t, { confirm: true });
    const request = f.capture('Pathfinder_Remember', { title: 'Pending', content: 'Wait.', book: 'Manual' });
    const { context } = f.admit(request);
    const waiting = await runPathfinderToolJob(context());
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { directories: f.directories, profile: { handle: f.f.scope.owner } };
        next();
    });
    app.use('/api/worldinfo', worldInfoRouter);
    const server = await new Promise(resolve => {
        const opened = app.listen(0, '127.0.0.1', () => resolve(opened));
    });
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const url = `http://127.0.0.1:${server.address().port}/api/worldinfo/edit`;
    const body = JSON.stringify({ name: 'Manual', data: { entries: {} } });
    const blocked = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body });
    assert.equal(blocked.status, 409);
    assert.equal(Object.values(JSON.parse(fs.readFileSync(f.bookFile, 'utf8')).entries).length, 1);
    decideJobApproval(context(), { id: waiting.approval.id, proposalHash: waiting.approval.proposalHash, decision: 'deny' });
    await runPathfinderToolJob(context());
    const released = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body });
    assert.equal(released.status, 200);
});

test('a full Pathfinder search that cannot fit its permanent result refuses before admission', t => {
    const f = prepared(t);
    const book = JSON.parse(fs.readFileSync(f.bookFile, 'utf8'));
    book.entries[12].content = 'telescope'.repeat(17_000);
    fs.writeFileSync(f.bookFile, JSON.stringify(book));
    const node = pathfinderTreeForBook('Manual', book, roleplayHash(book)).children.find(child => child.entries.includes(12));
    assert.ok(node);
    assert.throws(() => f.capture('Pathfinder_Search', { book: 'Manual', node_id: node.id }),
        { code: 'PATHFINDER_TOOL_CAPACITY' });
    assert.equal(Object.values(book.entries).length, 1);
    assert.equal(readRoleplayChat(f.f.scope, f.f.locator).records.at(-1).mes, 'Answer');
});
