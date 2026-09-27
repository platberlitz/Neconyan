import path from 'node:path';
import { authoringEvidence, readAuthoringFileLocked, stageAuthoringFileLocked, publishAuthoringFileLocked } from '../authoring-store.js';
import { roleplayHash, roleplayLease } from '../roleplay-store.js';
import { operationError, withOperation } from './store.js';

/** Publish a captured, untracked account file with a permanent physical acknowledgement. */
export function publishAccountFile(context, plan, { afterFilePublication } = {}) {
    return withOperation(context, ({ lease, value, save }) => {
        const filename = path.join(roleplayLease(lease).scope.directories.root, plan.relative);
        if (!value.effects.file) {
            context.signal.throwIfAborted();
            const current = readAuthoringFileLocked(lease, filename, plan.limit);
            if (roleplayHash(authoringEvidence(current)) !== roleplayHash(plan.evidence)) {
                throw Object.assign(operationError('This saved file changed. Reload it before reviewing another change.'), { operationRefused: true });
            }
            const staged = stageAuthoringFileLocked(lease, filename, Buffer.from(plan.text, 'utf8'), { expected: plan.evidence, limit: plan.limit });
            value.effects.file = { state: 'prepared', staged };
            value.fileResult = { ...plan.result, revision: roleplayHash(staged.after) };
            save();
        }
        if (value.effects.file.state !== 'done') {
            publishAuthoringFileLocked(lease, value.effects.file.staged);
            afterFilePublication?.(value.effects.file.staged);
            value.effects.file.state = 'done'; save();
        }
        return value.fileResult;
    });
}
