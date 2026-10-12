import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AUTHORING_FILE_LIMIT, authoringEvidence, deleteAuthoringFileLocked, readAuthoringFileLocked, writeAuthoringFileLocked } from '../authoring-store.js';
import { roleplayLease } from '../roleplay-store.js';
import { applyCleanup, cleanupCandidates, emptyBucket, readChatBucketLocked, readCleanupLocked, readIdentitiesLocked, scratchpadFile, ScratchpadError, serialiseChatBucketLocked, writeChatBucketLocked } from './store.js';

const SHARDS = Symbol('scratchpadSessionFiles');
const sourceCache = new Map();
const SOURCE_CACHE_LIMIT = 10000;

function rootOf(lease) {
    return roleplayLease(lease).scope.directories.root;
}

function scopeKey(scope, space = '') {
    return space.startsWith('conversation:')
        ? `${space}:${scope.kind}:${scope.id}`
        : `${scope.kind}:${scope.id}`;
}

function sharedSource(scope, space = '') {
    return { kind: 'roleplay', key: `shared:${scopeKey(scope, space)}`, label: '' };
}

function selectionSource(scope, space = '') {
    return { kind: 'roleplay', key: `selection:${scopeKey(scope, space)}` };
}

function selectionFile(lease, scope, space = '') {
    return scratchpadFile(rootOf(lease), selectionSource(scope, space));
}

function readJson(lease, filename) {
    const file = readAuthoringFileLocked(lease, filename, AUTHORING_FILE_LIMIT);
    if (!file) return null;
    try { return JSON.parse(file.bytes.toString('utf8')); } catch {
        throw new ScratchpadError('SCRATCHPAD_DAMAGED', 'A saved Scratchpad file could not be read. The original files were kept.', 500);
    }
}

function conversationParts(key) {
    if (typeof key !== 'string' || !key.startsWith('conversation:')) return null;
    let thread = key.slice('conversation:'.length);
    let persona = '';
    if (thread.startsWith('persona:')) {
        const separator = thread.indexOf(':', 'persona:'.length);
        if (separator < 0) return { space: 'conversation:', owner: null };
        persona = thread.slice('persona:'.length, separator);
        thread = thread.slice(separator + 1);
    }
    let owner = null;
    if (thread.startsWith('group:')) {
        const separator = thread.indexOf(':', 'group:'.length);
        if (separator > 'group:'.length && separator < thread.length - 1) {
            owner = { kind: 'group', id: thread.slice('group:'.length, separator) };
        }
    } else {
        const separator = thread.lastIndexOf(':');
        if (separator > 0 && separator < thread.length - 1) owner = { kind: 'character', id: thread.slice(0, separator) };
    }
    return { space: `conversation:${persona}`, owner: owner ? { ...owner, space: `conversation:${persona}` } : null };
}

function conversationOwner(key) {
    return conversationParts(key)?.owner ?? null;
}

function ownerOf(source, state, identities) {
    if (source.kind === 'conversation') return conversationOwner(source.key);
    if (source.kind !== 'roleplay') return null;

    // A renamed chat's permanent identity takes precedence over its old filename.
    const identityEntry = Object.entries(identities).find(([, value]) => value.key === source.key);
    const stable = identityEntry?.[0] ?? source.key;
    const identity = /^roleplay:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?::group:(.+))?$/.exec(stable);
    if (identity) {
        const resource = state.resources[identity[1]];
        if (resource?.kind !== 'chat' || resource.status !== 'live') return null;
        if (identity[2]) {
            if (!resource.locator.group) return null;
            const group = Object.values(state.resources).find(item => item.kind === 'group' && item.status === 'live'
                && item.locator.groupId === identity[2]);
            return group ? { kind: 'group', id: identity[2], space: '' } : null;
        }
        return resource.locator.group === false && typeof resource.locator.avatar === 'string'
            ? { kind: 'character', id: resource.locator.avatar, space: '' }
            : null;
    }
    if (identityEntry) return null;
    const legacy = /^(character|group):([^:]+):/.exec(source.key);
    return legacy ? { kind: legacy[1], id: legacy[2], space: '' } : null;
}

function hasPermanentIdentity(source, identities) {
    return /^roleplay:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?::group:.+)?$/.test(source.key)
        || Object.values(identities).some(value => value.key === source.key);
}

function originOf(storage, identities) {
    const key = Object.entries(identities).find(([, value]) => value.key === storage.key)?.[0];
    return key ? { kind: 'roleplay', key, legacyKey: storage.key, label: storage.label || '' } : storage;
}

function storageForFile(lease, filename, required) {
    let stat;
    try {
        stat = fs.statSync(filename, { bigint: true, throwIfNoEntry: false });
    } catch (error) {
        if (error.code === 'ENOENT') {
            sourceCache.delete(filename);
            return null;
        }
        if (required) throw error;
        console.warn(`Skipping unreadable Scratchpad file ${filename}.`, error);
        return null;
    }
    if (!stat) {
        sourceCache.delete(filename);
        return null;
    }
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
    const cached = sourceCache.get(filename);
    if (cached?.stamp === stamp) return cached.storage;

    let storage = null;
    try {
        const parsed = readJson(lease, filename);
        const source = parsed?.source;
        if (source?.kind && typeof source.key === 'string') {
            storage = { kind: source.kind, key: source.key, label: typeof source.label === 'string' ? source.label : '' };
        }
    } catch (error) {
        if (required) throw error;
        console.warn(`Skipping unreadable Scratchpad file ${filename}.`, error);
    }
    sourceCache.set(filename, { stamp, storage });
    if (sourceCache.size > SOURCE_CACHE_LIMIT) sourceCache.clear();
    return storage;
}

/** Present old chat files together without moving them or interrupting their reply jobs. */
export function readSharedBucketLocked(lease, inputSource) {
    const { state } = roleplayLease(lease);
    const root = rootOf(lease);
    if (inputSource.kind === 'roleplay' && inputSource.key.startsWith('roleplay:')) {
        readChatBucketLocked(lease, { ...inputSource, scope: undefined });
    }
    const identities = readIdentitiesLocked(lease).entries;
    const derived = ownerOf(inputSource, state, identities);
    const staleIdentity = !derived && inputSource.kind === 'roleplay' && hasPermanentIdentity(inputSource, identities);
    const scope = derived ? { kind: derived.kind, id: derived.id } : (staleIdentity ? null : inputSource.scope);
    if (!scope) return readChatBucketLocked(lease, { ...inputSource, scope: undefined });
    const conversation = inputSource.kind === 'conversation' ? conversationParts(inputSource.key) : null;
    const space = inputSource.kind === 'conversation' ? (derived?.space ?? conversation?.space ?? 'conversation:') : '';
    const source = { ...inputSource, scope };
    const canonical = sharedSource(scope, space);
    const canonicalFilename = scratchpadFile(root, canonical);
    const selectedFilename = selectionFile(lease, scope, space);
    const directory = path.join(root, 'scratchpad');
    const shards = [];
    const files = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^[a-f0-9]{40}\.json$/.test(name)).sort() : [];
    for (const name of files) {
        const filename = path.join(directory, name);
        if (filename === selectedFilename) continue;
        const storage = storageForFile(lease, filename, filename === canonicalFilename);
        if (!storage?.kind || typeof storage.key !== 'string') continue;
        const isCanonical = storage.kind === canonical.kind && storage.key === canonical.key;
        const owner = ownerOf(storage, state, identities);
        if (!isCanonical && (owner?.kind !== scope.kind || owner.id !== scope.id || owner.space !== space)) continue;
        if (scratchpadFile(root, storage) !== filename) throw new ScratchpadError('SCRATCHPAD_DAMAGED', 'A saved Scratchpad identity does not match its file.', 500);
        const bucket = readChatBucketLocked(lease, storage);
        const origin = isCanonical ? null : originOf(storage, identities);
        for (const session of bucket.sessions) {
            if (!origin) continue;
            if (session.settings.picked.length && (!session.settings.pickedSource
                || (session.settings.pickedSource.kind === storage.kind && session.settings.pickedSource.key === storage.key))) {
                session.settings.pickedSource = origin;
            }
            for (const message of session.messages) {
                if (!message.contextSource || (message.contextSource.kind === storage.kind && message.contextSource.key === storage.key)) {
                    message.contextSource = origin;
                }
            }
        }
        shards.push({ storage, bucket, origin, before: JSON.stringify(bucket) });
    }
    const bucket = emptyBucket(source);
    bucket.cleanup = readCleanupLocked(lease);
    bucket.sessions = shards.flatMap(shard => shard.bucket.sessions).sort((a, b) => b.updated.localeCompare(a.updated));
    // Never truncate old sessions when several chat lists together exceed the new-session limit.
    if (new Set(bucket.sessions.map(session => session.id)).size !== bucket.sessions.length) {
        throw new ScratchpadError('SCRATCHPAD_DAMAGED', 'Two saved Scratchpad sessions have the same identity. The original files were kept.', 500);
    }
    const selected = readJson(lease, selectedFilename);
    if (selected && (selected.version !== 1 || !(selected.activeSessionId === null || typeof selected.activeSessionId === 'string'))) {
        throw new ScratchpadError('SCRATCHPAD_DAMAGED', 'Scratchpad\'s saved session selection could not be read. The original files were kept.', 500);
    }
    const current = shards.find(shard => shard.storage.key === source.key || shard.storage.key === source.legacyKey)?.bucket.activeSessionId;
    bucket.activeSessionId = [selected?.activeSessionId, current, bucket.sessions[0]?.id].find(id => bucket.sessions.some(session => session.id === id)) ?? null;
    if (!selected && bucket.activeSessionId) saveSelection(lease, bucket, space);
    Object.defineProperty(bucket, SHARDS, { value: { shards, scope, space } });
    return bucket;
}

function saveSelection(lease, bucket, space = '') {
    writeAuthoringFileLocked(lease, selectionFile(lease, bucket.source.scope, space), JSON.stringify({ version: 1, activeSessionId: bucket.activeSessionId }));
}

function stripOriginTags(bucket, origin) {
    if (!origin) return bucket;
    const copy = structuredClone(bucket);
    for (const session of copy.sessions) {
        if (isDeepStrictEqual(session.settings.pickedSource, origin)) delete session.settings.pickedSource;
        for (const message of session.messages) {
            if (isDeepStrictEqual(message.contextSource, origin)) delete message.contextSource;
        }
    }
    return copy;
}

/** Each session stays in its original file; new sessions use the character/group file. */
export function writeSharedBucketLocked(lease, bucket) {
    const metadata = bucket[SHARDS];
    if (!metadata) throw new ScratchpadError('SCRATCHPAD_DAMAGED', 'Reload Scratchpad before saving.', 409);
    const { shards, scope, space } = metadata;
    bucket.cleanup = readCleanupLocked(lease);
    applyCleanup(bucket);
    const assigned = new Set();
    const writes = [];
    for (const shard of shards) {
        const ids = new Set(shard.bucket.sessions.map(session => session.id));
        const sessions = bucket.sessions.filter(session => ids.has(session.id));
        for (const session of sessions) assigned.add(session.id);
        const next = { ...shard.bucket, sessions,
            activeSessionId: sessions.some(session => session.id === bucket.activeSessionId) ? bucket.activeSessionId : shard.bucket.activeSessionId };
        if (JSON.stringify(next) !== shard.before) writes.push(stripOriginTags(next, shard.origin));
    }
    const fresh = bucket.sessions.filter(session => !assigned.has(session.id));
    if (fresh.length) {
        const storage = sharedSource(scope, space);
        let target = writes.find(item => item.source.key === storage.key);
        if (!target) {
            target = readChatBucketLocked(lease, storage);
            writes.push(target);
        }
        target.sessions.unshift(...fresh);
        if (target.sessions.some(session => session.id === bucket.activeSessionId)) target.activeSessionId = bucket.activeSessionId;
    }
    // Check every changed file before publishing any of them. Cleanup was already applied globally.
    for (const next of writes) {
        while (Buffer.byteLength(serialiseChatBucketLocked(lease, next)) > AUTHORING_FILE_LIMIT) {
            const oldest = bucket.cleanup.enabled && cleanupCandidates(bucket).find(session => next.sessions.some(item => item.id === session.id));
            if (!oldest) throw new ScratchpadError('SCRATCHPAD_STORAGE_FULL', 'Scratchpad is full. Delete old sessions or long replies, then try again.', 413);
            bucket.sessions = bucket.sessions.filter(session => session.id !== oldest.id);
            next.sessions = next.sessions.filter(session => session.id !== oldest.id);
        }
    }
    for (const next of writes) writeChatBucketLocked(lease, next, { cleanupApplied: true });
    saveSelection(lease, bucket, space);
}

function moveRoleplayFileLocked(lease, fromScope, toScope, selection = false) {
    const fromSource = selection ? selectionSource(fromScope) : sharedSource(fromScope);
    const toSource = selection ? selectionSource(toScope) : sharedSource(toScope);
    const fromFilename = scratchpadFile(rootOf(lease), fromSource);
    const toFilename = scratchpadFile(rootOf(lease), toSource);
    const file = readAuthoringFileLocked(lease, fromFilename, AUTHORING_FILE_LIMIT);
    if (!file) return false;
    if (fs.existsSync(toFilename) || readAuthoringFileLocked(lease, toFilename, AUTHORING_FILE_LIMIT)) {
        console.warn(`Could not move Scratchpad ${selection ? 'selection' : 'sessions'} from ${fromSource.key} to ${toSource.key}: destination already exists.`);
        return false;
    }
    let data = file.bytes;
    if (!selection) {
        let parsed;
        try { parsed = JSON.parse(file.bytes.toString('utf8')); } catch {
            throw new ScratchpadError('SCRATCHPAD_DAMAGED', 'A saved Scratchpad file could not be read. The original files were kept.', 500);
        }
        if (parsed?.source?.kind !== fromSource.kind || parsed.source.key !== fromSource.key) {
            throw new ScratchpadError('SCRATCHPAD_DAMAGED', 'A saved Scratchpad identity does not match its file.', 500);
        }
        parsed.source.key = toSource.key;
        data = `${JSON.stringify(parsed, null, 2)}\n`;
    }
    writeAuthoringFileLocked(lease, toFilename, data, { limit: AUTHORING_FILE_LIMIT });
    deleteAuthoringFileLocked(lease, fromFilename, authoringEvidence(file));
    return true;
}

/** Move Roleplay-space session and selection files after a character or group rename. */
export function moveSharedScratchpadsLocked(lease, { kind, from, to }) {
    const oldScope = { kind, id: from };
    const newScope = { kind, id: to };
    for (const selection of [false, true]) {
        try { moveRoleplayFileLocked(lease, oldScope, newScope, selection); } catch (error) {
            console.warn(`Could not move Scratchpad ${selection ? 'selection' : 'sessions'} for ${kind} ${from} to ${to}.`, error);
        }
    }
}

/** Remove Roleplay-space shared files after a character or group has been deleted. */
export function forgetSharedScratchpadsLocked(lease, { kind, id }) {
    const scope = { kind, id };
    for (const source of [sharedSource(scope), selectionSource(scope)]) {
        const filename = scratchpadFile(rootOf(lease), source);
        try { deleteAuthoringFileLocked(lease, filename); } catch (error) {
            console.warn(`Could not remove Scratchpad file ${source.key} after deleting ${kind} ${id}.`, error);
        }
    }
}
