import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fsyncDirectorySync, tryWriteFileSync } from './util.js';
import { assertUntrackedRoleplayFiles, createRoleplayDirectory, readRoleplayFile, roleplayAccountBase,
    roleplayAccountStamp, roleplayHash, roleplayLease, withRoleplayAccount } from './roleplay-store.js';
import { assertNativeMediaTargetIdle } from './generation/media-receipts.js';
import { AGENT_STORAGE_LIMITS, getAgentRecordError, isAgentRecordId, isAgentSetupId, normalizeAgentGroup, normalizeAgentSetupPreset, serializeAgentRecord } from '../public/scripts/extensions/in-chat-agents/setup-presets.js';

export function agentRecordRevision(record) {
    return crypto.createHash('sha256').update(serializeAgentRecord(record)).digest('hex');
}

function validate(record, kind) {
    return kind === 'agent' ? !getAgentRecordError(record)
        : Boolean(kind === 'group' ? normalizeAgentGroup(record) : normalizeAgentSetupPreset(record));
}

function storageError(status, message) {
    return Object.assign(new Error(message), { status, code: 'AGENT_STORAGE_CHANGED' });
}

export function agentCollectionDirectory(directories, kind = 'agent') {
    const agents = directories.inChatAgents ?? (directories.root && path.join(directories.root, 'InChatAgents'));
    const directory = kind === 'agent' ? agents : kind === 'group'
        ? directories.inChatAgentGroups ?? (directories.root && path.join(directories.root, 'InChatAgentGroups'))
        : kind === 'preset' && agents ? path.join(agents, 'presets') : null;
    if (!directory || !directories.root || !path.isAbsolute(directory)
        || (directory !== directories.root && !directory.startsWith(directories.root + path.sep))) {
        throw storageError(409, 'The agent collection is outside this account.');
    }
    return directory;
}

function recordFile(directory, kind, id) {
    if (!(kind === 'preset' ? isAgentSetupId(id) : isAgentRecordId(id))) throw storageError(400, 'Invalid record identifier.');
    const filename = path.join(directory, `${id}.json`);
    const file = readRoleplayFile(filename, AGENT_STORAGE_LIMITS[`${kind}Bytes`], { allowMissingParent: true });
    if (!file) return null;
    let record;
    try { record = JSON.parse(file.bytes.toString('utf8')); } catch { throw storageError(409, 'The existing agent record needs recovery.'); }
    if (!validate(record, kind) || record.id !== id) throw storageError(409, 'The existing agent record needs recovery.');
    return { record, revision: agentRecordRevision(record), file: { rawHash: file.rawHash, physical: file.physical } };
}

/** Native actions use the same physical record checks while holding the account lease. */
export function readAgentRecordLocked(lease, kind, id) {
    const { scope } = roleplayLease(lease);
    const directory = agentCollectionDirectory(scope.directories, kind);
    assertUntrackedRoleplayFiles(lease, [path.join(directory, `${id}.json`)]);
    return recordFile(directory, kind, id);
}

function listRecordFiles(directory, kind) {
    const files = [];
    const limit = AGENT_STORAGE_LIMITS[`${kind}Count`];
    let inspected = 0;
    const entries = fs.opendirSync(directory);
    try {
        for (let entry; (entry = entries.readSync());) {
            if (++inspected > limit * 2 || files.length > limit) return { files: files.sort(), overflow: true };
            if (entry.name.toLowerCase().endsWith('.json')) files.push(entry.name);
        }
    } finally { entries.closeSync(); }
    return { files: files.sort(), overflow: files.length > limit };
}

export function readAgentCollection(directory, kind = 'agent', base = null) {
    if (base) {
        if (directory !== agentCollectionDirectory(base.directories, kind)) throw storageError(409, 'The agent collection changed.');
        return withRoleplayAccount(base, null, () => readAgentCollection(directory, kind));
    }
    const records = [], errors = [], revisions = {};
    readRoleplayFile(path.join(directory, '.agent-path-check'), 1, { allowMissingParent: true });
    if (!fs.existsSync(directory)) return { records, errors, revisions };
    const { files, overflow } = listRecordFiles(directory, kind);
    if (overflow) errors.push({ file: 'Collection', message: 'Too many records to load safely. Existing files were kept.' });
    let bytes = 0;
    for (const file of files.slice(0, AGENT_STORAGE_LIMITS[`${kind}Count`])) {
        try {
            const filename = path.join(directory, file);
            const size = Number(fs.lstatSync(filename).size);
            if (size > AGENT_STORAGE_LIMITS[`${kind}Bytes`] || bytes + size > AGENT_STORAGE_LIMITS.collectionBytes) throw new Error('Storage size limit exceeded.');
            bytes += size;
            const stored = recordFile(directory, kind, file.slice(0, -5));
            if (!stored) throw storageError(409, 'The agent record disappeared.');
            const record = stored.record;
            if (`${record.id}.json` !== file) throw new Error('Invalid record or mismatched file identifier.');
            if (Object.hasOwn(revisions, record.id)) throw new Error('Duplicate record identifier.');
            records.push(record);
            Object.defineProperty(revisions, record.id, { value: stored.revision, enumerable: true });
        } catch (error) {
            errors.push({ file, message: error.status === 409 ? 'The saved record needs recovery and was kept.' : 'Invalid or oversized saved record.' });
        }
    }
    return { records, errors, revisions };
}

/** Check native staged writes against the same record and collection limits as ordinary saves. */
export function assertAgentWriteCapacityLocked(lease, kind, record) {
    const { scope } = roleplayLease(lease);
    const directory = agentCollectionDirectory(scope.directories, kind);
    if (!validate(record, kind)) throw storageError(400, 'Invalid agent, kit or setup data.');
    const size = Buffer.byteLength(JSON.stringify(record));
    if (size > AGENT_STORAGE_LIMITS[`${kind}Bytes`]) throw storageError(413, 'Record storage size limit exceeded.');
    readRoleplayFile(path.join(directory, '.agent-path-check'), 1, { allowMissingParent: true });
    const { files, overflow } = fs.existsSync(directory) ? listRecordFiles(directory, kind) : { files: [], overflow: false };
    if (overflow) throw storageError(413, 'The collection exceeds its loading limit. Existing files were kept.');
    if (!files.includes(`${record.id}.json`) && files.length >= AGENT_STORAGE_LIMITS[`${kind}Count`]) throw storageError(413, 'Collection item limit exceeded.');
    const total = files.filter(name => name !== `${record.id}.json`).reduce((sum, name) => {
        const file = readRoleplayFile(path.join(directory, name), AGENT_STORAGE_LIMITS[`${kind}Bytes`]);
        if (!file) throw storageError(409, 'The agent collection changed.');
        return sum + file.bytes.length;
    }, size);
    if (total > AGENT_STORAGE_LIMITS.collectionBytes) throw storageError(413, 'Collection storage limit exceeded.');
}

/** Account-first, physical compare-and-write shared by HTTP and native tool actions. */
export function writeAgentRecordLocked(lease, kind, record, { remove = false, expectedRevision, expectedFile, beforePublish } = {}) {
    const { scope } = roleplayLease(lease);
    const directory = agentCollectionDirectory(scope.directories, kind);
    const id = record?.id;
    if (!(kind === 'preset' ? isAgentSetupId(id) : isAgentRecordId(id))) throw storageError(400, 'Invalid record identifier.');
    if (kind === 'agent') assertNativeMediaTargetIdle(lease, { kind: 'agent', id });
    const text = remove ? '' : JSON.stringify(record);
    const size = Buffer.byteLength(text);
    if (size > AGENT_STORAGE_LIMITS[`${kind}Bytes`]) throw storageError(413, 'Record storage size limit exceeded.');
    if (!remove && !validate(record, kind)) throw storageError(400, 'Invalid agent, kit or setup data.');
    const filename = path.join(directory, `${id}.json`);
    const previous = readAgentRecordLocked(lease, kind, id);
    if (expectedRevision !== undefined && (previous?.revision ?? 'missing') !== expectedRevision) {
        throw storageError(409, 'This record changed in another tab or device. Reload it before saving.');
    }
    if (expectedFile !== undefined && roleplayHash(previous?.file ?? null) !== roleplayHash(expectedFile)) throw storageError(409, 'The physical agent record changed.');
    const validateCurrent = () => {
        const current = readAgentRecordLocked(lease, kind, id);
        if (roleplayHash(current?.file ?? null) !== roleplayHash(previous?.file ?? null)) throw storageError(409, 'The agent record changed before publication.');
    };
    if (remove) {
        beforePublish?.();
        validateCurrent();
        if (previous) { fs.unlinkSync(filename); fsyncDirectorySync(directory); }
        return 'missing';
    }
    createRoleplayDirectory(directory, scope.directories.root);
    assertAgentWriteCapacityLocked(lease, kind, record);
    beforePublish?.();
    validateCurrent();
    if (previous?.file.rawHash === crypto.createHash('sha256').update(text).digest('hex')) return agentRecordRevision(record);
    tryWriteFileSync(filename, text, { mode: 0o600 }, previous ? {
        replaceFileOnly: true, expectedFileIdentity: { dev: BigInt(previous.file.physical.dev), ino: BigInt(previous.file.physical.ino) },
        validateBeforeReplace: validateCurrent,
    } : { expectedFileAbsent: true, durable: true, preserveOnCreateError: true });
    if (readRoleplayFile(filename, AGENT_STORAGE_LIMITS[`${kind}Bytes`], { flush: true })?.bytes.toString('utf8') !== text) {
        throw storageError(409, 'The saved agent record could not be confirmed.');
    }
    return agentRecordRevision(record);
}

export function writeAgentRecord(request, directory, kind, record, { remove = false } = {}) {
    const base = roleplayAccountBase(request.user.directories);
    if (!base || base.owner !== request.user.profile.handle) throw storageError(409, 'This account needs its protected agent store.');
    if (directory !== agentCollectionDirectory(base.directories, kind)) throw storageError(409, 'The agent collection changed.');
    const owner = request.get('X-Neconyan-Account');
    if (owner !== undefined && owner !== base.owner) throw storageError(409, 'The signed-in account changed. Reload the agent library.');
    return withRoleplayAccount(base, roleplayAccountStamp(base), lease => writeAgentRecordLocked(lease, kind, record,
        { remove, expectedRevision: request.get('If-Match') }));
}
