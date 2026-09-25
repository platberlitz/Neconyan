import fs from 'node:fs';
import path from 'node:path';
import { acceptJob, getJob } from '../jobs/store.js';
import { assertRoleplaySourceLocked } from './roleplay-source.js';
import { assertUntrackedRoleplayFiles, confirmRoleplayAccount, createRoleplayDirectory, readRoleplayFile,
    roleplayError, roleplayHash, roleplayLease, roleplayStoreDirectory, withRoleplayAccount } from '../roleplay-store.js';
import { fsyncDirectorySync, tryWriteFileSync } from '../util.js';
import { reserveJobApprovalCapacityLocked } from './job-approvals.js';

// Reserve enough for every allowed sprite replacement or 256-part speech result
// before accepting work, including file evidence and the final completion list.
const RECEIPT_LIMIT = 512 * 1024;
const STORE_LIMIT = 16 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const fail = (message, code = 'MEDIA_RECOVERY_REQUIRED') => roleplayError(code, message);
const stamp = media => ({ accountId: media.accountId, dataEpoch: media.dataEpoch });

function receiptPath(base, account, operationKey) {
    return path.join(roleplayStoreDirectory(base), 'media', `${roleplayHash([account.accountId, operationKey])}.json`);
}

function readReceipt(filename) {
    const file = readRoleplayFile(filename, RECEIPT_LIMIT, { allowMissingParent: true });
    if (!file) return { file: null, value: null };
    let value;
    try { value = JSON.parse(file.bytes.toString('utf8')); } catch { throw fail('The saved media receipt is unreadable.'); }
    if (value?.version !== 1 || !HASH.test(value.intentHash) || !HASH.test(value.targetHash)
        || !['preparing', 'accepted', 'closed'].includes(value.state)
        || !value.account || typeof value.effects !== 'object' || !value.effects || Array.isArray(value.effects)
        || value.state !== 'preparing' && typeof value.jobId !== 'string') {
        throw fail('The saved media receipt is invalid.');
    }
    return { file, value };
}

function saveReceipt(filename, value, baseline) {
    const content = JSON.stringify(value);
    if (Buffer.byteLength(content) > RECEIPT_LIMIT) throw fail('The saved media receipt is full.', 'MEDIA_STORE_FULL');
    const validate = () => {
        const current = readRoleplayFile(filename, RECEIPT_LIMIT, { allowMissingParent: true });
        if (roleplayHash(current ? { rawHash: current.rawHash, physical: current.physical } : null)
            !== roleplayHash(baseline ? { rawHash: baseline.rawHash, physical: baseline.physical } : null)) {
            throw fail('The saved media receipt changed before it could be written.');
        }
    };
    validate();
    try {
        tryWriteFileSync(filename, content, { encoding: 'utf8', mode: 0o600 }, baseline ? {
            replaceFileOnly: true, expectedFileIdentity: { dev: BigInt(baseline.physical.dev), ino: BigInt(baseline.physical.ino) },
            validateBeforeReplace: validate,
        } : { expectedFileAbsent: true, durable: true, preserveOnCreateError: true });
        const written = readRoleplayFile(filename, RECEIPT_LIMIT, { flush: true });
        if (!written || written.bytes.toString('utf8') !== content) throw fail('The media receipt was not confirmed.');
        return written;
    } catch (cause) {
        throw Object.assign(fail('Reconcile the saved media receipt before continuing.', 'MEDIA_RECEIPT_UNCERTAIN'), { cause });
    }
}

function reserveReceipt(base, filename, targetHash) {
    const directory = path.dirname(filename);
    createRoleplayDirectory(directory, roleplayStoreDirectory(base));
    let used = RECEIPT_LIMIT;
    for (const name of fs.readdirSync(directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const { file, value } = readReceipt(path.join(directory, name));
        if (!file) throw fail('A saved media receipt disappeared during admission.');
        if (value.targetHash === targetHash && value.state !== 'closed') {
            throw fail('The media target already has accepted work.', 'MEDIA_TARGET_BUSY');
        }
        used += value.state === 'closed' ? file.bytes.length : RECEIPT_LIMIT;
        if (used > STORE_LIMIT) throw fail('Media receipt storage is full; earlier ownership was retained.', 'MEDIA_STORE_FULL');
    }
}

/** An ordinary cooperating writer cannot replace an accepted native media target. */
export function assertNativeMediaTargetIdle(lease, target) {
    const { scope } = roleplayLease(lease);
    const directory = path.join(roleplayStoreDirectory(scope), 'media');
    readRoleplayFile(path.join(directory, '.media-path-check'), 1, { allowMissingParent: true });
    if (!fs.existsSync(directory)) return;
    const hash = roleplayHash([scope.accountId, scope.dataEpoch, target]);
    for (const name of fs.readdirSync(directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const { value } = readReceipt(path.join(directory, name));
        if (!value) throw fail('A saved media receipt disappeared.');
        if (value.targetHash === hash && value.state !== 'closed') throw fail('This media target has unfinished accepted work.', 'MEDIA_TARGET_BUSY');
    }
}

/** Private admission for media work. Ownership survives job history and imported account settings. */
export function admitNativeMediaJob(base, account, { operationKey, source, kind, request, target, approvalReservation = null }) {
    if (typeof operationKey !== 'string' || !operationKey || operationKey.length > 200
        || !/^[a-z][a-z-]{0,31}$/.test(kind) || !source || !request || !target
        || Buffer.byteLength(JSON.stringify(request)) > 2 * 1024 * 1024) {
        throw fail('The media request is incomplete or too large.', 'MEDIA_INVALID');
    }
    const intent = { media: { ...stamp(account), operationKey }, source, kind, request, target };
    const intentHash = roleplayHash(intent);
    const targetHash = roleplayHash([account.accountId, account.dataEpoch, target]);
    if (approvalReservation && (typeof approvalReservation.key !== 'string' || !approvalReservation.key
        || approvalReservation.key.length > 256 || !Number.isSafeInteger(approvalReservation.bytes))) {
        throw fail('The accepted media approval reservation is invalid.', 'MEDIA_INVALID');
    }
    return withRoleplayAccount(base, account, lease => {
        confirmRoleplayAccount(lease);
        const filename = receiptPath(base, account, operationKey);
        let { file, value } = readReceipt(filename);
        if (value && value.intentHash !== intentHash) throw fail('This media key already names different work.', 'MEDIA_INTENT_CONFLICT');
        if (value && value.state !== 'preparing') return { jobId: value.jobId, state: value.state, created: false, result: value.result ?? null };
        assertRoleplaySourceLocked(lease, source);
        if (!value) {
            if (approvalReservation) reserveJobApprovalCapacityLocked(lease, approvalReservation);
            reserveReceipt(base, filename, targetHash);
            value = { version: 1, account: stamp(account), intentHash, targetHash, jobId: null, state: 'preparing', effects: {},
                ...(approvalReservation ? { approvalReservation } : {}) };
            file = saveReceipt(filename, value, null);
        } else if (roleplayHash(value.approvalReservation ?? null) !== roleplayHash(approvalReservation)) {
            throw fail('The saved approval reservation differs from the accepted media request.', 'MEDIA_INTENT_CONFLICT');
        }
        const { job, created } = acceptJob(base.directories, { owner: base.owner, type: `media.${kind}`,
            submissionKey: `media:${account.accountId}:${operationKey}`, intent, target, paused: true });
        value.jobId = job.id;
        value.state = 'accepted';
        saveReceipt(filename, value, file);
        return { jobId: job.id, state: value.state, created, result: null };
    });
}

/** Synchronous receipt/file changes share the account lock; providers never run inside this callback. */
export function withNativeMediaReceipt(context, operation, { checkSource = true } = {}) {
    const base = { owner: context.owner, directories: context.directories };
    const intent = context.job.intent;
    if (!intent?.media || !intent.source) throw fail('The accepted media request is missing.');
    return withRoleplayAccount(base, stamp(intent.media), lease => {
        const filename = receiptPath(base, intent.media, intent.media.operationKey);
        let { file, value } = readReceipt(filename);
        if (!value || value.intentHash !== roleplayHash(intent) || value.jobId !== context.job.id
            || roleplayHash(value.account) !== roleplayHash(stamp(intent.media))) throw fail('The media job does not own this receipt.');
        const savedJob = getJob(context.directories, context.job.id);
        if (!savedJob || roleplayHash(savedJob.intent) !== value.intentHash) throw fail('The accepted media job changed.');
        if (checkSource && value.state !== 'closed') assertRoleplaySourceLocked(lease, intent.source);
        const save = () => { file = saveReceipt(filename, value, file); };
        return operation({ lease, value, save, base, account: stamp(intent.media) });
    });
}

/** Prove a child's completed result and exact file effects after its replayable job has been pruned. */
export function readNativeMediaJobProof(base, account, { operationKey, jobId, intentHash }) {
    if (typeof operationKey !== 'string' || !operationKey || typeof jobId !== 'string' || !jobId || !HASH.test(intentHash)) {
        throw fail('The media result ownership is incomplete.');
    }
    return withRoleplayAccount(base, account, () => {
        const { value } = readReceipt(receiptPath(base, account, operationKey));
        if (!value || value.jobId !== jobId || value.intentHash !== intentHash
            || roleplayHash(value.account) !== roleplayHash(stamp(account))) {
            throw fail('This media job does not own the saved result.');
        }
        if (value.state !== 'closed') return null;
        if (Object.values(value.effects).some(effect => effect.state !== 'done')) {
            throw fail('The saved media result has an unsettled file effect.');
        }
        return { result: structuredClone(value.result), effects: structuredClone(value.effects) };
    });
}

/** A parent can prove a child's completed result after the replayable job has been pruned. */
export function readNativeMediaJobResult(base, account, identity) {
    const proof = readNativeMediaJobProof(base, account, identity);
    return proof === null ? null : proof.result;
}

export function finishNativeMediaJob(context, result, { checkSource = true, checkLocked } = {}) {
    if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) throw fail('The media completion receipt is too large.', 'MEDIA_INVALID');
    roleplayHash(result);
    return withNativeMediaReceipt(context, ({ lease, value, save }) => {
        checkLocked?.(lease, value);
        if (value.state === 'closed') {
            if (roleplayHash(value.result) !== roleplayHash(result)) throw fail('This media job already recorded a different result.');
            return { result: value.result };
        }
        if (Object.values(value.effects).some(effect => effect.state !== 'done')) throw fail('A media file operation has not settled.');
        value.result = result;
        value.state = 'closed';
        save();
        return { result };
    }, { checkSource });
}

function destination(base, relative) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0')
        || relative.split('/').some(part => !part || part === '.' || part === '..')) throw fail('The media destination is invalid.', 'MEDIA_INVALID');
    const filename = path.resolve(base.directories.root, relative);
    if (!filename.startsWith(path.resolve(base.directories.root) + path.sep)) throw fail('The media destination is outside this account.');
    return filename;
}

export function mediaFileEvidence(file) { return file ? { rawHash: file.rawHash, physical: file.physical } : null; }

export function mediaDirectoryEvidence(filename) {
    const stat = fs.lstatSync(filename, { bigint: true, throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('A media directory is not a physical account directory.', 'MEDIA_SOURCE_CHANGED');
    return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
}

export function ensureNativeMediaDirectory(context, { relative, before }) {
    return withNativeMediaReceipt(context, ({ value, save, base }) => {
        const filename = destination(base, relative);
        const key = roleplayHash(['directory', relative]);
        let effect = value.effects[key];
        let current = mediaDirectoryEvidence(filename);
        if (effect?.state === 'done') {
            if (roleplayHash(effect.after) !== roleplayHash(current)) throw fail('The media directory was replaced.', 'MEDIA_SOURCE_CHANGED');
            return current;
        }
        if (effect && current) {
            if (!effect.before || roleplayHash(current) !== roleplayHash(effect.before)) throw fail('The unfinished media directory creation needs recovery.');
            effect.after = current;
            effect.state = 'done';
            save();
            return current;
        }
        if (effect?.before && !current) throw fail('The accepted media directory disappeared.', 'MEDIA_SOURCE_CHANGED');
        if (!effect) {
            if (roleplayHash(current) !== roleplayHash(before)) throw fail('The media directory changed before work began.', 'MEDIA_SOURCE_CHANGED');
            effect = { relative, before, state: 'creating' };
            value.effects[key] = effect;
            save();
        }
        createRoleplayDirectory(filename, base.directories.root);
        current = mediaDirectoryEvidence(filename);
        effect.after = current;
        effect.state = 'done';
        save();
        return current;
    });
}

/** Record intent before atomic publication; a saved file proves recovery without another provider call. */
export function publishNativeMediaFile(context, { relative, before, bytes, checkLocked }) {
    const outputHash = roleplayHash(Buffer.from(bytes).toString('base64'));
    return withNativeMediaReceipt(context, ({ lease, value, save, base }) => {
        const filename = destination(base, relative);
        assertUntrackedRoleplayFiles(lease, [filename]);
        const key = roleplayHash(['write', relative]);
        let effect = value.effects[key];
        if (effect && (effect.relative !== relative || effect.outputHash !== outputHash || roleplayHash(effect.before) !== roleplayHash(before))) {
            throw fail('The media file operation differs from its saved intent.');
        }
        let current = readRoleplayFile(filename, 25 * 1024 * 1024, { allowMissingParent: true });
        if (effect?.state === 'done') {
            if (roleplayHash(mediaFileEvidence(current)) !== roleplayHash(effect.after)) throw fail('The completed media file changed.', 'MEDIA_SOURCE_CHANGED');
            return effect.after;
        }
        checkLocked?.(lease, value);
        if (!effect) {
            if (roleplayHash(mediaFileEvidence(current)) !== roleplayHash(before)) throw fail('The media destination changed before publication.', 'MEDIA_SOURCE_CHANGED');
            effect = { relative, before, outputHash, state: 'writing' };
            value.effects[key] = effect;
            save();
        }
        const matchesOutput = current && roleplayHash(current.bytes.toString('base64')) === outputHash;
        if (!matchesOutput) {
            if (roleplayHash(mediaFileEvidence(current)) !== roleplayHash(before)) throw fail('The unfinished media publication needs recovery.');
            createRoleplayDirectory(path.dirname(filename), base.directories.root);
            const validate = () => {
                const fresh = readRoleplayFile(filename, 25 * 1024 * 1024);
                if (roleplayHash(mediaFileEvidence(fresh)) !== roleplayHash(before)) throw fail('The media file changed before replacement.', 'MEDIA_SOURCE_CHANGED');
            };
            tryWriteFileSync(filename, Buffer.from(bytes), { mode: 0o600 }, before ? {
                replaceFileOnly: true, expectedFileIdentity: { dev: BigInt(before.physical.dev), ino: BigInt(before.physical.ino) },
                validateBeforeReplace: validate,
            } : { expectedFileAbsent: true, durable: true, preserveOnCreateError: true });
            current = readRoleplayFile(filename, 25 * 1024 * 1024, { flush: true });
        }
        if (!current || roleplayHash(current.bytes.toString('base64')) !== outputHash) throw fail('The saved media output could not be confirmed.');
        effect.after = mediaFileEvidence(current);
        effect.state = 'done';
        save();
        return effect.after;
    });
}

/** Remove an old format only after its replacement is durable, recording the removal before it happens. */
export function removeReplacedMediaFile(context, { relative, before, replacement }) {
    return withNativeMediaReceipt(context, ({ lease, value, save, base }) => {
        const written = value.effects[roleplayHash(['write', replacement])];
        if (written?.state !== 'done') throw fail('The replacement must be saved before the old sprite can be removed.');
        const replacementFile = readRoleplayFile(destination(base, replacement), 25 * 1024 * 1024);
        if (roleplayHash(mediaFileEvidence(replacementFile)) !== roleplayHash(written.after)) throw fail('The saved replacement changed.');
        const filename = destination(base, relative);
        assertUntrackedRoleplayFiles(lease, [filename]);
        const key = roleplayHash(['remove', relative]);
        let effect = value.effects[key];
        const current = readRoleplayFile(filename, 25 * 1024 * 1024, { allowMissingParent: true });
        if (!effect) {
            if (!before || roleplayHash(mediaFileEvidence(current)) !== roleplayHash(before)) throw fail('The old sprite changed before removal.', 'MEDIA_SOURCE_CHANGED');
            value.effects[key] = effect = { relative, before, replacement, state: 'removing' };
            save();
        }
        if (effect.relative !== relative || effect.replacement !== replacement || roleplayHash(effect.before) !== roleplayHash(before)) throw fail('The saved removal differs from its accepted file.');
        if (current) {
            if (effect.state === 'done' || roleplayHash(mediaFileEvidence(current)) !== roleplayHash(before)) throw fail('The old sprite was replaced by unrelated work.', 'MEDIA_SOURCE_CHANGED');
            fs.unlinkSync(filename);
            fsyncDirectorySync(path.dirname(filename));
        }
        effect.state = 'done';
        save();
    });
}
