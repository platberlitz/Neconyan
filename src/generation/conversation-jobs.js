import { createHash } from 'node:crypto';
import { deliverConversationReply } from '../../public/scripts/neconyan-conversation/reply-delivery.js';
import { getConversationMessageRevision } from '../../public/scripts/neconyan-conversation/message-identity-utils.js';
import { MAX_THREAD_MESSAGES } from '../../public/scripts/neconyan-conversation/constants.js';
import { getCharacterData, getConversationSettings, getDefaultDirective } from '../endpoints/conversation-generation.js';
import { getConversationThreadKey } from '../endpoints/conversation-store.js';
import { validateConversationPayload } from '../endpoints/conversation-utils.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { acceptChildJobs, acceptJob, getJob, listJobs, mutateJobs, releaseChildJobs, releaseJob, requestCancellation, setJobResume, submissionKey as fingerprintSubmission, updateJob } from '../jobs/store.js';
import { noteOwner, registerHandler } from '../jobs/runner.js';
import { createMacroEnvironment } from '../macros/index.js';
import { appendConversationJobMessage, applyConversationBookkeeping, captureConversationTarget, prepareConversationTarget, commitConversationEffect, commitConversationJobCommands, commitConversationReplyNotice, readConversationTarget } from './conversation-effects.js';
import { runChatProfile } from './service.js';
import { getChatProfileContextLimit } from './profiles.js';
import { createConversationImageGenerator, conversationReplyWantsImage, lastUserMessageText } from './conversation-images.js';
import { buildConversationParticipantPlan, buildConversationParticipantSnapshot, captureConversationParticipantBindings, buildAvailabilityAutoResponderText, buildDelayedReplyNoticeText, getConversationAvailabilityDecision, getInitialAvailabilityDelayMs, getReplyDelayMsForStatus, manualActivity, resolveParticipantActivity } from './conversation-participants.js';
import { captureConversationRoleplaySource, getConversationAsideOccurrenceKey, getConversationGroupAsideCooldownMs, getConversationGroupAsideLastSent, normalizeConversationAsideSubmission } from './conversation-roleplay-source.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const TERMINAL_JOB_STATES = new Set(['completed', 'cancelled', 'failed', 'interrupted', 'conflict']);
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };

const MAX_INPUT_MESSAGES = 64;
const MAX_INPUT_MESSAGE_BYTES = 256 * 1024;
const MAX_INPUT_TOTAL_BYTES = 2 * 1024 * 1024;
// Mirrors the browser's SEND_QUEUE_COALESCE_MS: a burst of composer messages
// stays one batch until the user goes quiet for this long.
const COALESCE_WINDOW_MS = 5000;

const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => { clearTimeout(timer); const error = new Error('Aborted'); error.name = 'AbortError'; reject(error); };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
});

/** Validate composer-supplied user messages. Only display fields survive; nothing routing-related is accepted. */
function normalizeInputMessages(raw) {
    if (!Array.isArray(raw) || raw.length === 0) fail('A Conversation send needs at least one message.', 400);
    if (raw.length > MAX_INPUT_MESSAGES) fail('Too many Conversation messages were submitted at once.', 413);
    const messages = [];
    let total = 0;
    for (const item of raw) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) fail('A submitted Conversation message is invalid.', 400);
        if (item.role !== undefined && item.role !== 'user') fail('Only user messages can be submitted.', 400);
        const mes = String(item.mes ?? '');
        const extra = item.extra && typeof item.extra === 'object' && !Array.isArray(item.extra) ? item.extra : {};
        const size = Buffer.byteLength(mes) + Buffer.byteLength(JSON.stringify(extra));
        if (size > MAX_INPUT_MESSAGE_BYTES) fail('A submitted Conversation message is too large.', 413);
        total += size;
        if (total > MAX_INPUT_TOTAL_BYTES) fail('The submitted Conversation messages are too large.', 413);
        messages.push({ mes, extra });
    }
    return messages;
}

const MAX_ANCHOR_REVISION_BYTES = MAX_INPUT_MESSAGE_BYTES;

/** One message identity the browser captured: the id plus the revision it saw. */
function normalizeMessageAnchor(raw, label) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`The Conversation ${label} is invalid.`, 400);
    const messageId = typeof raw.messageId === 'string' ? raw.messageId.trim() : '';
    const revision = typeof raw.revision === 'string' ? raw.revision : '';
    if (!messageId || messageId.length > 256) fail(`The Conversation ${label} is invalid.`, 400);
    if (raw.revisionHash !== undefined) {
        if (!/^[a-f0-9]{64}$/.test(raw.revisionHash)) fail(`The Conversation ${label} revision is invalid.`, 400);
        return { messageId, revisionHash: raw.revisionHash };
    }
    if (!revision || Buffer.byteLength(revision) > MAX_ANCHOR_REVISION_BYTES) fail(`The Conversation ${label} revision is invalid.`, 400);
    return { messageId, revision };
}

/**
 * Validate the browser's captured identities. `triggers` are the user messages a
 * reply was drawn from; `replyTarget` is the message the user explicitly replied
 * to. A send has neither and only carries the branch identity it landed on.
 */
export function normalizeSubmissionAnchors(body) {
    const branchCreatedAt = body.branchCreatedAt === undefined || body.branchCreatedAt === null ? '' : String(body.branchCreatedAt);
    if (branchCreatedAt.length > 128) fail('The Conversation branch identity is invalid.', 400);
    const replyTarget = body.replyTarget === undefined || body.replyTarget === null ? null : normalizeMessageAnchor(body.replyTarget, 'reply target');
    let triggers = [];
    if (body.triggers !== undefined) {
        if (!Array.isArray(body.triggers) || body.triggers.length > MAX_THREAD_MESSAGES) fail('The Conversation triggers are invalid.', 400);
        triggers = body.triggers.map(entry => normalizeMessageAnchor(entry, 'trigger'));
    }
    return { branchCreatedAt, triggers, replyTarget };
}

function findAnchoredMessage(branch, messageId) {
    return (branch.messages || []).find(message => String(message?.id || '') === String(messageId));
}

export function normalizeBindingRequest(raw) {
    if (raw === undefined) return undefined;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.participants || typeof raw.participants !== 'object' || Array.isArray(raw.participants)) fail('The captured connections are invalid.', 400);
    const entries = Object.entries(raw.participants);
    if (!entries.length || entries.length > 128) fail('The captured connections are invalid.', 400);
    const participants = Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)).map(([avatar, binding]) => {
        if (!avatar || avatar.length > 256 || !binding || !/^[a-f0-9]{64}$/.test(binding.fingerprint)) fail('The captured connection is invalid.', 400);
        if (binding.kind === 'active') {
            if (!['chat', 'text'].includes(binding.backend)) fail('The captured active connection is invalid.', 400);
            if (!/^[a-f0-9]{64}$/.test(binding.characterRegexHash)) fail('The captured character transformations are invalid.', 400);
            return [avatar, { kind: 'active', backend: binding.backend, fingerprint: binding.fingerprint, characterRegexHash: binding.characterRegexHash }];
        }
        if (typeof binding.profileId !== 'string' || !binding.profileId || binding.profileId.length > 256 || (binding.backend !== undefined && binding.backend !== 'text')) fail('The captured profile is invalid.', 400);
        return [avatar, { profileId: binding.profileId, fingerprint: binding.fingerprint, ...(binding.backend ? { backend: binding.backend } : {}) }];
    }));
    let acknowledgement = null;
    if (raw.acknowledgement !== undefined && raw.acknowledgement !== null) {
        const { account, settingsRevision } = raw.acknowledgement;
        if (typeof account !== 'string' || !account || account.length > 256 || !Number.isSafeInteger(settingsRevision) || settingsRevision < 0) fail('The active settings acknowledgement is invalid.', 400);
        acknowledgement = { account, settingsRevision };
    }
    return { participants, acknowledgement };
}

/** Validate saved selections without accepting input or starting generation. */
export async function preflightConversationBindings(request, body = {}) {
    if (!body.target || typeof body.target !== 'object' || Array.isArray(body.target)) fail('A Conversation target is required.', 400);
    const target = captureConversationTarget(request, body.target);
    const current = readConversationTarget(request, target);
    const anchors = normalizeSubmissionAnchors(body);
    verifyConversationAnchors(current, target, anchors);
    const explicitSpeaker = resolveManualSpeaker(current, target, anchors, body.speakerAvatar);
    const manualOptions = body.options ? validateManualOptions(body.options) : undefined;
    const proposedMessages = body.messages === undefined ? [] : normalizeInputMessages(body.messages);
    if (body.directive !== undefined && (typeof body.directive !== 'string' || body.directive.length > 20000)) fail('The Conversation directive is invalid.', 400);
    const participants = await captureConversationParticipantBindings(request, current, target, { explicitSpeaker, acknowledgement: body.acknowledgement,
        includeChimes: Array.isArray(body.messages),
        proposedMessages, directive: getDefaultDirective(body), manualOptions, bindingOnly: body.bindingOnly === true && Boolean(body.speakerAvatar) && !manualOptions });
    const captured = normalizeBindingRequest({ participants, acknowledgement: body.acknowledgement });
    return { ...captured, contextLimits: Object.fromEntries(Object.entries(participants).map(([avatar, binding]) => [avatar, getChatProfileContextLimit(request.user.directories, binding)])) };
}

function resolveManualSpeaker(current, target, anchors, speakerAvatar) {
    let explicitSpeaker = resolveExplicitSpeaker(current, target, anchors.replyTarget);
    if (speakerAvatar !== undefined) {
        const speaker = speakerAvatar;
        if (typeof speaker !== 'string' || !speaker || speaker.length > 256) fail('The selected speaker is invalid.', 400);
        const eligible = speaker === target.avatar || (target.groupId
            ? current.group.members.includes(speaker) && !current.group.disabled_members?.includes(speaker)
            : current.branch.messages.some(message => message.role === 'partner' && message.extra?.partner_avatar === speaker));
        if (!eligible || (explicitSpeaker && explicitSpeaker !== speaker)) fail('The selected speaker is not part of this Conversation.', 409);
        explicitSpeaker = speaker;
    }
    return explicitSpeaker;
}

/** Manual helpers still write their result in the browser, but never choose another connection on failure. */
function validateManualOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || !validateConversationPayload(options).valid) fail('The generation input is invalid.', 400);
    const { prompt, responseLength, ...other } = options;
    if ((typeof prompt !== 'string' && !Array.isArray(prompt)) || (Array.isArray(prompt) && prompt.length > 512)
        || !Number.isSafeInteger(responseLength) || responseLength < 1 || responseLength > 64000) fail('The generation input is invalid.', 400);
    const texts = [JSON.stringify(other)];
    for (const message of typeof prompt === 'string' ? [{ content: prompt }] : prompt) {
        if (!message || typeof message !== 'object') fail('The generation message is invalid.', 400);
        if (typeof message.content === 'string') texts.push(message.content);
        else if (Array.isArray(message.content)) {
            for (const part of message.content) {
                if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text);
                else if (part?.type !== 'image_url' || typeof part.image_url?.url !== 'string') fail('The generation content is invalid.', 400);
            }
        } else fail('The generation content is invalid.', 400);
    }
    if (texts.some(text => Buffer.byteLength(text) > MAX_INPUT_MESSAGE_BYTES) || texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0) > MAX_INPUT_TOTAL_BYTES) fail('The generation text is too large.', 413);
    return options;
}

export async function generateBoundConversationText(request, body, signal) {
    const options = validateManualOptions(body.options);
    const submitted = normalizeBindingRequest(body.bindingRequest);
    if (!submitted) fail('A captured connection is required.', 400);
    const currentBindings = await preflightConversationBindings(request, { ...body, bindingOnly: false, acknowledgement: submitted.acknowledgement });
    if (hash(normalizeBindingRequest(currentBindings)) !== hash(submitted)) fail('The captured connection changed. Try again.', 409);
    const { prompt, responseLength, ...rawOptions } = options;
    const target = captureConversationTarget(request, body.target);
    const current = readConversationTarget(request, target);
    const avatar = body.speakerAvatar || target.avatar;
    const binding = submitted.participants[avatar];
    if (!binding) fail('The selected speaker has no captured connection.', 409);
    const snapshot = await buildConversationParticipantSnapshot(request, current, target, { avatar }, { binding, directive: '', timeZone: 'UTC' });
    const assertSource = () => {
        const fresh = captureConversationTarget(request, body.target);
        const latest = readConversationTarget(request, fresh);
        verifyConversationAnchors(latest, fresh, normalizeSubmissionAnchors(body));
        resolveManualSpeaker(latest, fresh, normalizeSubmissionAnchors(body), avatar);
    };
    assertSource();
    const messages = binding.kind === 'active' ? prompt : [
        ...(rawOptions.systemPrompt ? [{ role: 'system', content: rawOptions.systemPrompt }] : []),
        ...(Array.isArray(prompt) ? prompt : [{ role: 'user', content: prompt }]),
    ];
    const result = await runChatProfile({ context: { owner: request.user.profile.handle, directories: request.user.directories },
        binding, messages, maxTokens: responseLength, macroEnvironment: createMacroEnvironment(snapshot.macros),
        userName: snapshot.userName, characterName: snapshot.speaker.name, groupNames: snapshot.groupNames,
        rawOptions: binding.kind === 'active' ? rawOptions : {}, signal, beforeDispatch: assertSource });
    return { text: result.text };
}

/** Re-check every captured identity against the fresh branch. Appends are fine; edits and deletions are not. */
function verifyConversationAnchors(current, target, anchors) {
    if (!anchors) return;
    if (anchors.branchCreatedAt && String(target.createdAt) !== String(anchors.branchCreatedAt)) {
        fail('The Conversation branch was replaced. Try again.', 409);
    }
    for (const trigger of anchors.triggers || []) {
        const message = findAnchoredMessage(current.branch, trigger.messageId);
        if (!message || !matchesMessageAnchor(message, trigger)) {
            fail('A message this reply depends on changed. Try again.', 409);
        }
    }
}

function matchesMessageAnchor(message, anchor) {
    const revision = getConversationMessageRevision(message);
    return anchor.revisionHash ? createHash('sha256').update(revision).digest('hex') === anchor.revisionHash : revision === anchor.revision;
}

/** The speaker an explicit reply target names, or '' when the user did not target one. */
function resolveExplicitSpeaker(current, target, replyTarget) {
    if (!replyTarget) return '';
    const message = findAnchoredMessage(current.branch, replyTarget.messageId);
    if (!message || !matchesMessageAnchor(message, replyTarget)) {
        fail('The message you replied to changed. Try again.', 409);
    }
    if (['user', 'system'].includes(String(message.role || ''))) fail('That message cannot be replied to.', 409);
    const speaker = message.role === 'partner'
        ? String(message.extra?.partner_avatar || '').trim()
        : String(target.avatar || '').trim();
    if (!speaker) fail('The reply target no longer names a speaker.', 409);
    if (!target.groupId) {
        if (speaker === target.avatar) return speaker;
        // A solo thread has no membership list, but a partner who has already
        // spoken there is a known participant: allow the explicit reply.
        const spoke = (current.branch.messages || []).some(message => message?.role === 'partner'
            && String(message.extra?.partner_avatar || '').trim() === speaker);
        if (spoke) return speaker;
        fail('That reply target is not available in this thread.', 409);
    }
    const members = new Set((current.group?.members || []).map(member => String(member || '').trim()));
    if (!members.has(speaker) || (current.group?.disabled_members || []).includes(speaker)) {
        fail('The reply target is no longer part of this group.', 409);
    }
    return speaker;
}

/** The last captured trigger message, so a reply quotes what the user sent, not the newest bubble. */
function lastTriggerId(anchors) {
    const triggers = anchors?.triggers || [];
    return triggers.length ? String(triggers[triggers.length - 1].messageId) : '';
}

/**
 * Freeze the whole request: pick the participants, then build each one's card,
 * profile binding, system prompt and macro environment. The first participant is
 * also the top-level snapshot so the legacy single-speaker path keeps working.
 */
async function buildConversationSnapshot(request, target, directive, timeZone, { force = false, plan = null, automation = null, anchors = null, bindings = {}, includeChimes = false } = {}) {
    const current = readConversationTarget(request, target);
    verifyConversationAnchors(current, target, anchors);
    const explicitSpeaker = anchors ? resolveExplicitSpeaker(current, target, anchors.replyTarget) : '';
    const now = Date.now();
    const participants = [];
    // An autonomous occurrence freezes its own participants; a normal reply lets
    // the selection policy choose them from the captured thread.
    const selected = Array.isArray(plan) ? plan : await buildConversationParticipantPlan(request, current, target, { force, now, timeZone, explicitSpeaker, includeChimes });
    for (const item of selected) {
        participants.push(await buildConversationParticipantSnapshot(request, current, target, item, {
            directive: item.directive || directive, timeZone, force: force || item.force === true, now,
            extra: item.extra, automation: automation || item.automation || null,
            referenceMessageId: lastTriggerId(anchors),
            binding: Object.hasOwn(bindings, item.avatar) ? bindings[item.avatar] : null,
        }));
    }
    const primary = participants[0];
    if (Buffer.byteLength(JSON.stringify(participants)) > 16 * 1024 * 1024) fail('The Conversation request snapshot is too large.', 413);
    return {
        settings: primary.settings, userName: primary.userName, now: primary.now,
        snapshot: { ...primary, participants }, branch: current.branch,
    };
}

/**
 * Finish server-side preparation for an accepted submission: append the submitted
 * user messages and the request snapshot under one job, then release the job for
 * dispatch. Every write is receipt-protected, so repeating a crashed preparation
 * repairs it instead of duplicating messages.
 */
async function prepareConversationSubmission(request, job, { mode, messages, directive, timeZone }) {
    const directories = request.user.directories;
    const appended = await appendSubmissionMessages(request, job, messages, job.submissionKey);
    // Every submitted message must have a saved completion record before this
    // submission is acknowledged as durable; a partial append is repaired by the
    // next retry because the effect ids are deterministic per submission key.
    const durable = appended.userMessageIds.length === messages.length;
    updateJob(directories, job.id, { submissionUserMessageIds: appended.userMessageIds, inputDurable: durable });
    // A send batch stays paused until its coalescing window closes, so a burst of
    // composer messages becomes one request. A reply is a forced barrier and goes
    // straight out; the zero deadline only lets the reconciler repair a crash.
    if (mode === 'send') {
        updateJob(directories, job.id, current => ({ coalesce: { ...current.coalesce, deadline: Date.now() + COALESCE_WINDOW_MS } }));
        return { job: getJob(directories, job.id), created: false, inputDurable: durable, userMessageIds: appended.userMessageIds, native: appended.native };
    }
    await finalizeConversationSubmission(request, job);
    return { job: getJob(directories, job.id), created: false, inputDurable: durable, userMessageIds: appended.userMessageIds, native: appended.native };
}

/** Append a submission's user messages under a job with per-submission effect ids. */
function verifyAcceptedBranch(request, job, target) {
    const createdAt = job.target?.createdAt ?? readArtifact(request.user.directories, job.id, 'request')?.target?.createdAt ?? job.intent?.anchors?.branchCreatedAt;
    if (createdAt === undefined || createdAt === null || createdAt === '' || String(target.createdAt) !== String(createdAt)) {
        fail('The original Conversation branch cannot be verified. Already saved messages have been kept.');
    }
}

async function appendSubmissionMessages(request, job, messages, submissionKey, anchors = job.intent?.anchors) {
    const directories = request.user.directories;
    const context = { owner: job.owner, directories, job, signal: { throwIfAborted() {} } };
    const target = captureConversationTarget(request, job.intent.target);
    // The frozen branch identity must still hold: a reset branch recreates the
    // same key with a new createdAt, and appending into it would silently attach
    // this submission to the replacement branch.
    verifyAcceptedBranch(request, job, target);
    const current = readConversationTarget(request, target);
    verifyConversationAnchors(current, target, anchors);
    resolveExplicitSpeaker(current, target, anchors?.replyTarget);
    const userName = String(current.settings.power_user?.personas?.[target.personaId] || current.settings.name1 || 'User');
    const tag = hash(submissionKey).slice(0, 12);
    const userMessageIds = [];
    for (const [index, message] of messages.entries()) {
        const appended = await appendConversationJobMessage(context, target, `input:${tag}:${index}`, {
            role: 'user', name: userName, mes: message.mes, extra: { ...message.extra, conversation_mode_user: true },
        });
        userMessageIds.push(appended.id);
    }
    const fresh = readConversationTarget(request, target);
    return {
        userMessageIds,
        native: { threadKey: getConversationThreadKey(target.avatar, target.groupId, target.personaId), branchId: target.branchId, revision: fresh.version },
    };
}

/**
 * Re-append the messages of any coalesced member that did not finish saving, so a
 * crash between membership and append cannot lose a message or let the batch
 * generate without it. Members record their bounded input before appending.
 */
async function repairBatchMembers(request, job) {
    const members = Array.isArray(job.coalesce?.members) ? job.coalesce.members : [];
    if (!members.length) return job;
    for (const member of members) {
        const messages = Array.isArray(member?.messages) ? member.messages : null;
        if (messages?.length && member.userMessageIds?.length === messages.length) continue;
        if (!member?.key || !messages?.length || !member.anchors) {
            fail('A submitted Conversation message could not be verified. Already saved messages have been kept.', 409);
        }
        const appended = await appendSubmissionMessages(request, job, messages, member.key, member.anchors);
        updateJob(request.user.directories, job.id, current => ({ coalesce: { ...current.coalesce,
            members: current.coalesce.members.map(entry => entry.key === member.key ? { ...entry, userMessageIds: appended.userMessageIds } : entry) } }));
    }
    return getJob(request.user.directories, job.id);
}

/**
 * Build the frozen request snapshot for a prepared job and let the dispatcher see
 * it. Safe to repeat: the artifact is written once and releasing a queued job does
 * nothing. A cancelled job is never released.
 */
export async function finalizeConversationSubmission(request, job) {
    const directories = request.user.directories;
    job = getJob(directories, job.id);
    if (!job || job.cancellation?.requested || TERMINAL_JOB_STATES.has(job.state)) return job;
    if (!readArtifact(directories, job.id, 'request')) {
        try {
            verifyAcceptedBranch(request, job, captureConversationTarget(request, job.intent.target));
            job = await repairBatchMembers(request, job);
            const target = captureConversationTarget(request, job.intent.target);
            verifyAcceptedBranch(request, job, target);
            const built = await buildConversationSnapshot(request, target, job.intent.directive, job.intent.timeZone, {
                force: job.intent.force === true, plan: job.intent.plan, automation: job.intent.automation,
                anchors: job.intent.anchors || null,
                bindings: job.config?.participantBindings,
                includeChimes: job.config?.sendChimes === true,
            });
            const latest = getJob(directories, job.id);
            if (!latest || latest.cancellation?.requested || TERMINAL_JOB_STATES.has(latest.state)) return latest;
            // A send joining during the async snapshot must be included on the next pass.
            if (hash(latest.coalesce) !== hash(job.coalesce)) return latest;
            if (Number.isFinite(built.snapshot.automation?.delayMs) && built.snapshot.automation.delayMs > 0 && !built.snapshot.automation.delayUntil) {
                const delayUntil = Number(job.createdAt || Date.now()) + built.snapshot.automation.delayMs;
                built.snapshot.automation.delayUntil = delayUntil;
                for (const participant of Array.isArray(built.snapshot.participants) ? built.snapshot.participants : []) {
                    participant.automation = { ...(participant.automation || {}), delayUntil };
                }
            }
            if (Buffer.byteLength(JSON.stringify(built.snapshot)) > 16 * 1024 * 1024) fail('The Conversation request snapshot is too large.', 413);
            writeArtifact(directories, job.id, 'request', built.snapshot);
        } catch (error) {
            const latest = getJob(directories, job.id);
            if (!latest || latest.cancellation?.requested || TERMINAL_JOB_STATES.has(latest.state)) return latest;
            // A snapshot that can never be built would be retried every second;
            // fail it so the user can see the reason and retry or dismiss.
            updateJob(directories, job.id, {
                state: 'failed', stage: null, finishedAt: Date.now(), recoverability: 'needs-retry',
                error: { message: error.message, code: error.code ?? null, status: error.status ?? null },
            });
            return getJob(directories, job.id);
        }
    }
    releaseJob(directories, job.id);
    return getJob(directories, job.id);
}

/** Find the job a submission key belongs to, whether it led a batch or joined one. */
function findSubmission(directories, owner, key) {
    for (const job of listJobs(directories, { owner, includeDismissed: true })) {
        if (job.submissionKey === key) return { job, member: null };
        const member = Array.isArray(job.coalesce?.members) ? job.coalesce.members.find(entry => entry?.key === key) : null;
        if (member) return { job, member };
    }
    return null;
}

/** The open send batch this submission can still join, or null. */
function findCoalesceLeader(directories, owner, target, bindings, now, { force, timeZone, directive, anchors }) {
    const threadKey = getConversationThreadKey(target.avatar, target.groupId, target.personaId);
    return listJobs(directories, { owner, includeDismissed: true }).find(job => job.type === 'conversation.reply'
        && job.intent?.mode === 'send'
        && (job.intent?.force === true) === (force === true)
        && job.intent?.timeZone === timeZone
        && job.intent?.directive === directive
        // A batch answers one target: an explicit reply to a different message is its own reply.
        && hash(job.intent?.anchors?.replyTarget ?? null) === hash(anchors.replyTarget)
        && job.state === 'waiting' && job.stage === 'preparing'
        && !job.cancellation?.requested
        && job.target?.id === threadKey && job.target?.branchId === target.branchId
        && job.target?.createdAt === target.createdAt
        && Number(job.coalesce?.deadline) > now
        && job.config?.participantBindings
        && job.config.sendChimes === true
        && hash(job.config.participantBindings) === hash(bindings)) || null;
}

/**
 * Merge a later composer message into an open send batch. The message is saved
 * under the leader's receipts, so repeating the submission cannot duplicate it,
 * and the window is pushed out so a burst keeps extending the batch.
 *
 * ponytail: a message landing in the same moment the window closes can miss that
 * batch. It is still saved; the browser has the same late-message behaviour.
 */
async function joinCoalesceLeader(request, leader, { messages, submissionKey, anchors, intentFingerprint }) {
    const directories = request.user.directories;
    leader = getJob(directories, leader.id);
    if (leader.cancellation?.requested || leader.state !== 'waiting' || leader.stage !== 'preparing') fail('The Conversation batch is no longer accepting messages.');
    const target = captureConversationTarget(request, leader.intent.target);
    verifyAcceptedBranch(request, leader, target);
    const current = readConversationTarget(request, target);
    verifyConversationAnchors(current, target, anchors);
    resolveExplicitSpeaker(current, target, anchors.replyTarget);
    // Record membership, with the bounded input, before appending. A crash then
    // leaves a recoverable member rather than an orphaned message that a later
    // retry could append again under a fresh batch.
    updateJob(directories, leader.id, current => ({ coalesce: { ...current.coalesce,
        members: [...(current.coalesce?.members || []).filter(member => member.key !== submissionKey),
            { key: submissionKey, hash: hash({ messages, anchors }), intentFingerprint, messages, anchors, userMessageIds: [] }] } }));
    const appended = await appendSubmissionMessages(request, leader, messages, submissionKey, anchors);
    updateJob(directories, leader.id, current => ({
        coalesce: {
            ...current.coalesce, deadline: Date.now() + COALESCE_WINDOW_MS,
            members: current.coalesce.members.map(member => member.key === submissionKey ? { ...member, userMessageIds: appended.userMessageIds } : member),
        },
    }));
    return { job: getJob(directories, leader.id), created: false, inputDurable: appended.userMessageIds.length === messages.length, userMessageIds: appended.userMessageIds, native: appended.native };
}

/**
 * Accept a Conversation submission. `send` appends the composer's user messages
 * natively before the reply is queued; `reply` targets messages the browser has
 * already appended. Neither accepts credentials or a browser-built prompt.
 */
export async function acceptConversationSubmission(request, body = {}) {
    const owner = request.user?.profile?.handle;
    const directories = request.user?.directories;
    if (!owner || !directories?.root) fail('An authenticated account is required.', 401);
    if (typeof body.submissionKey !== 'string' || !body.submissionKey || body.submissionKey.length > 256) fail('A submission key is required.', 400);
    if (!body.target || typeof body.target !== 'object' || Array.isArray(body.target)) fail('A saved Conversation target is required.', 400);
    if (body.directive !== undefined && (typeof body.directive !== 'string' || body.directive.length > 20000)) fail('The reply directive is invalid.', 400);
    if (body.force !== undefined && typeof body.force !== 'boolean') fail('The forced-reply flag is invalid.', 400);
    const timeZone = typeof body.timeZone === 'string' ? body.timeZone : 'UTC';
    try { new Intl.DateTimeFormat('en-GB', { timeZone }).format(); } catch { fail('The reply timezone is invalid.', 400); }
    const mode = body.mode === undefined || body.mode === 'reply' ? 'reply' : body.mode === 'send' ? 'send' : null;
    if (!mode) fail('The Conversation submission mode is invalid.', 400);
    const messages = mode === 'send' ? normalizeInputMessages(body.messages) : [];
    const anchors = normalizeSubmissionAnchors(body);
    const bindingRequest = normalizeBindingRequest(body.bindingRequest);
    const intent = {
        mode,
        target: { avatar: body.target.avatar, groupId: body.target.groupId || '', personaId: body.target.personaId || '', branchId: body.target.branchId },
        directive: getDefaultDirective(body), timeZone, force: body.force === true, anchors,
        ...(mode === 'send' ? { inputHash: hash(messages) } : {}),
    };
    const existing = findSubmission(directories, owner, body.submissionKey);
    if (bindingRequest) intent.bindingRequest = bindingRequest;
    const intentFingerprint = fingerprintSubmission(owner, body.submissionKey, { ...intent, inputHash: undefined, messages });
    if (existing) {
        const member = existing.member;
        const matches = member
            ? member.intentFingerprint === intentFingerprint
            : hash(existing.job.intent) === hash(intent);
        if (existing.job.type !== 'conversation.reply' || !matches) fail('This submission key already belongs to another operation.');
        const recordedIds = member?.userMessageIds || existing.job.submissionUserMessageIds;
        if (member && mode === 'send' && recordedIds?.length === messages.length) {
            return { job: existing.job, created: false, inputDurable: true, userMessageIds: recordedIds };
        }
        // A job still preparing is repaired, not duplicated. Anything else must
        // already have every submitted message saved to be acknowledged.
        if (existing.job.state === 'waiting' && existing.job.stage === 'preparing') {
            return existing.member
                ? joinCoalesceLeader(request, existing.job, { messages, submissionKey: body.submissionKey, anchors, intentFingerprint })
                : prepareConversationSubmission(request, existing.job, { mode, messages, directive: intent.directive, timeZone });
        }
        // A send's user messages must all be saved before it is acknowledged;
        // a reply submits no messages, so it has nothing further to wait for.
        if (existing.job.intent?.mode === 'send') {
            if (!Array.isArray(recordedIds) || recordedIds.length !== messages.length) fail('This submission finished before all its messages could be saved. Already saved messages have been kept.');
            return { job: existing.job, created: false, inputDurable: true, userMessageIds: recordedIds };
        }
        return {
            job: existing.job, created: false, inputDurable: true,
            userMessageIds: existing.member?.userMessageIds || [],
        };
    }
    const target = await prepareConversationTarget(request, intent.target);
    const current = readConversationTarget(request, target);
    // Refuse a stale or edited source before any partial write: the branch, its
    // triggers and the explicit reply target must all still match what was seen.
    verifyConversationAnchors(current, target, anchors);
    const explicitSpeaker = resolveExplicitSpeaker(current, target, anchors.replyTarget);
    const bindings = await captureConversationParticipantBindings(request, current, target, { explicitSpeaker, acknowledgement: bindingRequest?.acknowledgement,
        includeChimes: mode === 'send',
        proposedMessages: messages, directive: intent.directive });
    if (bindingRequest && hash(normalizeBindingRequest({ participants: bindings, acknowledgement: bindingRequest.acknowledgement })) !== hash(bindingRequest)) fail('The saved participant connections changed. Check the connection and try again.', 409);
    if (mode === 'send') {
        const leader = findCoalesceLeader(directories, owner, target, bindings, Date.now(), intent);
        if (leader) return joinCoalesceLeader(request, leader, { messages, submissionKey: body.submissionKey, anchors, intentFingerprint });
    }
    const accepted = acceptJob(directories, { owner, type: 'conversation.reply', submissionKey: body.submissionKey, intent, paused: true,
        coalesce: { deadline: mode === 'send' ? Date.now() + COALESCE_WINDOW_MS : 0, members: [] },
        target: { kind: 'conversation', id: getConversationThreadKey(target.avatar, target.groupId, target.personaId), branchId: target.branchId, createdAt: target.createdAt },
        credentialRef: Object.values(bindings)[0], config: { participantBindings: bindings, sendChimes: mode === 'send' }, label: 'Conversation reply' });
    noteOwner(owner);
    const prepared = await prepareConversationSubmission(request, accepted.job, { mode, messages, directive: intent.directive, timeZone });
    return { ...prepared, created: accepted.created };
}

/** Accept a reply to an already-saved native branch. No credentials or browser prompt are accepted. */
export async function acceptConversationReply(request, body = {}) {
    return acceptConversationSubmission(request, { ...body, mode: 'reply' });
}

/**
 * Queue a server-decided autonomous message (reminder, schedule, idle, proactive,
 * chime or character chat). The occurrence carries its own participants and
 * directive; its deterministic key is the submission key, so the same occurrence
 * is accepted once. No composer message is appended and no batch is joined.
 */
export async function acceptConversationAutonomousReply(request, occurrence) {
    const owner = request.user?.profile?.handle;
    const directories = request.user?.directories;
    if (!owner || !directories?.root) fail('An authenticated account is required.', 401);
    if (!occurrence || typeof occurrence !== 'object' || typeof occurrence.key !== 'string' || !occurrence.key || occurrence.key.length > 256) fail('The automatic Conversation occurrence key is invalid.', 400);
    if (typeof occurrence.directive !== 'string' || !occurrence.directive) fail('The automatic Conversation directive is invalid.', 400);
    if (!Array.isArray(occurrence.participants) || !occurrence.participants.length) fail('The automatic Conversation participants are missing.', 400);
    const target = await prepareConversationTarget(request, occurrence.target);
    const current = readConversationTarget(request, target);
    const intent = {
        mode: 'auto',
        target: { avatar: target.avatar, groupId: target.groupId, personaId: target.personaId, branchId: target.branchId },
        directive: occurrence.directive, timeZone: occurrence.timeZone || 'UTC', force: true,
        plan: occurrence.participants.map(participant => ({
            avatar: participant.avatar, purpose: participant.purpose || 'auto',
            directive: participant.directive || occurrence.directive, extra: participant.extra || null,
        })),
        automation: { key: occurrence.key, kind: occurrence.kind || 'auto', patch: occurrence.bookkeeping || null,
            delayMs: Number.isFinite(occurrence.delayMs) && occurrence.delayMs > 0 ? occurrence.delayMs : 0,
            groupAsideKey: typeof occurrence.groupAsideKey === 'string' ? occurrence.groupAsideKey : '',
            roleplaySource: occurrence.roleplaySource || null },
    };
    const existing = findSubmission(directories, owner, occurrence.key);
    if (existing) {
        if (existing.job.type !== 'conversation.reply' || hash(existing.job.intent) !== hash(intent)) fail('This occurrence key already belongs to another operation.');
        return { job: existing.job, created: false };
    }
    const bindings = await captureConversationParticipantBindings(request, current, target, { plan: occurrence.participants });
    const accepted = acceptJob(directories, { owner, type: 'conversation.reply', submissionKey: occurrence.key, intent, automatic: true, paused: true,
        coalesce: { deadline: 0, members: [] },
        target: { kind: 'conversation', id: getConversationThreadKey(target.avatar, target.groupId, target.personaId), branchId: target.branchId, createdAt: target.createdAt },
        credentialRef: Object.values(bindings)[0], config: { participantBindings: bindings }, label: 'Conversation automatic message' });
    noteOwner(owner);
    await finalizeConversationSubmission(request, accepted.job);
    return { job: getJob(directories, accepted.job.id), created: accepted.created };
}

/**
 * Accept a Roleplay group aside or solo side DM. The browser keeps the event
 * sampling but sends only the saved source locator and revisions; the directive
 * is rebuilt here from the saved chat, and the source is reasserted before
 * generation and delivery. A group cooldown is keyed by persona + source group +
 * recipient, never by branch, and is claimed when the first bubble is delivered.
 */
export async function acceptConversationAside(request, body = {}) {
    const owner = request.user?.profile?.handle;
    const directories = request.user?.directories;
    if (!owner || !directories?.root) fail('An authenticated account is required.', 401);
    const submission = normalizeConversationAsideSubmission(body);
    const target = await prepareConversationTarget(request, { ...submission.target, groupId: '' });
    readConversationTarget(request, target);
    const key = getConversationAsideOccurrenceKey(owner, submission);
    const existing = findSubmission(directories, owner, key);
    if (existing) {
        if (existing.job.type !== 'conversation.reply') fail('This aside key already belongs to another operation.');
        return { job: existing.job, created: false };
    }
    // Eligibility and the shared cooldown are checked against the fresh store
    // after the async character read: two submissions that started together must
    // not both slip past the persona + group + recipient cooldown, and a settings
    // change during the read must still be honoured. Group asides follow the
    // browser and read the source group's settings; their delivery stays a solo DM.
    const character = await getCharacterData(request, target.avatar, { allowOverride: false, requireExisting: true });
    const fresh = readConversationTarget(request, target);
    const isGroup = submission.source.locator.group === true;
    const settings = getConversationSettings(request, fresh.store, target.avatar, isGroup ? submission.source.groupId : '', {}, { personaId: target.personaId });
    if (settings.enabled === false || (isGroup && settings.roleplay_reactions !== true)) {
        return { job: null, created: false, skipped: 'disabled' };
    }
    if (isGroup) {
        const activity = resolveParticipantActivity(
            { [target.avatar]: fresh.store.characters?.[getConversationThreadKey(target.avatar, '', target.personaId)] },
            target.avatar, target.personaId, fresh.store.runtimeStatusOverrides, Date.now(), fresh.store.automation?.timeZone || 'UTC',
        ) || manualActivity(settings);
        if (activity.status === 'offline') return { job: null, created: false, skipped: 'offline' };
    }
    const cooldownKey = isGroup
        ? JSON.stringify([submission.target.personaId, submission.source.groupId, submission.target.avatar])
        : '';
    if (cooldownKey) {
        const lastSent = getConversationGroupAsideLastSent(fresh.store, cooldownKey);
        if (Date.now() - lastSent < getConversationGroupAsideCooldownMs(submission.reason)) {
            return { job: null, created: false, skipped: 'cooldown' };
        }
        const busy = listJobs(directories, { owner, includeDismissed: false })
            .some(job => job.intent?.automation?.groupAsideKey === cooldownKey && !TERMINAL_JOB_STATES.has(job.state));
        if (busy) return { job: null, created: false, skipped: 'busy' };
    }
    const userName = String(fresh.settings?.power_user?.personas?.[target.personaId] || fresh.settings?.name1 || 'User');
    const captured = captureConversationRoleplaySource(request, submission, { characterName: character?.name || 'Character', userName });
    return acceptConversationAutonomousReply(request, {
        key,
        directive: captured.directive,
        target: { avatar: target.avatar, groupId: '', personaId: target.personaId, branchId: target.branchId },
        participants: [{ avatar: target.avatar, purpose: captured.kind, directive: captured.directive, extra: captured.extra }],
        kind: captured.kind,
        delayMs: captured.delayMs,
        groupAsideKey: cooldownKey || null,
        roleplaySource: submission,
        bookkeeping: cooldownKey ? { groupAside: { key: cooldownKey } } : {},
    });
}

/**
 * Persist an abortable delay so a restart waits only the remaining time. The
 * deadline is written once, before waiting, and reused on every retry.
 */
export async function waitForConversationJobDelay(context, effectId, delayMs, { now = Date.now, sleep = defaultSleep } = {}) {
    if (!Number.isFinite(delayMs) || delayMs <= 0) return;
    const name = `delay:${hash(effectId).slice(0, 16)}`;
    let saved = readArtifact(context.directories, context.job.id, name);
    if (!saved) {
        saved = { deadline: now() + Math.round(delayMs) };
        writeArtifact(context.directories, context.job.id, name, saved);
    }
    const remaining = saved.deadline - now();
    if (remaining <= 0) return;
    context.signal?.throwIfAborted();
    await sleep(remaining, context.signal);
}

/** One root owns the occurrence, including all its siblings, before any chime is dispatched. */
function claimChimeOccurrence(context, snapshot) {
    const chime = snapshot.participants.find(participant => participant.purpose === 'chime');
    if (!chime) return true;
    const markers = chime.automation?.patch?.sessionMarkers || {};
    const activity = markers.sb_conv_last_chime_session_ ?? markers[`sb_conv_last_chime_session_${snapshot.target.groupId || 'solo'}`];
    if (activity === undefined) return false;
    const { avatar, groupId, personaId, branchId, createdAt } = snapshot.target;
    const key = hash({ avatar, groupId, personaId, branchId, createdAt, activity });
    const request = { user: { profile: { handle: context.owner }, directories: context.directories } };
    const branch = readConversationTarget(request, snapshot.target).branch;
    return mutateJobs(context.directories, store => {
        const jobs = Object.values(store.jobs);
        const owner = jobs.find(job => job.config?.chimeClaim === key);
        if (owner) return { changed: false, allowed: owner.id === context.job.id };
        if (branch.sessionMarkers?.sb_conv_last_chime_session_ === activity) return { changed: false, allowed: false };
        const job = jobs.find(item => item.id === context.job.id);
        if (!job || job.cancellation?.requested) return { changed: false, allowed: false };
        job.config = { ...job.config, chimeClaim: key };
        return { job, allowed: true };
    }).allowed;
}

/** The root coordinates its frozen participants and holds the thread without a slot. */
async function runConversationRootJob(context, deps) {
    const directories = context.directories;
    const snapshot = readArtifact(directories, context.job.id, 'request');
    if (!snapshot) fail('The accepted Conversation snapshot is unavailable. Resubmit the request.');
    if (readArtifact(directories, context.job.id, 'result')) return { artifact: true };
    if (!Array.isArray(snapshot.participants)) {
        // A job accepted before participant support ran its own single reply.
        return runConversationParticipantJob(context, deps);
    }
    setJobResume(directories, context.job.id, 'children');
    const threadKey = getConversationThreadKey(snapshot.target.avatar, snapshot.target.groupId, snapshot.target.personaId);
    try {
        const ownsChimes = claimChimeOccurrence(context, snapshot);
        const participants = snapshot.participants.filter(participant => participant.purpose !== 'chime' || ownsChimes);
        if (!participants.length) return { skipped: 'chime-already-owned' };
        const children = acceptChildJobs(directories, context.job.id, participants.map(participant => ({
            participantKey: participant.speaker.avatar,
            intent: { participantKey: participant.speaker.avatar, purpose: participant.purpose || 'reply' },
            target: { kind: 'conversation', id: threadKey, branchId: snapshot.target.branchId },
            credentialRef: participant.binding,
            config: { speakerAvatar: participant.speaker.avatar, speakerName: participant.speaker.name },
        })));
        for (const child of children) {
            if (readArtifact(directories, child.id, 'request')) continue;
            const participant = snapshot.participants.find(item => item.speaker.avatar === child.intent.participantKey);
            if (participant) writeArtifact(directories, child.id, 'request', participant);
        }
        releaseChildJobs(directories, context.job.id);
        return { children: children.map(child => child.id) };
    } catch (error) {
        // A child created but not released would wait forever; cancel the family
        // so the ledger stays consistent and the failure is actionable.
        try { requestCancellation(directories, context.job.id, { reason: 'Participant preparation failed.' }); } catch { /* the original error is the real failure */ }
        throw error;
    }
}

/** One participant: evaluate availability, then model and delivery, each receipt-protected. */
async function runConversationParticipantJob(context, deps) {
    const directories = context.directories;
    const snapshot = readArtifact(directories, context.job.id, 'request');
    if (!snapshot) fail('The accepted Conversation snapshot is unavailable. Resubmit the request.');
    if (readArtifact(directories, context.job.id, 'result')) return { artifact: true };
    const { target, binding, speaker, settings, userName } = snapshot;
    const force = snapshot.force === true;
    // An autonomous message was already chosen by the server's policy, so it
    // skips the interactive availability gate and writes with its own metadata.
    const automation = snapshot.automation || null;
    // A snapshot accepted before participant support already passed the browser's
    // own gate; re-gating it here would skip or auto-answer work it chose to do.
    const legacy = snapshot.activity === undefined && snapshot.gate === undefined;
    const activity = snapshot.activity || manualActivity(settings);
    const solo = snapshot.gate !== false;
    const decision = automation || legacy ? { action: 'reply', status: activity.status } : getConversationAvailabilityDecision({ settings, activity, force, solo });
    if (decision.action === 'skip') {
        writeArtifact(directories, context.job.id, 'result', { skipped: 'offline' });
        return { artifact: true };
    }
    // A receipt-only checkpoint validates ownership and the source before any work.
    await commitConversationEffect(context, target, 'accepted', () => null);
    if (decision.action === 'autoresponder') {
        await appendConversationJobMessage(context, target, 'autoresponder', {
            role: 'character', name: speaker.name, mes: buildAvailabilityAutoResponderText(settings, speaker.name, userName),
            extra: { conversation_mode_auto_responder: true, availability: settings.availability, ...(speaker.avatar !== target.avatar ? { partner_avatar: speaker.avatar } : {}) },
        });
        writeArtifact(directories, context.job.id, 'result', { skipped: 'autoresponder' });
        return { artifact: true };
    }
    if (decision.action === 'delay') {
        await waitForConversationJobDelay(context, 'initial', getInitialAvailabilityDelayMs(decision.status, deps.random), deps);
    }
    if (automation?.delayUntil) {
        const remaining = Number(automation.delayUntil) - deps.now();
        if (remaining > 0) {
            // Mark the wait resumable so a restart during the aside delay is
            // requeued; clearing it after makes a crash during generation an
            // interrupted unknown outcome instead of a charged automatic repeat.
            setJobResume(directories, context.job.id, 'automation-delay');
            try {
                await waitForConversationJobDelay(context, 'automation-delay', remaining, deps);
            } finally {
                setJobResume(directories, context.job.id, null);
            }
        }
    }
    // The browser posts the "replies may be slow" notice for a schedule-driven
    // dnd/offline speaker, but not when the manual availability already says so.
    const manualSuppressed = activity.source === 'manual' && ['dnd', 'offline'].includes(String(settings.availability || ''));
    if (!legacy && !automation && ['dnd', 'offline'].includes(decision.status) && !manualSuppressed) {
        await commitConversationReplyNotice(context, target, speaker, activity, {
            noticeText: buildDelayedReplyNoticeText(speaker.name, activity.activity), now: deps.now(),
        });
    }
    let response = readArtifact(directories, context.job.id, 'reply');
    if (!response) {
        // Reassert the saved source immediately before paying for a provider
        // call: the chat, message and group may have changed since acceptance.
        if (automation?.roleplaySource) {
            captureConversationRoleplaySource({ user: { directories } }, automation.roleplaySource, { characterName: speaker.name, userName });
        }
        const separateSystem = binding.kind === 'active' && snapshot.messages[0]?.role === 'system';
        response = await deps.generate({ context, jobContext: context, binding, messages: separateSystem ? snapshot.messages.slice(1) : snapshot.messages,
            maxTokens: settings.reply_max_tokens, userName, characterName: speaker.name,
            groupNames: snapshot.groupNames || [], rawOptions: separateSystem ? { systemPrompt: snapshot.messages[0].content } : {},
            macroEnvironment: createMacroEnvironment(snapshot.macros) });
        writeArtifact(directories, context.job.id, 'reply', response);
    }
    if (typeof response.text !== 'string' || !response.text.trim()) fail('The model returned an empty Conversation reply.', 502);
    if (Buffer.byteLength(response.text) > 256 * 1024) fail('The model reply exceeded the Conversation message limit.', 502);
    setJobResume(directories, context.job.id, 'delivery');
    let imageDelivered = false;
    let bookkeepingApplied = false;
    const metadata = snapshot.extra && typeof snapshot.extra === 'object' ? snapshot.extra : {};
    const result = await deliverConversationReply(response.text, settings, {
        fallbackSpeaker: speaker, groupId: target.groupId, splitEveryLine: speaker.avatar !== target.avatar,
        getSpeakers: () => snapshot.speakers,
        validateTarget: () => { context.signal.throwIfAborted(); return true; },
        append: async (text, author, delivery) => {
            const delayMs = getReplyDelayMsForStatus(text, settings, activity.status);
            await waitForConversationJobDelay(context, `bubble-delay:${delivery.chunk}:${delivery.bubble}`, delayMs, deps);
            // Reassert the saved source after each delivery delay, including a
            // resumed delivery: the source chat or its group may have changed.
            if (automation?.roleplaySource) {
                captureConversationRoleplaySource({ user: { directories } }, automation.roleplaySource, { characterName: speaker.name, userName });
            }
            const group = readConversationTarget({ user: { directories } }, target).group;
            if (target.groupId && (!group?.members?.includes(author.avatar) || group.disabled_members?.includes(author.avatar))) fail('The reply participant is no longer available.');
            return appendConversationJobMessage(context, target, `bubble:${delivery.chunk}:${delivery.bubble}`, {
                role: author.avatar === target.avatar ? 'character' : 'partner', name: author.name, mes: text,
                extra: { ...metadata, ...delivery.extra, ...(author.avatar !== target.avatar ? { partner_avatar: author.avatar } : {}),
                    ...(delivery.attachReplyReference && snapshot.replyReference ? { conversation_reply_to: snapshot.replyReference } : {}) },
            }, {
                // The first committed bubble consumes the occurrence and applies
                // its counters in the same native write as the message.
                mutate: automation && !bookkeepingApplied
                    ? (branch, store) => { applyConversationBookkeeping(branch, store, automation.patch, automation.key, deps.now()); bookkeepingApplied = true; }
                    : undefined,
            });
        },
        commitCommands: (parts, avatar, delivery) => commitConversationJobCommands(context, target, `commands:${delivery.chunk}`, parts, avatar, snapshot.timeZone || context.job.intent.timeZone, snapshot.now),
        generateImage: async (requestText, imageSpeaker, delivery) => {
            const saved = await deps.generateImage(context, snapshot, requestText, imageSpeaker, delivery);
            imageDelivered = imageDelivered || saved === true;
            return saved;
        },
    });
    // The browser also sends a keyword/spontaneous selfie after an ordinary reply,
    // reminder, schedule, idle or proactive message; chimes and character chat do
    // not, so an old user message cannot force a selfie on them.
    const imageEligible = ['reply', 'reminder', 'schedule', 'idle-followup', 'idle-spontaneous', 'proactive'].includes(snapshot.purpose || 'reply');
    const imageText = automation ? response.text : lastUserMessageText(snapshot.macros?.extra?.chat || []);
    if (imageEligible && !imageDelivered && conversationReplyWantsImage(settings, imageText)) {
        await deps.generateImage(context, snapshot, '', speaker, { chunk: 'spontaneous', image: 0, attachReplyReference: false, extra: {} });
    }
    writeArtifact(directories, context.job.id, 'result', result);
    return { artifact: true };
}

/** Register the Conversation root coordinator and its sibling participant worker. */
export function registerConversationReplyJob({ generate = runChatProfile, generateImage = createConversationImageGenerator(), now = Date.now, random = Math.random, sleep = defaultSleep } = {}) {
    const deps = { generate, generateImage, now, random, sleep };
    registerHandler('conversation.reply', context => runConversationRootJob(context, deps));
    registerHandler('conversation.participant', context => runConversationParticipantJob(context, deps), { allowSiblingConcurrency: true });
}

registerConversationReplyJob();
