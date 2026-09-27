import fs from 'node:fs';
import path from 'node:path';
import { assertUntrackedRoleplayFiles, readRoleplayFile, roleplayFileLocator, roleplayHash, roleplayLease } from '../roleplay-store.js';
import { commitRoleplayLifecycleLocked, roleplayTrackedInstance } from '../roleplay-lifecycle.js';
import { authoringEvidence } from '../authoring-store.js';
import { roleplayNativeHost } from '../endpoints/chats.js';
import { operationError, withOperation } from './store.js';
import { MAINTENANCE_FILE_LIMIT } from './maintenance-scan.js';

/** Prepared deletion records and native lifecycle receipts survive deletion of the user file itself. */
export function publishFileDeletions(context, files, result, { verify = () => {}, afterFileDeletion } = {}) {
    return withOperation(context, ({ lease, value, save }) => {
        const { scope } = roleplayLease(lease);
        if (!value.deletionsReady) {
            context.signal.throwIfAborted();
            verify(lease);
            for (const [index, file] of files.entries()) {
                const filename = path.resolve(scope.directories.root, file.relative);
                if (!filename.startsWith(path.resolve(scope.directories.root) + path.sep)) throw operationError('The reviewed file is outside this account.');
                const current = readRoleplayFile(filename, MAINTENANCE_FILE_LIMIT);
                if (!current || roleplayHash(authoringEvidence(current)) !== roleplayHash(file.evidence)) throw operationError('A reviewed file changed before deletion. Start a new scan.');
                const found = roleplayFileLocator(scope, filename);
                const tracked = found && roleplayTrackedInstance(lease, found.kind, found.locator);
                if (!tracked && found) assertUntrackedRoleplayFiles(lease, [filename]);
                value.effects[`delete:${index}`] = { state: 'prepared', relative: file.relative, evidence: file.evidence,
                    resource: tracked ? found : null, operationKey: `application:${context.job.id}:delete:${index}` };
            }
            value.deletionResult = result;
            value.deletionsReady = true;
            save();
        }
        for (const [name, effect] of Object.entries(value.effects)) {
            if (!name.startsWith('delete:') || effect.state === 'done') continue;
            if (effect.resource) {
                const { kind, locator } = effect.resource;
                const { state } = roleplayLease(lease);
                const keyHash = roleplayHash([state.accountId, 'lifecycle', effect.operationKey]);
                if (!state.submissions[keyHash] && state.pending?.operationKeyHash !== keyHash) {
                    const current = readRoleplayFile(path.join(scope.directories.root, effect.relative), MAINTENANCE_FILE_LIMIT);
                    if (!current || roleplayHash(authoringEvidence(current)) !== roleplayHash(effect.evidence)) throw operationError('A protected deletion target changed. Its later contents were kept.');
                }
                commitRoleplayLifecycleLocked(lease, { operationKey: effect.operationKey, action: 'application-delete',
                    intent: { relative: effect.relative, evidence: effect.evidence }, steps: [{ op: 'delete', kind, locator }],
                    auxiliary: kind === 'chat' ? [{ task: 'chat-memory-remove', locator }, { task: 'chat-recovery-clear', locator }] : [] }, roleplayNativeHost);
            } else {
                const filename = path.join(scope.directories.root, effect.relative);
                const current = readRoleplayFile(filename, MAINTENANCE_FILE_LIMIT);
                if (current) {
                    if (roleplayHash(authoringEvidence(current)) !== roleplayHash(effect.evidence)) throw operationError('A later file replaced a reviewed deletion target. The later file was kept.');
                    assertUntrackedRoleplayFiles(lease, [filename]);
                    fs.unlinkSync(filename);
                    const descriptor = fs.openSync(path.dirname(filename), 'r');
                    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
                }
            }
            afterFileDeletion?.(effect.relative);
            effect.state = 'done'; save();
        }
        return value.deletionResult;
    });
}
