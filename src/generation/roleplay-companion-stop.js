import { getJob } from '../jobs/store.js';
import { roleplayError } from '../roleplay-store.js';

/**
 * Stops for single Companions in a running pass. They live in memory only: a
 * stopped Companion saves a cancelled note at once, so a resumed job replays
 * that note, and a Stop that never reached a Companion before a restart only
 * lets it finish.
 */
const scopes = new Map();
const CODE = 'ROLEPLAY_COMPANION_STOPPED';
const stopped = () => roleplayError(CODE, 'This companion was stopped.', 409);

export function isRoleplayCompanionStop(error) {
    return error?.code === CODE;
}

/** Opens the stop scope for one Companion pass of a job; close it when the pass ends. */
export function openRoleplayCompanionStops(jobId, { isActive = () => true } = {}) {
    let state = scopes.get(jobId);
    if (!state) scopes.set(jobId, state = { refs: 0, stopped: new Set(), waiters: new Set(), passes: new Set() });
    state.refs++;
    const pass = { isActive };
    state.passes.add(pass);
    return {
        isStopped: agentId => state.stopped.has(agentId),
        /** A signal that aborts once every listed Companion is stopped. */
        watch(agentIds) {
            const controller = new AbortController();
            const check = () => {
                if (!controller.signal.aborted && agentIds.length && agentIds.every(id => state.stopped.has(id))) controller.abort(stopped());
            };
            state.waiters.add(check);
            check();
            return { signal: controller.signal, release: () => state.waiters.delete(check) };
        },
        close() {
            state.passes.delete(pass);
            if (--state.refs <= 0 && scopes.get(jobId) === state) scopes.delete(jobId);
        },
    };
}

/** Stops one running Companion in this job or the reply job below it. */
export function requestRoleplayCompanionStop({ directories, owner, job, agentId }) {
    if (!job || job.owner !== owner || typeof agentId !== 'string' || !agentId || agentId.length > 200) return false;
    const pending = [job.id];
    const visited = new Set();
    let found = false;
    for (const id of pending) {
        if (visited.has(id)) continue;
        visited.add(id);
        const current = id === job.id ? job : getJob(directories, id);
        if (!current || current.owner !== owner) continue;
        pending.push(...(current.children ?? []));
        if (!['running', 'queued', 'waiting'].includes(current.state)) continue;
        const state = scopes.get(id);
        if (!state || ![...state.passes].some(pass => pass.isActive(agentId))) continue;
        state.stopped.add(agentId);
        for (const check of [...state.waiters]) check();
        found = true;
    }
    return found;
}
