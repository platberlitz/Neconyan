import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CHAT_LINK_ID, CHAT_LINK_MODES } from '../public/scripts/chat-navigation-policy.js';
import { readRoleplayFile, roleplayError, roleplayLease, roleplayStoreDirectory } from './roleplay-store.js';
import { tryWriteFileSync } from './util.js';

const unavailable = () => roleplayError('navigation_unavailable', 'This chat is unavailable.', 404);
export { unavailable as navigationUnavailable };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && CHAT_LINK_ID.test(value);

function validAlias(alias) {
    if (!record(alias) || !validId(alias.ownerId)) return false;
    if (alias.kind === 'roleplay') return true;
    return alias.kind === 'conversation' && validId(alias.persona) && record(alias.target)
        && ['avatar', 'personaId', 'branchId'].every(key => typeof alias.target[key] === 'string' && alias.target[key].length > 0 && alias.target[key].length <= 256)
        && typeof alias.target.groupId === 'string' && alias.target.groupId.length <= 256
        && (alias.target.groupId ? record(alias.groupOwner) && ['roleplay', 'conversation'].includes(alias.groupOwner.kind) && validId(alias.groupOwner.id) : alias.groupOwner === null);
}

/** A narrow, protected, per-account document, never a browser settings replacement. */
export function readNavigationState(lease) {
    const { scope, state } = roleplayLease(lease);
    const file = readRoleplayFile(path.join(roleplayStoreDirectory(scope), 'navigation.json'), 4 * 1024 * 1024);
    if (!file) return { schema: 1, accountId: state.accountId, dataEpoch: state.dataEpoch, revision: 0, pointer: null, migration: 0, aliases: {}, clients: {}, personas: {} };
    let value;
    try { value = JSON.parse(file.bytes.toString('utf8')); } catch { throw roleplayError('navigation_damaged', 'Navigation state needs recovery.', 503); }
    if (value?.schema !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
        || !record(value.aliases) || !record(value.clients) || !record(value.personas) || ![0, 1].includes(value.migration)
        || Object.entries(value.aliases).some(([id, alias]) => !validId(id) || !validAlias(alias))
        || Object.entries(value.clients).some(([id, client]) => !validId(id) || !record(client) || !Number.isSafeInteger(client.sequence) || client.sequence < 1)
        || Object.values(value.personas).some(id => !validId(id))
        || (value.pointer !== null && (!record(value.pointer) || !validId(value.pointer.id)
            || !CHAT_LINK_MODES.includes(value.pointer.mode) || !Number.isSafeInteger(value.pointer.revision)
            || value.pointer.revision < 1 || value.pointer.revision > value.revision))) {
        throw roleplayError('navigation_damaged', 'Navigation state needs recovery.', 503);
    }
    if (value.accountId !== state.accountId || value.dataEpoch !== state.dataEpoch) {
        return { schema: 1, accountId: state.accountId, dataEpoch: state.dataEpoch, revision: 0, pointer: null, migration: 0, aliases: {}, clients: {}, personas: {} };
    }
    return value;
}

export function writeNavigationState(lease, value) {
    const { scope, state } = roleplayLease(lease);
    if (state.pending) throw roleplayError('navigation_busy', 'Saved content is being recovered. Retry shortly.', 503);
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw roleplayError('navigation_limit', 'Navigation storage is full.', 503);
    tryWriteFileSync(path.join(roleplayStoreDirectory(scope), 'navigation.json'), bytes);
}

export function validateNavigationDestination(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['id', 'mode'].includes(key))
        || !validId(value.id) || !CHAT_LINK_MODES.includes(value.mode)) throw roleplayError('navigation_invalid', 'Invalid chat link.', 400);
    return { id: value.id, mode: value.mode };
}

/** Sequence numbers belong to one tab. Between devices, acceptance order wins. */
export function acceptNavigationPointer(value, { destination, clientId, sequence }) {
    validateNavigationDestination(destination);
    if (!validId(clientId) || !Number.isSafeInteger(sequence) || sequence < 1) throw roleplayError('navigation_invalid', 'Invalid navigation update.', 400);
    const seen = value.clients[clientId];
    if (seen && sequence <= seen.sequence) return false;
    if (!seen && Object.keys(value.clients).length >= 8192) throw roleplayError('navigation_limit', 'Navigation ordering storage is full.', 503);
    if (!Number.isSafeInteger(value.revision + 1)) throw roleplayError('navigation_limit', 'Navigation revision limit reached.', 503);
    value.clients[clientId] = { sequence };
    value.migration = 1;
    value.revision += 1;
    value.pointer = { ...destination, revision: value.revision };
    return true;
}

export function clearNavigationPointer(value, revision) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw roleplayError('navigation_invalid', 'Invalid navigation revision.', 400);
    if (value.pointer?.revision !== revision) return false;
    if (!Number.isSafeInteger(value.revision + 1)) throw roleplayError('navigation_limit', 'Navigation revision limit reached.', 503);
    value.pointer = null;
    value.revision += 1;
    return true;
}

export function enrolNavigationAlias(value, id, target) {
    if (!validId(id) || !validAlias(target)) throw roleplayError('navigation_retry', 'Saved identity changed during enrolment.', 503);
    const old = value.aliases[id];
    if (old) {
        if (JSON.stringify(old) !== JSON.stringify(target)) throw unavailable();
        return false;
    }
    value.aliases[id] = target;
    return true;
}

export function navigationPersona(value, avatar, { establish = false } = {}) {
    if (!value.personas[avatar] && establish) value.personas[avatar] = randomUUID();
    return value.personas[avatar] || null;
}
