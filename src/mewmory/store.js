import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { acquireChatFileLock, withChatFileLocks } from '../chat-file-lock.js';
import { readChatJsonlStrict } from '../chat-recovery.js';
import { recoverFileWriteSync } from '../util.js';
import { fail, forkState, hash, newState, object, purgeSources, sourceAt, syncSources, text } from './core.js';

export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

export function normalizeLocator(value) {
    object(value, 'Chat');
    const chat = text(value.chat, 'Chat name', 255).replace(/\.jsonl$/, '');
    const avatar = value.group ? '' : text(value.avatar, 'Character file', 255);
    if (!chat || sanitize(chat) !== chat || (avatar && sanitize(avatar) !== avatar)) fail('Invalid chat path: Mewmory could not work out which chat this is.');
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

function recoveryPath(directories, locator) {
    return path.join(directories.root, 'mewmory', 'recovery', hash(normalizeLocator(locator)) + '.json');
}

export function buildMemoryRecoveryGuard(state) {
    const guard = {};
    for (const key of ['format', 'revision', 'storyId', 'branchId', 'sourceNamespace', 'locator', 'parent', 'enabled',
        'activeNpcIds', 'sceneNpcIds', 'castHistory', 'characterAliases', 'worldAliases', 'excludedSources',
        'timeline', 'inheritedTimeline', 'contextSources']) guard[key] = state[key];
    guard.sources = Object.fromEntries(Object.values(state.sources).map(source => [source.id, {
        id: source.id, type: source.type, current: source.current, active: source.active,
        identity: source.identity, messageId: source.messageId,
        hash: sourceAt(state, { id: source.id, revision: source.current })?.hash,
    }]));
    return guard;
}

function writeState(directories, state) {
    state.locator = normalizeLocator(state.locator);
    if (Buffer.byteLength(JSON.stringify(state)) > MAX_ARCHIVE_BYTES) fail('This chat’s memory file has reached the 256 MiB size limit.', 413);
    const guard = buildMemoryRecoveryGuard(state);
    // Persist rejection counters before prose. A failed archive write can only make recovery stricter.
    const filename = recoveryPath(directories, state.locator);
    const previous = fs.existsSync(filename) ? fs.readFileSync(filename) : null;
    writeJson(filename, guard);
    try {
        writeJson(statePath(directories, state.locator), state);
    } catch (error) {
        if (previous) writeFileAtomicSync(filename, previous, { mode: 0o600 });
        else fs.rmSync(filename, { force: true });
        throw error;
    }
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
 * use. The cache is bounded by source bytes rather than entry count because a
 * single archive may be large.
 */
const sharedJsonCache = new Map();
const SHARED_JSON_CACHE_MAX_BYTES = 64 * 1024 * 1024;
let sharedJsonCacheBytes = 0;

function sameCachedFileStat(cached, stat) {
    return cached.dev === stat.dev && cached.ino === stat.ino && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs;
}

function removeCachedJson(key) {
    const cached = sharedJsonCache.get(key);
    if (!cached) return;
    sharedJsonCache.delete(key);
    sharedJsonCacheBytes -= cached.bytes;
}

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
    const entry = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, bytes: stat.size, data };
    sharedJsonCache.set(key, entry);
    sharedJsonCacheBytes += entry.bytes;
    while (sharedJsonCacheBytes > SHARED_JSON_CACHE_MAX_BYTES && sharedJsonCache.size > 1) {
        removeCachedJson(sharedJsonCache.keys().next().value);
    }
    return data;
}

const chatReadCache = new Map();
const CHAT_READ_CACHE_MAX_BYTES = 64 * 1024 * 1024;
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
    const entry = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, bytes: stat.size, source };
    chatReadCache.set(key, entry);
    chatReadCacheBytes += entry.bytes;
    while (chatReadCacheBytes > CHAT_READ_CACHE_MAX_BYTES && chatReadCache.size > 1) {
        removeCachedChat(chatReadCache.keys().next().value);
    }
    return source;
}

const storySummaryCache = new Map();
const STORY_SUMMARY_CACHE_MAX_ENTRIES = 128;

function cloneStorySummary(summary) {
    return {
        ...summary,
        locator: { ...summary.locator },
        processing: summary.processing ? { ...summary.processing } : null,
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
    const summary = {
        locator: state.locator, storyId: state.storyId, branchId: state.branchId, enabled: state.enabled,
        updatedAt: state.updatedAt, processing: state.processing ? { status: state.processing.status, automatic: state.processing.automatic } : null,
    };
    storySummaryCache.set(key, { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, summary });
    while (storySummaryCache.size > STORY_SUMMARY_CACHE_MAX_ENTRIES) storySummaryCache.delete(storySummaryCache.keys().next().value);
    return cloneStorySummary(summary);
}

export function writeJson(filename, value) {
    const serialized = JSON.stringify(value);
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

export function mutateState(directories, locator, mutate, expectedRevision, { existingOnly = false } = {}) {
    locator = normalizeLocator(locator);
    const filename = statePath(directories, locator);
    const release = acquireChatFileLock(filename);
    try {
        if (existingOnly && !fs.existsSync(filename)) return null;
        const state = readState(directories, locator);
        if (expectedRevision !== undefined && state.revision !== expectedRevision) {
            fail('Mewmory changed while this was running. Reload Mewmory and try again.', 409);
        }
        const before = hash(state);
        const result = mutate(state) || state;
        if (hash(result) !== before || !fs.existsSync(filename)) {
            result.revision = state.revision + 1;
            result.updatedAt = Date.now();
            writeState(directories, result);
        } else if (!fs.existsSync(recoveryPath(directories, locator))) {
            writeState(directories, result);
        }
        return result;
    } finally {
        release();
    }
}

export function synchronize(directories, locator, context = [], source = readChatShared(directories, locator)) {
    locator = normalizeLocator(locator);
    // Native saves take this lock first too; never reconcile a chat snapshot read before it.
    return withChatFileLocks([chatPath(directories, locator)], () => {
        captureBranchMemory(directories, locator, source);
        return mutateState(directories, locator, state => syncSources(state, source.messages, context));
    });
}

/** Called by native saves before reporting branch creation as successful. */
export function captureBranchMemory(directories, locator, { metadata, messages }) {
    if (!directories.root) return;
    locator = normalizeLocator(locator);
    if (!metadata.main_chat || metadata.main_chat === locator.chat
        || fs.existsSync(statePath(directories, locator)) || fs.existsSync(recoveryPath(directories, locator))) return;
    const parentLocator = normalizeLocator({ ...locator, chat: metadata.main_chat });
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
        if (!previous || previous.text !== String(messages[index].mes ?? '')
            || previous.speaker !== String(messages[index].name ?? '')) break;
        through = index + offset;
    }
    const child = forkState(parent, locator, through, messages);
    child.revision = 1;
    return child;
}

export function listStories(directories) {
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
    }
    for (const key of storySummaryCache.keys()) {
        if (key.startsWith(path.resolve(directory) + path.sep) && !seen.has(key)) storySummaryCache.delete(key);
    }
    return stories;
}

export function removeChatMemory(directories, locator) {
    if (!directories.root) return;
    const filename = statePath(directories, locator);
    const release = acquireChatFileLock(filename);
    try {
        fs.rmSync(filename, { force: true });
        fs.rmSync(recoveryPath(directories, locator), { force: true });
    } finally {
        release();
    }
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
    if (!fs.existsSync(directory)) return;
    for (const filename of fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        const state = readJsonShared(path.join(directory, filename), null);
        if (state?.format !== 1) continue;
        if (avatar && deleteChats && !state.locator.group && state.locator.avatar === avatar) {
            removeChatMemory(directories, state.locator);
            continue;
        }
        const ids = Object.values(state.sources).filter(source => {
            const current = sourceAt(state, { id: source.id, revision: source.current });
            return (avatar && source.type === 'character' && (current?.meta.avatar === avatar
                || source.id === 'character:' + hash(state.characterAliases?.[avatar] || avatar).slice(0, 32)))
                || (world && source.type === 'lore' && (current?.meta.world === world
                    || source.id === 'lore:' + hash([state.worldAliases?.[world] || world, current?.meta.uid]).slice(0, 32)));
        }).map(source => source.id);
        if (ids.length) mutateState(directories, state.locator, current => { purgeSources(current, ids); }, state.revision);
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
    if (!fs.existsSync(directory)) return undo;
    try {
        for (const filename of fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
            const state = readJsonShared(path.join(directory, filename), null);
            if (state?.format !== 1) continue;
            const canonical = state[aliasKey]?.[oldName] || oldName;
            const ownsChat = type === 'character' && !state.locator.group && state.locator.avatar === oldName;
            const ids = Object.values(state.sources).filter(source => source.type === type
                && sourceAt(state, { id: source.id, revision: source.current })?.meta[metaKey] === oldName).map(source => source.id);
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
