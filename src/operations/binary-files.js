import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRoleplayDirectory, inspectRoleplayFile, readRoleplayFile, roleplayHash, roleplayStoreDirectory, withRoleplayAccount } from '../roleplay-store.js';
import { fsyncDirectorySync, tryWriteFileSync } from '../util.js';
import { operationError, readOperation, withOperation } from './store.js';

export const BINARY_FILE_LIMIT = 8 * 1024 * 1024 * 1024;
const TOTAL_LIMIT = 32 * 1024 * 1024 * 1024;
const physical = stat => ({ dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) });
const evidence = file => file && ({ rawHash: file.rawHash, physical: file.physical });
const directory = base => path.join(roleplayStoreDirectory(base), 'application-binaries');

/** A permanent allocation refuses new work at capacity; previous files and proof are never evicted. */
export function prepareBinaryOutput(context, name, limit) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > BINARY_FILE_LIMIT) throw operationError('This saved binary exceeds its output capacity.', 413);
    return withOperation(context, ({ base, account, value, save }) => {
        const root = directory(base);
        createRoleplayDirectory(root, roleplayStoreDirectory(base));
        const id = roleplayHash([account.accountId, value.key, name]);
        const allocationPath = path.join(root, id + '.json');
        const allocation = { version: 1, id, accountId: account.accountId, key: value.key, name, limit };
        let used = 0;
        for (const file of fs.readdirSync(root).filter(file => /^[a-f0-9]{64}\.json$/.test(file))) {
            const stored = readRoleplayFile(path.join(root, file), 4096);
            let record;
            try { record = JSON.parse(stored.bytes); } catch { throw operationError('The saved binary allocation needs recovery.'); }
            if (record.version !== 1 || file !== record.id + '.json' || record.id !== roleplayHash([record.accountId, record.key, record.name])
                || !Number.isSafeInteger(record.limit) || record.limit < 1 || record.limit > BINARY_FILE_LIMIT) throw operationError('The saved binary allocation needs recovery.');
            used += record.limit;
            if (record.id === id && roleplayHash(record) !== roleplayHash(allocation)) throw operationError('This binary allocation belongs to different work.');
        }
        if (!readRoleplayFile(allocationPath, 4096)) {
            if (used + limit > TOTAL_LIMIT) throw operationError('Saved binary storage is full. Existing files and evidence were kept.', 413);
            tryWriteFileSync(allocationPath, JSON.stringify(allocation), { mode: 0o600 }, { expectedFileAbsent: true, durable: true, preserveOnCreateError: true });
        }
        const key = `binary:${name}`;
        let effect = value.effects[key];
        if (!effect) {
            const temporary = id + '.' + randomUUID() + '.pending';
            const fd = fs.openSync(path.join(root, temporary), 'wx', 0o600);
            try {
                fs.fsyncSync(fd); fsyncDirectorySync(root);
                effect = { state: 'prepared', id, temporary, physical: physical(fs.fstatSync(fd, { bigint: true })), limit, publication: null };
            } finally { fs.closeSync(fd); }
            value.effects[key] = effect; save();
        }
        if (effect.id !== id || effect.limit !== limit) throw operationError('The accepted binary output changed.');
        return { root, key, effect, filename: path.join(root, effect.temporary) };
    });
}

/** Rebuilding an unfinished local output never touches a published file or another file's inode. */
export function openBinaryOutput(context, prepared) {
    return withOperation(context, () => {
        if (prepared.effect.publication || prepared.effect.state === 'done') throw operationError('This output already has a recorded publication.');
        const file = inspectRoleplayFile(prepared.filename, prepared.effect.limit);
        if (!file || roleplayHash(file.physical) !== roleplayHash(prepared.effect.physical)) throw operationError('The unfinished binary was replaced. It was kept.');
        const fd = fs.openSync(prepared.filename, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
        if (roleplayHash(physical(fs.fstatSync(fd, { bigint: true }))) !== roleplayHash(file.physical)) {
            fs.closeSync(fd); throw operationError('The unfinished binary changed before writing.');
        }
        fs.ftruncateSync(fd, 0);
        return fd;
    });
}

export function publishBinaryOutput(context, prepared, result, { afterBinaryPublication } = {}) {
    return withOperation(context, ({ value, save }) => {
        const effect = value.effects[prepared.key];
        const destination = path.join(prepared.root, effect.id + '.data');
        if (effect.state === 'done') return effect.result;
        if (!effect.publication) {
            const file = inspectRoleplayFile(prepared.filename, effect.limit, { flush: true });
            if (!file || roleplayHash(file.physical) !== roleplayHash(effect.physical)) throw operationError('The prepared binary was replaced.');
            effect.publication = { ...evidence(file), size: file.size };
            effect.result = { ...result, binary: effect.id, size: file.size };
            save();
        }
        const current = inspectRoleplayFile(destination, effect.limit);
        if (!current || roleplayHash(evidence(current)) !== roleplayHash(evidence(effect.publication))) {
            if (current) throw operationError('Another file occupies this saved binary. It was kept.');
            const temporary = inspectRoleplayFile(prepared.filename, effect.limit);
            if (!temporary || roleplayHash(evidence(temporary)) !== roleplayHash(evidence(effect.publication))) throw operationError('The prepared binary needs recovery.');
            fs.renameSync(prepared.filename, destination); fsyncDirectorySync(prepared.root);
        }
        const written = inspectRoleplayFile(destination, effect.limit, { flush: true });
        if (!written || roleplayHash(evidence(written)) !== roleplayHash(evidence(effect.publication))) throw operationError('The binary publication needs recovery.');
        afterBinaryPublication?.();
        effect.state = 'done'; save();
        return effect.result;
    });
}

/** Download only the exact immutable publication owned by the current account and record. */
export function openSavedBinary(base, key) {
    const record = readOperation(base, key);
    if (record?.state !== 'completed' || !record.result?.binary) throw operationError('The saved download is unavailable.', 404);
    return withRoleplayAccount(base, record.account, () => {
        const effect = Object.values(record.effects).find(item => item.state === 'done' && item.id === record.result.binary);
        if (!effect?.publication) throw operationError('The saved download has no publication evidence.');
        const filename = path.join(directory(base), effect.id + '.data');
        const file = inspectRoleplayFile(filename, effect.limit);
        if (!file || roleplayHash(evidence(file)) !== roleplayHash(evidence(effect.publication))) throw operationError('The saved download was replaced or removed.');
        const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        if (roleplayHash(physical(fs.fstatSync(fd, { bigint: true }))) !== roleplayHash(file.physical)) {
            fs.closeSync(fd); throw operationError('The saved download changed before it was opened.');
        }
        return { fd, filename, size: file.size, name: record.result.fileName || 'saved-download.bin', type: record.result.type || 'application/octet-stream' };
    });
}

/** A running native operation can consume its own exact, already-published input copy. */
export function openOperationBinary(context, name) {
    return withOperation(context, ({ base, value }) => {
        const effect = value.effects[`binary:${name}`];
        if (effect?.state !== 'done' || !effect.publication) throw operationError('The captured operation input is not ready.');
        const filename = path.join(directory(base), effect.id + '.data');
        const file = inspectRoleplayFile(filename, effect.limit);
        if (!file || roleplayHash(evidence(file)) !== roleplayHash(evidence(effect.publication))) throw operationError('The captured operation input changed.');
        const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        if (roleplayHash(physical(fs.fstatSync(fd, { bigint: true }))) !== roleplayHash(file.physical)) {
            fs.closeSync(fd); throw operationError('The captured operation input changed before opening.');
        }
        return { fd, filename, size: file.size, rawHash: file.rawHash, physical: file.physical };
    });
}
