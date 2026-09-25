import path from 'node:path';
import { createHash } from 'node:crypto';
import { tryWriteFileSync } from '../util.js';
import { createRoleplayDirectory, readRoleplayFile, roleplayError, roleplayHash,
    withRoleplayAccount } from '../roleplay-store.js';
import { jobKey } from '../jobs/store.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';

const MAX_RECORDS_BYTES = 65 * 1024 * 1024;
const RECEIPT = 'roleplay-workflow-records';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => roleplayError('ROLEPLAY_WORKFLOW_RECOVERY', 'The saved workflow chat result needs recovery.', 503);

function key(speakerIndex) {
    if (speakerIndex === null) return RECEIPT;
    if (!Number.isSafeInteger(speakerIndex) || speakerIndex < 0 || speakerIndex > 63) throw fail();
    return `${RECEIPT}:${speakerIndex}`;
}

function location(directories, id, name) {
    return path.join(directories.root, 'jobs', 'artifacts', jobKey(id), `${jobKey(name)}.records`);
}

/** Full chat bytes live in a physically protected account file, not a limited JSON job status. */
export function writeRoleplayWorkflowRecords(context, account, records, speakerIndex = null) {
    const bytes = Buffer.from(JSON.stringify(records));
    if (!Array.isArray(records) || bytes.length > MAX_RECORDS_BYTES) throw roleplayError('ROLEPLAY_WORKFLOW_CAPACITY',
        'The complete saved workflow chat exceeds the protected result capacity.', 507);
    const base = { owner: context.owner, directories: context.directories };
    return withRoleplayAccount(base, account, () => {
        const nameKey = key(speakerIndex);
        const name = location(context.directories, context.job.id, nameKey);
        const old = readArtifact(context.directories, context.job.id, nameKey);
        const current = readRoleplayFile(name, MAX_RECORDS_BYTES, { allowMissingParent: true });
        const proof = { version: 1, account, byteLength: bytes.length, digest: digest(bytes), recordsHash: roleplayHash(JSON.parse(bytes)) };
        if (old !== undefined && (roleplayHash(old) !== roleplayHash(proof) || !current)) throw fail();
        if (current && (current.rawHash !== proof.digest || current.bytes.length !== proof.byteLength)) throw fail();
        if (!current) {
            createRoleplayDirectory(path.dirname(name), context.directories.root);
            tryWriteFileSync(name, bytes, { mode: 0o600 }, { expectedFileAbsent: true, durable: true, preserveOnCreateError: true });
            const written = readRoleplayFile(name, MAX_RECORDS_BYTES);
            if (written?.rawHash !== proof.digest) throw fail();
        }
        if (old === undefined) writeArtifact(context.directories, context.job.id, nameKey, proof);
        return proof;
    });
}

export function readRoleplayWorkflowRecords(context, account, speakerIndex = null) {
    const base = { owner: context.owner, directories: context.directories };
    return withRoleplayAccount(base, account, () => {
        const nameKey = key(speakerIndex);
        const receipt = readArtifact(context.directories, context.job.id, nameKey);
        if (!receipt || receipt.version !== 1 || roleplayHash(receipt.account) !== roleplayHash(account)
            || !Number.isSafeInteger(receipt.byteLength) || receipt.byteLength < 2 || receipt.byteLength > MAX_RECORDS_BYTES
            || !/^[a-f0-9]{64}$/.test(receipt.digest)) throw fail();
        const saved = readRoleplayFile(location(context.directories, context.job.id, nameKey), MAX_RECORDS_BYTES);
        if (!saved || saved.bytes.length !== receipt.byteLength || saved.rawHash !== receipt.digest) throw fail();
        let records;
        try { records = JSON.parse(saved.bytes.toString('utf8')); } catch { throw fail(); }
        if (!Array.isArray(records) || roleplayHash(records) !== receipt.recordsHash) throw fail();
        return { records, proof: receipt };
    });
}
