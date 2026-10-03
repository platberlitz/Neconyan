import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { readRoleplayFile } from '../roleplay-store.js';
import fs from 'node:fs';
import { buildEntry } from './note-index.js';
import { normaliseRelativePath, sha256 } from './paths.js';
import { MAX_NOTE_BYTES, walkContent } from './store.js';
import { prepareImport } from './transfer.js';
import { attachmentType, MAX_ATTACHMENT_BYTES } from './attachments.js';

function scan({ contentRoot }) {
    const walk = walkContent(contentRoot);
    const files = [];
    for (const record of walk.files) {
        try {
            normaliseRelativePath(record.path);
            const source = readRoleplayFile(path.join(contentRoot, ...record.path.split('/')), MAX_NOTE_BYTES);
            if (!source) continue;
            const text = source.bytes.toString('utf8');
            const parsed = buildEntry('', record.path, text, source.rawHash);
            files.push({ ...record, bytes: source.bytes, text, hash: source.rawHash, evidence: { rawHash: source.rawHash, physical: source.physical }, parsed });
        } catch {
            walk.skipped.push({ path: record.path, reason: record.nlink > 1 ? 'hardlink' : 'unreadable' });
        }
    }
    return { ...walk, files, hash: sha256(JSON.stringify(files.map(file => [file.path, file.hash]))) };
}

function syncSnapshot({ contentRoot, known = {} }) {
    const walk = walkContent(contentRoot);
    const files = [];
    let bytes = 0;
    for (const record of [...walk.files, ...walk.attachments]) {
        if (!/\.md$/i.test(record.path) && !attachmentType(record.path)) continue;
        normaliseRelativePath(record.path);
        const stat = fs.lstatSync(record.full);
        if (!stat.isFile() || stat.nlink !== 1) {
            const error = new Error('A sync file is linked or no longer a normal file. Sync has paused.');
            Object.assign(error, { code: 'OBSIDIAN_UNSAFE_FILES', status: 409 });
            throw error;
        }
        if (files.length >= 5000 || record.size > MAX_ATTACHMENT_BYTES || (bytes += record.size) > 256 * 1024 * 1024) {
            const error = new Error('This sync folder exceeds the bounded file-history limits. Sync was not started or has been paused.');
            Object.assign(error, { code: 'OBSIDIAN_HISTORY_LIMIT', status: 413 });
            throw error;
        }
        const previous = known[record.path];
        if (previous && !previous.deleted && previous.stat?.size === stat.size && previous.stat?.mtimeMs === stat.mtimeMs && previous.stat?.ino === stat.ino && previous.stat?.ctimeMs === stat.ctimeMs) {
            files.push({ path: record.path, hash: previous.hash, size: record.size, unchanged: true });
            continue;
        }
        const file = readRoleplayFile(record.full, MAX_ATTACHMENT_BYTES);
        if (!file) continue;
        files.push({ path: record.path, hash: file.rawHash, bytes: file.bytes, size: file.bytes.length,
            stat: { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, ctimeMs: stat.ctimeMs }, evidence: { rawHash: file.rawHash, physical: file.physical } });
    }
    if (walk.skipped.some(record => record.reason !== 'hidden')) {
        const error = new Error('Some sync content could not be read safely. Fix those files before starting sync.');
        Object.assign(error, { code: 'OBSIDIAN_UNSAFE_FILES', status: 409 });
        throw error;
    }
    return { files, paths: files.map(file => file.path), hash: sha256(JSON.stringify(files.map(file => [file.path, file.hash]))) };
}

try {
    const result = workerData.task === 'scan' ? scan(workerData.input)
        : workerData.task === 'sync-snapshot' ? syncSnapshot(workerData.input) : prepareImport(workerData.input);
    parentPort.postMessage({ result });
} catch (error) {
    parentPort.postMessage({ error: { code: error.code ?? 'NOTEBOOK_PREPARATION_FAILED', message: error.message, status: error.status ?? 500 } });
}
