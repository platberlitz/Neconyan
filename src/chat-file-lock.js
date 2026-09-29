import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { types } from 'node:util';

const require = createRequire(import.meta.url);
const lockfile = require('proper-lockfile');

const LOCK_RETRY_DELAY_MS = 25;
const LOCK_RETRY_LIMIT = 200;
const LOCK_STALE_MS = 300_000;
const activeLocks = new Set();
const hostname = os.hostname();

const lockIdentity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.ctimeMs}`;

// Keep the normal stale timeout for live, remote or unidentified owners. Only a
// matching lock left by a provably dead local process can be reclaimed early.
function ownerAwareStat(filename, ...args) {
    const stat = fs.statSync(filename, ...args);
    try {
        const ownerPath = filename + '.owner';
        const info = fs.lstatSync(ownerPath);
        if (!info.isFile() || info.size > 4096) return stat;
        const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
        if (owner.hostname !== hostname || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.identity !== lockIdentity(stat)) return stat;
        try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') stat.mtime = new Date(0); }
    } catch { /* Old locks and incomplete owner records use the normal timeout. */ }
    return stat;
}
const ownerAwareFs = new Proxy(require('graceful-fs'), {
    get(target, name) { return name === 'statSync' ? ownerAwareStat : target[name]; },
});

function recordLockOwner(lockPath) {
    // This is a recovery hint, not write-ahead evidence. Losing it falls back to
    // the ordinary stale timeout; it must not add a disk flush to every lock.
    try {
        const identity = lockIdentity(fs.statSync(lockPath));
        const fd = fs.openSync(lockPath + '.owner', fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.writeFileSync(fd, JSON.stringify({ hostname, pid: process.pid, identity })); } finally { fs.closeSync(fd); }
    } catch { /* Locking remains valid without the recovery hint. */ }
}

/** Retain the existing lock policy while allowing immediate recovery of dead local owners. */
export function acquireLocalFileLock(filePath, options) {
    const release = lockfile.lockSync(filePath, { ...options, fs: ownerAwareFs });
    recordLockOwner(options.lockfilePath);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        try { fs.unlinkSync(options.lockfilePath + '.owner'); } catch { /* Optional recovery hint. */ }
        release();
    };
}

export function getChatFileLockPath(filePath) {
    const resolvedPath = path.resolve(filePath);
    const lockKey = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
    return path.join(path.dirname(filePath), `.neconyan-chat-${crypto.createHash('sha256').update(lockKey).digest('hex')}.lock`);
}

export function acquireChatFileLock(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const lockPath = getChatFileLockPath(filePath);
    if (activeLocks.has(lockPath)) {
        throw Object.assign(new Error(`Chat file is already locked: ${filePath}`), { code: 'ELOCKED' });
    }

    let release;
    for (let attempt = 0; attempt <= LOCK_RETRY_LIMIT; attempt++) {
        try {
            release = acquireLocalFileLock(filePath, {
                lockfilePath: lockPath,
                realpath: false,
                stale: LOCK_STALE_MS,
                update: LOCK_STALE_MS / 3,
            });
            break;
        } catch (error) {
            if (error?.code !== 'ELOCKED' || attempt === LOCK_RETRY_LIMIT) {
                throw error;
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_DELAY_MS);
        }
    }

    activeLocks.add(lockPath);
    return () => {
        try {
            release?.();
        } finally {
            activeLocks.delete(lockPath);
        }
    };
}

export function acquireChatFileLocks(filePaths) {
    const uniquePaths = [...new Map(filePaths.map(filePath => [getChatFileLockPath(filePath), filePath])).entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, filePath]) => filePath);
    const releases = [];
    const drain = () => {
        const errors = [];
        while (releases.length) {
            try { releases.pop()(); } catch (error) { errors.push(error); }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, 'Chat lock cleanup failed.');
    };
    try {
        for (const filePath of uniquePaths) {
            releases.push(acquireChatFileLock(filePath));
        }
    } catch (error) {
        try { drain(); } catch (cleanup) { console.warn('Chat lock cleanup also failed:', cleanup); }
        throw error;
    }

    return drain;
}

/** Synchronous file work; preserve its original failure even when cleanup also fails. */
export function withChatFileLocks(filePaths, operation) {
    if (typeof operation !== 'function' || types.isAsyncFunction(operation)) throw new TypeError('Chat lock operations must be synchronous.');
    const release = acquireChatFileLocks(filePaths);
    let result;
    try {
        result = operation();
        if (result && typeof result.then === 'function') {
            Promise.resolve(result).catch(() => {});
            throw new TypeError('Chat lock operations must not return a promise.');
        }
    } catch (error) {
        try { release(); } catch (cleanup) { console.warn('Chat lock cleanup also failed:', cleanup); }
        throw error;
    }
    release();
    return result;
}
