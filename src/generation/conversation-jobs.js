import { createHash } from 'node:crypto';
import { deliverConversationReply } from '../../public/scripts/neconyan-conversation/reply-delivery.js';
import { getConversationSettings, getDefaultDirective } from '../endpoints/conversation-generation.js';
import { getConversationThreadKey } from '../endpoints/conversation-store.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { acceptChildJobs, acceptJob, getJob, listJobs, releaseChildJobs, releaseJob, requestCancellation, setJobResume, updateJob } from '../jobs/store.js';
import { noteOwner, registerHandler } from '../jobs/runner.js';
import { createMacroEnvironment } from '../macros/index.js';
import { appendConversationJobMessage, captureConversationTarget, commitConversationEffect, commitConversationJobCommands, commitConversationReplyNotice, readConversationTarget } from './conversation-effects.js';
import { captureChatProfile } from './profiles.js';
import { runChatProfile } from './service.js';
import { createConversationImageGenerator, conversationReplyWantsImage, lastUserMessageText } from './conversation-images.js';
import { buildConversationParticipantPlan, buildConversationParticipantSnapshot, buildAvailabilityAutoResponderText, buildDelayedReplyNoticeText, getConversationAvailabilityDecision, getInitialAvailabilityDelayMs, getReplyDelayMsForStatus, manualActivity } from './conversation-participants.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
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

/**
 * Freeze the whole request: pick the participants, then build each one's card,
 * profile binding, system prompt and macro environment. The first participant is
 * also the top-level snapshot so the legacy single-speaker path keeps working.
 */
async function buildConversationSnapshot(request, target, directive, timeZone, { force = false } = {}) {
    const current = readConversationTarget(request, target);
    const now = Date.now();
    const plan = await buildConversationParticipantPlan(request, current, target, { force, now, timeZone });
    const participants = [];
    for (const item of plan) {
        participants.push(await buildConversationParticipantSnapshot(request, current, target, item, { directive, timeZone, force, now }));
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
    // A send batch stays paused until its coalescing window closes, so a burst of
    // composer messages becomes one request. A reply is a forced barrier and goes
    // straight out; the zero deadline only lets the reconciler repair a crash.
    if (mode === 'send') {
        updateJob(directories, job.id, { coalesce: { ...(job.coalesce || {}), deadline: Date.now() + COALESCE_WINDOW_MS } });
        return { job: getJob(directories, job.id), created: false, inputDurable: true, userMessageIds: appended.userMessageIds, native: appended.native };
    }
    await finalizeConversationSubmission(request, job);
    return { job: getJob(directories, job.id), created: false, inputDurable: true, userMessageIds: appended.userMessageIds, native: appended.native };
}

/** Append a submission's user messages under a job with per-submission effect ids. */
async function appendSubmissionMessages(request, job, messages, submissionKey) {
    const directories = request.user.directories;
    const context = { owner: job.owner, directories, job, signal: { throwIfAborted() {} } };
    const target = captureConversationTarget(request, job.intent.target);
    const current = readConversationTarget(request, target);
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
 * Build the frozen request snapshot for a prepared job and let the dispatcher see
 * it. Safe to repeat: the artifact is written once and releasing a queued job does
 * nothing. A cancelled job is never released.
 */
export async function finalizeConversationSubmission(request, job) {
    const directories = request.user.directories;
    if (!readArtifact(directories, job.id, 'request')) {
        try {
            const target = captureConversationTarget(request, job.intent.target);
            const built = await buildConversationSnapshot(request, target, job.intent.directive, job.intent.timeZone, { force: job.intent.force === true });
            if (Buffer.byteLength(JSON.stringify(built.snapshot)) > 16 * 1024 * 1024) fail('The Conversation request snapshot is too large.', 413);
            writeArtifact(directories, job.id, 'request', built.snapshot);
        } catch (error) {
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
function findCoalesceLeader(directories, owner, target, binding, now, { force, timeZone }) {
    const threadKey = getConversationThreadKey(target.avatar, target.groupId, target.personaId);
    return listJobs(directories, { owner, includeDismissed: true }).find(job => job.type === 'conversation.reply'
        && job.intent?.mode === 'send'
        && (job.intent?.force === true) === (force === true)
        && job.intent?.timeZone === timeZone
        && job.state === 'waiting' && job.stage === 'preparing'
        && !job.cancellation?.requested
        && job.target?.id === threadKey && job.target?.branchId === target.branchId
        && job.credentialRef?.profileId === binding?.profileId
        && job.credentialRef?.fingerprint === binding?.fingerprint
        && Number(job.coalesce?.deadline) > now) || null;
}

/**
 * Merge a later composer message into an open send batch. The message is saved
 * under the leader's receipts, so repeating the submission cannot duplicate it,
 * and the window is pushed out so a burst keeps extending the batch.
 *
 * ponytail: a message landing in the same moment the window closes can miss that
 * batch. It is still saved; the browser has the same late-message behaviour.
 */
async function joinCoalesceLeader(request, leader, { messages, submissionKey }) {
    const directories = request.user.directories;
    const appended = await appendSubmissionMessages(request, leader, messages, submissionKey);
    const members = [...(leader.coalesce?.members || []).filter(member => member?.key !== submissionKey), { key: submissionKey, hash: hash(messages), userMessageIds: appended.userMessageIds }];
    updateJob(directories, leader.id, { coalesce: { ...(leader.coalesce || {}), deadline: Date.now() + COALESCE_WINDOW_MS, members } });
    return { job: getJob(directories, leader.id), created: false, inputDurable: true, userMessageIds: appended.userMessageIds, native: appended.native };
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
    const intent = {
        mode,
        target: { avatar: body.target.avatar, groupId: body.target.groupId || '', personaId: body.target.personaId || '', branchId: body.target.branchId },
        directive: getDefaultDirective(body), timeZone, force: body.force === true,
        ...(mode === 'send' ? { inputHash: hash(messages) } : {}),
    };
    const existing = findSubmission(directories, owner, body.submissionKey);
    if (existing) {
        const matches = existing.member ? existing.member.hash === hash(messages) : hash(existing.job.intent) === hash(intent);
        if (existing.job.type !== 'conversation.reply' || !matches) fail('This submission key already belongs to another operation.');
        // A job still preparing is repaired, not duplicated. Anything else is already durable.
        if (existing.job.state === 'waiting' && existing.job.stage === 'preparing') {
            return existing.member
                ? joinCoalesceLeader(request, existing.job, { messages, submissionKey: body.submissionKey })
                : prepareConversationSubmission(request, existing.job, { mode, messages, directive: intent.directive, timeZone });
        }
        if (existing.member && !existing.member.userMessageIds?.length) fail('This submission finished before its message could be saved. Send it again.');
        return { job: existing.job, created: false, inputDurable: true, userMessageIds: existing.member?.userMessageIds || [] };
    }
    const target = captureConversationTarget(request, intent.target);
    const current = readConversationTarget(request, target);
    const settings = getConversationSettings(request, current.store, target.avatar, target.groupId, {}, { personaId: target.personaId });
    const binding = captureChatProfile(directories, settings.connection_profile);
    if (mode === 'send') {
        const leader = findCoalesceLeader(directories, owner, target, binding, Date.now(), { force: intent.force, timeZone });
        if (leader) return joinCoalesceLeader(request, leader, { messages, submissionKey: body.submissionKey });
    }
    const accepted = acceptJob(directories, { owner, type: 'conversation.reply', submissionKey: body.submissionKey, intent, paused: true,
        coalesce: { deadline: mode === 'send' ? Date.now() + COALESCE_WINDOW_MS : 0, members: [] },
        target: { kind: 'conversation', id: getConversationThreadKey(target.avatar, target.groupId, target.personaId), branchId: target.branchId },
        credentialRef: binding, config: {}, label: 'Conversation reply' });
    noteOwner(owner);
    const prepared = await prepareConversationSubmission(request, accepted.job, { mode, messages, directive: intent.directive, timeZone });
    return { ...prepared, created: accepted.created };
}

/** Accept a reply to an already-saved native branch. No credentials or browser prompt are accepted. */
export async function acceptConversationReply(request, body = {}) {
    return acceptConversationSubmission(request, { ...body, mode: 'reply' });
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
        const children = acceptChildJobs(directories, context.job.id, snapshot.participants.map(participant => ({
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
    // A snapshot accepted before participant support already passed the browser's
    // own gate; re-gating it here would skip or auto-answer work it chose to do.
    const legacy = snapshot.activity === undefined && snapshot.gate === undefined;
    const activity = snapshot.activity || manualActivity(settings);
    const solo = snapshot.gate !== false;
    const decision = legacy ? { action: 'reply', status: activity.status } : getConversationAvailabilityDecision({ settings, activity, force, solo });
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
    // The browser posts the "replies may be slow" notice for a schedule-driven
    // dnd/offline speaker, but not when the manual availability already says so.
    const manualSuppressed = activity.source === 'manual' && ['dnd', 'offline'].includes(String(settings.availability || ''));
    if (!legacy && ['dnd', 'offline'].includes(decision.status) && !manualSuppressed) {
        await commitConversationReplyNotice(context, target, speaker, activity, {
            noticeText: buildDelayedReplyNoticeText(speaker.name, activity.activity), now: deps.now(),
        });
    }
    let response = readArtifact(directories, context.job.id, 'reply');
    if (!response) {
        response = await deps.generate({ context, jobContext: context, binding, messages: snapshot.messages,
            maxTokens: settings.reply_max_tokens, userName, characterName: speaker.name,
            macroEnvironment: createMacroEnvironment(snapshot.macros) });
        writeArtifact(directories, context.job.id, 'reply', response);
    }
    if (typeof response.text !== 'string' || !response.text.trim()) fail('The model returned an empty Conversation reply.', 502);
    if (Buffer.byteLength(response.text) > 256 * 1024) fail('The model reply exceeded the Conversation message limit.', 502);
    setJobResume(directories, context.job.id, 'delivery');
    let imageDelivered = false;
    const result = await deliverConversationReply(response.text, settings, {
        fallbackSpeaker: speaker, groupId: target.groupId, splitEveryLine: speaker.avatar !== target.avatar,
        getSpeakers: () => snapshot.speakers,
        validateTarget: () => { context.signal.throwIfAborted(); return true; },
        append: async (text, author, delivery) => {
            const delayMs = getReplyDelayMsForStatus(text, settings, activity.status);
            await waitForConversationJobDelay(context, `bubble-delay:${delivery.chunk}:${delivery.bubble}`, delayMs, deps);
            const group = readConversationTarget({ user: { directories } }, target).group;
            if (target.groupId && (!group?.members?.includes(author.avatar) || group.disabled_members?.includes(author.avatar))) fail('The reply participant is no longer available.');
            return appendConversationJobMessage(context, target, `bubble:${delivery.chunk}:${delivery.bubble}`, {
                role: author.avatar === target.avatar ? 'character' : 'partner', name: author.name, mes: text,
                extra: { ...delivery.extra, ...(author.avatar !== target.avatar ? { partner_avatar: author.avatar } : {}),
                    ...(delivery.attachReplyReference && snapshot.replyReference ? { conversation_reply_to: snapshot.replyReference } : {}) },
            });
        },
        commitCommands: (parts, avatar, delivery) => commitConversationJobCommands(context, target, `commands:${delivery.chunk}`, parts, avatar, snapshot.timeZone || context.job.intent.timeZone, snapshot.now),
        generateImage: async (requestText, imageSpeaker, delivery) => {
            const saved = await deps.generateImage(context, snapshot, requestText, imageSpeaker, delivery);
            imageDelivered = imageDelivered || saved === true;
            return saved;
        },
    });
    // The browser also sends a keyword/spontaneous selfie after an ordinary reply.
    if (!imageDelivered && conversationReplyWantsImage(settings, lastUserMessageText(snapshot.macros?.extra?.chat || []))) {
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
