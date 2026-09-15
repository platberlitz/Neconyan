import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { SETTINGS_KEY } from '../src/core.js';
import { MAX_STORE_BYTES, HOST_STORE_NAME, HOST_PLUGIN_MARKER, encodedLimit, migrateLegacy, parseBytes, sizeOf, storeFrom } from '../src/storage-format.js';

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
        if (!stat.isFile()) fail(500, 'Saved Meower data is not a regular file.');
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
        return { ...storeFrom(raw), previous };
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
    return { ...await migrateLegacy(raw, (pointer, limit) => readBytes(path.join(directories.files, path.basename(pointer)), limit)), previous: null };
}

async function temporaryFile(directory, bytes) {
    const file = path.join(directory, `store-${randomUUID()}.tmp`);
    try {
        const handle = await fs.open(file, 'wx', 0o600);
        try {
            await handle.writeFile(bytes);
            await handle.sync();
        } finally {
            await handle.close();
        }
        return file;
    } catch (error) {
        await fs.rm(file, { force: true }).catch(() => {});
        throw error;
    }
}

async function markServerStorage(directory) {
    const folder = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    let pending;
    try {
        pending = await temporaryFile(directory, '{"format":1,"storage":"server"}\n');
        await fs.rename(pending, path.join(directory, HOST_PLUGIN_MARKER));
        pending = null;
        // Keep the marker on failure, and sync it again on retry, even if already visible.
        await folder.sync();
    } finally {
        if (pending) await fs.rm(pending, { force: true }).catch(() => {});
        await folder.close();
    }
}

async function saveStore(directory, store, previous) {
    const bytes = `${sizeOf(store, MAX_STORE_BYTES - 1, 'The Meower store (128 MiB limit)')}\n`;
    const folder = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    const current = path.join(directory, 'store.json');
    let pending;
    let backup;
    let restored;
    try {
        pending = await temporaryFile(directory, bytes);
        if (previous !== null) {
            backup = await temporaryFile(directory, previous);
            await fs.rename(backup, path.join(directory, 'store.previous.json'));
            backup = null;
        }
        await folder.sync();
        await fs.rename(pending, current);
        pending = null;
        try {
            await folder.sync();
        } catch (error) {
            // A failed directory sync must not leave a newer visible revision after a failed save.
            if (previous !== null) {
                restored = await temporaryFile(directory, previous);
                await fs.rename(restored, current);
                restored = null;
            } else {
                await fs.unlink(current);
            }
            await folder.sync();
            throw error;
        }
    } finally {
        await Promise.all([pending, backup, restored].filter(Boolean).map(file => fs.rm(file, { force: true }).catch(() => {})));
        await folder.close();
    }
    return bytes;
}

async function writeLocked(directories, candidate, account) {
    const directory = path.join(directories.root, 'hopper');
    await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(500, 'The private Meower storage directory is invalid.');
    const parent = await fs.open(directories.root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
        await parent.sync();
    } finally {
        await parent.close();
    }
    const lock = path.join(directory, 'store.lock');
    try {
        await fs.mkdir(lock, { mode: 0o700 });
    } catch (error) {
        if (error.code === 'EEXIST') {
            // ponytail: never steal stale locks. Stop the host and clear hopper/store.lock manually after a crash.
            fail(423, 'Meower storage is locked. Retry shortly; after a server crash, ask the administrator to clear the Meower storage lock while the host is stopped.');
        }
        throw error;
    }
    try {
        await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
        const current = await loadStore(directories, account);
        if (candidate.revision !== current.store.revision) return { ...current, conflict: true };
        if (current.store.revision === Number.MAX_SAFE_INTEGER) fail(500, 'The Meower revision limit has been reached. Nothing was saved.');
        const store = { ...candidate, revision: current.store.revision + 1 };
        await markServerStorage(directories.files);
        // Persist the imported revision first so even the first committed save has a private backup.
        if (current.previous === null) current.previous = await saveStore(directory, current.store, null);
        await saveStore(directory, store, current.previous);
        return { store, warnings: [] };
    } finally {
        await fs.rm(lock, { recursive: true, force: true });
    }
}

/**
 * Disk: {format:1, revision:integer, settings:normalizeSettings(...), feeds:{[sessionId]:{version:1, posts:[], interactions:[], epoch?:string}}}.
 * The host mounts /api/plugins/hopper. Responses add authenticated account and optional warnings.
 * POST takes the base revision; 409 returns the current full envelope plus error, not a wrapper.
 * Only POST writes root/hopper/store.json, retaining exact old bytes in store.previous.json.
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
                result = await loadStore(directories, account);
                if (revision !== undefined && Number(revision) === result.store.revision) {
                    return response.json({ account, revision: result.store.revision, unchanged: true });
                }
            } else {
                if (request.body?.account !== account) fail(409, 'The signed-in account changed. Reload Meower before continuing.');
                if (Number(request.headers?.['content-length']) > MAX_STORE_BYTES) fail(413, 'The Meower store exceeds 128 MiB.');
                const candidate = storeFrom(request.body, { strict: true, status: 400 }).store;
                const key = path.resolve(directories.root);
                const attempt = (writes.get(key) ?? Promise.resolve()).then(() => writeLocked(directories, candidate, account));
                const settled = attempt.catch(() => {});
                writes.set(key, settled);
                try {
                    result = await attempt;
                } finally {
                    if (writes.get(key) === settled) writes.delete(key);
                }
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
