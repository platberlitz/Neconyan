import { getJob, updateJob } from '../jobs/store.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';

const key = 'roleplay-agent-stop';
/** Stops Neconyan makes on its own, as opposed to the owner's Stop. */
const AUTOMATIC_ROLEPLAY_AGENT_STOP_REASONS = Object.freeze(['failed', 'refused']);
const controllers = new Map();
const stopped = () => roleplayError('ROLEPLAY_AGENTS_STOPPED', 'The remaining Agents were stopped; the completed reply will be saved.', 409);

export function isRoleplayAgentStop(error) {
    return error?.code === 'ROLEPLAY_AGENTS_STOPPED';
}

export function roleplayAgentsStopped({ directories, job }) {
    const saved = readArtifact(directories, job.id, key);
    if (saved === undefined) return false;
    if (saved.intentHash !== roleplayHash(job.intent)) throw roleplayError('ROLEPLAY_AGENT_RECOVERY', 'The saved Agent stop belongs to a different request.', 409);
    return true;
}

/**
 * Keep the paid main reply when its after-reply Agents failed for good. The
 * saved decision makes the next Agent pass skip the remaining work, exactly
 * like the owner's Stop, but records that failure caused the stop.
 */
export function markRoleplayAgentsFailed(context) {
    return markAutomaticRoleplayAgentStop(context, 'failed');
}

/**
 * Keep a main reply that reads as a model refusal and skip its after-reply
 * Agents and Companions, so none of them rewrites or answers the refusal.
 */
export function markRoleplayAgentsRefused(context) {
    return markAutomaticRoleplayAgentStop(context, 'refused');
}

function markAutomaticRoleplayAgentStop({ directories, owner, job }, reason) {
    const account = job.intent?.roleplay;
    return withRoleplayAccount({ owner, directories }, account, () => {
        if (roleplayAgentsStopped({ directories, job })) return false;
        writeArtifact(directories, job.id, key, { intentHash: roleplayHash(job.intent), reason });
        return true;
    });
}

/** Translation and speech are skipped only for the owner's Stop, never for an automatic stop. */
export function roleplayAgentsStoppedByOwner({ directories, job }) {
    if (!roleplayAgentsStopped({ directories, job })) return false;
    return !AUTOMATIC_ROLEPLAY_AGENT_STOP_REASONS.includes(readArtifact(directories, job.id, key)?.reason);
}

/** Stop only post-reply work. The normal cancellation path still owns an unfinished main reply. */
export function requestRoleplayAgentStop({ directories, owner, job }) {
    if (job.owner !== owner || job.cancellation?.requested || !['running', 'queued', 'waiting'].includes(job.state)) return false;
    const workflow = job.type === 'media.roleplay-workflow';
    const childId = job.children?.at(-1);
    const child = workflow ? childId && getJob(directories, childId) : job;
    if (!child || child.owner !== owner || workflow && child.parentId !== job.id
        || !['roleplay.reply', 'roleplay.candidate'].includes(child.type) || child.cancellation?.requested
        || !['running', 'queued', 'waiting', 'completed'].includes(child.state)
        || !child.intent?.roleplay || !child.intent?.source) return false;
    const account = child.intent.roleplay;
    return withRoleplayAccount({ owner, directories }, account, () => {
        // The main reply is paid for once its completion marker exists. From
        // then on Stop means "finish this reply, skip the optional work", even
        // when no Agents are configured. Before that marker it still cancels
        // the unfinished main generation through the ordinary path.
        const complete = readArtifact(directories, child.id, 'roleplay-main-complete');
        const mainComplete = complete?.version === 1 && complete.intentHash === roleplayHash(child.intent);
        const { hash, ...base } = readArtifact(directories, child.id, 'roleplay-agent-output-base') ?? {};
        const agentMain = hash === roleplayHash(base) && base.intentHash === roleplayHash(child.intent)
            && typeof base.value === 'string' && Boolean(base.value.trim());
        if (!mainComplete && !agentMain) return false;
        for (const target of workflow ? [child, job] : [child]) {
            if (!roleplayAgentsStopped({ directories, job: target })) writeArtifact(directories, target.id, key, { intentHash: roleplayHash(target.intent) });
        }
        // Save the decision before aborting an HTTP request, including duplicate Stop presses.
        for (const controller of controllers.get(child.id) ?? []) controller.abort(stopped());
        if (child.state === 'waiting' && child.stage === 'approval') {
            updateJob(directories, child.id, { state: 'queued', stage: 'agents-stopped', result: null });
        }
        return true;
    });
}

/** Give each auxiliary request its own abort signal; saving the main reply retains the runner's signal. */
export async function withRoleplayAgentStop(context, run, { ownerOnly = false } = {}) {
    const controller = new AbortController();
    const active = controllers.get(context.job.id) ?? new Set();
    controllers.set(context.job.id, active);
    active.add(controller);
    try {
        // A failure stop keeps the reply and skips the remaining Agents, but it
        // does not turn an optional translation or speech call into a Stop.
        if (ownerOnly ? roleplayAgentsStoppedByOwner(context) : roleplayAgentsStopped(context)) controller.abort(stopped());
        const scoped = { ...context, signal: AbortSignal.any([context.signal, controller.signal]) };
        return await run(scoped);
    } catch (error) {
        // The shared provider transport reports an aborted request as HTTP 499.
        if (controller.signal.aborted && !context.signal.aborted
            && (isRoleplayAgentStop(error) || error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
                || error?.status === 499)) throw controller.signal.reason;
        throw error;
    } finally {
        active.delete(controller);
        if (!active.size) controllers.delete(context.job.id);
    }
}
