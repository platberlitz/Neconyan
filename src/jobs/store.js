import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { acquireChatFileLock } from '../chat-file-lock.js';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { fsyncDirectorySync } from '../util.js';
import { notifyJobsChanged } from './notifications.js';

export const JOB_SCHEMA = 1;
export const JOB_LIMIT = 200;
export const JOB_RETAINED_LIMIT = 100;
export const JOB_MAX_BYTES = 2 * 1024 * 1024;
export const JOB_LEDGER_MAX_BYTES = 4 * 1024 * 1024;
// Matches the endpoint body limit so an accepted intent always fits on disk.
export const JOB_INTENT_LIMIT_BYTES = 3 * 1024 * 1024;
export const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Unresolved failures carry their whole prompt, so a day of them is enough
// time to retry; after that they are dismissed and can be cleared for space.
export const JOB_FAILURE_RETENTION_MS = 24 * 60 * 60 * 1000;
// A tab may still be applying a reply that finished moments ago.
export const JOB_CLEAR_GRACE_MS = 10 * 60 * 1000;
const PROCESS_STARTED_AT = Date.now();

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
const pruneHolds = new Set();
let historyLifecycle = null;

/** Native Distiller evidence must survive every removal path, before artefacts go. */
export function registerJobHistoryLifecycle(lifecycle) { historyLifecycle = lifecycle; }

/**
 * The jobs runner polls every 500 ms per owner, and every artifact read checks
 * that its job exists. Keep both the ledger text and its parsed object while
 * the file identity is unchanged. Accessors hand out clones (or a key check)
 * so a caller can never mutate the shared store; `mutateJobs` always parses its
 * own copy before applying a patch.
 */
const ledgerTextCache = new Map();
const ledgerStoreCache = new Map();
const LEDGER_CACHE_MAX_ENTRIES = 16;
// Parsed stores take roughly 1.5 times their source bytes. Bound them by source
// bytes as well as accounts so many full ledgers cannot grow unbounded.
const LEDGER_STORE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
let ledgerStoreCacheBytes = 0;

function ledgerIdentity(stat) {
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function sameLedgerIdentity(cached, stat) {
    return cached.dev === stat.dev && cached.ino === stat.ino && cached.size === stat.size
        && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs;
}

function deleteLedgerStore(filename) {
    const cached = ledgerStoreCache.get(filename);
    if (!cached) return;
    ledgerStoreCache.delete(filename);
    ledgerStoreCacheBytes -= cached.bytes;
}

function trimLedgerStore() {
    while (ledgerStoreCache.size > LEDGER_CACHE_MAX_ENTRIES || ledgerStoreCacheBytes > LEDGER_STORE_CACHE_MAX_BYTES) {
        const oldest = ledgerStoreCache.keys().next().value;
        if (oldest === undefined) break;
        deleteLedgerStore(oldest);
    }
}

function invalidateLedger(filename) {
    ledgerTextCache.delete(filename);
    deleteLedgerStore(filename);
}

function readLedgerText(filename) {
    let stat;
    try {
        stat = fs.statSync(filename);
    } catch (error) {
        if (error.code === 'ENOENT') {
            invalidateLedger(filename);
            return null;
        }
        throw fail(500, 'JOB_STORE_UNREADABLE', 'Neconyan could not read the saved job list. Try again in a moment.');
    }
    if (!stat.isFile()) throw fail(500, 'JOB_STORE_UNREADABLE', 'The saved job list is not a file. Ask the server owner to fix it.');
    if (stat.size > JOB_LEDGER_MAX_BYTES) throw fail(409, 'JOB_STORE_RECOVERABLE', 'The saved job list is damaged and was left untouched, so recent job history cannot be trusted. The server owner needs to repair or remove the saved job list file.');
    const cached = ledgerTextCache.get(filename);
    if (cached && sameLedgerIdentity(cached, stat)) {
        return { text: cached.text, identity: cached };
    }
    let text;
    try {
        text = fs.readFileSync(filename, 'utf8');
    } catch {
        throw fail(409, 'JOB_STORE_RECOVERABLE', 'The saved job list is damaged and was left untouched, so recent job history cannot be trusted. The server owner needs to repair or remove the saved job list file.');
    }
    const identity = ledgerIdentity(stat);
    ledgerTextCache.set(filename, { ...identity, text });
    while (ledgerTextCache.size > LEDGER_CACHE_MAX_ENTRIES) {
        ledgerTextCache.delete(ledgerTextCache.keys().next().value);
    }
    return { text, identity };
}

/** Keep upgrade evidence until the account's durable ownership has been copied. */
export function holdJobPruning(owner, held = true) {
    if (held) pruneHolds.add(owner);
    else pruneHolds.delete(owner);
}

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
export function canonical(value) {
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
function readStore(directories, { mutable = false } = {}) {
    const filename = storePath(directories);
    let raw;
    try {
        raw = readLedgerText(filename);
    } catch (error) {
        if (error.status) throw error;
        throw fail(500, 'JOB_STORE_UNREADABLE', 'Neconyan could not read the saved job list. Try again in a moment.');
    }
    if (raw === null) return emptyStore();
    if (!mutable) {
        const cached = ledgerStoreCache.get(filename);
        if (cached && sameLedgerIdentity(cached, raw.identity)) {
            ledgerStoreCache.delete(filename);
            ledgerStoreCache.set(filename, cached);
            return cached.store;
        }
    }
    let store;
    try {
        store = JSON.parse(raw.text);
    } catch {
        throw fail(409, 'JOB_STORE_RECOVERABLE', 'The saved job list is damaged and was left untouched, so recent job history cannot be trusted. The server owner needs to repair or remove the saved job list file.');
    }
    if (!store || store.schema !== JOB_SCHEMA || typeof store.jobs !== 'object' || store.jobs === null || Array.isArray(store.jobs)) {
        throw fail(409, 'JOB_STORE_INCOMPATIBLE', 'The saved job list uses a format this version of Neconyan cannot read.');
    }
    if (!mutable) {
        deleteLedgerStore(filename);
        const bytes = Number(raw.identity.size);
        ledgerStoreCache.set(filename, { ...raw.identity, bytes, store });
        ledgerStoreCacheBytes += bytes;
        trimLedgerStore();
    }
    return store;
}

const finishedCleanly = job => ['completed', 'cancelled'].includes(job.state);
const unresolvedFailure = job => isTerminal(job) && !finishedCleanly(job) && !job.dismissed;
// `retainedReply` only marks records from releases that showed the Recovered
// reply card; new jobs never set it. An old record is neither expired nor
// evicted, so no ordinary ledger write can discard the last copy of a paid
// reply before the upgrade migration has claimed it.
const failureExpired = (job, at = now()) => unresolvedFailure(job) && !job.retainedReply
    && (job.finishedAt ?? job.updatedAt ?? 0) <= at - JOB_FAILURE_RETENTION_MS;
const baseRemovable = job => finishedCleanly(job) || (isTerminal(job) && (job.dismissed || failureExpired(job)));

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

const removable = (job, jobs = {}) => !pruneHolds.has(job.owner) && !historyLifecycle?.keep(job) && baseRemovable(job) && !familyLocked(job, jobs);
// Last resort when the ledger is over a limit: a recent unresolved failure may
// go so new work is never refused because of old mistakes.
const evictableFailure = (job, jobs = {}) => !pruneHolds.has(job.owner) && unresolvedFailure(job)
    && !historyLifecycle?.keep(job) && !job.retainedReply && !familyLocked(job, jobs);

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
    if (keep.size > JOB_LIMIT) {
        const failures = nonTerminal
            .filter(([, job]) => job.id !== protectedId && evictableFailure(job, jobs))
            .sort(([, left], [, right]) => (left.updatedAt ?? 0) - (right.updatedAt ?? 0));
        for (const [key] of failures) {
            if (keep.size <= JOB_LIMIT) break;
            keep.delete(key);
        }
    }
    for (const [key, job] of terminal) {
        if (keep.size >= JOB_LIMIT) break;
        if (keep.size >= JOB_RETAINED_LIMIT && (job.updatedAt ?? 0) <= now() - JOB_RETENTION_MS) continue;
        keep.add(key);
    }
    return Object.fromEntries(entries.filter(([key]) => keep.has(key)));
}

function dismissExpiredFailures(jobs) {
    const at = now();
    for (const job of Object.values(jobs)) {
        if (!failureExpired(job, at)) continue;
        job.dismissed = true;
        job.dismissedReason = 'expired';
    }
}

function writeStore(directories, store, protectedId, previousJobs = { ...store.jobs }) {
    // The server accepts requests before startup recovery runs, and any write
    // here expires and prunes. Claim old Recovered copies on this ledger's first
    // write before that race can discard the last saved reply.
    ensureRetainedReplyProtection(directories, store);
    dismissExpiredFailures(store.jobs);
    const ordered = { ...store, jobs: pruneJobs(store.jobs, protectedId) };
    ordered.revision += 1;
    ordered.updatedAt = now();
    let text = JSON.stringify(ordered);
    for (const canDrop of [removable, evictableFailure]) {
        for (const [key, job] of Object.entries(ordered.jobs).sort(([, a], [, b]) => a.updatedAt - b.updatedAt)) {
            if (Buffer.byteLength(text) <= JOB_LEDGER_MAX_BYTES) break;
            if (job.id === protectedId || !canDrop(job, ordered.jobs)) continue;
            delete ordered.jobs[key];
            text = JSON.stringify(ordered);
        }
    }
    if (Buffer.byteLength(text) > JOB_LEDGER_MAX_BYTES) {
        throw fail(413, 'JOB_STORE_FULL', 'Too many jobs for this account are still unfinished. Wait for some to finish, or use User Settings > Clear job history.');
    }
    const removed = Object.entries(previousJobs).filter(([key]) => !ordered.jobs[key]).map(([, job]) => job);
    historyLifecycle?.beforeRemove(directories, removed);
    fs.mkdirSync(stateDir(directories), { recursive: true, mode: 0o700 });
    const filename = storePath(directories);
    writeFileAtomicSync(filename, text, { mode: 0o600 });
    // The returned job objects belong to the caller, so never share the written
    // store. Keep the immutable text; the next reader parses one fresh copy.
    invalidateLedger(filename);
    try {
        const stat = fs.statSync(filename);
        const identity = ledgerIdentity(stat);
        ledgerTextCache.set(filename, { ...identity, text });
        while (ledgerTextCache.size > LEDGER_CACHE_MAX_ENTRIES) {
            ledgerTextCache.delete(ledgerTextCache.keys().next().value);
        }
    } catch { /* The next read reports the real problem. */ }
    // Delete artifacts only after the ledger no longer references their job.
    for (const key of Object.keys(previousJobs)) {
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
    const action = () => mutateJobsLocked(directories, mutate);
    return historyLifecycle ? historyLifecycle.withMutation(directories, action) : action();
}

function mutateJobsLocked(directories, mutate) {
    const release = acquireChatFileLock(storePath(directories));
    try {
        // A mutation owns and may rewrite every job object, so it must not use
        // the shared parsed copy that readers receive.
        const store = readStore(directories, { mutable: true });
        const previousOwner = Object.values(store.jobs)[0]?.owner;
        const queued = new Set(Object.values(store.jobs).filter(job => job.state === 'queued').map(job => job.id));
        const previousJobs = { ...store.jobs };
        const result = mutate(store);
        if (result?.changed === false) {
            delete result.removedJobs;
            return result;
        }
        // Explicit cleanup annotates the objects before deletion; preserve its reason.
        const beforeRemoval = { ...previousJobs, ...store.jobs };
        for (const job of result?.removedJobs ?? []) beforeRemoval[jobKey(job.id)] = job;
        const written = writeStore(directories, store, result?.job?.id, beforeRemoval);
        const jobs = Object.values(written.jobs);
        const owner = result?.job?.owner ?? jobs[0]?.owner ?? previousOwner;
        if (owner) notifyJobsChanged({ owner, queued: jobs.some(job => job.state === 'queued' && !queued.has(job.id)),
            ...(result?.job?.id ? { id: result.job.id, state: result.job.state } : {}) });
        const publicResult = { ...result };
        delete publicResult.removedJobs;
        return { ...publicResult, revision: written.revision };
    } finally {
        release();
    }
}

/**
 * Move the account's job ledger and artefacts aside for a data reset. Renames keep
 * already-durable bytes, repeat safely after a crash, and leave late writers an
 * empty ledger that no longer knows their job.
 */
export function retireJobStore(directories, destination) {
    const release = acquireChatFileLock(storePath(directories));
    try {
        fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
        for (const name of [STORE_FILE, 'artifacts']) {
            const source = path.join(stateDir(directories), name);
            const target = path.join(destination, name);
            if (fs.existsSync(source) && !fs.existsSync(target)) fs.renameSync(source, target);
        }
        fsyncDirectorySync(destination);
        invalidateLedger(storePath(directories));
        for (const name of fs.readdirSync(stateDir(directories))) {
            if (!name.endsWith('.lock')) fs.rmSync(path.join(stateDir(directories), name), { recursive: true, force: true });
        }
        fsyncDirectorySync(stateDir(directories));
    } finally {
        release();
    }
}

export function readJobStore(directories) {
    return structuredClone(readStore(directories));
}

export function listJobs(directories, { owner, includeDismissed = false } = {}) {
    // The runner lists every owner twice per poll. Cloning every job from the
    // shared cache costs about twice a fresh parse, so this accessor parses its
    // own isolated copy and skips the clone. getJob and hasJob keep the cache.
    const store = readStore(directories, { mutable: true });
    return Object.values(store.jobs)
        .filter(job => owner === undefined || job.owner === owner)
        .filter(job => includeDismissed || job.dismissed !== true)
        .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
}

export function getJob(directories, id) {
    const job = readStore(directories).jobs[jobKey(id)];
    return job ? structuredClone(job) : null;
}

/** Existence-only check for artifact paths; never exposes the shared job object. */
export function hasJob(directories, id) {
    return Boolean(readStore(directories).jobs[jobKey(id)]);
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
                throw fail(409, 'JOB_SUBMISSION_CONFLICT', 'This request was already sent with different details. Start it again as a new request.');
            }
            return { job, created: false, changed: false, revision: store.revision };
        }
        // Refuse before persisting when this record could not be saved, rather
        // than throwing away the caller's just-accepted identity.
        if (Object.keys(store.jobs).length >= JOB_LIMIT) {
            const hasRemovable = Object.values(store.jobs).some(job => removable(job, store.jobs) || evictableFailure(job, store.jobs));
            if (!hasRemovable) {
                throw fail(503, 'JOB_STORE_FULL', 'Too many jobs for this account are still unfinished or unresolved. Wait for some to finish, or use User Settings > Clear job history.');
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
        if (!parent) throw fail(404, 'JOB_NOT_FOUND', 'The job this belongs to no longer exists.');
        const children = [];
        for (const input of inputs) {
            const participantKey = input?.participantKey;
            if (typeof participantKey !== 'string' || !participantKey || participantKey.length > 256) {
                throw fail(400, 'JOB_INVALID', 'A participant key is required.');
            }
            const key = `child:${parentId}:${participantKey}`;
            const existing = Object.values(store.jobs).find(job => job.owner === parent.owner && job.submissionKey === key);
            if (existing) {
                if (existing.parentId !== parentId) throw fail(409, 'JOB_SUBMISSION_CONFLICT', 'This participant was already sent with different details.');
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

/** Attach a privately admitted child before releasing it, retaining its evidence for a live root. */
export function attachOwnedChild(directories, parentId, childId, { parentIntentHash, childIntentHash } = {}) {
    return mutateJobs(directories, store => {
        const parent = store.jobs[jobKey(parentId)];
        const child = store.jobs[jobKey(childId)];
        if (!parent || !child || parent.id !== parentId || child.id !== childId
            || parent.owner !== child.owner || crypto.createHash('sha256').update(canonical(parent.intent)).digest('hex') !== parentIntentHash
            || crypto.createHash('sha256').update(canonical(child.intent)).digest('hex') !== childIntentHash) {
            throw fail(409, 'JOB_FAMILY_CONFLICT', 'One of the saved workflow steps does not belong to the job it was started from.');
        }
        const vectorChild = ['roleplay.reply', 'roleplay.candidate'].includes(parent.type) && child.type === 'operations.vectors';
        const conversationTool = ['conversation.participant', 'conversation.reply'].includes(parent.type)
            && child.type === 'media.assistant-tool' && child.intent?.source?.kind === 'conversation-assistant'
            && child.intent.source.instanceId === parentId;
        if (parent.type !== 'media.roleplay-workflow' && !vectorChild && !conversationTool || child.parentId && child.parentId !== parentId
            || isTerminal(parent) || parent.cancellation?.requested || child.cancellation?.requested) {
            throw fail(409, 'JOB_FAMILY_CONFLICT', 'The saved workflow changed before one of its steps could run.');
        }
        if (!['waiting', 'queued', 'running', ...TERMINAL_STATES].includes(child.state)
            || (parent.children ?? []).length >= 128 && !parent.children.includes(childId)) {
            throw fail(409, 'JOB_FAMILY_CONFLICT', 'The workflow cannot keep another step result.');
        }
        if (child.parentId === parentId && parent.children.includes(childId)) return { job: parent, child, changed: false };
        child.parentId = parentId;
        child.updatedAt = now();
        parent.children = [...new Set([...(parent.children ?? []), childId])];
        parent.updatedAt = now();
        return { job: parent, child };
    });
}

/**
 * Release a parent's frozen children for dispatch and park the parent at
 * `waiting/children`. The parent holds its target but consumes no running slot,
 * so its children can take the account's provider slots. Safe to repeat.
 */
export function releaseChildJobs(directories, parentId) {
    return mutateJobs(directories, store => {
        const parent = store.jobs[jobKey(parentId)];
        if (!parent) throw fail(404, 'JOB_NOT_FOUND', 'The job this belongs to no longer exists.');
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
        if (!job) throw fail(404, 'JOB_NOT_FOUND', 'This job no longer exists.');
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
        if (!job) throw fail(404, 'JOB_NOT_FOUND', 'This job no longer exists.');
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
        if (!job) throw fail(404, 'JOB_NOT_FOUND', 'This job no longer exists.');
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
        const descendants = [...(job.children ?? [])];
        const visited = new Set([job.id]);
        for (const childId of descendants) {
            if (visited.has(childId)) continue;
            visited.add(childId);
            const child = store.jobs[jobKey(childId)];
            if (!child || child.owner !== job.owner) continue;
            descendants.push(...(child.children ?? []));
            if (TERMINAL_STATES.includes(child.state)) continue;
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
        if (!job) throw fail(404, 'JOB_NOT_FOUND', 'This job no longer exists.');
        job.dismissed = true;
        job.dismissedReason = 'user';
        job.updatedAt = now();
        // The client only ever sees the root, so dismissing it must also dismiss
        // the participants that would otherwise keep the family in the ledger.
        for (const childId of job.children ?? []) {
            const child = store.jobs[jobKey(childId)];
            if (!child) continue;
            child.dismissed = true;
            child.dismissedReason = 'user';
            child.updatedAt = now();
        }
        return { job };
    });
}

/**
 * The owner's "Clear job history": dismiss every unresolved failure and delete
 * every finished record that nothing still depends on. Unfinished work stays,
 * and so do replies finished in the last few minutes that a tab may be applying.
 */
export function clearFinishedJobs(directories, { owner } = {}) {
    return mutateJobs(directories, store => {
        const at = now();
        const mine = Object.entries(store.jobs).filter(([, job]) => owner === undefined || job.owner === owner);
        let dismissed = 0;
        for (const [, job] of mine) {
            if (!unresolvedFailure(job)) continue;
            job.dismissed = true;
            job.dismissedReason = 'cleared';
            job.updatedAt = at;
            dismissed += 1;
        }
        const recent = job => job.state === 'completed' && (job.finishedAt ?? job.updatedAt ?? 0) > at - JOB_CLEAR_GRACE_MS;
        const pinned = job => recent(job) || [job.parentId, ...(job.children ?? [])]
            .some(id => id && recent(store.jobs[jobKey(id)] ?? {}));
        const doomed = mine.filter(([, job]) => removable(job, store.jobs) && !pinned(job)).map(([key]) => key);
        const removedJobs = doomed.map(key => store.jobs[key]);
        for (const key of doomed) delete store.jobs[key];
        const remaining = Object.values(store.jobs).filter(job => owner === undefined || job.owner === owner).length;
        return { changed: dismissed > 0 || doomed.length > 0, removed: doomed.length, dismissed, remaining, removedJobs };
    });
}

/**
 * An explicit retry is the owner's deliberate decision to ask the provider
 * again, so unknown provider steps are released; saved results still replay.
 */
export function explicitRetryRecovery(job) {
    return { recoverability: 'resumable', recoveryStep: null, recoverySteps: [],
        resume: typeof job.resume === 'string' && job.resume.startsWith('provider:') ? null : job.resume ?? null };
}

/**
 * Reopen a Conversation family after an explicit retry. Only failed or unknown
 * participants are requeued; completed ones keep their saved output. The root
 * returns to `waiting/children` so the worker aggregates again.
 */
export function retryConversationFamily(directories, id) {
    return mutateJobs(directories, store => {
        const root = store.jobs[jobKey(id)];
        if (!root) throw fail(404, 'JOB_NOT_FOUND', 'This job no longer exists.');
        let changed = false;
        const retryChild = child => {
            if (!child || !['failed', 'interrupted'].includes(child.state)) return;
            for (const nestedId of child.children ?? []) {
                const nested = store.jobs[jobKey(nestedId)];
                if (nested?.parentId === child.id && nested.type === 'media.assistant-tool') retryChild(nested);
            }
            child.state = child.children?.length ? 'waiting' : 'queued';
            child.stage = child.children?.length ? 'children' : null;
            child.error = null;
            child.result = null;
            child.finishedAt = null;
            Object.assign(child, explicitRetryRecovery(child));
            child.attempt += 1;
            child.updatedAt = now();
            changed = true;
        };
        for (const childId of root.children ?? []) {
            retryChild(store.jobs[jobKey(childId)]);
        }
        if (!changed) throw fail(409, 'JOB_NOT_RETRYABLE', 'None of the replies in this Conversation can be retried.');
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
    return updateJob(directories, id, job => ({
        recoverability: 'unknown-outcome', recoveryStep: step,
        recoverySteps: [...new Set([...providerRecoverySteps(job).filter(key => !hasSavedProviderResult(directories, job, key)), step])]
            .filter(key => typeof key === 'string' && key.startsWith('provider:')),
    }));
}

/** Save the recoverable result before the uncertainty is cleared. */
export function markProviderSettled(directories, id, step = null) {
    return updateJob(directories, id, job => {
        const remaining = step === null ? [] : providerRecoverySteps(job)
            .filter(key => key !== step && !hasSavedProviderResult(directories, job, key));
        return { recoverability: remaining.length ? 'unknown-outcome' : job.resume ? 'resumable' : 'settled',
            recoveryStep: remaining.at(-1) ?? null, recoverySteps: remaining };
    });
}

/** A server-side checkpoint nominates the next safe step after a restart. */
export function setJobResume(directories, id, step) {
    return updateJob(directories, id, job => ({ resume: typeof step === 'string' && step ? step : null,
        recoverability: job.recoverability === 'unknown-outcome' || providerRecoverySteps(job).length ? 'unknown-outcome' : 'resumable' }));
}

export function providerRecoverySteps(job) {
    if (job?.recoverySteps !== undefined && !Array.isArray(job.recoverySteps)) {
        throw Object.assign(new Error('Saved records of earlier AI requests need repair.'), { status: 409 });
    }
    return [...new Set([...(job?.recoverySteps ?? []), job?.recoveryStep])]
        .filter(step => typeof step === 'string' && step.startsWith('provider:'));
}

function hasSavedProviderResult(directories, job, step = job.recoveryStep) {
    if (typeof step !== 'string' || !step.startsWith('provider:') || !step.slice(9)) return false;
    const filename = path.join(stateDir(directories), 'artifacts', jobKey(job.id), jobKey(step) + '.json');
    try {
        if (fs.statSync(filename).size > 16 * 1024 * 1024) return false;
        return JSON.parse(fs.readFileSync(filename, 'utf8')) !== undefined;
    } catch {
        return false;
    }
}

const LEGACY_REPLY_UPGRADE = 'retainedReplyUpgrade';
const RETAINED_REPLY_MIGRATION = 1;
const LEGACY_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
const LEGACY_REPLY_MISSING = 'The finished reply from the previous version was kept in job history, but its saved model result is missing, so it was not sent again.';
const LEGACY_REPLY_CONFLICT = 'Another step of this saved reply needs recovery, so the finished reply was kept in job history and was not written to the chat.';
const SAVED_PROVIDER_STEP = /^provider:[a-f0-9]{64}$/;
const retryableDismissal = reason => reason === 'restart' || reason === 'expired';

function readStoredArtifact(directories, id, name) {
    const filename = path.join(stateDir(directories), 'artifacts', jobKey(id), jobKey(name) + '.json');
    try {
        if (fs.statSync(filename).size > LEGACY_ARTIFACT_MAX_BYTES) return undefined;
        return JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch {
        return undefined;
    }
}

/** The one startup migration that must add evidence uses the same artifact shape. */
function writeStoredArtifact(directories, id, name, value) {
    const filename = path.join(stateDir(directories), 'artifacts', jobKey(id), jobKey(name) + '.json');
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    writeFileAtomicSync(filename, JSON.stringify(value), { mode: 0o600 });
}

function storedIntentHash(value) {
    return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

const completedLegacyPreview = value => Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && !['preparing', 'generating'].includes(value.stage) && (value.text || value.reasoning));

/**
 * The Recovered reply card wrote a finished display copy beside the workflow
 * root. `retainedReply` alone is also evidence: a crash can leave the flag
 * without its artifact, and that copy must still survive the upgrade.
 */
function legacyRoleplayReply(directories, job, { previewOnly = false } = {}) {
    if (job?.type !== 'media.roleplay-workflow' || job.parentId) return null;
    // Only the one-time upgrade scan treats a completed display copy as legacy
    // by itself. Every later pass requires the durable flag that scan writes.
    if (!previewOnly && !job.retainedReply) return null;
    const recovery = readStoredArtifact(directories, job.id, 'roleplay-recovery');
    if (completedLegacyPreview(recovery)) return recovery;
    const preview = readStoredArtifact(directories, job.id, 'roleplay-preview');
    if (completedLegacyPreview(preview)) return preview;
    return job.retainedReply ? { missing: true } : null;
}

/**
 * Claim every old retained reply before failure expiry or pruning can dismiss
 * it. This is the only place that writes `retainedReply`, and it only finds
 * terminal records the old Recovered reply card left behind.
 */
function protectLegacyRoleplayReplies(directories, jobs, { previewOnly = false } = {}) {
    let changed = false;
    for (const job of Object.values(jobs)) {
        if (!isTerminal(job) || job.state === 'completed') continue;
        if (!legacyRoleplayReply(directories, job, { previewOnly })) continue;
        if (!job.retainedReply) {
            job.retainedReply = true;
            changed = true;
        }
        // Old start-up code un-dismissed these two automatic reasons; an explicit
        // user dismissal or a cleared history stays final.
        if (job.dismissed && retryableDismissal(job.dismissedReason)) {
            job.dismissed = false;
            delete job.dismissedReason;
            changed = true;
        }
    }
    return changed;
}

/** Claim old replies once, before this ledger's first expiry or prune, and persist that fact. */
function ensureRetainedReplyProtection(directories, store) {
    if (store.retainedReplyMigration === RETAINED_REPLY_MIGRATION) return false;
    // An absent ledger must stay absent until real work is accepted.
    if (Object.keys(store.jobs).length === 0) return false;
    protectLegacyRoleplayReplies(directories, store.jobs, { previewOnly: true });
    store.retainedReplyMigration = RETAINED_REPLY_MIGRATION;
    return true;
}

const savedReplyResult = value => value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.text === 'string';

function savedLegacyProviderResult(directories, job, reference) {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)
        || typeof reference.intentHash !== 'string' || !/^[a-f0-9]{64}$/.test(reference.intentHash)
        || typeof reference.step !== 'string' || !SAVED_PROVIDER_STEP.test(reference.step)) return false;
    const completed = readStoredArtifact(directories, job.id, reference.step);
    // A Horde result replaces the staging value with the paid payload under its
    // own artifact. Missing that payload must never fall through to a new call.
    if (job.intent?.request?.binding?.backend === 'horde' && completed && typeof completed === 'object'
        && !Array.isArray(completed) && completed.id) {
        return savedReplyResult(readStoredArtifact(directories, job.id, 'horde-result:' + reference.step.slice(9)));
    }
    return savedReplyResult(completed);
}

function hasSavedLegacyMainResult(directories, job) {
    // A saved output is replayed before any provider reference is considered.
    // A damaged value still stops early in the execution path instead of
    // sending a new main request.
    if (readStoredArtifact(directories, job.id, 'roleplay-output') !== undefined) return true;
    return savedLegacyProviderResult(directories, job,
        readStoredArtifact(directories, job.id, 'roleplay-main-provider'));
}

const HELPER_REPLY_RECOVERY = 'helperReplyRecovery';

/**
 * A restart can leave a workflow child interrupted because a post-reply Agent,
 * translation or speech request has no saved answer, while the main reply
 * itself is complete. The paid main result is provable. Record the same failure
 * stop that a live failed Agent pass writes, then release the child through the
 * normal save path. The stop prevents Agent work; the retained unknown steps
 * also stop every optional translation or speech request before dispatch. A
 * genuinely unknown main result never reaches this branch.
 */
function recoverUnknownHelperReplies(directories, jobs, { hold = false } = {}) {
    if (hold) return false;
    let changed = false;
    const postMainProviderStep = step => SAVED_PROVIDER_STEP.test(step)
        || step.startsWith('provider:translation:')
        || step.startsWith('provider:speech:');
    for (const child of Object.values(jobs)) {
        if (child.type !== 'roleplay.candidate' || !child.parentId) continue;
        if (!['interrupted', 'failed'].includes(child.state)) continue;
        // A queued retry is allowed to continue across another restart, but a
        // failed migrated attempt stops here and stays visible for the owner.
        if (child[HELPER_REPLY_RECOVERY] === 'queued' && child.state !== 'interrupted') continue;
        if (child.cancellation?.requested
            || child.dismissed && !retryableDismissal(child.dismissedReason)) continue;
        const request = child.intent?.request;
        const worldInfo = request?.worldInfo;
        // Optional work also runs without Agents, so either feature is enough.
        if (!worldInfo?.agents && !worldInfo?.translation && !worldInfo?.speech) continue;
        const parent = jobs[jobKey(child.parentId)];
        if (!parent || parent.type !== 'media.roleplay-workflow' || parent.owner !== child.owner
            || !(parent.children ?? []).includes(child.id) || !parent.intent?.media || !parent.intent?.source
            || parent.cancellation?.requested || parent.state === 'completed'
            || parent.dismissed && !retryableDismissal(parent.dismissedReason)) continue;
        // Post-main uncertainty is plain Agent steps plus outgoing translation
        // and speech. Captions and other pre-main named steps stay excluded.
        const missing = providerRecoverySteps(child).filter(step => !hasSavedProviderResult(directories, child, step));
        if (!missing.length || missing.some(step => !postMainProviderStep(step))) continue;
        if (missing.some(step => step.startsWith('provider:translation:')) && !worldInfo.translation) continue;
        if (missing.some(step => step.startsWith('provider:speech:')) && !worldInfo.speech) continue;
        const intentHash = storedIntentHash(child.intent);
        const main = readStoredArtifact(directories, child.id, 'roleplay-main-provider');
        if (!main || main.intentHash !== intentHash || !savedLegacyProviderResult(directories, child, main)
            || missing.includes(main.step)) continue;
        const candidates = (parent.children ?? []).map(id => jobs[jobKey(id)])
            .filter(candidate => candidate?.type === 'roleplay.candidate');
        if (candidates.some(candidate => candidate.id !== child.id && candidate.state !== 'completed')) continue;
        const stop = readStoredArtifact(directories, child.id, 'roleplay-agent-stop');
        if (stop !== undefined && (stop?.reason !== 'failed' || stop?.intentHash !== intentHash)) continue;
        try {
            if (stop === undefined) {
                writeStoredArtifact(directories, child.id, 'roleplay-agent-stop', { intentHash, reason: 'failed' });
            }
        } catch {
            continue;
        }
        if (child.dismissed) {
            child.dismissed = false;
            delete child.dismissedReason;
        }
        if (parent.dismissed) {
            parent.dismissed = false;
            delete parent.dismissedReason;
        }
        child[HELPER_REPLY_RECOVERY] = 'queued';
        child.state = 'queued';
        child.stage = null;
        child.finishedAt = null;
        child.result = null;
        child.error = null;
        // Deliberately keep the unknown post-main steps: they stay blocked if
        // any later path tries the helper or optional work before the stop is read.
        parent.state = 'waiting';
        parent.stage = 'children';
        parent.finishedAt = null;
        parent.error = null;
        changed = true;
    }
    return changed;
}

/**
 * Finish old Recovered replies through the current workflow and save path.
 * Only already-paid work is released: a missing or unknown main result is
 * preserved and reported instead, because the upgrade must never send the
 * main request again. The marker makes a failed attempt terminal; the owner's
 * normal Retry stays available and the reason remains on the job.
 */
function upgradeLegacyRoleplayReplies(directories, jobs, { hold = false } = {}) {
    let changed = false;
    const mark = (job, status) => {
        job[LEGACY_REPLY_UPGRADE] = status;
        changed = true;
    };
    const preserve = (job, message = null) => {
        mark(job, 'preserved');
        if (!message) return;
        if (!isTerminal(job)) {
            job.state = 'interrupted';
            job.finishedAt = now();
        }
        job.stage = 'child-needs-recovery';
        job.error = { code: 'ROLEPLAY_REPLY_PRESERVED', message };
        job.recoverability = 'needs-retry';
    };
    for (const job of Object.values(jobs)) {
        const reply = legacyRoleplayReply(directories, job);
        if (!reply) continue;
        if (job.state === 'completed') continue;
        const status = job[LEGACY_REPLY_UPGRADE];
        if (status === 'queued' || status === 'preserved') continue;
        // A restart or expiry dismissal is automatic, even when the one-time
        // scan has already marked this ledger. Only a real owner dismissal is final.
        if (job.dismissed && retryableDismissal(job.dismissedReason)) {
            job.dismissed = false;
            delete job.dismissedReason;
            changed = true;
        }
        if (job.state === 'cancelled' || job.cancellation?.requested || job.dismissed) {
            // The owner stopped or dismissed this reply; keep the record, never
            // schedule a write they already refused.
            mark(job, 'preserved');
            continue;
        }
        if (hold) {
            if (status === 'paused') continue;
            mark(job, 'paused');
            if (!isTerminal(job)) {
                job.state = 'interrupted';
                job.stage = null;
                job.finishedAt = now();
            }
            job.error = { code: 'SAFE_START',
                message: 'Neconyan restarted in safe mode, so this saved reply was left untouched. Start normally to finish saving it.' };
            continue;
        }
        if (reply.missing) {
            preserve(job, LEGACY_REPLY_MISSING);
            continue;
        }
        const childId = reply.childId;
        const child = typeof childId === 'string' ? jobs[jobKey(childId)] : null;
        if (!child || child.parentId !== job.id || !(job.children ?? []).includes(child.id)
            || child.owner !== job.owner || child.type !== 'roleplay.candidate'
            || !job.intent?.media || !job.intent?.source) {
            preserve(job, LEGACY_REPLY_MISSING);
            continue;
        }
        if (child.cancellation?.requested || child.state === 'cancelled') {
            mark(job, 'preserved');
            continue;
        }
        if (child.dismissed) {
            if (!retryableDismissal(child.dismissedReason)) {
                mark(job, 'preserved');
                continue;
            }
            child.dismissed = false;
            delete child.dismissedReason;
            changed = true;
        }
        const candidates = (job.children ?? []).map(id => jobs[jobKey(id)])
            .filter(candidate => candidate?.type === 'roleplay.candidate');
        const otherFailed = candidates.find(candidate => candidate.id !== child.id
            && ['failed', 'interrupted', 'conflict', 'cancelled'].includes(candidate.state));
        if (otherFailed) {
            preserve(job, LEGACY_REPLY_CONFLICT);
            continue;
        }
        if (child.state === 'completed') {
            const active = candidates.find(candidate => candidate.id !== child.id && candidate.state !== 'completed');
            if (active) {
                job.state = 'waiting';
                job.stage = 'children';
                job.finishedAt = null;
                job.error = null;
            } else {
                job.state = 'queued';
                job.stage = 'children-completed';
                job.finishedAt = null;
                job.error = null;
            }
            mark(job, 'queued');
            continue;
        }
        if (!['failed', 'interrupted', 'conflict'].includes(child.state)) {
            // The existing waiting resolver owns this transition once the child
            // reaches a terminal state.
            job.state = 'waiting';
            job.stage = 'children';
            job.finishedAt = null;
            job.error = null;
            mark(job, 'queued');
            continue;
        }
        if (child.error?.code === 'ROLEPLAY_SOURCE_CHANGED') {
            mark(job, 'preserved');
            continue;
        }
        if (!hasSavedLegacyMainResult(directories, child)) {
            preserve(job, LEGACY_REPLY_MISSING);
            continue;
        }
        // Release only the one paid child through the ordinary execution path.
        // Its saved prompt and provider result are verified there again before
        // any Agent work, and a changed chat still refuses the write. Automatic
        // upgrade must not call explicitRetryRecovery: clearing saved
        // uncertainty here could dispatch another optional or Agent request.
        child.state = 'queued';
        child.stage = null;
        child.finishedAt = null;
        child.result = null;
        child.error = null;
        job.state = 'waiting';
        job.stage = 'children';
        job.finishedAt = null;
        job.error = null;
        mark(job, 'queued');
    }
    return changed;
}

/**
 * Start-up reconciliation. Work that was queued but never started is recovered
 * and returned for dispatch. Work that was running when the process stopped is
 * marked interrupted unless it can be resumed from a server-saved next step; an
 * unknown provider outcome is never silently re-submitted as a charged call.
 */
export function recoverJobs(directories, { startedAt = PROCESS_STARTED_AT, hold = false } = {}) {
    return mutateJobs(directories, store => {
        const recoverable = [];
        // Claim old Recovered replies once, in the same mutation that would
        // otherwise expire or prune them, before any state below can dismiss
        // the root. The marker rides the same atomic ledger write.
        let changed = ensureRetainedReplyProtection(directories, store);
        // Safe start: work that would run again on its own is paused for a
        // deliberate retry, because replaying it may be what stopped the server.
        const pause = job => {
            changed = true;
            job.state = 'interrupted';
            job.stage = null;
            job.finishedAt = now();
            job.error = { message: 'Neconyan restarted in safe mode, so this job was paused. Retry it when you are ready.', code: 'SAFE_START' };
            job.recoverability = 'needs-retry';
        };
        for (const job of Object.values(store.jobs)) {
            // Failures from before this start are cleared away; work this very
            // restart interrupts below stays visible so it can still be retried.
            if (unresolvedFailure(job) && !job.retainedReply && (job.finishedAt ?? job.updatedAt ?? 0) < startedAt) {
                changed = true;
                job.dismissed = true;
                job.dismissedReason = 'restart';
                continue;
            }
            if (CANCELLABLE_STATES.includes(job.state) && job.cancellation?.requested) {
                changed = true;
                job.state = 'cancelled';
                job.finishedAt = now();
                continue;
            }
            const providerSteps = providerRecoverySteps(job);
            const unknown = providerSteps.some(step => !hasSavedProviderResult(directories, job, step))
                || !providerSteps.length && job.recoverability === 'unknown-outcome';
            if (job.state === 'queued' && !unknown) {
                if (hold) pause(job);
                else recoverable.push(job);
                continue;
            }
            // A saved review stays waiting for its decision, not another execution.
            if (job.state === 'running' || job.state === 'queued' && unknown) {
                changed = true;
                // The result can be saved immediately before the status write; its artifact proves a retry will not repeat the provider call.
                const savedResult = providerSteps.length > 0 && !unknown;
                const resumable = !unknown && (job.recoverability === 'resumable' || savedResult) && typeof job.resume === 'string' && job.resume;
                if (resumable && hold) {
                    pause(job);
                    continue;
                }
                if (resumable) {
                    job.state = 'queued';
                    job.stage = null;
                    if (savedResult) job.recoverability = 'resumable';
                    job.recoveredAt = now();
                    recoverable.push(job);
                    continue;
                }
                job.state = 'interrupted';
                job.finishedAt = now();
                job.error = { message: unknown ? 'The result from the AI service is unknown after a restart. Retry only if the earlier request did not go through.' : 'The server stopped before this job finished.', code: 'INTERRUPTED' };
                job.recoverability = 'needs-retry';
            }
        }
        // Recovery has settled ordinary states. A paid main reply whose only
        // lost step is a post-reply helper is released first, so the legacy
        // pass sees it as already queued rather than releasing it again.
        if (recoverUnknownHelperReplies(directories, store.jobs, { hold })) changed = true;
        // Old retained replies now join that same flow, or keep their copy with
        // a visible reason.
        if (upgradeLegacyRoleplayReplies(directories, store.jobs, { hold })) changed = true;
        return { recoverable, changed };
    });
}
