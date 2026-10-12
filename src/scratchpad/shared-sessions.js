import fs from 'node:fs';
import path from 'node:path';
import { AUTHORING_FILE_LIMIT, readAuthoringFileLocked, writeAuthoringFileLocked } from '../authoring-store.js';
import { roleplayLease } from '../roleplay-store.js';
import { applyCleanup, cleanupCandidates, emptyBucket, readChatBucketLocked, readCleanupLocked, readIdentitiesLocked, scratchpadFile, ScratchpadError, serialiseChatBucketLocked, writeChatBucketLocked } from './store.js';

const SHARDS = Symbol('scratchpadSessionFiles');

function rootOf(lease) {
    return roleplayLease(lease).scope.directories.root;
}

function sharedSource(scope) {
    return { kind: 'roleplay', key: `shared:${scope.kind}:${scope.id}`, label: '' };
}

function selectionFile(lease, scope) {
    return scratchpadFile(rootOf(lease), { kind: 'roleplay', key: `selection:${scope.kind}:${scope.id}` });
}

function readJson(lease, filename) {
    const file = readAuthoringFileLocked(lease, filename, AUTHORING_FILE_LIMIT);
    if (!file) return null;
    try { return JSON.parse(file.bytes.toString('utf8')); } catch {
        throw new ScratchpadError('SCRATCHPAD_DAMAGED', 'A saved Scratchpad file could not be read. The original files were kept.', 500);
    }
}

function conversationOwner(key) {
    let thread = key.slice('conversation:'.length);
    if (thread.startsWith('persona:')) thread = thread.slice(thread.indexOf(':', 8) + 1);
    if (thread.startsWith('group:')) return { kind: 'group', id: thread.slice(6, thread.indexOf(':', 6)) };
    const end = thread.lastIndexOf(':');
    return end > 0 ? { kind: 'character', id: thread.slice(0, end) } : null;
}

function ownerOf(source, state, identities) {
    if (source.kind === 'conversation' && source.key.startsWith('conversation:')) return conversationOwner(source.key);
    if (source.kind !== 'roleplay') return null;
    // A renamed chat's permanent identity takes precedence over its old filename.
    const stable = Object.entries(identities).find(([, value]) => value.key === source.key)?.[0] ?? source.key;
    const identity = /^roleplay:([a-f0-9-]{36})(?::group:(.+))?$/.exec(stable);
    if (identity) {
        if (identity[2]) return { kind: 'group', id: identity[2] };
        const resource = state.resources[identity[1]];
        return resource?.kind === 'chat' && !resource.locator.group ? { kind: 'character', id: resource.locator.avatar } : null;
    }
    const legacy = /^(character|group):([^:]+):/.exec(source.key);
    return legacy ? { kind: legacy[1], id: legacy[2] } : null;
}

function originOf(storage, identities) {
    const key = Object.entries(identities).find(([, value]) => value.key === storage.key)?.[0];
    return key ? { kind: 'roleplay', key, legacyKey: storage.key, label: storage.label || '' } : storage;
}

/** Present old chat files together without moving them or interrupting their reply jobs. */
export function readSharedBucketLocked(lease, source) {
    const { state } = roleplayLease(lease);
    const root = rootOf(lease);
    const canonical = sharedSource(source.scope);
    const directory = path.join(root, 'scratchpad');
    if (source.kind === 'roleplay') readChatBucketLocked(lease, { ...source, scope: undefined });
    const identities = readIdentitiesLocked(lease).entries;
    const shards = [];
    const files = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^[a-f0-9]{40}\.json$/.test(name)).sort() : [];
    for (const name of files) {
        const filename = path.join(directory, name);
        const parsed = readJson(lease, filename);
        const storage = parsed?.source;
        if (!storage?.kind || typeof storage.key !== 'string') continue;
        const owner = ownerOf(storage, state, identities);
        const isCanonical = storage.kind === canonical.kind && storage.key === canonical.key;
        if (!isCanonical && (owner?.kind !== source.scope.kind || owner.id !== source.scope.id)) continue;
        if (scratchpadFile(root, storage) !== filename) throw new ScratchpadError('SCRATCHPAD_DAMAGED', 'A saved Scratchpad identity does not match its file.', 500);
        const bucket = readChatBucketLocked(lease, storage);
        const origin = isCanonical ? null : originOf(storage, identities);
        for (const session of bucket.sessions) {
            if (origin) {
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
        }
        shards.push({ storage, bucket, before: JSON.stringify(bucket) });
    }
    const bucket = emptyBucket(source);
    bucket.cleanup = readCleanupLocked(lease);
    bucket.sessions = shards.flatMap(shard => shard.bucket.sessions).sort((a, b) => b.updated.localeCompare(a.updated));
    // Never truncate old sessions when several chat lists together exceed the new-session limit.
    if (new Set(bucket.sessions.map(session => session.id)).size !== bucket.sessions.length) {
        throw new ScratchpadError('SCRATCHPAD_DAMAGED', 'Two saved Scratchpad sessions have the same identity. The original files were kept.', 500);
    }
    const selected = readJson(lease, selectionFile(lease, source.scope));
    if (selected && (selected.version !== 1 || !(selected.activeSessionId === null || typeof selected.activeSessionId === 'string'))) {
        throw new ScratchpadError('SCRATCHPAD_DAMAGED', 'Scratchpad\'s saved session selection could not be read. The original files were kept.', 500);
    }
    const current = shards.find(shard => shard.storage.key === source.key || shard.storage.key === source.legacyKey)?.bucket.activeSessionId;
    bucket.activeSessionId = [selected?.activeSessionId, current, bucket.sessions[0]?.id].find(id => bucket.sessions.some(session => session.id === id)) ?? null;
    if (!selected && bucket.activeSessionId) saveSelection(lease, bucket);
    Object.defineProperty(bucket, SHARDS, { value: shards });
    return bucket;
}

function saveSelection(lease, bucket) {
    writeAuthoringFileLocked(lease, selectionFile(lease, bucket.source.scope), JSON.stringify({ version: 1, activeSessionId: bucket.activeSessionId }));
}

/** Each session stays in its original file; new sessions use the character/group file. */
export function writeSharedBucketLocked(lease, bucket) {
    const shards = bucket[SHARDS];
    if (!shards) throw new ScratchpadError('SCRATCHPAD_DAMAGED', 'Reload Scratchpad before saving.', 409);
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
        if (JSON.stringify(next) !== shard.before) writes.push(next);
    }
    const fresh = bucket.sessions.filter(session => !assigned.has(session.id));
    if (fresh.length) {
        const storage = sharedSource(bucket.source.scope);
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
    saveSelection(lease, bucket);
}
