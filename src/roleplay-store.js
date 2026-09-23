import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual, TextDecoder, types } from 'node:util';
import sanitize from 'sanitize-filename';
import { acquireChatFileLock } from './chat-file-lock.js';
import { canonical, retireJobStore, validateOwner } from './jobs/store.js';
import { decodeFileWriteRecovery, fsyncDirectorySync, setFileWriteRecoveryGuard, tryWriteFileSync, FILE_WRITE_RECOVERY_SUFFIX, FILE_WRITE_RECOVERY_MAX_BYTES } from './util.js';

export const ROLEPLAY_STORE_MAX_BYTES = 16 * 1024 * 1024;
export const ROLEPLAY_RECOVERY_RESERVE_BYTES = 256 * 1024;
export const ROLEPLAY_LARGEST_PHYSICAL = Object.freeze(Object.fromEntries(['dev', 'ino', 'birthtimeNs'].map(key => [key, '9'.repeat(30)])));
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PENDING_MAX_BYTES = 64 * 1024;
const SUBMISSION_RESULT_MAX_BYTES = 2 * 1024;
export const ROLEPLAY_IMPORT_MAX_OUTPUTS = 64;
const IMPORT_RESULT_MAX_BYTES = 32 * 1024;
const DEFER_SEQUENCE_MAX_LENGTH = 256;
const RESERVED_IDENTIFIERS = new Set(['.', '..', '__proto__', 'constructor', 'prototype']);
const leases = new WeakMap();
const observedAccounts = new Map();
const activeAccountLeases = new Map();

export function roleplayError(code, message, status = 409) {
    return Object.assign(new Error(message), { code, status });
}

export function roleplayHash(value) {
    const json = JSON.stringify(value);
    if (json === undefined || !isDeepStrictEqual(JSON.parse(json), value)) {
        throw roleplayError('ROLEPLAY_INVALID', 'Roleplay identity requires JSON-only values.', 400);
    }
    return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

export function roleplayPathKey(stamp, kind, locator) {
    return roleplayHash([stamp.accountId, stamp.dataEpoch, kind, locator]);
}

export function roleplayAvatarOwner(avatar) {
    // Existing character storage removes the first occurrence, including embedded '.png'.
    return avatar.replace('.png', '');
}

export function validRoleplayAvatar(value) {
    return typeof value === 'string' && value.endsWith('.png') && Buffer.byteLength(value) <= 255
        && !/[\\/\0]/.test(value) && (process.platform !== 'win32' || value === sanitize(value))
        && roleplayAvatarOwner(value).length > 0 && !RESERVED_IDENTIFIERS.has(roleplayAvatarOwner(value));
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const damaged = () => roleplayError('ROLEPLAY_STORE_DAMAGED', 'Protected Roleplay evidence needs recovery and was left untouched.');

/** This directory is a sibling of user data, never an imported or reset user file. */
export function roleplayStoreDirectory({ owner, directories }) {
    validateOwner(owner);
    if (typeof directories?.root !== 'string' || !path.isAbsolute(directories.root)
        || path.basename(directories.root) !== owner || owner.startsWith('_')) {
        throw roleplayError('ROLEPLAY_INVALID', 'Roleplay storage requires server-resolved account directories.', 400);
    }
    return path.join(path.dirname(directories.root), '_roleplay', crypto.createHash('sha256').update(owner).digest('hex'));
}

function directory(filePath, create = false, allowMissing = false) {
    const parent = path.dirname(filePath);
    if (parent !== filePath && directory(parent, false, allowMissing) === false) return false;
    try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw damaged();
    } catch (error) {
        if (error.code === 'ENOENT' && allowMissing && !create) return false;
        if (error.code !== 'ENOENT' || !create) throw error;
        fs.mkdirSync(filePath, { mode: 0o700 });
        fsyncDirectorySync(parent);
    }
    return true;
}

/** Only a recorded lifecycle operation may call this for its server-resolved destination. */
export function createRoleplayDirectory(filename, ownedRoot) {
    if (!path.isAbsolute(filename) || !path.isAbsolute(ownedRoot)) throw damaged();
    filename = path.resolve(filename);
    ownedRoot = path.resolve(ownedRoot);
    if (filename !== ownedRoot && !filename.startsWith(ownedRoot + path.sep)) throw damaged();
    if (filename === ownedRoot) {
        directory(ownedRoot);
        return;
    }
    const parent = path.dirname(filename);
    createRoleplayDirectory(parent, ownedRoot);
    directory(filename, true);
    // An existing entry may be left by a mkdir whose parent flush failed.
    fsyncDirectorySync(parent);
}

function prepareDirectory(scope) {
    const root = roleplayStoreDirectory(scope);
    directory(path.dirname(root), true);
    directory(root, true);
    return root;
}

export function readRoleplayFile(filename, limit = ROLEPLAY_STORE_MAX_BYTES, { flush = false, allowMissingParent = false } = {}) {
    if (directory(path.dirname(filename), false, allowMissingParent) === false) return null;
    let stat;
    try { stat = fs.lstatSync(filename, { bigint: true }); } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(limit)) throw damaged();
    const fd = fs.openSync(filename, (flush ? fs.constants.O_RDWR : fs.constants.O_RDONLY)
        | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
        const current = fs.fstatSync(fd, { bigint: true });
        if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size) throw damaged();
        const bytes = Buffer.alloc(Number(stat.size));
        let offset = 0;
        while (offset < bytes.length) {
            const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (!read) break;
            offset += read;
        }
        if (flush) {
            fs.fsyncSync(fd);
            fsyncDirectorySync(path.dirname(filename));
        }
        const after = fs.fstatSync(fd, { bigint: true });
        if (after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs
            || after.nlink !== 1n || offset !== Number(stat.size)) throw damaged();
        const finalPath = fs.lstatSync(filename, { bigint: true });
        if (!finalPath.isFile() || finalPath.nlink !== 1n || finalPath.dev !== after.dev || finalPath.ino !== after.ino
            || finalPath.size !== after.size || finalPath.mtimeNs !== after.mtimeNs || finalPath.ctimeNs !== after.ctimeNs) throw damaged();
        return { bytes, rawHash: crypto.createHash('sha256').update(bytes).digest('hex'),
            physical: { dev: String(after.dev), ino: String(after.ino), birthtimeNs: String(after.birthtimeNs) } };
    } finally { fs.closeSync(fd); }
}

/** An oversized sidecar component cannot exist; errors on the active path or its parents still propagate. */
export function readRoleplayWriteJournal(filename, options = {}) {
    const journalPath = filename + FILE_WRITE_RECOVERY_SUFFIX;
    try { return readRoleplayFile(journalPath, FILE_WRITE_RECOVERY_MAX_BYTES, options); } catch (error) {
        if (error.code === 'ENAMETOOLONG' && error.path === journalPath && Buffer.byteLength(path.basename(journalPath)) > 255) return null;
        throw error;
    }
}

function decodeJson(file) {
    if (!file) return undefined;
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)); } catch { throw damaged(); }
}

function assertSameFile(current, expected) {
    if ((!current !== !expected) || (current && (current.rawHash !== expected.rawHash || !isDeepStrictEqual(current.physical, expected.physical)))) {
        throw roleplayError('ROLEPLAY_STORE_CHANGED', 'Protected Roleplay evidence changed after it was read and was left untouched.');
    }
}

function writeJson(filename, value, expected = null) {
    const text = JSON.stringify(value);
    const limit = path.basename(filename) === 'identity.json' ? 4096 : ROLEPLAY_STORE_MAX_BYTES;
    if (Buffer.byteLength(text) > limit) throw roleplayError('ROLEPLAY_STORE_FULL', 'Protected Roleplay evidence is full.', 413);
    const intendedHash = crypto.createHash('sha256').update(text).digest('hex');
    const validateBeforeReplace = () => assertSameFile(readRoleplayFile(filename, limit), expected);
    validateBeforeReplace();
    try {
        tryWriteFileSync(filename, text, { encoding: 'utf8', mode: 0o600 }, expected
            ? { replaceFileOnly: true, expectedFileIdentity: { dev: BigInt(expected.physical.dev), ino: BigInt(expected.physical.ino) }, validateBeforeReplace }
            : { expectedFileAbsent: true, durable: true, preserveOnCreateError: true });
        const written = readRoleplayFile(filename, limit);
        if (!written || written.bytes.toString('utf8') !== text) throw damaged();
        return written;
    } catch (cause) {
        throw Object.assign(roleplayError('ROLEPLAY_STORE_UNCERTAIN', 'Reconcile protected Roleplay evidence before retrying this operation.'),
            { cause, roleplayWriteUncertain: true, publication: path.basename(filename), intendedHash });
    }
}

/** Pure path-safety rule mirrored from generation/roleplay-source.js for stored records. */
function safeIdentifier(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 256
        && value === sanitize(value) && !RESERVED_IDENTIFIERS.has(value);
}

/** The exact locator a resource of this kind may persist, or null when malformed. */
function storedLocator(kind, value) {
    if (kind === 'chat') {
        if (!object(value) || typeof value.group !== 'boolean'
            || Object.keys(value).some(key => !['group', 'chat', 'avatar'].includes(key)) || !safeIdentifier(value.chat)) return null;
        if (value.group) return value.avatar ? null : { group: true, chat: value.chat };
        return validRoleplayAvatar(value.avatar) ? { group: false, chat: value.chat, avatar: value.avatar } : null;
    }
    if (kind === 'character') {
        return object(value) && Object.keys(value).length === 1 && validRoleplayAvatar(value.avatar) ? { avatar: value.avatar } : null;
    }
    if (kind === 'group') {
        return object(value) && Object.keys(value).length === 1 && safeIdentifier(value.groupId) ? { groupId: value.groupId } : null;
    }
    return null;
}

function isStoredLocator(kind, value) {
    const normalised = storedLocator(kind, value);
    return normalised !== null && isDeepStrictEqual(normalised, value);
}

function encodedBytes(value) {
    try { return Buffer.byteLength(canonical(value)); } catch { return Infinity; }
}

function validIntegrity(value) {
    return typeof value === 'string';
}

function validBackup(value) {
    return object(value) && typeof value.deferBackup === 'boolean'
        && Object.keys(value).every(key => ['deferBackup', 'deferSequenceId'].includes(key))
        && (value.deferSequenceId === undefined
            || (typeof value.deferSequenceId === 'string' && value.deferSequenceId.length <= DEFER_SEQUENCE_MAX_LENGTH));
}

function validAfter(after) {
    return object(after) && integer(after.revision) && after.revision >= 1
        && HASH.test(after.rawHash) && HASH.test(after.contentHash) && validIntegrity(after.integrity)
        && integer(after.byteLength) && after.byteLength <= 64 * 1024 * 1024
        && (after.writeId === null || UUID.test(after.writeId)) && after.payload === 'chat.after.jsonl';
}

const MESSAGE_ANCHOR_KEYS = ['index', 'recordHash', 'selectedSwipeId', 'selectedSwipeHash', 'selectedSwipeInfoHash'];
const RANGE_ANCHOR_KEYS = ['start', 'count', 'recordsHash', 'prefixHash', 'suffixHash'];

function validMessageAnchor(value) {
    return object(value) && Object.keys(value).length === MESSAGE_ANCHOR_KEYS.length
        && MESSAGE_ANCHOR_KEYS.every(key => Object.hasOwn(value, key))
        && integer(value.index) && HASH.test(value.recordHash) && HASH.test(value.selectedSwipeHash) && HASH.test(value.selectedSwipeInfoHash)
        && (value.selectedSwipeId === null || typeof value.selectedSwipeId === 'string' || Number.isFinite(value.selectedSwipeId));
}

function validRangeAnchor(value) {
    return object(value) && Object.keys(value).length === RANGE_ANCHOR_KEYS.length
        && RANGE_ANCHOR_KEYS.every(key => Object.hasOwn(value, key))
        && integer(value.start) && integer(value.count) && value.count >= 1
        && HASH.test(value.recordsHash) && HASH.test(value.prefixHash) && HASH.test(value.suffixHash);
}

function validSubmissionResult(value) {
    if (value?.kind === 'lifecycle') {
        return object(value) && Object.keys(value).length === 9 && value.mode === 'lifecycle' && LIFECYCLE_ACTION.test(value.action)
            && UUID.test(value.instanceId) && integer(value.revision) && value.revision >= 1 && HASH.test(value.rawHash)
            && value.integrity === '' && UUID.test(value.writeId) && value.changed === true;
    }
    if (value?.kind === 'import') {
        return object(value) && value.mode === 'create' && value.changed === true
            && UUID.test(value.instanceId) && value.revision === 1 && HASH.test(value.rawHash)
            && typeof value.integrity === 'string' && UUID.test(value.writeId)
            && Array.isArray(value.names) && value.names.length >= 1 && value.names.length <= ROLEPLAY_IMPORT_MAX_OUTPUTS
            && value.names.every(name => typeof name === 'string' && name.length > 0 && name.length <= 256)
            && Array.isArray(value.outputs) && value.outputs.length === value.names.length
            && value.outputs.every((output, index) => object(output) && output.name === value.names[index]
                && UUID.test(output.instanceId) && HASH.test(output.rawHash) && UUID.test(output.writeId))
            && (value.group === null || (object(value.group) && typeof value.group.id === 'string' && HASH.test(value.group.rawHash)))
            && value.outputs[0].instanceId === value.instanceId && value.outputs[0].rawHash === value.rawHash
            && encodedBytes(value) <= IMPORT_RESULT_MAX_BYTES;
    }
    return object(value) && UUID.test(value.instanceId) && integer(value.revision) && value.revision >= 1
        && HASH.test(value.rawHash) && validIntegrity(value.integrity) && UUID.test(value.writeId)
        && typeof value.changed === 'boolean' && ['update', 'create'].includes(value.mode)
        && (value.kind === undefined || (value.kind === 'group' && value.mode === 'update' && typeof value.rawChanged === 'boolean'))
        && (value.mode !== 'create' || (value.revision === 1 && value.changed))
        && encodedBytes(value) <= SUBMISSION_RESULT_MAX_BYTES;
}

function validCleanup(value) {
    if (!object(value) || Object.keys(value).length !== 2 || !object(value.payloads)) return false;
    if (Object.keys(value.payloads).some(name => LIFECYCLE_PAYLOAD.test(name))) {
        return value.journal === null && Object.entries(value.payloads).every(([name, hash]) => LIFECYCLE_PAYLOAD.test(name) && HASH.test(hash));
    }
    if (Object.hasOwn(value.payloads, 'import.chat.0.jsonl')) {
        return value.journal === null && Object.keys(value.payloads).every(name =>
            /^import\.chat\.\d+\.jsonl$|^import\.memory\.\d+\.(?:archive|guard)\.json$|^import\.group\.after\.json$/.test(name)
                && HASH.test(value.payloads[name]));
    }
    if (Object.hasOwn(value.payloads, 'group.after.json')) {
        return Object.keys(value.payloads).length === 1 && HASH.test(value.payloads['group.after.json']) && value.journal === null;
    }
    if (!HASH.test(value.payloads['chat.after.jsonl'])
        || Object.hasOwn(value.payloads, 'memory.archive.json') !== Object.hasOwn(value.payloads, 'memory.guard.json')
        || Object.entries(value.payloads).some(([name, hash]) => !['chat.after.jsonl', 'memory.archive.json', 'memory.guard.json'].includes(name) || !HASH.test(hash))) return false;
    return value.journal === null || (object(value.journal) && Object.keys(value.journal).length === 3
        && isStoredLocator('chat', value.journal.locator) && HASH.test(value.journal.rawHash) && validPhysical(value.journal.physical));
}

function validateState(state, identity) {
    if (!object(state) || state.schema !== 1 || state.storageId !== identity.storageId || state.owner !== identity.owner
        || !UUID.test(state.accountId) || !integer(state.dataEpoch) || state.dataEpoch < 1 || !integer(state.revision)
        || !['ready', 'maintenance', 'deleted', 'recovery-required'].includes(state.status)
        || !object(state.paths) || !object(state.resources) || !object(state.submissions)
        || (state.pending !== null && !object(state.pending))) throw damaged();
    for (const [key, value] of Object.entries(state.resources)) {
        if (!UUID.test(key) || !object(value) || !UUID.test(value.accountId) || !integer(value.dataEpoch)
            || !['chat', 'character', 'group'].includes(value.kind) || !isStoredLocator(value.kind, value.locator)
            || !['live', 'deleted', 'replaced'].includes(value.status) || !integer(value.revision) || value.revision < 1
            || !object(value.head) || !HASH.test(value.head.rawHash) || !HASH.test(value.head.contentHash)
            || !validPhysical(value.head.physical)
            || (value.head.writeId !== null && !UUID.test(value.head.writeId))
             || (value.busySubmission !== null && !Object.hasOwn(state.submissions, value.busySubmission))) throw damaged();
    }
    for (const [key, value] of Object.entries(state.paths)) {
        if (!HASH.test(key) || !object(value) || !integer(value.generation)
            || (value.instanceId !== null && !Object.hasOwn(state.resources, value.instanceId))) throw damaged();
        const resource = state.resources[value.instanceId];
        // Retired paths keep their original account and epoch, not the current account's stamp.
        if (resource && key !== roleplayPathKey(resource, resource.kind, resource.locator)) throw damaged();
    }
    for (const [key, value] of Object.entries(state.submissions)) {
        if (!HASH.test(key) || !object(value) || !UUID.test(value.accountId) || !integer(value.dataEpoch)
            || !HASH.test(value.intentHash) || (value.jobId !== null && !UUID.test(value.jobId))
            || !Object.hasOwn(state.resources, value.targetInstanceId)
            || !['preparing', 'accepted', 'closed', 'void'].includes(value.state)
            || !integer(value.reservedReceiptBytes) || !object(value.effects)
            || (value.state === 'closed' && Object.keys(value.effects).length === 0)
             || (value.state === 'closed' && !validSubmissionResult(value.outcome))
             || (value.outcome !== undefined && value.outcome !== null && !validSubmissionResult(value.outcome))
             || (value.outcome?.kind === 'import' && !HASH.test(value.requestHash))) throw damaged();
        const target = state.resources[value.targetInstanceId];
        if (target.accountId !== value.accountId || target.dataEpoch !== value.dataEpoch
            || (value.outcome?.kind === 'group' && target.kind !== 'group')
            || (value.outcome?.kind === 'import' && target.kind !== 'chat')) throw damaged();
        for (const [effectKey, effect] of Object.entries(value.effects)) {
            if (!HASH.test(effectKey) || !object(effect) || !HASH.test(effect.effectHash) || !UUID.test(effect.writeId)
                || !Object.hasOwn(state.resources, effect.instanceId) || !integer(effect.appliedRevision)
                 || (value.state === 'closed' && !validSubmissionResult(effect.result))
                 || (effect.result !== undefined && effect.result !== null && !validSubmissionResult(effect.result))) throw damaged();
            if (effect.instanceId !== value.targetInstanceId || effect.effectHash !== value.intentHash) throw damaged();
            if (effect.result && (effect.result.instanceId !== effect.instanceId || effect.result.revision !== effect.appliedRevision
                || effect.result.writeId !== effect.writeId || (value.outcome && !isDeepStrictEqual(effect.result, value.outcome)))) throw damaged();
            if (effect.cleanup !== undefined && (!validCleanup(effect.cleanup)
                || (effect.result?.kind === 'lifecycle' ? Object.keys(effect.cleanup.payloads).some(name => !LIFECYCLE_PAYLOAD.test(name))
                    : effect.result?.kind === 'import'
                        ? effect.result.outputs.some((output, index) => effect.cleanup.payloads[`import.chat.${index}.jsonl`] !== output.rawHash)
                        || (effect.result.group && effect.cleanup.payloads['import.group.after.json'] !== effect.result.group.rawHash)
                        : (effect.cleanup.payloads['group.after.json'] ?? effect.cleanup.payloads['chat.after.jsonl']) !== effect.result?.rawHash)
                || (effect.result?.kind === 'group') !== Object.hasOwn(effect.cleanup.payloads, 'group.after.json')
                || (effect.result.mode === 'create' && effect.cleanup.journal !== null))) throw damaged();
        }
    }
    if (state.pending !== null) {
        if (state.pending.kind === 'group-update') validateGroupTransaction(state.pending, state);
        else if (state.pending.kind === 'chat-import') validateImportTransaction(state.pending, state);
        else if (state.pending.kind === 'lifecycle') validateLifecycleTransaction(state.pending, state);
        else if (state.pending.kind === 'account-reset') validateResetTransaction(state.pending, state);
        else validateChatTransaction(state.pending, state);
    }
    return state;
}

function load(scope, allowUninitialised = false) {
    const root = roleplayStoreDirectory(scope);
    const identityFile = readRoleplayFile(path.join(root, 'identity.json'), 4096);
    if (!identityFile && allowUninitialised && !readRoleplayFile(path.join(root, 'state.json'))) {
        throw roleplayError('ROLEPLAY_ACCOUNT_UNAVAILABLE', 'Protected storage has not been prepared for this account.', 503);
    }
    const identity = decodeJson(identityFile);
    if (!identity || identity.schema !== 1 || identity.owner !== scope.owner || !UUID.test(identity.storageId)
        || identity.phase !== 'ready') throw damaged();
    const stateFile = readRoleplayFile(path.join(root, 'state.json'));
    const saved = decodeJson(stateFile);
    if (!object(saved) || !HASH.test(saved.hash) || roleplayHash(saved.state) !== saved.hash) throw damaged();
    return { root, identity, identityFile, stateFile, state: validateState(saved.state, identity) };
}

function stamp(scope, state) {
    return { owner: scope.owner, directories: scope.directories, accountId: state.accountId, dataEpoch: state.dataEpoch };
}

function save(root, identity, state, expected = null) {
    validateState(state, identity);
    const saved = { hash: roleplayHash(state), state };
    const reserved = Object.values(state.submissions).reduce((sum, item) => sum + item.reservedReceiptBytes, state.pending?.reservedBytes ?? 0);
    if (!Number.isSafeInteger(reserved) || Buffer.byteLength(JSON.stringify(saved)) + reserved > ROLEPLAY_STORE_MAX_BYTES) {
        throw roleplayError('ROLEPLAY_STORE_FULL', 'Protected Roleplay evidence has no room for this change; existing records were retained.', 413);
    }
    return writeJson(path.join(root, 'state.json'), saved, expected);
}

function isCurrentResource(state, instanceId) {
    const resource = state.resources[instanceId];
    return resource?.accountId === state.accountId && resource?.dataEpoch === state.dataEpoch
        && state.paths[roleplayPathKey(state, resource.kind, resource.locator)]?.instanceId === instanceId;
}

function validateDependency(dependency, state) {
    if (!object(dependency) || !['character', 'group'].includes(dependency.kind)
        || !UUID.test(dependency.instanceId) || !integer(dependency.revision) || dependency.revision < 1
        || !HASH.test(dependency.contentHash)) throw damaged();
    const resource = state.resources[dependency.instanceId];
    if (!object(resource) || resource.kind !== dependency.kind || resource.status !== 'live'
        || !isCurrentResource(state, dependency.instanceId)
        || !integer(resource.revision) || resource.revision !== dependency.revision
        || !object(resource.head) || resource.head.contentHash !== dependency.contentHash
        || !isStoredLocator(dependency.kind, dependency.locator)
        || !isDeepStrictEqual(resource.locator, dependency.locator)) throw damaged();
}

function validateChatSource(pending, state) {
    const source = pending.source;
    if (!object(source) || source.accountId !== pending.accountId || source.dataEpoch !== pending.dataEpoch
        || !isStoredLocator('chat', source.locator) || !isDeepStrictEqual(source.locator, pending.locator)
        || !Array.isArray(source.dependencies)) throw damaged();
    for (const dependency of source.dependencies) validateDependency(dependency, state);
    if (new Set(source.dependencies.map(item => item.instanceId)).size !== source.dependencies.length
        || new Set(source.dependencies.map(item => roleplayHash([item.kind, item.locator]))).size !== source.dependencies.length) throw damaged();
    if (source.kind !== undefined) {
        if (source.kind !== 'storage' || source.dependencies.length !== 0 || source.groupId !== undefined
            || source.message !== undefined || source.range !== undefined) throw damaged();
    } else if (pending.locator.group) {
        if (!safeIdentifier(source.groupId)) throw damaged();
        const groups = source.dependencies.filter(item => item.kind === 'group');
        if (groups.length !== 1 || groups[0].locator.groupId !== source.groupId) throw damaged();
    } else if (source.groupId !== undefined || source.dependencies.length !== 1
        || source.dependencies[0].kind !== 'character' || source.dependencies[0].locator.avatar !== pending.locator.avatar) throw damaged();
    if (source.message !== undefined && !validMessageAnchor(source.message)) throw damaged();
    if (source.range !== undefined && !validRangeAnchor(source.range)) throw damaged();
    if (pending.mode === 'update') {
        if (!UUID.test(source.instanceId) || source.instanceId !== pending.instanceId
            || !integer(source.revision) || source.revision < 1 || !HASH.test(source.rawHash)) throw damaged();
        const resource = state.resources[source.instanceId];
        if (!object(resource) || resource.kind !== 'chat' || resource.status !== 'live'
            || !isCurrentResource(state, source.instanceId)
            || !object(resource.head) || !isDeepStrictEqual(resource.locator, source.locator)
            || resource.revision !== source.revision || resource.head.rawHash !== source.rawHash) throw damaged();
        const before = pending.before;
        if (!object(before) || before.revision !== resource.revision
            || before.rawHash !== resource.head.rawHash || before.contentHash !== resource.head.contentHash
            || !isDeepStrictEqual(before.physical, resource.head.physical)
            || before.writeId !== resource.head.writeId
            || !validIntegrity(before.integrity)) throw damaged();
        if (pending.changed ? pending.after.revision !== before.revision + 1 : pending.after.revision !== before.revision) throw damaged();
        if (pending.changed ? pending.after.writeId !== pending.id : pending.after.writeId !== before.writeId) throw damaged();
        if (pending.changed ? (pending.after.rawHash === before.rawHash || pending.after.contentHash === before.contentHash)
            : (pending.after.rawHash !== before.rawHash || pending.after.contentHash !== before.contentHash
                || pending.after.integrity !== before.integrity)) throw damaged();
    } else {
        if (source.instanceId !== undefined || source.revision !== undefined || source.rawHash !== undefined) throw damaged();
        if (pending.before !== null || !integer(pending.expectedVacancy)) throw damaged();
        if (pending.after.revision !== 1 || pending.changed !== true || pending.after.writeId !== pending.id) throw damaged();
        const vacancy = state.paths[roleplayPathKey(state, 'chat', pending.locator)];
        if (Object.hasOwn(state.resources, pending.instanceId) || vacancy?.instanceId
            || pending.expectedVacancy !== (vacancy?.generation ?? 0)) throw damaged();
    }
}

function validPendingMemory(memory, mode, locator) {
    if (memory === null) return true;
    const validFile = value => object(value) && HASH.test(value.rawHash) && validPhysical(value.physical);
    const validPair = value => object(value) && validFile(value.archive) && (value.guard === null || validFile(value.guard));
    if (!object(memory) || !['absent', 'existing', 'create'].includes(memory.kind)) return false;
    if (memory.kind === 'existing') return mode !== 'create' && validPair(memory.child);
    if (!isStoredLocator('chat', memory.parentLocator) || memory.parentLocator.group !== locator.group
        || memory.parentLocator.avatar !== locator.avatar || memory.parentLocator.chat === locator.chat) return false;
    if (memory.kind === 'absent') return memory.parent === null;
    return validPair(memory.parent) && UUID.test(memory.branchId) && HASH.test(memory.archiveHash)
        && HASH.test(memory.guardHash) && integer(memory.archiveBytes) && integer(memory.guardBytes)
        && memory.archiveBytes <= 256 * 1024 * 1024 && memory.guardBytes <= 256 * 1024 * 1024;
}

function validateChatTransaction(pending, state) {
    if (pending.schema !== 1 || pending.kind !== 'chat-write' || !UUID.test(pending.id)
        || pending.accountId !== state.accountId || pending.dataEpoch !== state.dataEpoch
        || !HASH.test(pending.operationKeyHash) || !HASH.test(pending.intentHash) || !UUID.test(pending.instanceId)
        || !['update', 'create'].includes(pending.mode) || !isStoredLocator('chat', pending.locator)
        || !['prepared', 'chat-applied', 'auxiliary'].includes(pending.phase) || typeof pending.changed !== 'boolean'
        || !integer(pending.reservedBytes) || pending.reservedBytes > ROLEPLAY_RECOVERY_RESERVE_BYTES
        || typeof pending.allowShrink !== 'boolean' || !validBackup(pending.backup) || !validAfter(pending.after)
        || (pending.force !== undefined && typeof pending.force !== 'boolean')
        || !object(pending.source)
        || (pending.appliedPhysical !== null && !validPhysical(pending.appliedPhysical))) throw damaged();
    validateChatSource(pending, state);
    if (pending.repair !== null && (!object(pending.repair) || !HASH.test(pending.repair.rawHash) || !validPhysical(pending.repair.physical))) throw damaged();
    if (pending.journal != null && (!object(pending.journal) || Object.keys(pending.journal).length !== 4
        || !HASH.test(pending.journal.rawHash) || !validPhysical(pending.journal.physical) || !HASH.test(pending.journal.nextHash)
        || pending.mode !== 'update' || pending.journal.originalHash !== pending.before.rawHash)) throw damaged();
    if (encodedBytes(pending) > PENDING_MAX_BYTES) throw damaged();
    if (!validPendingMemory(pending.memory, pending.mode, pending.locator)) throw damaged();
}

function validPhysical(value) {
    return object(value) && Object.keys(value).length === 3
        && ['dev', 'ino', 'birthtimeNs'].every(key => typeof value[key] === 'string' && /^\d{1,30}$/.test(value[key]));
}

function validateGroupTransaction(pending, state) {
    if (pending.schema !== 1 || pending.kind !== 'group-update' || !UUID.test(pending.id)
        || pending.accountId !== state.accountId || pending.dataEpoch !== state.dataEpoch
        || !HASH.test(pending.operationKeyHash) || !HASH.test(pending.intentHash) || !UUID.test(pending.instanceId)
        || !isStoredLocator('group', pending.locator) || !['prepared', 'group-applied'].includes(pending.phase)
        || typeof pending.changed !== 'boolean' || typeof pending.rawChanged !== 'boolean'
        || !integer(pending.reservedBytes) || pending.reservedBytes > ROLEPLAY_RECOVERY_RESERVE_BYTES
        || (pending.appliedPhysical !== null && !validPhysical(pending.appliedPhysical))
        || !object(pending.source) || pending.source.instanceId !== pending.instanceId
        || !integer(pending.source.revision) || pending.source.revision < 1 || !HASH.test(pending.source.rawHash)
        || !object(pending.before) || !integer(pending.before.revision) || pending.before.revision !== pending.source.revision
        || pending.before.rawHash !== pending.source.rawHash || !HASH.test(pending.before.contentHash)
        || !validPhysical(pending.before.physical)
        || (pending.before.writeId !== null && !UUID.test(pending.before.writeId))
        || !object(pending.after) || !HASH.test(pending.after.rawHash) || !HASH.test(pending.after.contentHash)
        || pending.after.payload !== 'group.after.json' || !integer(pending.after.byteLength)
        || pending.after.byteLength > 64 * 1024 * 1024
        || pending.after.revision !== pending.before.revision + Number(pending.changed)
        || pending.after.writeId !== (pending.rawChanged ? pending.id : pending.before.writeId)
        || pending.rawChanged !== (pending.after.rawHash !== pending.before.rawHash)
        || pending.changed !== (pending.after.contentHash !== pending.before.contentHash)
        || encodedBytes(pending) > PENDING_MAX_BYTES) throw damaged();
    const resource = state.resources[pending.instanceId];
    if (!resource || resource.kind !== 'group' || resource.status !== 'live'
        || resource.accountId !== state.accountId || resource.dataEpoch !== state.dataEpoch
        || !isDeepStrictEqual(resource.locator, pending.locator) || resource.revision !== pending.before.revision
        || !isDeepStrictEqual(resource.head, { rawHash: pending.before.rawHash, contentHash: pending.before.contentHash,
            physical: pending.before.physical, writeId: pending.before.writeId })
        || state.paths[roleplayPathKey(state, 'group', pending.locator)]?.instanceId !== pending.instanceId) throw damaged();
}

const LIFECYCLE_ACTION = /^[a-z][a-z-]{0,63}$/;
const LIFECYCLE_PAYLOAD = /^lifecycle\.\d+\.bin$/;
// ponytail: whole-entity deletes are one transaction; a pending record past 2 MiB is refused before any effect.
export const ROLEPLAY_LIFECYCLE_MAX_STEPS = 4096;
const LIFECYCLE_PENDING_MAX_BYTES = 2 * 1024 * 1024;
const LIFECYCLE_STEP_KEYS = {
    delete: ['op', 'kind', 'locator', 'instanceId', 'before'],
    move: ['op', 'kind', 'locator', 'instanceId', 'before', 'destination', 'destinationVacancy'],
    discard: ['op', 'kind', 'locator', 'before'],
    create: ['op', 'kind', 'locator', 'instanceId', 'expectedVacancy', 'after', 'physical'],
    update: ['op', 'kind', 'locator', 'instanceId', 'before', 'after', 'physical'],
};
const DATE_ADDED_ENTITIES = ['characters', 'groups'];

function validLifecycleTask(task) {
    if (!object(task)) return false;
    if (['chat-memory-remove', 'chat-recovery-clear'].includes(task.task)) return Object.keys(task).length === 2 && isStoredLocator('chat', task.locator);
    if (task.task === 'date-added-remove') return Object.keys(task).length === 3 && DATE_ADDED_ENTITIES.includes(task.entity) && safeIdentifier(task.id);
    if (task.task === 'date-added-create') {
        return Object.keys(task).length === 4 && DATE_ADDED_ENTITIES.includes(task.entity) && safeIdentifier(task.id) && integer(task.time);
    }
    if (task.task === 'source-memory-remove') {
        return Object.keys(task).length === 4 && validRoleplayAvatar(task.avatar) && typeof task.world === 'string' && task.world.length <= 256
            && typeof task.deleteChats === 'boolean';
    }
    if (task.task === 'character-memory-rename') {
        return Object.keys(task).length === 3 && validRoleplayAvatar(task.from) && validRoleplayAvatar(task.to);
    }
    if (task.task === 'chat-folder-move') return Object.keys(task).length === 3 && validRoleplayAvatar(task.from) && validRoleplayAvatar(task.to);
    if (task.task === 'chat-folder-remove') return Object.keys(task).length === 2 && validRoleplayAvatar(task.avatar);
    return task.task === 'chat-memory-rename' && Object.keys(task).length === 3
        && isStoredLocator('chat', task.from) && isStoredLocator('chat', task.to);
}

function validLifecycleBefore(before, tracked) {
    if (!tracked) return object(before) && Object.keys(before).length === 2 && HASH.test(before.rawHash) && validPhysical(before.physical);
    return object(before) && Object.keys(before).length === 5 && integer(before.revision) && before.revision >= 1
        && HASH.test(before.rawHash) && HASH.test(before.contentHash) && validPhysical(before.physical)
        && (before.writeId === null || UUID.test(before.writeId));
}

function validLifecycleAfter(after, revision) {
    return object(after) && Object.keys(after).length === 5 && after.revision === revision && HASH.test(after.rawHash)
        && HASH.test(after.contentHash) && integer(after.byteLength) && LIFECYCLE_PAYLOAD.test(after.payload);
}

function validateLifecycleTransaction(pending, state) {
    if (pending.schema !== 1 || !UUID.test(pending.id) || pending.accountId !== state.accountId || pending.dataEpoch !== state.dataEpoch
        || !HASH.test(pending.operationKeyHash) || !HASH.test(pending.intentHash) || !LIFECYCLE_ACTION.test(pending.action)
        || !['prepared', 'files-applied'].includes(pending.phase)
        || !integer(pending.reservedBytes) || pending.reservedBytes > ROLEPLAY_RECOVERY_RESERVE_BYTES
        || !Array.isArray(pending.steps) || pending.steps.length < 1 || pending.steps.length > ROLEPLAY_LIFECYCLE_MAX_STEPS
        || !pending.steps.some(step => step?.op !== 'discard')
        || !Array.isArray(pending.auxiliary) || pending.auxiliary.length > 2 * ROLEPLAY_LIFECYCLE_MAX_STEPS
        || !pending.auxiliary.every(validLifecycleTask)
        || encodedBytes(pending) > LIFECYCLE_PENDING_MAX_BYTES) throw damaged();
    const keys = new Set();
    const instances = new Set();
    const payloads = new Set();
    const physicals = new Set(Object.values(state.resources).map(resource => JSON.stringify(resource.head.physical)));
    for (const step of pending.steps) {
        const expected = LIFECYCLE_STEP_KEYS[step?.op];
        if (!object(step) || !expected || Object.keys(step).length !== expected.length || !expected.every(key => Object.hasOwn(step, key))
            || !['chat', 'character', 'group'].includes(step.kind) || !isStoredLocator(step.kind, step.locator)) throw damaged();
        const key = roleplayPathKey(state, step.kind, step.locator);
        if (keys.has(key)) throw damaged();
        keys.add(key);
        if (step.op === 'discard') {
            if (!validLifecycleBefore(step.before, false) || state.paths[key]?.instanceId
                || physicals.has(JSON.stringify(step.before.physical))) throw damaged();
            continue;
        }
        if (!UUID.test(step.instanceId) || instances.has(step.instanceId)) throw damaged();
        instances.add(step.instanceId);
        if (step.op === 'create' || step.op === 'update') {
            if (step.kind === 'chat' || !validLifecycleAfter(step.after, step.op === 'create' ? 1 : step.before?.revision + 1)
                || payloads.has(step.after.payload) || (step.physical !== null && !validPhysical(step.physical))) throw damaged();
            payloads.add(step.after.payload);
        }
        if (step.op === 'create') {
            if (Object.hasOwn(state.resources, step.instanceId) || state.paths[key]?.instanceId
                || (state.paths[key]?.generation ?? 0) !== step.expectedVacancy || !integer(step.expectedVacancy)) throw damaged();
            continue;
        }
        const { before } = step;
        const resource = state.resources[step.instanceId];
        if (!validLifecycleBefore(before, true)
            || !resource || resource.kind !== step.kind || resource.status !== 'live'
            || resource.accountId !== state.accountId || resource.dataEpoch !== state.dataEpoch
            || !isDeepStrictEqual(resource.locator, step.locator) || resource.revision !== before.revision
            || !isDeepStrictEqual(resource.head, { rawHash: before.rawHash, contentHash: before.contentHash,
                physical: before.physical, writeId: before.writeId })
            || state.paths[key]?.instanceId !== step.instanceId) throw damaged();
        if (step.op !== 'move') continue;
        if (!isStoredLocator(step.kind, step.destination) || isDeepStrictEqual(step.destination, step.locator)
            || (step.kind === 'chat' && step.destination.group !== step.locator.group)
            || !integer(step.destinationVacancy)) throw damaged();
        const destinationKey = roleplayPathKey(state, step.kind, step.destination);
        if (state.paths[destinationKey]?.instanceId || (state.paths[destinationKey]?.generation ?? 0) !== step.destinationVacancy
            || keys.has(destinationKey)) throw damaged();
        keys.add(destinationKey);
    }
}

export function roleplayImportPlan(pending) {
    return { target: pending.target, timestamp: pending.timestamp,
        outputs: pending.outputs.map(({ locator, instanceId, expectedVacancy, after, memory, memoryPayloads }) =>
            ({ locator, instanceId, expectedVacancy, after, memory, memoryPayloads })),
        group: pending.group && { locator: pending.group.locator, instanceId: pending.group.instanceId,
            before: pending.group.before, after: pending.group.after } };
}

function validateImportTransaction(pending, state) {
    if (pending.schema !== 1 || pending.kind !== 'chat-import' || !UUID.test(pending.id)
        || pending.accountId !== state.accountId || pending.dataEpoch !== state.dataEpoch
        || !HASH.test(pending.operationKeyHash) || !HASH.test(pending.requestHash) || !HASH.test(pending.planHash)
        || !object(pending.target) || typeof pending.target.group !== 'boolean'
        || (pending.target.group ? !isStoredLocator('group', { groupId: pending.target.groupId })
            : !validRoleplayAvatar(pending.target.avatar) || !object(pending.target.character)
                || !HASH.test(pending.target.character.rawHash) || !validPhysical(pending.target.character.physical))
        || !integer(pending.timestamp) || !['prepared', 'publishing', 'linking', 'linked'].includes(pending.phase)
        || !Array.isArray(pending.outputs) || pending.outputs.length < 1 || pending.outputs.length > ROLEPLAY_IMPORT_MAX_OUTPUTS
        || !integer(pending.reservedBytes) || pending.reservedBytes > ROLEPLAY_RECOVERY_RESERVE_BYTES
        || (pending.group !== null) !== pending.target.group) throw damaged();
    const names = new Set();
    const instances = new Set();
    for (const [index, output] of pending.outputs.entries()) {
        if (!object(output) || !isStoredLocator('chat', output.locator) || output.locator.group !== pending.target.group
            || (!pending.target.group && output.locator.avatar !== pending.target.avatar)
            || !UUID.test(output.instanceId) || !integer(output.expectedVacancy)
            || (output.physical !== null && !validPhysical(output.physical)) || typeof output.memoryDone !== 'boolean'
            || (output.memoryDone && output.physical === null)
            || !object(output.after) || output.after.revision !== 1 || !HASH.test(output.after.rawHash)
            || !HASH.test(output.after.contentHash) || typeof output.after.integrity !== 'string'
            || !UUID.test(output.after.writeId) || !integer(output.after.byteLength)
            || output.after.byteLength > 64 * 1024 * 1024 || output.after.payload !== `import.chat.${index}.jsonl`
            || !Array.isArray(output.memoryPayloads) || output.memoryPayloads.length > 2
            || output.memoryPayloads.some(item => !object(item) || !['archive', 'guard'].includes(item.kind)
                || !HASH.test(item.hash) || !integer(item.bytes) || item.bytes > 256 * 1024 * 1024)
            || !validPendingMemory(output.memory, 'create', output.locator)
            || (output.memory?.kind === 'create'
                ? output.memoryPayloads.length !== 2
                    || output.memoryPayloads.find(item => item.kind === 'archive')?.hash !== output.memory.archiveHash
                    || output.memoryPayloads.find(item => item.kind === 'archive')?.bytes !== output.memory.archiveBytes
                    || output.memoryPayloads.find(item => item.kind === 'guard')?.hash !== output.memory.guardHash
                    || output.memoryPayloads.find(item => item.kind === 'guard')?.bytes !== output.memory.guardBytes
                : output.memoryPayloads.length !== 0)
            || names.has(output.locator.chat) || instances.has(output.instanceId)
            || state.resources[output.instanceId]
            || state.paths[roleplayPathKey(state, 'chat', output.locator)]?.instanceId
            || (state.paths[roleplayPathKey(state, 'chat', output.locator)]?.generation ?? 0) !== output.expectedVacancy) throw damaged();
        names.add(output.locator.chat);
        instances.add(output.instanceId);
    }
    if (pending.group) {
        const group = pending.group;
        const resource = state.resources[group.instanceId];
        if (!object(group) || !isStoredLocator('group', group.locator) || group.locator.groupId !== pending.target.groupId
            || !UUID.test(group.instanceId) || !object(group.before) || !validPhysical(group.before.physical)
            || !HASH.test(group.before.rawHash) || !HASH.test(group.before.contentHash)
            || !integer(group.before.revision) || group.before.revision < 1
            || (group.before.writeId !== null && !UUID.test(group.before.writeId))
            || !object(group.after) || !HASH.test(group.after.rawHash) || !HASH.test(group.after.contentHash)
            || group.after.revision !== group.before.revision + 1 || group.after.writeId !== pending.id
            || group.after.payload !== 'import.group.after.json' || !integer(group.after.byteLength)
            || group.after.byteLength > 64 * 1024 * 1024
            || (group.appliedPhysical !== null && !validPhysical(group.appliedPhysical))
            || !resource || resource.kind !== 'group' || resource.status !== 'live'
            || resource.revision !== group.before.revision
            || !isDeepStrictEqual(resource.locator, group.locator)
            || !isDeepStrictEqual(resource.head, { rawHash: group.before.rawHash, contentHash: group.before.contentHash,
                physical: group.before.physical, writeId: group.before.writeId })) throw damaged();
    }
    if (roleplayHash(roleplayImportPlan(pending)) !== pending.planHash || encodedBytes(pending) > PENDING_MAX_BYTES) throw damaged();
}

export function largestRoleplayJournal(pending) {
    return pending?.mode === 'update' ? { rawHash: 'f'.repeat(64), physical: ROLEPLAY_LARGEST_PHYSICAL,
        originalHash: pending.before.rawHash, nextHash: 'f'.repeat(64) } : null;
}

/** Leave emergency capacity for bounded reconciliation rather than evicting older evidence. */
export function assertRoleplayTransactionCapacity(lease, pending, finalState) {
    const { state, identity } = roleplayLease(lease);
    // Reserve the largest recovery progress record before staging or publishing any content.
    const progress = pending && { ...state, pending: pending.kind === 'chat-import'
        ? { ...pending, phase: 'linked', outputs: pending.outputs.map(output => ({ ...output, physical: ROLEPLAY_LARGEST_PHYSICAL, memoryDone: true })),
            group: pending.group && { ...pending.group, appliedPhysical: ROLEPLAY_LARGEST_PHYSICAL } }
        : pending.kind === 'group-update'
            ? { ...pending, phase: 'group-applied', appliedPhysical: ROLEPLAY_LARGEST_PHYSICAL }
            : pending.kind === 'lifecycle' ? { ...pending, phase: 'files-applied', steps: pending.steps.map(step =>
                Object.hasOwn(step, 'physical') ? { ...step, physical: ROLEPLAY_LARGEST_PHYSICAL } : step) } : { ...pending, phase: 'chat-applied', appliedPhysical: ROLEPLAY_LARGEST_PHYSICAL,
                repair: { rawHash: pending.after.rawHash, physical: ROLEPLAY_LARGEST_PHYSICAL }, journal: largestRoleplayJournal(pending) } };
    for (const candidate of [{ ...state, pending }, progress, finalState].filter(Boolean)) {
        if (candidate.pending && encodedBytes(candidate.pending)
            > (candidate.pending.kind === 'lifecycle' ? LIFECYCLE_PENDING_MAX_BYTES : PENDING_MAX_BYTES)) {
            throw roleplayError('ROLEPLAY_STORE_FULL', 'Protected Roleplay evidence has no room for the complete transaction.', 413);
        }
        validateState(candidate, identity);
        const reserved = Object.values(candidate.submissions).reduce((sum, item) => sum + item.reservedReceiptBytes, candidate.pending?.reservedBytes ?? 0);
        const size = Buffer.byteLength(JSON.stringify({ hash: roleplayHash(candidate), state: candidate }));
        if (size + reserved > ROLEPLAY_STORE_MAX_BYTES - ROLEPLAY_RECOVERY_RESERVE_BYTES) {
            throw roleplayError('ROLEPLAY_STORE_FULL', 'Protected Roleplay evidence has no room for another transaction.', 413);
        }
    }
}

export function roleplayPayloadDirectory(lease, transactionId) {
    const { root } = roleplayLease(lease);
    if (!UUID.test(transactionId)) throw damaged();
    const filename = path.join(root, 'pending', transactionId);
    directory(filename, false, true);
    return filename;
}

function payloadPath(lease, transactionId, name) {
    if (!['chat.after.jsonl', 'chat.corrupt.jsonl', 'group.after.json', 'memory.archive.json', 'memory.guard.json'].includes(name)
        && !/^import\.chat\.\d+\.jsonl$|^import\.memory\.\d+\.(?:archive|guard)\.json$|^import\.group\.after\.json$/.test(name)
        && !LIFECYCLE_PAYLOAD.test(name)) throw damaged();
    return path.join(roleplayPayloadDirectory(lease, transactionId), name);
}

export function readRoleplayPayload(lease, transactionId, name, expectedHash, limit = 64 * 1024 * 1024) {
    const filename = payloadPath(lease, transactionId, name);
    const file = readRoleplayFile(filename, limit, { flush: true });
    if (!file || file.rawHash !== expectedHash) throw damaged();
    return { ...file, filename };
}

export function stageRoleplayPayload(lease, transactionId, name, bytes, limit = 64 * 1024 * 1024) {
    const filename = payloadPath(lease, transactionId, name);
    if (!Buffer.isBuffer(bytes) || bytes.length > limit) throw roleplayError('ROLEPLAY_INVALID', 'Invalid prepared Roleplay payload.', 413);
    createRoleplayDirectory(path.dirname(filename), roleplayLease(lease).root);
    const existing = readRoleplayFile(filename, limit);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (existing && existing.rawHash !== hash) throw damaged();
    if (!existing) tryWriteFileSync(filename, bytes, { mode: 0o600 }, { expectedFileAbsent: true, durable: true, preserveOnCreateError: true });
    return readRoleplayPayload(lease, transactionId, name, hash, limit);
}

function locked(scope, operation, initialise = false) {
    const root = initialise ? prepareDirectory(scope) : roleplayStoreDirectory(scope);
    if (!initialise && !directory(root, false, true)) {
        throw roleplayError('ROLEPLAY_ACCOUNT_UNAVAILABLE', 'Protected storage has not been prepared for this account.', 503);
    }
    const release = acquireChatFileLock(path.join(root, 'state.json'));
    let result;
    try { result = operation(root); } catch (failure) {
        try { release(); } catch (cause) { console.warn('Roleplay account lock cleanup also failed:', cause?.code || cause?.name); }
        throw failure;
    }
    try { release(); } catch (cause) {
        throw Object.assign(roleplayError('ROLEPLAY_STORE_UNCERTAIN', 'Reconcile the Roleplay operation after account lock cleanup failed.'),
            { cause, roleplayWriteUncertain: true });
    }
    return result;
}

/** Explicit startup bootstrap only; receipt reads never create an empty ledger. */
export function initialiseRoleplayAccount(scope) {
    const result = locked(scope, root => {
        const markerPath = path.join(root, 'identity.json');
        let markerFile = readRoleplayFile(markerPath, 4096);
        let marker = decodeJson(markerFile);
        if (marker?.phase === 'ready') {
            const loaded = load(scope);
            assertSameFile(readRoleplayFile(markerPath, 4096, { flush: true }), loaded.identityFile);
            assertSameFile(readRoleplayFile(path.join(root, 'state.json'), ROLEPLAY_STORE_MAX_BYTES, { flush: true }), loaded.stateFile);
            return stamp(scope, loaded.state);
        }
        if (marker === undefined) {
            if (fs.readdirSync(root).some(name => name !== path.basename(path.join(root, 'state.json')) && !name.endsWith('.lock'))
                || fs.existsSync(path.join(root, 'state.json'))) throw damaged();
            marker = { schema: 1, owner: scope.owner, storageId: crypto.randomUUID(), initialAccountId: crypto.randomUUID(), phase: 'initialising' };
            markerFile = writeJson(markerPath, marker);
        }
        if (!object(marker) || marker.schema !== 1 || marker.owner !== scope.owner || !UUID.test(marker.storageId)
            || !UUID.test(marker.initialAccountId) || marker.phase !== 'initialising') throw damaged();
        assertSameFile(readRoleplayFile(markerPath, 4096, { flush: true }), markerFile);
        const existing = decodeJson(readRoleplayFile(path.join(root, 'state.json')));
        if (existing !== undefined) {
            if (!object(existing) || existing.hash !== roleplayHash(existing.state) || existing.state.accountId !== marker.initialAccountId
                || existing.state.revision !== 0) throw damaged();
            validateState(existing.state, marker);
            const confirmed = decodeJson(readRoleplayFile(path.join(root, 'state.json'), ROLEPLAY_STORE_MAX_BYTES, { flush: true }));
            if (!isDeepStrictEqual(confirmed, existing)) throw damaged();
        } else {
            save(root, marker, { schema: 1, owner: scope.owner, storageId: marker.storageId, accountId: marker.initialAccountId,
                dataEpoch: 1, revision: 0, status: 'ready', paths: {}, resources: {}, submissions: {}, pending: null });
        }
        writeJson(markerPath, { ...marker, phase: 'ready' }, markerFile);
        return stamp(scope, load(scope).state);
    }, true);
    observedAccounts.set(path.resolve(scope.directories.root), { ...scope, accountId: result.accountId, dataEpoch: result.dataEpoch });
    return result;
}

const RESET_KEYS = ['schema', 'kind', 'id', 'mode', 'dataEpoch', 'phase'];

function validateResetTransaction(pending, state) {
    if (Object.keys(pending).length !== RESET_KEYS.length || RESET_KEYS.some(name => !Object.hasOwn(pending, name))
        || pending.schema !== 1 || !UUID.test(pending.id) || !['reset', 'purge'].includes(pending.mode)
        || pending.dataEpoch !== state.dataEpoch + 1 || pending.phase !== 'prepared' || state.status !== 'maintenance') throw damaged();
}

function finishAccountReset(scope, root, identity, state, stateFile) {
    const { pending } = state;
    // Old jobs and artefacts stay beside the ledger; late callbacks then find neither their job nor their epoch.
    retireJobStore(scope.directories, path.join(root, 'retired', `${state.dataEpoch}-${pending.id}`, 'jobs'));
    const userRoot = scope.directories.root;
    for (const name of fs.existsSync(userRoot) ? fs.readdirSync(userRoot) : []) {
        if (name !== 'jobs') fs.rmSync(path.join(userRoot, name), { recursive: true, force: true });
    }
    // ponytail: a purge leaves the empty jobs lock folder; account recreation reuses it.
    const resources = Object.fromEntries(Object.entries(state.resources)
        .map(([id, resource]) => [id, resource.status === 'live' ? { ...resource, status: 'deleted' } : resource]));
    const next = { ...state, revision: state.revision + 1, dataEpoch: pending.dataEpoch,
        status: pending.mode === 'purge' ? 'deleted' : 'ready', paths: {}, resources, pending: null };
    save(root, identity, next, stateFile);
    const key = path.resolve(userRoot);
    if (next.status === 'ready') observedAccounts.set(key, stamp(scope, next));
    else observedAccounts.delete(key);
    return stamp(scope, next);
}

/**
 * Replace the account's saved data with a new data epoch ('reset') or retire it ('purge').
 * The maintenance record is durable before any file is touched; receipts are kept.
 */
export function resetRoleplayAccount(base, expected, mode) {
    if (!['reset', 'purge'].includes(mode)) throw new TypeError('Unknown account reset mode.');
    return locked(base, root => {
        const loaded = load(base);
        let { state, stateFile } = loaded;
        if (expected) assertAccountIdentity(expected, state);
        if (state.pending?.kind === 'account-reset') {
            if (state.pending.mode !== mode) throw roleplayError('ROLEPLAY_INTENT_CONFLICT', 'A different account reset is already in progress.');
        } else {
            if (mode === 'purge' && state.status === 'deleted') return stamp(base, state);
            assertRoleplayAccountCurrent(stamp(base, state), state);
            if (state.pending) throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'An earlier Roleplay operation must settle first.');
            state = { ...state, revision: state.revision + 1, status: 'maintenance',
                pending: { schema: 1, kind: 'account-reset', id: crypto.randomUUID(), mode, dataEpoch: state.dataEpoch + 1, phase: 'prepared' } };
            stateFile = save(root, loaded.identity, state, stateFile);
        }
        return finishAccountReset(base, root, loaded.identity, state, stateFile);
    });
}

/** Startup: finish an interrupted reset. Returns the current stamp, or null for a retired account that must not be served. */
export function settleRoleplayAccountReset(base) {
    return locked(base, root => {
        const loaded = load(base);
        const current = loaded.state.pending?.kind === 'account-reset'
            ? finishAccountReset(base, root, loaded.identity, loaded.state, loaded.stateFile) : stamp(base, loaded.state);
        const retired = loaded.state.pending?.kind === 'account-reset' ? loaded.state.pending.mode === 'purge' : loaded.state.status === 'deleted';
        if (retired) observedAccounts.delete(path.resolve(base.directories.root));
        return retired ? null : current;
    });
}

/** A retired (purged) account name gets a fresh incarnation with a new account id and data epoch. */
export function recreateRoleplayAccount(base) {
    return locked(base, root => {
        const loaded = load(base);
        if (loaded.state.status !== 'deleted' || loaded.state.pending !== null) return stamp(base, loaded.state);
        const next = { ...loaded.state, revision: loaded.state.revision + 1, accountId: crypto.randomUUID(),
            dataEpoch: loaded.state.dataEpoch + 1, status: 'ready', paths: {} };
        save(root, loaded.identity, next, loaded.stateFile);
        observedAccounts.set(path.resolve(base.directories.root), stamp(base, next));
        return stamp(base, next);
    });
}

function assertAccountIdentity(scope, state) {
    if (scope.accountId !== state.accountId || scope.dataEpoch !== state.dataEpoch) {
        throw roleplayError('ROLEPLAY_ACCOUNT_CHANGED', 'The account or its saved data was replaced. Reload before continuing.');
    }
}

export function assertRoleplayAccountCurrent(scope, state = load(scope).state) {
    assertAccountIdentity(scope, state);
    if (state.status !== 'ready') throw roleplayError('ROLEPLAY_ACCOUNT_UNAVAILABLE', 'The account has unfinished maintenance or recovery.');
    return state;
}

export function readRoleplayAccount(scope) {
    return assertRoleplayAccountCurrent(scope);
}

/** Confirm an exact uncertain publication under a fresh lock without rewriting it. */
export function reconcileRoleplayAccount(scope, expectedHash) {
    if (typeof expectedHash !== 'string' || !HASH.test(expectedHash)) throw new TypeError('An exact intended ledger hash is required.');
    return locked(scope, root => {
        const loaded = load(scope);
        assertAccountIdentity(scope, loaded.state);
        if (loaded.stateFile.rawHash !== expectedHash) throw roleplayError('ROLEPLAY_PUBLICATION_DIFFERENT', 'The current protected ledger is not the intended publication.');
        assertSameFile(readRoleplayFile(path.join(root, 'identity.json'), 4096, { flush: true }), loaded.identityFile);
        assertSameFile(readRoleplayFile(path.join(root, 'state.json'), ROLEPLAY_STORE_MAX_BYTES, { flush: true }), loaded.stateFile);
        return loaded.state;
    });
}

/** The opaque lease permits synchronous nested storage work, not a lock bypass. */
export function withRoleplayAccountLock(scope, operation) {
    return withRoleplayAccount(scope, { accountId: scope.accountId, dataEpoch: scope.dataEpoch }, operation);
}

/** Explicit discovery uses null; mutating request handlers must supply their captured account stamp. */
export function withRoleplayAccount(base, expected, operation) {
    if (typeof operation !== 'function' || types.isAsyncFunction(operation)) throw new TypeError('Roleplay storage operations must be synchronous.');
    if (expected !== null && (!object(expected) || !UUID.test(expected.accountId) || !integer(expected.dataEpoch) || expected.dataEpoch < 1)) {
        throw roleplayError('ROLEPLAY_ACCOUNT_CHANGED', 'A saved account identity is required. Reload before continuing.');
    }
    return locked(base, () => {
        const loaded = load(base, expected === null);
        if (expected !== null) assertAccountIdentity(expected, loaded.state);
        const scope = stamp(base, loaded.state);
        assertRoleplayAccountCurrent(scope, loaded.state);
        const lease = Object.freeze({});
        const held = { ...loaded, scope, persistedRevision: loaded.state.revision, failure: null };
        leases.set(lease, held);
        activeAccountLeases.set(path.resolve(scope.directories.root), lease);
        try {
            const result = operation(lease, { accountId: scope.accountId, dataEpoch: scope.dataEpoch });
            if (result && typeof result.then === 'function') {
                Promise.resolve(result).catch(() => {});
                throw new TypeError('Roleplay storage operations must not return promises.');
            }
            if (held.failure) throw held.failure;
            return result;
        } finally { activeAccountLeases.delete(path.resolve(scope.directories.root)); leases.delete(lease); }
    });
}

export function roleplayLease(lease) {
    const held = leases.get(lease);
    if (!held) throw new TypeError('An active Roleplay account lock is required.');
    if (held.failure) throw held.failure;
    return held;
}

/** Keep the account lock through a legacy recovery or migration publication. */
export function withUntrackedRoleplayFiles(base, filenames, operation) {
    return withRoleplayAccount(base, null, lease => {
        assertUntrackedRoleplayFiles(lease, filenames);
        return operation();
    });
}

/** Returns the account scope when its protected store was bootstrapped, or null for ordinary storage that cannot hold tracked files. */
export function roleplayAccountBase(directories) {
    try {
        const base = { owner: path.basename(directories.root), directories };
        return fs.existsSync(path.join(roleplayStoreDirectory(base), 'identity.json')) ? base : null;
    } catch {
        return null;
    }
}

/** Classifies an account file as a protected Roleplay path, or null when it is ordinary storage. */
export function roleplayFileLocator(scope, filename) {
    const child = key => {
        const value = path.relative(scope.directories[key], filename);
        return value && value !== '..' && !value.startsWith('..' + path.sep) && !path.isAbsolute(value) ? value : null;
    };
    const character = child('characters');
    const group = child('groups');
    const groupChat = child('groupChats');
    const soloChat = child('chats');
    if (character && !character.includes(path.sep) && character.toLowerCase().endsWith('.png')) return { kind: 'character', locator: { avatar: character } };
    if (group && !group.includes(path.sep) && group.endsWith('.json')) return { kind: 'group', locator: { groupId: group.slice(0, -5) } };
    if (groupChat && !groupChat.includes(path.sep) && groupChat.endsWith('.jsonl')) return { kind: 'chat', locator: { group: true, chat: groupChat.slice(0, -6) } };
    if (soloChat && soloChat.endsWith('.jsonl') && soloChat.split(path.sep).length === 2) {
        const [avatar, chatFile] = soloChat.split(path.sep);
        return { kind: 'chat', locator: { group: false, avatar: avatar + '.png', chat: chatFile.slice(0, -6) } };
    }
    return null;
}

export function assertUntrackedRoleplayFiles(lease, filenames) {
    const { state, scope } = roleplayLease(lease);
    if (state.pending) throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'Pending protected Roleplay work must finish first.');
    for (const filename of filenames) {
        const found = roleplayFileLocator(scope, filename);
        if (!found) throw roleplayError('ROLEPLAY_INVALID', 'Legacy target is outside recognised account data.', 400);
        const { kind, locator } = found;
        const sameProtectedPath = value => {
            const saved = value.locator;
            const expected = value.kind === 'character' ? path.join(scope.directories.characters, saved.avatar)
                : value.kind === 'group' ? path.join(scope.directories.groups, saved.groupId + '.json')
                    : saved.group ? path.join(scope.directories.groupChats, saved.chat + '.jsonl')
                        : path.join(scope.directories.chats, roleplayAvatarOwner(saved.avatar), saved.chat + '.jsonl');
            return path.resolve(filename) === path.resolve(expected);
        };
        if (Object.values(state.resources).some(value => sameProtectedPath(value) || (value.kind === kind && isDeepStrictEqual(value.locator, locator)))
                || state.paths[roleplayPathKey(state, kind, locator)]
                || (state.pending?.kind === 'chat-write' && kind === 'chat' && isDeepStrictEqual(state.pending.locator, locator))) {
            throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'Legacy work cannot change an observed Roleplay file.');
        }
        const journal = readRoleplayWriteJournal(filename);
        const journalTarget = journal && decodeFileWriteRecovery(journal.bytes, 64 * 1024 * 1024);
        if (journal && !journalTarget) throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'Legacy recovery evidence could not be proved untracked.');
        // Aliases (hard links, symlinks) are untrackable; their lstat identity still must not match a protected file.
        const alias = fs.lstatSync(filename, { bigint: true, throwIfNoEntry: false });
        const physicals = [alias && { dev: String(alias.dev), ino: String(alias.ino), birthtimeNs: String(alias.birthtimeNs) }, journal?.physical].filter(Boolean);
        const protectedPhysicals = Object.values(state.resources).map(value => value.head.physical);
        if (state.pending) protectedPhysicals.push(state.pending.before?.physical, state.pending.appliedPhysical, state.pending.journal?.physical);
        if (physicals.some(physical => protectedPhysicals.some(saved => saved && isDeepStrictEqual(physical, saved)))
            || (journalTarget && protectedPhysicals.some(saved => saved && saved.dev === journalTarget.dev && saved.ino === journalTarget.ino
                && (!journalTarget.birthtime || saved.birthtimeNs === journalTarget.birthtime)))) {
            throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'Legacy work cannot change an observed Roleplay file.');
        }
    }
}

setFileWriteRecoveryGuard((filename, recover) => {
    const target = path.resolve(filename);
    const base = [...observedAccounts.values()].find(({ directories }) =>
        ['characters', 'groups', 'groupChats', 'chats'].some(key => {
            const relative = path.relative(directories[key], target);
            return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
        }));
    if (!base) return recover();
    try {
        const active = activeAccountLeases.get(path.resolve(base.directories.root));
        if (active) {
            assertUntrackedRoleplayFiles(active, [target]);
            return recover();
        }
        return withUntrackedRoleplayFiles(base, [target], recover);
    } catch (error) {
        if (error?.code?.startsWith('ROLEPLAY_')) return false;
        throw error;
    }
});

/** Confirm loaded write-ahead evidence before publishing content or acknowledging a saved receipt. */
export function confirmRoleplayAccount(lease) {
    const held = roleplayLease(lease);
    try {
        assertSameFile(readRoleplayFile(path.join(held.root, 'identity.json'), 4096, { flush: true }), held.identityFile);
        assertSameFile(readRoleplayFile(path.join(held.root, 'state.json'), ROLEPLAY_STORE_MAX_BYTES, { flush: true }), held.stateFile);
    } catch (failure) {
        held.failure = failure;
        throw failure;
    }
}

export function saveRoleplayAccount(lease) {
    const held = roleplayLease(lease);
    try {
        assertSameFile(readRoleplayFile(path.join(held.root, 'identity.json'), 4096), held.identityFile);
        const candidate = { ...held.state, revision: held.persistedRevision + 1 };
        held.stateFile = save(held.root, held.identity, candidate, held.stateFile);
        held.persistedRevision = candidate.revision;
        held.state.revision = candidate.revision;
        return candidate.revision;
    } catch (failure) {
        held.failure = failure;
        throw failure;
    }
}
