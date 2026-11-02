import path from 'node:path';
import { createHash } from 'node:crypto';
import { roleplayLease, roleplayError } from '../roleplay-store.js';
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
    if (!file) return { schema: 1, drafts: {} };
    const data = JSON.parse(file.bytes.toString('utf8'));
    if (data.schema !== 1 || !data.drafts || Array.isArray(data.drafts)) throw roleplayError('CREATOR_SCHEMA', 'The Creator store needs a newer version of Neconyan.', 409);
    return data;
}

function requireId(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw roleplayError('CREATOR_ID', 'Choose a valid Creator draft.', 400);
    return id;
}

export function listCreatorDrafts(lease) {
    return Object.values(read(lease).drafts).map(item => ({ id: item.draft.id, name: item.draft.card.data.name || 'Untitled character', updatedAt: item.updatedAt, revision: item.revision, avatar: item.draft.source?.avatar ?? null }));
}

export function getCreatorDraft(lease, id) {
    const drafts = read(lease).drafts;
    requireId(id);
    const item = Object.hasOwn(drafts, id) ? drafts[id] : null;
    if (!item) throw roleplayError('CREATOR_NOT_FOUND', 'This Creator draft no longer exists.', 404);
    return item;
}

export function saveCreatorDraft(lease, draft, expectedRevision) {
    requireId(draft?.id);
    try { validateCreatorDraft(draft); } catch (error) { throw roleplayError('CREATOR_DOCUMENT', error.message, 400); }
    const store = read(lease);
    const previous = Object.hasOwn(store.drafts, draft.id) ? store.drafts[draft.id] : null;
    const revision = hash(JSON.stringify(draft));
    if (previous?.revision === revision) return previous;
    if ((previous?.revision ?? null) !== expectedRevision) throw roleplayError('CREATOR_CONFLICT', 'This draft changed elsewhere. Keep your recovery copy and compare the saved draft.', 409);
    if (!previous && Object.keys(store.drafts).length >= MAX_DRAFTS) throw roleplayError('CREATOR_LIMIT', 'Remove an old draft before creating another.', 409);
    const item = { draft, revision, updatedAt: new Date().toISOString() };
    store.drafts[draft.id] = item;
    writeAuthoringFileLocked(lease, filename(lease), JSON.stringify(store), { limit: LIMIT });
    return item;
}

export function deleteCreatorDraft(lease, id, expectedRevision) {
    const store = read(lease);
    requireId(id);
    const previous = Object.hasOwn(store.drafts, id) ? store.drafts[id] : null;
    if (!previous) return { deleted: true };
    if (previous.revision !== expectedRevision) throw roleplayError('CREATOR_CONFLICT', 'This draft changed elsewhere. Reload it before discarding.', 409);
    delete store.drafts[id];
    writeAuthoringFileLocked(lease, filename(lease), JSON.stringify(store), { limit: LIMIT });
    return { deleted: true };
}
