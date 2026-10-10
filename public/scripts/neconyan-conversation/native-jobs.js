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
import { reviewAssistantJobChildren } from '../neconyan-assistant-job-review.js';
import { observeNativeConversationPreview } from './native-preview.js';

const OBSERVED_ROOT_TYPES = new Set(['conversation.reply', 'conversation.rewrite', 'conversation.selfie', 'conversation.schedule', 'conversation.summary']);
const observed = new Map();
const readbacks = new Map();
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

/** Watch a native root job and merge its saved messages as they appear. */
export function observeNativeConversationJob(jobId, account = getCurrentUserHandle()) {
    if (account !== getCurrentUserHandle()) return;
    if (!jobId || observed.has(jobId)) {
        return;
    }
    let stopPreview;
    const stop = observeJob(jobId, {
        account,
        onSnapshot: async job => {
            if (['conversation.reply', 'conversation.rewrite'].includes(job.type) && !TERMINAL.has(job.state) && !stopPreview) stopPreview = observeNativeConversationPreview(jobId, account);
            await readback(account);
            await reviewAssistantJobChildren(job, account);
        },
        // Drop the registry entry once polling really stops, so a retried job
        // that reuses the id (or a later resume) can be observed again.
        onStop: (reason) => {
            stopPreview?.();
            observed.delete(jobId);
            if (reason === 'missing') void readback(account).catch(() => {});
        },
    });
    observed.set(jobId, { account, stop });
}

/**
 * Wait for one native job and read its saved result back. Resolves with the
 * final job, or null when this page stopped watching before it finished.
 */
export function waitForNativeConversationJob(jobId, account = getCurrentUserHandle()) {
    return new Promise(resolve => {
        observeJob(jobId, {
            account,
            onSnapshot: () => readback(account),
            onDone: job => resolve(job),
            onStop: reason => { if (reason !== 'done') resolve(null); },
        });
    });
}

export function stopNativeConversationObservation() {
    for (const { stop } of [...observed.values()]) {
        stop();
    }
    observed.clear();
}

export function isObservingConversationJob(jobId) {
    return observed.has(jobId);
}

/** Reattach to native roots accepted before the page loaded or on another tab. */
export async function resumeNativeConversationObservation() {
    const account = getCurrentUserHandle();
    for (const entry of [...observed.values()]) {
        if (entry.account !== account) entry.stop();
    }
    let jobs = [];
    try {
        jobs = await listJobs({ includeDismissed: false, account });
    } catch {
        return;
    }
    for (const job of jobs) {
        if (OBSERVED_ROOT_TYPES.has(job?.type) && !job.parentId && !TERMINAL.has(job.state)) observeNativeConversationJob(job.id, account);
    }
    await readback(account).catch(() => {});
}

/** Ask the server to cancel one job family; committed messages are preserved. */
export async function cancelNativeConversationJob(jobId) {
    const account = observed.get(jobId)?.account ?? getCurrentUserHandle();
    await cancelJob(jobId, { reason: 'Cancelled from Conversation Mode.', account });
    observed.get(jobId)?.stop();
}
