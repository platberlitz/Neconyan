/**
 * Observe server-owned Conversation jobs without re-running their work.
 *
 * The browser accepted a submission; the server appends the user messages and,
 * later, the reply bubbles. Observation only polls the job ledger and reads the
 * authoritative store back, then repaints. It never calls a generation or
 * delivery function, so a reload or a second tab cannot execute a reply twice.
 */
import { cancelJob, listJobs, observeJob, TERMINAL } from '../jobs.js';
import { getCurrentUserHandle } from '../user.js';
import { presentPendingConversationClaims } from './presentation.js';
import { scheduleInterfaceRefresh } from './render-scheduler.js';
import { refreshConversationStore } from './store-sync.js';

const observed = new Map();
const readbacks = new Map();
const retries = new Map();
// Counts the account's in-flight job lists. Until one resolves the browser
// cannot know a native job exists, so callers must treat observation as active.
let syncCount = 0;
// A pruned job must merge the saved store before the fence can drop, so retry
// until the readback succeeds: releasing on stale history lets a duplicate
// chime start. store-sync aborts its own stalled requests, so a retry always
// gets to run and this needs no separate timeout.
const PRUNED_REFRESH_RETRY_MS = 5000;
function readback(account) {
    const pending = readbacks.get(account);
    if (pending) {
        pending.again = true;
        return pending.promise;
    }
    const entry = { again: false, promise: null };
    entry.promise = (async () => {
        let changed = false;
        do {
            entry.again = false;
            const result = await refreshConversationStore(account);
            if (account !== getCurrentUserHandle()) throw new Error('account_changed');
            // Throw so a terminal job keeps polling until its readback succeeds.
            if (result?.conflict) throw new Error('Conversation store merge conflict.');
            changed ||= result?.changed === true;
        } while (entry.again);
        // Present after each successful merge so a closed workspace still badges,
        // and a reopened one narrates. Never await: playback must not pin polling.
        void presentPendingConversationClaims(account);
        if (changed) scheduleInterfaceRefresh({ syncControls: false });
    })().finally(() => readbacks.delete(account));
    readbacks.set(account, entry);
    return entry.promise;
}

// Keep the observation entry (and the chime fence) until the pruned job's saved
// store has actually been merged. Retries cover a transient failure. ponytail:
// while the server cannot answer, browser chimes wait rather than risk a
// duplicate paid generation; removing the browser worker in the ownership stage
// deletes this fence entirely.
function refreshBeforeRelease(jobId, account) {
    const clearRetry = () => {
        clearTimeout(retries.get(jobId));
        retries.delete(jobId);
    };
    const attempt = () => {
        if (!observed.has(jobId)) {
            clearRetry();
            return;
        }
        readback(account).then(
            () => {
                clearRetry();
                observed.delete(jobId);
            },
            error => {
                clearRetry();
                if (error?.message === 'account_changed') {
                    observed.delete(jobId);
                    return;
                }
                retries.set(jobId, setTimeout(attempt, PRUNED_REFRESH_RETRY_MS));
            },
        );
    };
    attempt();
}

/** Watch a native root job and merge its saved messages as they appear. */
export function observeNativeConversationJob(jobId, account = getCurrentUserHandle()) {
    if (account !== getCurrentUserHandle()) return;
    if (!jobId || observed.has(jobId)) {
        return;
    }
    const stop = observeJob(jobId, {
        account,
        onSnapshot: () => readback(account),
        // Drop the registry entry once polling really stops, so a retried job
        // that reuses the id (or a later resume) can be observed again.
        onStop: (reason) => {
            // A pruned job ('missing') can be gone before its final readback, so
            // merge the saved store before releasing the fence; releasing it on
            // stale state would let the next worker tick start a duplicate chime.
            if (reason !== 'missing') {
                observed.delete(jobId);
                return;
            }
            refreshBeforeRelease(jobId, account);
        },
    });
    observed.set(jobId, { account, stop });
}

export function stopNativeConversationObservation() {
    for (const { stop } of [...observed.values()]) {
        stop();
    }
    observed.clear();
    for (const timer of retries.values()) clearTimeout(timer);
    retries.clear();
}

export function isObservingConversationJob(jobId) {
    return observed.has(jobId);
}

/** True while any native Conversation job is in flight, syncing, or not yet listed. */
export function isObservingNativeConversationJob() {
    return observed.size > 0 || syncCount > 0;
}

/** Reattach to native roots accepted before the page loaded or on another tab. */
export async function resumeNativeConversationObservation() {
    const account = getCurrentUserHandle();
    for (const entry of [...observed.values()]) {
        if (entry.account !== account) entry.stop();
    }
    syncCount += 1;
    try {
        let jobs = [];
        try {
            jobs = await listJobs({ includeDismissed: false, account });
        } catch {
            return;
        }
        for (const job of jobs) {
            if (job?.type === 'conversation.reply' && !job.parentId && !TERMINAL.has(job.state)) {
                observeNativeConversationJob(job.id, account);
            }
        }
        await readback(account).catch(() => {});
    } finally {
        syncCount -= 1;
    }
}

/** Ask the server to cancel one job family; committed messages are preserved. */
export async function cancelNativeConversationJob(jobId) {
    const account = observed.get(jobId)?.account ?? getCurrentUserHandle();
    await cancelJob(jobId, { reason: 'Cancelled from Conversation Mode.', account });
    observed.get(jobId)?.stop();
}
