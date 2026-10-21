import { getJob } from '../jobs/store.js';
import { classifyGenerationOutcome } from '../../public/scripts/generation-outcome.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { roleplayError, roleplayHash } from '../roleplay-store.js';

const fail = () => roleplayError('ROLEPLAY_BLOCKED_RECOVERY', 'The saved provider-blocked reply does not match its provider result.', 409);
const messageOf = output => output?.message ?? output?.messages?.[0] ?? output;
function bindings(directories, job, output, records) {
    const reference = readArtifact(directories, job.id, 'roleplay-main-provider');
    if (reference?.intentHash !== roleplayHash(job.intent) || !/^provider:[a-f0-9]{64}$/.test(reference?.step)) throw fail();
    const provider = readArtifact(directories, job.id, reference.step);
    const outcome = classifyGenerationOutcome(provider?.response);
    const message = messageOf(output);
    const text = message?.mes ?? output?.text;
    if (!outcome || typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 256 * 1024
        || text !== provider.text || roleplayHash(outcome) !== roleplayHash(message?.extra?.generation_outcome)
        || output.continuedText !== undefined || output.agentProof !== undefined || output.messages?.length > 1
        || Object.keys(message.extra ?? {}).some(key => /^inChatAgent|^agent_/.test(key))) throw fail();
    const baseline = job.intent.effect === 'continue' ? records[job.intent.source.message.index + 1] : null;
    if (job.intent.effect === 'continue' && typeof baseline?.mes !== 'string') throw fail();
    const delivered = structuredClone(output);
    delete delivered.blockedProof;
    const deliveredMessage = messageOf(delivered);
    const parent = job.intent.request.workflowCandidate?.parentJobId && getJob(directories, job.intent.request.workflowCandidate.parentJobId);
    if (parent?.intent?.request?.group) {
        for (const key of ['force_avatar', 'original_avatar']) {
            if (deliveredMessage[key] !== undefined && deliveredMessage[key] !== job.intent.request.worldInfo.avatar) throw fail();
            delete deliveredMessage[key];
        }
        if (deliveredMessage.extra?.gen_id !== undefined && deliveredMessage.extra.gen_id !== parent.intent.request.group.generationId) throw fail();
        delete deliveredMessage.extra.gen_id;
    }
    return { outputHash: roleplayHash(delivered), version: 1, intentHash: roleplayHash(job.intent), providerReferenceHash: roleplayHash(reference),
        providerHash: roleplayHash(provider), outcome, text,
        baselineHash: baseline ? roleplayHash({ text: baseline.mes, swipe: baseline.swipe_id ?? 0 }) : null };
}

export function saveBlockedOutputProof(directories, job, output, records) {
    const value = bindings(directories, job, output, records);
    const hash = roleplayHash(value);
    const saved = readArtifact(directories, job.id, 'roleplay-blocked-output');
    if (saved !== undefined && roleplayHash(saved) !== roleplayHash({ ...value, hash })) throw fail();
    if (saved === undefined) writeArtifact(directories, job.id, 'roleplay-blocked-output', { ...value, hash });
    output.blockedProof = hash;
}

export function verifyBlockedOutputProof(directories, job, output, records) {
    if (output.blockedContinuationProof) return verifyBlockedContinuationProof(directories, job, output, records);
    const { hash, ...value } = readArtifact(directories, job.id, 'roleplay-blocked-output') ?? {};
    if (typeof output.blockedProof !== 'string' || output.blockedProof !== hash || hash !== roleplayHash(value)
        || roleplayHash(bindings(directories, job, output, records)) !== hash) throw fail();
}


function continuationBindings(directories, job, output, previousOutput) {
    const admitted = job.intent.request.workflowCandidate;
    const parent = admitted?.parentJobId && getJob(directories, admitted.parentJobId);
    if (!parent || parent.id !== job.parentId || parent.owner !== job.owner || roleplayHash(parent.intent) !== admitted.parentIntentHash) throw fail();
    let decision;
    for (let turn = 0; turn < admitted.turn; turn++) {
        const candidate = readArtifact(directories, parent.id, `roleplay-workflow-decision:${turn}`);
        if (candidate?.hash === admitted.decisionHash) decision = candidate;
    }
    const { hash, ...record } = decision ?? {};
    if (!hash || hash !== roleplayHash(record) || record.parentIntentHash !== admitted.parentIntentHash
        || record.decision?.kind !== 'continue' || record.outputHash !== roleplayHash(previousOutput)) throw fail();
    const priorJob = getJob(directories, record.childJobId);
    if (!priorJob) throw fail();
    const { hash: candidateHash, ...candidate } = readArtifact(directories, priorJob?.id, 'roleplay-candidate') ?? {};
    const reference = readArtifact(directories, priorJob?.id, 'roleplay-main-provider');
    const provider = reference?.step && readArtifact(directories, priorJob.id, reference.step);
    if (!priorJob || priorJob.parentId !== parent.id || candidateHash !== record.candidateHash || candidateHash !== roleplayHash(candidate)
        || candidate.providerHash !== roleplayHash(provider) || candidate.intentHash !== roleplayHash(priorJob.intent)) throw fail();
    const original = readArtifact(directories, job.id, 'roleplay-candidate')?.output;
    const prefix = messageOf(previousOutput)?.mes ?? previousOutput?.text;
    const suffix = messageOf(original)?.mes ?? original?.text;
    const text = messageOf(output)?.mes ?? output?.text;
    if (typeof prefix !== 'string' || typeof suffix !== 'string' || text !== prefix + suffix || Buffer.byteLength(text) > 256 * 1024
        || output.agentProof !== undefined) throw fail();
    if (previousOutput.continuedText !== undefined) {
        if (job.intent.effect !== 'continue' || typeof previousOutput.continuedText !== 'string'
            || output.continuedText !== previousOutput.continuedText + suffix
            || Buffer.byteLength(output.continuedText) > 256 * 1024) throw fail();
    } else if (output.continuedText !== undefined) throw fail();
    const delivered = structuredClone(output);
    delete delivered.blockedContinuationProof;
    // Group identity is independently checked by its publication path and the base blocked proof.
    if (parent.intent.request.group) {
        const message = messageOf(delivered);
        for (const key of ['force_avatar', 'original_avatar']) {
            if (message[key] !== undefined && message[key] !== job.intent.request.worldInfo.avatar) throw fail();
            delete message[key];
        }
        if (message.extra?.gen_id !== undefined && message.extra.gen_id !== parent.intent.request.group.generationId) throw fail();
        delete message.extra.gen_id;
    }
    return { intentHash: roleplayHash(job.intent), parentIntentHash: admitted.parentIntentHash, decisionHash: hash,
        priorProviderHash: roleplayHash(provider), baseProof: original?.blockedProof, previousOutput, outputHash: roleplayHash(delivered) };
}

/** Bind a previously accepted automatic-continuation prefix without granting arbitrary continuedText. */
export function saveBlockedContinuationProof(directories, job, output, previousOutput) {
    const value = continuationBindings(directories, job, output, previousOutput);
    const hash = roleplayHash(value);
    const saved = readArtifact(directories, job.id, 'roleplay-blocked-continuation');
    if (saved !== undefined && roleplayHash(saved) !== roleplayHash({ ...value, hash })) throw fail();
    if (saved === undefined) writeArtifact(directories, job.id, 'roleplay-blocked-continuation', { ...value, hash });
    output.blockedContinuationProof = hash;
}

function verifyBlockedContinuationProof(directories, job, output, records) {
    const original = readArtifact(directories, job.id, 'roleplay-candidate')?.output;
    if (!original || original.blockedContinuationProof) throw fail();
    verifyBlockedOutputProof(directories, job, original, records);
    const { hash, ...value } = readArtifact(directories, job.id, 'roleplay-blocked-continuation') ?? {};
    if (!hash || output.blockedContinuationProof !== hash || hash !== roleplayHash(value)
        || hash !== roleplayHash(continuationBindings(directories, job, output, value.previousOutput))) throw fail();
}
