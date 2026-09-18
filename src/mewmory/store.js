import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { acquireChatFileLock, acquireChatFileLocks } from '../chat-file-lock.js';
import { readChatJsonlStrict } from '../chat-recovery.js';
import { fail, forkState, hash, newState, object, purgeSources, sourceAt, syncSources, text } from './core.js';

export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

export function normalizeLocator(value) {
    object(value, 'Chat');
    const chat = text(value.chat, 'Chat name', 255).replace(/\.jsonl$/, '');
    const avatar = value.group ? '' : text(value.avatar, 'Character file', 255);
    if (!chat || sanitize(chat) !== chat || (avatar && sanitize(avatar) !== avatar)) fail('Invalid chat path.');
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

function writeState(directories, state) {
    state.locator = normalizeLocator(state.locator);
    if (Buffer.byteLength(JSON.stringify(state)) > MAX_ARCHIVE_BYTES) fail('This Mewmory archive reached 256 MiB.', 413);
    const guard = {};
    for (const key of ['format', 'revision', 'storyId', 'branchId', 'sourceNamespace', 'locator', 'parent', 'enabled',
        'activeNpcIds', 'sceneNpcIds', 'castHistory', 'characterAliases', 'worldAliases', 'excludedSources',
        'timeline', 'inheritedTimeline', 'contextSources']) guard[key] = state[key];
    guard.sources = Object.fromEntries(Object.values(state.sources).map(source => [source.id, {
        id: source.id, type: source.type, current: source.current, active: source.active,
        identity: source.identity, messageId: source.messageId,
        hash: sourceAt(state, { id: source.id, revision: source.current })?.hash,
    }]));
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
        fail('No verified recovery identity is available for this chat. Keep the export and restore the original archive from a server backup.', 409);
    }
    if (backup?.format !== 1 || backup.storyId !== guard.storyId || backup.branchId !== guard.branchId) {
        fail('This export belongs to a different story or branch.', 409);
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
        fail('This export lacks verified inherited passages. Choose a newer export to recover this continuation.', 409);
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
                || recoveryState(directories, locator, backup).token !== token) fail('Saved memory changed after recovery was reviewed. Review the export again.', 409);
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
        if (!stat.isFile() || stat.size > MAX_ARCHIVE_BYTES) fail('The Mewmory file is too large or is not a regular file.', 409);
        return JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return fallback;
        if (error.status) throw error;
        fail('Mewmory could not read its saved data. Restore a valid export before making changes.', 409);
    }
}

export function writeJson(filename, value) {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > MAX_ARCHIVE_BYTES) fail('This Mewmory archive reached 256 MiB. Export it and start a new story before adding more memory.', 413);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    writeFileAtomicSync(filename, serialized, { encoding: 'utf8', mode: 0o600 });
}

export function readChat(directories, locator) {
    const filename = chatPath(directories, locator);
    const result = readChatJsonlStrict(filename);
    if (result.status !== 'ok') fail('Save or reload this chat before using Mewmory. Its source file is unavailable.', 409);
    return { metadata: result.records[0].chat_metadata || {}, messages: result.records.slice(1), filename };
}

export function readState(directories, locator) {
    locator = normalizeLocator(locator);
    const state = readJson(statePath(directories, locator), null);
    if (!state) {
        if (fs.existsSync(recoveryPath(directories, locator))) fail('The Mewmory archive is missing. Recover it from an export before making changes.', 409);
        return newState(locator);
    }
    if (state.format !== 1 || hash(normalizeLocator(state.locator)) !== hash(locator) || !Array.isArray(state.records)) {
        fail('This Mewmory archive has an unsupported format or chat identity.', 409);
    }
    return state;
}

export function mutateState(directories, locator, mutate, expectedRevision, { existingOnly = false } = {}) {
    locator = normalizeLocator(locator);
    const filename = statePath(directories, locator);
    const release = acquireChatFileLock(filename);
    try {
        if (existingOnly && !fs.existsSync(filename)) return null;
        const state = readState(directories, locator);
        if (expectedRevision !== undefined && state.revision !== expectedRevision) {
            fail('Mewmory changed while this work was running. Refresh and try again.', 409);
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

export function synchronize(directories, locator, context = []) {
    locator = normalizeLocator(locator);
    // Native saves take this lock first too; never reconcile a chat snapshot read before it.
    const release = acquireChatFileLock(chatPath(directories, locator));
    try {
        const source = readChat(directories, locator);
        captureBranchMemory(directories, locator, source);
        return mutateState(directories, locator, state => syncSources(state, source.messages, context));
    } finally {
        release();
    }
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
    const release = acquireChatFileLocks([parentFile, statePath(directories, locator)]);
    try {
        if (fs.existsSync(statePath(directories, locator))) return;
        const parent = readState(directories, parentLocator);
        const offset = parent.inheritedTimeline?.length || 0;
        let through = offset - 1;
        for (let index = 0; index < messages.length; index++) {
            const previous = sourceAt(parent, parent.timeline[index + offset]);
            if (!previous || previous.text !== String(messages[index].mes ?? '')
                || previous.speaker !== String(messages[index].name ?? '')) break;
            through = index + offset;
        }
        const child = forkState(parent, normalizeLocator(locator), through, messages);
        child.revision = 1;
        writeState(directories, child);
    } finally {
        release();
    }
}

export function listStories(directories) {
    const directory = path.join(directories.root, 'mewmory', 'stories');
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
        try {
            const state = readJson(path.join(directory, name), null);
            return state?.format === 1 && fs.existsSync(chatPath(directories, state.locator))
                ? [{ locator: state.locator, storyId: state.storyId, branchId: state.branchId, enabled: state.enabled, updatedAt: state.updatedAt }]
                : [];
        } catch {
            return [];
        }
    });
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

export function renameChatMemory(directories, oldLocator, newLocator) {
    if (!directories.root) return false;
    const before = statePath(directories, oldLocator);
    const after = statePath(directories, newLocator);
    if (before === after) return;
    if (!fs.existsSync(before) && !fs.existsSync(recoveryPath(directories, oldLocator))) return;
    const release = acquireChatFileLocks([before, after]);
    try {
        if (fs.existsSync(after) || fs.existsSync(recoveryPath(directories, newLocator))) fail('A Mewmory archive already exists for that chat name.', 409);
        const state = readState(directories, oldLocator);
        state.locator = normalizeLocator(newLocator);
        for (const job of state.jobs.filter(job => job.status === 'processing')) {
            Object.assign(job, { status: 'failed', error: 'The chat was renamed. Retry this update in the renamed chat.', finishedAt: Date.now() });
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
    } finally {
        release();
    }
}

/** Explicit card/book deletion also reaches stores whose chats are not currently open. */
export function removeSourceMemory(directories, { avatar = '', world = '', deleteChats = false }) {
    if (!directories.root) return;
    const directory = path.join(directories.root, 'mewmory', 'stories');
    if (!fs.existsSync(directory)) return;
    for (const filename of fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        const state = readJson(path.join(directory, filename), null);
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

export function renameCharacterMemory(directories, oldAvatar, newAvatar) {
    return renameLibraryMemory(directories, 'character', oldAvatar, newAvatar);
}

export function renameWorldMemory(directories, oldName, newName) {
    return renameLibraryMemory(directories, 'lore', oldName, newName);
}

function renameLibraryMemory(directories, type, oldName, newName) {
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
            const state = readJson(path.join(directory, filename), null);
            if (state?.format !== 1) continue;
            const canonical = state[aliasKey]?.[oldName] || oldName;
            const ownsChat = type === 'character' && !state.locator.group && state.locator.avatar === oldName;
            const ids = Object.values(state.sources).filter(source => source.type === type
                && sourceAt(state, { id: source.id, revision: source.current })?.meta[metaKey] === oldName).map(source => source.id);
            if (!ownsChat && !ids.length) continue;
            const change = { before: state.locator, after: ownsChat ? { ...state.locator, avatar: newName } : state.locator,
                aliases: structuredClone(state[aliasKey] || {}), ids, moved: false, aliased: false };
            changes.push(change);
            if (ownsChat) change.moved = renameChatMemory(directories, change.before, change.after);
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
