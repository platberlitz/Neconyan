import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { acquireChatFileLock } from '../chat-file-lock.js';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

export const JOB_SCHEMA = 1;
export const JOB_LIMIT = 200;
export const JOB_RETAINED_LIMIT = 100;
export const JOB_MAX_BYTES = 2 * 1024 * 1024;
export const JOB_LEDGER_MAX_BYTES = 4 * 1024 * 1024;
// Matches the endpoint body limit so an accepted intent always fits on disk.
export const JOB_INTENT_LIMIT_BYTES = 3 * 1024 * 1024;
export const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Typed limits. They are enforced on both halves of the boundary: the HTTP
// endpoint cannot be handed an object that would not fit on disk, and the
// writer refuses to persist a ledger that grew past the read limit.
export const JOB_TYPE_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
export const JOB_SUBMISSION_KEY_MAX = 256;
export const JOB_PART_MAX_BYTES = 512 * 1024;
export const JOB_INTENT_MAX_BYTES = 2 * 1024 * 1024;
export const JOB_LABEL_MAX = 200;

export const TERMINAL_STATES = Object.freeze(['completed', 'cancelled', 'failed', 'interrupted', 'conflict']);
export const CANCELLABLE_STATES = Object.freeze(['queued', 'running', 'waiting']);

const STORE_FILE = 'index.json';

function stateDir(directories) {
    return path.join(directories.root, 'jobs');
}

function storePath(directories) {
    return path.join(stateDir(directories), STORE_FILE);
}

function fail(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

function byteSize(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value ?? null));
    } catch {
        return Infinity;
    }
}

/**
 * Canonical JSON: object keys are sorted so two intents that differ only in key
 * order produce the same hash and therefore deduplicate as the same submission.
 */
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

export function jobKey(id) {
    return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 32);
}

export function submissionKey(owner, key, intent) {
    return crypto.createHash('sha256').update(canonical([JOB_SCHEMA, owner, String(key ?? ''), intent ?? null])).digest('hex');
}

export function newJobId() {
    return crypto.randomUUID();
}

export function isTerminal(job) {
    return TERMINAL_STATES.includes(job?.state);
}

export function isMutating(job) {
    return job?.mutating !== false;
}

function now() {
    return Date.now();
}

export function validateOwner(owner) {
    if (typeof owner !== 'string' || !owner.trim() || owner.length > 128 || /[\\/]/.test(owner) || owner === '.' || owner === '..') {
        throw fail(400, 'JOB_INVALID', 'A job needs a valid owner handle.');
    }
    return owner;
}

function validateTarget(target) {
    if (target === null || target === undefined) return null;
    if (typeof target !== 'object' || Array.isArray(target)) throw fail(400, 'JOB_INVALID', 'A job target must be an object.');
    const kind = target.kind;
    if (typeof kind !== 'string' || !JOB_TYPE_PATTERN.test(kind)) throw fail(400, 'JOB_INVALID', 'A job target needs a short kind.');
    const identity = target.id ?? target.chat ?? null;
    if (identity !== null && (typeof identity !== 'string' || !identity.length || identity.length > 256)) {
        throw fail(400, 'JOB_INVALID', 'A job target identity must be a bounded string.');
    }
    const branchId = target.branchId ?? null;
    if (branchId !== null && typeof branchId !== 'string' && typeof branchId !== 'number') {
        throw fail(400, 'JOB_INVALID', 'A job target branch must be a string or number.');
    }
    if (byteSize(target) > JOB_PART_MAX_BYTES) throw fail(400, 'JOB_INVALID', 'The job target is too large.');
    return target;
}

function validatePart(name, value, maxBytes) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' || Array.isArray(value)) throw fail(400, 'JOB_INVALID', `The job ${name} must be an object.`);
    if (byteSize(value) > maxBytes) throw fail(400, 'JOB_INVALID', `The job ${name} is too large.`);
    return value;
}

function emptyStore() {
    return { schema: JOB_SCHEMA, revision: 0, updatedAt: now(), jobs: {} };
}

/**
 * Read the owner's ledger. Damage fails closed for that owner only: the file is
 * left untouched and an actionable error is raised, because silently replacing
 * a ledger with an empty one would drop receipts and permit replay of effects.
 */
function readStore(directories) {
    const filename = storePath(directories);
    let raw;
    let stat;
    try {
        stat = fs.statSync(filename);
    } catch (error) {
        if (error.code === 'ENOENT') return emptyStore();
        throw fail(500, 'JOB_STORE_UNREADABLE', 'The saved job ledger could not be read.');
    }
    try {
        if (!stat.isFile()) throw new Error('not a file');
        if (stat.size > JOB_LEDGER_MAX_BYTES) throw new Error('too large');
        raw = fs.readFileSync(filename, 'utf8');
    } catch {
        throw fail(409, 'JOB_STORE_RECOVERABLE', 'The saved job ledger needs recovery and was left untouched. Recent job history cannot be trusted until an operator repairs or removes it.');
    }
    let store;
    try {
        store = JSON.parse(raw);
    } catch {
        throw fail(409, 'JOB_STORE_RECOVERABLE', 'The saved job ledger is damaged and was left untouched. Recent job history cannot be trusted until an operator repairs or removes it.');
    }
    if (!store || store.schema !== JOB_SCHEMA || typeof store.jobs !== 'object' || store.jobs === null || Array.isArray(store.jobs)) {
        throw fail(409, 'JOB_STORE_INCOMPATIBLE', 'The saved job ledger uses an unsupported format.');
    }
    return store;
}

const baseRemovable = job => ['completed', 'cancelled'].includes(job.state) || (isTerminal(job) && job.dismissed);

/**
 * A conversation family is retained or dropped together: a finished child must
 * outlive its root so reconciliation can still read it, and a root must outlive
 * its unfinished children. Any other family member keeps the whole job alive.
 */
function familyLocked(job, jobs) {
    const parent = job.parentId ? jobs[jobKey(job.parentId)] : null;
    // A dismissed member is the user saying "gone"; it stops pinning the family.
    if (parent && !baseRemovable(parent) && !parent.dismissed) return true;
    for (const childId of job.children ?? []) {
        const child = jobs[jobKey(childId)];
        if (child && !baseRemovable(child) && !child.dismissed) return true;
    }
    return false;
}

const removable = (job, jobs = {}) => baseRemovable(job) && !familyLocked(job, jobs);

function pruneJobs(jobs, protectedId) {
    const entries = Object.entries(jobs);
    if (entries.length <= JOB_LIMIT) return jobs;
    // Never discard work that is still queued, running or waiting. Among the
    // terminal records, keep the newest; retention is finite and documented.
    const keep = new Set();
    const nonTerminal = entries.filter(([, job]) => job.id === protectedId || !removable(job, jobs));
    const terminal = entries
        .filter(([, job]) => job.id !== protectedId && removable(job, jobs))
        .sort(([, left], [, right]) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    for (const [key] of nonTerminal) keep.add(key);
    for (const [key, job] of terminal) {
        if (keep.size >= JOB_LIMIT) break;
        if (keep.size >= JOB_RETAINED_LIMIT && (job.updatedAt ?? 0) <= now() - JOB_RETENTION_MS) continue;
        keep.add(key);
    }
    return Object.fromEntries(entries.filter(([key]) => keep.has(key)));
}

function writeStore(directories, store, protectedId) {
    const previousKeys = Object.keys(store.jobs);
    const ordered = { ...store, jobs: pruneJobs(store.jobs, protectedId) };
    ordered.revision += 1;
    ordered.updatedAt = now();
    let text = JSON.stringify(ordered);
    for (const [key, job] of Object.entries(ordered.jobs).sort(([, a], [, b]) => a.updatedAt - b.updatedAt)) {
        if (Buffer.byteLength(text) <= JOB_LEDGER_MAX_BYTES) break;
        if (job.id === protectedId || !removable(job, ordered.jobs)) continue;
        delete ordered.jobs[key];
        text = JSON.stringify(ordered);
    }
    if (Buffer.byteLength(text) > JOB_LEDGER_MAX_BYTES) {
        throw fail(413, 'JOB_STORE_FULL', 'The job ledger for this account is full. Older finished jobs must be dismissed before new work is accepted.');
    }
    fs.mkdirSync(stateDir(directories), { recursive: true, mode: 0o700 });
    writeFileAtomicSync(storePath(directories), text, { mode: 0o600 });
    // Delete artifacts only after the ledger no longer references their job.
    for (const key of previousKeys) {
        if (ordered.jobs[key]) continue;
        try {
            fs.rmSync(path.join(stateDir(directories), 'artifacts', key), { recursive: true, force: true });
        } catch (error) {
            console.warn('[Jobs] Could not remove expired artifacts:', error.message);
        }
    }
    return ordered;
}

/**
 * Read-modify-write under the existing chat lock helper. The lock is released
 * before any model call ever runs, so a long generation never holds it. This is
 * a lock-protected read/modify/write, not a revision compare-and-set.
 */
export function mutateJobs(directories, mutate) {
    const release = acquireChatFileLock(storePath(directories));
    try {
        const store = readStore(directories);
        const result = mutate(store);
        if (result?.changed === false) return result;
        const written = writeStore(directories, store, result?.job?.id);
        return { ...result, revision: written.revision };
    } finally {
        release();
    }
}

export function readJobStore(directories) {
    return readStore(directories);
}

export function listJobs(directories, { owner, includeDismissed = false } = {}) {
    const store = readStore(directories);
    return Object.values(store.jobs)
        .filter(job => owner === undefined || job.owner === owner)
        .filter(job => includeDismissed || job.dismissed !== true)
        .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
}

export function getJob(directories, id) {
    return readStore(directories).jobs[jobKey(id)] ?? null;
}

/**
 * Accept an immutable job intent. The same owner and submission key with the
 * same normalised intent returns the existing job; the same key with a
 * different intent is a conflict. A dropped acceptance response therefore
 * cannot cause a second message or provider call.
 *
 * `resume`, `recoverability` and `stage` are deliberately not accepted from a
 * caller: only server-side checkpoints may nominate safe resumption. A client
 * cannot ask the server to repeat an uncertain provider call after a crash.
 */
export function acceptJob(directories, input) {
    const owner = validateOwner(input?.owner);
    const type = input?.type;
    if (typeof type !== 'string' || !JOB_TYPE_PATTERN.test(type)) throw fail(400, 'JOB_INVALID', 'A job needs a short lowercase type.');
    const key = input?.submissionKey;
    if (typeof key !== 'string' || !key.length || key.length > JOB_SUBMISSION_KEY_MAX) {
        throw fail(400, 'JOB_INVALID', 'A job needs a bounded string submission key.');
    }
    if (input?.intent === undefined || input.intent === null) throw fail(400, 'JOB_INVALID', 'A job needs an intent.');
    const intent = validatePart('intent', input.intent, JOB_INTENT_MAX_BYTES) ?? {};
    const target = validateTarget(input.target ?? null);
    const config = validatePart('config', input.config ?? null, JOB_PART_MAX_BYTES);
    const credentialRef = validatePart('credentialRef', input.credentialRef ?? null, JOB_PART_MAX_BYTES);
    const automatic = input.automatic === true;
    const mutating = input.mutating !== false;
    // A paused job is not dispatchable. It exists so server-side preparation
    // (private captures, native input writes) can finish before the runner sees
    // it, and a crash mid-preparation leaves a resumable record, not a paid call.
    const paused = input.paused === true;
    // Optional server-side coalescing record: a paused Conversation submission
    // carries the moment its batch closes and the member submissions merged into
    // it. Written in the same mutation as the paused state so a crash cannot
    // leave a paused job the reconciler would never finish.
    const coalesce = input.coalesce == null ? null : validatePart('coalesce', input.coalesce, JOB_PART_MAX_BYTES);
    const label = input.label == null ? null : String(input.label).slice(0, JOB_LABEL_MAX);
    const intentHash = submissionKey(owner, key, { type, intent, target, config, credentialRef, automatic, mutating });
    return mutateJobs(directories, store => {
        for (const job of Object.values(store.jobs)) {
            if (job.owner !== owner || job.submissionKey !== key) continue;
            if (job.intentHash !== intentHash) {
                throw fail(409, 'JOB_SUBMISSION_CONFLICT', 'This submission key was already used for different work.');
            }
            return { job, created: false, changed: false, revision: store.revision };
        }
        // Refuse before persisting when this record could not be saved, rather
        // than throwing away the caller's just-accepted identity.
        if (Object.keys(store.jobs).length >= JOB_LIMIT) {
            const hasRemovable = Object.values(store.jobs).some(job => removable(job, store.jobs));
            if (!hasRemovable) {
                throw fail(503, 'JOB_STORE_FULL', 'Too many unfinished or unresolved jobs for this account. Finish work or dismiss resolved failures before starting more.');
            }
        }
        const id = newJobId();
        const job = {
            schema: JOB_SCHEMA,
            id,
            owner,
            type,
            mutating,
            automatic,
            submissionKey: key,
            intentHash,
            intent,
            label,
            state: paused ? 'waiting' : 'queued',
            stage: paused ? 'preparing' : null,
            coalesce,
            progress: { completed: 0, total: null },
            target,
            config,
            // Saved connection-profile reference only; never a secret value.
            // The profile is resolved at execution time.
            credentialRef,
            resume: null,
            recoverability: 'resumable',
            children: [],
            receipts: [],
            artifact: null,
            result: null,
            error: null,
            cancellation: { requested: false, requestedAt: null, reason: null },
            dismissed: false,
            createdAt: now(),
            updatedAt: now(),
            startedAt: null,
            finishedAt: null,
            attempt: 0,
        };
        store.jobs[jobKey(id)] = job;
        return { job, created: true };
    });
}

/**
 * Materialise a parent job's participants as child jobs in one ledger mutation.
 * Children start paused so the parent can freeze each participant request before
 * any provider work; repeating materialisation with the same keys returns the
 * existing children instead of duplicating them. Only server-side callers use
 * this: the public submission endpoint never accepts a parent id.
 */
export function acceptChildJobs(directories, parentId, inputs) {
    if (!Array.isArray(inputs) || inputs.length === 0) return [];
    return mutateJobs(directories, store => {
        const parent = store.jobs[jobKey(parentId)];
        if (!parent) throw fail(404, 'JOB_NOT_FOUND', 'The parent job no longer exists.');
        const children = [];
        for (const input of inputs) {
            const participantKey = input?.participantKey;
            if (typeof participantKey !== 'string' || !participantKey || participantKey.length > 256) {
                throw fail(400, 'JOB_INVALID', 'A participant key is required.');
            }
            const key = `child:${parentId}:${participantKey}`;
            const existing = Object.values(store.jobs).find(job => job.owner === parent.owner && job.submissionKey === key);
            if (existing) {
                if (existing.parentId !== parentId) throw fail(409, 'JOB_SUBMISSION_CONFLICT', 'A participant key was already used for different work.');
                children.push(existing);
                continue;
            }
            const intent = validatePart('intent', input.intent ?? {}, JOB_INTENT_MAX_BYTES) ?? {};
            const target = validateTarget(input.target ?? parent.target ?? null);
            const config = validatePart('config', input.config ?? null, JOB_PART_MAX_BYTES);
            const credentialRef = validatePart('credentialRef', input.credentialRef ?? null, JOB_PART_MAX_BYTES);
            const id = newJobId();
            const job = {
                schema: JOB_SCHEMA, id, owner: parent.owner, type: 'conversation.participant',
                mutating: true, automatic: parent.automatic === true, parentId,
                submissionKey: key,
                intentHash: submissionKey(parent.owner, key, { type: 'conversation.participant', intent, target, config, credentialRef }),
                intent, label: parent.label, state: 'waiting', stage: 'preparing', coalesce: null,
                progress: { completed: 0, total: null }, target, config, credentialRef,
                resume: null, recoverability: 'resumable', children: [], receipts: [],
                artifact: null, result: null, error: null,
                cancellation: { requested: false, requestedAt: null, reason: null },
                dismissed: false, createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null, attempt: 0,
            };
            store.jobs[jobKey(id)] = job;
            children.push(job);
        }
        parent.children = [...new Set([...(parent.children ?? []), ...children.map(child => child.id)])];
        parent.updatedAt = now();
        return { children, job: parent };
    }).children;
}

/**
 * Release a parent's frozen children for dispatch and park the parent at
 * `waiting/children`. The parent holds its target but consumes no running slot,
 * so its children can take the account's provider slots. Safe to repeat.
 */
export function releaseChildJobs(directories, parentId) {
    return mutateJobs(directories, store => {
        const parent = store.jobs[jobKey(parentId)];
        if (!parent) throw fail(404, 'JOB_NOT_FOUND', 'The parent job no longer exists.');
        // A cancellation that landed during preparation still stops the children:
        // queueing them here would dispatch work the user already cancelled.
        const cancelled = parent.cancellation?.requested === true;
        for (const childId of parent.children ?? []) {
            const child = store.jobs[jobKey(childId)];
            if (!child || TERMINAL_STATES.includes(child.state)) continue;
            if (cancelled) {
                child.cancellation = { requested: true, requestedAt: now(), reason: parent.cancellation?.reason ?? null };
                child.state = 'cancelled';
                child.finishedAt = now();
                child.updatedAt = now();
            } else if (child.state === 'waiting' && child.stage === 'preparing') {
                child.state = 'queued';
                child.stage = null;
                child.updatedAt = now();
            }
        }
        if (cancelled) {
            parent.state = 'cancelled';
            parent.stage = null;
            parent.finishedAt = now();
            parent.updatedAt = now();
        } else if (parent.state === 'running' || parent.state === 'queued' || parent.state === 'waiting') {
            parent.state = 'waiting';
            parent.stage = 'children';
            parent.updatedAt = now();
        }
        return { job: parent };
    });
}

export function updateJob(directories, id, patch) {
    return mutateJobs(directories, store => {
        const key = jobKey(id);
        const job = store.jobs[key];
        if (!job) throw fail(404, 'JOB_NOT_FOUND', 'No such job.');
        Object.assign(job, typeof patch === 'function' ? patch(job) : patch, { updatedAt: now() });
        return { job };
    });
}

export function setJobState(directories, id, state, { error = null, stuck = null } = {}) {
    return updateJob(directories, id, job => {
        // A requested cancellation wins over a late success or failure. A reply
        // that arrives after the cancel is saved as a recoverable artifact, not
        // reported as a successful job. A genuine target conflict is still
        // reported, because it tells the user their data changed underneath.
        if (job.cancellation?.requested && ['completed', 'failed', 'interrupted'].includes(state)) {
            return { state: 'cancelled', finishedAt: now(), error: null, recoverability: 'terminal' };
        }
        const patch = { state, error, finishedAt: TERMINAL_STATES.includes(state) ? now() : null };
        if (state === 'running') {
            patch.startedAt = job.startedAt ?? now();
            patch.attempt = (job.attempt ?? 0) + 1;
        }
        if (stuck) patch.stuck = stuck;
        return patch;
    });
}

/**
 * Move a job that finished its server-side preparation into the dispatch queue.
 * A job cancelled while it was preparing stays cancelled; releasing never
 * resurrects it.
 */
export function releaseJob(directories, id) {
    return mutateJobs(directories, store => {
        const key = jobKey(id);
        const job = store.jobs[key];
        if (!job) throw fail(404, 'JOB_NOT_FOUND', 'No such job.');
        if (job.state !== 'waiting' || job.stage !== 'preparing' || job.cancellation?.requested) return { job, changed: false };
        job.state = 'queued';
        job.stage = null;
        job.updatedAt = now();
        return { job };
    });
}

export function requestCancellation(directories, id, { reason = null } = {}) {
    return mutateJobs(directories, store => {
        const job = store.jobs[jobKey(id)];
        if (!job) throw fail(404, 'JOB_NOT_FOUND', 'No such job.');
        if (TERMINAL_STATES.includes(job.state)) return { job, changed: false };
        job.cancellation = { requested: true, requestedAt: now(), reason };
        job.updatedAt = now();
        // A queued job was never started, so the cancellation is final at once.
        // Running work records the request and lets the runner observe it.
        if (job.state === 'queued' || job.state === 'waiting') {
            job.state = 'cancelled';
            job.finishedAt = now();
        }
        // Cancelling a family cancels its unfinished children in the same write.
        // Committed child effects stay intact; only pending work stops.
        for (const childId of job.children ?? []) {
            const child = store.jobs[jobKey(childId)];
            if (!child || TERMINAL_STATES.includes(child.state)) continue;
            child.cancellation = { requested: true, requestedAt: now(), reason };
            child.updatedAt = now();
            if (child.state === 'queued' || child.state === 'waiting') {
                child.state = 'cancelled';
                child.finishedAt = now();
            }
        }
        // The request is durable before it is acknowledged. The runner observes
        // it before starting, between stages, and after any late provider reply.
        return { job };
    });
}

export function dismissJob(directories, id) {
    return mutateJobs(directories, store => {
        const job = store.jobs[jobKey(id)];
        if (!job) throw fail(404, 'JOB_NOT_FOUND', 'No such job.');
        job.dismissed = true;
        job.updatedAt = now();
        // The client only ever sees the root, so dismissing it must also dismiss
        // the participants that would otherwise keep the family in the ledger.
        for (const childId of job.children ?? []) {
            const child = store.jobs[jobKey(childId)];
            if (!child) continue;
            child.dismissed = true;
            child.updatedAt = now();
        }
        return { job };
    });
}

/**
 * Reopen a Conversation family after an explicit retry. Only failed or unknown
 * participants are requeued; completed ones keep their saved output. The root
 * returns to `waiting/children` so the worker aggregates again.
 */
export function retryConversationFamily(directories, id) {
    return mutateJobs(directories, store => {
        const root = store.jobs[jobKey(id)];
        if (!root) throw fail(404, 'JOB_NOT_FOUND', 'No such job.');
        let changed = false;
        for (const childId of root.children ?? []) {
            const child = store.jobs[jobKey(childId)];
            if (!child || !['failed', 'interrupted'].includes(child.state)) continue;
            child.state = 'queued';
            child.stage = null;
            child.error = null;
            child.result = null;
            child.recoverability = 'resumable';
            child.recoveryStep = null;
            child.attempt += 1;
            child.updatedAt = now();
            changed = true;
        }
        if (!changed) throw fail(409, 'JOB_NOT_RETRYABLE', 'No participant in this Conversation reply can be retried.');
        root.state = 'waiting';
        root.stage = 'children';
        root.error = null;
        root.result = null;
        root.finishedAt = null;
        root.recoverability = 'resumable';
        root.updatedAt = now();
        return { job: root };
    });
}

export function recordReceipt(directories, id, receipt) {
    return updateJob(directories, id, job => ({
        receipts: [...(job.receipts ?? []), { ...receipt, at: now() }],
    }));
}

export function appendChild(directories, id, child) {
    return updateJob(directories, id, job => ({ children: [...(job.children ?? []), child] }));
}

/**
 * Record that outbound provider work may now have happened. The state is saved
 * BEFORE the request is made, so a crash during the call is honestly reported
 * as an unknown outcome rather than silently repeated.
 */
export function markProviderUncertain(directories, id, { step = null } = {}) {
    return updateJob(directories, id, {
        recoverability: 'unknown-outcome',
        recoveryStep: step,
    });
}

/** Save the recoverable result before the uncertainty is cleared. */
export function markProviderSettled(directories, id) {
    return updateJob(directories, id, job => ({
        recoverability: job.resume ? 'resumable' : 'settled',
        recoveryStep: null,
    }));
}

/** A server-side checkpoint nominates the next safe step after a restart. */
export function setJobResume(directories, id, step) {
    return updateJob(directories, id, { resume: typeof step === 'string' && step ? step : null, recoverability: 'resumable' });
}

/**
 * Start-up reconciliation. Work that was queued but never started is recovered
 * and returned for dispatch. Work that was running when the process stopped is
 * marked interrupted unless it can be resumed from a server-saved next step; an
 * unknown provider outcome is never silently re-submitted as a charged call.
 */
export function recoverJobs(directories) {
    return mutateJobs(directories, store => {
        const recoverable = [];
        let changed = false;
        for (const job of Object.values(store.jobs)) {
            if (CANCELLABLE_STATES.includes(job.state) && job.cancellation?.requested) {
                changed = true;
                job.state = 'cancelled';
                job.finishedAt = now();
                continue;
            }
            if (job.state === 'queued') {
                recoverable.push(job);
                continue;
            }
            // A saved review stays waiting for its decision, not another execution.
            if (job.state === 'running') {
                changed = true;
                const resumable = job.recoverability === 'resumable' && typeof job.resume === 'string' && job.resume;
                if (resumable) {
                    job.state = 'queued';
                    job.stage = null;
                    job.recoveredAt = now();
                    recoverable.push(job);
                    continue;
                }
                job.state = 'interrupted';
                job.finishedAt = now();
                job.error = { message: job.recoverability === 'unknown-outcome' ? 'The provider result is unknown after a restart. Retry deliberately if the request was not completed.' : 'The server stopped before this job finished.', code: 'INTERRUPTED' };
                job.recoverability = 'needs-retry';
            }
        }
        return { recoverable, changed };
    });
}
