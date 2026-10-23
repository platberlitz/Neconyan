import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import sanitize from 'sanitize-filename';
import { acquireChatFileLock } from '../chat-file-lock.js';
import { parseChatJsonl } from '../chat-recovery.js';
import { read as readCharacterCard } from '../character-card-parser.js';
import { TavernCardValidator } from '../validator/TavernCardValidator.js';
import { canonical } from '../jobs/store.js';
import { inspectRoleplayFileStat, readRoleplayFile, roleplayAvatarOwner, validRoleplayAvatar, roleplayError, roleplayHash, roleplayLease, roleplayPathKey, saveRoleplayAccount, withRoleplayAccountLock } from '../roleplay-store.js';

export { roleplayPathKey } from '../roleplay-store.js';

export const ROLEPLAY_METADATA_KEY = 'neconyan_roleplay';

const CHAT_READ_LIMIT = 64 * 1024 * 1024;
// A weak map from an already-read chat result to its per-lock marker. This is a
// same-lock usage check inside trusted server code, not an unforgeable
// capability: any holder can pass the same object or mutate its records. The
// account-state checks below still refuse a read from another lock or after the
// resource changed.
const CHAT_READ_SNAPSHOTS = new WeakMap();
const CHAT_READ_TOKENS = new WeakMap();
const CHAT_CONTENT_HASH = /^[a-f0-9]{64}$/;

function chatReadToken(held) {
    let token = CHAT_READ_TOKENS.get(held);
    if (!token) {
        token = Object.freeze({});
        CHAT_READ_TOKENS.set(held, token);
    }
    return token;
}

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

const isPlainRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;

/**
 * True only for the values JSON.stringify would round-trip exactly. The parsed
 * chat path needs this check because the direct canonical hash below would
 * otherwise hash undefined as null, or turn -0 into 0, where the legacy path
 * refuses the record outright.
 */
function isParsedChatValue(value, ancestors) {
    if (value === null) return true;
    switch (typeof value) {
        case 'string':
        case 'boolean':
            return true;
        case 'number':
            return Number.isFinite(value) && !Object.is(value, -0);
        case 'object':
            break;
        default:
            return false;
    }
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            for (let index = 0; index < value.length; index += 1) {
                if (!Object.hasOwn(value, index) || !isParsedChatValue(value[index], ancestors)) return false;
            }
            for (const key of Object.keys(value)) {
                if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) return false;
            }
            return !Object.getOwnPropertySymbols(value).some(symbol => Object.prototype.propertyIsEnumerable.call(value, symbol));
        }
        if (Object.getPrototypeOf(value) !== Object.prototype) return false;
        if (Object.getOwnPropertySymbols(value).some(symbol => Object.prototype.propertyIsEnumerable.call(value, symbol))) return false;
        for (const key of Object.keys(value)) {
            if (!isParsedChatValue(value[key], ancestors)) return false;
        }
        return true;
    } finally {
        ancestors.delete(value);
    }
}

function canHashParsedChat(records) {
    if (!Array.isArray(records) || records.length === 0) return false;
    const header = records[0];
    if (!isPlainRecord(header) || !isPlainRecord(header.chat_metadata)) return false;
    return isParsedChatValue(records, new Set());
}

/**
 * The same hash as `roleplayContentHash` for records parsed from JSONL, without
 * cloning every message or running the JSON round-trip check. Any value that is
 * not exactly JSON-safe falls back to the legacy path, so -0, undefined, dates,
 * functions, symbols, bigints, cycles and custom prototypes keep their old
 * result or refusal. Only pass records that came from `parseChatJsonl` or an
 * equivalent JSON-only chat payload.
 */
export function roleplayParsedContentHash(records) {
    let safe = false;
    try {
        safe = canHashParsedChat(records);
    } catch {
        safe = false;
    }
    if (!safe) return roleplayContentHash(records);
    const copy = records.slice();
    copy[0] = { ...records[0], chat_metadata: { ...records[0].chat_metadata } };
    delete copy[0].chat_metadata.integrity;
    return crypto.createHash('sha256').update(canonical(copy)).digest('hex');
}

/**
 * The stored content hash for a live chat whose exact bytes and physical
 * identity still match the enrolled head. The caller must pass the locator and
 * file observation used for the current read. A missing, invalid or mismatched
 * hash returns null so the caller recomputes through the exact hash path.
 */
export function reusableChatContentHash(state, locator, file) {
    if (!state || !file) return null;
    const key = roleplayPathKey(state, 'chat', locator);
    const instanceId = state.paths?.[key]?.instanceId;
    const resource = instanceId ? state.resources?.[instanceId] : null;
    if (!resource || resource.kind !== 'chat' || resource.status !== 'live'
        || resource.accountId !== state.accountId || resource.dataEpoch !== state.dataEpoch
        || !isDeepStrictEqual(resource.locator, locator)
        || resource.head?.rawHash !== file.rawHash
        || !isDeepStrictEqual(resource.head?.physical, file.physical)
        || typeof resource.head?.contentHash !== 'string'
        || !CHAT_CONTENT_HASH.test(resource.head.contentHash)) {
        return null;
    }
    return resource.head.contentHash;
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
    // Deleted or replaced records keep their evidence but no longer own a file. A reused
    // inode, especially on a mobile filesystem without reliable birth times, must not
    // block enrolling an unrelated new file at that physical identity.
    if (Object.values(state.resources).some(resource => resource.status === 'live' && !retired(resource)
        && isDeepStrictEqual(resource.head.physical, file.physical))) {
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
    const invalid = message => roleplayError('ROLEPLAY_INVALID', message, 400);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw invalid('The group data must be a JSON object.');
    }
    if (typeof data.id !== 'string' && !Number.isSafeInteger(data.id)) throw invalid('The group field \'id\' must be text or a whole number.');
    if (String(data.id) !== id) throw invalid('The group field \'id\' does not match its filename.');
    for (const field of ['members', 'chats', 'disabled_members']) {
        const required = field === 'members' || (field === 'chats' && !storage);
        if ((required || data[field] !== undefined) && !Array.isArray(data[field])) throw invalid(`The group field '${field}' must be a list.`);
    }
    if (data.chats !== undefined) {
        try { groupChatIds(data); } catch { throw invalid('The group field \'chats\' contains an invalid chat filename.'); }
    }
    return data;
}

/** Parses saved character or group bytes and returns the content hash protected resources record. */
export function roleplayEntityContent(kind, id, bytes, { storage = false } = {}) {
    const filename = kind === 'character' ? `characters/${id}` : `groups/${id}.json`;
    const damaged = (reason, cause) => Object.assign(roleplayError('ROLEPLAY_SOURCE_DAMAGED', `Cannot read '${filename}': ${reason}`), { cause, reason });
    let text;
    try {
        text = kind === 'character' ? readCharacterCard(bytes) : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (cause) {
        let reason = 'The group file is not valid UTF-8 text.';
        if (kind === 'character') {
            reason = 'The PNG image could not be read.';
            if (cause.message === 'No PNG metadata.') reason = 'The PNG image has no embedded character data. An ordinary portrait cannot be used as a character card.';
            else if (/Truncated PNG|ended prematurely/.test(cause.message)) reason = 'The PNG image is incomplete or cut off.';
            else if (/Invalid .png file header|IHDR header missing/.test(cause.message)) reason = 'The file is not a valid PNG image.';
            else if (/CRC values/.test(cause.message)) reason = 'The PNG image failed its corruption check.';
        }
        throw damaged(reason, cause);
    }
    let data;
    try {
        data = JSON.parse(text);
    } catch (cause) {
        // JSON parser errors can contain private card text; report the format, not a data excerpt.
        throw damaged(`The ${kind} data is not valid JSON.`, cause);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw damaged(`The ${kind} data must be a JSON object.`);
    if (kind === 'character') {
        const validator = new TavernCardValidator(data);
        const valid = data.spec === 'chara_card_v3' ? validator.validateV3()
            : data.spec === 'chara_card_v2' ? validator.validateV2() : validator.validateV1();
        if (!valid || (data.spec && Array.isArray(data.data))) {
            const field = validator.lastValidationError === 'No tavern card data found' || (data.spec && Array.isArray(data.data))
                ? 'data' : validator.lastValidationError;
            throw damaged(field ? `The character card field '${field}' is missing or invalid.` : 'The character card structure is invalid.');
        }
    }
    if (kind === 'group') {
        try { assertRoleplayGroupData(data, id, { storage }); } catch (cause) { throw damaged(cause.message, cause); }
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

export function readRoleplayEntityLocked(lease, kind, id, { storage = false, enrolMissing = true } = {}) {
    const { state } = roleplayLease(lease);
    if (state.pending) throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'An earlier Roleplay transaction must be reconciled first.');
    const { locator, file, contentHash, data } = inspectEntity(lease, kind, id, { storage });
    if (!enrolMissing && !state.paths[roleplayPathKey(state, kind, locator)]?.instanceId) {
        throw roleplayError('ROLEPLAY_SOURCE_MISSING', 'The saved resource is unavailable.', 404);
    }
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

export function readRoleplayChatLocked(lease, input, { enrolMissing = true } = {}) {
    const held = roleplayLease(lease);
    const { scope, state } = held;
    if (state.pending) throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'An earlier Roleplay transaction must be reconciled first.');
    const locator = normaliseRoleplayLocator(input);
    if (!enrolMissing && !state.paths[roleplayPathKey(state, 'chat', locator)]?.instanceId) {
        throw roleplayError('ROLEPLAY_SOURCE_MISSING', 'The saved chat is unavailable.', 404);
    }
    const filename = roleplayChatPath(scope, locator);
    // Refuse a missing or linked source before the lock helper can create
    // directories or a lock file. This runs the same recursive ancestor checks
    // as readRoleplayFile without reading the chat bytes.
    if (!inspectRoleplayFileStat(filename, CHAT_READ_LIMIT)) {
        throw roleplayError('ROLEPLAY_SOURCE_MISSING', 'The saved Roleplay chat does not exist.', 404);
    }
    const release = acquireChatFileLock(filename);
    try {
        const file = readRoleplayFile(filename, CHAT_READ_LIMIT);
        if (!file) throw roleplayError('ROLEPLAY_SOURCE_MISSING', 'The saved Roleplay chat does not exist.', 404);
        const parsed = parseChatJsonl(file.bytes);
        if (parsed.status !== 'ok') throw roleplayError('ROLEPLAY_SOURCE_DAMAGED', 'The Roleplay chat needs recovery.');
        const contentHash = reusableChatContentHash(state, locator, file) ?? roleplayParsedContentHash(parsed.records);
        const entry = enrol(lease, 'chat', locator, file, contentHash, parsed.records[0].chat_metadata[ROLEPLAY_METADATA_KEY]);
        const result = { ...descriptor(state, entry), records: parsed.records, changed: entry.changed, filePath: filename };
        CHAT_READ_SNAPSHOTS.set(result, { token: chatReadToken(held), physical: file.physical });
        return result;
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

/**
 * Refuse an observation that does not belong to the live lock and current
 * account state. This is a trusted internal contract, not a security boundary:
 * code that already holds the saved object can mutate its records or pass that
 * exact object to another trusted call. It prevents accidental reuse across
 * locks or after a state change.
 */
function assertCurrentChatSnapshot(lease, saved, locator) {
    const held = roleplayLease(lease);
    const { state } = held;
    if (state.pending) throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'An earlier Roleplay transaction must be reconciled first.');
    const snapshot = saved && typeof saved === 'object' ? CHAT_READ_SNAPSHOTS.get(saved) : undefined;
    if (!snapshot || CHAT_READ_TOKENS.get(held) !== snapshot.token) {
        throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The saved Roleplay source changed before its capture.');
    }
    const expectedLocator = normaliseRoleplayLocator(locator);
    const key = roleplayPathKey(state, 'chat', expectedLocator);
    const instanceId = state.paths?.[key]?.instanceId;
    const resource = instanceId ? state.resources?.[instanceId] : null;
    if (!resource || resource.kind !== 'chat' || resource.status !== 'live'
        || resource.accountId !== state.accountId || resource.dataEpoch !== state.dataEpoch
        || saved.accountId !== state.accountId || saved.dataEpoch !== state.dataEpoch
        || saved.instanceId !== instanceId || resource.revision !== saved.revision
        || resource.head?.rawHash !== saved.rawHash
        || !isDeepStrictEqual(resource.head?.physical, snapshot.physical)
        || !isDeepStrictEqual(saved.locator, expectedLocator)) {
        throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The saved Roleplay source changed before its capture.');
    }
}

function captureRoleplaySourceFromCurrentChatLocked(lease, saved, { locator, groupId, message, range }) {
    const { dependencies, changed } = captureRoleplayDependenciesLocked(lease, saved.locator, groupId);
    const source = { accountId: saved.accountId, dataEpoch: saved.dataEpoch, instanceId: saved.instanceId,
        revision: saved.revision, rawHash: saved.rawHash, locator: saved.locator,
        dependencies: dependencies.map(({ kind, instanceId, revision, contentHash, locator }) => ({ kind, instanceId, revision, contentHash, locator })) };
    if (saved.locator.group) source.groupId = groupId;
    if (message !== undefined) source.message = captureRoleplayMessage(saved.records, message);
    if (range !== undefined) source.range = captureRoleplayRange(saved.records, range);
    return { source, saved, changed: saved.changed || changed };
}

export function captureRoleplaySourceLocked(lease, input) {
    return captureRoleplaySourceFromCurrentChatLocked(lease, readRoleplayChatLocked(lease, input.locator), input);
}

/**
 * Capture a source from a chat that was already read in this same lock. The
 * caller must pass the exact result of `readRoleplayChatLocked`; a result from
 * an earlier lock or a changed account state is refused rather than reused.
 * This is a trusted same-lock contract, not a security boundary over code that
 * already holds the saved object.
 */
export function captureRoleplaySourceFromSavedChatLocked(lease, saved, input) {
    assertCurrentChatSnapshot(lease, saved, input.locator);
    return captureRoleplaySourceFromCurrentChatLocked(lease, saved, input);
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
            throw roleplayError('ROLEPLAY_SOURCE_MISSING', 'The chat this reply belongs to no longer exists.', 404);
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
