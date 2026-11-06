import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const DATA_ROOT_OWNER_DIRECTORY = '.neconyan-root-owner';
const OWNER_NAME = 'owner.json';
const activeOwners = new Map();

function withinRoot(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function verifyHeldOwner(held) {
    try {
        const directory = path.join(held.root, DATA_ROOT_OWNER_DIRECTORY);
        const current = readOwner(directory);
        const now = rootIdentity(held.root);
        const dir = fs.lstatSync(directory, { bigint: true });
        const file = fs.lstatSync(path.join(directory, OWNER_NAME), { bigint: true });
        const start = processStartIdentity();
        return current.version === 1
            && current.nonce === held.owner.nonce
            && current.pid === process.pid
            && current.hostname === os.hostname()
            && current.platform === process.platform
            && current.purpose === held.owner.purpose
            && current.processStart === held.owner.processStart
            && (held.owner.processStart === null || start === held.owner.processStart)
            && current.root.dev === held.identity.dev
            && current.root.ino === held.identity.ino
            && now.dev === held.identity.dev
            && now.ino === held.identity.ino
            && dir.dev === held.directoryStat.dev
            && dir.ino === held.directoryStat.ino
            && file.dev === held.ownerStat.dev
            && file.ino === held.ownerStat.ino
            && file.size === held.ownerStat.size
            && file.mtimeNs === held.ownerStat.mtimeNs
            && file.ctimeNs === held.ownerStat.ctimeNs;
    } catch {
        return false;
    }
}

function hasNestedDataRootOwner(root, target) {
    let current = path.dirname(target);
    while (withinRoot(root, current) && current !== root) {
        try {
            fs.lstatSync(path.join(current, DATA_ROOT_OWNER_DIRECTORY));
            return true;
        } catch (error) {
            if (error?.code !== 'ENOENT') return true;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return false;
}

/** True only when this process currently holds a verified live data-root lease directly governing targetPath. */
export function isPathUnderOwnedDataRoot(targetPath) {
    if (typeof targetPath !== 'string' || !targetPath || !activeOwners.size) return false;
    let resolvedTarget;
    try {
        resolvedTarget = fs.realpathSync(path.resolve(targetPath));
    } catch {
        try {
            const resolved = path.resolve(targetPath);
            resolvedTarget = path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
        } catch {
            return false;
        }
    }
    for (const held of activeOwners.values()) {
        try {
            if (fs.realpathSync(held.root) !== held.root) continue;
        } catch {
            continue;
        }
        if (withinRoot(held.root, resolvedTarget) && !hasNestedDataRootOwner(held.root, resolvedTarget) && verifyHeldOwner(held)) {
            return true;
        }
    }
    return false;
}

const APP_SERVER_BUSY = 'The previous Neconyan server on this phone may still be using your data. Close Neconyan from the recent apps screen, or force stop it in Android settings, then open it again.';
const APP_LOCK_DAMAGED = 'The data folder lock on this phone needs checking, so it was left untouched. Save a backup of your data from this screen and report the problem. Lock problem: ';

function fail(message, details) {
    const error = Object.assign(new Error(details ? `${message} ${formatLeaseDetails(details)}` : message), { code: 'DATA_ROOT_OWNED' });
    if (details) error.details = details;
    return error;
}

const leaseText = value => String(value).replace(/[^\x21-\x7e]/g, '?').slice(0, 64);

/** One key=value sentence naming the lease record and this start, for the log and the startup note. Never includes the nonce. */
function formatLeaseDetails(details) {
    const side = (entry, withPurpose) => `pid=${leaseText(entry.pid)} platform=${leaseText(entry.platform)} host=${leaseText(entry.hostname)}`
        + `${withPurpose ? ` purpose=${leaseText(entry.purpose)}` : ''} processStart=${entry.processStart === null ? 'none' : leaseText(entry.processStart)}`
        + ` root=${leaseText(entry.root.dev)}:${leaseText(entry.root.ino)}`;
    const record = details.owner ? side(details.owner, true) : 'incomplete or unreadable';
    const differs = details.owner ? (details.differs.length ? details.differs.join(', ') : 'none') : 'unknown';
    return `Lease record: ${record}; this start: ${side(details.current, false)}; differs: ${differs}.`;
}

function leaseDetails(owner, identity) {
    const record = owner && isOwnerRecord(owner) ? owner : null;
    const differs = [];
    if (record) {
        if (record.hostname !== os.hostname()) differs.push('hostname');
        if (record.platform !== process.platform) differs.push('platform');
        if (record.root.dev !== identity.dev) differs.push('root.dev');
        if (record.root.ino !== identity.ino) differs.push('root.ino');
    }
    return Object.freeze({
        owner: record && Object.freeze({ pid: record.pid, platform: record.platform, hostname: record.hostname,
            processStart: record.processStart, purpose: record.purpose, root: Object.freeze({ dev: record.root.dev, ino: record.root.ino }) }),
        current: Object.freeze({ pid: process.pid, platform: process.platform, hostname: os.hostname(), processStart: processStartIdentity(),
            root: Object.freeze({ dev: identity.dev, ino: identity.ino }) }),
        differs: Object.freeze(differs),
    });
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

function removeFailedOwnerDirectory(root, identity, directory, directoryStat) {
    try {
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
            || typeof directoryStat.dev !== 'bigint' || typeof directoryStat.ino !== 'bigint' || directoryStat.ino <= 0n
            || typeof directoryStat.ctimeNs !== 'bigint' || typeof directoryStat.mtimeNs !== 'bigint'
            || !/^\d+$/.test(identity.dev) || !/^[1-9]\d*$/.test(identity.ino)) return;
        const unchanged = () => {
            if (fs.realpathSync(root) !== root) return false;
            const currentRoot = fs.lstatSync(root, { bigint: true });
            const currentDirectory = fs.lstatSync(directory, { bigint: true });
            return typeof currentRoot.dev === 'bigint' && typeof currentRoot.ino === 'bigint' && currentRoot.ino > 0n
                && currentRoot.isDirectory() && !currentRoot.isSymbolicLink()
                && String(currentRoot.dev) === identity.dev && String(currentRoot.ino) === identity.ino
                && currentDirectory.isDirectory() && !currentDirectory.isSymbolicLink()
                && currentDirectory.dev === directoryStat.dev && currentDirectory.ino === directoryStat.ino
                && currentDirectory.ctimeNs === directoryStat.ctimeNs && currentDirectory.mtimeNs === directoryStat.mtimeNs;
        };
        if (!unchanged() || fs.readdirSync(directory).length !== 0 || !unchanged()) return;
        fs.rmdirSync(directory);
        flushDirectory(root);
    } catch { /* Preserve the original create-open failure. */ }
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

function isOwnerRecord(value) {
    return value?.version === 1 && Object.keys(value).sort().join(',') === 'hostname,nonce,pid,platform,processStart,purpose,root,version'
        && Object.keys(value.root ?? {}).sort().join(',') === 'dev,ino' && /^[a-f0-9]{32}$/.test(value.nonce)
        && typeof value.hostname === 'string' && typeof value.platform === 'string'
        && Number.isSafeInteger(value.pid) && value.pid >= 1
        && ['server', 'repair'].includes(value.purpose)
        && /^\d+$/.test(value.root?.dev) && /^\d+$/.test(value.root?.ino)
        && (value.processStart === null || typeof value.processStart === 'string' && /^\d+$/.test(value.processStart));
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
        if (!isOwnerRecord(value)) throw fail('The data root ownership record needs inspection.');
        return value;
    } catch (error) {
        if (error?.code === 'DATA_ROOT_OWNED') throw error;
        throw fail('The data root ownership record cannot be read.');
    } finally { fs.closeSync(fd); }
}

/** True only inside the Android app's own server: Android platform, the app marker, and the app's linked neconyan_fs binding (Termux shares the platform and anyone can set the marker). */
export function isAndroidAppServer({ env = process.env, platform = process.platform, linkedBinding = name => process._linkedBinding(name), warn = console.warn } = {}) {
    if (platform !== 'android' || env.NECONYAN_ANDROID_APP !== '1') return false;
    try { if (linkedBinding('neconyan_fs')) return true; } catch { /* fall through */ }
    warn('The Android app marker is set but the neconyan_fs binding is missing, so the data folder lease keeps its strict checks.');
    return false;
}

function leaseReclaimed(reason, details) {
    return Object.freeze({ reason, details, message: `Reclaimed a stale data folder lease (${reason}). ${formatLeaseDetails(details)}` });
}

/** Desktop, Termux and shared folders: only a fully identified local process proven absent can be reclaimed automatically. */
function reclaimDeadLocalLease(root, directory, identity) {
    let existing;
    try { existing = readOwner(directory); } catch (error) {
        if (error?.code === 'DATA_ROOT_OWNED') throw fail(error.message, leaseDetails(null, identity));
        throw error;
    }
    const details = leaseDetails(existing, identity);
    if (details.differs.length) {
        throw fail('The data folder is already owned or needs its ownership checked. Stop all installations before continuing.', details);
    }
    let running = true;
    try { process.kill(existing.pid, 0); } catch (cause) {
        if (cause.code === 'ESRCH') running = false;
        else if (cause.code !== 'EPERM') throw cause;
    }
    if (running) throw fail('The data folder is already owned by a running process.', details);
    const snapshot = ownerRecoverySnapshot(root);
    if (!snapshot.owner || snapshot.owner.nonce !== existing.nonce) throw fail('The ownership record changed.', details);
    try { recoverDataRootOwner(root, snapshot.token); } catch (error) {
        if (error?.code === 'DATA_ROOT_OWNED') throw fail(error.message, details);
        throw error;
    }
    return leaseReclaimed('process-ended', details);
}

function appLeaseReason(owner) {
    if (owner === null) return 'incomplete-record';
    if (owner.pid === process.pid) return 'pid-reused';
    let signalled = true;
    try { process.kill(owner.pid, 0); } catch (error) {
        if (error.code === 'ESRCH') return 'process-ended';
        if (error.code !== 'EPERM') return 'unidentified';
        signalled = false;
    }
    const start = processStartIdentity(owner.pid);
    if (owner.processStart !== null && start === owner.processStart) return 'running';
    if (!signalled) return 'pid-of-another-app';
    if (owner.processStart !== null && start !== null) return 'pid-reused';
    return 'unidentified';
}

/** The Android app is the only program that can use its private data folder, so a leftover lease is its own earlier run: only a live or unidentifiable owner, or unsafe evidence, is refused. */
function reclaimAppServerLease(root, identity) {
    for (const held of activeOwners.values()) {
        if (held.root === root) throw fail('This server already holds the data folder.', leaseDetails(held.owner, identity));
    }
    let snapshot;
    try { snapshot = ownerRecoverySnapshot(root); } catch (error) {
        if (error?.code === 'DATA_ROOT_OWNED') throw fail(APP_LOCK_DAMAGED + error.message, leaseDetails(null, identity));
        throw error;
    }
    // The directory vanished after EEXIST: something is changing the lease right now, so do not race it.
    if (!snapshot.token) throw fail(APP_SERVER_BUSY, leaseDetails(null, identity));
    const owner = isOwnerRecord(snapshot.owner) ? snapshot.owner : null;
    const details = leaseDetails(owner, identity);
    const reason = appLeaseReason(owner);
    if (reason === 'running' || reason === 'unidentified') throw fail(APP_SERVER_BUSY, details);
    try { removeCheckedOwner(root, snapshot.token); } catch (error) {
        if (error?.code === 'DATA_ROOT_OWNED') throw fail(APP_SERVER_BUSY, details);
        throw error;
    }
    return leaseReclaimed(reason, details);
}

/** Hold the fixed root-relative lease until every writer has stopped. No timeout steals it. */
export function acquireDataRootOwner(dataRoot, purpose, { androidAppServer = false } = {}) {
    if (!['server', 'repair'].includes(purpose)) throw new TypeError('Invalid data root ownership purpose.');
    if (typeof androidAppServer !== 'boolean' || androidAppServer && purpose !== 'server') throw new TypeError('Invalid data root ownership option.');
    const root = fs.realpathSync(path.resolve(dataRoot));
    const identity = Object.freeze(rootIdentity(root));
    const directory = path.join(root, DATA_ROOT_OWNER_DIRECTORY);
    let reclaimed = null;
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        reclaimed = androidAppServer ? reclaimAppServerLease(root, identity) : reclaimDeadLocalLease(root, directory, identity);
        fs.mkdirSync(directory, { mode: 0o700 });
    }
    flushDirectory(root);
    const directoryStat = fs.lstatSync(directory, { bigint: true });
    const owner = { version: 1, nonce: crypto.randomBytes(16).toString('hex'), hostname: os.hostname(),
        platform: process.platform, pid: process.pid, processStart: processStartIdentity(), root: identity, purpose };
    let fd;
    try {
        fd = fs.openSync(path.join(directory, OWNER_NAME), fs.constants.O_WRONLY | fs.constants.O_CREAT
            | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    } catch (error) {
        removeFailedOwnerDirectory(root, identity, directory, directoryStat);
        throw error;
    }
    let ownerStat;
    try { fs.writeFileSync(fd, JSON.stringify(owner)); fs.fsyncSync(fd); ownerStat = fs.fstatSync(fd, { bigint: true }); } finally { fs.closeSync(fd); }
    flushDirectory(directory);
    let released = false;
    const capability = {
        root, identity, reclaimed,
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
    removeCheckedOwner(dataRoot, token);
}

/** Remove the ownership entry only if it still matches the exact inspected token. */
function removeCheckedOwner(dataRoot, token) {
    const confirmed = ownerRecoverySnapshot(dataRoot);
    if (confirmed.token !== token) throw fail('The data root ownership changed. Check its status again.');
    const directory = path.join(confirmed.root, DATA_ROOT_OWNER_DIRECTORY);
    if (confirmed.file) fs.unlinkSync(path.join(directory, OWNER_NAME));
    fs.rmdirSync(directory);
    flushDirectory(confirmed.root);
}
