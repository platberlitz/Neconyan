import fs from 'node:fs';
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
        // File contents live in a sibling keyed by content hash, so the many
        // small journal checkpoints do not rewrite every pending payload.
        const contentFile = path.join(root, roleplayHash(stamp) + '.content.json');
        const storedContent = readRoleplayFile(contentFile, STATE_LIMIT, { allowMissingParent: true });
        let content = new Map(Object.entries(storedContent ? json(storedContent.bytes) : {}));
        let contentBytes = storedContent?.bytes.length ?? 0;
        const holders = () => [...(state.journal?.items ?? []), ...Object.values(state.conflicts)]
            .flatMap(item => [item.local, item.remote, ...(item.companions?.local ?? []), ...(item.companions?.remote ?? [])]).filter(Boolean);
        for (const item of holders()) {
            if (item.data !== undefined) continue;
            if (typeof content.get(item.hash) !== 'string') throw fail('Device sync storage needs recovery.', 409);
            item.data = content.get(item.hash);
        }
        const writeContent = (next, bytes) => {
            if (next.size) tryWriteFileSync(contentFile, bytes, { mode: 0o600 }, { durable: true, maxFileBytes: STATE_LIMIT });
            else fs.rmSync(contentFile, { force: true });
            content = next; contentBytes = next.size ? bytes.length : 0;
        };
        const encode = map => Buffer.from(JSON.stringify(Object.fromEntries(map)));
        const save = () => {
            const items = new Set(holders());
            const needed = new Map([...items].map(item => [item.hash, item.data]));
            const bytes = Buffer.from(JSON.stringify(state, function (key, value) { return key === 'data' && items.has(this) ? undefined : value; }));
            const added = [...needed.keys()].some(key => !content.has(key));
            // New contents are durable before the state that refers to them;
            // unused contents are dropped only after the state stops referring to them.
            const union = added ? new Map([...content, ...needed]) : content;
            const unionBytes = added ? encode(union) : null;
            if (bytes.length + (unionBytes?.length ?? contentBytes) > STATE_LIMIT) throw fail('Device sync recovery storage is full. Download and remove resolved preserved copies before importing more data.', 413);
            if (added) writeContent(union, unionBytes);
            tryWriteFileSync(filename, bytes, { mode: 0o600 }, { durable: true, maxFileBytes: STATE_LIMIT });
            if (content.size > needed.size) writeContent(needed, encode(needed));
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
    grants: Object.entries(state.grants).filter(([, grant]) => grant.expires > Date.now()).map(([id, grant]) => ({ id, expires: grant.expires })),
    conflicts: Object.entries(state.conflicts).map(([id, conflict]) => ({ id, path: conflict.remote.path, category: conflict.remote.category,
        localHash: conflict.local?.hash ?? null, incomingHash: conflict.remote.hash, method: conflict.method, resolved: conflict.resolved === true, superseded: conflict.superseded === true })), limits: LIMITS };
}
