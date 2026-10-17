import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const { acceptJob } = await import('../src/jobs/store.js');
const { writeArtifact } = await import('../src/jobs/artifacts.js');
const { applyAgentCompletionRecords } = await import('../src/generation/agent-completion-records.js');
const { roleplayHash } = await import('../src/roleplay-store.js');

function prepared(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-agent-completion-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directories = { root };
    const intent = { effect: 'append', source: { kind: 'chat', instanceId: 'chat', rawHash: 'a'.repeat(64), locator: { avatar: 'Nova.png' } },
        request: { worldInfo: { agents: { companionAutoCleanup: null } } } };
    const { job } = acceptJob(directories, { owner: 'owner', type: 'roleplay.reply', submissionKey: `guard-${randomUUID()}`, intent });
    return { directories, job, records: [{ chat_metadata: {} }, { mes: 'Answer' }],
        output: { message: { mes: 'Raw answer', extra: {} } } };
}

test('an automatic Agent failure stop delivers a reply without Agent proof', t => {
    const f = prepared(t);
    writeArtifact(f.directories, f.job.id, 'roleplay-agent-stop', { intentHash: roleplayHash(f.job.intent), reason: 'failed' });
    assert.equal(applyAgentCompletionRecords(f.directories, f.job, f.records, f.output), undefined);
    assert.deepEqual(f.records, [{ chat_metadata: {} }, { mes: 'Answer' }]);
});

for (const [label, stop] of [
    ['the owner Stop', null],
    ['another reason', job => ({ intentHash: roleplayHash(job.intent), reason: 'owner' })],
    ['a mismatched intent', job => ({ intentHash: 'b'.repeat(64), reason: 'failed' })],
]) test(`${label} cannot deliver a reply without Agent proof`, t => {
    const fixture = prepared(t);
    const value = stop === null ? { intentHash: roleplayHash(fixture.job.intent) } : stop(fixture.job);
    writeArtifact(fixture.directories, fixture.job.id, 'roleplay-agent-stop', value);
    assert.throws(() => applyAgentCompletionRecords(fixture.directories, fixture.job, fixture.records, fixture.output),
        { code: 'ROLEPLAY_AGENT_RECOVERY' });
});

test('a continuation cannot use the failure stop to skip Agent proof', t => {
    const f = prepared(t);
    writeArtifact(f.directories, f.job.id, 'roleplay-agent-stop', { intentHash: roleplayHash(f.job.intent), reason: 'failed' });
    assert.throws(() => applyAgentCompletionRecords(f.directories, f.job, f.records, { continuedText: 'Raw answer', text: 'Raw answer' }),
        { code: 'ROLEPLAY_AGENT_RECOVERY' });
});
