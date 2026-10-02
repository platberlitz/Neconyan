import { getJob, providerRecoverySteps, TERMINAL_STATES } from '../jobs/store.js';
import { roleplayHash } from '../roleplay-store.js';
import { withNativeMediaReceipt } from './media-jobs.js';

/**
 * Release an earlier reply's claim on a chat once it can no longer run or write.
 * A stopped or failed workflow is only resumed by a deliberate retry, which
 * returns the closed receipt instead of writing. Pruned jobs were already finished.
 */
export function releaseStoppedRoleplayWorkflow({ owner, directories }) {
    return value => {
        if (value.state !== 'accepted' || Object.values(value.effects).some(effect => effect?.state !== 'done')) return null;
        const job = value.jobId ? getJob(directories, value.jobId) : null;
        if (job) {
            if (job.type !== 'media.roleplay-workflow' || job.owner !== owner || job.parentId
                || job.state === 'completed' || !TERMINAL_STATES.includes(job.state)) return null;
            for (const id of job.children ?? []) {
                const child = getJob(directories, id);
                if (child && !TERMINAL_STATES.includes(child.state)) return null;
            }
        } else if (!value.jobId) {
            return null;
        }
        return { stopped: true, chatChanged: Object.keys(value.effects).length > 0 };
    };
}

/** Release a stopped workflow only when none of its model work ever started. */
export function closeUnstartedRoleplayWorkflow({ owner, directories, job }) {
    if (job?.type !== 'media.roleplay-workflow' || job.owner !== owner || job.state !== 'cancelled'
        || !job.cancellation?.requested || !job.intent?.media || !job.intent.source) return false;
    return withNativeMediaReceipt({ owner, directories, job }, ({ value, save }) => {
        if (value.state === 'closed') return true;
        const current = getJob(directories, job.id);
        if (current.state !== 'cancelled' || !current.cancellation?.requested
            || Object.keys(value.effects).length || current.receipts?.length || providerRecoverySteps(current).length) return false;
        const children = current.children ?? [];
        // An unstarted root, or its first queued candidate, cannot have published
        // a reply or dispatched a provider. Later turns retain their recovery proof.
        if (children.length === 0 ? current.attempt !== 0
            : children.length !== 1 || current.stage !== 'children' || current.attempt !== 1) return false;
        for (const id of children) {
            const child = getJob(directories, id);
            if (!child || child.type !== 'roleplay.candidate' || child.parentId !== current.id || child.owner !== owner
                || child.state !== 'cancelled' || !child.cancellation?.requested || child.attempt !== 0 || child.startedAt
                || child.children?.length || child.receipts?.length || providerRecoverySteps(child).length
                || child.intent?.request?.workflowCandidate?.parentIntentHash !== roleplayHash(current.intent)) return false;
        }
        value.result = { cancelled: true, providerDispatched: false, chatChanged: false };
        value.state = 'closed';
        save();
        return true;
    }, { checkSource: false });
}
