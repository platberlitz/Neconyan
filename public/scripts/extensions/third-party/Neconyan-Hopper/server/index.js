import fs from 'node:fs/promises';
import syncFs, { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { SETTINGS_KEY } from '../src/core.js';
import { checkMeowerReceipts } from './job-receipts.js';
import { MAX_STORE_BYTES, HOST_STORE_NAME, HOST_PLUGIN_MARKER, encodedLimit, migrateLegacy, parseBytes, sizeOf, storeFrom } from '../src/storage-format.js';
import { withRoleplayAccount } from '../../../../../../src/roleplay-store.js';

export const info = { id: 'hopper', name: 'Meower', description: 'Private, revision-checked storage for Meower timelines.' };

const writes = new Map();
const isRecord = value => value !== null && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const own = (value, key) => isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;

function fail(status, message) {
    throw Object.assign(new Error(message), { status });
}

async function readBytes(file, limit) {
    let handle;
    try {
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1) fail(500, 'Saved Meower data is not a private regular file.');
        if (stat.size > limit) fail(413, 'Saved Meower data exceeds the supported size limit.');
        const bytes = await handle.readFile();
        if (bytes.length > limit) fail(413, 'Saved Meower data exceeds the supported size limit.');
        return bytes;
    } finally {
        await handle.close();
    }
}

async function loadStore(directories, account) {
    const directory = path.join(directories.root, 'hopper');
    const stat = await fs.lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail(500, 'The private Meower storage directory is invalid.');
    const previous = await readBytes(path.join(directory, 'store.json'), MAX_STORE_BYTES);
    let bytes = previous;
    if (previous === null) {
        if (await readBytes(path.join(directory, 'store.previous.json'), MAX_STORE_BYTES) !== null) {
            fail(500, 'The Meower store is missing but its previous version exists. Restore that version before saving.');
        }
        bytes = await readBytes(path.join(directories.files, HOST_STORE_NAME), encodedLimit(MAX_STORE_BYTES));
    }
    if (bytes !== null) {
        const raw = parseBytes(bytes, { base64: previous === null });
        if (own(raw, 'account') !== undefined && raw.account !== account) {
            fail(409, 'The signed-in account changed. Reload Meower before continuing.');
        }
        // Host bytes stay in place; only private bytes participate in backup and rollback.
        const receipts = previous === null ? {} : (raw.jobReceipts ?? {});
        if (!isRecord(receipts)) fail(500, 'The saved Meower job receipts are invalid. Restore them before saving.');
        checkMeowerReceipts(receipts);
        return { ...storeFrom(raw), receipts, previous };
    }

    const hostBytes = await readBytes(path.join(directories.root, 'settings.json'), MAX_STORE_BYTES);
    let raw;
    if (hostBytes !== null) {
        const host = parseBytes(hostBytes);
        if (!isRecord(host) || (host.extension_settings !== undefined && !isRecord(host.extension_settings))) {
            fail(500, 'The host settings could not be read safely.');
        }
        raw = own(host.extension_settings, SETTINGS_KEY);
    }
    return { ...await migrateLegacy(raw, (pointer, limit) => readBytes(path.join(directories.files, path.basename(pointer)), limit)), receipts: {}, previous: null };
}

function temporaryFile(directory, bytes) {
    const file = path.join(directory, `store-${randomUUID()}.tmp`);
    try {
        const handle = syncFs.openSync(file, 'wx', 0o600);
        try {
            syncFs.writeFileSync(handle, bytes);
            syncFs.fsyncSync(handle);
        } finally {
            syncFs.closeSync(handle);
        }
        return file;
    } catch (error) {
        try { syncFs.rmSync(file, { force: true }); } catch { /* Retain the original write error. */ }
        throw error;
    }
}

function markServerStorage(directory) {
    const folder = syncFs.openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    let pending;
    try {
        pending = temporaryFile(directory, '{"format":1,"storage":"server"}\n');
        syncFs.renameSync(pending, path.join(directory, HOST_PLUGIN_MARKER));
        pending = null;
        // Keep the marker on failure, and sync it again on retry, even if already visible.
        syncFs.fsyncSync(folder);
    } finally {
        if (pending) syncFs.rmSync(pending, { force: true });
        syncFs.closeSync(folder);
    }
}

function saveStore(directory, store, previous) {
    const bytes = `${sizeOf(store, MAX_STORE_BYTES - 1, 'The Meower store (128 MiB limit)')}\n`;
    const folder = syncFs.openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    const current = path.join(directory, 'store.json');
    let pending;
    let backup;
    let restored;
    try {
        pending = temporaryFile(directory, bytes);
        if (previous !== null) {
            backup = temporaryFile(directory, previous);
            syncFs.renameSync(backup, path.join(directory, 'store.previous.json'));
            backup = null;
        }
        syncFs.fsyncSync(folder);
        syncFs.renameSync(pending, current);
        pending = null;
        try {
            syncFs.fsyncSync(folder);
        } catch (error) {
            // A failed directory sync must not leave a newer visible revision after a failed save.
            if (previous !== null) {
                restored = temporaryFile(directory, previous);
                syncFs.renameSync(restored, current);
                restored = null;
            } else {
                syncFs.unlinkSync(current);
            }
            syncFs.fsyncSync(folder);
            throw error;
        }
    } finally {
        for (const file of [pending, backup, restored].filter(Boolean)) {
            try { syncFs.rmSync(file, { force: true }); } catch { /* Keep failed-write evidence. */ }
        }
        syncFs.closeSync(folder);
    }
    return bytes;
}

async function writeLocked(directories, account, stamp, produce) {
    const base = { owner: account, directories };
    const directory = path.join(directories.root, 'hopper');
    const lock = path.join(directory, 'store.lock');
    const lockIdentity = withRoleplayAccount(base, stamp, () => {
        try { syncFs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        const stat = syncFs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(500, 'The private Meower storage directory is invalid.');
        const parent = syncFs.openSync(directories.root, constants.O_RDONLY | constants.O_DIRECTORY);
        try { syncFs.fsyncSync(parent); } finally { syncFs.closeSync(parent); }
        try {
            syncFs.mkdirSync(lock, { mode: 0o700 });
        } catch (error) {
            if (error.code === 'EEXIST') {
                // Never steal stale locks. Stop the host and clear this lock manually after a crash.
                fail(423, 'Meower storage is locked. Retry shortly; after a server crash, ask the administrator to clear the Meower storage lock while the host is stopped.');
            }
            throw error;
        }
        return syncFs.lstatSync(lock, { bigint: true });
    });
    try {
        withRoleplayAccount(base, stamp, () => syncFs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }));
        const current = await loadStore(directories, account);
        const draft = JSON.parse(JSON.stringify({ store: current.store, receipts: current.receipts }));
        const result = await produce(draft.store, draft.receipts, stamp);
        return withRoleplayAccount(base, stamp, () => {
            if (result?.unchanged || result?.conflict) return { ...current, ...result };
            if (current.store.revision === Number.MAX_SAFE_INTEGER) fail(500, 'The Meower revision limit has been reached. Nothing was saved.');
            const store = storeFrom({ ...draft.store, revision: current.store.revision + 1 }, { strict: true }).store;
            const envelope = { ...store, account, jobReceipts: draft.receipts };
            const { unused } = checkMeowerReceipts(draft.receipts);
            sizeOf(envelope, MAX_STORE_BYTES - 1 - unused, 'The Meower store including reserved job receipts');
            markServerStorage(directories.files);
            // Persist the imported revision first so even the first committed save has a private backup.
            if (current.previous === null) current.previous = saveStore(directory, current.store, null);
            saveStore(directory, envelope, current.previous);
            return { store, receipts: draft.receipts, warnings: [], result };
        });
    } finally {
        releaseStoreLock(base, stamp, lock, lockIdentity);
    }
}

function releaseStoreLock(base, stamp, lock, identity) {
    try {
        withRoleplayAccount(base, stamp, () => {
            const current = syncFs.lstatSync(lock, { bigint: true });
            if (current.dev !== identity.dev || current.ino !== identity.ino || current.birthtimeNs !== identity.birthtimeNs) fail(409, 'The Meower storage lock was replaced.');
            syncFs.rmSync(lock, { recursive: true });
        });
    } catch (error) {
        // An old epoch must never remove a replacement account's lock.
        if (!['ROLEPLAY_ACCOUNT_CHANGED', 'ROLEPLAY_ACCOUNT_UNAVAILABLE'].includes(error.code)) throw error;
    }
}

function resolveDirectories(directories) {
    return { ...directories, root: path.resolve(directories.root), files: path.resolve(directories.files) };
}

/** Native jobs and browser writes share this queue and the on-disk lock. */
export async function mutateMeowerStore(directories, account, produce) {
    directories = resolveDirectories(directories);
    const stamp = withRoleplayAccount({ owner: account, directories }, null, (_lease, current) => current);
    const key = path.resolve(directories.root);
    const attempt = (writes.get(key) ?? Promise.resolve()).then(() => writeLocked(directories, account, stamp, produce));
    const settled = attempt.catch(() => {});
    writes.set(key, settled);
    try { return await attempt; } finally {
        if (writes.get(key) === settled) writes.delete(key);
    }
}

/** Internal reads include permanent receipts; HTTP responses expose only the normal store. */
export async function readMeowerStore(directories, account) {
    directories = resolveDirectories(directories);
    const base = { owner: account, directories };
    const stamp = withRoleplayAccount(base, null, (_lease, current) => current);
    await writes.get(path.resolve(directories.root));
    const saved = await loadStore(directories, account);
    return withRoleplayAccount(base, stamp, () => saved);
}

/**
 * Disk: {format:1, revision:integer, settings:normalizeSettings(...), feeds:{[sessionId]:{version:1, posts:[], interactions:[], epoch?:string}}}.
 * The host mounts /api/plugins/hopper. Responses add authenticated account and optional warnings.
 * POST takes the base revision; 409 returns the current full envelope plus error, not a wrapper.
 * Native mutations and POST retain exact old bytes in store.previous.json.
 * jobReceipts is private, preserved on every browser save, and committed atomically with the feed.
 * Before committing, POST permanently marks files/hopper-server-storage.json; host imports stay untouched.
 */
export async function init(router) {
    const route = method => async (request, response) => {
        response.set?.('Cache-Control', 'no-store');
        try {
            const account = request.user?.profile?.handle;
            const hostDirectories = request.user?.directories;
            if (typeof account !== 'string' || !account.trim()) fail(401, 'Sign in before opening Meower.');
            if (!hostDirectories || ![hostDirectories.root, hostDirectories.files].every(value => typeof value === 'string' && value.trim())) {
                fail(500, 'Private Meower storage is unavailable for this account.');
            }
            // The host supports a relative dataRoot; resolve its authenticated paths before storage checks.
            const directories = { root: path.resolve(hostDirectories.root), files: path.resolve(hostDirectories.files) };
            if (request.headers?.['sec-fetch-site'] === 'cross-site') fail(403, 'Cross-site Meower requests are not allowed.');
            let result;
            if (method === 'GET') {
                const revision = request.query?.revision;
                if (revision !== undefined && (typeof revision !== 'string' || !/^(0|[1-9][0-9]*)$/.test(revision)
                    || !Number.isSafeInteger(Number(revision)))) fail(400, 'The Meower revision must be a non-negative integer.');
                result = await readMeowerStore(directories, account);
                if (revision !== undefined && Number(revision) === result.store.revision) {
                    return response.json({ account, revision: result.store.revision, unchanged: true });
                }
            } else {
                if (request.body?.account !== account) fail(409, 'The signed-in account changed. Reload Meower before continuing.');
                if (Number(request.headers?.['content-length']) > MAX_STORE_BYTES) fail(413, 'The Meower store exceeds 128 MiB.');
                const candidate = storeFrom(request.body, { strict: true, status: 400 }).store;
                result = await mutateMeowerStore(directories, account, store => {
                    if (candidate.revision !== store.revision) return { conflict: true };
                    Object.assign(store, candidate);
                });
            }
            return response.status(result.conflict ? 409 : 200).json({
                ...result.store,
                account,
                ...(result.conflict ? { error: 'Meower changed on another device. Merge with the current store before retrying.' } : {}),
                ...(result.warnings.length ? { warnings: result.warnings } : {}),
            });
        } catch (error) {
            return response.status(error.status ?? 500).json({ error: error.status ? error.message : 'Meower storage could not be read or saved. Your previous saved version is retained.' });
        }
    };
    router.get('/store', route('GET'));
    router.post('/store', route('POST'));
}
