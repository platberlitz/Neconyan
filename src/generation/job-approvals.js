import fs from 'node:fs';
import path from 'node:path';
import { getJob, updateJob } from '../jobs/store.js';
import { createRoleplayDirectory, readRoleplayFile, roleplayAccountBase, roleplayError, roleplayHash,
    roleplayLease, roleplayStoreDirectory, withRoleplayAccount } from '../roleplay-store.js';
import { tryWriteFileSync } from '../util.js';

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const invalid = message => roleplayError('JOB_APPROVAL_CHANGED', message, 409);
const full = () => roleplayError('JOB_APPROVAL_CAPACITY', 'Saved approval ownership is full; this action was not accepted.', 507);

function owned(context) {
    const base = roleplayAccountBase(context.directories);
    const job = getJob(context.directories, context.job.id);
    if (!base || base.owner !== context.owner || !job || job.owner !== context.owner) throw invalid('The saved approval account or job is unavailable.');
    return { base, job };
}

function filenameFor(lease, id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw invalid('The saved approval identity is invalid.');
    return path.join(roleplayStoreDirectory(roleplayLease(lease).scope), 'approvals', `${id}.json`);
}

function read(lease, id) {
    const filename = filenameFor(lease, id);
    const file = readRoleplayFile(filename, MAX_RECORD_BYTES, { allowMissingParent: true });
    if (!file) return { filename, file: null, value: null };
    let value;
    try { value = JSON.parse(file.bytes.toString('utf8')); } catch { throw invalid('The saved approval needs recovery.'); }
    const { hash, ...data } = value ?? {};
    if (data.id !== id || hash !== roleplayHash(data)) throw invalid('The saved approval needs recovery.');
    return { filename, file, value: data };
}

function capacity(lease, extra = 0, own = null) {
    const root = roleplayStoreDirectory(roleplayLease(lease).scope);
    const directory = path.join(root, 'approvals');
    readRoleplayFile(path.join(directory, '.approval-path-check'), 1, { allowMissingParent: true });
    let used = extra;
    const existing = new Set();
    if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const id = name.slice(0, -5);
        const { file } = read(lease, id);
        if (!file) throw invalid('A saved approval disappeared while checking capacity.');
        existing.add(id);
        used += file.bytes.length + 1024;
    }
    const media = path.join(root, 'media');
    readRoleplayFile(path.join(media, '.approval-media-path-check'), 1, { allowMissingParent: true });
    if (fs.existsSync(media)) for (const name of fs.readdirSync(media)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const file = readRoleplayFile(path.join(media, name), 512 * 1024);
        let receipt;
        try { receipt = JSON.parse(file?.bytes.toString('utf8')); } catch { throw invalid('A saved media approval reservation needs recovery.'); }
        const reserved = receipt?.approvalReservation;
        if (!reserved) continue;
        if (receipt.version !== 1 || !['preparing', 'accepted', 'closed'].includes(receipt.state)
            || typeof receipt.jobId !== 'string' && receipt.state !== 'preparing'
            || typeof receipt.account?.accountId !== 'string' || typeof reserved.key !== 'string'
            || !Number.isSafeInteger(reserved.bytes) || reserved.bytes < 2048 || reserved.bytes > MAX_RECORD_BYTES) {
            throw invalid('A saved approval reservation is invalid.');
        }
        const id = receipt.jobId ? roleplayHash([receipt.account.accountId, receipt.jobId, reserved.key]) : '';
        if (own && id === own.id) {
            if (reserved.bytes < own.bytes) throw invalid('The accepted approval reservation cannot hold this complete proposal.');
            continue;
        }
        if (receipt.state !== 'closed' && !existing.has(id)) used += reserved.bytes;
    }
    if (used > MAX_STORE_BYTES) throw full();
}

/** The caller holds the protected account lock before admitting a job that will need owner review. */
export function reserveJobApprovalCapacityLocked(lease, { bytes }) {
    if (!Number.isSafeInteger(bytes) || bytes < 2048 || bytes > MAX_RECORD_BYTES) throw full();
    capacity(lease, bytes);
}

function write(lease, previous, value) {
    const bytes = Buffer.from(JSON.stringify({ ...value, hash: roleplayHash(value) }));
    if (bytes.length > MAX_RECORD_BYTES - 1024) throw invalid('The complete approval proposal exceeds its saved limit.');
    const directory = path.dirname(previous.filename);
    createRoleplayDirectory(directory, roleplayStoreDirectory(roleplayLease(lease).scope));
    if (!previous.file) {
        capacity(lease, bytes.length + 1024, { id: value.id, bytes: bytes.length + 1024 });
    }
    const before = previous.file;
    const validate = () => {
        const current = readRoleplayFile(previous.filename, MAX_RECORD_BYTES, { allowMissingParent: true });
        if (before ? !current || current.rawHash !== before.rawHash || roleplayHash(current.physical) !== roleplayHash(before.physical) : current) {
            throw invalid('The saved approval was replaced.');
        }
    };
    validate();
    tryWriteFileSync(previous.filename, bytes, {}, before ? { durable: true, replaceFileOnly: true,
        expectedFileIdentity: { dev: BigInt(before.physical.dev), ino: BigInt(before.physical.ino) }, validateBeforeReplace: validate }
        : { durable: true, expectedFileAbsent: true });
    const confirmed = readRoleplayFile(previous.filename, MAX_RECORD_BYTES, { flush: true });
    if (!confirmed?.bytes.equals(bytes)) throw invalid('The approval decision could not be confirmed on disk.');
}

function assertRecord(value, context, job, account) {
    if (!value || value.owner !== context.owner || value.jobId !== job.id || value.intentHash !== roleplayHash(job.intent)
        || roleplayHash(value.account) !== roleplayHash(account) || !Array.isArray(value.choices)
        || value.decision !== null && !value.choices.includes(value.decision)) throw invalid('The saved approval does not belong to this accepted request.');
}

/** This saves a proposal, not a decision. Model-provided confirmation flags confer no authority. */
export function requireJobApproval(context, { account, key, proposal, choices = ['allow', 'deny'], assertSourceLocked }) {
    const { base, job } = owned(context);
    if (typeof key !== 'string' || !key || key.length > 256 || !proposal || !Array.isArray(choices)
        || choices.length < 2 || choices.length > 4 || choices.some(choice => typeof choice !== 'string' || !/^[a-z-]{1,32}$/.test(choice))
        || new Set(choices).size !== choices.length) throw invalid('The approval proposal is invalid.');
    return withRoleplayAccount(base, account, lease => {
        const id = roleplayHash([account.accountId, job.id, key]);
        const proposalHash = roleplayHash({ proposal, choices });
        const previous = read(lease, id);
        let value = previous.value;
        if (value) {
            assertRecord(value, context, job, account);
            if (value.key !== key || value.proposalHash !== proposalHash) throw invalid('The action differs from the saved approval proposal.');
        } else {
            assertSourceLocked?.(lease);
            value = { version: 1, id, owner: context.owner, jobId: job.id, account, key,
                intentHash: roleplayHash(job.intent), proposal, proposalHash, choices, decision: null, createdAt: Date.now() };
            write(lease, previous, value);
        }
        if (value.decision === null) {
            const current = getJob(context.directories, job.id);
            if (current.cancellation?.requested || ['completed', 'cancelled', 'failed', 'interrupted', 'conflict'].includes(current.state)) {
                throw invalid('This job is no longer waiting for approval.');
            }
            updateJob(context.directories, job.id, { state: 'waiting', stage: 'approval',
                result: { approval: { id, proposalHash, key } } });
        }
        return { id, proposalHash, decision: value.decision };
    });
}

export function readJobApproval(context, id) {
    const { base, job } = owned(context);
    return withRoleplayAccount(base, null, (lease, account) => {
        const { value } = read(lease, id);
        assertRecord(value, context, job, account);
        return { id, proposalHash: value.proposalHash, proposal: value.proposal, choices: value.choices, decision: value.decision };
    });
}

/** Called only by the authenticated, CSRF-protected owner endpoint after displaying this exact proposal. */
export function decideJobApproval(context, { id, proposalHash, decision }) {
    const { base, job } = owned(context);
    return withRoleplayAccount(base, null, (lease, account) => {
        const previous = read(lease, id), value = previous.value;
        assertRecord(value, context, job, account);
        if (value.proposalHash !== proposalHash || !value.choices.includes(decision)) throw invalid('Review the saved proposal before choosing its decision.');
        if (value.decision !== null) {
            if (value.decision !== decision) throw invalid('This proposal already has a different decision.');
            const current = getJob(context.directories, job.id);
            if (current.state === 'waiting' && current.stage === 'approval' && current.result?.approval?.id === id && !current.cancellation?.requested) {
                return { id, decision, job: updateJob(context.directories, job.id, { state: 'queued', stage: 'approved', result: null, error: null }).job };
            }
            return { id, decision, job: current };
        }
        if (job.state !== 'waiting' || job.stage !== 'approval' || job.result?.approval?.id !== id || job.cancellation?.requested) {
            throw invalid('This job is no longer waiting for this approval.');
        }
        write(lease, previous, { ...value, decision, decidedAt: Date.now() });
        const resumed = updateJob(context.directories, job.id, { state: 'queued', stage: 'approved', result: null, error: null }).job;
        return { id, decision, job: resumed };
    });
}

/** Reconcile a durable decision if the process stopped before updating its replayable job status. */
export function recoverJobApproval(context) {
    const current = getJob(context.directories, context.job.id);
    if (current?.state !== 'waiting' || current.stage !== 'approval' || current.cancellation?.requested) return;
    const id = current.result?.approval?.id;
    const approval = readJobApproval({ ...context, job: current }, id);
    if (approval.decision !== null) return decideJobApproval({ ...context, job: current }, approval);
}
