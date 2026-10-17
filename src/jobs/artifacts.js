import fs from 'node:fs';
import path from 'node:path';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { getJob, hasJob, jobKey, markProviderSettled, markProviderUncertain, providerRecoverySteps, setJobResume } from './store.js';

const MAX_BYTES = 16 * 1024 * 1024;
const preDispatchFailures = new WeakSet();
const providerScopes = new WeakMap();

/** An in-process capability permits distinct concurrent calls, never a replay of an uncertain call. */
export function createProviderScope({ directories, job }) {
    if (!hasJob(directories, job.id)) throw Object.assign(new Error('No such job.'), { status: 404 });
    const scope = Object.freeze({});
    providerScopes.set(scope, { root: path.resolve(directories.root), id: job.id, active: new Set(), refused: new Set(), priorResume: new Map() });
    return scope;
}

function scopeState(directories, id, scope) {
    const state = scope && providerScopes.get(scope);
    return state?.root === path.resolve(directories.root) && state.id === id ? state : null;
}

/** Only server preparation code may identify a failure known to precede the HTTP request. */
export function providerNotDispatched(error) {
    const failure = error && (typeof error === 'object' || typeof error === 'function') ? error : new Error(String(error));
    preDispatchFailures.add(failure);
    return failure;
}

/**
 * A provider that answered with a definite refusal produced no result, so its
 * step settles instead of staying unknown. Only statuses that promise the work
 * was not done qualify; timeouts and gateway errors stay unknown.
 */
export function isDefiniteProviderRefusal(status) {
    const code = Number(status);
    return Number.isInteger(code) && ((code >= 400 && code < 500 && code !== 408) || code === 503 || code === 529);
}

/** Mark a thrown provider refusal as a known outcome without a result. */
export function providerRefused(error) {
    return providerNotDispatched(error);
}

function artifactPath(directories, id, name) {
    if (!hasJob(directories, id)) throw Object.assign(new Error('No such job.'), { status: 404 });
    return path.join(directories.root, 'jobs', 'artifacts', jobKey(id), jobKey(name) + '.json');
}

export function readArtifact(directories, id, name) {
    const filename = artifactPath(directories, id, name);
    try {
        if (fs.statSync(filename).size > MAX_BYTES) throw new Error('The saved result is too large.');
        return JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw Object.assign(new Error('The saved result for this job is damaged and was left untouched.'), { status: 409 });
    }
}

/** Recovery may change job status without resolving an uncertain external result. */
export function unresolvedProviderStep(directories, id, { scope, currentStep } = {}) {
    const job = getJob(directories, id);
    const active = scopeState(directories, id, scope)?.active;
    return [...providerRecoverySteps(job), job?.resume].find(step => typeof step === 'string' && step.startsWith('provider:')
        && readArtifact(directories, id, step) === undefined && (step === currentStep || !active?.has(step)));
}

export function writeArtifact(directories, id, name, value, { durable = true } = {}) {
    const filename = artifactPath(directories, id, name);
    const data = JSON.stringify(value);
    if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_BYTES) {
        throw Object.assign(new Error('The result for this job is too large to save.'), { status: 413 });
    }
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    // Display-only artifacts may skip the fsync: a crash can lose the frame, but
    // never a prompt, proof or chat write, and the browser is told first anyway.
    writeFileAtomicSync(filename, data, { mode: 0o600, fsync: durable });
    return value;
}

/** Persist provider results separately from status; an uncertain call is never replayed on restart. */
export async function providerStep({ directories, job, signal, providerScope }, name, call, resultStore = {}) {
    const { readResult = readArtifact, writeResult = writeArtifact } = resultStore;
    signal.throwIfAborted();
    const key = 'provider:' + name;
    const saved = readResult(directories, job.id, key);
    if (saved !== undefined) return saved;
    if (unresolvedProviderStep(directories, job.id, { scope: providerScope, currentStep: key })) {
        throw Object.assign(new Error('The earlier request to the AI service has an unknown result, so Neconyan will not send it again automatically.'),
            { code: 'PROVIDER_OUTCOME_UNKNOWN', status: 503 });
    }
    const state = scopeState(directories, job.id, providerScope);
    const previousResume = getJob(directories, job.id)?.resume;
    // Remember the resume each parallel step replaced, so a refusal can walk
    // back past active or already-refused provider keys to the ordinary
    // checkpoint that was there before the group started.
    state?.priorResume?.set(key, previousResume);
    setJobResume(directories, job.id, key);
    markProviderUncertain(directories, job.id, { step: key });
    const active = state?.active;
    active?.add(key);
    try {
        let result;
        try { result = await call(); } catch (error) {
            if (preDispatchFailures.has(error)) {
                // Parallel callers all set `resume` before the shared check runs.
                // Only the caller that still owns the current resume may restore
                // it, and never to a sibling that was itself refused or is still
                // active. Genuinely uncertain siblings stay in recoverySteps.
                state?.refused?.add(key);
                if (getJob(directories, job.id)?.resume === key) {
                    // Walk back over provider keys that this scope is using or
                    // has refused. A non-provider checkpoint, null, or an older
                    // settled provider key is restored unchanged. Uncertain
                    // siblings remain in recoverySteps either way.
                    const restorableResume = () => {
                        let candidate = previousResume;
                        const seen = new Set([key]);
                        for (let depth = 0; depth < 64; depth++) {
                            if (typeof candidate !== 'string' || !candidate.startsWith('provider:')) return candidate;
                            if (candidate === key || seen.has(candidate)) return null;
                            if (!active?.has(candidate) && !state?.refused?.has(candidate)) return candidate;
                            seen.add(candidate);
                            if (!state?.priorResume?.has(candidate)) return null;
                            candidate = state.priorResume.get(candidate);
                        }
                        return null;
                    };
                    setJobResume(directories, job.id, restorableResume());
                }
                markProviderSettled(directories, job.id, key);
            }
            throw error;
        }
        writeResult(directories, job.id, key, result);
        markProviderSettled(directories, job.id, key);
        signal.throwIfAborted();
        return result;
    } finally {
        active?.delete(key);
    }
}
