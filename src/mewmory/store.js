import fs from 'node:fs';
import path from 'node:path';
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
        : path.join(directories.chats, locator.avatar.replace(/\.png$/, ''), locator.chat + '.jsonl');
}

export function statePath(directories, locator) {
    return path.join(directories.root, 'mewmory', 'stories', hash(normalizeLocator(locator)) + '.json');
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
    if (!state) return newState(locator);
    if (state.format !== 1 || hash(state.locator) !== hash(locator) || !Array.isArray(state.records)) {
        fail('This Mewmory archive has an unsupported format or chat identity.', 409);
    }
    return state;
}

export function mutateState(directories, locator, mutate, expectedRevision) {
    locator = normalizeLocator(locator);
    const filename = statePath(directories, locator);
    const release = acquireChatFileLock(filename);
    try {
        const state = readState(directories, locator);
        if (expectedRevision !== undefined && state.revision !== expectedRevision) {
            fail('Mewmory changed while this work was running. Refresh and try again.', 409);
        }
        const before = hash(state);
        const result = mutate(state) || state;
        if (hash(result) !== before || !fs.existsSync(filename)) {
            result.revision = state.revision + 1;
            result.updatedAt = Date.now();
            writeJson(filename, result);
        }
        return result;
    } finally {
        release();
    }
}

export function synchronize(directories, locator, context = []) {
    locator = normalizeLocator(locator);
    const source = readChat(directories, locator);
    return mutateState(directories, locator, state => {
        if (state.revision === 0 && source.metadata.main_chat && source.metadata.main_chat !== locator.chat) {
            const parentLocator = normalizeLocator({ ...locator, chat: source.metadata.main_chat });
            const parent = readJson(statePath(directories, parentLocator), null);
            if (parent?.format === 1) {
                // Legacy branches have no explicit fork position. Only the matching prefix can be inherited.
                let through = -1;
                for (let index = 0; index < source.messages.length; index++) {
                    const offset = parent.inheritedTimeline?.length || 0;
                    const ref = parent.timeline[index + offset];
                    const previous = ref && parent.sources[ref.id]?.revisions.find(item => item.revision === ref.revision);
                    if (!previous || previous.text !== String(source.messages[index].mes ?? '')
                        || previous.speaker !== String(source.messages[index].name ?? '')) break;
                    through = index + offset;
                }
                state = forkState(parent, locator, through, source.messages);
            }
        }
        return syncSources(state, source.messages, context);
    });
}

export function listStories(directories) {
    const directory = path.join(directories.root, 'mewmory', 'stories');
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
        const state = readJson(path.join(directory, name), null);
        return state?.format === 1 && fs.existsSync(chatPath(directories, state.locator))
            ? [{ locator: state.locator, storyId: state.storyId, branchId: state.branchId, enabled: state.enabled, updatedAt: state.updatedAt }]
            : [];
    });
}

export function removeChatMemory(directories, locator) {
    if (!directories.root) return;
    const filename = statePath(directories, locator);
    if (!fs.existsSync(filename)) return;
    const release = acquireChatFileLock(filename);
    try {
        fs.unlinkSync(filename);
    } finally {
        release();
    }
}

export function renameChatMemory(directories, oldLocator, newLocator) {
    if (!directories.root) return false;
    const before = statePath(directories, oldLocator);
    const after = statePath(directories, newLocator);
    if (!fs.existsSync(before) || before === after) return;
    const release = acquireChatFileLocks([before, after]);
    try {
        if (fs.existsSync(after)) fail('A Mewmory archive already exists for that chat name.', 409);
        const state = readState(directories, oldLocator);
        state.locator = normalizeLocator(newLocator);
        state.revision++;
        writeJson(after, state);
        try {
            fs.unlinkSync(before);
        } catch (error) {
            fs.unlinkSync(after);
            throw error;
        }
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
            return (avatar && source.type === 'character' && current?.meta.avatar === avatar)
                || (world && source.type === 'lore' && current?.meta.world === world);
        }).map(source => source.id);
        if (ids.length) mutateState(directories, state.locator, current => { purgeSources(current, ids); }, state.revision);
    }
}

export function renameCharacterMemory(directories, oldAvatar, newAvatar) {
    const changes = [];
    const undo = () => {
        for (const change of changes.slice().reverse()) {
            if (change.aliased) mutateState(directories, change.after, state => {
                if (change.previousAlias) state.characterAliases[newAvatar] = change.previousAlias;
                else delete state.characterAliases[newAvatar];
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
            const canonical = state.characterAliases?.[oldAvatar] || oldAvatar;
            const ownsChat = !state.locator.group && state.locator.avatar === oldAvatar;
            if (!ownsChat && !state.sources['character:' + hash(canonical).slice(0, 32)]) continue;
            const change = { before: state.locator, after: ownsChat ? { ...state.locator, avatar: newAvatar } : state.locator,
                previousAlias: state.characterAliases?.[newAvatar], moved: false, aliased: false };
            changes.push(change);
            if (ownsChat) change.moved = renameChatMemory(directories, change.before, change.after);
            mutateState(directories, change.after, current => {
                current.characterAliases ??= {};
                current.characterAliases[newAvatar] = canonical;
            });
            change.aliased = true;
        }
        return undo;
    } catch (error) {
        undo();
        throw error;
    }
}
