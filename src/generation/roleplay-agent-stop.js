import { getJob, updateJob } from '../jobs/store.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';

const key = 'roleplay-agent-stop';
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
export function markRoleplayAgentsFailed({ directories, owner, job }) {
    const account = job.intent?.roleplay;
    return withRoleplayAccount({ owner, directories }, account, () => {
        if (roleplayAgentsStopped({ directories, job })) return false;
        writeArtifact(directories, job.id, key, { intentHash: roleplayHash(job.intent), reason: 'failed' });
        return true;
    });
}

/** Translation and speech are skipped only for the owner's Stop, never for a failure stop. */
export function roleplayAgentsStoppedByOwner({ directories, job }) {
    if (!roleplayAgentsStopped({ directories, job })) return false;
    return readArtifact(directories, job.id, key)?.reason !== 'failed';
}

/** Stop only post-reply work. The normal cancellation path still owns an unfinished main reply. */
export function requestRoleplayAgentStop({ directories, owner, job }) {
    if (job.owner !== owner || job.cancellation?.requested || !['running', 'queued', 'waiting'].includes(job.state)) return false;
    const workflow = job.type === 'media.roleplay-workflow';
    const childId = job.children?.at(-1);
    const child = workflow ? childId && getJob(directories, childId) : job;
    if (!child || child.owner !== owner || workflow && child.parentId !== job.id
        || !['roleplay.reply', 'roleplay.candidate'].includes(child.type) || child.cancellation?.requested
        || !['running', 'queued', 'waiting', 'completed'].includes(child.state) || !child.intent.request?.worldInfo?.agents) return false;
    const account = child.intent.roleplay;
    return withRoleplayAccount({ owner, directories }, account, () => {
        const { hash, ...base } = readArtifact(directories, child.id, 'roleplay-agent-output-base') ?? {};
        if (hash !== roleplayHash(base) || base.intentHash !== roleplayHash(child.intent) || typeof base.value !== 'string' || !base.value.trim()) return false;
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
export async function withRoleplayAgentStop(context, run) {
    const controller = new AbortController();
    const active = controllers.get(context.job.id) ?? new Set();
    controllers.set(context.job.id, active);
    active.add(controller);
    try {
        if (roleplayAgentsStopped(context)) controller.abort(stopped());
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
