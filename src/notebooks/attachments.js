import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createRoleplayDirectory } from '../roleplay-store.js';
import { readAuthoringFileLocked, writeAuthoringFileLocked } from '../authoring-store.js';
import {
    NotebookError, foldKey, normaliseFolder, normaliseRelativePath, sha256, uniquePath,
} from './paths.js';
import {
    ATTACHMENT_FOLDER, accountRootOf, loadNotebookLocked, notebookContentRoot, notebookControlRoot,
    readJsonLocked, runOperationLocked, updateManifestLocked, writeJsonLocked,
} from './store.js';
import { resolveLink } from './note-index.js';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Attachment types Neconyan accepts. Only raster images render inline;
 * SVG and every other type is served as a download so active content never
 * runs inside the app.
 */
export const ATTACHMENT_TYPES = Object.freeze({
    png: { mime: 'image/png', inline: true, magic: 'png' },
    jpg: { mime: 'image/jpeg', inline: true, magic: 'jpeg' },
    jpeg: { mime: 'image/jpeg', inline: true, magic: 'jpeg' },
    gif: { mime: 'image/gif', inline: true, magic: 'gif' },
    webp: { mime: 'image/webp', inline: true, magic: 'webp' },
    avif: { mime: 'image/avif', inline: true, magic: 'avif' },
    bmp: { mime: 'image/bmp', inline: true, magic: 'bmp' },
    svg: { mime: 'image/svg+xml', inline: false },
    pdf: { mime: 'application/pdf', inline: false, magic: 'pdf' },
    txt: { mime: 'text/plain; charset=utf-8', inline: false },
    csv: { mime: 'text/csv; charset=utf-8', inline: false },
    json: { mime: 'application/json', inline: false },
    canvas: { mime: 'application/json', inline: false },
    mp3: { mime: 'audio/mpeg', inline: false },
    ogg: { mime: 'audio/ogg', inline: false },
    wav: { mime: 'audio/wav', inline: false },
    m4a: { mime: 'audio/mp4', inline: false },
    mp4: { mime: 'video/mp4', inline: false },
    webm: { mime: 'video/webm', inline: false },
});

function extensionOf(name) {
    const match = /\.([A-Za-z0-9]{1,10})$/.exec(String(name ?? ''));
    return match ? match[1].toLowerCase() : '';
}

export function attachmentType(name) {
    return ATTACHMENT_TYPES[extensionOf(name)] ?? null;
}

function matchesMagic(kind, bytes) {
    const head = bytes.subarray(0, 16);
    switch (kind) {
        case 'png': return head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        case 'jpeg': return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
        case 'gif': return head.subarray(0, 4).toString('latin1') === 'GIF8';
        case 'webp': return head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
        case 'avif': return head.subarray(4, 8).toString('latin1') === 'ftyp' && /^avi[fs]/.test(head.subarray(8, 12).toString('latin1'));
        case 'bmp': return head.subarray(0, 2).toString('latin1') === 'BM';
        case 'pdf': return head.subarray(0, 5).toString('latin1') === '%PDF-';
        default: return true;
    }
}

/**
 * Checks a file's name, size and leading bytes. Throws a NotebookError
 * describing the first problem found.
 */
export function validateAttachment(name, bytes) {
    const type = attachmentType(name);
    if (!type) throw new NotebookError('ATTACHMENT_TYPE_UNSUPPORTED', 'That file type cannot be attached to a note.', 415);
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new NotebookError('ATTACHMENT_TOO_LARGE', 'Attachments can be up to 20 MiB.', 413);
    if (type.magic && !matchesMagic(type.magic, bytes)) {
        throw new NotebookError('ATTACHMENT_TYPE_MISMATCH', 'That file does not contain what its name says.', 415);
    }
    return type;
}

function cleanDisplayName(name) {
    const base = String(name ?? '').split(/[\\/]/).pop().normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return base.slice(0, 200) || 'attachment';
}

function safeStem(name) {
    const stem = cleanDisplayName(name).replace(/\.[^.]*$/, '');
    const cleaned = stem.replace(/[<>:"/\\|?*#^[\]%]/g, '-').replace(/^[.\s]+|[.\s]+$/g, '');
    return (cleaned || 'attachment').slice(0, 120);
}

export function attachmentPathIsSafe(relative) {
    try {
        const clean = normaliseRelativePath(relative, { label: 'attachment path' });
        return !/\.md$/i.test(clean) && Boolean(attachmentType(clean)) ? clean : null;
    } catch {
        return null;
    }
}

/**
 * Saves an uploaded file under the notebook's attachments folder with a
 * collision-free name. The original display name is kept in the manifest.
 */
export function saveAttachmentLocked(lease, { operationId, notebookId, name, bytes, folder = ATTACHMENT_FOLDER }) {
    const contentHash = sha256(bytes);
    return runOperationLocked(lease, { operationId, kind: 'attachment-upload', args: { notebookId, name, folder, contentHash } }, () => {
        validateAttachment(name, bytes);
        const state = loadNotebookLocked(lease, notebookId, { force: true });
        const cleanFolder = normaliseFolder(folder) || ATTACHMENT_FOLDER;
        normaliseRelativePath(cleanFolder);
        const taken = new Set([
            ...state.attachments.map(item => foldKey(item.path)),
            ...state.entries.map(entry => foldKey(entry.path)),
            ...state.folders.map(item => foldKey(item)),
        ]);
        const relative = uniquePath(cleanFolder, safeStem(name), `.${extensionOf(name)}`, taken);
        const target = path.join(notebookContentRoot(accountRootOf(lease), notebookId), relative);
        createRoleplayDirectory(path.dirname(target), accountRootOf(lease));
        writeAuthoringFileLocked(lease, target, bytes, { expected: null, limit: MAX_ATTACHMENT_BYTES });
        const displayName = cleanDisplayName(name);
        updateManifestLocked(lease, notebookId, manifest => {
            manifest.attachments ||= {};
            manifest.attachments[relative] = { name: displayName, size: bytes.length, hash: contentHash, uploadedAt: new Date().toISOString() };
        });
        return {
            status: 'success',
            committed: true,
            path: relative,
            name: displayName,
            size: bytes.length,
            markdown: `${attachmentType(name).inline ? '!' : ''}[${displayName.replace(/[[\]]/g, '')}](${relative.split('/').map(encodeURIComponent).join('/')})`,
        };
    });
}

export function listAttachmentsLocked(lease, notebookId) {
    const state = loadNotebookLocked(lease, notebookId);
    const meta = state.manifest.attachments ?? {};
    const references = attachmentReferenceMap(state);
    return state.attachments
        .filter(item => attachmentType(item.path))
        .map(item => ({
            path: item.path,
            name: meta[item.path]?.name ?? path.posix.basename(item.path),
            size: item.size,
            inline: Boolean(attachmentType(item.path)?.inline),
            references: (references.get(foldKey(item.path)) ?? []).length,
        }));
}

function attachmentReferenceMap(state) {
    const map = new Map();
    for (const entry of state.entries) {
        for (const link of entry.links) {
            const resolved = resolveLink(state.entries, link, entry.path);
            if (resolved.status !== 'attachment' || !resolved.path) continue;
            const key = foldKey(resolved.path);
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(entry.id);
        }
    }
    return map;
}

/**
 * Reads attachment bytes for the owner. The caller decides whether the
 * request context may see this notebook.
 */
export function readAttachmentLocked(lease, { notebookId, path: relative }) {
    const clean = attachmentPathIsSafe(relative);
    if (!clean) throw new NotebookError('ATTACHMENT_NOT_FOUND', 'That attachment could not be found.', 404);
    loadNotebookLocked(lease, notebookId);
    const target = path.join(notebookContentRoot(accountRootOf(lease), notebookId), clean);
    let file;
    try {
        file = readAuthoringFileLocked(lease, target, MAX_ATTACHMENT_BYTES);
    } catch {
        file = null;
    }
    if (!file) throw new NotebookError('ATTACHMENT_NOT_FOUND', 'That attachment could not be found.', 404);
    const type = attachmentType(clean);
    return { bytes: file.bytes, path: clean, mime: type.mime, inline: type.inline, hash: file.rawHash };
}

function attachmentTrashFile(lease, notebookId) {
    return path.join(notebookControlRoot(accountRootOf(lease), notebookId), 'attachment-trash.json');
}

/**
 * Moves an attachment out of the content folder into recoverable storage.
 * Refuses while a current note still links to it.
 */
export function trashAttachmentLocked(lease, { operationId, notebookId, path: relative }) {
    return runOperationLocked(lease, { operationId, kind: 'attachment-trash', args: { notebookId, path: relative } }, () => {
        const clean = attachmentPathIsSafe(relative);
        if (!clean) throw new NotebookError('ATTACHMENT_NOT_FOUND', 'That attachment could not be found.', 404);
        const state = loadNotebookLocked(lease, notebookId, { force: true });
        const users = attachmentReferenceMap(state).get(foldKey(clean)) ?? [];
        if (users.length) {
            throw new NotebookError('ATTACHMENT_IN_USE', 'Notes still link to this attachment.', 409, {
                notes: users.map(id => ({ id, title: state.byId.get(id)?.title })),
            });
        }
        const root = accountRootOf(lease);
        const source = path.join(notebookContentRoot(root, notebookId), clean);
        if (!fs.existsSync(source)) throw new NotebookError('ATTACHMENT_NOT_FOUND', 'That attachment could not be found.', 404);
        const id = `a_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
        const held = path.join(notebookControlRoot(root, notebookId), 'attachment-trash', id);
        createRoleplayDirectory(path.dirname(held), root);
        fs.renameSync(source, held);
        const trash = readJsonLocked(lease, attachmentTrashFile(lease, notebookId), () => ({ schema: 1, entries: [] }));
        trash.entries.push({ id, path: clean, name: state.manifest.attachments?.[clean]?.name ?? path.posix.basename(clean), deletedAt: new Date().toISOString() });
        writeJsonLocked(lease, attachmentTrashFile(lease, notebookId), trash);
        updateManifestLocked(lease, notebookId, manifest => {
            if (manifest.attachments) delete manifest.attachments[clean];
        });
        return { status: 'success', committed: true, trashId: id, path: clean };
    });
}

export function listAttachmentTrashLocked(lease, notebookId) {
    return readJsonLocked(lease, attachmentTrashFile(lease, notebookId), () => ({ schema: 1, entries: [] })).entries;
}

export function restoreAttachmentLocked(lease, { operationId, notebookId, trashId }) {
    return runOperationLocked(lease, { operationId, kind: 'attachment-restore', args: { notebookId, trashId } }, () => {
        const trash = readJsonLocked(lease, attachmentTrashFile(lease, notebookId), () => ({ schema: 1, entries: [] }));
        const index = trash.entries.findIndex(entry => entry.id === trashId);
        if (index < 0 || !/^a_[a-f0-9]{16}$/.test(trashId)) throw new NotebookError('ATTACHMENT_NOT_FOUND', 'That attachment is not in Trash.', 404);
        const record = trash.entries[index];
        const state = loadNotebookLocked(lease, notebookId, { force: true });
        const taken = new Set([...state.attachments.map(item => foldKey(item.path)), ...state.entries.map(entry => foldKey(entry.path))]);
        const folder = path.posix.dirname(record.path) === '.' ? '' : path.posix.dirname(record.path);
        const ext = path.posix.extname(record.path);
        const relative = taken.has(foldKey(record.path))
            ? uniquePath(folder, path.posix.basename(record.path, ext), ext, taken)
            : record.path;
        const root = accountRootOf(lease);
        const target = path.join(notebookContentRoot(root, notebookId), relative);
        createRoleplayDirectory(path.dirname(target), root);
        fs.renameSync(path.join(notebookControlRoot(root, notebookId), 'attachment-trash', trashId), target);
        trash.entries.splice(index, 1);
        writeJsonLocked(lease, attachmentTrashFile(lease, notebookId), trash);
        updateManifestLocked(lease, notebookId, manifest => {
            manifest.attachments ||= {};
            manifest.attachments[relative] = { name: record.name, restoredAt: new Date().toISOString() };
        });
        return { status: 'success', committed: true, path: relative };
    });
}
