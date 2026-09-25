import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { fixture } from './roleplay-transactions-fixture.js';

const { requireJobApproval, readJobApproval, decideJobApproval, recoverJobApproval } = await import('../src/generation/job-approvals.js');
const { acceptJob, getJob, recoverJobs, updateJob, requestCancellation } = await import('../src/jobs/store.js');
const { roleplayAccountStamp, resetRoleplayAccount } = await import('../src/roleplay-store.js');
const { router } = await import('../src/endpoints/jobs.js');

function prepared(t) {
    const f = fixture(t);
    const directories = f.scope.directories;
    const { job } = acceptJob(directories, { owner: f.scope.owner, type: 'approval-fixture', submissionKey: 'review', intent: { source: 'original' } });
    updateJob(directories, job.id, { state: 'running' });
    const context = { directories, owner: f.scope.owner, job };
    const options = { account: roleplayAccountStamp(f.scope), key: 'lore-change', proposal: { title: 'Change the saved entry',
        changes: [{ field: 'content', before: 'Original', after: 'Changed' }] } };
    return { ...f, context, options };
}

test('approval persists the exact proposal and only the owner decision resumes it after restart', t => {
    const f = prepared(t);
    const pending = requireJobApproval(f.context, f.options);
    assert.equal(pending.decision, null);
    assert.equal(getJob(f.context.directories, f.context.job.id).state, 'waiting');
    recoverJobs(f.context.directories);
    assert.deepEqual(readJobApproval(f.context, pending.id).proposal, f.options.proposal);
    assert.throws(() => decideJobApproval(f.context, { ...pending, proposalHash: 'another-proposal', decision: 'allow' }), { code: 'JOB_APPROVAL_CHANGED' });
    assert.throws(() => requireJobApproval(f.context, { ...f.options, proposal: { title: 'A different target' } }), { code: 'JOB_APPROVAL_CHANGED' });
    const accepted = decideJobApproval(f.context, { ...pending, decision: 'allow' });
    assert.equal(accepted.job.state, 'queued');
    assert.equal(requireJobApproval(f.context, f.options).decision, 'allow');
    assert.throws(() => decideJobApproval(f.context, { ...pending, decision: 'deny' }), { code: 'JOB_APPROVAL_CHANGED' });
    // The durable decision was saved but the process stopped before the status update.
    updateJob(f.context.directories, f.context.job.id, { state: 'waiting', stage: 'approval', result: { approval: pending } });
    recoverJobs(f.context.directories);
    recoverJobApproval(f.context);
    assert.equal(getJob(f.context.directories, f.context.job.id).state, 'queued');
    assert.equal(readJobApproval(f.context, pending.id).decision, 'allow');
});

test('cancelled work, altered intent and a replaced account cannot acquire approval', t => {
    const f = prepared(t);
    const pending = requireJobApproval(f.context, f.options);
    requestCancellation(f.context.directories, f.context.job.id);
    assert.throws(() => decideJobApproval(f.context, { ...pending, decision: 'allow' }), { code: 'JOB_APPROVAL_CHANGED' });
    const changed = prepared(t);
    const next = requireJobApproval(changed.context, changed.options);
    updateJob(changed.context.directories, changed.context.job.id, { intent: { source: 'different' } });
    assert.throws(() => readJobApproval(changed.context, next.id), { code: 'JOB_APPROVAL_CHANGED' });
    const replaced = prepared(t);
    requireJobApproval(replaced.context, replaced.options);
    resetRoleplayAccount(replaced.scope, replaced.options.account, 'reset');
    assert.throws(() => requireJobApproval(replaced.context, replaced.options), error => error.status === 409);
});

test('the authenticated approval route rejects a model confirmation flag and a different account', async t => {
    const f = prepared(t);
    const pending = requireJobApproval(f.context, f.options);
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { request.user = { profile: { handle: request.get('X-Test-Owner') || f.scope.owner }, directories: f.context.directories }; next(); });
    app.use('/api/jobs', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const url = `http://127.0.0.1:${server.address().port}/api/jobs/${f.context.job.id}/approval/${pending.id}`;
    assert.equal((await fetch(url, { headers: { 'X-Test-Owner': 'another-owner' } })).status, 404);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userConfirmed: true }) })).status, 409);
    assert.equal((await fetch(url)).status, 200);
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proposalHash: pending.proposalHash, decision: 'deny' }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).decision, 'deny');
    assert.equal(requireJobApproval(f.context, f.options).decision, 'deny');
});
