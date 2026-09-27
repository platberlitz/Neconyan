import fs from 'node:fs';
import path from 'node:path';
import { acceptJob, getJob, releaseJob } from './store.js';
import { readRoleplayFile, roleplayError, roleplayHash, roleplayLease, roleplayStoreDirectory,
    createRoleplayDirectory, withRoleplayAccount } from '../roleplay-store.js';
import { tryWriteFileSync } from '../util.js';

/** Permanent evidence for native workflows using the existing jobs runner. */
export function createOperationRecords({ namespace, label, errorCode, recordLimit, planLimit,
    storeLimit = 512 * 1024 * 1024, maximumRecordBytes = 64 * 1024 * 1024, canRelease = () => true,
    survivesReset = () => false, reconcile = () => false }) {
    if (!/^[a-z][a-z-]*$/.test(namespace)) throw new Error('Invalid operation namespace.');
    const labError = (message, status = 409) => roleplayError(errorCode, message.replaceAll('Labs', label), status);
    const states = new Set(['preparing', 'accepted', 'completed', 'refused']);
    const evidence = file => file ? { rawHash: file.rawHash, physical: file.physical } : null;
    const directoryFor = base => path.join(roleplayStoreDirectory(base), namespace);
    const stamp = account => ({ accountId: account.accountId, dataEpoch: account.dataEpoch });
    const belongs = (value, account) => roleplayHash(value.account) === roleplayHash(stamp(account))
        || survivesReset(value.kind) && value.account.accountId === account.accountId;

    function filenameFor(base, account, key) {
        if (typeof key !== 'string' || !key || key.length > 200) throw labError('A Labs operation key is required.', 400);
        return path.join(directoryFor(base), `${roleplayHash([account.accountId, key])}.json`);
    }

    function read(filename) {
        const file = readRoleplayFile(filename, maximumRecordBytes, { allowMissingParent: true });
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
        if (reserved > storeLimit) throw labError('Labs storage is full. Existing evidence was retained.', 413);
        const validate = () => {
            if (roleplayHash(evidence(readRoleplayFile(filename, maximumRecordBytes, { allowMissingParent: true })))
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
            if (used > storeLimit) throw labError('Labs storage has no room for another result. Existing records were retained.', 413);
            if (open && value.applyTarget && Object.keys(value.effects).length && roleplayHash(value.account) === roleplayHash(stamp(account))
            && roleplayHash(value.applyTarget) === roleplayHash(target)) throw labError('That target has an unfinished reviewed Labs change.');
        }
    }

    /** Called by ordinary authoring writers under the same account lock. */
    function assertLabsTargetIdle(lease, target) {
        const { scope } = roleplayLease(lease);
        for (const { value } of records(scope)) {
            if (!value) throw labError('A saved Labs record disappeared.');
            if (['preparing', 'accepted'].includes(value.state) && value.applyTarget && Object.keys(value.effects).length
            && roleplayHash(value.account) === roleplayHash(stamp(scope))
            && roleplayHash(value.applyTarget) === roleplayHash(target)) throw labError('This target has an unfinished reviewed Labs change.');
        }
    }

    /** Readback is independent of the disposable job ledger and its artefacts. */
    function readLabRecord(base, key) {
        return withRoleplayAccount(base, null, (lease, account) => {
            const filename = filenameFor(base, account, key);
            const { value, file } = read(filename);
            if (value && !belongs(value, account)) throw labError('This Labs operation belongs to an earlier account state.');
            if (value && reconcile(value, lease)) save(filename, value, file);
            return value;
        });
    }

    /** A rejected key stays rejected even if an earlier, delayed submission reaches admission later. */
    function refuseLabSubmission(base, account, { key, kind, ...input }, message) {
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

    function listLabRecords(base, kind = '') {
        return withRoleplayAccount(base, null, (_lease, account) => records(base).flatMap(({ value }) => {
            if (!value || !belongs(value, account) || kind && value.kind !== kind) return [];
            return [{ key: value.key, kind: value.kind, state: value.state, jobId: value.jobId, createdAt: value.createdAt,
                label: value.label, book: value.plan.target?.name ?? null, operation: value.plan.operation ?? null,
                resultHash: value.resultHash ?? null }];
        }).sort((a, b) => b.createdAt - a.createdAt));
    }

    function withLabRecord(context, operation) {
        const base = { owner: context.owner, directories: context.directories };
        const identity = context.job.intent?.[namespace];
        if (!identity || !context.job.type.startsWith(`${namespace}.`)) throw labError('The accepted Labs identity is missing.');
        const canTransition = survivesReset(context.job.type.slice(namespace.length + 1));
        return withRoleplayAccount(base, canTransition ? null : identity.account, (lease, currentAccount) => {
            const filename = filenameFor(base, identity.account, identity.key);
            let { file, value } = read(filename);
            if (!value || !belongs(value, currentAccount) || value.jobId !== context.job.id || value.planHash !== identity.planHash
            || roleplayHash(value.account) !== roleplayHash(identity.account)
            || value.kind !== context.job.type.slice(namespace.length + 1)) throw labError('The job does not own this Labs record.');
            return operation({ lease, value, save: () => { file = save(filename, value, file); }, base, account: identity.account });
        });
    }

    /** Related proposal bookkeeping uses the caller's existing account lease. */
    function mutateLabRecordLocked(lease, key, operation) {
        const { scope } = roleplayLease(lease);
        const filename = filenameFor(scope, scope, key);
        const { file, value } = read(filename);
        if (!value || roleplayHash(value.account) !== roleplayHash(stamp(scope))) throw labError('The related Labs record is unavailable.');
        const result = operation(value);
        if (!result?.unchanged) save(filename, value, file);
        return result;
    }

    /** The complete plan is saved before a paused job can be accepted or released. */
    function admitLabJob(base, account, { key, kind, input, plan, label, applyTarget = null, validateLocked = () => {} }) {
        if (!/^[a-z][a-z.-]{0,63}$/.test(kind) || !plan || Buffer.byteLength(JSON.stringify(plan)) > planLimit(kind)) {
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
            const accepted = acceptJob(base.directories, { owner: base.owner, type: `${namespace}.${kind}`, submissionKey: `${namespace}:${account.accountId}:${key}`,
                intent: { [namespace]: { key, account: stamp(account), planHash: value.planHash } },
                target: applyTarget || { kind: namespace, id: roleplayHash([account.accountId, key]) }, paused: true, label: value.label });
            value.jobId = accepted.job.id;
            value.state = 'accepted';
            save(filename, value, file);
            return { ...accepted, record: value };
        });
    }

    function finalizeLabSubmission(context) {
        if (!context.job.type.startsWith(`${namespace}.`) || context.job.state !== 'waiting' || context.job.stage !== 'preparing') return;
        const identity = context.job.intent?.[namespace];
        if (!identity) throw labError('The paused Labs identity is missing.');
        const ready = withRoleplayAccount({ owner: context.owner, directories: context.directories }, identity.account, () => {
            const filename = filenameFor(context, identity.account, identity.key);
            const { file, value } = read(filename);
            if (!value || value.planHash !== identity.planHash || value.kind !== context.job.type.slice(namespace.length + 1)
            || value.jobId && value.jobId !== context.job.id) throw labError('The paused Labs record needs recovery.');
            if (value.state === 'preparing') { value.jobId = context.job.id; value.state = 'accepted'; save(filename, value, file); }
            return canRelease(context, value);
        });
        if (ready) releaseJob(context.directories, context.job.id);
    }

    function finishLabJob(context, result) {
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

    return Object.freeze({ error: labError, assertTargetIdle: assertLabsTargetIdle, read: readLabRecord,
        refuse: refuseLabSubmission, list: listLabRecords, withRecord: withLabRecord, mutateLocked: mutateLabRecordLocked,
        admit: admitLabJob, finalize: finalizeLabSubmission, finish: finishLabJob });
}
