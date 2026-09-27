import { attachOwnedChild, getJob, releaseChildJobs, updateJob } from '../jobs/store.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { readRoleplayFile, roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { assertRoleplaySourceLocked } from './roleplay-source.js';
import { assertRoleplayWorldInfoCurrent } from './world-info.js';
import { captureVectors } from '../operations/vector-sources.js';
import { admitOperation, readOperation } from '../operations/store.js';

const KEY = 'roleplay-vectors';
const fail = message => roleplayError('ROLEPLAY_VECTOR_RECOVERY', message, 409);

/** A real Roleplay job owns its complete vector child, including any browser-local WebLLM wait. */
export async function prepareRoleplayVectors(context, { snapshot, source, records, macros, binding, maxTokens, contextLimit }) {
    const { directories, job, owner } = context;
    const base = { directories, owner };
    const input = { action: 'prompt', locator: source.locator, parentIntentHash: roleplayHash(job.intent) };
    const key = `roleplay:${job.id}:vectors`;
    const old = readOperation(base, key);
    if (old && old.requestHash !== roleplayHash({ kind: 'vectors', input })) throw fail('The accepted vector child changed.');
    let plan = old?.plan;
    if (!plan) {
        // Optional live formatting controls may be undefined. Persist the same
        // JSON snapshot the macro evaluator reads, rather than live objects.
        const macroSnapshot = JSON.parse(JSON.stringify(macros));
        const current = withRoleplayAccount(base, snapshot.account, lease => {
            const saved = assertRoleplaySourceLocked(lease, source);
            return readRoleplayFile(saved.filePath, 32 * 1024 * 1024);
        });
        assertRoleplayWorldInfoCurrent(base, snapshot);
        plan = await captureVectors(base, snapshot.account, input, {
            chat: { locator: source.locator, records, rawHash: current.rawHash,
                physical: current.physical, macros: macroSnapshot, persona: { lorebook: snapshot.names.persona[0] || '' } },
            macros: macroSnapshot, summary: { binding, contextLimit, maxTokens },
        });
        plan.ownerJob = { id: job.id, intentHash: input.parentIntentHash };
    }
    const accepted = admitOperation(base, snapshot.account, { key, kind: 'vectors', input, plan,
        label: 'Prepare saved vector context', applyTarget: { kind: 'vectors', id: 'account-vector-indexes' },
        validateLocked: lease => {
            context.signal.throwIfAborted(); assertRoleplaySourceLocked(lease, source);
            const parent = getJob(directories, job.id);
            if (!parent || parent.cancellation?.requested || roleplayHash(parent.intent) !== input.parentIntentHash) throw fail('The vector parent changed before admission.');
        } });
    if (!accepted.job || accepted.record.state === 'refused') throw fail('The accepted vector child needs recovery.');
    attachOwnedChild(directories, job.id, accepted.job.id,
        { parentIntentHash: input.parentIntentHash, childIntentHash: roleplayHash(accepted.job.intent) });
    const pointer = { jobId: accepted.job.id, key, parentIntentHash: input.parentIntentHash, planHash: accepted.record.planHash };
    const prior = readArtifact(directories, job.id, KEY + ':child');
    if (prior && roleplayHash(prior) !== roleplayHash(pointer)) throw fail('The saved vector child pointer changed.');
    if (!prior) writeArtifact(directories, job.id, KEY + ':child', pointer);
    const record = readOperation(base, key);
    if (record.state !== 'completed') {
        const child = getJob(directories, record.jobId);
        if (['failed', 'interrupted', 'cancelled', 'conflict'].includes(child.state)) throw fail('The vector request needs explicit recovery before this reply can continue.');
        releaseChildJobs(directories, job.id);
        return { waiting: true, childJobId: child.id };
    }
    const value = { ...pointer, resultHash: record.resultHash, projection: record.result.projection };
    if (!value.projection) throw fail('The completed vector operation lost its prompt context.');
    const result = { ...value, hash: roleplayHash(value) };
    const saved = readArtifact(directories, job.id, KEY);
    if (saved && roleplayHash(saved) !== roleplayHash(result)) throw fail('The saved vector prompt context changed.');
    if (!saved) writeArtifact(directories, job.id, KEY, result);
    return result;
}

/** Keep original record positions for attachments and memory until the final history selection. */
export function applyRoleplayVectorFiles(records, projection) {
    const next = structuredClone(records);
    for (const item of [...projection.removed, ...projection.files]) {
        if (!Number.isSafeInteger(item.index) || roleplayHash(records[item.index + 1]) !== item.hash) throw fail('A vector result does not match its saved message.');
    }
    for (const item of projection.files) {
        next[item.index + 1].mes = item.text;
        next[item.index + 1].extra = { ...next[item.index + 1].extra, fileLength: 0, files: [] };
    }
    return next;
}

export function recoverWaitingRoleplayVectors({ job, directories, owner }) {
    if (!['roleplay.reply', 'roleplay.candidate'].includes(job.type) || job.state !== 'waiting' || job.stage !== 'children') return;
    const saved = readArtifact(directories, job.id, KEY + ':child');
    const child = saved && getJob(directories, saved.jobId);
    if (!child || child.owner !== owner || child.parentId !== job.id || child.type !== 'operations.vectors') throw fail('The Roleplay vector child is unavailable.');
    if (child.state === 'completed') updateJob(directories, job.id, { state: 'queued', stage: 'vectors-completed' });
    else if (['failed', 'interrupted', 'cancelled', 'conflict'].includes(child.state)) updateJob(directories, job.id,
        { state: 'interrupted', stage: 'vector-needs-recovery', error: { code: 'ROLEPLAY_VECTOR_RECOVERY', message: 'Review the vector child before retrying this reply.' } });
}
