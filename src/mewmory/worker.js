import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beginServerWork } from '../android-wake.js';
import { fail, hash, sourceFingerprint } from './core.js';
import { readConfig, resolvedRoleIdentity } from './models.js';
import { overDailyLimit } from './spend.js';
import { isStaleSourceError, pendingSources, processBatch, processingVersion } from './processing.js';
import { loadCurrentState } from './sources.js';
import { chatPath, listStories, listStoriesGradually, mutateState, readStateShared, statePath, updateProcessing } from './store.js';

const running = new Map();
/** Stop work for a disabled chat without waiting on a remote model. */
export function abortMewmoryProcessing(directories, locator) {
    running.get(statePath(directories, locator))?.controller.abort();
}
const MAX_RUNNING = 4;
const STALE_SOURCE_RETRIES = 3;
let wake = () => {};
const atCapacity = (directories, automatic) => running.size >= MAX_RUNNING
    || (automatic && (running.size >= MAX_RUNNING - 1
        || [...running.values()].filter(entry => entry.root === directories.root).length >= 2));
// Reconciling a story re-reads its chat, cards, lorebooks and files, and with dozens of enabled
// chats that kept the server busy for most of every scan while nothing had changed. A story is
// reconciled again only when one of those files changes, or every ten minutes as a safety net.
const RECONCILE_REFRESH_MS = 10 * 60_000;
const reconciled = new Map();
const attemptedVisibilityRestores = new Set();
const fileStamp = filename => {
    try {
        const stat = fs.statSync(filename);
        return [stat.ino, stat.size, stat.mtimeMs];
    } catch {
        return null;
    }
};
const directoryStamp = directory => {
    let names;
    try {
        names = fs.readdirSync(directory).sort();
    } catch {
        return null;
    }
    return names.map(name => [name, fileStamp(path.join(directory, name))]);
};
const sharedInputs = (directories, config) => hash([config, fileStamp(path.join(directories.root, 'settings.json')),
    ...[directories.characters, directories.groups, directories.worlds, directories.files].map(directoryStamp)]);
const resolvedIdentities = config => ({ extractor: resolvedRoleIdentity(config, 'extractor'),
    pawspective: resolvedRoleIdentity(config, 'pawspective') });
// A failed story is retried only after something that affects its result changed. Connection Manager
// model and URL edits live outside the Mewmory config revision, so include their resolved identities.
const fingerprint = (state, config) => hash([sourceFingerprint(state),
    processingVersion(config, resolvedIdentities(config)), config.revision, state.overrides, state.excludedSources]);
// Reading and saving a large story takes tens of milliseconds each; awaiting a finished promise does not let
// page requests in, so background work steps aside between those steps.
const yieldToRequests = () => new Promise(resolve => setImmediate(resolve));
// Each failure in a row doubles the wait before automatic updates try that chat again, from one minute up to
// half an hour, and never sooner than a busy model service asked for.
const retryTime = (error, failures, now = Date.now()) => Math.max(Number(error.retryAt) || 0,
    now + Math.min(30 * 60 * 1000, 60 * 1000 * 2 ** (failures - 1)));
const settingsFingerprint = config => hash([processingVersion(config, resolvedIdentities(config)), config.revision]);
// Changed settings are tried straight away. A busy service clears up by itself, so that failure is retried
// once its wait is over. Any other failure needs something that affects the result to change, as well as the wait.
const automaticRetryAllowed = (previous, state, config, now = Date.now()) => {
    if (previous?.status === 'cancelled') return previous.fingerprint !== fingerprint(state, config);
    if (previous?.status !== 'failed') return true;
    if (previous.settings && previous.settings !== settingsFingerprint(config)) return true;
    if (Number(previous.retryAt) > now) return false;
    return Boolean(previous.busy) || previous.fingerprint !== fingerprint(state, config);
};
// Automatic updates follow the chat being played. Reading every enabled chat in the background spent
// most of the day's tokens on chats nobody had open; the others catch up when they are next replied in,
// and Update memories still covers any chat on request.
function mostRecentChat(directories, stories) {
    let latest = null;
    for (const story of stories) {
        if (!story.enabled) continue;
        const modified = fileStamp(chatPath(directories, story.locator))?.[2];
        if (Number.isFinite(modified) && (!latest || modified > latest.modified)) latest = { key: statePath(directories, story.locator), modified };
    }
    return latest?.key ?? null;
}

/** Persist intent before starting work; neither the HTTP connection nor the selected chat owns it. */
export async function startProcessing(directories, locator, { all = false, checkpoint = false, automatic = false, unreadOnly = automatic } = {}, call) {
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
    const failures = state.processing?.status === 'failed' ? state.processing.failures || 1 : 0;
    const job = { id: randomUUID(), status: 'running', all, checkpoint, automatic, unreadOnly: unreadOnly === true,
        fingerprint: fingerprint(state, config), settings: settingsFingerprint(config), startedAt: Date.now(), ...(failures ? { failures } : {}) };
    state = mutateState(directories, locator, current => {
        current.processing = job;
        for (const batch of current.jobs) {
            if (batch.status === 'processing') Object.assign(batch, { status: 'failed', error: 'The server restarted before this finished. It will be tried again.', finishedAt: Date.now() });
        }
    }, state.revision);
    const controller = new AbortController();
    const entry = { controller, promise: null, root: directories.root };
    running.set(key, entry);
    const endWork = beginServerWork();
    entry.promise = run(directories, locator, state.branchId, job, controller.signal, call)
        .finally(() => {
            running.delete(key);
            endWork();
            wake();
        });
    return state;
}

function processingEligibility(directories, locator, branchId, job, signal) {
    const current = readStateShared(directories, locator);
    if (signal.aborted || current.branchId !== branchId || current.processing?.id !== job.id) return 'stop';
    return current.enabled ? 'eligible' : 'disabled';
}

async function run(directories, locator, branchId, job, signal, call) {
    const finish = (status, error = '', errorStatus = null, extra = {}) => updateProcessing(directories, locator,
        { branchId, jobId: job.id, existingOnly: true },
        { set: { status, error, errorStatus, finishedAt: Date.now(), ...extra },
            remove: status === 'failed' ? [] : ['failures', 'retryAt', 'busy'] });
    try {
        for (let staleRetries = 0; ;) {
            await yieldToRequests();
            const eligibility = processingEligibility(directories, locator, branchId, job, signal);
            if (eligibility === 'stop') return;
            if (eligibility === 'disabled') break;
            if (job.automatic) {
                const config = readConfig(directories);
                // Automatic updates pause for the rest of the day once the daily limit is used up.
                if (!config.autoUpdate || overDailyLimit(directories, config)) break;
            }
            let state;
            try {
                state = await processBatch(directories, locator, { checkpoint: job.checkpoint, unreadOnly: job.unreadOnly === true, signal }, call);
                staleRetries = 0;
            } catch (error) {
                // Post-generation agents and trackers rewrite the reply just after it is saved; read the new text and go again.
                if (signal.aborted || !isStaleSourceError(error) || ++staleRetries > STALE_SOURCE_RETRIES) throw error;
                continue;
            }
            if (!job.all || signal.aborted || !pendingSources(state, readConfig(directories), job).length) break;
        }
        finish(signal.aborted ? 'cancelled' : 'complete');
    } catch (error) {
        try {
            const failures = (job.failures || 0) + 1;
            finish(signal.aborted ? 'cancelled' : 'failed', error.status ? error.message : 'Mewmory processing failed. Its saved memory has been kept.', error.status || 500,
                signal.aborted ? {} : { failures, retryAt: retryTime(error, failures), ...(error.retryAt ? { busy: true } : {}) });
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
    return updateProcessing(directories, locator,
        { branchId: state.branchId, jobId: state.processing?.id, expectedRevision: state.revision },
        { set: { status: 'cancelled', finishedAt: Date.now(), fingerprint: fingerprint(state, readConfig(directories)) } }).state;
}

/** One bounded scan also resumes persisted manual work after a restart. */
export async function scanProcessing(directories, call, { reconcile = true } = {}) {
    const config = readConfig(directories);
    const capped = overDailyLimit(directories, config);
    const shared = reconcile ? sharedInputs(directories, config) : null;
    const stories = (await listStoriesGradually(directories)).sort((a, b) => b.updatedAt - a.updatedAt);
    const seen = new Set();
    const followed = mostRecentChat(directories, stories);
    for (const [index, story] of stories.entries()) {
        const key = statePath(directories, story.locator);
        seen.add(key);
        // Each story's checks are synchronous; let waiting requests run between them.
        if (index) await yieldToRequests();
        if (running.has(key)) continue;
        try {
            const restoreKey = story.visibilityRestore && key + ':' + story.visibilityRestore.operationKey;
            if (restoreKey && story.visibilityRestore.status !== 'complete' && !attemptedVisibilityRestores.has(restoreKey)) {
                attemptedVisibilityRestores.add(restoreKey);
                const { roleplayAccountBase } = await import('../roleplay-store.js');
                const base = roleplayAccountBase(directories);
                if (base) {
                    const { resumeVisibilityRestore } = await import('./visibility.js');
                    try { resumeVisibilityRestore(base, story.locator); } catch { /* Retry remains visible per chat. */ }
                }
            }
            const automaticAllowed = config.autoUpdate && !capped && key === followed;
            if (story.processing?.status === 'running' && (!story.enabled || (story.processing.automatic && !automaticAllowed))) {
                const state = readStateShared(directories, story.locator);
                if (state.enabled && (!state.processing?.automatic || automaticAllowed)) continue;
                updateProcessing(directories, story.locator,
                    { branchId: state.branchId, jobId: state.processing?.id, status: 'running', existingOnly: true },
                    { set: { status: 'complete', finishedAt: Date.now() } });
                continue;
            }
            if (!story.enabled || atCapacity(directories, story.processing?.status !== 'running' || story.processing.automatic)) continue;
            if (story.processing?.status !== 'running' && !(automaticAllowed && config.roles.extractor.enabled)) continue;
            let state;
            let chat;
            if (reconcile) {
                chat = fileStamp(chatPath(directories, story.locator));
                const last = reconciled.get(key);
                if (last?.idle && Date.now() - last.at < RECONCILE_REFRESH_MS
                    && last.stamp === hash([shared, chat, fileStamp(key)])) continue;
                // The periodic pass is the safety net for an input nothing noticed changing, so it reconciles from scratch.
                state = await loadCurrentState(directories, story.locator, { fresh: Boolean(last?.idle) && Date.now() - last.at >= RECONCILE_REFRESH_MS });
            } else {
                state = readStateShared(directories, story.locator);
            }
            await yieldToRequests();
            if (running.has(key) || atCapacity(directories, story.processing?.status !== 'running' || story.processing.automatic)) continue;
            const previous = state.processing;
            let idle = false;
            if (previous?.status === 'running' && (!previous.automatic || automaticAllowed)) {
                await startProcessing(directories, story.locator, previous, call);
            } else if (automaticAllowed && config.roles.extractor.enabled
                && pendingSources(state, config, { checkpoint: config.excludeHistory, unreadOnly: true }).length
                && automaticRetryAllowed(previous, state, config)) {
                await startProcessing(directories, story.locator, { all: true, checkpoint: config.excludeHistory, automatic: true }, call);
            } else {
                idle = true;
            }
            // The chat is stamped as it was before the read, so a save during it is noticed next time.
            if (reconcile) reconciled.set(key, { idle, at: Date.now(), stamp: hash([shared, chat, fileStamp(key)]) });
        } catch (error) {
            reconciled.delete(key);
            console.warn('[Mewmory] Could not schedule story:', error.message);
        }
    }
    const directory = path.join(directories.root, 'mewmory', 'stories');
    for (const key of reconciled.keys()) {
        if (path.dirname(key) === directory && !seen.has(key)) reconciled.delete(key);
    }
}

/** Safe start: stop interrupted processing from resuming by itself; its saved memory is kept for a manual retry. */
export async function pauseInterruptedProcessing(getDirectories) {
    let paused = 0;
    for (const directories of await getDirectories()) {
        for (const story of listStories(directories)) {
            if (story.visibilityRestore && story.visibilityRestore.status !== 'complete') {
                const { roleplayAccountBase } = await import('../roleplay-store.js');
                const base = roleplayAccountBase(directories);
                if (base) {
                    const { resumeVisibilityRestore } = await import('./visibility.js');
                    try { resumeVisibilityRestore(base, story.locator); } catch { /* Keep the durable retry state. */ }
                }
            }
            if (story.processing?.status !== 'running') continue;
            try {
                const state = readStateShared(directories, story.locator);
                const result = updateProcessing(directories, story.locator,
                    { branchId: state.branchId, jobId: state.processing?.id, status: 'running', existingOnly: true },
                    { set: { status: 'failed', error: 'Neconyan restarted in safe mode, so this update was paused. Update memories again when you are ready.', errorStatus: 503, finishedAt: Date.now() } });
                if (result.changed) paused++;
            } catch (error) {
                console.warn('[Mewmory] Could not pause saved processing:', error.message);
            }
        }
    }
    return paused;
}

/**
 * firstScanDelayMs holds back the first scan (and the regular ones) so a freshly started server can serve
 * the page first; a scan that finds many chats to catch up keeps the server busy for a while.
 */
export function startMewmoryWorker(getDirectories, call, { firstScanDelayMs = 0 } = {}) {
    let scanning = false;
    let pending = false;
    let scheduled;
    let firstUser = 0;
    let started = false;
    const scan = async (reconcile = true) => {
        if (scanning) {
            pending = true;
            return;
        }
        scanning = true;
        try {
            const users = await getDirectories();
            for (let index = 0; index < users.length; index++) {
                try {
                    await scanProcessing(users[(firstUser + index) % users.length], call, { reconcile });
                } catch (error) {
                    console.warn('[Mewmory] Could not scan an account’s saved stories:', error.message);
                }
            }
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
        // The startup delay owns the first scan. A job that finishes after an
        // earlier worker stopped must not pull this worker into its grace period.
        if (!started || scheduled) return;
        scheduled = setImmediate(() => {
            scheduled = null;
            void scan(false);
        });
        scheduled.unref();
    };
    let timer;
    const begin = () => {
        started = true;
        timer = setInterval(() => void scan(), 15000);
        timer.unref();
        void scan();
    };
    const delay = firstScanDelayMs > 0 ? setTimeout(begin, firstScanDelayMs) : null;
    if (delay) delay.unref();
    else begin();
    return () => {
        started = false;
        clearTimeout(delay);
        clearInterval(timer);
        clearImmediate(scheduled);
        wake = () => {};
    };
}
