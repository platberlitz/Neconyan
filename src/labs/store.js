import fs from 'node:fs';
import path from 'node:path';
import { acceptJob, getJob, releaseJob } from '../jobs/store.js';
import { readRoleplayFile, roleplayError, roleplayHash, roleplayLease, roleplayStoreDirectory,
    createRoleplayDirectory, withRoleplayAccount } from '../roleplay-store.js';
import { tryWriteFileSync } from '../util.js';

export const LAB_RECORD_LIMIT = 16 * 1024 * 1024;
const TRANSFER_RECORD_LIMIT = 64 * 1024 * 1024;
export const LAB_STORE_LIMIT = 512 * 1024 * 1024;
const recordLimit = kind => kind === 'prompting.transfer' ? TRANSFER_RECORD_LIMIT : LAB_RECORD_LIMIT;
export const labError = (message, status = 409) => roleplayError('LAB_WORK_CHANGED', message, status);
const states = new Set(['preparing', 'accepted', 'completed', 'refused']);
const evidence = file => file ? { rawHash: file.rawHash, physical: file.physical } : null;
const directoryFor = base => path.join(roleplayStoreDirectory(base), 'labs');
const stamp = account => ({ accountId: account.accountId, dataEpoch: account.dataEpoch });

function filenameFor(base, account, key) {
    if (typeof key !== 'string' || !key || key.length > 200) throw labError('A Labs operation key is required.', 400);
    return path.join(directoryFor(base), `${roleplayHash([account.accountId, key])}.json`);
}

function read(filename) {
    const file = readRoleplayFile(filename, TRANSFER_RECORD_LIMIT, { allowMissingParent: true });
    if (!file) return { file: null, value: null };
    let value;
    try { value = JSON.parse(file.bytes.toString('utf8')); } catch { throw labError('The saved Labs record is unreadable.'); }
    if (file.bytes.length > recordLimit(value?.kind) || value?.version !== 1 || !states.has(value.state) || typeof value.key !== 'string'
        || !value.account || typeof value.requestHash !== 'string' || !value.plan
        || value.planHash !== roleplayHash(value.plan) || !value.effects || Array.isArray(value.effects)
        || value.state !== 'preparing' && typeof value.jobId !== 'string'
        || value.state === 'completed' && value.resultHash !== roleplayHash(value.result)) throw labError('The saved Labs record needs recovery.');
    return { file, value };
}

function save(filename, value, before) {
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > recordLimit(value.kind)) throw labError('The saved Labs result exceeds its reserved space.', 413);
    let reserved = ['preparing', 'accepted'].includes(value.state) ? recordLimit(value.kind) : Buffer.byteLength(bytes);
    for (const name of fs.readdirSync(path.dirname(filename))) {
        const other = path.join(path.dirname(filename), name);
        if (other === filename || !/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const item = read(other);
        if (!item.file) throw labError('A saved Labs record disappeared.');
        reserved += ['preparing', 'accepted'].includes(item.value.state) ? recordLimit(item.value.kind) : item.file.bytes.length;
    }
    if (reserved > LAB_STORE_LIMIT) throw labError('Labs storage is full. Existing evidence was retained.', 413);
    const validate = () => {
        if (roleplayHash(evidence(readRoleplayFile(filename, TRANSFER_RECORD_LIMIT, { allowMissingParent: true })))
            !== roleplayHash(evidence(before))) throw labError('The Labs record changed before it could be saved.');
    };
    validate();
    tryWriteFileSync(filename, bytes, { encoding: 'utf8', mode: 0o600 }, before ? {
        replaceFileOnly: true, expectedFileIdentity: { dev: BigInt(before.physical.dev), ino: BigInt(before.physical.ino) },
        validateBeforeReplace: validate,
    } : { expectedFileAbsent: true, durable: true, preserveOnCreateError: true });
    const written = readRoleplayFile(filename, recordLimit(value.kind), { flush: true });
    if (!written || written.bytes.toString('utf8') !== bytes) throw labError('The Labs record write needs recovery.');
    return written;
}

function records(base) {
    const directory = directoryFor(base);
    readRoleplayFile(path.join(directory, '.path-check'), 1, { allowMissingParent: true });
    return fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
        .map(name => read(path.join(directory, name))) : [];
}

function reserve(base, target, account, kind = '') {
    let used = recordLimit(kind);
    for (const { file, value } of records(base)) {
        if (!file || !value) throw labError('A saved Labs record disappeared.');
        const open = ['preparing', 'accepted'].includes(value.state);
        used += open ? recordLimit(value.kind) : file.bytes.length;
        if (used > LAB_STORE_LIMIT) throw labError('Labs storage has no room for another result. Existing records were retained.', 413);
        if (open && value.applyTarget && Object.keys(value.effects).length && roleplayHash(value.account) === roleplayHash(stamp(account))
            && roleplayHash(value.applyTarget) === roleplayHash(target)) throw labError('That target has an unfinished reviewed Labs change.');
    }
}

/** Called by ordinary authoring writers under the same account lock. */
export function assertLabsTargetIdle(lease, target) {
    const { scope } = roleplayLease(lease);
    for (const { value } of records(scope)) {
        if (!value) throw labError('A saved Labs record disappeared.');
        if (['preparing', 'accepted'].includes(value.state) && value.applyTarget && Object.keys(value.effects).length
            && roleplayHash(value.account) === roleplayHash(stamp(scope))
            && roleplayHash(value.applyTarget) === roleplayHash(target)) throw labError('This target has an unfinished reviewed Labs change.');
    }
}

/** Readback is independent of the disposable job ledger and its artefacts. */
export function readLabRecord(base, key) {
    return withRoleplayAccount(base, null, (_lease, account) => {
        const { value } = read(filenameFor(base, account, key));
        if (value && roleplayHash(value.account) !== roleplayHash(account)) throw labError('This Labs operation belongs to an earlier account state.');
        return value;
    });
}

/** A rejected key stays rejected even if an earlier, delayed submission reaches admission later. */
export function refuseLabSubmission(base, account, { key, kind, ...input }, message) {
    if (!/^[a-z][a-z.-]{0,63}$/.test(kind)) return false;
    return withRoleplayAccount(base, account, () => {
        const filename = filenameFor(base, account, key);
        const existing = read(filename).value;
        if (existing) return false;
        reserve(base, null, account);
        createRoleplayDirectory(directoryFor(base), roleplayStoreDirectory(base));
        const plan = {};
        save(filename, { version: 1, key, account: stamp(account), kind, label: 'Refused Labs submission',
            requestHash: roleplayHash({ kind, input }), plan, planHash: roleplayHash(plan), applyTarget: null,
            state: 'refused', jobId: '', effects: {}, error: message, createdAt: Date.now() }, null);
        return true;
    });
}

export function listLabRecords(base, kind = '') {
    return withRoleplayAccount(base, null, (_lease, account) => records(base).flatMap(({ value }) => {
        if (!value || roleplayHash(value.account) !== roleplayHash(account) || kind && value.kind !== kind) return [];
        return [{ key: value.key, kind: value.kind, state: value.state, jobId: value.jobId, createdAt: value.createdAt,
            label: value.label, book: value.plan.target?.name ?? null, operation: value.plan.operation ?? null,
            resultHash: value.resultHash ?? null }];
    }).sort((a, b) => b.createdAt - a.createdAt));
}

export function withLabRecord(context, operation) {
    const base = { owner: context.owner, directories: context.directories };
    const identity = context.job.intent?.labs;
    if (!identity || !context.job.type.startsWith('labs.')) throw labError('The accepted Labs identity is missing.');
    return withRoleplayAccount(base, identity.account, lease => {
        const filename = filenameFor(base, identity.account, identity.key);
        let { file, value } = read(filename);
        if (!value || value.jobId !== context.job.id || value.planHash !== identity.planHash
            || roleplayHash(value.account) !== roleplayHash(identity.account)
            || value.kind !== context.job.type.slice(5)) throw labError('The job does not own this Labs record.');
        return operation({ lease, value, save: () => { file = save(filename, value, file); }, base, account: identity.account });
    });
}

/** Related proposal bookkeeping uses the caller's existing account lease. */
export function mutateLabRecordLocked(lease, key, operation) {
    const { scope } = roleplayLease(lease);
    const filename = filenameFor(scope, scope, key);
    const { file, value } = read(filename);
    if (!value || roleplayHash(value.account) !== roleplayHash(stamp(scope))) throw labError('The related Labs record is unavailable.');
    const result = operation(value);
    if (!result?.unchanged) save(filename, value, file);
    return result;
}

/** The complete plan is saved before a paused job can be accepted or released. */
export function admitLabJob(base, account, { key, kind, input, plan, label, applyTarget = null, validateLocked = () => {} }) {
    const planLimit = kind === 'prompting.transfer' ? 24 * 1024 * 1024 : 8 * 1024 * 1024;
    if (!/^[a-z][a-z.-]{0,63}$/.test(kind) || !plan || Buffer.byteLength(JSON.stringify(plan)) > planLimit) {
        throw labError('The Labs plan is invalid or too large.', 413);
    }
    const requestHash = roleplayHash({ kind, input });
    return withRoleplayAccount(base, account, lease => {
        const filename = filenameFor(base, account, key);
        let { file, value } = read(filename);
        if (value && (value.requestHash !== requestHash || roleplayHash(value.account) !== roleplayHash(account))) throw labError('This operation key already names different Labs work.');
        if (value && value.state !== 'preparing') return { created: false, job: value.jobId ? getJob(base.directories, value.jobId) : null, record: value };
        if (!value) {
            validateLocked(lease);
            reserve(base, applyTarget, account, kind);
            createRoleplayDirectory(directoryFor(base), roleplayStoreDirectory(base));
            value = { version: 1, key, account: stamp(account), kind, label, requestHash, plan, planHash: roleplayHash(plan),
                applyTarget, state: 'preparing', jobId: null, effects: {}, createdAt: Date.now() };
            file = save(filename, value, null);
        }
        const accepted = acceptJob(base.directories, { owner: base.owner, type: `labs.${kind}`, submissionKey: `labs:${account.accountId}:${key}`,
            intent: { labs: { key, account: stamp(account), planHash: value.planHash } },
            target: applyTarget || { kind: 'labs', id: roleplayHash([account.accountId, key]) }, paused: true, label: value.label });
        value.jobId = accepted.job.id;
        value.state = 'accepted';
        save(filename, value, file);
        return { ...accepted, record: value };
    });
}

export function finalizeLabSubmission(context) {
    if (!context.job.type.startsWith('labs.') || context.job.state !== 'waiting' || context.job.stage !== 'preparing') return;
    const identity = context.job.intent?.labs;
    if (!identity) throw labError('The paused Labs identity is missing.');
    withRoleplayAccount({ owner: context.owner, directories: context.directories }, identity.account, () => {
        const filename = filenameFor(context, identity.account, identity.key);
        const { file, value } = read(filename);
        if (!value || value.planHash !== identity.planHash || value.kind !== context.job.type.slice(5)
            || value.jobId && value.jobId !== context.job.id) throw labError('The paused Labs record needs recovery.');
        if (value.state === 'preparing') { value.jobId = context.job.id; value.state = 'accepted'; save(filename, value, file); }
    });
    releaseJob(context.directories, context.job.id);
}

export function finishLabJob(context, result) {
    return withLabRecord(context, ({ value, save }) => {
        if (value.state === 'completed') return value.result;
        if (value.state !== 'accepted' || Object.values(value.effects).some(effect => effect.state !== 'done')) throw labError('A Labs change still needs recovery.');
        value.result = result;
        value.resultHash = roleplayHash(result);
        value.state = 'completed';
        save();
        return result;
    });
}
