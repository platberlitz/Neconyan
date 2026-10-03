import crypto from 'node:crypto';

export const NOTEBOOK_ID = /^nb_[a-f0-9]{16}$/;
export const NOTE_ID = /^n_[a-f0-9]{16}$/;
export const MAX_SEGMENT_BYTES = 180;
export const MAX_PATH_BYTES = 1024;
export const MAX_DEPTH = 16;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u001f\u007f<>:"\\|?*]/u;

export class NotebookError extends Error {
    constructor(code, message, status = 400, extra = {}) {
        super(message);
        this.code = code;
        this.status = status;
        Object.assign(this, extra);
    }
}

export const notebookError = (code, message, status = 400, extra = {}) => new NotebookError(code, message, status, extra);
export const newNotebookId = () => `nb_${crypto.randomBytes(8).toString('hex')}`;
export const newNoteId = () => `n_${crypto.randomBytes(8).toString('hex')}`;
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

/** Collision key: Unicode NFC plus case folding, used to detect names that would clash on common filesystems. */
export const foldKey = value => String(value).normalize('NFC').toLocaleLowerCase('und').normalize('NFC');

export function validSegment(segment, { allowHidden = false } = {}) {
    if (typeof segment !== 'string' || !segment || segment === '.' || segment === '..') return false;
    if (segment !== segment.normalize('NFC')) return false;
    if (FORBIDDEN.test(segment) || segment.includes('/')) return false;
    if (!allowHidden && segment.startsWith('.')) return false;
    if (/[. ]$/.test(segment) || /^\s/.test(segment)) return false;
    if (RESERVED.test(segment)) return false;
    return Buffer.byteLength(segment, 'utf8') <= MAX_SEGMENT_BYTES;
}

/** Normalises a notebook-relative path and rejects anything that could escape or clash. */
export function normaliseRelativePath(value, { allowHidden = false, label = 'path' } = {}) {
    if (typeof value !== 'string') throw notebookError('NOTEBOOK_PATH_INVALID', `The ${label} is invalid.`);
    const text = value.normalize('NFC').replace(/^\/+/, '');
    if (!text || text.includes('\0') || /^[a-z]:/i.test(text) || text.startsWith('\\\\') || text.startsWith('//')) {
        throw notebookError('NOTEBOOK_PATH_INVALID', `The ${label} is invalid.`);
    }
    const segments = text.split('/');
    if (segments.length > MAX_DEPTH || Buffer.byteLength(text, 'utf8') > MAX_PATH_BYTES || !segments.every(segment => validSegment(segment, { allowHidden }))) {
        throw notebookError('NOTEBOOK_PATH_INVALID', `The ${label} contains a name that cannot be saved.`);
    }
    return segments.join('/');
}

export function normaliseFolder(value) {
    if (value === undefined || value === null || value === '' || value === '/') return '';
    return normaliseRelativePath(String(value).replace(/\/+$/, ''), { label: 'folder' });
}

/** A portable file name for a title. Unicode is kept; only characters that cannot be stored are replaced. */
export function titleToFileStem(title) {
    let stem = String(title ?? '').normalize('NFC')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f<>:"/\\|?*#^[\]]/gu, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\.+/, '')
        .replace(/[. ]+$/, '');
    if (!stem || RESERVED.test(stem)) stem = stem ? `${stem}-note` : 'Untitled';
    while (Buffer.byteLength(stem, 'utf8') > MAX_SEGMENT_BYTES - 12) stem = Array.from(stem).slice(0, -1).join('');
    return stem;
}

export const joinPath = (folder, name) => (folder ? `${folder}/${name}` : name);
export const parentFolder = relative => (relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '');
export const baseName = relative => relative.slice(relative.lastIndexOf('/') + 1);
export const stemOf = relative => baseName(relative).replace(/\.md$/i, '');

/** Picks `Name.md`, `Name 2.md`, ... without clashing with any existing case/Unicode-folded path. */
export function uniquePath(folder, stem, extension, taken) {
    const occupied = taken instanceof Set ? taken : new Set([...taken].map(foldKey));
    for (let index = 1; index < 10000; index++) {
        const name = `${index === 1 ? stem : `${stem} ${index}`}${extension}`;
        const candidate = joinPath(folder, name);
        if (!occupied.has(foldKey(candidate))) return candidate;
    }
    throw notebookError('NOTEBOOK_PATH_TAKEN', 'Too many notes share this name.', 409);
}

export function requireNotebookId(value) {
    if (typeof value !== 'string' || !NOTEBOOK_ID.test(value)) throw notebookError('NOTEBOOK_NOT_FOUND', 'The notebook was not found.', 404);
    return value;
}

export function requireNoteId(value) {
    if (typeof value !== 'string' || !NOTE_ID.test(value)) throw notebookError('NOTE_NOT_FOUND', 'The note was not found.', 404);
    return value;
}
