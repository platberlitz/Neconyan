/** Snapshot blobs, their validated settings index, and retention. */
import {
    DEFAULT_KEEP_PER_TARGET,
    DEFAULT_MAX_TOTAL_BYTES,
    canonicalJson,
    hashOf,
    isPlainObject,
    legacyHashOf,
    prunePlan,
    snapshotFileName,
} from './core.js';

export const MODULE_NAME = 'NeconyanCardTimeMachine';
const SETTINGS_VERSION = 1;
const ATTACHMENT_KEY = '__Neconyan-Card-Time-Machine__';
const KINDS = new Set(['character', 'lorebook', 'preset']);
const COMMIT_TIMEOUT = 12_000;

function ctx() {
    return globalThis.SillyTavern.getContext();
}

function defaults() {
    return {
        settingsVersion: SETTINGS_VERSION,
        snapshots: [],
        quarantinedSnapshots: [],
        captureCharacters: true,
        captureLorebooks: true,
        capturePresets: true,
        keepPerTarget: DEFAULT_KEEP_PER_TARGET,
        maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
        lastCommit: '',
    };
}

function uniqueToken() {
    return globalThis.crypto?.randomUUID?.()
        ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function canonicalUrl(name) {
    return `/user/files/${name}`;
}

function normalUrl(url) {
    return typeof url === 'string' ? `/${url}`.replace(/^\/+/, '/') : '';
}

function normalizeRow(value) {
    if (!isPlainObject(value)
        || !KINDS.has(value.kind)
        || typeof value.target !== 'string' || value.target === ''
        || typeof value.label !== 'string'
        || typeof value.name !== 'string'
        || !Number.isFinite(value.ts)
        || !Number.isFinite(value.size) || value.size < 0
        || (value.hash !== null && !/^[0-9a-f]{64}$/.test(value.hash ?? ''))
        || (value.sourceTarget !== undefined && (typeof value.sourceTarget !== 'string' || value.sourceTarget === ''))
        || !new RegExp(`^cardtm_${value.kind}_[A-Za-z0-9_-]+\\.json$`).test(value.name)
        || normalUrl(value.url) !== canonicalUrl(value.name)) {
        return null;
    }
    return {
        ...value,
        id: value.name,
        ts: Number(value.ts),
        size: Number(value.size),
        url: canonicalUrl(value.name),
    };
}

let needsRepair = false;
const protectedSnapshotIds = new Set();
const unconfirmedCommits = new Set();

export function getSettings() {
    const container = ctx().extensionSettings;
    if (!isPlainObject(container[MODULE_NAME])) {
        container[MODULE_NAME] = defaults();
        needsRepair = true;
    }
    const settings = container[MODULE_NAME];
    const before = canonicalJson(settings);

    if (!Array.isArray(settings.snapshots)) {
        settings.snapshots = [];
    }
    if (!Array.isArray(settings.quarantinedSnapshots)) {
        settings.quarantinedSnapshots = [];
    }

    const valid = [];
    const seen = new Set();
    for (const candidate of settings.snapshots) {
        const row = normalizeRow(candidate);
        if (!row || seen.has(row.id)) {
            settings.quarantinedSnapshots.push(candidate);
            continue;
        }
        seen.add(row.id);
        valid.push(row);
    }
    settings.snapshots = valid;

    for (const key of ['captureCharacters', 'captureLorebooks', 'capturePresets']) {
        if (typeof settings[key] !== 'boolean') {
            settings[key] = defaults()[key];
        }
    }
    settings.keepPerTarget = Number.isFinite(settings.keepPerTarget)
        ? Math.max(1, Math.floor(settings.keepPerTarget))
        : DEFAULT_KEEP_PER_TARGET;
    settings.maxTotalBytes = Number.isFinite(settings.maxTotalBytes) && settings.maxTotalBytes > 0
        ? Math.floor(settings.maxTotalBytes)
        : DEFAULT_MAX_TOTAL_BYTES;
    settings.lastCommit = typeof settings.lastCommit === 'string' ? settings.lastCommit : '';
    settings.settingsVersion = SETTINGS_VERSION;

    needsRepair ||= before !== canonicalJson(settings);
    return settings;
}

export function saveSettings() {
    if (typeof ctx().saveSettingsDebounced !== 'function') {
        throw new Error('This Neconyan version cannot save extension settings');
    }
    ctx().saveSettingsDebounced();
}

export function listSnapshots() {
    return getSettings().snapshots;
}

/** Keeps restore inputs out of retention while a restore is in flight. */
export function pinSnapshots(ids) {
    ids.filter(Boolean).forEach(id => protectedSnapshotIds.add(id));
}

export function unpinSnapshots(ids) {
    ids.filter(Boolean).forEach(id => protectedSnapshotIds.delete(id));
}

/** The hash of the newest snapshot of a target, or null if there is none. */
export function lastHashOf(kind, target) {
    return newestRow(kind, target)?.hash ?? null;
}

function newestRow(kind, target) {
    return listSnapshots()
        .filter(row => row.kind === kind && row.target === target)
        .sort((a, b) => b.ts - a.ts)[0] ?? null;
}

async function post(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const error = new Error(`${url} responded ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return response;
}

async function readPersistedSettings() {
    const response = await post('/api/settings/get', { settingsOnly: true });
    const body = await response.json();
    const source = typeof body?.settings === 'string' ? JSON.parse(body.settings) : body?.settings ?? body;
    if (!isPlainObject(source)) {
        throw new Error('Neconyan returned malformed settings');
    }
    return source;
}

function persistedModule(settings) {
    const block = settings?.extension_settings?.[MODULE_NAME];
    return isPlainObject(block) ? block : null;
}

async function assertCurrentIndex() {
    const remoteValue = persistedModule(await readPersistedSettings())?.lastCommit;
    const remoteCommit = typeof remoteValue === 'string' ? remoteValue : '';
    const settings = getSettings();
    if (remoteCommit !== settings.lastCommit && unconfirmedCommits.delete(remoteCommit)) {
        // A timed-out save from this page landed after its local token was rolled back.
        settings.lastCommit = remoteCommit;
    } else if (remoteCommit !== settings.lastCommit) {
        const error = new Error('Time Machine changed in another tab. Reload Neconyan before changing its history.');
        error.code = 'STALE_INDEX';
        throw error;
    }
}

function waitForSettingsUpdate(timeout = 500) {
    const context = ctx();
    const type = context.eventTypes?.SETTINGS_UPDATED;
    return new Promise(resolve => {
        let timer;
        const done = () => {
            clearTimeout(timer);
            if (type) {
                context.eventSource?.removeListener?.(type, done);
            }
            resolve();
        };
        if (type) {
            context.eventSource?.on?.(type, done);
        }
        timer = setTimeout(done, timeout);
    });
}

/** Saves settings and resolves only after the module's commit token is read back. */
export function commitSettings() {
    return enqueueMutation(commitNow);
}

async function commitNow() {
    await assertCurrentIndex();
    const settings = getSettings();
    const previous = settings.lastCommit;
    const expected = uniqueToken();
    settings.lastCommit = expected;
    const deadline = Date.now() + COMMIT_TIMEOUT;
    let lastError;

    let changed = waitForSettingsUpdate();
    try {
        saveSettings();
    } catch (error) {
        if (settings.lastCommit === expected) {
            settings.lastCommit = previous;
        }
        throw error;
    }
    while (Date.now() < deadline) {
        await changed;
        try {
            if (persistedModule(await readPersistedSettings())?.lastCommit === expected) {
                unconfirmedCommits.clear();
                needsRepair = false;
                return;
            }
        } catch (error) {
            lastError = error;
        }
        changed = waitForSettingsUpdate(Math.min(500, Math.max(0, deadline - Date.now())));
    }

    // One last read before declaring failure: the write may have landed without
    // the update event or an earlier read having caught it. Rolling the token
    // back when the file already carries it would desync this tab and fail
    // every later capture with STALE_INDEX.
    try {
        if (persistedModule(await readPersistedSettings())?.lastCommit === expected) {
            unconfirmedCommits.clear();
            needsRepair = false;
            return;
        }
    } catch (error) {
        lastError = error;
    }

    unconfirmedCommits.add(expected);
    if (settings.lastCommit === expected) {
        settings.lastCommit = previous;
    }
    const error = new Error('Could not confirm that Time Machine settings were saved', { cause: lastError });
    error.code = 'COMMIT_UNCONFIRMED';
    throw error;
}

function snapshotContent(payload) {
    const { format, kind, target, label, ts, hash, ...content } = payload;
    return content;
}

function validatePayloadShape(row, payload) {
    if (!isPlainObject(payload)
        || payload.format !== 1
        || payload.kind !== row.kind
        || payload.target !== (row.sourceTarget ?? row.target)
        || payload.ts !== row.ts
        || typeof payload.label !== 'string'
        || !isPlainObject(payload.data)
        || (payload.tags !== undefined && (!Array.isArray(payload.tags) || payload.tags.some(tag => typeof tag !== 'string')))) {
        throw new Error(`Snapshot ${row.name} does not match its index`);
    }
}

async function validatePayloadHash(row, payload) {
    const expected = await (Object.prototype.hasOwnProperty.call(payload, 'hash')
        ? hashOf(snapshotContent(payload))
        : legacyHashOf(payload.data));
    if (!expected) {
        return;
    }
    if (row.hash && row.hash !== expected) {
        throw new Error(`Snapshot ${row.name} failed its integrity check`);
    }
    if (payload.hash && payload.hash !== expected) {
        throw new Error(`Snapshot ${row.name} failed its integrity check`);
    }
}

function requireRow(row) {
    const valid = normalizeRow(row);
    if (!valid) {
        throw new Error('Refusing an invalid Time Machine file path');
    }
    return valid;
}

async function upload(name, text) {
    const response = await post('/api/files/upload', { name, data: base64(text) });
    const body = await response.json();
    if (normalUrl(body?.path) !== canonicalUrl(name)) {
        throw new Error('Neconyan returned an unexpected snapshot path');
    }
}

let mutationQueue = Promise.resolve();

function enqueueMutation(action) {
    const run = mutationQueue.then(() => withBrowserLock(action), () => withBrowserLock(action));
    mutationQueue = run.then(() => {}, () => {});
    return run;
}

function withBrowserLock(action) {
    // ponytail: Web Locks coordinate tabs in one browser. The persisted commit
    // check fails closed for other devices instead of building a custom leader.
    return globalThis.navigator?.locks?.request
        ? globalThis.navigator.locks.request('neconyan-time-machine', async () => action())
        : action();
}

export function save(request, options = {}) {
    return enqueueMutation(() => saveNow(request, options));
}

async function saveNow({ kind, target, label, data, extra = {} }, { skipPrune = false, protectedIds = [] } = {}) {
    if (!KINDS.has(kind) || typeof target !== 'string' || !target || typeof label !== 'string'
        || !isPlainObject(data) || !isPlainObject(extra)) {
        throw new TypeError('Invalid snapshot request');
    }
    const reserved = ['format', 'kind', 'target', 'label', 'ts', 'hash', 'data'];
    if (reserved.some(key => Object.prototype.hasOwnProperty.call(extra, key))) {
        throw new TypeError('Snapshot extras contain a reserved field');
    }

    await assertCurrentIndex();
    const content = { data: structuredClone(data), ...structuredClone(extra) };
    const hash = await hashOf(content);
    const previous = newestRow(kind, target);
    if (hash && previous?.hash === hash) {
        try {
            await load(previous, { forgetMissing: false });
            if (!skipPrune) {
                await pruneNow({ protectedIds });
            }
            return null;
        } catch (error) {
            console.warn('[Time Machine] replacing an unreadable duplicate', previous.name, error);
            if (error.code === 'SNAPSHOT_MISSING') {
                settingsWithout(previous);
            }
        }
    }

    if (!hash) {
        console.warn('[Time Machine] WebCrypto is unavailable; saving without deduplication or integrity hashing');
    }
    const settings = getSettings();
    const ts = settings.snapshots.reduce((latest, row) => Math.max(latest, row.ts + 1), Date.now());
    const name = snapshotFileName(kind, target, `${ts}_${uniqueToken()}`, settings.snapshots.map(row => row.name));
    const payload = { format: 1, kind, target, label, ts, ...content, hash };
    const text = JSON.stringify(payload);
    const row = {
        id: name,
        ts,
        kind,
        target,
        label,
        name,
        url: canonicalUrl(name),
        hash,
        size: new TextEncoder().encode(text).length,
    };

    await upload(name, text);
    settings.snapshots.push(row);
    registerAttachment(row);
    try {
        await commitNow();
    } catch (error) {
        if (error.code === 'COMMIT_UNCONFIRMED') {
            throw error;
        }
        settings.snapshots = settings.snapshots.filter(item => item.id !== row.id);
        unregisterAttachment(row);
        await deleteBlob(row).catch(cleanupError => {
            console.error('[Time Machine] could not clean up an unindexed snapshot', row.name, cleanupError);
        });
        throw error;
    }

    if (!skipPrune) {
        await pruneNow({ protectedIds }).catch(error => {
            console.error('[Time Machine] snapshot saved, but retention failed', error);
        });
    }
    return row;
}

/** Loads and verifies the blob behind an already-validated index row. */
export async function load(row, { forgetMissing = true } = {}) {
    const valid = requireRow(row);
    const response = await fetch(valid.url, { cache: 'no-store' });
    if (response.status === 404) {
        if (forgetMissing) {
            void forget(valid).catch(error => console.error('[Time Machine] could not remove a missing snapshot row', error));
        }
        const error = new Error(`Snapshot ${valid.name} is no longer on the server`);
        error.code = 'SNAPSHOT_MISSING';
        throw error;
    }
    if (!response.ok) {
        throw new Error(`Could not read snapshot ${valid.name} (${response.status})`);
    }
    let payload;
    try {
        payload = await response.json();
    } catch (error) {
        throw new Error(`Snapshot ${valid.name} is not valid JSON`, { cause: error });
    }
    validatePayloadShape(valid, payload);
    await validatePayloadHash(valid, payload);
    return payload;
}

function settingsWithout(row) {
    const settings = getSettings();
    settings.snapshots = settings.snapshots.filter(item => item.id !== row.id);
    unregisterAttachment(row);
}

function forget(row) {
    return enqueueMutation(async () => {
        const valid = requireRow(row);
        await assertCurrentIndex();
        const settings = getSettings();
        if (!settings.snapshots.some(item => item.id === valid.id)) {
            return;
        }
        settingsWithout(valid);
        await commitNow();
    });
}

async function deleteBlob(row) {
    try {
        await post('/api/files/delete', { path: requireRow(row).url });
    } catch (error) {
        if (error.status !== 404) {
            throw error;
        }
    }
}

export function remove(row) {
    return enqueueMutation(() => {
        const valid = requireRow(row);
        if (protectedSnapshotIds.has(valid.id)) {
            throw new Error('That snapshot is in use by a restore and cannot be deleted');
        }
        return removeRows([valid]);
    });
}

export function prune(options = {}) {
    return enqueueMutation(() => pruneNow(options));
}

async function pruneNow({ protectedIds = [] } = {}) {
    const settings = getSettings();
    const doomed = new Set(prunePlan(settings.snapshots, {
        keepPerTarget: settings.keepPerTarget,
        maxTotalBytes: settings.maxTotalBytes,
        protectedIds: [...protectedSnapshotIds, ...protectedIds],
    }));
    return removeRows(settings.snapshots.filter(snapshot => doomed.has(snapshot.id)));
}

async function removeRows(rows) {
    if (rows.length === 0) {
        return 0;
    }
    const settings = getSettings();
    const ids = new Set(rows.map(row => row.id));
    const indexed = settings.snapshots.filter(row => ids.has(row.id));
    if (indexed.length === 0) {
        return 0;
    }

    // Commit the index change before unlinking files. A stale tab can then fail
    // safely without deleting blobs that the persisted index still references.
    const previousRows = settings.snapshots;
    const attachmentList = attachments();
    const previousAttachments = [...attachmentList];
    settings.snapshots = settings.snapshots.filter(row => !ids.has(row.id));
    indexed.forEach(unregisterAttachment);
    try {
        await commitNow();
    } catch (error) {
        settings.snapshots = previousRows;
        attachmentList.splice(0, attachmentList.length, ...previousAttachments);
        throw error;
    }

    const failures = [];
    for (const row of indexed) {
        try {
            await deleteBlob(row);
        } catch (error) {
            failures.push({ row, error });
        }
    }
    if (failures.length === 0) {
        return indexed.length;
    }

    // A failed or ambiguous unlink stays indexed so it can be retried and does
    // not become an unreachable server file.
    const current = getSettings();
    for (const { row } of failures) {
        if (!current.snapshots.some(item => item.id === row.id)) {
            current.snapshots.push(row);
            registerAttachment(row);
        }
    }
    await commitNow();
    if (failures.length === 1) {
        throw failures[0].error;
    }
    throw new AggregateError(failures.map(item => item.error), 'Some snapshots could not be deleted');
}

function attachments() {
    const container = ctx().extensionSettings;
    if (!isPlainObject(container.character_attachments)) {
        container.character_attachments = {};
        needsRepair = true;
    }
    if (!Array.isArray(container.character_attachments[ATTACHMENT_KEY])) {
        container.character_attachments[ATTACHMENT_KEY] = [];
        needsRepair = true;
    }
    return container.character_attachments[ATTACHMENT_KEY];
}

function registration(row) {
    return { url: row.url, size: row.size, name: row.name, created: row.ts };
}

function registerAttachment(row) {
    if (!attachments().some(entry => entry?.url === row.url)) {
        attachments().push(registration(row));
    }
}

function unregisterAttachment(row) {
    const list = attachments();
    const index = list.findIndex(entry => entry?.url === row.url);
    if (index !== -1) {
        list.splice(index, 1);
    }
}

/** Repairs persisted rows/registrations and applies changed retention settings. */
export function reconcile() {
    return enqueueMutation(async () => {
        await assertCurrentIndex();
        const desired = getSettings().snapshots.map(registration);
        const list = attachments();
        const registrationsChanged = canonicalJson(list) !== canonicalJson(desired);
        if (registrationsChanged) {
            list.splice(0, list.length, ...desired);
        }
        if (needsRepair || registrationsChanged) {
            await commitNow();
        }
        return pruneNow();
    });
}

/** Follows host rename events without rewriting immutable snapshot blobs. */
export function renameTarget(kind, oldTarget, newTarget, label) {
    return enqueueMutation(async () => {
        if (!KINDS.has(kind) || !oldTarget || !newTarget || oldTarget === newTarget) {
            return 0;
        }
        await assertCurrentIndex();
        const rows = getSettings().snapshots.filter(row => row.kind === kind && row.target === oldTarget);
        if (rows.length === 0) {
            return 0;
        }
        const previous = rows.map(row => ({ row, target: row.target, label: row.label, sourceTarget: row.sourceTarget }));
        for (const row of rows) {
            row.sourceTarget ??= row.target;
            row.target = newTarget;
            if (label !== undefined) {
                row.label = label;
            }
        }
        try {
            await commitNow();
        } catch (error) {
            const current = new Map(getSettings().snapshots.map(row => [row.id, row]));
            for (const item of previous) {
                const row = current.get(item.row.id);
                if (!row) {
                    continue;
                }
                row.target = item.target;
                row.label = item.label;
                if (item.sourceTarget === undefined) {
                    delete row.sourceTarget;
                } else {
                    row.sourceTarget = item.sourceTarget;
                }
            }
            throw error;
        }
        return rows.length;
    });
}

function base64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return globalThis.btoa(binary);
}
