import fs from 'node:fs';
import path from 'node:path';
import { setImmediate as yieldToServer } from 'node:timers/promises';
import sanitize from 'sanitize-filename';
import { formatBytes } from '../util.js';
import { authoringEvidence, readAuthoringFileLocked } from '../authoring-store.js';
import { inspectRoleplayFileStat, readRoleplayFile, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { createFileSummaryCache } from '../file-summary-cache.js';
import { findMatchingSnippetInJsonl, parseJsonl, recordsToText, normalizeOrganization } from '../../public/scripts/extensions/neconyan-chats-archive/src/core.js';
import { registerOperation } from './jobs.js';
import { operationError, readOperation, withOperation } from './store.js';
import { publishAccountFile } from './file-publication.js';

const FILE_LIMIT = 32 * 1024 * 1024;
const ORGANIZATION_LIMIT = 8 * 1024 * 1024;
const ORGANIZATION_FILE = '_sbca_organization.json';
// The archive list shows 180 characters, and every row is held in both the saved plan and the result.
const PREVIEW_LENGTH = 180;
const metadataCache = createFileSummaryCache({ maxBytes: 32 * 1024 * 1024, maxEntries: 100000 });

function cachedMetadata(base, account, filename) {
    // Revalidate ancestors and link counts even on a hit. Nanosecond timestamps
    // catch same-size rewrites; the saved content hash still guards later reads.
    const stat = inspectRoleplayFileStat(filename, FILE_LIMIT);
    if (!stat) throw operationError('An archive file disappeared during capture. Start another scan.');
    const identity = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeNs, ctimeMs: stat.ctimeNs };
    const cacheKey = JSON.stringify([base.owner, account.accountId, account.dataEpoch, filename]);
    const cached = metadataCache.get(cacheKey, identity);
    if (cached) return cached;
    const file = readRoleplayFile(filename, FILE_LIMIT);
    if (!file) throw operationError('An archive file disappeared during capture. Start another scan.');
    const value = { evidence: authoringEvidence(file), metadata: metadata(file.bytes, Number(stat.mtimeMs)) };
    const after = inspectRoleplayFileStat(filename, FILE_LIMIT);
    if (after && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'].every(field => stat[field] === after[field])) {
        metadataCache.set(cacheKey, identity, value);
    }
    return value;
}

function previewText(value) {
    const preview = value.trim().replace(/\s+/g, ' ');
    return preview.length > PREVIEW_LENGTH ? `${preview.slice(0, PREVIEW_LENGTH - 3)}...` : preview;
}

function directoryEntries(directory) {
    readRoleplayFile(path.join(directory, '.archive-path-check'), 1, { allowMissingParent: true });
    try {
        const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        if (entries.some(entry => !entry.isFile() && !entry.isDirectory())) throw operationError('An archive path is not a regular file or directory. Resolve it before scanning.');
        return entries;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function metadata(bytes, mtime) {
    const lines = bytes.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
    let first, last;
    try { first = JSON.parse(lines[0] || 'null'); } catch { /* A damaged row is reported, never deleted. */ }
    try { last = JSON.parse(lines.at(-1) || 'null'); } catch { /* Metadata is still useful for a damaged chat. */ }
    const header = first && typeof first === 'object' && !Array.isArray(first) && !Object.hasOwn(first, 'mes');
    return { file_size: formatBytes(bytes.length), chat_items: Math.max(0, lines.length - Number(Boolean(header))),
        last_mes: last?.send_date || mtime, mes: typeof last?.mes === 'string' ? previewText(last.mes) : '[The chat is empty]' };
}

/** Fields derivable from the captured path are rebuilt rather than stored twice in the plan. */
function archiveRow(file) {
    return { _source: file.row.orphan_type && file.row.orphan_type !== 'root' ? 'archive-orphan' : 'archive-inventory',
        file_id: path.basename(file.relative, '.jsonl'), file_name: path.basename(file.relative), ...file.row, archive_hash: file.hash };
}

/** Capture both ownership and file identities once; pagination never advances a mutable cursor. */
export async function captureArchive(base, account, input = {}) {
    if (!['archive', 'orphans', 'all'].includes(input.scope || 'archive')) throw operationError('Choose a valid archive scope.', 400);
    if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 10000)) throw operationError('The archive search text is too large.', 400);
    const files = withRoleplayAccount(base, account, () => {
        const dirs = base.directories;
        const avatars = new Map(directoryEntries(dirs.characters).filter(entry => entry.isFile() && entry.name.endsWith('.png')).map(entry => [entry.name.slice(0, -4), entry.name]));
        const groups = new Map();
        for (const entry of directoryEntries(dirs.groups).filter(entry => entry.isFile() && entry.name.endsWith('.json'))) {
            const file = readRoleplayFile(path.join(dirs.groups, entry.name), 8 * 1024 * 1024);
            let group; try { group = JSON.parse(file.bytes); } catch { throw operationError('A group definition could not be read. No archive ownership was guessed.'); }
            if (!group || !['number', 'string'].includes(typeof group.id) || !Array.isArray(group.chats ?? [])) throw operationError('A saved group definition is invalid.');
            for (const chat of new Set([...(group.chats || []), group.chat_id].filter(value => value !== undefined && value !== null && value !== ''))) {
                const name = `${chat}.jsonl`;
                if (sanitize(name) !== name) throw operationError('A saved group chat name is invalid.');
                if (groups.has(name) && String(groups.get(name)) !== String(group.id)) throw operationError('More than one group owns this saved chat.');
                groups.set(name, group.id);
            }
        }
        const files = [];
        const add = (filename, identity, linked) => {
            if (input.scope !== 'all' && (input.scope === 'orphans') === linked) return;
            files.push({ relative: path.relative(dirs.root, filename), row: identity });
            if (files.length > 100000) throw operationError('This archive exceeds the saved inventory capacity.', 413);
        };
        for (const entry of directoryEntries(dirs.chats)) {
            if (entry.isFile() && entry.name.endsWith('.jsonl')) add(path.join(dirs.chats, entry.name), { orphan_type: 'root' }, true);
            if (!entry.isDirectory()) continue;
            const avatar = avatars.get(entry.name);
            for (const chat of directoryEntries(path.join(dirs.chats, entry.name))) {
                if (chat.isFile() && chat.name.endsWith('.jsonl')) add(path.join(dirs.chats, entry.name, chat.name),
                    { chatFolder: entry.name, ...(avatar ? { avatar } : { orphan_type: 'missing-character' }) }, Boolean(avatar));
            }
        }
        for (const entry of directoryEntries(dirs.groupChats)) {
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
            const group = groups.get(entry.name);
            add(path.join(dirs.groupChats, entry.name), group === undefined ? { orphan_type: 'unlinked-group' } : { group }, group !== undefined);
        }
        return files;
    });
    // Short synchronous leases keep account checks intact without holding the
    // account lock or the server's event loop across a whole multi-GB library.
    let index = 0;
    while (index < files.length) {
        await yieldToServer();
        withRoleplayAccount(base, account, () => {
            const started = performance.now();
            do {
                const file = files[index++];
                const saved = cachedMetadata(base, account, path.join(base.directories.root, file.relative));
                file.hash = roleplayHash(file.relative);
                file.evidence = saved.evidence;
                file.row = { ...file.row, ...saved.metadata };
            } while (index < files.length && performance.now() - started < 16);
        });
    }
    return { scope: input.scope || 'archive', query: input.query ?? null, files };
}

function readCaptured(base, file) {
    const current = readRoleplayFile(path.join(base.directories.root, file.relative), FILE_LIMIT);
    if (!current || roleplayHash(authoringEvidence(current)) !== roleplayHash(file.evidence)) throw operationError('This archive file changed after the saved scan. Refresh the archive before reading it.');
    return current.bytes;
}

export function readArchiveFile(base, key, hash) {
    const record = readOperation(base, key);
    const file = record?.state === 'completed' && ['archive-inventory', 'archive-search'].includes(record.kind) && record.plan.files.find(item => item.hash === hash);
    if (!file) throw operationError('This file is not in the saved archive result.', 404);
    return withRoleplayAccount(base, record.account, () => ({ bytes: readCaptured(base, file), name: path.basename(file.relative) }));
}

async function runArchive(context, plan) {
    const rows = []; let errors = 0;
    let lastProgress = performance.now();
    let lastYield = lastProgress;
    for (let index = 0; index < plan.files.length; index++) {
        context.signal.throwIfAborted(); const file = plan.files[index];
        if (plan.query) {
            const text = withOperation(context, ({ base }) => readCaptured(base, file).toString('utf8'));
            const match = findMatchingSnippetInJsonl(text, plan.query);
            errors += Number(match.invalidLines > 0);
            if (match.snippet !== null) rows.push({ ...archiveRow(file), mes: match.snippet });
        } else rows.push(archiveRow(file));
        const now = performance.now();
        if (now - lastProgress >= 500 || index + 1 === plan.files.length) {
            await context.progress({ stage: 'Preparing saved chat archive', completed: index + 1, total: plan.files.length });
            lastProgress = now;
        }
        if (now - lastYield >= 16) { await yieldToServer(); lastYield = performance.now(); }
    }
    return { rows, errors, total: rows.length, scope: plan.scope, query: plan.query };
}

export function readArchiveOrganization(base, account = null) {
    return withRoleplayAccount(base, account, lease => {
        const filename = path.join(base.directories.files, ORGANIZATION_FILE);
        const file = readAuthoringFileLocked(lease, filename, ORGANIZATION_LIMIT);
        let value = null;
        if (file) {
            try { value = JSON.parse(file.bytes); } catch {
                try { value = JSON.parse(Buffer.from(file.bytes.toString().trim(), 'base64').toString('utf8')); } catch { throw operationError('The saved archive organisation could not be read. Its contents were kept.'); }
            }
        }
        return { organization: value === null ? null : normalizeOrganization(value), revision: roleplayHash(authoringEvidence(file)),
            evidence: authoringEvidence(file), relative: path.relative(base.directories.root, filename) };
    });
}

registerOperation('archive-inventory', { label: 'Read saved chat archive', resultInRecord: true, capture: captureArchive, run: runArchive });
registerOperation('archive-search', { label: 'Search saved chat contents', resultInRecord: true, capture: (base, account, input) => captureArchive(base, account, { ...input, scope: 'all' }), run: runArchive });
registerOperation('archive-export', { label: 'Export a saved chat', resultInRecord: true,
    capture: (base, account, input) => {
        if (typeof input.file !== 'string' || !input.file.endsWith('.jsonl') || sanitize(input.file) !== input.file || !['jsonl', 'txt'].includes(input.format || 'jsonl')) throw operationError('Choose a saved chat and export format.', 400);
        const avatar = input.avatar_url;
        if (!input.is_group && (typeof avatar !== 'string' || sanitize(avatar) !== avatar || !avatar.endsWith('.png'))) throw operationError('Choose a saved character chat.', 400);
        const directory = input.is_group ? base.directories.groupChats : path.join(base.directories.chats, avatar === '.png' ? '' : avatar.slice(0, -4));
        return withRoleplayAccount(base, account, () => {
            const file = readRoleplayFile(path.join(directory, input.file), FILE_LIMIT);
            if (!file) throw operationError('The selected chat was not found.', 404);
            return { text: file.bytes.toString('utf8'), format: input.format || 'jsonl', name: input.file };
        });
    }, run: (_context, plan) => {
        const text = plan.format === 'jsonl' ? plan.text : recordsToText(parseJsonl(plan.text));
        return { result: plan.format === 'txt' && text ? text + '\n\n' : text,
            fileName: plan.name.replace(/\.jsonl$/, `.${plan.format}`), message: `Chat saved to ${plan.name}` };
    } });
registerOperation('archive-organization', { label: 'Save chat archive organisation', target: () => ({ kind: 'file', id: ORGANIZATION_FILE }),
    canRecover: value => Boolean(value.effects.file), capture: (base, account, input) => {
        const current = readArchiveOrganization(base, account);
        if (input.revision !== current.revision) throw operationError('The archive organisation changed in another window. Reload before saving.');
        if (!input.organization || typeof input.organization !== 'object' || Array.isArray(input.organization)) throw operationError('The archive organisation must be an object.', 400);
        const organization = normalizeOrganization(input.organization); const text = JSON.stringify(organization);
        if (Buffer.byteLength(text) > ORGANIZATION_LIMIT) throw operationError('The archive organisation exceeds its saved capacity.', 413);
        return { relative: current.relative, evidence: current.evidence, text, limit: ORGANIZATION_LIMIT, result: { organization } };
    }, run: publishAccountFile });
