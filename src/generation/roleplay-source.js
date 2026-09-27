import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import sanitize from 'sanitize-filename';
import { acquireChatFileLock } from '../chat-file-lock.js';
import { parseChatJsonl } from '../chat-recovery.js';
import { read as readCharacterCard } from '../character-card-parser.js';
import { TavernCardValidator } from '../validator/TavernCardValidator.js';
import { readRoleplayFile, roleplayAvatarOwner, validRoleplayAvatar, roleplayError, roleplayHash, roleplayLease, roleplayPathKey, saveRoleplayAccount, withRoleplayAccountLock } from '../roleplay-store.js';

export { roleplayPathKey } from '../roleplay-store.js';

export const ROLEPLAY_METADATA_KEY = 'neconyan_roleplay';

// Reuse decoding only after the protected reader has re-read and hashed the
// exact file bytes. JSON copies keep callers from changing cached card data.
const decodedCharacters = new Map();
const DECODED_CHARACTER_BYTES = 32 * 1024 * 1024;
let decodedCharacterBytes = 0;

function decodedCharacter(filename, file, id) {
    const cached = decodedCharacters.get(filename);
    if (cached) {
        decodedCharacters.delete(filename);
        decodedCharacterBytes -= cached.bytes;
        if (cached.rawHash === file.rawHash) {
            decodedCharacters.set(filename, cached);
            decodedCharacterBytes += cached.bytes;
            return { data: JSON.parse(cached.json), contentHash: cached.contentHash };
        }
    }
    const result = roleplayEntityContent('character', id, file.bytes);
    const json = JSON.stringify(result.data);
    const bytes = Buffer.byteLength(json);
    if (bytes <= DECODED_CHARACTER_BYTES) {
        decodedCharacters.set(filename, { rawHash: file.rawHash, contentHash: result.contentHash, json, bytes });
        decodedCharacterBytes += bytes;
        while (decodedCharacterBytes > DECODED_CHARACTER_BYTES || decodedCharacters.size > 128) {
            const oldest = decodedCharacters.keys().next().value;
            decodedCharacterBytes -= decodedCharacters.get(oldest).bytes;
            decodedCharacters.delete(oldest);
        }
    }
    return result;
}

function identifier(value) {
    if (typeof value !== 'string' || !value || value.length > 256 || value !== sanitize(value)
        || ['.', '..', '__proto__', 'constructor', 'prototype'].includes(value)) {
        throw roleplayError('ROLEPLAY_INVALID', 'Invalid Roleplay source identifier.', 400);
    }
    return value;
}

export const normaliseRoleplayGroupId = identifier;

export function normaliseRoleplayLocator(locator) {
    if (!locator || typeof locator !== 'object' || Array.isArray(locator) || typeof locator.group !== 'boolean'
        || Object.keys(locator).some(key => !['group', 'chat', 'avatar'].includes(key))) {
        throw roleplayError('ROLEPLAY_INVALID', 'Invalid Roleplay chat locator.', 400);
    }
    // Locators always contain the exact base name; the storage path adds one extension.
    const chat = identifier(locator.chat);
    if (locator.group) {
        if (locator.avatar) throw roleplayError('ROLEPLAY_INVALID', 'A group chat cannot have a solo owner.', 400);
        return { group: true, chat };
    }
    const avatar = locator.avatar;
    if (!validRoleplayAvatar(avatar)) throw roleplayError('ROLEPLAY_INVALID', 'A solo chat needs a saved character.', 400);
    return { group: false, chat, avatar };
}

export function roleplayChatPath(scope, locator) {
    const value = normaliseRoleplayLocator(locator);
    return value.group ? path.join(scope.directories.groupChats, value.chat + '.jsonl')
        : path.join(scope.directories.chats, roleplayAvatarOwner(value.avatar), value.chat + '.jsonl');
}

export function roleplayContentHash(records) {
    const copy = structuredClone(records);
    delete copy[0].chat_metadata.integrity;
    return roleplayHash(copy);
}

function enrol(lease, kind, locator, file, contentHash, marker = null) {
    const { state } = roleplayLease(lease);
    const key = roleplayPathKey(state, kind, locator);
    const current = state.paths[key];
    if (current) {
        const resource = state.resources[current.instanceId];
        if (!resource || resource.status !== 'live' || resource.accountId !== state.accountId || resource.dataEpoch !== state.dataEpoch
            || resource.head.rawHash !== file.rawHash || !isDeepStrictEqual(resource.head.physical, file.physical)
            || resource.head.contentHash !== contentHash
            || (kind === 'chat' && resource.head.writeId !== null && !isDeepStrictEqual(marker,
                { schema: 1, instanceId: current.instanceId, revision: resource.revision, writeId: resource.head.writeId }))) {
            throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The saved Roleplay source differs from its protected identity.');
        }
        return { instanceId: current.instanceId, resource, changed: false };
    }
    const retired = value => value && (value.accountId !== state.accountId || value.dataEpoch !== state.dataEpoch);
    // A marker written by this store before a reset names a retired resource; the file starts a new identity in this epoch.
    if (marker && !retired(state.resources[marker.instanceId])) {
        throw roleplayError('ROLEPLAY_FOREIGN_SOURCE', 'Imported native metadata cannot establish a chat identity. Import this chat as a new copy.');
    }
    if (Object.values(state.resources).some(resource => !retired(resource) && isDeepStrictEqual(resource.head.physical, file.physical))) {
        throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'This file already has a protected identity at another location.');
    }
    const instanceId = crypto.randomUUID();
    const resource = { accountId: state.accountId, dataEpoch: state.dataEpoch, kind, locator, status: 'live', revision: 1,
        head: { rawHash: file.rawHash, contentHash, writeId: null, physical: file.physical }, busySubmission: null };
    state.paths[key] = { generation: 1, instanceId };
    state.resources[instanceId] = resource;
    return { instanceId, resource, changed: true };
}

function descriptor(state, entry) {
    return { accountId: state.accountId, dataEpoch: state.dataEpoch, instanceId: entry.instanceId,
        revision: entry.resource.revision, rawHash: entry.resource.head.rawHash, locator: structuredClone(entry.resource.locator) };
}

export function roleplayGroupContentHash(group) {
    const copy = JSON.parse(JSON.stringify(group));
    // Only navigation and derived display statistics are outside generation identity.
    for (const key of ['chat_id', 'date_last_chat', 'chat_size', 'date_added', 'create_date']) delete copy[key];
    return roleplayHash(copy);
}

function groupChatIds(group) {
    if (!Array.isArray(group.chats)) throw roleplayError('ROLEPLAY_SOURCE_DAMAGED', 'The saved group chat list is damaged.');
    return group.chats.map(chat => identifier(Number.isSafeInteger(chat) ? String(chat) : chat));
}

export function assertRoleplayGroupData(data, id, { storage = false } = {}) {
    if (!data || typeof data !== 'object' || Array.isArray(data)
        || (typeof data.id !== 'string' && !Number.isSafeInteger(data.id)) || String(data.id) !== id
        || !Array.isArray(data.members) || (!storage && !Array.isArray(data.chats))
        || (data.chats !== undefined && !Array.isArray(data.chats))
        || (data.disabled_members !== undefined && !Array.isArray(data.disabled_members))) {
        throw roleplayError('ROLEPLAY_INVALID', 'Invalid saved group metadata.', 400);
    }
    if (data.chats !== undefined) groupChatIds(data);
    return data;
}

/** Parses saved character or group bytes and returns the content hash protected resources record. */
export function roleplayEntityContent(kind, id, bytes, { storage = false } = {}) {
    let data;
    try {
        data = JSON.parse(kind === 'character' ? readCharacterCard(bytes) : new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid resource');
        if (kind === 'character') {
            const validator = new TavernCardValidator(data);
            const valid = data.spec === 'chara_card_v3' ? validator.validateV3()
                : data.spec === 'chara_card_v2' ? validator.validateV2() : validator.validateV1();
            if (!valid || (data.spec && Array.isArray(data.data))) throw new Error('Invalid character card');
        }
        if (kind === 'group') assertRoleplayGroupData(data, id, { storage });
    } catch (cause) {
        throw Object.assign(roleplayError('ROLEPLAY_SOURCE_DAMAGED', 'A required Roleplay character or group is damaged.'), { cause });
    }
    return { data, contentHash: kind === 'group' ? roleplayGroupContentHash(data) : roleplayHash(data) };
}

function inspectEntity(lease, kind, id, { storage = false } = {}) {
    const { scope, state } = roleplayLease(lease);
    if (!['character', 'group'].includes(kind)) throw roleplayError('ROLEPLAY_INVALID', 'Invalid Roleplay resource kind.', 400);
    if (kind === 'character') normaliseRoleplayLocator({ group: false, chat: 'source', avatar: id });
    else identifier(id);
    const locator = kind === 'character' ? { avatar: id } : { groupId: id };
    const filename = path.join(kind === 'character' ? scope.directories.characters : scope.directories.groups, kind === 'character' ? id : id + '.json');
    const file = readRoleplayFile(filename, 64 * 1024 * 1024);
    if (!file) throw roleplayError('ROLEPLAY_SOURCE_MISSING', 'A required Roleplay character or group no longer exists.', 404);
    const { data, contentHash } = kind === 'character' ? decodedCharacter(filename, file, id)
        : roleplayEntityContent(kind, id, file.bytes, { storage });
    const existing = state.paths[roleplayPathKey(state, kind, locator)];
    if (existing) {
        const resource = state.resources[existing.instanceId];
        if (!resource || resource.status !== 'live' || resource.head.rawHash !== file.rawHash
            || !isDeepStrictEqual(resource.head.physical, file.physical)) throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'A protected Roleplay resource changed.');
    }
    return { kind, locator, file, contentHash, data };
}

export function readRoleplayEntityLocked(lease, kind, id, { storage = false } = {}) {
    const { state } = roleplayLease(lease);
    if (state.pending) throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'An earlier Roleplay transaction must be reconciled first.');
    const { locator, file, contentHash, data } = inspectEntity(lease, kind, id, { storage });
    const entry = enrol(lease, kind, locator, file, contentHash);
    return { ...descriptor(state, entry), kind, contentHash, physical: file.physical, data, changed: entry.changed };
}

export function readRoleplayEntity(scope, kind, id, options = {}) {
    return withRoleplayAccountLock(scope, lease => {
        const result = readRoleplayEntityLocked(lease, kind, id, options);
        if (result.changed) saveRoleplayAccount(lease);
        return result;
    });
}

function checkGroupOwnership(lease, locator, groupId, read) {
    const group = read('group', groupId);
    if (!groupChatIds(group.data).includes(locator.chat)) throw roleplayError('ROLEPLAY_GROUP_MISMATCH', 'The group does not own this saved chat.');
    const { scope, state } = roleplayLease(lease);
    const groupFiles = new Set(fs.readdirSync(scope.directories.groups));
    for (const resource of Object.values(state.resources)) {
        if (resource.kind === 'group' && resource.status === 'live' && resource.accountId === state.accountId && resource.dataEpoch === state.dataEpoch) {
            groupFiles.add(identifier(resource.locator.groupId) + '.json');
        }
    }
    for (const name of groupFiles) {
        if (!name.endsWith('.json') || name === groupId + '.json') continue;
        const other = read('group', name.slice(0, -5));
        if (groupChatIds(other.data).includes(locator.chat)) throw roleplayError('ROLEPLAY_GROUP_AMBIGUOUS', 'More than one group claims this saved chat.');
    }
    return group;
}

/** Recheck the exact pending source without enrolling resources or bypassing normal-read barriers. */
export function assertPendingRoleplayDependencies(lease) {
    const { state } = roleplayLease(lease);
    const source = state.pending?.source;
    if (!source || state.pending.kind !== 'chat-write') throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'A saved chat transaction is required.');
    if (source.kind === 'storage') return;
    for (const dependency of source.dependencies) {
        const current = inspectEntity(lease, dependency.kind, dependency.kind === 'character' ? dependency.locator.avatar : dependency.locator.groupId);
        const resource = state.resources[dependency.instanceId];
        if (!resource || resource.status !== 'live' || resource.accountId !== state.accountId || resource.dataEpoch !== state.dataEpoch
            || resource.kind !== dependency.kind || resource.revision !== dependency.revision || current.contentHash !== dependency.contentHash
            || !isDeepStrictEqual(resource.locator, dependency.locator) || resource.head.rawHash !== current.file.rawHash
            || !isDeepStrictEqual(resource.head.physical, current.file.physical)) throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'A pending Roleplay dependency changed.');
    }
    if (source.locator.group) {
        const group = checkGroupOwnership(lease, source.locator, source.groupId, (kind, id) => inspectEntity(lease, kind, id));
        const characters = source.dependencies.filter(item => item.kind === 'character').map(item => item.locator.avatar);
        if (!isDeepStrictEqual([...new Set(group.data.members)].sort(), characters.sort())) {
            throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'A pending Roleplay dependency list does not match the saved group members.');
        }
    }
}

export function captureRoleplayDependenciesLocked(lease, locator, groupId) {
    const dependencies = [];
    let changed = false;
    const addCharacter = avatar => dependencies.push(readRoleplayEntityLocked(lease, 'character', avatar));
    if (!locator.group) {
        if (groupId !== undefined) throw roleplayError('ROLEPLAY_INVALID', 'A solo source cannot name a group.', 400);
        addCharacter(locator.avatar);
    } else {
        // A caller cannot resolve ambiguous legacy ownership merely by choosing one group.
        const group = checkGroupOwnership(lease, locator, groupId, (kind, id) => {
            const entity = readRoleplayEntityLocked(lease, kind, id);
            changed ||= entity.changed;
            return entity;
        });
        dependencies.push(group);
        for (const avatar of new Set(group.data.members)) addCharacter(avatar);
    }
    return { dependencies, changed: changed || dependencies.some(item => item.changed) };
}

export function readRoleplayChatLocked(lease, input) {
    const { scope, state } = roleplayLease(lease);
    if (state.pending) throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'An earlier Roleplay transaction must be reconciled first.');
    const locator = normaliseRoleplayLocator(input);
    const filename = roleplayChatPath(scope, locator);
    // Reading does not run recovery: only a journalled lifecycle operation may restore tracked bytes.
    const initial = readRoleplayFile(filename, 64 * 1024 * 1024);
    if (!initial) throw roleplayError('ROLEPLAY_SOURCE_MISSING', 'The saved Roleplay chat does not exist.', 404);
    const release = acquireChatFileLock(filename);
    try {
        const file = readRoleplayFile(filename, 64 * 1024 * 1024);
        if (!file) throw roleplayError('ROLEPLAY_SOURCE_MISSING', 'The saved Roleplay chat does not exist.', 404);
        const parsed = parseChatJsonl(file.bytes);
        if (parsed.status !== 'ok') throw roleplayError('ROLEPLAY_SOURCE_DAMAGED', 'The Roleplay chat needs recovery.');
        const entry = enrol(lease, 'chat', locator, file, roleplayContentHash(parsed.records), parsed.records[0].chat_metadata[ROLEPLAY_METADATA_KEY]);
        return { ...descriptor(state, entry), records: parsed.records, changed: entry.changed, filePath: filename };
    } finally { release(); }
}

export function readRoleplayChat(scope, locator) {
    return withRoleplayAccountLock(scope, lease => {
        const result = readRoleplayChatLocked(lease, locator);
        if (result.changed) saveRoleplayAccount(lease);
        return result;
    });
}

export function captureRoleplayMessage(records, index) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= records.length - 1) {
        throw roleplayError('ROLEPLAY_INVALID', 'The Roleplay message is outside the saved history.', 400);
    }
    const message = records[index + 1];
    const selectedSwipeId = message.swipe_id ?? null;
    if (selectedSwipeId !== null && typeof selectedSwipeId !== 'string' && !Number.isFinite(selectedSwipeId)) {
        throw roleplayError('ROLEPLAY_INVALID', 'The saved Roleplay swipe selection is invalid.', 400);
    }
    return { index, recordHash: roleplayHash(message), selectedSwipeId,
        selectedSwipeHash: roleplayHash(selectedSwipeId === null ? null : message.swipes?.[selectedSwipeId] ?? null),
        selectedSwipeInfoHash: roleplayHash(selectedSwipeId === null ? null : message.swipe_info?.[selectedSwipeId] ?? null) };
}

export function captureRoleplayRange(records, { start, count }) {
    const messages = records.slice(1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 1 || start + count > messages.length) {
        throw roleplayError('ROLEPLAY_INVALID', 'The Roleplay replacement range is outside the saved history.', 400);
    }
    return { start, count, recordsHash: roleplayHash(messages.slice(start, start + count)),
        prefixHash: roleplayHash(messages.slice(0, start)), suffixHash: roleplayHash(messages.slice(start + count)) };
}

export function captureRoleplaySourceLocked(lease, { locator, groupId, message, range }) {
    const saved = readRoleplayChatLocked(lease, locator);
    const { dependencies, changed } = captureRoleplayDependenciesLocked(lease, saved.locator, groupId);
    const source = { accountId: saved.accountId, dataEpoch: saved.dataEpoch, instanceId: saved.instanceId,
        revision: saved.revision, rawHash: saved.rawHash, locator: saved.locator,
        dependencies: dependencies.map(({ kind, instanceId, revision, contentHash, locator }) => ({ kind, instanceId, revision, contentHash, locator })) };
    if (saved.locator.group) source.groupId = groupId;
    if (message !== undefined) source.message = captureRoleplayMessage(saved.records, message);
    if (range !== undefined) source.range = captureRoleplayRange(saved.records, range);
    return { source, saved, changed: saved.changed || changed };
}

export function captureRoleplaySource(scope, input) {
    return withRoleplayAccountLock(scope, lease => {
        const captured = captureRoleplaySourceLocked(lease, input);
        if (captured.changed) saveRoleplayAccount(lease);
        return captured.source;
    });
}

/** Ordinary storage edits bind the chat itself; they do not authorise generation. */
export function captureRoleplayStorageSourceLocked(lease, locator) {
    const saved = readRoleplayChatLocked(lease, locator);
    const { accountId, dataEpoch, instanceId, revision, rawHash } = saved;
    return { source: { kind: 'storage', accountId, dataEpoch, instanceId, revision, rawHash,
        locator: saved.locator, dependencies: [] }, saved, changed: saved.changed };
}

export function captureRoleplayStorageSource(scope, locator) {
    return withRoleplayAccountLock(scope, lease => {
        const captured = captureRoleplayStorageSourceLocked(lease, locator);
        if (captured.changed) saveRoleplayAccount(lease);
        return captured.source;
    });
}

export function assertRoleplaySourceLocked(lease, source, { effect } = {}) {
    if (source?.kind !== undefined && source.kind !== 'storage') throw roleplayError('ROLEPLAY_INVALID', 'Invalid Roleplay source kind.', 400);
    let locator = source.locator;
    if (effect) {
        const { state } = roleplayLease(lease);
        const resource = state.resources[source.instanceId];
        if (source.kind === 'storage' || resource?.kind !== 'chat' || resource.status !== 'live'
            || resource.accountId !== state.accountId || resource.dataEpoch !== state.dataEpoch) {
            throw roleplayError('ROLEPLAY_SOURCE_MISSING', 'The chat this job answers no longer exists.', 404);
        }
        locator = resource.locator;
    }
    const captured = source.kind === 'storage' ? captureRoleplayStorageSourceLocked(lease, locator)
        : captureRoleplaySourceLocked(lease, { locator, groupId: source.groupId,
            message: source.message?.index, range: source.range });
    const expected = effect ? { ...source, locator, ...(effect === 'append' ? {}
        : { revision: captured.source.revision, rawHash: captured.source.rawHash }) } : source;
    if (!isDeepStrictEqual(captured.source, expected)) {
        const error = roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The Roleplay source changed after this work was prepared.');
        if (source.kind === 'storage' && !captured.changed) {
            const { instanceId, revision, rawHash } = captured.saved;
            error.current = { instanceId, revision, rawHash };
        }
        throw error;
    }
    return captured.saved;
}

export function assertRoleplaySource(scope, source) {
    return withRoleplayAccountLock(scope, lease => assertRoleplaySourceLocked(lease, source));
}
