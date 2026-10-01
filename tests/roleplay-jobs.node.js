/* eslint playwright/expect-expect: off -- Uses node:assert against real saved files. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { readRoleplayChat, captureRoleplaySource } = await import('../src/generation/roleplay-source.js');
const { readRoleplayAccount, resetRoleplayAccount } = await import('../src/roleplay-store.js');
const { admitRoleplayJob, applyRoleplayJobEffect, voidRoleplayJob } = await import('../src/roleplay-jobs.js');
const { getJob, requestCancellation } = await import('../src/jobs/store.js');
const { prepareNativeChatWrite, publishNativeChatWrite } = await import('../src/endpoints/chats.js');
const host = { prepare: prepareNativeChatWrite, publish: publishNativeChatWrite };

const stamp = scope => ({ accountId: scope.accountId, dataEpoch: scope.dataEpoch });
const messages = f => readRoleplayChat(f.scope, f.locator).records.slice(1);

function admit(f, operationKey, effect, anchor = {}) {
    const source = captureRoleplaySource(f.scope, { locator: f.locator, ...anchor });
    return { source, ...admitRoleplayJob(f.scope, stamp(f.scope), { operationKey, effect, source, request: { prompt: operationKey } }) };
}

test('admission records the receipt, creates one paused job and replays it', async t => {
    const f = fixture(t);
    const first = admit(f, 'reply-1', 'append');
    assert.equal(first.created, true);
    const job = getJob(f.scope.directories, first.jobId);
    assert.equal(job.state, 'waiting');
    assert.deepEqual(job.intent.roleplay, { ...stamp(f.scope), operationKey: 'reply-1' });
    const again = admitRoleplayJob(f.scope, stamp(f.scope), { operationKey: 'reply-1', effect: 'append', source: first.source, request: { prompt: 'reply-1' } });
    assert.deepEqual(again, { jobId: first.jobId, state: 'accepted', created: false });
    assert.throws(() => admitRoleplayJob(f.scope, stamp(f.scope), { operationKey: 'reply-1', effect: 'append', source: first.source, request: { prompt: 'other' } }),
        { code: 'ROLEPLAY_INTENT_CONFLICT' });
    assert.throws(() => admitRoleplayJob(f.scope, stamp(f.scope), { operationKey: 'reply-2', effect: 'swipe', source: first.source }), { code: 'ROLEPLAY_INVALID' });
});

test('each typed effect writes once and a completed replay never writes again', async t => {
    const f = fixture(t);
    const append = admit(f, 'append', 'append');
    const appended = applyRoleplayJobEffect(f.scope, stamp(f.scope), { operationKey: 'append', jobId: append.jobId, output: { message: { name: 'Nova', is_user: false, mes: 'Appended' } } }, host);
    assert.equal(messages(f).at(-1).mes, 'Appended');

    const cont = admit(f, 'continue', 'continue', { message: 2 });
    applyRoleplayJobEffect(f.scope, stamp(f.scope), { operationKey: 'continue', jobId: cont.jobId, output: { text: ' more' } }, host);
    assert.equal(messages(f)[2].mes, 'Appended more');

    const swipe = admit(f, 'swipe', 'swipe', { message: 1 });
    applyRoleplayJobEffect(f.scope, stamp(f.scope), { operationKey: 'swipe', jobId: swipe.jobId, output: { text: 'Third' } }, host);
    assert.deepEqual(messages(f)[1].swipes, ['Answer', 'Other', 'Third']);
    assert.equal(messages(f)[1].swipe_id, 2);
    assert.equal(messages(f)[1].mes, 'Third');

    const replace = admit(f, 'replace', 'replace', { range: { start: 0, count: 1 } });
    applyRoleplayJobEffect(f.scope, stamp(f.scope), { operationKey: 'replace', jobId: replace.jobId, output: { messages: [{ name: 'User', is_user: true, mes: 'Edited' }] } }, host);
    assert.equal(messages(f)[0].mes, 'Edited');
    assert.equal(messages(f).length, 3);

    // A late duplicate callback returns the recorded outcome without writing.
    const revision = readRoleplayChat(f.scope, f.locator).revision;
    const replay = applyRoleplayJobEffect(f.scope, stamp(f.scope), { operationKey: 'append', jobId: append.jobId, output: { message: { name: 'Nova', mes: 'Again' } } }, host);
    assert.deepEqual(replay, appended);
    assert.equal(readRoleplayChat(f.scope, f.locator).revision, revision);
    assert.ok(!messages(f).some(message => message.mes === 'Again'));
});

test('an open job keeps its finished write receipt through many later saves and never writes twice', async t => {
    const f = fixture(t);
    const { roleplayHash, withRoleplayAccountLock, roleplayLease, saveRoleplayAccount } = await import('../src/roleplay-store.js');
    const { commitSingleChatWrite } = await import('../src/roleplay-lifecycle.js');
    const append = admit(f, 'append', 'append');
    const appended = applyRoleplayJobEffect(f.scope, stamp(f.scope), { operationKey: 'append', jobId: append.jobId, output: { message: { name: 'Nova', is_user: false, mes: 'Appended' } } }, host);
    // A crash after the chat write but before the job receipt closed.
    withRoleplayAccountLock(f.scope, lease => {
        const receipt = roleplayLease(lease).state.submissions[roleplayHash([f.scope.accountId, 'roleplay-job', 'append'])];
        Object.assign(receipt, { state: 'accepted', effects: {} });
        delete receipt.outcome;
        saveRoleplayAccount(lease);
    });
    for (let index = 0; index < 20; index++) {
        const records = readRoleplayChat(f.scope, f.locator).records;
        records[1].mes = `Manual edit ${index}`;
        commitSingleChatWrite(f.scope, { operationKey: `edit-${index}`, mode: 'update', source: captureRoleplaySource(f.scope, { locator: f.locator }), records, backup: { deferBackup: true } }, host);
    }
    const count = messages(f).filter(message => message.mes === 'Appended').length;
    const replay = applyRoleplayJobEffect(f.scope, stamp(f.scope), { operationKey: 'append', jobId: append.jobId, output: { message: { name: 'Nova', is_user: false, mes: 'Appended' } } }, host);
    assert.deepEqual(replay, appended);
    assert.equal(messages(f).filter(message => message.mes === 'Appended').length, count);
});

test('moved anchors, foreign jobs, withdrawn jobs and older incarnations are refused', async t => {
    const f = fixture(t);
    const swipe = admit(f, 'swipe', 'swipe', { message: 1 });
    const append = admit(f, 'append', 'append');
    applyRoleplayJobEffect(f.scope, stamp(f.scope), { operationKey: 'append', jobId: append.jobId, output: { message: { name: 'Nova', mes: 'Later' } } }, host);
    // The swipe target is unchanged, so a later append elsewhere is allowed.
    applyRoleplayJobEffect(f.scope, stamp(f.scope), { operationKey: 'swipe', jobId: swipe.jobId, output: { text: 'Fresh' } }, host);

    const stale = admit(f, 'stale', 'append');
    const other = admit(f, 'other', 'append');
    assert.throws(() => applyRoleplayJobEffect(f.scope, stamp(f.scope), { operationKey: 'stale', jobId: other.jobId, output: { message: { mes: 'x' } } }, host),
        { code: 'ROLEPLAY_JOB_REJECTED' });
    applyRoleplayJobEffect(f.scope, stamp(f.scope), { operationKey: 'other', jobId: other.jobId, output: { message: { mes: 'Other' } } }, host);
    assert.throws(() => applyRoleplayJobEffect(f.scope, stamp(f.scope), { operationKey: 'stale', jobId: stale.jobId, output: { message: { mes: 'x' } } }, host),
        { code: 'ROLEPLAY_SOURCE_CHANGED' });

    const cancelled = admit(f, 'cancelled', 'append');
    requestCancellation(f.scope.directories, cancelled.jobId);
    assert.throws(() => applyRoleplayJobEffect(f.scope, stamp(f.scope), { operationKey: 'cancelled', jobId: cancelled.jobId, output: { message: { mes: 'x' } } }, host),
        { code: 'ROLEPLAY_JOB_REJECTED' });
    assert.equal(voidRoleplayJob(f.scope, stamp(f.scope), { operationKey: 'cancelled', jobId: cancelled.jobId }), 'void');
    assert.throws(() => applyRoleplayJobEffect(f.scope, stamp(f.scope), { operationKey: 'cancelled', jobId: cancelled.jobId, output: { message: { mes: 'x' } } }, host),
        { code: 'ROLEPLAY_JOB_REJECTED' });

    const late = admit(f, 'late', 'append');
    const next = resetRoleplayAccount(f.scope, null, 'reset');
    assert.throws(() => applyRoleplayJobEffect(f.scope, stamp(f.scope), { operationKey: 'late', jobId: late.jobId, output: { message: { mes: 'x' } } }, host),
        { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
    assert.throws(() => applyRoleplayJobEffect(next, stamp(next), { operationKey: 'late', jobId: late.jobId, output: { message: { mes: 'x' } } }, host),
        { code: 'ROLEPLAY_JOB_REJECTED' });
    assert.equal(fs.existsSync(f.filename), false);
});

test('a completed job replays after its chat is deleted without recreating it', async t => {
    const f = fixture(t);
    const append = admit(f, 'append', 'append');
    const result = applyRoleplayJobEffect(f.scope, stamp(f.scope), { operationKey: 'append', jobId: append.jobId, output: { message: { mes: 'Done' } } }, host);
    fs.rmSync(f.filename);
    assert.deepEqual(applyRoleplayJobEffect(f.scope, stamp(f.scope), { operationKey: 'append', jobId: append.jobId, output: { message: { mes: 'Done' } } }, host), result);
    assert.equal(fs.existsSync(f.filename), false);
    const receipts = Object.values(readRoleplayAccount(f.scope).submissions).filter(item => item.state === 'closed');
    assert.ok(receipts.length >= 2);
});

test('jobs follow a renamed chat, may shrink explicit ranges, normalise swipes and refuse a tampered ledger intent', async t => {
    const f = fixture(t);
    for (let index = 0; index < 8; index++) {
        const next = admit(f, `grow-${index}`, 'append');
        applyRoleplayJobEffect(f.scope, stamp(f.scope), { operationKey: `grow-${index}`, jobId: next.jobId, output: { message: { name: 'Nova', mes: `Line ${index}` } } }, host);
    }
    const count = messages(f).length;
    const replace = admit(f, 'shrink', 'replace', { range: { start: 0, count: count - 1 } });
    applyRoleplayJobEffect(f.scope, stamp(f.scope), { operationKey: 'shrink', jobId: replace.jobId, output: { messages: [{ name: 'Nova', mes: 'Summary' }] } }, host);
    assert.deepEqual(messages(f).map(message => message.mes), ['Summary', 'Line 7']);
    assert.equal(readRoleplayAccount(f.scope).pending, null);

    const swipe = admit(f, 'swipe', 'swipe', { message: 1 });
    const { commitRoleplayLifecycleLocked } = await import('../src/roleplay-lifecycle.js');
    const { withRoleplayAccount } = await import('../src/roleplay-store.js');
    const destination = { ...f.locator, chat: 'Renamed' };
    withRoleplayAccount(f.scope, stamp(f.scope), lease => commitRoleplayLifecycleLocked(lease, { operationKey: 'rename', action: 'chat-rename',
        intent: { destination }, steps: [{ op: 'move', kind: 'chat', locator: f.locator, destination }] }));
    applyRoleplayJobEffect(f.scope, stamp(f.scope), { operationKey: 'swipe', jobId: swipe.jobId, output: { text: 'After rename' } }, host);
    const renamed = readRoleplayChat(f.scope, destination).records.slice(1);
    assert.equal(renamed[1].mes, 'After rename');
    assert.equal(renamed[1].swipe_info.length, renamed[1].swipes.length);

    const tampered = admit({ ...f, locator: destination }, 'tampered', 'append');
    const ledger = `${f.scope.directories.root}/jobs/index.json`;
    const store = JSON.parse(fs.readFileSync(ledger, 'utf8'));
    Object.values(store.jobs).find(job => job.id === tampered.jobId).intent.request = { prompt: 'swapped' };
    fs.writeFileSync(ledger, JSON.stringify(store));
    assert.throws(() => applyRoleplayJobEffect(f.scope, stamp(f.scope), { operationKey: 'tampered', jobId: tampered.jobId, output: { message: { mes: 'x' } } }, host),
        { code: 'ROLEPLAY_JOB_REJECTED', message: /intent it was admitted with/ });
});
