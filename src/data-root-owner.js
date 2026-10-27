import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const DATA_ROOT_OWNER_DIRECTORY = '.neconyan-root-owner';
const OWNER_NAME = 'owner.json';
const activeOwners = new WeakMap();

function fail(message) {
    return Object.assign(new Error(message), { code: 'DATA_ROOT_OWNED' });
}

function flushDirectory(directory) {
    if (process.platform === 'win32') return;
    const fd = fs.openSync(directory, 'r');
    try {
        try { fs.fsyncSync(fd); } catch (error) {
            if (!['EBADF', 'EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
        }
    } finally { fs.closeSync(fd); }
}

function rootIdentity(root) {
    const stat = fs.statSync(root, { bigint: true });
    if (!stat.isDirectory()) throw fail('The data root is not a directory.');
    return { dev: String(stat.dev), ino: String(stat.ino) };
}

function processStartIdentity(pid = process.pid) {
    if (process.platform !== 'linux' && process.platform !== 'android') return null;
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const end = stat.lastIndexOf(')');
        if (end < 0) return null;
        const start = stat.slice(end + 2).split(' ')[19];
        return /^\d+$/.test(start) ? start : null;
    } catch { return null; }
}

function readOwner(directory) {
    const dir = fs.lstatSync(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw fail('The data root ownership entry is unsafe.');
    const names = fs.readdirSync(directory);
    if (names.length !== 1 || names[0] !== OWNER_NAME) throw fail('The data root ownership record is incomplete or unexpected.');
    const filename = path.join(directory, OWNER_NAME);
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw fail('The data root ownership record is unsafe.');
        const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (value?.version !== 1 || Object.keys(value).sort().join(',') !== 'hostname,nonce,pid,platform,processStart,purpose,root,version'
            || Object.keys(value.root ?? {}).sort().join(',') !== 'dev,ino' || !/^[a-f0-9]{32}$/.test(value.nonce)
            || typeof value.hostname !== 'string' || typeof value.platform !== 'string'
            || !Number.isSafeInteger(value.pid) || value.pid < 1
            || !['server', 'repair'].includes(value.purpose)
            || !/^\d+$/.test(value.root?.dev) || !/^\d+$/.test(value.root?.ino)
            || !(value.processStart === null || typeof value.processStart === 'string' && /^\d+$/.test(value.processStart))) {
            throw fail('The data root ownership record needs inspection.');
        }
        return value;
    } catch (error) {
        if (error?.code === 'DATA_ROOT_OWNED') throw error;
        throw fail('The data root ownership record cannot be read.');
    } finally { fs.closeSync(fd); }
}

/** Hold the fixed root-relative lease until every writer has stopped. No timeout steals it. */
export function acquireDataRootOwner(dataRoot, purpose) {
    if (!['server', 'repair'].includes(purpose)) throw new TypeError('Invalid data root ownership purpose.');
    const root = fs.realpathSync(path.resolve(dataRoot));
    const identity = Object.freeze(rootIdentity(root));
    const directory = path.join(root, DATA_ROOT_OWNER_DIRECTORY);
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Only a fully identified local process proven absent can be reclaimed automatically.
        const existing = readOwner(directory);
        if (existing.hostname !== os.hostname() || existing.platform !== process.platform
            || existing.root.dev !== identity.dev || existing.root.ino !== identity.ino) {
            throw fail('The data folder is already owned or needs its ownership checked. Stop all installations before continuing.');
        }
        try {
            process.kill(existing.pid, 0);
            throw fail('The data folder is already owned by a running process.');
        } catch (cause) {
            if (cause.code !== 'ESRCH') throw cause;
        }
        const snapshot = ownerRecoverySnapshot(root);
        if (!snapshot.owner || snapshot.owner.nonce !== existing.nonce) throw fail('The ownership record changed.');
        recoverDataRootOwner(root, snapshot.token);
        fs.mkdirSync(directory, { mode: 0o700 });
    }
    flushDirectory(root);
    const directoryStat = fs.lstatSync(directory, { bigint: true });
    const owner = { version: 1, nonce: crypto.randomBytes(16).toString('hex'), hostname: os.hostname(),
        platform: process.platform, pid: process.pid, processStart: processStartIdentity(), root: identity, purpose };
    const fd = fs.openSync(path.join(directory, OWNER_NAME), fs.constants.O_WRONLY | fs.constants.O_CREAT
        | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    let ownerStat;
    try { fs.writeFileSync(fd, JSON.stringify(owner)); fs.fsyncSync(fd); ownerStat = fs.fstatSync(fd, { bigint: true }); } finally { fs.closeSync(fd); }
    flushDirectory(directory);
    let released = false;
    const capability = {
        root, identity,
        release() {
            if (released) return;
            const currentDirectory = fs.lstatSync(directory, { bigint: true });
            const currentFile = fs.lstatSync(path.join(directory, OWNER_NAME), { bigint: true });
            if (!currentDirectory.isDirectory() || currentDirectory.isSymbolicLink() || currentDirectory.dev !== directoryStat.dev
                || currentDirectory.ino !== directoryStat.ino || !currentFile.isFile() || currentFile.isSymbolicLink()
                || currentFile.nlink !== 1n || currentFile.dev !== ownerStat.dev || currentFile.ino !== ownerStat.ino
                || currentFile.size !== ownerStat.size || currentFile.mtimeNs !== ownerStat.mtimeNs || currentFile.ctimeNs !== ownerStat.ctimeNs) {
                throw fail('The data root ownership files changed. Their evidence was retained.');
            }
            const current = readOwner(directory);
            const now = rootIdentity(root);
            if (JSON.stringify(current) !== JSON.stringify(owner) || now.dev !== identity.dev || now.ino !== identity.ino) {
                throw fail('The data root ownership changed. Its evidence was retained.');
            }
            fs.unlinkSync(path.join(directory, OWNER_NAME));
            fs.rmdirSync(directory);
            flushDirectory(root);
            released = true;
            activeOwners.delete(capability);
        },
    };
    activeOwners.set(capability, { root, identity, owner, directoryStat, ownerStat });
    return Object.freeze(capability);
}

/** Offline storage operations require the actual live repair owner, not a caller-controlled flag. */
export function assertDataRootRepairOwner(capability, dataRoot) {
    const held = activeOwners.get(capability);
    if (!held || held.owner.purpose !== 'repair' || fs.realpathSync(path.resolve(dataRoot)) !== held.root) throw fail('Exclusive repair ownership is required.');
    const current = readOwner(path.join(held.root, DATA_ROOT_OWNER_DIRECTORY));
    const now = rootIdentity(held.root);
    const dir = fs.lstatSync(path.join(held.root, DATA_ROOT_OWNER_DIRECTORY), { bigint: true });
    const file = fs.lstatSync(path.join(held.root, DATA_ROOT_OWNER_DIRECTORY, OWNER_NAME), { bigint: true });
    if (JSON.stringify(current) !== JSON.stringify(held.owner) || now.dev !== held.identity.dev || now.ino !== held.identity.ino
        || dir.dev !== held.directoryStat.dev || dir.ino !== held.directoryStat.ino || file.dev !== held.ownerStat.dev
        || file.ino !== held.ownerStat.ino || file.size !== held.ownerStat.size || file.mtimeNs !== held.ownerStat.mtimeNs
        || file.ctimeNs !== held.ownerStat.ctimeNs) throw fail('The repair ownership changed.');
}

/** Inspect ownership without assuming an old or unknown owner is dead. */
export function inspectDataRootOwner(dataRoot) {
    const root = fs.realpathSync(path.resolve(dataRoot));
    const directory = path.join(root, DATA_ROOT_OWNER_DIRECTORY);
    try { return readOwner(directory); } catch (error) {
        if (error.code === 'ENOENT') {
            if (fs.existsSync(directory)) throw fail('The data root ownership record is incomplete.');
            return null;
        }
        throw error;
    }
}

function ownerRecoverySnapshot(dataRoot) {
    const root = fs.realpathSync(path.resolve(dataRoot));
    const identity = rootIdentity(root);
    const directory = path.join(root, DATA_ROOT_OWNER_DIRECTORY);
    let directoryStat;
    try { directoryStat = fs.lstatSync(directory, { bigint: true }); } catch (error) {
        if (error.code === 'ENOENT') return { root, owner: null, token: null };
        throw error;
    }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw fail('The data root ownership entry is unsafe.');
    const names = fs.readdirSync(directory);
    if (names.length > 1 || names.length === 1 && names[0] !== OWNER_NAME) throw fail('Unexpected ownership files need manual inspection.');
    let value = null, fileEvidence = null;
    if (names.length) {
        const filename = path.join(directory, OWNER_NAME);
        const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
        try {
            const before = fs.fstatSync(fd, { bigint: true });
            if (!before.isFile() || before.nlink !== 1n || before.size > 4096n) throw fail('The data root ownership record is unsafe.');
            const bytes = fs.readFileSync(fd);
            const after = fs.fstatSync(fd, { bigint: true });
            const current = fs.lstatSync(filename, { bigint: true });
            if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
                || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || current.isSymbolicLink()
                || current.dev !== after.dev || current.ino !== after.ino) throw fail('The ownership record changed while it was checked.');
            fileEvidence = { dev: String(after.dev), ino: String(after.ino), size: String(after.size),
                mtimeNs: String(after.mtimeNs), ctimeNs: String(after.ctimeNs), hash: crypto.createHash('sha256').update(bytes).digest('hex') };
            try { value = JSON.parse(bytes.toString('utf8')); } catch { /* Exact malformed bytes can still be identified for explicit recovery. */ }
        } finally { fs.closeSync(fd); }
    }
    const snapshot = { version: 1, root, rootIdentity: identity,
        directory: { dev: String(directoryStat.dev), ino: String(directoryStat.ino) }, file: fileEvidence, owner: value };
    return { ...snapshot, token: crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
}

/** Produce an exact recovery token even for an incomplete owner, without deciding it is stale. */
export function describeDataRootOwner(dataRoot) {
    return ownerRecoverySnapshot(dataRoot);
}

/** Explicitly recover only the exact inspected ownership after the operator has stopped all servers. */
export function recoverDataRootOwner(dataRoot, token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw fail('An ownership recovery token is required.');
    const checked = ownerRecoverySnapshot(dataRoot);
    if (!checked.token || checked.token !== token) throw fail('The data root ownership changed. Check its status again.');
    const owner = checked.owner;
    if (owner?.hostname === os.hostname() && owner.platform === process.platform && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (error) {
            if (error.code === 'ESRCH') alive = false;
            else throw fail('The ownership process could not be checked.');
        }
        if (alive) {
            const currentStart = processStartIdentity(owner.pid);
            if (!owner.processStart || !currentStart || owner.processStart === currentStart) {
                throw fail('The ownership process is still running or cannot be identified. Stop it before recovering the lock.');
            }
        }
    }
    const confirmed = ownerRecoverySnapshot(dataRoot);
    if (confirmed.token !== token) throw fail('The data root ownership changed. Check its status again.');
    const directory = path.join(checked.root, DATA_ROOT_OWNER_DIRECTORY);
    if (checked.file) fs.unlinkSync(path.join(directory, OWNER_NAME));
    fs.rmdirSync(directory);
    flushDirectory(checked.root);
}
