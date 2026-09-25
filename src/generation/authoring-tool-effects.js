import path from 'node:path';
import { assertAuthoringEvidence, authoringEvidence, publishAuthoringFileLocked, readAuthoringFileLocked,
    stageAuthoringFileLocked } from '../authoring-store.js';
import { roleplayError, roleplayHash } from '../roleplay-store.js';
import { withNativeMediaReceipt } from './media-jobs.js';

const invalid = message => roleplayError('TOOL_EFFECT_RECOVERY', message, 409);

/** Save the prepared physical file witness before publishing an approved authoring change. */
export function publishNativeAuthoringFile(context, { relative, before, bytes, checkLocked, beforePublish } = {}) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0')
        || relative.split('/').some(part => !part || part === '.' || part === '..') || !Buffer.isBuffer(bytes)) {
        throw invalid('The accepted authoring file is invalid.');
    }
    const outputHash = roleplayHash(bytes.toString('base64'));
    return withNativeMediaReceipt(context, ({ lease, value, save, base }) => {
        const filename = path.join(base.directories.root, relative);
        const key = roleplayHash(['authoring', relative]);
        let effect = value.effects[key];
        if (effect && (effect.relative !== relative || effect.outputHash !== outputHash
            || roleplayHash(effect.before) !== roleplayHash(before))) {
            throw invalid('The authoring change differs from its saved intention.');
        }
        if (effect?.state === 'done') {
            assertAuthoringEvidence(lease, filename, effect.staged.after, effect.staged.limit);
            return effect.staged.after;
        }
        checkLocked?.(lease, value);
        if (!effect) {
            const staged = stageAuthoringFileLocked(lease, filename, bytes, { expected: before });
            effect = { relative, before, outputHash, staged, state: 'prepared' };
            value.effects[key] = effect;
            save();
        } else {
            const staged = effect.staged;
            const current = readAuthoringFileLocked(lease, filename, staged.limit);
            if (roleplayHash(authoringEvidence(current)) !== roleplayHash(staged.after)) {
                assertAuthoringEvidence(lease, filename, staged.before, staged.limit);
                if (!staged.temporary) throw invalid('The prepared authoring file is missing.');
                assertAuthoringEvidence(lease, path.join(base.directories.root, staged.temporary), staged.after, staged.limit);
            }
        }
        beforePublish?.(effect.staged);
        const published = publishAuthoringFileLocked(lease, effect.staged);
        if (roleplayHash(authoringEvidence(published)) !== roleplayHash(effect.staged.after)) throw invalid('The authoring change needs recovery.');
        effect.state = 'done';
        save();
        return effect.staged.after;
    });
}
