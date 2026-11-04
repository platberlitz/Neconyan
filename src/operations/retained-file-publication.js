import fs from 'node:fs';
import path from 'node:path';
import { types } from 'node:util';
import { roleplayHash, withRoleplayFileHandle } from '../roleplay-store.js';
import { fsyncDirectorySync } from '../util.js';
import { operationError } from './store.js';

const evidence = file => ({ rawHash: file.rawHash, physical: file.physical });
const same = (left, right) => roleplayHash(left) === roleplayHash(right);

/** Keep the original descriptor open while recording exFAT's post-rename file ID. */
export function publishRetainedFile(temporary, destination, expected, size, checkpoint, { flushDirectory = true } = {}) {
    if (typeof checkpoint !== 'function' || types.isAsyncFunction(checkpoint) || types.isGeneratorFunction(checkpoint)) {
        throw operationError('File publication needs a synchronous evidence checkpoint.');
    }
    return withRoleplayFileHandle(temporary, size, (prepared, readAt) => {
        if (prepared.size !== size || !same(evidence(prepared), expected)) throw operationError('The prepared file changed before publication.');
        fs.renameSync(temporary, destination);
        const verify = () => {
            // readAt compares the destination with this still-open descriptor. Only
            // a live rename may change the file ID; saved/replayed evidence stays exact.
            const held = readAt(destination);
            if (held.size !== size || held.rawHash !== prepared.rawHash || held.physical.dev !== prepared.physical.dev
                || held.physical.birthtimeNs !== prepared.physical.birthtimeNs) throw operationError('The published file changed during its rename.');
            return held;
        };
        const published = verify();
        const finalEvidence = evidence(published);
        const changed = !same(finalEvidence, expected);
        if (flushDirectory || changed) fsyncDirectorySync(path.dirname(destination));
        if (changed) {
            const result = checkpoint(finalEvidence);
            if (result && typeof result.then === 'function') {
                Promise.resolve(result).catch(() => {});
                throw operationError('File publication evidence checkpoints must be synchronous.');
            }
            if (!same(evidence(verify()), finalEvidence)) throw operationError('The published file changed during checkpointing.');
        }
        return published;
    }, { flush: false });
}
