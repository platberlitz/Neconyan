import { roleplayAccountStamp, roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { getCreatorDraft } from './store.js';
import { acceptJob, getJob, listJobs, releaseJob, requestCancellation } from '../jobs/store.js';
import { abortJob, noteOwner, registerHandler } from '../jobs/runner.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { captureGenerationBinding, resolveGenerationProfile } from '../generation/profiles.js';
import { runChatProfile } from '../generation/service.js';
import { scratchpadMacroEnvironment } from '../scratchpad/macros.js';
import { creatorConnection, creatorConnectionError } from '../../public/scripts/creator/connection.js';
import { creatorPrefill, joinCreatorPrefill } from '../../public/scripts/creator/prefill.js';
import { assertCreatorReplyNotRefused } from '../../public/scripts/creator/refusal.js';
import { isGenerationLengthFinish } from '../../public/scripts/generation-request-controls.js';
import { creatorStepMessages, mergeCreatorStep, reviseCreatorConversion } from '../../public/scripts/creator/conversion.js';
import { creatorQuestionMessages, mergeCreatorQuestions } from '../../public/scripts/creator/questions.js';
import { creatorAgentMessages, creatorAgentStepInput, finishCreatorAgentStep } from '../../public/scripts/creator/agent-processing.js';

export const CREATOR_JOB_TYPE = 'creator.reply';
const fail = message => roleplayError('CREATOR_GENERATION', message, 409);
const terminal = job => ['completed', 'failed', 'cancelled', 'interrupted', 'conflict'].includes(job.state);

function connectionFor(draft, agent) {
    const connection = { ...draft.writing?.connection };
    if (Number.isSafeInteger(agent?.maxTokens) && agent.maxTokens > 0) connection.maxTokens = agent.maxTokens;
    if (agent?.connectionProfile) Object.assign(connection, { profile: agent.connectionProfile, fallbacks: agent.connectionFallbacks ?? [] });
    return connection;
}

/** Freeze private authoring work before releasing it to the shared job runner. */
export function acceptCreatorGeneration(base, body) {
    const account = roleplayAccountStamp(base);
    return withRoleplayAccount(base, account, lease => {
        const requestHash = roleplayHash({ id: body.id ?? null, expectedRevision: body.expectedRevision ?? null, proposalId: body.proposalId ?? null, reviseField: body.reviseField ?? null, messages: body.messages ?? null, connection: body.connection ?? null, recovery: body.recovery ?? null });
        const prior = listJobs(base.directories, { owner: base.owner, includeDismissed: true }).find(job => job.submissionKey === body.submissionKey);
        if (prior) {
            if (prior.type !== CREATOR_JOB_TYPE || prior.intent.requestHash !== requestHash) throw fail('This request identity belongs to different work.');
            return { job: prior };
        }
        if (listJobs(base.directories, { owner: base.owner }).some(job => job.type === CREATOR_JOB_TYPE && job.intent.draftId === body.id && !terminal(job))) throw fail('This draft already has a server request. Open Server requests to check it before starting another.');
        const saved = getCreatorDraft(lease, body.id);
        if (saved.revision !== body.expectedRevision) throw fail('Save the current draft before asking the server to write.');
        const draft = structuredClone(saved.draft);
        // Authoring history and images never enter the generation snapshot.
        draft.history = []; draft.future = []; draft.media = []; draft.source = { avatar: draft.source.avatar };
        const proposal = body.proposalId ? draft.proposals.find(item => item.id === body.proposalId) : null;
        if (body.proposalId && (!proposal?.plan || !Array.isArray(proposal.plan.steps) || proposal.plan.steps.length > 500)) throw fail('Choose an unfinished writing proposal.');
        if (body.reviseField && !proposal?.changes.some(change => change.field === body.reviseField)) throw fail('Choose a proposed field to regenerate.');
        if (!proposal && (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 100 || body.messages.some(message => !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string'))) throw fail('The writing request is invalid.');
        const connection = body.connection ?? connectionFor(draft);
        const connections = proposal && !body.reviseField ? proposal.plan.phase === 'questions' ? [connection]
            : proposal.plan.steps.slice(proposal.plan.next).filter(step => !step.agent || step.agent.prompt?.trim()).map(step => connectionFor(draft, step.agent)) : [connection];
        const bindings = Object.create(null);
        for (const connection of connections) {
            const { profiles } = creatorConnection({ writing: { connection } });
            for (const profile of profiles) if (!Object.hasOwn(bindings, profile)) bindings[profile] = captureGenerationBinding(base.directories, profile ? { kind: 'profile', profileId: profile } : { kind: 'active' }, body.acknowledgement);
        }
        if (body.recovery && !['field', 'interview', 'lore'].includes(body.recovery.kind)) throw fail('The saved result type is invalid.');
        const input = { account, draft, proposal, reviseField: body.reviseField, messages: body.messages, connection, bindings, recovery: body.recovery };
        if (Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024) throw fail('This writing request is too large. Split it into smaller requests.');
        const { job } = acceptJob(base.directories, { owner: base.owner, type: CREATOR_JOB_TYPE, submissionKey: body.submissionKey,
            intent: { draftId: draft.id, requestHash }, target: { kind: 'creator', id: draft.id }, paused: true,
            label: `Catelier: ${proposal?.label || 'writing request'}`, credentialRef: bindings });
        writeArtifact(base.directories, job.id, 'creator-input', input);
        releaseJob(base.directories, job.id);
        noteOwner(base.owner);
        return { job: getJob(base.directories, job.id) };
    });
}

export function creatorGenerationStatus(base, { id, jobId, cancel = false }) {
    const jobs = listJobs(base.directories, { owner: base.owner }).filter(job => job.type === CREATOR_JOB_TYPE && job.intent.draftId === id);
    if (!jobId) return { jobs };
    let job = jobs.find(item => item.id === jobId);
    if (!job) throw fail('This writing request is unavailable in this draft.');
    if (cancel && !terminal(job)) { requestCancellation(base.directories, jobId); abortJob(jobId); job = getJob(base.directories, jobId); }
    return { job, result: readArtifact(base.directories, jobId, 'result') ?? null, preview: readArtifact(base.directories, jobId, 'creator-preview') ?? null };
}

/** Results stay separate from editable drafts, so another device cannot be overwritten. */
export async function runCreatorGeneration(context, { generate = runChatProfile } = {}) {
    const { directories, job, signal } = context;
    const input = readArtifact(directories, job.id, 'creator-input');
    if (!input) throw fail('The saved writing request is incomplete. Start a new request.');
    const base = { directories, owner: job.owner };
    const check = () => {
        signal.throwIfAborted();
        withRoleplayAccount(base, input.account, lease => getCreatorDraft(lease, input.draft.id));
    };
    const reply = async (messages, connection, namespace) => {
        const { profiles, maxTokens } = creatorConnection({ writing: { connection } });
        const failures = [];
        for (const profile of profiles) {
            check();
            try {
                const binding = input.bindings[profile];
                const material = resolveGenerationProfile(directories, binding);
                const prefill = creatorPrefill(connection, material.profile?.model || material.active?.model_novel);
                const prompt = structuredClone(messages);
                const chat = !binding.backend || binding.backend === 'chat';
                if (prefill.text && (chat || binding.kind !== 'active')) prompt.push({ role: 'assistant', content: prefill.text, ...(prefill.partial ? { partial: true } : {}) });
                const names = { user: 'Interviewer', char: input.draft.card.data.name || 'Character' };
                let previewAt = 0;
                let previewText = '';
                const preview = value => {
                    writeArtifact(directories, job.id, 'creator-preview', { text: joinCreatorPrefill(value.text || '', prefill.reply), reasoning: value.reasoning || '' }, { durable: false });
                    previewAt = Date.now();
                    previewText = value.text || '';
                };
                preview({});
                previewAt = 0;
                const result = await generate({ context: { directories }, binding, messages: prompt, maxTokens, signal, jobContext: context,
                    macroEnvironment: scratchpadMacroEnvironment(names, prompt), userName: names.user, characterName: names.char,
                    preparedMessages: chat, stepNamespace: `${namespace}:${profile}`, stream: connection.stream === true,
                    rawOptions: binding.kind === 'active' ? { trimNames: false, cacheScope: 'auxiliary', ...(!chat ? { prefill: prefill.text } : {}) } : { includePreset: false, includeInstruct: false },
                    beforeDispatch: check,
                    onStream: value => { if (Date.now() - previewAt >= 250 || !previewAt || (!previewText && value.text)) preview(value); },
                });
                preview(result);
                check();
                if (result.outcome || isGenerationLengthFinish(result.response)) throw fail('The model did not return a complete reply. Try a smaller request.');
                if (!result.text?.trim()) throw fail('The model returned no text.');
                const text = joinCreatorPrefill(result.text, prefill.reply);
                assertCreatorReplyNotRefused(text, messages);
                return text;
            } catch (error) {
                check();
                // Uncertain paid calls must not be silently replayed on another connection.
                if (getJob(directories, job.id)?.recoverability === 'unknown-outcome') throw error;
                failures.push(`${profile || 'Current connection'}: ${creatorConnectionError(error)}`);
            }
        }
        throw fail(failures.join('\n'));
    };
    check();
    let result = readArtifact(directories, job.id, 'result');
    if (result?.complete) return { draftId: input.draft.id };
    if (!input.proposal) {
        result = { text: await reply(input.messages, input.connection, 'reply'), complete: true, recovery: input.recovery, source: input.draft };
        writeArtifact(directories, job.id, 'result', result);
        return { draftId: input.draft.id };
    }
    let proposal = result?.workingProposal ?? result?.proposal ?? (input.reviseField
        ? reviseCreatorConversion(input.draft, input.proposal, { field: input.reviseField, note: input.proposal.fieldNotes?.[input.reviseField] ?? '', regenerate: true })
        : structuredClone(input.proposal));
    const save = complete => {
        const review = input.reviseField ? structuredClone(input.proposal) : proposal;
        if (input.reviseField) review.changes = review.changes.map(change => change.field === input.reviseField ? proposal.changes.find(item => item.field === input.reviseField) : change);
        writeArtifact(directories, job.id, 'result', { proposal: review, before: input.proposal, complete, ...(input.reviseField ? { workingProposal: proposal } : {}) });
    };
    while (proposal.plan.phase !== 'answers' && proposal.plan.next < proposal.plan.steps.length) {
        check();
        const step = proposal.plan.steps[proposal.plan.next];
        await context.progress({ stage: proposal.plan.phase === 'questions' ? 'Asking questions' : step.label, completed: proposal.plan.next, total: proposal.plan.steps.length });
        if (proposal.plan.phase === 'questions') proposal = mergeCreatorQuestions(proposal, await reply(creatorQuestionMessages(proposal), input.connection, 'questions'));
        else {
            let output;
            if (step.agent) {
                const text = step.agent.prompt?.trim() ? await reply(creatorAgentMessages(proposal), connectionFor(input.draft, step.agent), `step:${proposal.plan.next}`) : creatorAgentStepInput(proposal);
                output = finishCreatorAgentStep(proposal, text);
            } else output = await reply(creatorStepMessages(input.draft, proposal), input.connection, `step:${proposal.plan.next}`);
            proposal = mergeCreatorStep(input.draft, proposal, output);
        }
        save(false);
    }
    save(true);
    return { draftId: input.draft.id };
}

registerHandler(CREATOR_JOB_TYPE, runCreatorGeneration);
