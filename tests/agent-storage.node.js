import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { agentRecordRevision, readAgentCollection, readAgentRecordLocked, writeAgentRecordLocked, writeAgentRecord } = await import('../src/in-chat-agent-storage.js');
const { roleplayAccountStamp, withRoleplayAccount } = await import('../src/roleplay-store.js');

function prepared(t) {
    const f = fixture(t);
    const directories = f.scope.directories;
    directories.inChatAgents = path.join(directories.root, 'agents');
    directories.inChatAgentGroups = path.join(directories.root, 'agent-groups');
    const account = roleplayAccountStamp(f.scope);
    const locked = operation => withRoleplayAccount(f.scope, account, operation);
    return { ...f, directories, account, locked };
}

test('Agent HTTP and native edits share the account lock, exact versions and physical identities', t => {
    const f = prepared(t);
    const original = { id: 'agent-a', name: 'A', prompt: 'Original' };
    const revision = f.locked(lease => writeAgentRecordLocked(lease, 'agent', original, { expectedRevision: 'missing' }));
    assert.equal(revision, agentRecordRevision(original));
    const saved = f.locked(lease => readAgentRecordLocked(lease, 'agent', original.id));
    const current = { ...original, prompt: 'Changed through HTTP' };
    const request = { user: { profile: { handle: f.scope.owner }, directories: f.directories },
        get: name => name === 'If-Match' ? revision : f.scope.owner };
    assert.equal(writeAgentRecord(request, f.directories.inChatAgents, 'agent', current), agentRecordRevision(current));
    assert.throws(() => f.locked(lease => writeAgentRecordLocked(lease, 'agent', original,
        { expectedRevision: revision, expectedFile: saved.file })), { status: 409 });
    const latest = f.locked(lease => readAgentRecordLocked(lease, 'agent', original.id));
    const filename = path.join(f.directories.inChatAgents, 'agent-a.json');
    fs.renameSync(filename, filename + '.old');
    fs.writeFileSync(filename, JSON.stringify(current));
    assert.throws(() => f.locked(lease => writeAgentRecordLocked(lease, 'agent', { ...current, prompt: 'No' },
        { expectedRevision: latest.revision, expectedFile: latest.file })), { status: 409 });
    assert.deepEqual(JSON.parse(fs.readFileSync(filename)), current);
});

test('Agent writes retain previous bytes on failure and refuse symlinks, damaged records and outside collections', t => {
    const f = prepared(t);
    const original = { id: 'agent-a', prompt: 'Keep this' };
    f.locked(lease => writeAgentRecordLocked(lease, 'agent', original));
    assert.throws(() => f.locked(lease => writeAgentRecordLocked(lease, 'agent', { ...original, prompt: 'New' },
        { beforePublish: () => { throw new Error('Publication stopped'); } })), /Publication stopped/);
    const directory = f.directories.inChatAgents;
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'agent-a.json'))), original);
    fs.writeFileSync(path.join(directory, 'broken.json'), '{');
    fs.symlinkSync(path.join(directory, 'agent-a.json'), path.join(directory, 'alias.json'));
    for (const id of ['broken', 'alias']) assert.throws(() => f.locked(lease => writeAgentRecordLocked(lease, 'agent', { id })), { status: 409 });
    const collection = readAgentCollection(directory, 'agent', f.scope);
    assert.deepEqual(collection.records, [original]);
    assert.deepEqual(collection.errors.map(item => item.file).sort(), ['alias.json', 'broken.json']);
    assert.equal(fs.readFileSync(path.join(directory, 'broken.json'), 'utf8'), '{');
    assert.throws(() => readAgentCollection(path.dirname(f.directories.root), 'agent', f.scope), { status: 409 });
});
