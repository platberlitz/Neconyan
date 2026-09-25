import { readArtifact } from '../jobs/artifacts.js';
import { roleplayError, roleplayHash } from '../roleplay-store.js';
import { preparePathfinderNotebookAction } from './pathfinder-notebook.js';

/** Apply only a previously admitted and durably prepared notebook change. */
export function applyPathfinderNotebookRecords(directories, job, records, output) {
    const invalid = () => roleplayError('PATHFINDER_NOTEBOOK_RECOVERY', 'The saved notebook change needs recovery.', 409);
    if (Object.keys(output ?? {}).length !== 1 || typeof output.notebookOutput !== 'string'
        || job.intent.request?.notebook?.action === 'read') throw invalid();
    const saved = readArtifact(directories, job.id, 'pathfinder-notebook-output');
    if (!saved || saved.hash !== output.notebookOutput || saved.identity !== roleplayHash(job.intent)
        || saved.recordsHash !== roleplayHash(records)) throw invalid();
    const { hash, ...values } = saved;
    if (hash !== roleplayHash(values)) throw invalid();
    const prepared = preparePathfinderNotebookAction(records, job.intent.request.notebook);
    if (!prepared.changed || prepared.afterHash !== saved.afterHash
        || prepared.afterHash !== job.intent.request.expectedAfterHash || prepared.result !== saved.result) throw invalid();
    return prepared.records;
}
