/* eslint playwright/expect-expect: off -- These native jobs use Node assertions. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { capturePathfinderNotebookRequest, admitPathfinderNotebookJob, runPathfinderNotebookJob } = await import('../src/generation/pathfinder-notebook-jobs.js');
const { preparePathfinderNotebookAction } = await import('../src/generation/pathfinder-notebook.js');
const { getJob, releaseJob } = await import('../src/jobs/store.js');
const { readRoleplayChat } = await import('../src/generation/roleplay-source.js');
const { readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');

function prepared(t, { books = true } = {}) {
    const f = fixture(t);
    const directories = f.scope.directories;
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(row => JSON.stringify(row)).join('\n'));
    directories.worlds = path.join(directories.root, 'worlds');
    directories.inChatAgents = path.join(directories.root, 'InChatAgents');
    fs.mkdirSync(directories.worlds);
    fs.mkdirSync(directories.inChatAgents);
    if (books) fs.writeFileSync(path.join(directories.worlds, 'Manual.json'), JSON.stringify({ entries: {} }));
    const agentFile = path.join(directories.inChatAgents, 'pathfinder.json');
    fs.writeFileSync(agentFile, JSON.stringify({ id: 'pathfinder', name: 'Pathfinder', category: 'tool', enabled: true,
        sourceTemplateId: 'tpl-pathfinder', settings: { sidecarEnabled: true, pipelineEnabled: false,
            enabledLorebooks: books ? ['Manual'] : [], includeContextualLorebooks: false } }));
    const settingsFile = path.join(directories.root, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ extension_settings: { inChatAgents: { globalSettings: { enabled: true } } } }));
    const source = f.source();
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const capture = (args, callId = 'notebook-call') => capturePathfinderNotebookRequest(f.scope, account, source,
        { avatar: 'Nova.png', agentId: 'pathfinder', args, callId });
    const admit = (request, operationKey = 'notebook-operation') => {
        const { jobId } = admitPathfinderNotebookJob(f.scope, account, { operationKey, source, request });
        releaseJob(directories, jobId);
        return { jobId, context: () => ({ directories, owner: f.scope.owner, job: getJob(directories, jobId),
            signal: new AbortController().signal }) };
    };
    return { f, source, account, directories, settingsFile, agentFile, capture, admit };
}

test('read-only notebooks keep saved chat and swipes unchanged, including when no lorebook is enabled', async t => {
    const f = prepared(t, { books: false });
    const request = f.capture({ action: 'read' });
    const { context } = f.admit(request);
    const result = await runPathfinderNotebookJob(context());
    assert.equal(result.result.tool, 'Pathfinder_Notebook');
    assert.equal(result.result.result, '📓 Notebook is empty. Use "write" to add entries.');
    assert.deepEqual(readRoleplayChat(f.f.scope, f.f.locator).records.slice(1), f.f.records.slice(1));
    assert.deepEqual((await runPathfinderNotebookJob(context())).result, result.result);
    assert.throws(() => f.capture({ action: 'write', key: 'Tower', content: 'Repaired' }),
        { code: 'PATHFINDER_NOTEBOOK_SOURCE_CHANGED' });
});

test('an owned notebook write changes only metadata and completes exactly once after an interrupted delivery', async t => {
    const f = prepared(t);
    const request = f.capture({ action: 'write', key: 'Tower', content: 'The old telescope is repaired.' });
    const { context } = f.admit(request);
    await assert.rejects(runPathfinderNotebookJob(context(), { beforeCompletion: () => { throw new Error('stop before chat write'); } }),
        /stop before chat write/);
    assert.deepEqual(readRoleplayChat(f.f.scope, f.f.locator).records[0].chat_metadata, {});
    const saved = readArtifact(f.directories, context().job.id, 'pathfinder-notebook-output');
    assert.equal(saved.result, '📓 Wrote "Tower" to notebook.');
    const finished = await runPathfinderNotebookJob(context());
    assert.equal(finished.result.result, saved.result);
    const records = readRoleplayChat(f.f.scope, f.f.locator).records;
    assert.deepEqual(records.slice(1), f.f.records.slice(1));
    assert.equal(records[0].chat_metadata.pathfinder_notebook.entries[0].key, 'Tower');
    assert.equal(records[0].chat_metadata.pathfinder_notebook.entries[0].content, 'The old telescope is repaired.');
    assert.deepEqual((await runPathfinderNotebookJob(context())).result, finished.result);
});

test('a missing notebook key is a durable known no-op; a changed chat or agent refuses before mutation', async t => {
    const f = prepared(t);
    const noop = f.capture({ action: 'delete', key: 'Missing' });
    assert.equal(noop.mutating, false);
    const { context } = f.admit(noop);
    assert.match((await runPathfinderNotebookJob(context())).result.result, /No notebook entry/);
    assert.deepEqual(readRoleplayChat(f.f.scope, f.f.locator).records[0].chat_metadata, {});
    const stale = prepared(t);
    const request = stale.capture({ action: 'write', key: 'Tower', content: 'Repaired' });
    const pending = stale.admit(request);
    const raw = fs.readFileSync(stale.f.filename);
    fs.unlinkSync(stale.f.filename);
    fs.writeFileSync(stale.f.filename, raw);
    await assert.rejects(runPathfinderNotebookJob(pending.context()), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    const blocked = prepared(t);
    const selected = blocked.capture({ action: 'write', key: 'Tower', content: 'Repaired' });
    const job = blocked.admit(selected);
    const agent = JSON.parse(fs.readFileSync(blocked.agentFile, 'utf8'));
    agent.settings.sidecarEnabled = false;
    fs.writeFileSync(blocked.agentFile, JSON.stringify(agent));
    await assert.rejects(runPathfinderNotebookJob(job.context()), { code: 'PATHFINDER_NOTEBOOK_SOURCE_CHANGED' });
});

test('a damaged saved notebook proof cannot be used to rewrite a chat or replay a different action', async t => {
    const f = prepared(t);
    const request = f.capture({ action: 'write', key: 'Tower', content: 'Repaired' });
    const { context, jobId } = f.admit(request);
    await assert.rejects(runPathfinderNotebookJob(context(), { beforeCompletion: () => { throw new Error('stop'); } }), /stop/);
    const stored = readArtifact(f.directories, jobId, 'pathfinder-notebook-output');
    writeArtifact(f.directories, jobId, 'pathfinder-notebook-output', { ...stored, afterHash: '0'.repeat(64) });
    await assert.rejects(runPathfinderNotebookJob(context()), { code: 'PATHFINDER_NOTEBOOK_SOURCE_CHANGED' });
    assert.deepEqual(readRoleplayChat(f.f.scope, f.f.locator).records[0].chat_metadata, {});
    assert.throws(() => preparePathfinderNotebookAction(f.f.records, { action: 'write', key: ' ', content: 'x', updatedAt: 1 }),
        { code: 'PATHFINDER_NOTEBOOK_INVALID' });
});
