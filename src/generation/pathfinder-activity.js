import { listJobs } from '../jobs/store.js';
import { readArtifact } from '../jobs/artifacts.js';
import { withRoleplayAccount } from '../roleplay-store.js';

/** Read only this account's latest retrieval for the selected agent and chat. */
export function readPathfinderActivity(base, { agentId, locator } = {}) {
    if (!agentId || !locator?.chat || (!locator.group && !locator.avatar)) return null;
    for (const job of listJobs(base.directories, { owner: base.owner })) {
        const source = job.intent?.source?.locator;
        const snapshot = job.intent?.request?.worldInfo;
        if (snapshot?.pathfinder?.agentId !== agentId || !source
            || source.chat !== locator.chat || Boolean(source.group) !== Boolean(locator.group)
            || (!source.group && source.avatar !== locator.avatar)) continue;
        return withRoleplayAccount(base, job.intent.roleplay, () => {
            const result = readArtifact(base.directories, job.id, 'roleplay-pathfinder');
            const completed = Boolean(result);
            return {
                type: 'pathfinder_retrieval_detail', timestamp: job.updatedAt ?? job.createdAt,
                mode: result?.mode === 'sidecar' ? 'tool-retrieval' : 'pipeline',
                books: snapshot.pathfinder.books ?? [],
                selectedEntries: (result?.selected ?? []).map(([bookName, uid]) => ({ bookName, uid, name: `Entry ${uid}` })),
                stageResults: (result?.stageResults ?? []).map(stage => ({
                    ...stage, stageIndex: stage.index, success: !stage.failed,
                    entriesFound: stage.selected?.length ?? 0,
                })),
                injectedPrompt: result?.prompt?.content ?? '',
                metadata: { serverJobId: job.id, serverState: job.state, serverRetrievalCompleted: completed,
                    ...(!completed && { reason: 'No completed server retrieval yet.', error: job.error?.message || '' }) },
            };
        });
    }
    return null;
}
