import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { roleplayLease, roleplayError, createRoleplayDirectory } from '../roleplay-store.js';
import { readAuthoringFileLocked, writeAuthoringFileLocked } from '../authoring-store.js';
import { validateCreatorDraft } from '../../public/scripts/creator/model.js';

const LIMIT = 24 * 1024 * 1024;
const MAX_DRAFTS = 40;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function filename(lease) {
    return path.join(roleplayLease(lease).scope.directories.root, 'creator', 'drafts.json');
}

function read(lease) {
    const file = readAuthoringFileLocked(lease, filename(lease), LIMIT);
    if (!file) return;
    const data = JSON.parse(file.bytes.toString('utf8'));
    if (data.schema === 2) return;
    if (data.schema !== 1 || !data.drafts || Array.isArray(data.drafts)) throw roleplayError('CREATOR_SCHEMA', 'The Creator store needs a newer version of Neconyan.', 409);
    // Each copy is durable before retiring the legacy aggregate. Retrying a partial
    // migration never replaces an already migrated draft or deletion tombstone.
    for (const item of Object.values(data.drafts)) {
        const target = draftPath(lease, requireId(item.draft.id));
        if (!readAuthoringFileLocked(lease, target, LIMIT)) writeAuthoringFileLocked(lease, target, JSON.stringify(item), { limit: LIMIT });
    }
    writeAuthoringFileLocked(lease, filename(lease), JSON.stringify({ schema: 2 }));
}

function draftPath(lease, id) {
    return path.join(roleplayLease(lease).scope.directories.root, 'creator', 'drafts', `${requireId(id)}.json`);
}

function readItem(lease, id) {
    const file = readAuthoringFileLocked(lease, draftPath(lease, id), LIMIT);
    if (!file) return null;
    const item = JSON.parse(file.bytes.toString('utf8'));
    return item.deleted ? null : item;
}

function requireId(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw roleplayError('CREATOR_ID', 'Choose a valid Creator draft.', 400);
    return id;
}

export function listCreatorDrafts(lease) {
    read(lease);
    const root = roleplayLease(lease).scope.directories.root;
    const directory = path.join(root, 'creator', 'drafts');
    createRoleplayDirectory(directory, root);
    return fs.readdirSync(directory).filter(name => /^[a-zA-Z0-9_-]{1,64}\.json$/.test(name))
        .map(name => {
            const item = readItem(lease, name.slice(0, -5));
            return item ? { id: item.draft.id, name: item.draft.card.data.name || 'Untitled character', updatedAt: item.updatedAt, revision: item.revision, avatar: item.draft.source?.avatar ?? null } : null;
        }).filter(Boolean);
}

export function getCreatorDraft(lease, id) {
    read(lease);
    const item = readItem(lease, id);
    if (!item) throw roleplayError('CREATOR_NOT_FOUND', 'This Creator draft no longer exists.', 404);
    return item;
}

export function saveCreatorDraft(lease, draft, expectedRevision) {
    requireId(draft?.id);
    try { validateCreatorDraft(draft); } catch (error) { throw roleplayError('CREATOR_DOCUMENT', error.message, 400); }
    read(lease);
    const previous = readItem(lease, draft.id);
    const revision = hash(JSON.stringify(draft));
    if (previous?.revision === revision) return previous;
    if ((previous?.revision ?? null) !== expectedRevision) throw roleplayError('CREATOR_CONFLICT', 'This draft changed elsewhere. Export your local draft as a private backup before opening the saved version.', 409);
    if (!previous && listCreatorDrafts(lease).length >= MAX_DRAFTS) throw roleplayError('CREATOR_LIMIT', 'Remove an old draft before creating another.', 409);
    const item = { draft, revision, updatedAt: new Date().toISOString() };
    const bytes = JSON.stringify(item);
    if (Buffer.byteLength(bytes) > LIMIT) throw roleplayError('CREATOR_DRAFT_SIZE', `The draft “${draft.card.data.name || draft.id}” is too large. Remove portraits or shorten its lorebooks, then save again. Other drafts are unaffected.`, 413);
    writeAuthoringFileLocked(lease, draftPath(lease, draft.id), bytes, { limit: LIMIT });
    return item;
}

export function deleteCreatorDraft(lease, id, expectedRevision) {
    read(lease);
    const previous = readItem(lease, id);
    if (!previous) return { deleted: true };
    if (previous.revision !== expectedRevision) throw roleplayError('CREATOR_CONFLICT', 'This draft changed elsewhere. Reload it before discarding.', 409);
    writeAuthoringFileLocked(lease, draftPath(lease, id), JSON.stringify({ deleted: true }), { limit: LIMIT });
    return { deleted: true };
}
