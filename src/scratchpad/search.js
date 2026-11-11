import fs from 'node:fs';
import path from 'node:path';

import { AUTHORING_FILE_LIMIT, readAuthoringFileLocked } from '../authoring-store.js';
import { roleplayLease } from '../roleplay-store.js';
import { ScratchpadError, SOURCE_KINDS } from './store.js';

export const MIN_SEARCH_LENGTH = 2;
export const MAX_SEARCH_LENGTH = 200;
export const MAX_SEARCH_RESULTS = 50;
const SNIPPET_BEFORE = 40;
const SNIPPET_LENGTH = 160;
const LIST_FILE = /^[a-f0-9]{40}\.json$/;
const LIST_ID = /^[a-f0-9]{40}$/;

function directoryOf(lease) {
    return path.join(roleplayLease(lease).scope.directories.root, 'scratchpad');
}

/** Read one saved session list; anything unreadable, or holding no sessions, is simply not a list. */
function readList(lease, directory, name) {
    let parsed;
    try {
        const file = readAuthoringFileLocked(lease, path.join(directory, name), AUTHORING_FILE_LIMIT);
        if (!file) return null;
        parsed = JSON.parse(file.bytes.toString('utf8'));
    } catch {
        return null;
    }
    const source = parsed?.source;
    if (!SOURCE_KINDS.includes(source?.kind) || typeof source.key !== 'string' || !Array.isArray(parsed.sessions)) return null;
    return parsed;
}

function listNames(directory) {
    try {
        return fs.readdirSync(directory).filter(name => LIST_FILE.test(name)).sort();
    } catch {
        return [];
    }
}

/** A name the owner can recognise: the saved label, or the character or group a shared list belongs to. */
function whereOf(source) {
    const label = typeof source.label === 'string' ? source.label.trim() : '';
    if (label) return label.slice(0, 200);
    const shared = /^shared:(?:conversation:[^:]*:)?(character|group):(.+)$/.exec(source.key);
    if (shared) return shared[2].replace(/\.[a-z0-9]+$/i, '').slice(0, 200);
    return '';
}

function snippetOf(text, at, length) {
    const start = Math.max(0, at - SNIPPET_BEFORE);
    const end = Math.min(text.length, Math.max(at + length, start + SNIPPET_LENGTH));
    const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
    return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

function matchOf(session, needle) {
    const name = typeof session.name === 'string' ? session.name : '';
    const messages = Array.isArray(session.messages) ? session.messages : [];
    for (const message of messages) {
        const text = typeof message?.text === 'string' ? message.text : '';
        const at = text.toLowerCase().indexOf(needle);
        if (at >= 0) return snippetOf(text, at, needle.length);
    }
    return name.toLowerCase().includes(needle) ? '' : null;
}

export function normaliseSearchQuery(value) {
    const query = typeof value === 'string' ? value.trim() : '';
    if (query.length < MIN_SEARCH_LENGTH) {
        throw new ScratchpadError('SCRATCHPAD_SEARCH_INVALID', 'Type at least 2 characters to search every list.');
    }
    if (query.length > MAX_SEARCH_LENGTH) {
        throw new ScratchpadError('SCRATCHPAD_SEARCH_INVALID', 'That search is too long. Use 200 characters or fewer.');
    }
    return query;
}

/** Find sessions by name or message text in every session list this account owns. */
export function searchSessionsLocked(lease, input) {
    const needle = normaliseSearchQuery(input).toLowerCase();
    const directory = directoryOf(lease);
    const results = [];
    for (const name of listNames(directory)) {
        const list = readList(lease, directory, name);
        if (!list) continue;
        for (const session of list.sessions) {
            if (!session || typeof session.id !== 'string' || session.temporary === true) continue;
            const snippet = matchOf(session, needle);
            if (snippet === null) continue;
            results.push({
                list: name.slice(0, 40),
                kind: list.source.kind,
                where: whereOf(list.source),
                sessionId: session.id,
                name: typeof session.name === 'string' ? session.name : '',
                assistant: typeof session.assistant === 'string' ? session.assistant : '',
                updated: typeof session.updated === 'string' ? session.updated.slice(0, 40) : '',
                messages: Array.isArray(session.messages) ? session.messages.length : 0,
                snippet,
            });
        }
    }
    results.sort((a, b) => b.updated.localeCompare(a.updated));
    return { results: results.slice(0, MAX_SEARCH_RESULTS), more: results.length > MAX_SEARCH_RESULTS };
}

/** Read one found session so it can be copied into another list through the import rules. */
export function readFoundSessionLocked(lease, listId, sessionId) {
    const missing = () => new ScratchpadError('SCRATCHPAD_SEARCH_MISSING', 'That session is no longer there. Search again.', 404);
    if (typeof listId !== 'string' || !LIST_ID.test(listId)) throw missing();
    const list = readList(lease, directoryOf(lease), `${listId}.json`);
    const session = list?.sessions.find(item => item?.id === sessionId && item.temporary !== true);
    if (!session) throw missing();
    return {
        assistant: session.assistant,
        gender: session.gender,
        name: session.name,
        settings: session.settings,
        messages: (Array.isArray(session.messages) ? session.messages : []).filter(item => item?.role === 'user' || item?.state === 'done'),
    };
}
