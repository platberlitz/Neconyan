import fs from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import { readRoleplayFile, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { authoringEvidence, assertAuthoringEvidence } from '../authoring-store.js';
import { registerOperation } from './jobs.js';
import { operationError, withOperation } from './store.js';

function inventory(root, selected) {
    const result = [];
    const walk = (directory, depth = 0) => {
        readRoleplayFile(path.join(directory, '.path-check'), 1, { allowMissingParent: true });
        if (!fs.existsSync(directory)) return;
        if (depth > 4) throw operationError('The vector folder contains an unsupported nested directory.');
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (depth === 1 && selected && !selected.has(entry.name)) continue;
            const filename = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(filename, depth + 1);
            else {
                const file = readRoleplayFile(filename, 32 * 1024 * 1024);
                if (!file) throw operationError('The vector files changed while preparing their deletion.');
                result.push({ relative: path.relative(root, filename), evidence: authoringEvidence(file) });
                if (result.length > 100000) throw operationError('This vector deletion exceeds the saved file limit.', 413);
            }
        }
    };
    walk(root);
    return result;
}

export function captureVectorPurge(base, account, input) {
    const ids = input.collectionIds;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => typeof id !== 'string' || !id || id.length > 500 || !sanitize(id)))) {
        throw operationError('Choose valid vector collections to clear.', 400);
    }
    return withRoleplayAccount(base, account, () => ({ files: inventory(base.directories.vectors,
        ids === undefined ? null : new Set(ids.map(id => sanitize(id)))) }));
}

/** An explicit purge is bound to the exact old files, never to whatever later occupies their paths. */
export function runVectorPurge(context, plan, { afterVectorDeletion } = {}) {
    return withOperation(context, ({ lease, value, save, base }) => {
        if (!value.purgeReady) {
            context.signal.throwIfAborted();
            for (const item of plan.files) assertAuthoringEvidence(lease, path.join(base.directories.vectors, item.relative), item.evidence, 32 * 1024 * 1024);
            value.effects = Object.fromEntries(plan.files.map((item, index) => [`purge:${index}`, { ...item, state: 'prepared' }]));
            value.purgeReady = true; save();
        }
        for (const effect of Object.values(value.effects)) {
            if (effect.state === 'done') continue;
            const filename = path.join(base.directories.vectors, effect.relative);
            const current = readRoleplayFile(filename, 32 * 1024 * 1024, { allowMissingParent: true });
            if (current) {
                if (roleplayHash(authoringEvidence(current)) !== roleplayHash(effect.evidence)) throw operationError('A vector file was replaced. The newer file has been kept.');
                fs.unlinkSync(filename);
                const directory = fs.openSync(path.dirname(filename), fs.constants.O_RDONLY);
                try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
            }
            afterVectorDeletion?.(filename);
            effect.state = 'done'; save();
        }
        return { removed: plan.files.length };
    });
}

registerOperation('vector-purge', { label: 'Clear selected vector indexes', capture: captureVectorPurge, run: runVectorPurge,
    canRecover: value => value.purgeReady === true, target: () => ({ kind: 'vectors', id: 'account-vector-indexes' }) });
