import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tryWriteFileSync } from './util.js';
import { isNativeLorebook, serializeLorebook } from '../public/scripts/neconyan-lorebook-tools-core.js';
import { deleteAuthoringFileLocked, readAuthoringFileLocked, writeAuthoringFileLocked } from './authoring-store.js';

export function worldInfoRevision(data) {
    return createHash('sha256').update(serializeLorebook(data)).digest('hex');
}

export function worldInfoHistoryPath(bookPath) {
    const filename = createHash('sha256').update(path.basename(bookPath)).digest('hex');
    return path.join(path.dirname(bookPath), '.history', `${filename}.json`);
}

export function newWorldInfoHistory() {
    const now = Date.now();
    return { version: 1, id: randomUUID(), createdAt: now, updatedAt: now, headCommitId: null, commits: [] };
}

export function validateWorldInfoHistory(history) {
    if (!history || history.version !== 1 || !Array.isArray(history.commits)) return false;
    const ids = new Set();
    for (const commit of history.commits) {
        if (!commit || typeof commit.id !== 'string' || !/^[a-f0-9]{64}$/.test(commit.id) || ids.has(commit.id)
            || !(commit.parentId === null || ids.has(commit.parentId)) || !Number.isFinite(commit.timestamp)
            || typeof commit.message !== 'string' || !isNativeLorebook(commit.snapshot)) return false;
        ids.add(commit.id);
    }
    return history.headCommitId === null || ids.has(history.headCommitId);
}

export function readWorldInfoHistory(bookPath, lease = null) {
    const filename = worldInfoHistoryPath(bookPath);
    if (lease) {
        const file = readAuthoringFileLocked(lease, filename);
        if (!file) return null;
        const history = JSON.parse(file.bytes.toString('utf8'));
        if (!validateWorldInfoHistory(history)) throw new Error('Invalid World Info history');
        return history;
    }
    if (!fs.existsSync(filename)) return null;
    const history = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!validateWorldInfoHistory(history)) throw new Error('Invalid World Info history');
    return history;
}

export function writeWorldInfoHistory(bookPath, history, lease = null) {
    if (!validateWorldInfoHistory(history)) throw new Error('Invalid World Info history');
    const filename = worldInfoHistoryPath(bookPath);
    if (lease) return writeAuthoringFileLocked(lease, filename, JSON.stringify(history));
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    tryWriteFileSync(filename, JSON.stringify(history));
}

export function deleteWorldInfoHistory(bookPath, lease = null) {
    if (lease) return deleteAuthoringFileLocked(lease, worldInfoHistoryPath(bookPath));
    fs.rmSync(worldInfoHistoryPath(bookPath), { force: true });
}

export function renameWorldInfoHistory(oldPath, newPath, lease = null) {
    const source = worldInfoHistoryPath(oldPath);
    const target = worldInfoHistoryPath(newPath);
    if (lease) {
        const file = readAuthoringFileLocked(lease, source);
        if (!file) return;
        if (readAuthoringFileLocked(lease, target)) throw new Error('World Info history already exists');
        writeAuthoringFileLocked(lease, target, file.bytes, { expected: null });
        deleteAuthoringFileLocked(lease, source, { rawHash: file.rawHash, physical: file.physical });
        return;
    }
    if (!fs.existsSync(source)) return;
    if (fs.existsSync(target)) throw new Error('World Info history already exists');
    fs.renameSync(source, target);
}

export function appendWorldInfoCommit(history, snapshot, message) {
    const head = history.commits.find(commit => commit.id === history.headCommitId);
    if (head && serializeLorebook(head.snapshot) === serializeLorebook(snapshot)) return history;
    const parentId = history.headCommitId;
    const id = createHash('sha256').update(`${parentId ?? 'root'}\0${serializeLorebook(snapshot)}`).digest('hex');
    const timestamp = Date.now();
    return {
        ...history,
        headCommitId: id,
        updatedAt: timestamp,
        commits: [...history.commits, { id, parentId, timestamp, message, snapshot: structuredClone(snapshot) }],
    };
}

export function mergeWorldInfoHistory(previous, incoming, currentBook) {
    if (!previous) return incoming;
    const protectedHistory = appendWorldInfoCommit(previous, currentBook, 'Import');
    const commits = new Map(protectedHistory.commits.map(commit => [commit.id, commit]));
    for (const commit of incoming.commits) {
        const existing = commits.get(commit.id);
        if (existing && (serializeLorebook(existing.snapshot) !== serializeLorebook(commit.snapshot) || existing.parentId !== commit.parentId)) {
            throw new Error('Invalid World Info history');
        }
        if (!existing) commits.set(commit.id, commit);
    }
    return { ...incoming, id: previous.id, createdAt: previous.createdAt, commits: [...commits.values()] };
}
