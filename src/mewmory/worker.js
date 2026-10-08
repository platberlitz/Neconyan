import { randomUUID } from 'node:crypto';
import { fail, hash, sourceFingerprint } from './core.js';
import { readConfig } from './models.js';
import { pendingSources, processBatch, processingVersion } from './processing.js';
import { loadCurrentState } from './sources.js';
import { listStories, mutateState, readStateShared, statePath } from './store.js';

const running = new Map();
const MAX_RUNNING = 4;
let wake = () => {};
const atCapacity = (directories, automatic) => running.size >= MAX_RUNNING
    || (automatic && (running.size >= MAX_RUNNING - 1
        || [...running.values()].filter(entry => entry.root === directories.root).length >= 2));
const fingerprint = (state, config) => hash([sourceFingerprint(state), processingVersion(config), config.revision, state.overrides, state.excludedSources]);

/** Persist intent before starting work; neither the HTTP connection nor the selected chat owns it. */
export async function startProcessing(directories, locator, { all = false, checkpoint = false, automatic = false } = {}, call) {
    const key = statePath(directories, locator);
    let state = await loadCurrentState(directories, locator);
    if (running.has(key)) {
        if ((all && !state.processing?.all) || (checkpoint && !state.processing?.checkpoint)) {
            fail('Mewmory is already updating memories for this chat. Wait for it to finish, or stop it first.', 409);
        }
        return state;
    }
    if (!state.enabled) return state;
    if (atCapacity(directories, automatic)) fail('Mewmory is busy updating other chats. Try again in a moment.', 429);
    const config = readConfig(directories);
    const job = { id: randomUUID(), status: 'running', all, checkpoint, automatic,
        fingerprint: fingerprint(state, config), startedAt: Date.now() };
    state = mutateState(directories, locator, current => {
        current.processing = job;
        for (const batch of current.jobs) {
            if (batch.status === 'processing') Object.assign(batch, { status: 'failed', error: 'The server restarted before this finished. It will be tried again.', finishedAt: Date.now() });
        }
    }, state.revision);
    const controller = new AbortController();
    const entry = { controller, promise: null, root: directories.root };
    running.set(key, entry);
    entry.promise = run(directories, locator, state.branchId, job, controller.signal, call)
        .finally(() => {
            running.delete(key);
            wake();
        });
    return state;
}

async function run(directories, locator, branchId, job, signal, call) {
    const finish = (status, error = '', errorStatus = null) => mutateState(directories, locator, current => {
        if (current.branchId !== branchId || current.processing?.id !== job.id) return;
        Object.assign(current.processing, { status, error, errorStatus, finishedAt: Date.now() });
    }, undefined, { existingOnly: true });
    try {
        do {
            const current = readStateShared(directories, locator);
            if (signal.aborted || current.branchId !== branchId || current.processing?.id !== job.id) return;
            if (!current.enabled || (job.automatic && !readConfig(directories).autoUpdate)) break;
            const state = await processBatch(directories, locator, { checkpoint: job.checkpoint, signal }, call);
            if (!pendingSources(state, readConfig(directories), job).length) break;
        } while (job.all && !signal.aborted);
        finish(signal.aborted ? 'cancelled' : 'complete');
    } catch (error) {
        try {
            finish(signal.aborted ? 'cancelled' : 'failed', error.status ? error.message : 'Mewmory processing failed. Its saved memory has been kept.', error.status || 500);
        } catch (saveError) {
            console.error('[Mewmory] Could not save processing status:', saveError);
        }
    }
}

export async function waitForProcessing(directories, locator) {
    await running.get(statePath(directories, locator))?.promise;
    return loadCurrentState(directories, locator);
}

export async function cancelProcessing(directories, locator) {
    const state = await loadCurrentState(directories, locator);
    running.get(statePath(directories, locator))?.controller.abort();
    return mutateState(directories, locator, current => {
        current.processing = { ...current.processing, status: 'cancelled', finishedAt: Date.now(),
            fingerprint: fingerprint(current, readConfig(directories)) };
    }, state.revision);
}

/** One bounded scan also resumes persisted manual work after a restart. */
export async function scanProcessing(directories, call, { reconcile = true } = {}) {
    const config = readConfig(directories);
    for (const story of listStories(directories).sort((a, b) => b.updatedAt - a.updatedAt)) {
        if (running.has(statePath(directories, story.locator))) continue;
        try {
            if (story.processing?.status === 'running' && (!story.enabled || (story.processing.automatic && !config.autoUpdate))) {
                mutateState(directories, story.locator, state => {
                    if (state.processing?.status === 'running') Object.assign(state.processing, { status: 'complete', finishedAt: Date.now() });
                }, undefined, { existingOnly: true });
                continue;
            }
            if (!story.enabled || atCapacity(directories, story.processing?.status !== 'running' || story.processing.automatic)) continue;
            if (story.processing?.status !== 'running' && !(config.autoUpdate && config.roles.extractor.enabled)) continue;
            const state = reconcile ? await loadCurrentState(directories, story.locator) : readStateShared(directories, story.locator);
            const previous = state.processing;
            if (previous?.status === 'running' && (!previous.automatic || config.autoUpdate)) {
                await startProcessing(directories, story.locator, previous, call);
            } else if (config.autoUpdate && config.roles.extractor.enabled
                && pendingSources(state, config, { checkpoint: config.excludeHistory }).length
                && (!['failed', 'cancelled'].includes(previous?.status) || previous.fingerprint !== fingerprint(state, config))) {
                await startProcessing(directories, story.locator, { all: true, checkpoint: config.excludeHistory, automatic: true }, call);
            }
        } catch (error) {
            console.warn('[Mewmory] Could not schedule story:', error.message);
        }
    }
}

/** Safe start: stop interrupted processing from resuming by itself; its saved memory is kept for a manual retry. */
export async function pauseInterruptedProcessing(getDirectories) {
    let paused = 0;
    for (const directories of await getDirectories()) {
        for (const story of listStories(directories)) {
            if (story.processing?.status !== 'running') continue;
            try {
                mutateState(directories, story.locator, state => {
                    if (state.processing?.status !== 'running') return;
                    Object.assign(state.processing, { status: 'failed', error: 'Neconyan restarted in safe mode, so this update was paused. Update memories again when you are ready.', errorStatus: 503, finishedAt: Date.now() });
                    paused++;
                }, undefined, { existingOnly: true });
            } catch (error) {
                console.warn('[Mewmory] Could not pause saved processing:', error.message);
            }
        }
    }
    return paused;
}

export function startMewmoryWorker(getDirectories, call) {
    let scanning = false;
    let pending = false;
    let scheduled;
    let firstUser = 0;
    const scan = async (reconcile = true) => {
        if (scanning) {
            pending = true;
            return;
        }
        scanning = true;
        try {
            const users = await getDirectories();
            for (let index = 0; index < users.length; index++) await scanProcessing(users[(firstUser + index) % users.length], call, { reconcile });
            firstUser = users.length ? (firstUser + 1) % users.length : 0;
        } catch (error) {
            console.warn('[Mewmory] Could not scan saved stories:', error.message);
        } finally {
            scanning = false;
            if (pending) {
                pending = false;
                wake();
            }
        }
    };
    wake = () => {
        if (scheduled) return;
        scheduled = setImmediate(() => {
            scheduled = null;
            void scan(false);
        });
        scheduled.unref();
    };
    const timer = setInterval(() => void scan(), 15000);
    timer.unref();
    void scan();
    return () => {
        clearInterval(timer);
        clearImmediate(scheduled);
        wake = () => {};
    };
}
