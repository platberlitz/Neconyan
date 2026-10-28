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

for (const reason of ['failed', 'refused']) test(`an automatic Agent ${reason} stop delivers a reply without Agent proof`, t => {
    const f = prepared(t);
    writeArtifact(f.directories, f.job.id, 'roleplay-agent-stop', { intentHash: roleplayHash(f.job.intent), reason });
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

const { saveBlockedOutputProof } = await import('../src/generation/blocked-output-proof.js');
function blockedFixture(t, continuation = false) {
    const f = prepared(t);
    if (continuation) {
        f.job.intent.effect = 'continue';
        f.job.intent.source.message = { index: 0 };
    }
    const outcome = { version: 1, status: 'blocked', reason: 'content_filter' };
    const result = { text: 'An incomplete sentence', response: { choices: [{ message: { content: 'An incomplete sentence' }, finish_reason: 'content_filter' }] } };
    const step = 'provider:' + 'a'.repeat(64);
    writeArtifact(f.directories, f.job.id, 'roleplay-main-provider', { intentHash: roleplayHash(f.job.intent), step });
    writeArtifact(f.directories, f.job.id, step, result);
    f.output = continuation ? { text: result.text, extra: { generation_outcome: outcome } }
        : { message: { mes: result.text, extra: { generation_outcome: outcome } } };
    saveBlockedOutputProof(f.directories, f.job, f.output, f.records);
    return { ...f, step, result };
}

test('a provider-bound blocked proof admits exact partial output and continuation without Agent proof', t => {
    for (const continuation of [false, true]) {
        const f = blockedFixture(t, continuation);
        assert.equal(applyAgentCompletionRecords(f.directories, f.job, f.records, f.output), undefined);
        assert.equal(applyAgentCompletionRecords(f.directories, f.job, f.records, structuredClone(f.output)), undefined);
    }
});
for (const [name, tamper] of [
    ['forged metadata', f => { delete f.output.blockedProof; }],
    ['wrong provider hash', f => writeArtifact(f.directories, f.job.id, f.step, { ...f.result, text: 'Changed' })],
    ['changed partial text', f => { f.output.message.mes += ' forged'; }],
    ['forged Agent metadata', f => { f.output.message.extra.inChatAgentCompanionResults = { forged: true }; }],
    ['invented continuation', f => { f.output.continuedText = 'invented'; }],
]) test(`blocked proof rejects ${name}`, t => {
    const f = blockedFixture(t);
    tamper(f);
    assert.throws(() => applyAgentCompletionRecords(f.directories, f.job, f.records, f.output));
});
test('blocked continuation proof rejects a different accepted baseline', t => {
    const f = blockedFixture(t, true);
    f.records[1].mes = 'Different baseline';
    assert.throws(() => applyAgentCompletionRecords(f.directories, f.job, f.records, f.output), { code: 'ROLEPLAY_BLOCKED_RECOVERY' });
});
