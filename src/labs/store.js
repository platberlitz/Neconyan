import { createOperationRecords } from '../jobs/operation-records.js';
import { getJob, providerRecoverySteps, registerJobHistoryLifecycle, requestCancellation, updateJob } from '../jobs/store.js';
import { readArtifact } from '../jobs/artifacts.js';
import { abortJob, isJobRunning } from '../jobs/runner.js';
import { roleplayAccountBase, roleplayHash, roleplayLease, roleplayStoreDirectory, withExistingRoleplayAccount } from '../roleplay-store.js';
import fs from 'node:fs';
import path from 'node:path';
import { parseProposals, normalizeProposals, mergeProposals, markDuplicates } from '../../public/scripts/extensions/third-party/Neconyan-Lorebook-Distiller/src/core.js';

export const LAB_RECORD_LIMIT = 16 * 1024 * 1024;
export const LAB_STORE_LIMIT = 512 * 1024 * 1024;
const records = createOperationRecords({ namespace: 'labs', label: 'Labs', errorCode: 'LAB_WORK_CHANGED',
    recordLimit: kind => kind === 'prompting.transfer' ? 64 * 1024 * 1024 : LAB_RECORD_LIMIT,
    planLimit: kind => kind === 'prompting.transfer' ? 24 * 1024 * 1024 : 8 * 1024 * 1024,
    storeLimit: LAB_STORE_LIMIT,
    reserves: value => ['preparing', 'accepted'].includes(value.state)
        && (value.kind !== 'distill' || !value.lifecycle?.retired || isJobRunning(value.jobId)),
    canRelease: (_context, value) => value.kind !== 'distill' || !value.lifecycle?.retired,
    reconcile: (value, lease) => value.kind === 'distill' && reconcileDistillation(value, roleplayLease(lease).scope),
});

export const { error: labError, assertTargetIdle: assertLabsTargetIdle, read: readLabRecord,
    refuse: refuseLabSubmission, list: listLabRecords, withRecord: withLabRecord,
    mutateLocked: mutateLabRecordLocked, admit: admitLabJob, finalize: finalizeLabSubmission,
    finish: finishLabJob } = records;

export const distillTransaction = records.transaction;
export const distillTransactionLocked = records.transactionLocked;

export function distillUncertain(base, job) {
    if (!job) return true;
    const steps = providerRecoverySteps(job);
    const pending = steps.filter(step => readArtifact(base.directories, job.id, step) === undefined);
    const resume = job.resume;
    if (typeof resume === 'string' && resume.startsWith('provider:') && readArtifact(base.directories, job.id, resume) === undefined) return true;
    return pending.length > 0 || !steps.length && job.recoverability === 'unknown-outcome';
}

function retire(value, { reason, uncertain, removed = false }) {
    const before = value.lifecycle ?? {};
    if (before.retired && before.reason === reason && before.uncertain === uncertain && Boolean(before.removed) === removed) return false;
    value.lifecycle = { ...before, revision: (before.revision ?? 0) + 1, retired: true, reason, uncertain, removed };
    return true;
}

function retainDistillCheckpoint(value, base, job) {
    const step = job?.resume;
    if (!value.plan.target?.book || typeof step !== 'string' || !step.startsWith('provider:') || value.partial?.lastProviderStep === step) return false;
    const saved = readArtifact(base.directories, job.id, step);
    if (!saved?.text) return false;
    let proposals;
    try { proposals = parseProposals(saved.text); } catch { return false; }
    const cleaned = normalizeProposals([...(value.partial?.proposals ?? []), ...proposals]);
    const chunks = readArtifact(base.directories, job.id, 'distill-chunks');
    value.partial = { target: value.plan.target, proposals: markDuplicates(mergeProposals(cleaned.proposals), Object.values(value.plan.target.book.entries))
        .map((proposal, id) => ({ ...proposal, id })), dropped: cleaned.dropped, failedChunks: value.partial?.failedChunks ?? 0,
    chunks: chunks?.length ?? value.partial?.chunks ?? 1, incomplete: true, lastProviderStep: step };
    return true;
}

function reconcileDistillation(value, base, suppliedJob, removal = false) {
    if (value.kind !== 'distill') return false;
    const job = suppliedJob ?? (value.jobId ? getJob(base.directories, value.jobId) : null);
    if (value.state === 'completed') return false;
    // A crash can fall between the result artefact and permanent completion.
    // This finishes saved local work, including a late superseded reply, without dispatch.
    const savedResult = job && readArtifact(base.directories, job.id, 'result');
    if (savedResult !== undefined && savedResult !== null && job) {
        value.result = savedResult; value.resultHash = roleplayHash(savedResult); value.state = 'completed';
        delete value.partial;
        return true;
    }
    const checkpointSaved = job ? retainDistillCheckpoint(value, base, job) : false;
    if (value.lifecycle?.reason === 'superseded') return checkpointSaved;
    const retainFailure = changed => {
        if (job?.error && roleplayHash(value.lifecycle?.error ?? null) !== roleplayHash(job.error)) {
            value.lifecycle = { ...value.lifecycle, error: job.error, revision: (value.lifecycle?.revision ?? 0) + (changed ? 0 : 1) };
            return true;
        }
        return changed || checkpointSaved;
    };
    if (removal) return retainFailure(retire(value, { reason: job.dismissedReason === 'cleared' ? 'cleared' : 'missing',
        uncertain: distillUncertain(base, job), removed: true }));
    if (value.state === 'refused') return retire(value, { reason: 'refused', uncertain: false });
    if (!job && value.state !== 'preparing') return retire(value, { reason: value.lifecycle?.removed ? value.lifecycle.reason : 'missing',
        uncertain: value.lifecycle?.uncertain ?? true, removed: true });
    if (job && ['failed', 'cancelled', 'interrupted', 'conflict'].includes(job.state)) {
        value.error = job.error?.message ?? value.error;
        return retainFailure(retire(value, { reason: job.state, uncertain: distillUncertain(base, job) }));
    }
    return checkpointSaved;
}

/** Release abandoned Distiller reservations before the next admission, including legacy records. */
export function reconcileDistillations(base, account) {
    return records.transaction(base, account, (_lease, tx) => {
        for (const value of tx.all('distill')) if (reconcileDistillation(value, base)) tx.write(value);
    });
}

/** Only deliberate current-selection replacement may retire an uncertain operation. */
export function fenceDistillation(lease, { previousKey, previousRevision, previousBody, key, consent }, successor, validateOnly = false) {
    return records.transactionLocked(lease, (_lease, tx) => {
        const { scope: base } = roleplayLease(lease);
        let old = tx.read(previousKey);
        const missing = !old;
        if (!old) {
            const plan = {};
            old = { version: 1, key: previousKey, kind: 'distill', label: 'Earlier distillation', account: { accountId: base.accountId, dataEpoch: base.dataEpoch },
                state: 'refused', jobId: '', effects: {}, createdAt: Date.now(), plan, planHash: roleplayHash(plan),
                requestHash: previousBody ? roleplayHash({ kind: 'distill', input: Object.fromEntries(Object.entries(previousBody).filter(([name]) => !['key', 'kind'].includes(name))) }) : roleplayHash(['fenced', previousKey]),
                lifecycle: { revision: 0, retired: true, uncertain: true, reason: 'missing', removed: true } };
        }
        if (old.kind !== 'distill') throw labError('Only a distillation can be replaced.', 400);
        if (old.lifecycle?.replacement?.key === key) return;
        const linked = old.lifecycle?.replacement && tx.read(old.lifecycle.replacement.key);
        if (linked && linked.state !== 'refused') throw Object.assign(labError('An earlier retry already owns this attempt. Check its saved status.'), { replacementKey: linked.key });
        if (!missing) reconcileDistillation(old, base);
        if (old.state === 'completed') throw Object.assign(labError('The previous distillation finished. Review its saved proposals before starting another.'), { code: 'DISTILL_COMPLETED', recordKey: old.key });
        if ((old.lifecycle?.revision ?? 0) !== previousRevision) throw Object.assign(labError('The previous request changed. Check its status before trying again.'), { code: 'DISTILL_CHANGED' });
        const job = old.jobId ? getJob(base.directories, old.jobId) : null;
        const uncertain = old.lifecycle?.uncertain ?? distillUncertain(base, job);
        if ((uncertain || job && ['queued', 'running', 'waiting'].includes(job.state)) && consent !== true) {
            throw Object.assign(labError('The previous request may still be processing, or its reply may have been lost. Trying again may use tokens again.'), { code: 'DISTILL_UNCERTAIN' });
        }
        if (validateOnly) return;
        retire(old, { reason: 'superseded', uncertain, removed: !job });
        old.lifecycle.replacement = { key, requestHash: successor.requestHash };
        tx.write(old); // Durable fence and receipt precede cancellation and new dispatch.
        if (job) {
            requestCancellation(base.directories, job.id, { reason: 'distill-replaced' });
            abortJob(job.id);
        }
    });
}

export function assertDistillActive(context) {
    return withLabRecord(context, ({ value }) => {
        if (value.lifecycle?.retired) throw Object.assign(labError('This earlier distillation has been retired. Start another from Lorebook Distiller.'), { code: 'DISTILL_RETIRED' });
    });
}

export function retryDistillJob(base, job) {
    return withExistingRoleplayAccount(base, lease => records.transactionLocked(lease, (_lease, tx) => {
        const value = tx.read(job.intent?.labs?.key);
        if (value?.kind === 'distill' && reconcileDistillation(value, base)) tx.write(value);
        if (value?.state === 'completed') throw Object.assign(labError('This distillation already has saved proposals. Review them in Lorebook Distiller.'), { code: 'DISTILL_COMPLETED' });
        if (!value || value.kind !== 'distill' || value.lifecycle?.retired) throw Object.assign(labError('This earlier distillation is no longer active. Try again with current selections in Lorebook Distiller.'), { code: 'DISTILL_RETIRED' });
        return updateJob(base.directories, job.id, { state: 'queued', finishedAt: null, error: null, dismissed: false }).job;
    }));
}

registerJobHistoryLifecycle({
    keep: job => job.type === 'labs.distill' && isJobRunning(job.id),
    withMutation(directories, action) {
        const base = roleplayAccountBase(directories);
        // Ordinary jobs and accounts without Labs records retain their existing path.
        if (!base || !fs.existsSync(path.join(roleplayStoreDirectory(base), 'labs'))) return action();
        return withExistingRoleplayAccount(base, () => action());
    },
    beforeRemove(directories, removed) {
        const distillations = removed.filter(job => job.type === 'labs.distill');
        if (!distillations.length) return;
        const base = roleplayAccountBase(directories);
        if (!base) return;
        withExistingRoleplayAccount(base, lease => records.transactionLocked(lease, (_lease, tx) => {
            for (const job of distillations) {
                const value = tx.read(job.intent?.labs?.key);
                if (value && value.jobId === job.id && reconcileDistillation(value, base, job, true)) tx.write(value);
            }
        }));
    },
});
