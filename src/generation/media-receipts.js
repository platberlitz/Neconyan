import fs from 'node:fs';
import path from 'node:path';
import { readRoleplayFile, roleplayError, roleplayHash, roleplayLease, roleplayStoreDirectory } from '../roleplay-store.js';
import { assertLabsTargetIdle } from '../labs/store.js';
import { assertOperationTargetIdle } from '../operations/store.js';

// Keep cooperating storage writers independent of provider and prompt modules.
export const MEDIA_RECEIPT_LIMIT = 512 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const fail = (message, code = 'MEDIA_RECOVERY_REQUIRED') => roleplayError(code, message);

export function readMediaReceipt(filename) {
    const file = readRoleplayFile(filename, MEDIA_RECEIPT_LIMIT, { allowMissingParent: true });
    if (!file) return { file: null, value: null };
    let value;
    try { value = JSON.parse(file.bytes.toString('utf8')); } catch { throw fail('The saved media receipt is unreadable.'); }
    if (value?.version !== 1 || !HASH.test(value.intentHash) || !HASH.test(value.targetHash)
        || !['preparing', 'accepted', 'closed'].includes(value.state)
        || !value.account || typeof value.effects !== 'object' || !value.effects || Array.isArray(value.effects)
        || value.state !== 'preparing' && typeof value.jobId !== 'string') {
        throw fail('The saved media receipt is invalid.');
    }
    return { file, value };
}

/** An ordinary cooperating writer cannot replace an accepted native media target. */
export function assertNativeMediaTargetIdle(lease, target) {
    assertLabsTargetIdle(lease, target);
    assertOperationTargetIdle(lease, target);
    const { scope } = roleplayLease(lease);
    const directory = path.join(roleplayStoreDirectory(scope), 'media');
    readRoleplayFile(path.join(directory, '.media-path-check'), 1, { allowMissingParent: true });
    if (!fs.existsSync(directory)) return;
    const hash = roleplayHash([scope.accountId, scope.dataEpoch, target]);
    for (const name of fs.readdirSync(directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const { value } = readMediaReceipt(path.join(directory, name));
        if (!value) throw fail('A saved media receipt disappeared.');
        if (value.targetHash === hash && value.state !== 'closed') throw fail('This media target has unfinished accepted work.', 'MEDIA_TARGET_BUSY');
    }
}
