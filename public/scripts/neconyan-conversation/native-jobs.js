/**
 * Observe server-owned Conversation jobs without re-running their work.
 *
 * The browser accepted a submission; the server appends the user messages and,
 * later, the reply bubbles. Observation only polls the job ledger and reads the
 * authoritative store back, then repaints. It never calls a generation or
 * delivery function, so a reload or a second tab cannot execute a reply twice.
 */
import { cancelJob, listJobs, observeJob } from '../jobs.js';
import { scheduleInterfaceRefresh } from './render-scheduler.js';
import { refreshConversationStore } from './store-sync.js';

const observed = new Map();
let refreshing = false;
let refreshQueued = false;

async function readback() {
    if (refreshing) {
        refreshQueued = true;
        return;
    }
    refreshing = true;
    try {
        do {
            refreshQueued = false;
            const result = await refreshConversationStore();
            // A conflicting merge means the authoritative read did not settle;
            // throw so the observer backs off and retries rather than stopping
            // on a terminal job with messages still missing.
            if (result?.conflict) {
                throw new Error('Conversation store merge conflict.');
            }
            scheduleInterfaceRefresh({ syncControls: false });
        } while (refreshQueued);
    } finally {
        refreshing = false;
    }
}

/** Watch a native root job and merge its saved messages as they appear. */
export function observeNativeConversationJob(jobId) {
    if (!jobId || observed.has(jobId)) {
        return;
    }
    const stop = observeJob(jobId, {
        onUpdate: () => readback(),
        onSnapshot: () => readback(),
        // Drop the registry entry once polling really stops, so a retried job
        // that reuses the id (or a later resume) can be observed again.
        onDone: () => { observed.delete(jobId); },
    });
    observed.set(jobId, () => {
        stop();
        observed.delete(jobId);
    });
}

export function stopNativeConversationObservation() {
    for (const stop of [...observed.values()]) {
        stop();
    }
    observed.clear();
}

export function isObservingConversationJob(jobId) {
    return observed.has(jobId);
}

/** Reattach to native roots accepted before the page loaded or on another tab. */
export async function resumeNativeConversationObservation() {
    let jobs = [];
    try {
        jobs = await listJobs({ includeDismissed: false });
    } catch {
        return;
    }
    for (const job of jobs) {
        if (job?.type === 'conversation.reply' && !job.parentId) {
            observeNativeConversationJob(job.id);
        }
    }
}

/** Ask the server to cancel one job family; committed messages are preserved. */
export async function cancelNativeConversationJob(jobId) {
    await cancelJob(jobId, { reason: 'Cancelled from Conversation Mode.' });
    observed.get(jobId)?.();
}
