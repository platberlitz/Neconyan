import path from 'node:path';
import { createHash } from 'node:crypto';
import { getJob, jobKey } from './store.js';
import { readArtifact, writeArtifact } from './artifacts.js';
import { createRoleplayDirectory, readRoleplayFile, roleplayError } from '../roleplay-store.js';
import { tryWriteFileSync } from '../util.js';

const MAX_BYTES = 25 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => roleplayError('MEDIA_ARTIFACT_RECOVERY', 'The saved media bytes need recovery.', 503);

function filename(directories, id, name) {
    if (!getJob(directories, id)) throw fail();
    return path.join(directories.root, 'jobs', 'artifacts', jobKey(id), `${jobKey(name)}.data`);
}

/** The caller holds the account lock. A small receipt owns an immutable bounded binary input. */
export function writeBinaryArtifact(directories, id, name, bytes) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) throw fail();
    const target = filename(directories, id, name);
    const value = { binaryArtifact: 1, byteLength: bytes.length, digest: digest(bytes) };
    const previous = readArtifact(directories, id, name);
    if (previous !== undefined && (previous.binaryArtifact !== 1 || previous.byteLength !== value.byteLength || previous.digest !== value.digest)) throw fail();
    createRoleplayDirectory(path.dirname(target), directories.root);
    const current = readRoleplayFile(target, MAX_BYTES);
    if (current && (current.bytes.length !== bytes.length || current.rawHash !== value.digest)) throw fail();
    if (!current) tryWriteFileSync(target, bytes, { mode: 0o600 }, { expectedFileAbsent: true, durable: true });
    const saved = readRoleplayFile(target, MAX_BYTES, { flush: true });
    if (!saved || saved.rawHash !== value.digest) throw fail();
    if (previous === undefined) writeArtifact(directories, id, name, value);
    return bytes;
}

export function readBinaryArtifact(directories, id, name) {
    const value = readArtifact(directories, id, name);
    if (value === undefined) return undefined;
    if (value?.binaryArtifact !== 1 || !Number.isSafeInteger(value.byteLength) || value.byteLength < 1
        || value.byteLength > MAX_BYTES || !/^[a-f0-9]{64}$/.test(value.digest)) throw fail();
    const file = readRoleplayFile(filename(directories, id, name), MAX_BYTES, { allowMissingParent: true });
    if (!file || file.bytes.length !== value.byteLength || file.rawHash !== value.digest) throw fail();
    return file.bytes;
}
