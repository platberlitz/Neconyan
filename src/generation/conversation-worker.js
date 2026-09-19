import { getJob, listJobs, updateJob } from '../jobs/store.js';
import { finalizeConversationSubmission } from './conversation-jobs.js';

const DEFAULT_INTERVAL_MS = 1000;
const TERMINAL_STATES = new Set(['completed', 'cancelled', 'failed', 'interrupted', 'conflict']);

/**
 * Close a Conversation family whose participants have all stopped. The root
 * records each participant's outcome; a failed participant never cancels a
 * healthy sibling, and an interrupted one needs an explicit retry.
 */
export function reconcileConversationJob(directories, job, { now } = {}) {
    if (!Number.isFinite(now) || now <= 0) now = Date.now();
    const children = (job.children || []).map(id => getJob(directories, id)).filter(Boolean);
    if (!children.length) return false;
    if (children.some(child => !TERMINAL_STATES.has(child.state))) return false;
    const participants = children.map(child => ({
        id: child.id, participant: child.intent?.participantKey || '',
        state: child.state, skipped: child.result?.skipped || null,
    }));
    let state = 'completed';
    if (job.cancellation?.requested) state = 'cancelled';
    else if (children.some(child => child.state === 'interrupted' || child.state === 'conflict')) state = 'interrupted';
    else if (children.some(child => child.state === 'failed')) state = 'failed';
    else if (children.some(child => child.state === 'cancelled')) state = 'cancelled';
    updateJob(directories, job.id, {
        state, stage: null, result: { participants }, progress: { completed: children.length, total: children.length },
        finishedAt: now, recoverability: state === 'completed' ? 'terminal' : 'needs-retry',
    });
    return true;
}

/**
 * Close Conversation submission batches whose coalescing window has passed,
 * repair any paused job left behind by a crash, and finalise a family whose
 * participants have all finished. The runner only dispatches `queued` jobs, so
 * a paused job is invisible to it until it is finalised here.
 */
export async function runConversationWorkerTick({ directoriesFor, owners, now = Date.now() }) {
    const ownerList = typeof owners === 'function' ? await owners() : owners;
    if (!Array.isArray(ownerList)) return;
    for (const owner of ownerList) {
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
            if (job.type !== 'conversation.reply') continue;
            try {
                if (job.stage === 'preparing' && job.state === 'waiting' && !job.cancellation?.requested && !(Number(job.coalesce?.deadline) > now)) {
                    await finalizeConversationSubmission({ user: { profile: { handle: owner }, directories } }, job);
                } else if (job.stage === 'children' && !job.result) {
                    // A cancelled root is terminal but still needs its aggregate.
                    reconcileConversationJob(directories, job, { now });
                }
            } catch (error) {
                console.error(`[Conversation] Could not reconcile job ${job.id}:`, error?.message ?? error);
            }
        }
    }
}

/** Start the reconciler. Returns a stop function. Overlapping ticks are skipped. */
export function startConversationWorker({ directoriesFor, owners, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    const list = async () => (typeof owners === 'function' ? await owners() : owners || []);
    let ticking = false;
    const tick = async () => {
        if (ticking) return;
        ticking = true;
        try {
            await runConversationWorkerTick({ directoriesFor, owners: await list(), now: Date.now() });
        } catch (error) {
            console.error('[Conversation] Scan failed:', error);
        } finally {
            ticking = false;
        }
    };
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    void tick();
    return () => clearInterval(timer);
}

export const testExports = { runConversationWorkerTick, reconcileConversationJob };
