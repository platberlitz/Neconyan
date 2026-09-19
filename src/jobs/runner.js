import { serverEvents } from '../server-events.js';
import {
    getJob,
    listJobs,
    recordReceipt,
    recoverJobs,
    setJobState,
    updateJob,
} from './store.js';

export const CONCURRENCY = Object.freeze({
    global: 4,
    perUser: 2,
    reservedForInteractive: 1,
    pollIntervalMs: 500,
});

const running = new Map();
const controllers = new Map();
const knownOwners = new Set();
let timer = null;
let ticking = false;
let cursor = 0;

/** Remember an owner seen by an endpoint so the dispatcher can find their jobs. */
export function noteOwner(owner) {
    if (owner) knownOwners.add(owner);
}

function targetKey(job) {
    const target = job?.target;
    if (!target) return null;
    return JSON.stringify([job.owner, target.kind ?? null, target.id ?? target.chat ?? null, target.branchId ?? null]);
}

function isAutomatic(job) {
    return job?.automatic === true;
}

function userRunningCount(owner) {
    let count = 0;
    for (const job of running.values()) if (job.owner === owner) count += 1;
    return count;
}

function globalRunningCount() {
    return running.size;
}

function interactiveRunningCount() {
    let count = 0;
    for (const job of running.values()) if (!isAutomatic(job)) count += 1;
    return count;
}

export function canStart(job) {
    if (running.has(job.id)) return false;
    if (globalRunningCount() >= CONCURRENCY.global) return false;
    if (userRunningCount(job.owner) >= CONCURRENCY.perUser) return false;
    // One global slot is reserved for interactive work. Automatic-only work
    // cannot consume it, so a user's manual action is never starved by
    // background backfill.
    if (isAutomatic(job) && globalRunningCount() >= CONCURRENCY.global - CONCURRENCY.reservedForInteractive) return false;
    return true;
}

/** Global totals only; account handles and per-account counts stay private. */
export function capacity() {
    return {
        global: globalRunningCount(),
        interactive: interactiveRunningCount(),
        limit: CONCURRENCY.global,
        perUserLimit: CONCURRENCY.perUser,
    };
}

export function ownerCount(owner) {
    return userRunningCount(owner);
}

function targetBusy(job) {
    const key = targetKey(job);
    if (key === null) return false;
    for (const runningJob of running.values()) {
        if (targetKey(runningJob) !== key) continue;
        // Sibling participants of one accepted request share the thread on
        // purpose; they were selected together and each owns its own receipts.
        // Any other job on the same target stays mutually exclusive.
        if (job.parentId && runningJob.parentId === job.parentId
            && handlerEntry(job.type)?.allowSiblingConcurrency && handlerEntry(runningJob.type)?.allowSiblingConcurrency) continue;
        return true;
    }
    return false;
}

/**
 * A handler receives ({ job, directories, signal, progress, receipt }) and
 * resolves with a result. It must persist its own local effects before
 * resolving; the dispatcher only updates the durable status.
 */
const handlers = new Map();

function handlerEntry(type) {
    return handlers.get(type);
}

export function registerHandler(type, handler, { allowSiblingConcurrency = false } = {}) {
    if (typeof handler !== 'function') throw new Error('A job handler must be a function.');
    handlers.set(type, { handler, allowSiblingConcurrency });
}

export function setDirectoriesResolver(resolver) {
    directoriesResolver = resolver;
}

let directoriesResolver = null;

async function runJob(job) {
    let directories;
    try {
        directories = directoriesResolver(job.owner);
        const saved = getJob(directories, job.id);
        if (!saved) return;
        if (saved.cancellation?.requested) {
            await settleQuietly(() => setJobState(directories, job.id, 'cancelled'));
            return;
        }
        const handler = handlerEntry(saved.type)?.handler;
        if (!handler) {
            await settleQuietly(() => setJobState(directories, job.id, 'failed', { error: { message: `No handler is registered for ${saved.type}.`, code: 'JOB_NO_HANDLER' } }));
            return;
        }
        const controller = new AbortController();
        controllers.set(job.id, controller);
        running.set(job.id, saved);
        // Every failure path, including a failed running-state write, must
        // release the slot and target lock. Secondary status writes never
        // become unhandled rejections.
        try {
            await updateJob(directories, job.id, current => ({
                state: 'running',
                startedAt: current.startedAt ?? Date.now(),
                attempt: (current.attempt ?? 0) + 1,
            }));
            await execute(directories, saved, handler, controller);
        } catch (error) {
            await reportFailure(directories, job.id, error, controller.signal);
        } finally {
            running.delete(job.id);
            controllers.delete(job.id);
        }
    } catch (error) {
        await settleQuietly(() => serverEvents.emit('job-status-failed', { owner: job.owner, message: error?.message ?? 'Job could not be read.' }));
    } finally {
        serverEvents.emit('job-updated', { id: job.id, owner: job.owner });
    }
}

async function execute(directories, saved, handler, controller) {
    const progress = async patch => {
        await updateJob(directories, saved.id, current => ({
            stage: patch.stage ?? current.stage,
            progress: patch.total === undefined ? current.progress : { completed: patch.completed ?? current.progress.completed, total: patch.total },
        }));
    };
    const receipt = async entry => {
        await recordReceipt(directories, saved.id, entry);
    };
    const context = { job: saved, directories, owner: saved.owner, signal: controller.signal, progress, receipt };
    const result = await handler(context);
    const current = getJob(directories, saved.id);
    // A cancel may have arrived while the handler was running. Committed
    // local effects are never undone; the caller records them as a partial
    // result so the status does not lie about what happened.
    if (!current || !['running', 'cancelled'].includes(current.state)) return;
    await updateJob(directories, saved.id, job => ({
        result: result ?? null,
        state: job.cancellation?.requested ? 'cancelled' : controller.signal.aborted ? 'interrupted' : 'completed',
        finishedAt: Date.now(),
        recoverability: controller.signal.aborted && !job.cancellation?.requested ? 'needs-retry' : 'terminal',
        resume: null,
        recoveryStep: null,
    }));
}

/**
 * A provider failure is only treated as a cancellation when this job owns a
 * real abort: the controller fired, or the store holds a saved cancellation.
 * A message that merely contains the word 'aborted' stays a visible failure.
 */
async function reportFailure(directories, id, error, signal) {
    const saved = getJob(directories, id);
    if (saved?.cancellation?.requested) {
        await settleQuietly(() => setJobState(directories, id, 'cancelled'));
        return;
    }
    const status = typeof error?.status === 'number' ? error.status : 500;
    const recoverable = error?.recoverable === true || signal?.aborted;
    await settleQuietly(() => setJobState(directories, id, recoverable ? 'interrupted' : 'failed', {
        error: { message: error?.message ?? 'The job failed.', code: error?.code ?? 'JOB_FAILED', status },
    }));
}

function isAbortError(error) {
    return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

/** A secondary failure while writing status must not become an unhandled rejection. */
async function settleQuietly(write) {
    try {
        await write();
    } catch (error) {
        serverEvents.emit('job-status-failed', { message: error?.message ?? 'Job status could not be saved.' });
    }
}

async function tick() {
    if (ticking || !directoriesResolver) return;
    ticking = true;
    try {
        // Fair ordering: a rotating start point over the known owners so one
        // account with continuous work cannot starve the owners after it.
        const owners = [...knownOwners];
        if (owners.length === 0) return;
        const start = cursor % owners.length;
        let dispatched = 0;
        for (let offset = 0; offset < owners.length; offset += 1) {
            const owner = owners[(start + offset) % owners.length];
            let directories;
            try {
                directories = directoriesResolver(owner);
            } catch {
                continue;
            }
            let candidates;
            try {
                candidates = listJobs(directories, { owner, includeDismissed: true })
                    .filter(job => job.state === 'queued' && !job.cancellation?.requested)
                    .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
            } catch {
                // A damaged ledger fails closed for that owner and must not stop
                // the dispatcher for everyone else.
                continue;
            }
            for (const job of candidates) {
                if (!canStart(job) || targetBusy(job)) continue;
                void runJob(job).catch(error => console.error('[Jobs] Dispatch failed:', error));
                dispatched += 1;
            }
        }
        if (dispatched > 0) cursor = (start + 1) % owners.length;
    } finally {
        ticking = false;
    }
}

/** Run one dispatch pass at once, used by tests; the interval calls the same work. */
export async function runScheduledTick() {
    await tick();
}

export function abortJob(id) {
    const controller = controllers.get(id);
    if (controller && !controller.signal.aborted) controller.abort('cancelled');
}

/**
 * Start the dispatcher. Recovery runs once so queued work and interrupts are
 * known before the first tick; the interval then only picks up new jobs.
 */
export function startJobsRunner({ directoriesFor, owners }) {
    setDirectoriesResolver(directoriesFor);
    let stopped = false;
    // Recover each owner's saved work, then let the interval dispatch. Recovery
    // of one owner never prevents the others from being reconciled.
    void (async () => {
        try {
            const list = typeof owners === 'function' ? await owners() : [];
            for (const owner of list) {
                if (stopped) return;
                noteOwner(owner);
                try {
                    recoverJobs(directoriesFor(owner));
                } catch (error) {
                    serverEvents.emit('job-recovery-failed', { owner, message: error?.message ?? 'Recovery failed.' });
                }
            }
            if (stopped) return;
            await tick();
        } catch (error) {
            serverEvents.emit('job-runner-recovery-failed', { message: error?.message ?? 'Recovery failed.' });
        } finally {
            if (!stopped) {
                timer = setInterval(() => { void tick().catch(error => console.error('[Jobs] Scan failed:', error)); }, CONCURRENCY.pollIntervalMs);
                timer.unref();
            }
        }
    })().catch(error => console.error('[Jobs] Startup failed:', error));
    return () => {
        stopped = true;
        if (timer) clearInterval(timer);
        timer = null;
        for (const controller of controllers.values()) controller.abort();
        knownOwners.clear();
        serverEvents.emit('job-runner-stopped');
    };
}

export const testExports = { runJob, tick, capacity, ownerCount, canStart, isAbortError };
