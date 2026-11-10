import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRoleplayDirectory, readRoleplayFile, roleplayHash, roleplayStoreDirectory, withRoleplayAccount } from '../roleplay-store.js';
import { tryWriteFileSync } from '../util.js';
import { fail, json, METHODS, CATEGORIES, LIMITS } from './protocol.js';

const STATE_LIMIT = 160 * 1024 * 1024;
export const accountKey = base => roleplayHash([base.owner, base.directories.root]);

/** Sibling storage is not a user backup/settings/export source. All access holds the account lease. */
export function withSync(base, account, operation) {
    return withRoleplayAccount(base, account, (lease, stamp) => {
        const protectedRoot = roleplayStoreDirectory(base);
        const dataRoot = path.dirname(path.dirname(protectedRoot));
        const root = path.join(dataRoot, '_device-sync', path.basename(protectedRoot));
        createRoleplayDirectory(root, dataRoot);
        const filename = path.join(root, roleplayHash(stamp) + '.json');
        const stored = readRoleplayFile(filename, STATE_LIMIT, { allowMissingParent: true });
        const state = stored ? json(stored.bytes) : { version: 1, deviceId: randomUUID(), sequence: 0, revision: 0,
            categories: [...CATEGORIES], methods: Object.fromEntries(METHODS.map(method => [method, { enabled: false }])),
            targets: {}, conflicts: {}, grants: {}, journal: null, lastResult: null };
        if (state.version !== 1) throw fail('Device sync storage needs recovery.', 409);
        const save = () => {
            const bytes = Buffer.from(JSON.stringify(state));
            if (bytes.length > STATE_LIMIT) throw fail('Device sync recovery storage is full. Download and remove resolved preserved copies before importing more data.', 413);
            tryWriteFileSync(filename, bytes, { mode: 0o600 }, { durable: true, maxFileBytes: STATE_LIMIT });
        };
        if (!stored) save();
        return operation({ lease, state, save, stamp });
    });
}

export function requireMethod(state, method, revision) {
    if (!METHODS.includes(method) || state.methods[method].enabled !== true) throw fail('This sync method is switched off.', 409);
    if (revision !== undefined && state.revision !== revision) throw fail('Sync settings changed. The operation was stopped; start it again.', 409);
}

export function publicState(state) {
    return { categories: state.categories, methods: Object.fromEntries(METHODS.map(method => {
        const value = state.methods[method];
        return [method, { enabled: value.enabled, configured: Boolean(method === 'file' || method === 'webdav' && value.url || method === 'gist' && value.token || method === 'pairing' && value.peer),
            ...(method === 'gist' && value.gistId ? { gistId: value.gistId } : {}) }];
    })), hasPassphrase: Boolean(state.passphrase), lastResult: state.lastResult, recoveryPending: Boolean(state.journal),
    grants: Object.entries(state.grants).map(([id, grant]) => ({ id, expires: grant.expires })),
    conflicts: Object.entries(state.conflicts).map(([id, conflict]) => ({ id, path: conflict.remote.path, category: conflict.remote.category,
        localHash: conflict.local?.hash ?? null, incomingHash: conflict.remote.hash, method: conflict.method, resolved: conflict.resolved === true, superseded: conflict.superseded === true })), limits: LIMITS };
}
