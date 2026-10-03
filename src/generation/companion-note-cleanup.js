import { getCompanionResultStores, isSuppressedCompanionResult, planCompanionNoteCleanup } from '../../public/scripts/extensions/in-chat-agents/companion/companion-shared.js';

/** Remove only older copies belonging to successful, readable Companion runs. */
export function applyAutomaticCompanionNoteCleanup(messages, policy, results, protectedMessageIndex) {
    if (!policy || policy.enabled !== true) return;
    const agentIds = Object.entries(results ?? {}).filter(([id, result]) => result?.status === 'done'
        && !result.lastRunError && typeof result.content === 'string' && result.content.trim()
        && !isSuppressedCompanionResult(id, result)).map(([id]) => id);
    if (!agentIds.length) return;
    const plan = planCompanionNoteCleanup(messages, { agentIds, keepLatest: true,
        olderNotesToKeep: policy.olderNotesToKeep, protectedMessageIndex });
    for (const entry of plan.targets) {
        for (const store of getCompanionResultStores(messages[entry.messageIndex])) {
            for (const id of entry.agentIds) delete store[id];
        }
    }
}
