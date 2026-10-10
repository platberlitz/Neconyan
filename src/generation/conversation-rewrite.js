import {
    extractCharacterReplyCommandParts,
    getCharacterReplyCommandMetadata,
    normalizeConversationOutputText,
} from '../../public/scripts/neconyan-conversation/generation-utils.js';
import { runChatProfile, validateActiveGenerationContext } from './service.js';
import { resolveGenerationProfile } from './profiles.js';
import {
    normalizeBindingRequest,
    normalizeSubmissionAnchors,
    preflightConversationBindings,
    verifyConversationAnchors,
} from './conversation-jobs.js';
import { buildConversationParticipantSnapshot } from './conversation-participants.js';
import { createMacroEnvironment } from '../macros/index.js';
import { hash } from '../mewmory/core.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { acceptJob, getJob, listJobs, releaseJob, setJobResume, updateJob } from '../jobs/store.js';
import { noteOwner, registerHandler } from '../jobs/runner.js';
import { getConversationSettings } from '../endpoints/conversation-generation.js';
import { getConversationThreadKey } from '../endpoints/conversation-store.js';
import { refreshBranchPreview } from '../endpoints/conversation-messages.js';
import { createMessageTokenCounter, getReplyReasoning } from './message-token-counts.js';
import { publishConversationPreview } from './conversation-preview.js';
import { applyConversationJobCommands, captureConversationTarget, commitConversationEffect, readConversationTarget } from './conversation-effects.js';

const REWRITE_MODES = new Set(['regenerate', 'polish']);
const MAX_RESPONSE_BYTES = 256 * 1024;

function fail(message, status = 400) {
    return Object.assign(new Error(message), { status });
}

function scopedRequest(context) {
    return { user: { profile: { handle: context.owner }, directories: context.directories } };
}

/** The speaker a rewrite must use: the message's own partner, or the thread character. */
function rewriteSpeaker(message, mode, target) {
    if (!message || ['user', 'system'].includes(message.role || '')) throw fail('Only a character reply can be rewritten.', 409);
    if (mode === 'polish') {
        if (!String(message.mes || '').trim()) throw fail('This reply has no text to polish.', 409);
        return target.avatar;
    }
    return String(message.extra?.partner_avatar || target.avatar);
}

function rewriteRequestHash(body) {
    const target = body.target || {};
    return hash({
        kind: 'rewrite', mode: body.mode, messageId: body.messageId,
        target: { avatar: target.avatar || '', groupId: target.groupId || '', personaId: target.personaId || '', branchId: target.branchId || '' },
        anchors: normalizeSubmissionAnchors(body), speakerAvatar: body.speakerAvatar || '',
        bindingRequest: normalizeBindingRequest(body.bindingRequest) || null, options: body.options ?? null, timeZone: body.timeZone || 'UTC',
    });
}

/**
 * The rewrite depends only on the messages it was drawn from: the branch, the
 * captured context and the target reply itself. A reaction or a later message
 * elsewhere in the thread does not discard the paid result.
 */
function verifyRewriteSource(current, snapshot) {
    if (String(current.branch.createdAt) !== String(snapshot.target.createdAt)) throw fail('The Conversation branch was replaced. The original reply was kept.', 409);
    try {
        verifyConversationAnchors(current, snapshot.target, snapshot.anchors);
    } catch {
        throw fail('The message changed before it could be rewritten. The original reply was kept.', 409);
    }
}

function generationOptions(snapshot) {
    return {
        binding: snapshot.binding,
        messages: snapshot.messages,
        maxTokens: snapshot.maxTokens,
        macroEnvironment: createMacroEnvironment(snapshot.macros || {}),
        userName: snapshot.userName || 'User',
        characterName: snapshot.characterName || 'Character',
        groupNames: snapshot.groupNames || [],
        rawOptions: snapshot.rawOptions,
        stream: snapshot.streamPreview === true,
    };
}

/** Turn the provider text into the saved reply, or nothing when it is unusable. */
export function prepareConversationRewrite(snapshot, text) {
    const raw = String(text ?? '');
    if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) return { text: '' };
    if (snapshot.mode === 'polish') return { text: normalizeConversationOutputText(raw.trim()) };
    const parts = extractCharacterReplyCommandParts(raw, snapshot.commandSettings);
    return { text: parts.text, parts };
}

async function finalizeRewriteSubmission(request, job, preparedSnapshot) {
    try {
        const snapshot = preparedSnapshot || readArtifact(request.user.directories, job.id, 'request');
        if (!snapshot) throw fail('The rewrite request was not saved before the server stopped. Try again.', 409);
        if (job.config?.requestHash && hash(snapshot) !== job.config.requestHash) throw fail('The accepted rewrite request changed during preparation.', 409);
        writeArtifact(request.user.directories, job.id, 'request', snapshot);
    } catch (error) {
        updateJob(request.user.directories, job.id, {
            state: 'failed', stage: null, finishedAt: Date.now(),
            error: { message: error?.message || 'The rewrite request could not be prepared.', code: error?.code || 'REWRITE_PREPARE_FAILED' },
            recoverability: 'needs-retry',
        });
        return getJob(request.user.directories, job.id);
    }
    releaseJob(request.user.directories, job.id);
    return getJob(request.user.directories, job.id);
}

/**
 * Accept a manual regeneration or polish of one saved reply. The page builds
 * the prompt as before; the server calls the captured connection once, keeps
 * the provider text, and replaces the reply in one receipt-protected write.
 */
export async function acceptConversationRewrite(request, body = {}) {
    const owner = request.user?.profile?.handle;
    const directories = request.user?.directories;
    if (!owner || !directories?.root) throw fail('An authenticated account is required.', 401);
    if (typeof body.submissionKey !== 'string' || !body.submissionKey || body.submissionKey.length > 256) throw fail('A submission key is required.');
    if (!REWRITE_MODES.has(body.mode)) throw fail('The rewrite mode is invalid.');
    if (typeof body.messageId !== 'string' || !body.messageId || body.messageId.length > 256) throw fail('A message is required.');
    if (!body.target || typeof body.target !== 'object' || Array.isArray(body.target)) throw fail('A Conversation target is required.');
    if (!body.options || typeof body.options !== 'object' || Array.isArray(body.options)) throw fail('The generation input is invalid.');
    const timeZone = typeof body.timeZone === 'string' ? body.timeZone : 'UTC';
    try { new Intl.DateTimeFormat('en-GB', { timeZone }).format(); } catch { throw fail('The rewrite timezone is invalid.'); }
    const requestHash = rewriteRequestHash(body);
    const recorded = listJobs(directories, { owner, includeDismissed: true }).find(item => item.submissionKey === body.submissionKey);
    if (recorded) {
        if (recorded.type !== 'conversation.rewrite' || recorded.intent?.requestHash !== requestHash) throw fail('This submission key already belongs to another operation.', 409);
        return { created: false, job: recorded };
    }
    const submitted = normalizeBindingRequest(body.bindingRequest);
    if (!submitted) throw fail('A captured connection is required.');
    const anchors = normalizeSubmissionAnchors(body);
    if (!anchors.branchCreatedAt || !anchors.triggers.some(anchor => anchor.messageId === body.messageId)) {
        throw fail('The rewritten message must be part of the captured context.');
    }
    const target = captureConversationTarget(request, body.target);
    const captured = await preflightConversationBindings(request, { ...body, bindingOnly: false, acknowledgement: submitted.acknowledgement });
    if (hash(normalizeBindingRequest(captured)) !== hash(submitted)) throw fail('The captured connection changed. Try again.', 409);
    const current = readConversationTarget(request, target);
    const message = (current.branch.messages || []).find(item => String(item?.id || '') === body.messageId);
    const speakerAvatar = rewriteSpeaker(message, body.mode, target);
    if ((body.speakerAvatar || target.avatar) !== speakerAvatar) throw fail('The selected speaker did not write this reply.', 409);
    const binding = submitted.participants[speakerAvatar];
    if (!binding) throw fail('The selected speaker has no captured connection.', 409);
    const participant = await buildConversationParticipantSnapshot(request, current, target, { avatar: speakerAvatar }, { binding, directive: '', timeZone: 'UTC' });
    const { prompt, responseLength, ...rawOptions } = body.options;
    const settings = getConversationSettings(request, current.store, speakerAvatar, target.groupId, {}, { personaId: target.personaId });
    const snapshot = {
        mode: body.mode, messageId: body.messageId, target, anchors, speakerAvatar, binding, timeZone,
        speaker: participant.speaker, streamPreview: participant.streamPreview,
        messages: binding.kind === 'active' ? prompt : [
            ...(rawOptions.systemPrompt ? [{ role: 'system', content: rawOptions.systemPrompt }] : []),
            ...(Array.isArray(prompt) ? prompt : [{ role: 'user', content: prompt }]),
        ],
        maxTokens: responseLength,
        rawOptions: binding.kind === 'active' ? rawOptions : {},
        macros: participant.macros, userName: participant.userName, characterName: participant.speaker.name, groupNames: participant.groupNames,
        commandSettings: { schedule_command_enabled: settings.schedule_command_enabled, selfie_command_enabled: settings.selfie_command_enabled },
    };
    const options = generationOptions(snapshot);
    await validateActiveGenerationContext(resolveGenerationProfile(directories, binding), options.macroEnvironment, options.messages, options.rawOptions,
        { maxTokens: options.maxTokens, groupNames: options.groupNames });
    const accepted = acceptJob(directories, {
        owner, type: 'conversation.rewrite', submissionKey: body.submissionKey,
        intent: { kind: body.mode, target, messageId: body.messageId, speakerAvatar, requestHash },
        automatic: false, paused: true, coalesce: { deadline: 0, members: [] },
        target: { kind: 'conversation', id: getConversationThreadKey(target.avatar, target.groupId, target.personaId), branchId: target.branchId },
        credentialRef: binding, config: { requestHash: hash(snapshot) },
        label: body.mode === 'polish' ? 'Conversation reply polish' : 'Conversation reply regeneration',
    });
    noteOwner(owner);
    if (!accepted.created) return { created: false, job: accepted.job };
    const job = await finalizeRewriteSubmission(request, accepted.job, snapshot);
    return { created: true, job };
}

async function runConversationRewriteJob(context, { generate }) {
    const { directories, job } = context;
    const snapshot = readArtifact(directories, job.id, 'request');
    if (!snapshot) throw fail('The rewrite request is missing.', 409);
    if (readArtifact(directories, job.id, 'result')) return { artifact: true };
    const request = scopedRequest(context);
    const verify = current => verifyRewriteSource(current, snapshot);
    let reply = readArtifact(directories, job.id, 'reply');
    if (!reply) {
        const assertSource = () => verify(readConversationTarget(request, snapshot.target));
        assertSource();
        const counter = await createMessageTokenCounter(value => publishConversationPreview(context, snapshot, value), { signal: context.signal });
        try {
            const response = await generate({ ...generationOptions(snapshot), context, jobContext: context, beforeDispatch: assertSource,
                onStream: value => counter.publish(value) });
            const reasoning = getReplyReasoning(response);
            reply = { text: String(response?.text ?? ''), ...(reasoning ? { reasoning } : {}) };
        } finally {
            counter.stop();
            publishConversationPreview(context, snapshot, null);
        }
        writeArtifact(directories, job.id, 'reply', reply);
    }
    const rewrite = prepareConversationRewrite(snapshot, reply.text);
    if (!rewrite.text) {
        throw fail(snapshot.mode === 'polish' ? 'Could not rewrite the reply. The model returned no text.' : 'Regenerate returned no message.', 502);
    }
    setJobResume(directories, job.id, 'apply');
    const counter = await createMessageTokenCounter(() => {});
    const counts = counter.counts(rewrite.text, reply.reasoning);
    const now = Date.now();
    await commitConversationEffect(context, snapshot.target, 'rewrite', (branch, store) => {
        const index = branch.messages.findIndex(item => String(item?.id || '') === snapshot.messageId);
        if (index < 0) throw fail('The message was deleted before it could be rewritten.', 409);
        const message = branch.messages[index];
        message.mes = rewrite.text;
        message.extra = { ...message.extra, ...counts };
        let reminders = [];
        if (snapshot.mode === 'regenerate') {
            const extra = { ...message.extra };
            delete extra.conversation_commands;
            const metadata = getCharacterReplyCommandMetadata(rewrite.parts);
            message.extra = { ...extra, ...(metadata ? { conversation_commands: metadata } : {}), regenerated_at: now };
            ({ reminders } = applyConversationJobCommands(store, snapshot.target, rewrite.parts, snapshot.speakerAvatar,
                { timeZone: snapshot.timeZone, now, idSeed: [job.id, 'rewrite'] }));
        }
        if (index === branch.messages.length - 1) refreshBranchPreview(branch);
        return { messageId: snapshot.messageId, reminders };
    }, { verify });
    writeArtifact(directories, job.id, 'result', { messageId: snapshot.messageId, text: rewrite.text });
    return { artifact: true };
}

/** Finish a paused rewrite the worker found after a crash. */
export function finalizeConversationRewriteSubmission(request, job) {
    return finalizeRewriteSubmission(request, job);
}

export function registerConversationRewriteJobs({ generate = runChatProfile } = {}) {
    registerHandler('conversation.rewrite', context => runConversationRewriteJob(context, { generate }));
}

registerConversationRewriteJobs();

export const testExports = { runConversationRewriteJob, verifyRewriteSource };
