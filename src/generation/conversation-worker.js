import { listJobs } from '../jobs/store.js';
import { finalizeConversationSubmission } from './conversation-jobs.js';

const DEFAULT_INTERVAL_MS = 1000;

/**
 * Close Conversation submission batches whose coalescing window has passed, and
 * repair any paused job left behind by a crash. The runner only dispatches
 * `queued` jobs, so a paused job is invisible to it until it is finalised here.
 */
export async function runConversationWorkerTick({ directoriesFor, owners, now = Date.now() }) {
    for (const owner of owners) {
        let directories;
        try {
            directories = directoriesFor(owner);
        } catch {
            continue;
        }
        let jobs;
        try {
            jobs = listJobs(directories, { owner, includeDismissed: true });
        } catch {
            continue;
        }
        for (const job of jobs) {
            if (job.type !== 'conversation.reply' || job.state !== 'waiting' || job.stage !== 'preparing') continue;
            if (job.cancellation?.requested) continue;
            if (Number(job.coalesce?.deadline) > now) continue;
            try {
                await finalizeConversationSubmission({ user: { profile: { handle: owner }, directories } }, job);
            } catch (error) {
                console.error(`[Conversation] Could not prepare job ${job.id}:`, error?.message ?? error);
            }
        }
    }
}

/** Start the reconciler. Returns a stop function. */
export function startConversationWorker({ directoriesFor, owners, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    const list = typeof owners === 'function' ? owners : () => owners || [];
    const tick = () => runConversationWorkerTick({ directoriesFor, owners: list() }).catch(error => console.error('[Conversation] Scan failed:', error));
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    void tick();
    return () => clearInterval(timer);
}

export const testExports = { runConversationWorkerTick };
