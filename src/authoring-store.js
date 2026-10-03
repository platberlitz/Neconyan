import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertUntrackedRoleplayFiles, createRoleplayDirectory, readRoleplayFile, roleplayAccountBase, roleplayAccountStamp, roleplayError, roleplayHash, roleplayLease, withRoleplayAccount } from './roleplay-store.js';
import { fsyncDirectorySync, tryWriteFileSync, withDirectoryFlushBatchSync } from './util.js';

export const AUTHORING_FILE_LIMIT = 32 * 1024 * 1024;
export const authoringEvidence = file => file ? { rawHash: file.rawHash, physical: file.physical } : null;

function ownedPath(lease, filename) {
    const { scope } = roleplayLease(lease);
    const root = path.resolve(scope.directories.root);
    const target = path.resolve(filename);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw roleplayError('AUTHORING_PATH_INVALID', 'The authoring file is outside the account.', 409);
    assertUntrackedRoleplayFiles(lease, [target]);
    return { root, target, relative };
}

export function readAuthoringFileLocked(lease, filename, limit = AUTHORING_FILE_LIMIT) {
    return readRoleplayFile(ownedPath(lease, filename).target, limit, { allowMissingParent: true });
}

export function assertAuthoringEvidence(lease, filename, expected, limit = AUTHORING_FILE_LIMIT) {
    const file = readAuthoringFileLocked(lease, filename, limit);
    if (roleplayHash(authoringEvidence(file)) !== roleplayHash(expected)) throw roleplayError('AUTHORING_SOURCE_CHANGED', 'The authoring file changed after it was selected.', 409);
    return file;
}

/** The caller saves this physical publication witness before making a durable tool change. */
export function stageAuthoringFileLocked(lease, filename, data, { expected, limit = AUTHORING_FILE_LIMIT } = {}) {
    const { root, target, relative } = ownedPath(lease, filename);
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    if (bytes.length > limit) throw roleplayError('AUTHORING_FILE_TOO_LARGE', 'The authoring file is too large.', 413);
    const before = expected === undefined ? authoringEvidence(readAuthoringFileLocked(lease, target, limit)) : expected;
    const existing = assertAuthoringEvidence(lease, target, before, limit);
    if (existing?.bytes.equals(bytes)) return { relative, before, after: before, temporary: null, limit };
    createRoleplayDirectory(path.dirname(target), root);
    const temporary = path.join(path.dirname(target), `.author-${randomUUID()}.tmp`);
    ownedPath(lease, temporary);
    tryWriteFileSync(temporary, bytes, {}, { expectedFileAbsent: true, durable: true });
    // tryWriteFileSync already flushed these exact bytes. Keep the physical/content proof.
    const prepared = readRoleplayFile(temporary, limit);
    if (!prepared?.bytes.equals(bytes)) throw roleplayError('AUTHORING_RECOVERY_REQUIRED', 'The prepared authoring file could not be verified.', 409);
    return { relative, before, after: authoringEvidence(prepared), temporary: path.relative(root, temporary), limit };
}

export function publishAuthoringFileLocked(lease, staged) {
    if (!staged || !Number.isSafeInteger(staged.limit) || staged.limit < 0 || staged.limit > AUTHORING_FILE_LIMIT) throw roleplayError('AUTHORING_RECOVERY_REQUIRED', 'The prepared authoring file is invalid.', 409);
    const { scope } = roleplayLease(lease);
    const root = path.resolve(scope.directories.root);
    const target = ownedPath(lease, path.join(root, staged.relative)).target;
    const current = readAuthoringFileLocked(lease, target, staged.limit);
    if (roleplayHash(authoringEvidence(current)) === roleplayHash(staged.after)) return current;
    assertAuthoringEvidence(lease, target, staged.before, staged.limit);
    if (!staged.temporary) throw roleplayError('AUTHORING_RECOVERY_REQUIRED', 'The prepared authoring file is missing.', 409);
    const temporary = ownedPath(lease, path.join(root, staged.temporary)).target;
    if (path.dirname(temporary) !== path.dirname(target) || !/^\.author-[a-f0-9-]+\.tmp$/.test(path.basename(temporary))) throw roleplayError('AUTHORING_RECOVERY_REQUIRED', 'The prepared authoring path is invalid.', 409);
    assertAuthoringEvidence(lease, temporary, staged.after, staged.limit);
    fs.renameSync(temporary, target);
    fsyncDirectorySync(path.dirname(target));
    return assertAuthoringEvidence(lease, target, staged.after, staged.limit);
}

export function writeAuthoringFileLocked(lease, filename, data, options = {}) {
    const staged = stageAuthoringFileLocked(lease, filename, data, options);
    let published = false;
    try {
        options.beforePublish?.(staged);
        const result = publishAuthoringFileLocked(lease, staged);
        published = true;
        return result;
    } finally {
        if (!published && staged.temporary) {
            const { scope } = roleplayLease(lease);
            const filename = path.join(scope.directories.root, staged.temporary);
            const file = readAuthoringFileLocked(lease, filename, staged.limit);
            if (file && roleplayHash(authoringEvidence(file)) === roleplayHash(staged.after)) {
                fs.unlinkSync(filename);
                fsyncDirectorySync(path.dirname(filename));
            }
        }
    }
}

/** The operation's durable recovery plan must be saved before entering this batch. */
export function withAuthoringBatchLocked(lease, operation) {
    roleplayLease(lease);
    return withDirectoryFlushBatchSync(operation);
}

/** Replays folder durability when a previous batch stopped before its progress was flushed. */
export function flushAuthoringPathLocked(lease, filename) {
    const { root, target } = ownedPath(lease, filename);
    createRoleplayDirectory(path.dirname(target), root);
    fsyncDirectorySync(path.dirname(target));
}

export function deleteAuthoringFileLocked(lease, filename, expected) {
    const { target } = ownedPath(lease, filename);
    const file = expected === undefined ? readAuthoringFileLocked(lease, target) : assertAuthoringEvidence(lease, target, expected);
    if (!file) return false;
    fs.unlinkSync(target);
    fsyncDirectorySync(path.dirname(target));
    return true;
}

export function authoringRoute(handler) {
    return (request, response) => {
        try {
            const base = roleplayAccountBase(request.user?.directories);
            if (!base || base.owner !== request.user?.profile?.handle) throw roleplayError('AUTHORING_ACCOUNT_CHANGED', 'The authoring account is unavailable.', 409);
            const expectedOwner = request.get?.('X-Neconyan-Account');
            if (expectedOwner && expectedOwner !== base.owner) throw roleplayError('AUTHORING_ACCOUNT_CHANGED', 'The authoring account changed.', 409);
            return withRoleplayAccount(base, roleplayAccountStamp(base), lease => handler(request, response, lease));
        } catch (error) {
            if (response.headersSent) throw error;
            return response.sendStatus(error.status || 500);
        }
    };
}
