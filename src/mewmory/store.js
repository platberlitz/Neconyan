import fs from 'node:fs';
import { registerMemoryReclaimer } from '../memory-pressure.js';
import { isConstrainedMobileRuntime } from '../runtime.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { acquireChatFileLock, withChatFileLocks } from '../chat-file-lock.js';
import { readChatJsonlStrict } from '../chat-recovery.js';
import { recoverFileWriteSync } from '../util.js';
import { agentCollectionDirectory, readAgentCollection } from '../in-chat-agent-storage.js';
import { getActiveCompanionResults } from '../../public/scripts/extensions/in-chat-agents/companion/companion-shared.js';
import { fail, forkState, hash, newState, object, purgeSources, sourceAt, syncSources, text } from './core.js';
import { compactArchiveVectors } from './vector-storage.js';
import { readGroupSceneStart } from '../../public/scripts/group-chat-visibility.js';

export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

export function normalizeLocator(value) {
    object(value, 'Chat');
    // Validate filenames as text, but do not trim them into a different saved chat.
    text(value.chat, 'Chat name', 255);
    if (!value.group) text(value.avatar, 'Character file', 255);
    const chat = value.chat.replace(/\.jsonl$/, '');
    const avatar = value.group ? '' : value.avatar;
    if (!chat.trim() || sanitize(chat) !== chat || (avatar && sanitize(avatar) !== avatar)) fail('Invalid chat path: Mewmory could not work out which chat this is.');
    return { chat, avatar, group: value.group === true };
}

export function chatPath(directories, locator) {
    locator = normalizeLocator(locator);
    return locator.group
        ? path.join(directories.groupChats, locator.chat + '.jsonl')
        : path.join(directories.chats, locator.avatar.replace('.png', ''), locator.chat + '.jsonl');
}

export function statePath(directories, locator) {
    return path.join(directories.root, 'mewmory', 'stories', hash(normalizeLocator(locator)) + '.json');
}

export function recoveryPath(directories, locator) {
    return path.join(directories.root, 'mewmory', 'recovery', hash(normalizeLocator(locator)) + '.json');
}

export function buildMemoryRecoveryGuard(state) {
    const guard = {};
    for (const key of ['format', 'revision', 'storyId', 'branchId', 'sourceNamespace', 'locator', 'parent', 'enabled',
        'activeNpcIds', 'sceneNpcIds', 'castHistory', 'characterAliases', 'worldAliases', 'excludedSources',
        'timeline', 'inheritedTimeline', 'contextSources', 'lastDisableId', 'visibilityRestore']) guard[key] = state[key];
    guard.sources = Object.fromEntries(Object.values(state.sources).map(source => [source.id, {
        id: source.id, type: source.type, current: source.current, active: source.active,
        identity: source.identity, messageId: source.messageId,
        hash: sourceAt(state, { id: source.id, revision: source.current })?.hash,
    }]));
    return guard;
}

/** `serialized` is the finished text of `state` (normalised locator included) when the caller already built it. */
function writeState(directories, state, serialized) {
    state.locator = normalizeLocator(state.locator);
    // Archives reach several megabytes; serialise once for both the size check and the write.
    serialized ??= JSON.stringify(state);
    if (Buffer.byteLength(serialized) > MAX_ARCHIVE_BYTES) fail('This chat’s memory file has reached the 256 MiB size limit.', 413);
    const guard = buildMemoryRecoveryGuard(state);
    // Persist rejection counters before prose. A failed archive write can only make recovery stricter.
    const filename = recoveryPath(directories, state.locator);
    const previous = fs.existsSync(filename) ? fs.readFileSync(filename) : null;
    writeJson(filename, guard);
    const archive = statePath(directories, state.locator);
    try {
        writeSerializedJson(archive, serialized);
    } catch (error) {
        if (previous) writeFileAtomicSync(filename, previous, { mode: 0o600 });
        else fs.rmSync(filename, { force: true });
        throw error;
    }
    // The story list and the next change both start from what was just written, not a fresh read of it.
    const stat = fs.statSync(archive);
    rememberWrittenState(archive, serialized, statIdentity(stat));
    rememberStorySummary(path.resolve(archive), stat, state);
}

/**
 * The text of recently saved archives, so the next change to the same chat can tell whether
 * anything changed without serialising the whole archive again. An entry counts only while
 * the file still has the device, inode, size and times it had straight after the save.
 */
const writtenStates = new Map();
// V8 keeps JSON text that holds any character above U+00FF (a curly quote, a dash, an emoji) at two bytes per
// character, and JavaScript cannot tell which representation a string has, so the budget counts the worst case.
const WRITTEN_STATE_MAX_BYTES = 48 * 1024 * 1024;
const CONSTRAINED_WRITTEN_STATE_MAX_BYTES = 16 * 1024 * 1024;
const writtenStateMaxBytes = () => (isConstrainedMobileRuntime() ? CONSTRAINED_WRITTEN_STATE_MAX_BYTES : WRITTEN_STATE_MAX_BYTES);
const writtenStateBytes = serialized => serialized.length * 2;
let writtenStateTotal = 0;

const statIdentity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

export function fileIdentity(filename) {
    try {
        return statIdentity(fs.statSync(filename));
    } catch {
        return null;
    }
}

function forgetWrittenState(filename) {
    const written = writtenStates.get(filename);
    if (!written) return;
    writtenStates.delete(filename);
    writtenStateTotal -= writtenStateBytes(written.serialized);
}

function rememberWrittenState(filename, serialized, identity = fileIdentity(filename)) {
    forgetWrittenState(filename);
    const maxBytes = writtenStateMaxBytes();
    if (!identity || writtenStateBytes(serialized) > maxBytes) return;
    writtenStates.set(filename, { identity, serialized });
    writtenStateTotal += writtenStateBytes(serialized);
    while (writtenStateTotal > maxBytes) forgetWrittenState(writtenStates.keys().next().value);
}

/**
 * The serialised form of an unmodified archive read from filename while it had identity. The text
 * is remembered when the file did not change during the read, so repeated checks of an unchanged
 * chat serialise it once.
 */
function serializedArchive(filename, identity, shared) {
    const written = writtenStates.get(filename);
    if (identity && written?.identity === identity) return written.serialized;
    const serialized = JSON.stringify(shared);
    if (identity && fileIdentity(filename) === identity) rememberWrittenState(filename, serialized, identity);
    else forgetWrittenState(filename);
    return serialized;
}

/** Recover only source revisions independently vouched for by the saved, prose-free ledger. */
export function recoveryState(directories, locator, backup) {
    const guard = readJson(recoveryPath(directories, locator), null);
    if (!guard || guard.format !== 1 || hash(guard.locator) !== hash(normalizeLocator(locator))) {
        fail('Mewmory cannot confirm this export belongs to this chat. Keep the export file and restore the original memory file from a server backup.', 409);
    }
    if (backup?.format !== 1 || backup.storyId !== guard.storyId || backup.branchId !== guard.branchId) {
        fail('This export belongs to another story or chat branch, so it cannot be restored here.', 409);
    }
    const filename = statePath(directories, locator);
    const token = hash([guard, fs.existsSync(filename) ? hash(fs.readFileSync(filename, 'utf8')) : null]);
    const state = { ...newState(normalizeLocator(locator)), ...guard, sources: {} };
    for (const source of Object.values(guard.sources)) {
        const saved = backup.sources?.[source.id]?.revisions?.find(revision => revision.revision === source.current);
        const value = saved ? { ...saved } : null;
        if (value) { delete value.hash; delete value.revision; }
        const revisions = source.active && value && hash(value) === source.hash ? [structuredClone(saved)] : [];
        state.sources[source.id] = { ...source, active: source.active && revisions.length > 0, revisions };
        delete state.sources[source.id].hash;
    }
    if (state.inheritedTimeline.some(ref => !sourceAt(state, ref))) {
        fail('This export is missing the earlier chat this one continues from. Choose a newer export.', 409);
    }
    state.timeline = state.timeline.filter(ref => sourceAt(state, ref));
    state.contextSources = state.contextSources.filter(ref => sourceAt(state, ref));
    return { state, token };
}

export function commitRecovery(directories, locator, backup, state, token, sourceFingerprint) {
    const releaseChat = acquireChatFileLock(chatPath(directories, locator));
    try {
        const release = acquireChatFileLock(statePath(directories, locator));
        try {
            const source = readChat(directories, locator);
            if (hash([source.metadata, source.messages]) !== sourceFingerprint
                || recoveryState(directories, locator, backup).token !== token) fail('Saved memories changed after you reviewed the restore. Review the export again.', 409);
            state.revision++;
            state.updatedAt = Date.now();
            writeState(directories, state);
            return state;
        } finally {
            release();
        }
    } finally {
        releaseChat();
    }
}

export function readJson(filename, fallback) {
    try {
        const stat = fs.statSync(filename);
        if (!stat.isFile() || stat.size > MAX_ARCHIVE_BYTES) fail('The memory file for this chat is too large or damaged. Restore a valid export.', 409);
        return JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return fallback;
        if (error.status) throw error;
        fail('Mewmory could not read the saved memories for this chat. Restore a valid export before making changes.', 409);
    }
}

/**
 * Stat-validated parsed JSON for files that Mewmory reads many times inside one
 * scan (settings.json, connection presets). The returned object is shared
 * between callers, so treat it as read-only; never mutate it. A cached copy is
 * reused only while the file still has the same device, inode, size and
 * modification time, so an edited or replaced file is read again on its next
 * use. The cache is bounded by estimated heap bytes rather than entry count because a
 * single archive may be large.
 */
const sharedJsonCache = new Map();
// Parsed JSON takes several times its file size on the heap. Measured with forced collections: an MVU-style
// nested chat 4.4x, a prose chat 3.8x, an archive 3.7x, small-key objects alone 3.4x. The estimate rounds up to 5.
const PARSED_SIZE_FACTOR = 5;
// Estimated heap. This is the earlier 64 MiB of files at the estimated size of parsed data, so what an ordinary
// account keeps cached (the tester's five archives and settings.json together are 31 MiB of files) is unchanged;
// the figure now states the memory that holds, and the memory-pressure reclaimer empties it.
const SHARED_JSON_CACHE_MAX_BYTES = 64 * 1024 * 1024 * PARSED_SIZE_FACTOR;
const CONSTRAINED_SHARED_JSON_CACHE_MAX_BYTES = 16 * 1024 * 1024 * PARSED_SIZE_FACTOR;
const sharedJsonCacheMaxBytes = () => (isConstrainedMobileRuntime() ? CONSTRAINED_SHARED_JSON_CACHE_MAX_BYTES : SHARED_JSON_CACHE_MAX_BYTES);
let sharedJsonCacheBytes = 0;

function sameCachedFileStat(cached, stat) {
    return cached.dev === stat.dev && cached.ino === stat.ino && cached.size === stat.size
        && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs;
}

function removeCachedJson(key) {
    const cached = sharedJsonCache.get(key);
    if (!cached) return;
    sharedJsonCache.delete(key);
    sharedJsonCacheBytes -= cached.bytes;
}

/** Lets a test see (and for instance freeze) every value the shared cache is about to keep. */
export const sharedJsonHooks = { onParse: null };

export function readJsonShared(filename, fallback) {
    const key = path.resolve(filename);
    let stat;
    try {
        stat = fs.statSync(key);
    } catch (error) {
        removeCachedJson(key);
        if (error.code === 'ENOENT') return fallback;
        if (error.status) throw error;
        fail('Mewmory could not read the saved memories for this chat. Restore a valid export before making changes.', 409);
    }
    if (!stat.isFile() || stat.size > MAX_ARCHIVE_BYTES) {
        removeCachedJson(key);
        fail('The memory file for this chat is too large or damaged. Restore a valid export.', 409);
    }
    const cached = sharedJsonCache.get(key);
    if (cached && sameCachedFileStat(cached, stat)) {
        // Refresh recency so a hot archive is not evicted before its next scan.
        sharedJsonCache.delete(key);
        sharedJsonCache.set(key, cached);
        return cached.data;
    }
    removeCachedJson(key);
    let data;
    try {
        data = JSON.parse(fs.readFileSync(key, 'utf8'));
    } catch (error) {
        removeCachedJson(key);
        if (error.code === 'ENOENT') return fallback;
        fail('Mewmory could not read the saved memories for this chat. Restore a valid export before making changes.', 409);
    }
    const folder = path.dirname(key);
    if (data?.format === 1 && Array.isArray(data.records)
        && path.basename(folder) === 'stories' && path.basename(path.dirname(folder)) === 'mewmory'
        && /^[0-9a-f]{64}\.json$/.test(path.basename(key))) {
        compactArchiveVectors(data, { inPlace: true });
    }
    sharedJsonHooks.onParse?.(data, key);
    const entry = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, bytes: stat.size * PARSED_SIZE_FACTOR, data };
    sharedJsonCache.set(key, entry);
    sharedJsonCacheBytes += entry.bytes;
    const maxBytes = sharedJsonCacheMaxBytes();
    while (sharedJsonCacheBytes > maxBytes && sharedJsonCache.size > 1) {
        removeCachedJson(sharedJsonCache.keys().next().value);
    }
    return data;
}

const chatReadCache = new Map();
// Estimated heap again (see PARSED_SIZE_FACTOR): the same 64 MiB of chat files as before.
const CHAT_READ_CACHE_MAX_BYTES = 64 * 1024 * 1024 * PARSED_SIZE_FACTOR;
const CONSTRAINED_CHAT_READ_CACHE_MAX_BYTES = 16 * 1024 * 1024 * PARSED_SIZE_FACTOR;
const chatReadCacheMaxBytes = () => (isConstrainedMobileRuntime() ? CONSTRAINED_CHAT_READ_CACHE_MAX_BYTES : CHAT_READ_CACHE_MAX_BYTES);
let chatReadCacheBytes = 0;

function removeCachedChat(key) {
    const cached = chatReadCache.get(key);
    if (!cached) return;
    chatReadCache.delete(key);
    chatReadCacheBytes -= cached.bytes;
}

function chatSourceFromResult(result, filename) {
    if (result.status !== 'ok') fail('Mewmory cannot find the saved file for this chat. Save or reload the chat, then try again.', 409);
    return { metadata: result.records[0].chat_metadata || {}, messages: result.records.slice(1), filename };
}

/** Shared, read-only chat snapshots for Mewmory's periodic reconciliation path. */
export function readChatShared(directories, locator) {
    const filename = chatPath(directories, locator);
    const key = path.resolve(filename);
    recoverFileWriteSync(key);
    let stat;
    try {
        stat = fs.lstatSync(key);
    } catch {
        removeCachedChat(key);
        return chatSourceFromResult(readChatJsonlStrict(key), filename);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
        removeCachedChat(key);
        return chatSourceFromResult(readChatJsonlStrict(key), filename);
    }
    const cached = chatReadCache.get(key);
    if (cached && sameCachedFileStat(cached, stat)) {
        chatReadCache.delete(key);
        chatReadCache.set(key, cached);
        return cached.source;
    }
    removeCachedChat(key);
    const result = readChatJsonlStrict(key, { recover: false });
    const source = chatSourceFromResult(result, filename);
    const entry = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, bytes: stat.size * PARSED_SIZE_FACTOR, source };
    chatReadCache.set(key, entry);
    chatReadCacheBytes += entry.bytes;
    const maxBytes = chatReadCacheMaxBytes();
    while (chatReadCacheBytes > maxBytes && chatReadCache.size > 1) {
        removeCachedChat(chatReadCache.keys().next().value);
    }
    return source;
}

/** What the store's caches hold now and may hold at most, in estimated heap bytes. */
export function cacheUsage() {
    return {
        writtenStates: { bytes: writtenStateTotal, max: writtenStateMaxBytes(), entries: writtenStates.size },
        sharedJson: { bytes: sharedJsonCacheBytes, max: sharedJsonCacheMaxBytes(), entries: sharedJsonCache.size },
        chatRead: { bytes: chatReadCacheBytes, max: chatReadCacheMaxBytes(), entries: chatReadCache.size },
    };
}

const storySummaryCache = new Map();
registerMemoryReclaimer(() => {
    sharedJsonCache.clear();
    sharedJsonCacheBytes = 0;
    chatReadCache.clear();
    chatReadCacheBytes = 0;
    storySummaryCache.clear();
    writtenStates.clear();
    writtenStateTotal = 0;
});
// Summaries are a few hundred bytes. The worker lists every story each scan, so a cap below the
// story count evicted each entry just before it was needed and every scan re-parsed every archive.
const STORY_SUMMARY_CACHE_MAX_ENTRIES = 10_000;

function cloneStorySummary(summary) {
    return {
        ...summary,
        locator: { ...summary.locator },
        processing: summary.processing ? { ...summary.processing } : null,
        visibilityRestore: summary.visibilityRestore ? structuredClone(summary.visibilityRestore) : null,
    };
}

function readStorySummary(directories, filename) {
    const key = path.resolve(filename);
    const expectedHash = path.basename(filename, '.json');
    let stat;
    try {
        stat = fs.statSync(key);
    } catch {
        storySummaryCache.delete(key);
        return null;
    }
    const cached = storySummaryCache.get(key);
    if (cached && sameCachedFileStat(cached, stat)) {
        if (!fs.existsSync(chatPath(directories, cached.summary.locator))) {
            storySummaryCache.delete(key);
            return null;
        }
        // Refresh recency just like the shared JSON cache.
        storySummaryCache.delete(key);
        storySummaryCache.set(key, cached);
        return cloneStorySummary(cached.summary);
    }
    let state;
    try {
        state = readJson(key, null);
        if (!state || state.format !== 1 || !state.locator) {
            storySummaryCache.delete(key);
            return null;
        }
        const locator = normalizeLocator(state.locator);
        validateState(locator, state, expectedHash);
        if (!fs.existsSync(chatPath(directories, locator))) {
            storySummaryCache.delete(key);
            return null;
        }
    } catch {
        storySummaryCache.delete(key);
        return null;
    }
    return cloneStorySummary(rememberStorySummary(key, stat, state));
}

// The entry must carry every field sameCachedFileStat compares, or no listing ever reuses it.
function rememberStorySummary(key, stat, state) {
    const summary = {
        locator: { ...state.locator }, storyId: state.storyId, branchId: state.branchId, enabled: state.enabled,
        updatedAt: state.updatedAt, processing: state.processing ? { status: state.processing.status, automatic: state.processing.automatic } : null,
        visibilityRestore: state.visibilityRestore ? structuredClone(state.visibilityRestore) : null,
    };
    storySummaryCache.delete(key);
    storySummaryCache.set(key, { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, summary });
    while (storySummaryCache.size > STORY_SUMMARY_CACHE_MAX_ENTRIES) storySummaryCache.delete(storySummaryCache.keys().next().value);
    return summary;
}

export function writeJson(filename, value) {
    writeSerializedJson(filename, JSON.stringify(value));
}

function writeSerializedJson(filename, serialized) {
    if (Buffer.byteLength(serialized) > MAX_ARCHIVE_BYTES) fail('This chat’s memory file has reached the 256 MiB size limit. Export it and start a new chat before adding more memories.', 413);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    writeFileAtomicSync(filename, serialized, { encoding: 'utf8', mode: 0o600 });
}

export function readChat(directories, locator) {
    const filename = chatPath(directories, locator);
    const result = readChatJsonlStrict(filename);
    if (result.status !== 'ok') fail('Mewmory cannot find the saved file for this chat. Save or reload the chat, then try again.', 409);
    return { metadata: result.records[0].chat_metadata || {}, messages: result.records.slice(1), filename };
}

function validateState(locator, state, expectedHash = hash(locator)) {
    if (state.format !== 1 || hash(normalizeLocator(state.locator)) !== expectedHash || hash(locator) !== expectedHash || !Array.isArray(state.records)) {
        fail('This memory file is from an unsupported version or belongs to a different chat.', 409);
    }
    const restore = state.visibilityRestore;
    if (restore && (!['pending', 'failed', 'complete'].includes(restore.status)
        || typeof restore.operationKey !== 'string' || !restore.operationKey || restore.operationKey.length > 256
        || typeof restore.branchId !== 'string' || typeof restore.account?.accountId !== 'string'
        || !Number.isSafeInteger(restore.account?.dataEpoch) || typeof restore.instanceId !== 'string')) {
        fail('Mewmory cannot read the saved message restoration state. Keep the memory file and restore a valid backup.', 409);
    }
    return state;
}

/**
 * Read-only worker and index paths share the parsed archive. The cache is
 * stat-validated, and callers must not mutate the returned object.
 */
export function readStateShared(directories, locator) {
    locator = normalizeLocator(locator);
    const state = readJsonShared(statePath(directories, locator), null);
    if (!state) {
        if (fs.existsSync(recoveryPath(directories, locator))) fail('The Mewmory archive is missing for this chat. Restore it from an export before making changes.', 409);
        return newState(locator);
    }
    return validateState(locator, state);
}

/** All callers of readState may mutate the result, so never expose the shared object. */
export function readState(directories, locator) {
    return structuredClone(readStateShared(directories, locator));
}

/** Do not reconcile or write an archive just to discover that a chat has not opted in. */
export function memoryEnabled(directories, locator) {
    try {
        return readStateShared(directories, locator).enabled === true;
    } catch (error) {
        if (error.status === 409 && readLibraryArchive(recoveryPath(directories, locator), true)?.enabled === false) return false;
        throw error;
    }
}

// The map is copied (a few pointers per entry) so adding or removing an entry cannot reach the shared one;
// the entries stay shared.
const copyVectorMap = vectors => Array.isArray(vectors) ? vectors.slice() : vectors && typeof vectors === 'object' ? { ...vectors } : vectors;

function cloneIndexShell(index) {
    const copy = {};
    for (const key of Object.keys(index)) {
        const value = index[key];
        copy[key] = key === 'vectors' ? copyVectorMap(value)
            : key === 'build' && value && typeof value === 'object' && !Array.isArray(value) ? cloneIndexShell(value) : structuredClone(value);
    }
    return copy;
}

/**
 * An owned copy of a shared state for a mutator. The embedding vectors are the one part whose entries are not
 * copied: they are immutable (every writer builds a new entry and assigns it to a copy of the map), and they
 * are most of a large archive. Key order is kept, because it decides the bytes written.
 */
export function cloneState(shared) {
    const state = {};
    for (const key of Object.keys(shared)) {
        const value = shared[key];
        state[key] = key === 'index' && value && typeof value === 'object' && !Array.isArray(value)
            ? cloneIndexShell(value) : structuredClone(value);
    }
    return state;
}

/** The text of each top-level key, so the three fields a write changes can be swapped in without serialising again. */
function topLevelText(state) {
    const entries = [];
    for (const key of Object.keys(state)) {
        const text = JSON.stringify(state[key]);
        if (text !== undefined) entries.push({ key, name: JSON.stringify(key), text });
    }
    return entries;
}

/** Whether `entries` joined as one object give exactly `serialized`, without building that text. */
function sameSerialized(serialized, entries) {
    let position = 0;
    for (const [index, { name, text }] of entries.entries()) {
        const head = (index ? ',' : '{') + name + ':';
        if (!serialized.startsWith(head, position)) return false;
        position += head.length;
        if (!serialized.startsWith(text, position)) return false;
        position += text.length;
    }
    return serialized.length === position + (entries.length ? 1 : 2) && serialized.endsWith(entries.length ? '}' : '{}');
}

/** The text JSON.stringify would give after assigning `changes` to the state, keys it lacked going last in order. */
function joinSerialized(entries, changes) {
    const parts = [];
    const used = new Set();
    for (const { key, name, text } of entries) {
        used.add(key);
        parts.push(name + ':' + (Object.hasOwn(changes, key) ? JSON.stringify(changes[key]) : text));
    }
    for (const [key, value] of Object.entries(changes)) if (!used.has(key)) parts.push(JSON.stringify(key) + ':' + JSON.stringify(value));
    // The braces ride on the first and last (small) pieces so the join is one flat string, not a wrapper that copies it again.
    if (!parts.length) return '{}';
    parts[0] = '{' + parts[0];
    parts[parts.length - 1] += '}';
    return parts.join(',');
}

export function mutateState(directories, locator, mutate, expectedRevision, { existingOnly = false, onSettled } = {}) {
    locator = normalizeLocator(locator);
    const filename = statePath(directories, locator);
    const release = acquireChatFileLock(filename);
    try {
        if (existingOnly && !fs.existsSync(filename)) return null;
        const identity = fileIdentity(filename);
        const shared = readStateShared(directories, locator);
        const state = cloneState(shared);
        if (expectedRevision !== undefined && state.revision !== expectedRevision) {
            fail('Mewmory changed while this was running. Reload Mewmory and try again.', 409);
        }
        // Compare serialised text directly; hashing both copies of a large archive cost more than the comparison.
        let before = identity ? serializedArchive(filename, identity, shared) : null;
        const result = compactArchiveVectors(mutate(state) || state);
        // One serialisation serves the comparison and the write: only revision, updatedAt and locator differ between them.
        let entries = topLevelText(result);
        const changed = before === null || !fs.existsSync(filename) || !sameSerialized(before, entries);
        // Once compared, the old text is of no more use, and the pieces are not needed after they are joined: at most
        // two full texts are alive at any moment, and only one while the file is written.
        before = null;
        if (changed) {
            forgetWrittenState(filename);
            result.revision = state.revision + 1;
            result.updatedAt = Date.now();
            result.locator = normalizeLocator(result.locator);
            const serialized = joinSerialized(entries, { revision: result.revision, updatedAt: result.updatedAt, locator: result.locator });
            entries = null;
            writeState(directories, result, serialized);
        } else if (!fs.existsSync(recoveryPath(directories, locator))) {
            writeState(directories, result);
        }
        onSettled?.({ changed, shared, identity: fileIdentity(filename), guard: fileIdentity(recoveryPath(directories, locator)) });
        return result;
    } finally {
        release();
    }
}

/**
 * Change only processing under the archive lock. All other nested data in the
 * returned state is shared and read-only, just like readStateShared.
 */
export function updateProcessing(directories, locator, guards, { set = {}, remove = [] } = {}) {
    locator = normalizeLocator(locator);
    const filename = statePath(directories, locator);
    const release = acquireChatFileLock(filename);
    try {
        if (guards.existingOnly && !fs.existsSync(filename)) return { state: null, changed: false };
        const shared = readStateShared(directories, locator);
        if (guards.expectedRevision !== undefined && shared.revision !== guards.expectedRevision) {
            fail('Mewmory changed while this was running. Reload Mewmory and try again.', 409);
        }
        const state = { ...shared };
        let processing = structuredClone(shared.processing);
        if (Object.hasOwn(shared, 'processing')) state.processing = processing;
        const matches = shared.branchId === guards.branchId && Object.hasOwn(guards, 'jobId')
            && shared.processing?.id === guards.jobId
            && (guards.status === undefined || shared.processing?.status === guards.status);
        let changed = false;
        if (matches) {
            const patch = structuredClone(set);
            if (Object.keys(patch).length) processing = { ...processing, ...patch };
            if (processing != null) for (const key of remove) delete processing[key];
            if (Object.hasOwn(shared, 'processing') || processing !== undefined) state.processing = processing;
            // Only processing can differ. Differential checks pin this to the full-state decision.
            changed = JSON.stringify(processing) !== JSON.stringify(shared.processing) || !fs.existsSync(filename);
        }
        if (changed) {
            state.revision = shared.revision + 1;
            state.updatedAt = Date.now();
            writeState(directories, state);
        } else if (!fs.existsSync(recoveryPath(directories, locator))) {
            // writeState normalises locator, so even a repair must own its top-level object.
            writeState(directories, state);
        }
        return { state, changed };
    } finally {
        release();
    }
}

/** True when a saved tracker result predates the category snapshot, so syncing it reads the Agent library. */
export const hasLegacyTrackerResults = messages => messages.some(message => Object.values(getActiveCompanionResults(message))
    .some(result => result?.status === 'done' && !result.agentCategory));

/** Capture the same legacy tracker configuration for real or shadow reconciliation. */
export function sourceSyncOptions(directories, messages) {
    const legacy = hasLegacyTrackerResults(messages);
    const trackerAgentIds = legacy ? readAgentCollection(agentCollectionDirectory(directories)).records
        .filter(agent => agent.category === 'tracker').map(agent => agent.id) : [];
    return { trackerAgentIds };
}

/** `onSettled` receives what mutateState reports once the archive is saved or found unchanged, still under its lock. */
export function synchronize(directories, locator, context = [], source = readChatShared(directories, locator), extraChange, onSettled) {
    locator = normalizeLocator(locator);
    // Native saves take this lock first too; never reconcile a chat snapshot read before it.
    return withChatFileLocks([chatPath(directories, locator)], () => {
        captureBranchMemory(directories, locator, source);
        // Older saved results predate the category snapshot; resolve them from the saved Agent library.
        const options = sourceSyncOptions(directories, source.messages);
        return mutateState(directories, locator, state => {
            syncSources(state, source.messages, context, { ...options, ...(source.metadata ? { groupStart: readGroupSceneStart(source.metadata) } : {}) });
            // Archive upkeep that must share the same clone and write as the source sync.
            return extraChange ? extraChange(state) || state : state;
        }, undefined, { onSettled });
    });
}

/**
 * The parent of a branch chat, given an already canonical child locator. Older and imported
 * chats can name the parent with a group's numeric id or a name that is not a safe file name;
 * the first still resolves and the second simply has no parent memory.
 */
export function branchParentLocator(locator, metadata) {
    const value = metadata?.main_chat;
    if (!value) return null;
    const chat = Number.isSafeInteger(value) ? String(value) : value;
    let parent;
    try {
        parent = normalizeLocator({ ...locator, chat });
    } catch (error) {
        if (error?.status === 400) return null;
        throw error;
    }
    return parent.chat === locator.chat ? null : parent;
}

/** Called by native saves before reporting branch creation as successful. */
export function captureBranchMemory(directories, locator, { metadata, messages }) {
    if (!directories.root) return;
    locator = normalizeLocator(locator);
    const parentLocator = branchParentLocator(locator, metadata);
    if (!parentLocator || fs.existsSync(statePath(directories, locator)) || fs.existsSync(recoveryPath(directories, locator))) return;
    const parentFile = statePath(directories, parentLocator);
    if (!fs.existsSync(parentFile)) return;
    return withChatFileLocks([parentFile, statePath(directories, locator)], () => {
        if (fs.existsSync(statePath(directories, locator))) return;
        const parent = readState(directories, parentLocator);
        const child = buildBranchMemoryState(parent, normalizeLocator(locator), messages);
        writeState(directories, child);
    });
}

/** The caller supplies an already canonical locator; recovery reuses the resulting bytes. */
export function buildBranchMemoryState(parent, locator, messages) {
    const offset = parent.inheritedTimeline?.length || 0;
    let through = offset - 1;
    for (let index = 0; index < messages.length; index++) {
        const previous = sourceAt(parent, parent.timeline[index + offset]);
        if (!previous || (previous.storyText ?? previous.text) !== String(messages[index].mes ?? '')
            || previous.speaker !== String(messages[index].name ?? '')) break;
        through = index + offset;
    }
    const child = forkState(parent, locator, through, messages);
    child.revision = 1;
    return child;
}

/** Lists the saved stories one file per step, so a caller can pause between files. */
function* storyListing(directories) {
    if (!directories.root) {
        storySummaryCache.clear();
        return [];
    }
    const directory = path.join(directories.root, 'mewmory', 'stories');
    if (!fs.existsSync(directory)) {
        storySummaryCache.clear();
        return [];
    }
    const names = fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    const seen = new Set();
    const stories = [];
    for (const name of names) {
        const filename = path.join(directory, name);
        seen.add(path.resolve(filename));
        const summary = readStorySummary(directories, filename);
        if (summary) stories.push(summary);
        yield;
    }
    for (const key of storySummaryCache.keys()) {
        if (key.startsWith(path.resolve(directory) + path.sep) && !seen.has(key)) storySummaryCache.delete(key);
    }
    return stories;
}

export function listStories(directories) {
    const listing = storyListing(directories);
    for (;;) {
        const step = listing.next();
        if (step.done) return step.value;
    }
}

/** The first listing after a start reads every story's whole memory file; let page requests run between files. */
export async function listStoriesGradually(directories) {
    const listing = storyListing(directories);
    for (;;) {
        const step = listing.next();
        if (step.done) return step.value;
        await new Promise(resolve => setImmediate(resolve));
    }
}

export function removeChatMemory(directories, locator) {
    if (!directories.root) return;
    const filename = statePath(directories, locator);
    const release = acquireChatFileLock(filename);
    try {
        const state = readLibraryArchive(filename);
        const guard = readLibraryArchive(recoveryPath(directories, locator), true);
        const storyIds = new Set([state?.storyId, guard?.storyId].filter(Boolean));
        if (storyIds.size) {
            try {
                updateSharedMemories(directories, entries => entries.filter(entry => !storyIds.has(entry.storyId)));
            } catch (error) {
                if (error.status !== 409) throw error;
                // Do not overwrite a damaged catalogue, or leave the deleted chat's private archive behind.
                console.warn('Could not remove published copies from the unreadable Mewmory shared catalogue.');
            }
        }
        fs.rmSync(filename, { force: true });
        fs.rmSync(recoveryPath(directories, locator), { force: true });
    } finally {
        release();
    }
}

const SHARED_LIMIT = 500;

export function readSharedMemories(directories) {
    const saved = readJsonShared(path.join(directories.root, 'mewmory', 'shared.json'), null);
    return Array.isArray(saved?.entries) ? saved.entries.filter(entry => entry && typeof entry === 'object' && entry.id) : [];
}

export function updateSharedMemories(directories, change) {
    const filename = path.join(directories.root, 'mewmory', 'shared.json');
    return withChatFileLocks([filename], () => {
        const before = readSharedMemories(directories);
        const entries = change(before).slice(-SHARED_LIMIT);
        if (entries.length !== before.length || entries.some((entry, i) => entry !== before[i])) writeJson(filename, { entries });
    });
}

function readLibraryArchive(filename, guard = false) {
    try {
        const state = readJsonShared(filename, null);
        if (!state) return null;
        const locator = normalizeLocator(state.locator);
        const expectedHash = path.basename(filename, '.json');
        if (state.format !== 1 || hash(locator) !== expectedHash || typeof state.storyId !== 'string') fail('Invalid Mewmory archive.', 409);
        if (!guard) {
            validateState(locator, state, expectedHash);
            object(state.sources, 'Mewmory sources');
            if (Object.values(state.sources).some(source => !source || typeof source.id !== 'string'
                || !Array.isArray(source.revisions) || source.revisions.some(revision => !revision || typeof revision !== 'object'))) {
                fail('Invalid Mewmory sources.', 409);
            }
        }
        return state;
    } catch (error) {
        if (error.status !== 400 && error.status !== 409) throw error;
        console.warn('Skipping an unreadable Mewmory file during library maintenance:', path.basename(filename));
        return null;
    }
}

function libraryArchives(directories, kind) {
    const directory = path.join(directories.root, 'mewmory', kind);
    return fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)) : [];
}

export function chatMemoryExists(directories, locator) {
    return Boolean(directories.root) && (fs.existsSync(statePath(directories, locator)) || fs.existsSync(recoveryPath(directories, locator)));
}

/**
 * `resume` finishes a recorded rename from any point a crash could leave it: a stale guard written before
 * the new archive, a new archive beside the old one, or a finished move whose old guard remained.
 */
export function renameChatMemory(directories, oldLocator, newLocator, { resume = false } = {}) {
    if (!directories.root) return false;
    const before = statePath(directories, oldLocator);
    const after = statePath(directories, newLocator);
    if (before === after) return;
    if (!fs.existsSync(before) && !fs.existsSync(recoveryPath(directories, oldLocator))) return;
    return withChatFileLocks([before, after], () => {
        if (resume && fs.existsSync(after)) {
            const previous = fs.existsSync(before) ? readJson(before, null) : null;
            if (!previous || readJson(after, null)?.revision > previous.revision) {
                fs.rmSync(before, { force: true });
                fs.rmSync(recoveryPath(directories, oldLocator), { force: true });
                return true;
            }
        }
        if (resume && !fs.existsSync(after) && fs.existsSync(before)) fs.rmSync(recoveryPath(directories, newLocator), { force: true });
        if (fs.existsSync(after) || fs.existsSync(recoveryPath(directories, newLocator))) fail('Memories already exist for a chat with that name. Choose a different name.', 409);
        const state = readState(directories, oldLocator);
        state.locator = normalizeLocator(newLocator);
        for (const job of state.jobs.filter(job => job.status === 'processing')) {
            Object.assign(job, { status: 'failed', error: 'The chat was renamed while this was running. Open the renamed chat and try again.', finishedAt: Date.now() });
        }
        state.revision++;
        writeState(directories, state);
        try {
            fs.unlinkSync(before);
        } catch (error) {
            fs.unlinkSync(after);
            fs.rmSync(recoveryPath(directories, newLocator), { force: true });
            throw error;
        }
        fs.rmSync(recoveryPath(directories, oldLocator), { force: true });
        return true;
    });
}

/** Explicit card/book deletion also reaches stores whose chats are not currently open. */
export function removeSourceMemory(directories, { avatar = '', world = '', deleteChats = false }) {
    if (!directories.root) return;
    const directory = path.join(directories.root, 'mewmory', 'stories');
    const files = libraryArchives(directories, 'stories');
    const deleted = new Set();
    const matchingSources = state => Object.values(state.sources).filter(source => {
        if (!source || (source.type !== 'character' && source.type !== 'lore')) return false;
        const version = sourceAt(state, { id: source.id, revision: source.current });
        return (avatar && source.type === 'character' && (version?.meta?.avatar === avatar
            || source.id === 'character:' + hash(state.characterAliases?.[avatar] || avatar).slice(0, 32)))
            || (world && source.type === 'lore' && (version?.meta?.world === world
                || source.id === 'lore:' + hash([state.worldAliases?.[world] || world, version?.meta?.uid]).slice(0, 32)));
    }).map(source => source.id);
    if (avatar && deleteChats) {
        for (const filename of new Set([...files, ...libraryArchives(directories, 'recovery')])) {
            const state = readLibraryArchive(path.join(directory, filename))
                || readLibraryArchive(path.join(directories.root, 'mewmory', 'recovery', filename), true);
            if (state && !state.locator.group && state.locator.avatar === avatar) {
                removeChatMemory(directories, state.locator);
                deleted.add(filename);
            }
        }
    }
    for (const filename of files) {
        if (deleted.has(filename)) continue;
        const state = readLibraryArchive(path.join(directory, filename));
        if (!state || !matchingSources(state).length) continue;
        mutateState(directories, state.locator, current => {
            const ids = matchingSources(current);
            if (ids.length) purgeSources(current, ids);
        }, undefined, { existingOnly: true });
    }
}

export function renameCharacterMemory(directories, oldAvatar, newAvatar, { resume = false } = {}) {
    return renameLibraryMemory(directories, 'character', oldAvatar, newAvatar, { resume });
}

export function renameWorldMemory(directories, oldName, newName) {
    return renameLibraryMemory(directories, 'lore', oldName, newName);
}

function renameLibraryMemory(directories, type, oldName, newName, { resume = false } = {}) {
    const aliasKey = type === 'character' ? 'characterAliases' : 'worldAliases';
    const metaKey = type === 'character' ? 'avatar' : 'world';
    const changes = [];
    const undo = () => {
        for (const change of changes.slice().reverse()) {
            if (change.aliased) mutateState(directories, change.after, state => {
                state[aliasKey] = change.aliases;
                for (const source of Object.values(state.sources).filter(source => change.ids.includes(source.id))) {
                    for (const revision of source.revisions) {
                        revision.meta[metaKey] = oldName;
                        const value = { ...revision };
                        delete value.revision;
                        delete value.hash;
                        revision.hash = hash(value);
                    }
                }
            });
            if (change.moved) renameChatMemory(directories, change.after, change.before);
        }
    };
    if (!directories.root) return undo;
    const directory = path.join(directories.root, 'mewmory', 'stories');
    try {
        for (const filename of libraryArchives(directories, 'stories')) {
            const state = readLibraryArchive(path.join(directory, filename));
            if (!state) continue;
            const canonical = state[aliasKey]?.[oldName] || oldName;
            const ownsChat = type === 'character' && !state.locator.group && state.locator.avatar === oldName;
            const ids = Object.values(state.sources).filter(source => source.type === type
                && sourceAt(state, { id: source.id, revision: source.current })?.meta?.[metaKey] === oldName).map(source => source.id);
            if (!ownsChat && !ids.length) continue;
            const change = { before: state.locator, after: ownsChat ? { ...state.locator, avatar: newName } : state.locator,
                aliases: structuredClone(state[aliasKey] || {}), ids, moved: false, aliased: false };
            changes.push(change);
            if (ownsChat) change.moved = renameChatMemory(directories, change.before, change.after, { resume });
            mutateState(directories, change.after, current => {
                current[aliasKey] ??= {};
                current[aliasKey][newName] = canonical;
                current[aliasKey][oldName] = randomUUID();
                for (const source of Object.values(current.sources).filter(source => ids.includes(source.id))) {
                    for (const revision of source.revisions) {
                        revision.meta[metaKey] = newName;
                        const value = { ...revision };
                        delete value.revision;
                        delete value.hash;
                        revision.hash = hash(value);
                    }
                }
            });
            change.aliased = true;
        }
        return undo;
    } catch (error) {
        undo();
        throw error;
    }
}
