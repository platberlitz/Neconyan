import path from 'node:path';
import { readRoleplayFile, withRoleplayAccount } from '../roleplay-store.js';
import { authoringEvidence } from '../authoring-store.js';
import { isCanonicalChatBackupName } from '../endpoints/backups.js';
import { publishFileDeletions } from './file-deletion.js';
import { MAINTENANCE_FILE_LIMIT } from './maintenance-scan.js';
import { registerOperation } from './jobs.js';
import { operationError } from './store.js';

/** Freezes the exact backup files the user confirmed so later backups with other contents are never removed. */
export function captureBackupDeletion(base, account, input) {
    const names = input?.names;
    if (!Array.isArray(names) || !names.length || names.length > 100000 || new Set(names).size !== names.length
        || !names.every(isCanonicalChatBackupName)) throw operationError('Choose distinct chat backups to delete.', 400);
    return withRoleplayAccount(base, account, () => {
        const root = path.resolve(base.directories.root);
        const files = names.map(name => {
            const filename = path.resolve(base.directories.backups, name);
            if (!filename.startsWith(root + path.sep)) throw operationError('Chat backups must be inside this account.', 400);
            const file = readRoleplayFile(filename, MAINTENANCE_FILE_LIMIT);
            if (!file) throw operationError(`The backup '${name}' no longer exists.`, 404);
            return { relative: path.relative(root, filename), evidence: authoringEvidence(file) };
        });
        return { files, names };
    });
}

registerOperation('chat-backup-delete', { label: 'Delete chat backups', capture: captureBackupDeletion,
    target: () => ({ kind: 'chat-backups', id: 'account' }), canRecover: value => value.deletionsReady === true,
    run: (context, plan, dependencies) => publishFileDeletions(context, plan.files, { removed: plan.names.length, names: plan.names }, dependencies) });
