import path from 'node:path';
import { readAuthoringFileLocked, writeAuthoringFileLocked } from '../authoring-store.js';
import { roleplayLease } from '../roleplay-store.js';
import { invalidateContextCache } from './context.js';
import { relinkBookBindingsLocked } from './lore.js';
import { NotebookError } from './paths.js';
import {
    invalidateNotebookCache,
    listNotebookIdsLocked,
    notebookControlRoot,
    readJsonLocked,
    readManifestLocked,
    readPoliciesLocked,
    writeManifestStructureLocked,
    writePoliciesLocked,
} from './store.js';

/*
 * Keeps every Notebook in the account pointing at a lorebook after the whole
 * book is renamed or deleted: lore bindings, note associations and lorebook
 * context scopes. Note bodies and pending assistant proposals are left alone.
 */

const BOOK_KINDS = new Set(['lorebook', 'lore-entry']);
// A control file this version cannot read is reported and left exactly as it is.
const UNREADABLE = new Set(['NOTEBOOK_SCHEMA_UNSUPPORTED', 'NOTEBOOK_CONTROL_DAMAGED']);

/** The new id for a stored book reference, keeping its '.json' form, or null when it names another book. */
export function renameBookReference(id, from, to) {
    if (typeof id !== 'string') return null;
    if (id === from) return to;
    if (id === `${from}.json`) return `${to}.json`;
    return null;
}

function relabel(label, from, to) {
    if (typeof label !== 'string') return label;
    if (label === from) return to;
    const suffix = ` (${from})`;
    return label.endsWith(suffix) ? `${label.slice(0, -suffix.length)} (${to})` : label;
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function damaged(message) {
    return new NotebookError('NOTEBOOK_CONTROL_DAMAGED', message, 500);
}

/**
 * Reads a manifest for relinking. A manifest that is not an object leaves the
 * whole notebook alone; associations of the wrong shape are reported apart, as
 * rewriting the manifest would otherwise replace them with an empty set.
 */
function readManifestForLinks(lease, notebookId, control) {
    const raw = readJsonLocked(lease, path.join(control, 'manifest.json'), null);
    if (!isRecord(raw)) throw damaged('The notebook manifest could not be read.');
    const manifest = readManifestLocked(lease, notebookId);
    const lists = raw.associations;
    const associationsOk = (raw.notes == null || isRecord(raw.notes))
        && (lists == null || (isRecord(lists) && Object.values(lists).every(list => Array.isArray(list) && list.every(isRecord))));
    return { manifest, associationsOk };
}

function associationKey(item) {
    return `${item.kind}\u0000${item.id}\u0000${item.uid ?? ''}`;
}

/** Rewrites manifest associations in place. Returns how many changed. */
export function relinkAssociations(manifest, from, to = null) {
    let changed = 0;
    for (const [noteId, list] of Object.entries(manifest.associations ?? {})) {
        if (!Array.isArray(list)) continue;
        let touched = 0;
        const next = [];
        for (const item of list) {
            const book = BOOK_KINDS.has(item?.kind) ? renameBookReference(item.id, from, to ?? from) : null;
            if (book === null) {
                next.push(item);
                continue;
            }
            touched++;
            if (to !== null) next.push({ ...item, id: book, label: relabel(item.label, from, to) });
        }
        if (!touched) continue;
        changed += touched;
        const seen = new Set();
        const unique = next.filter(item => {
            const key = associationKey(item);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        if (unique.length) manifest.associations[noteId] = unique;
        else delete manifest.associations[noteId];
    }
    return changed;
}

/**
 * Rewrites lorebook context scopes in place. A note whose last scope goes
 * stops being offered as context; its other policy settings stay.
 */
export function relinkContextScopes(policies, from, to = null) {
    let changed = 0;
    for (const [noteId, entry] of Object.entries(policies.notes ?? {})) {
        const context = entry?.context;
        if (!context || !Array.isArray(context.scopes)) continue;
        let touched = 0;
        const scopes = [];
        for (const scope of context.scopes) {
            const book = scope?.kind === 'lorebook' ? renameBookReference(scope.id, from, to ?? from) : null;
            if (book === null) {
                scopes.push(scope);
                continue;
            }
            touched++;
            if (to !== null) scopes.push({ ...scope, id: book, ...(scope.label === undefined ? {} : { label: relabel(scope.label, from, to) }) });
        }
        if (!touched) continue;
        changed += touched;
        if (scopes.length) {
            entry.context = { ...context, scopes };
            continue;
        }
        delete entry.context;
        if (!Object.keys(entry).length) delete policies.notes[noteId];
    }
    return changed;
}

function skipped(lease, notebookId, part, error, name = null) {
    if (name === null) {
        try {
            const manifest = readJsonLocked(lease, path.join(notebookControlRoot(rootOf(lease), notebookId), 'manifest.json'), null);
            if (typeof manifest?.name === 'string') name = manifest.name;
        } catch {
            // A damaged manifest has no readable name; the id identifies it.
        }
    }
    return { notebookId, name, part, code: error?.code ?? 'NOTEBOOK_UNREADABLE' };
}

function rootOf(lease) {
    return roleplayLease(lease).scope.directories.root;
}

/**
 * Moves (`toFilename` set) or removes (`toFilename` null) every Notebook link
 * to one lorebook file. A part this version cannot read (the lore links, the
 * associations or the policies) is skipped, listed and never rewritten, while
 * the other parts are still updated; an unreadable manifest skips the whole
 * notebook. A failed write puts back every file already
 * changed and throws. `undo()` reverses a finished run, for a rename that
 * fails later.
 */
export function relinkNotebookLorebooksLocked(lease, { fromFilename, toFilename = null }) {
    const from = path.parse(fromFilename).name;
    const to = toFilename === null ? null : path.parse(toFilename).name;
    const originals = [];
    const changedNotebooks = new Set();
    const keep = (notebookId, filename) => {
        changedNotebooks.add(notebookId);
        if (originals.some(item => item.filename === filename)) return;
        originals.push({ filename, bytes: readAuthoringFileLocked(lease, filename)?.bytes ?? null });
    };
    const undo = () => {
        for (const { filename, bytes } of [...originals].reverse()) {
            if (bytes) writeAuthoringFileLocked(lease, filename, bytes);
        }
        for (const notebookId of changedNotebooks) {
            invalidateNotebookCache(lease, notebookId);
            invalidateContextCache(lease, notebookId);
        }
    };
    const report = { links: 0, notebooks: [], skipped: [] };
    try {
        for (const notebookId of listNotebookIdsLocked(lease)) {
            const control = notebookControlRoot(rootOf(lease), notebookId);
            let manifest;
            let associationsOk;
            try {
                ({ manifest, associationsOk } = readManifestForLinks(lease, notebookId, control));
            } catch (error) {
                if (!UNREADABLE.has(error?.code)) throw error;
                report.skipped.push(skipped(lease, notebookId, 'notebook', error));
                continue;
            }
            const name = typeof manifest.name === 'string' ? manifest.name : null;
            let links = 0;

            try {
                keep(notebookId, path.join(control, 'lore-bindings.json'));
                links += relinkBookBindingsLocked(lease, notebookId, fromFilename, toFilename);
            } catch (error) {
                // Only an unreadable file is skipped; it was not written, so nothing needs undoing.
                if (!UNREADABLE.has(error?.code)) throw error;
                report.skipped.push(skipped(lease, notebookId, 'bindings', error, name));
            }

            const changedAssociations = associationsOk ? relinkAssociations(manifest, from, to) : 0;
            if (!associationsOk) {
                report.skipped.push(skipped(lease, notebookId, 'associations', damaged('These associations could not be read.'), name));
            } else if (changedAssociations) {
                keep(notebookId, path.join(control, 'manifest.json'));
                writeManifestStructureLocked(lease, manifest);
                links += changedAssociations;
            }

            let policies = null;
            try {
                policies = readPoliciesLocked(lease, notebookId);
            } catch (error) {
                if (!UNREADABLE.has(error?.code)) throw error;
                report.skipped.push(skipped(lease, notebookId, 'policies', error, name));
            }
            const changedScopes = policies ? relinkContextScopes(policies, from, to) : 0;
            if (changedScopes) {
                keep(notebookId, path.join(control, 'policies.json'));
                // A new revision, as for any policy change, so a settings screen opened before this cannot put the old scope back.
                writePoliciesLocked(lease, notebookId, policies);
                links += changedScopes;
            }

            if (links) {
                invalidateContextCache(lease, notebookId);
                report.links += links;
                report.notebooks.push(notebookId);
            }
        }
    } catch (error) {
        undo();
        throw error;
    }
    return { report, undo };
}
