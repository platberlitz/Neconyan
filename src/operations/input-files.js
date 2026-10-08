import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createRoleplayDirectory, inspectRoleplayFile, readRoleplayFile, roleplayHash, roleplayStoreDirectory, withRoleplayAccount } from '../roleplay-store.js';
import { fsyncDirectorySync, tryWriteFileSync } from '../util.js';
import { BINARY_FILE_LIMIT } from './binary-files.js';
import { operationError } from './store.js';

const INPUT_CAPACITY = 32 * 1024 * 1024 * 1024;
const directory = base => path.join(roleplayStoreDirectory(base), 'application-inputs');
const physical = stat => ({ dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) });
const identity = value => roleplayHash([value.account.accountId, value.account.dataEpoch, value.key]);
const copies = new Map();

function readAllocation(filename) {
    const file = readRoleplayFile(filename, 16384, { allowMissingParent: true });
    if (!file) return null;
    let value;
    try { value = JSON.parse(file.bytes); } catch { throw operationError('The retained upload record needs recovery.'); }
    if (value.version !== 1 || !value.account?.accountId || !Number.isSafeInteger(value.account.dataEpoch)
        || typeof value.key !== 'string' || !value.key || value.key.length > 200 || value.id !== identity(value)
        || path.basename(filename) !== value.id + '.json' || !['pending', 'complete'].includes(value.state)
        || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > BINARY_FILE_LIMIT
        || !/^[a-f0-9]{64}$/.test(value.rawHash) || !value.physical
        || typeof value.temporary !== 'string' || !new RegExp(`^${value.id}\\.[a-f0-9-]+\\.pending$`).test(value.temporary)) {
        throw operationError('The retained upload record needs recovery.');
    }
    return { file, value };
}

function saveAllocation(filename, value, previous) {
    tryWriteFileSync(filename, JSON.stringify(value), { mode: 0o600 }, previous ? {
        replaceFileOnly: true, maxFileBytes: 16384,
        expectedFileIdentity: { dev: BigInt(previous.file.physical.dev), ino: BigInt(previous.file.physical.ino) },
        validateBeforeReplace: () => {
            const current = readAllocation(filename);
            if (!current || current.file.rawHash !== previous.file.rawHash) throw operationError('The retained upload record changed.');
        }, durable: true,
    } : { expectedFileAbsent: true, durable: true, preserveOnCreateError: true });
    const saved = readRoleplayFile(filename, 16384, { flush: true });
    if (!saved || saved.bytes.toString() !== JSON.stringify(value)) throw operationError('The retained upload could not be confirmed.');
}

function assertBytes(filename, value) {
    const file = inspectRoleplayFile(filename, value.size, { flush: true });
    if (!file || file.size !== value.size || file.rawHash !== value.rawHash || roleplayHash(file.physical) !== roleplayHash(value.physical)) {
        throw operationError('The retained upload was replaced or is incomplete. Its previous evidence was kept.');
    }
    return file;
}

/** Keep a completed upload outside resettable user data before accepting an import. */
async function copyUploadedArchive(base, account, key, filename) {
    if (typeof key !== 'string' || !key || key.length > 200) throw operationError('An import submission key is required.', 400);
    const source = inspectRoleplayFile(filename, BINARY_FILE_LIMIT);
    if (!source?.size) throw operationError('A non-empty backup ZIP is required.', 400);
    const prepared = withRoleplayAccount(base, account, () => {
        const root = directory(base);
        createRoleplayDirectory(root, roleplayStoreDirectory(base));
        const id = identity({ account, key });
        const recordPath = path.join(root, id + '.json');
        const records = fs.readdirSync(root).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
        if (records.length > 100000) throw operationError('Retained upload storage has reached its record capacity.', 413);
        let used = 0;
        for (const name of records) used += readAllocation(path.join(root, name)).value.size;
        let saved = readAllocation(recordPath);
        let value = saved?.value;
        if (value && roleplayHash(value.account) !== roleplayHash(account)) throw operationError('This upload belongs to an earlier account.');
        if (value && (value.rawHash !== source.rawHash || value.size !== source.size)) {
            throw Object.assign(operationError('This import key already belongs to a different upload. The earlier upload was kept.'), { code: 'IMPORT_UPLOAD_CONFLICT' });
        }
        if (!value) {
            if (used + source.size > INPUT_CAPACITY) throw operationError('Retained upload storage is full. Earlier uploads and evidence were kept.', 413);
            const temporary = id + '.' + randomUUID() + '.pending';
            const fd = fs.openSync(path.join(root, temporary), 'wx', 0o600);
            try {
                fs.fsyncSync(fd); fsyncDirectorySync(root);
                value = { version: 1, id, account, key, state: 'pending', size: source.size, rawHash: source.rawHash,
                    temporary, physical: physical(fs.fstatSync(fd, { bigint: true })) };
            } finally { fs.closeSync(fd); }
            saveAllocation(recordPath, value, null);
            saved = readAllocation(recordPath);
        }
        const destination = path.join(root, id + '.zip');
        if (value.state === 'complete' || inspectRoleplayFile(destination, value.size)) {
            assertBytes(destination, value);
            if (value.state !== 'complete') { value.state = 'complete'; saveAllocation(recordPath, value, saved); }
            return { complete: true, id };
        }
        const temporary = path.join(root, value.temporary);
        const partial = inspectRoleplayFile(temporary, value.size);
        if (!partial || roleplayHash(partial.physical) !== roleplayHash(value.physical)) throw operationError('The unfinished retained upload changed.');
        const input = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let output;
        try {
            if (roleplayHash(physical(fs.fstatSync(input, { bigint: true }))) !== roleplayHash(source.physical)) throw operationError('The uploaded ZIP changed before it could be retained.');
            output = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
            if (roleplayHash(physical(fs.fstatSync(output, { bigint: true }))) !== roleplayHash(value.physical)) throw operationError('The unfinished retained upload changed before copying.');
            fs.ftruncateSync(output, 0);
            return { id, input, output, temporary, destination, recordPath, value };
        } catch (error) {
            fs.closeSync(input);
            if (output !== undefined) fs.closeSync(output);
            throw error;
        }
    });
    if (!prepared.complete) {
        let size = 0;
        const hash = createHash('sha256');
        const check = new Transform({ transform(chunk, _encoding, callback) {
            size += chunk.length;
            if (size > source.size) return callback(operationError('The uploaded ZIP grew while being retained.'));
            hash.update(chunk); callback(null, chunk);
        } });
        await pipeline(fs.createReadStream(filename, { fd: prepared.input, autoClose: true }), check,
            fs.createWriteStream(prepared.temporary, { fd: prepared.output, autoClose: true }));
        if (size !== source.size || hash.digest('hex') !== source.rawHash) throw operationError('The uploaded ZIP changed while being retained.');
        withRoleplayAccount(base, account, () => {
            const saved = readAllocation(prepared.recordPath);
            if (!saved || roleplayHash(saved.value) !== roleplayHash(prepared.value)) throw operationError('The retained upload record changed during copying.');
            assertBytes(prepared.temporary, saved.value);
            if (inspectRoleplayFile(prepared.destination, source.size)) throw operationError('Another file occupies this retained upload. It was kept.');
            fs.renameSync(prepared.temporary, prepared.destination); fsyncDirectorySync(path.dirname(prepared.destination));
            assertBytes(prepared.destination, saved.value);
            saved.value.state = 'complete'; saveAllocation(prepared.recordPath, saved.value, saved);
        });
    }
    return capturedArchiveInput(base, account, prepared.id);
}

export function retainUploadedArchive(base, account, key, filename) {
    if (typeof key !== 'string' || !key || key.length > 200) throw operationError('An import submission key is required.', 400);
    const queueKey = path.join(directory(base), identity({ account, key }));
    const previous = copies.get(queueKey) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => copyUploadedArchive(base, account, key, filename));
    copies.set(queueKey, next);
    return next.finally(() => { if (copies.get(queueKey) === next) copies.delete(queueKey); });
}

export function readUploadedArchive(base, account, key) {
    if (typeof key !== 'string' || !key || key.length > 200) throw operationError('An import submission key is required.', 400);
    const id = withRoleplayAccount(base, account, () => {
        const id = identity({ account, key });
        const recordPath = path.join(directory(base), id + '.json');
        const saved = readAllocation(recordPath);
        if (!saved) return null;
        if (roleplayHash(saved.value.account) !== roleplayHash(account)) throw operationError('This upload belongs to an earlier account.');
        if (saved.value.state !== 'complete') {
            const destination = path.join(directory(base), id + '.zip');
            if (!inspectRoleplayFile(destination, saved.value.size)) return null;
            assertBytes(destination, saved.value);
            saved.value.state = 'complete'; saveAllocation(recordPath, saved.value, saved);
        }
        return id;
    });
    return id ? capturedArchiveInput(base, account, id) : null;
}

export function capturedArchiveInput(base, account, id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw operationError('The retained upload identifier is invalid.', 400);
    return withRoleplayAccount(base, account, () => {
        const saved = readAllocation(path.join(directory(base), id + '.json'));
        if (!saved || saved.value.state !== 'complete' || roleplayHash(saved.value.account) !== roleplayHash(account)) throw operationError('This retained upload is unavailable to the current account.');
        const filename = path.join(directory(base), id + '.zip');
        const file = assertBytes(filename, saved.value);
        return { id, filename, size: file.size, evidence: { rawHash: file.rawHash, physical: file.physical } };
    });
}
