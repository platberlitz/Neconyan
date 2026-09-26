import {
    MEMORY_SUMMARY_INTERVAL_MESSAGES,
    MEMORY_SUMMARY_MIN_MESSAGES,
    MEMORY_SUMMARY_RESPONSE_TOKENS,
} from '../../public/scripts/neconyan-conversation/constants.js';
import { normalizeEditedSchedule, parseScheduleResponse } from '../../public/scripts/neconyan-conversation/schedule-utils.js';
import { getConversationAttachmentSummary } from '../../public/scripts/neconyan-conversation/thread-store-utils.js';
import { runChatProfile, validateActiveGenerationContext } from './service.js';
import { resolveGenerationProfile } from './profiles.js';
import { normalizeBindingRequest, normalizeSubmissionAnchors, preflightConversationBindings } from './conversation-jobs.js';
import { buildConversationParticipantSnapshot } from './conversation-participants.js';
import { createMacroEnvironment } from '../macros/index.js';
import { hash } from '../mewmory/core.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { acceptJob, getJob, listJobs, releaseJob, setJobResume, updateJob } from '../jobs/store.js';
import { noteOwner, registerHandler } from '../jobs/runner.js';
import { getCharacterData, getConversationSettings, normalizeConversationSettings } from '../endpoints/conversation-generation.js';
import { ensureConversationStore, getConversationThreadKey, readUserSettingsWithStatus, saveConversationStore } from '../endpoints/conversation-store.js';
import { getConversationThreadStore } from '../endpoints/conversation-threads.js';
import {
    authorizeConversationGroup,
    getConversationGroupRecord,
    normalizeConversationGroupRecord,
    normalizeGroupConversationSettings,
} from '../endpoints/conversation-groups.js';
import { getSettingsVersion } from '../settings-version.js';
import {
    prepareConversationTarget,
    commitConversationMemorySummary,
    getConversationMemoryFingerprint,
    commitConversationStoreEffect,
    readConversationTarget,
    retainConversationAutomaticAcceptance,
    wasConversationAutomaticOccurrenceAccepted,
} from './conversation-effects.js';

const SUMMARY_SYSTEM_PROMPT = 'You maintain a concise private DM memory summary for realistic ongoing chat continuity.';
const SCHEDULE_SYSTEM_PROMPT = [
    'You are a schedule generator. Create a realistic weekly schedule for a character based on their personality and description.',
    'Each time block must include a "status" field indicating availability:',
    '- "online": awake and available (free time, socializing, casual activities)',
    '- "idle": semi-available (eating, commuting, showering, cooking)',
    '- "dnd": busy / do not disturb (working, studying, training, in a meeting, focused tasks)',
    '- "offline": unavailable (sleeping, passed out, unconscious)',
    'Also assess the character\'s talkativeness on a scale of 0-100 (how often they initiate contact).',
    'And estimate how long in minutes this character would wait before messaging someone who has not replied (very patient: 180-360, average: 90-150, eager: 15-60).',
    'RESPOND IN EXACTLY THIS JSON FORMAT (no markdown, no code blocks, just raw JSON):',
    '{"talkativeness":50,"inactivityThresholdMinutes":120,"days":{"0":[{"time":"08:00-12:00","activity":"working","status":"dnd"}],"1":[],"2":[],"3":[],"4":[],"5":[],"6":[]}}',
    'Days are keyed 0=Sunday through 6=Saturday. Cover each day with several blocks spanning a full 24 hours including sleep.',
].join('\n');

const MAX_RESPONSE_BYTES = 256 * 1024;

function fail(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function hasContent(message) {
    return String(message?.mes ?? '').trim().length > 0 || Boolean(getConversationAttachmentSummary(message));
}

function formatTranscript(messages, limit) {
    return messages.slice(-limit)
        .map(message => `${message.name || 'Speaker'}: ${[String(message.mes || '').slice(0, 1800), message.attachmentSummary].filter(Boolean).join(' ')}`)
        .join('\n');
}

export function eligibleMessages(branch) {
    return (branch.messages || []).filter(message => message.role !== 'system' && hasContent(message));
}

function automaticSummaryAllowed(request, current, target) {
    return current.store.automation?.mode === 'server'
        && getConversationSettings(request, current.store, target.avatar, target.groupId, {}, { personaId: target.personaId }).enabled !== false;
}

/** Older manual summaries stored a count rather than a cursor. */
export function countNewMessages(messages, cursor, count) {
    if (!cursor) return Math.max(0, messages.length - (Number(count) || 0));
    const index = messages.findIndex(message => message.id === cursor);
    return index >= 0 ? messages.length - index - 1 : messages.length;
}

export function buildConversationSummaryPrompt(snapshot) {
    const lines = [
        `Main DM: ${snapshot.characterName} with ${snapshot.userName}.`,
        'Summarize durable DM memory only: relationship tone, promises, unresolved topics, preferences, private jokes, boundaries, and emotionally important beats.',
        'Ignore filler small talk unless it changes the relationship. Keep it compact and useful for future replies.',
        '',
    ];
    if (snapshot.previousSummary) {
        lines.push('Current summary:', snapshot.previousSummary, '');
    }
    lines.push(formatTranscript(snapshot.messages, 36));
    return lines.join('\n');
}

export function buildConversationSchedulePrompt(character) {
    const parts = [`Character name: ${character.name || 'The character'}`];
    const description = String(character.description || '').slice(0, 1800);
    const personality = String(character.personality || '').slice(0, 1200);
    if (description) parts.push(`Description: ${description}`);
    if (personality) parts.push(`Personality: ${personality}`);
    parts.push('Generate the weekly schedule JSON now.');
    return parts.join('\n\n');
}

async function buildSummarySnapshot(request, job) {
    const current = readConversationTarget(request, job.intent.target);
    const branch = current.branch;
    const character = await getCharacterData(request, job.intent.target.avatar, { allowOverride: false });
    const messages = eligibleMessages(branch);
    const throughId = messages.at(-1)?.id || '';
    const participant = await buildConversationParticipantSnapshot(request, current, job.intent.target, { avatar: job.intent.target.avatar }, {
        binding: job.credentialRef, directive: '', timeZone: 'UTC',
    });
    return {
        target: job.intent.target,
        binding: job.credentialRef,
        characterName: character.name || 'Character',
        userName: participant.userName, macros: participant.macros, groupNames: participant.groupNames,
        previousSummary: branch.memorySummary || '',
        memoryFingerprint: getConversationMemoryFingerprint(branch),
        messages: messages.map(message => {
            const attachmentSummary = getConversationAttachmentSummary(message);
            return { id: message.id, name: message.name, mes: message.mes, ...(attachmentSummary ? { attachmentSummary } : {}) };
        }),
        throughId,
        count: messages.length,
    };
}

function maintenanceGenerationOptions(snapshot, kind) {
    const summary = kind === 'summary';
    const systemPrompt = summary ? SUMMARY_SYSTEM_PROMPT : SCHEDULE_SYSTEM_PROMPT;
    return {
        binding: snapshot.binding,
        messages: [
            ...(snapshot.binding.kind === 'active' ? [] : [{ role: 'system', content: systemPrompt }]),
            { role: 'user', content: summary ? buildConversationSummaryPrompt(snapshot) : buildConversationSchedulePrompt(snapshot.character) },
        ],
        maxTokens: summary ? MEMORY_SUMMARY_RESPONSE_TOKENS : 8000,
        userName: snapshot.userName || 'User', characterName: summary ? snapshot.characterName : snapshot.character.name,
        groupNames: snapshot.groupNames || [], macroEnvironment: createMacroEnvironment(snapshot.macros || {}),
        rawOptions: snapshot.binding.kind === 'active' ? { systemPrompt } : {},
    };
}

async function validateMaintenanceSnapshot(request, snapshot, kind) {
    const options = maintenanceGenerationOptions(snapshot, kind);
    await validateActiveGenerationContext(resolveGenerationProfile(request.user.directories, snapshot.binding), options.macroEnvironment,
        options.messages, options.rawOptions, { maxTokens: options.maxTokens, groupNames: options.groupNames });
}

async function finalizeSummarySubmission(request, job, preparedSnapshot) {
    await retainConversationAutomaticAcceptance(request, job);
    try {
        const snapshot = preparedSnapshot || readArtifact(request.user.directories, job.id, 'request') || await buildSummarySnapshot(request, job);
        if (job.config?.requestHash && hash(snapshot) !== job.config.requestHash) throw fail('The accepted summary request changed during preparation.', 409);
        await validateMaintenanceSnapshot(request, snapshot, 'summary');
        writeArtifact(request.user.directories, job.id, 'request', snapshot);
    } catch (error) {
        updateJob(request.user.directories, job.id, {
            state: 'failed', stage: null, finishedAt: Date.now(),
            error: { message: error?.message || 'The summary request could not be prepared.', code: error?.code || 'SUMMARY_PREPARE_FAILED' },
            recoverability: 'needs-retry',
        });
        return getJob(request.user.directories, job.id);
    }
    // Freeze the captured-history occurrence before dispatch, too. A failed
    // marker write must leave the job waiting and non-prunable.
    await retainConversationAutomaticAcceptance(request, getJob(request.user.directories, job.id));
    releaseJob(request.user.directories, job.id);
    return getJob(request.user.directories, job.id);
}

function sameThreadTarget(a, b) {
    return String(a?.avatar || '') === String(b?.avatar || '')
        && String(a?.groupId || '') === String(b?.groupId || '')
        && String(a?.personaId || '') === String(b?.personaId || '')
        && String(a?.branchId || '') === String(b?.branchId || '');
}

function maintenanceRequestHash(body, kind) {
    const target = body.target || {};
    return hash({ kind, target: { avatar: target.avatar || body.avatar || '', groupId: target.groupId || '',
        personaId: target.personaId || '', branchId: target.branchId || '' }, force: body.force === true,
    anchors: normalizeSubmissionAnchors(body), bindingRequest: normalizeBindingRequest(body.bindingRequest) || null, acknowledgement: body.acknowledgement || null });
}

async function captureMaintenanceBinding(request, body, target) {
    const submitted = normalizeBindingRequest(body.bindingRequest);
    const captured = normalizeBindingRequest(await preflightConversationBindings(request, { ...body, target, speakerAvatar: target.avatar, bindingOnly: true,
        acknowledgement: submitted?.acknowledgement || body.acknowledgement }));
    if (submitted && hash(submitted) !== hash(captured)) throw fail('The captured connection changed. Try again.', 409);
    return captured.participants[target.avatar];
}

/**
 * Accept a memory summary. Manual callers set force; the worker calls it with
 * automatic true and lets eligibility decide.
 */
export async function acceptConversationSummary(request, body = {}, { automatic = false } = {}) {
    const owner = request.user?.profile?.handle;
    const directories = request.user?.directories;
    if (!owner || !directories?.root) throw fail('An authenticated account is required.', 401);
    if (typeof body.submissionKey !== 'string' || !body.submissionKey || body.submissionKey.length > 256) throw fail('A submission key is required.');
    if (!body.target || typeof body.target !== 'object') throw fail('A target is required.');
    if (Object.hasOwn(body, 'summary')) {
        if (automatic || typeof body.summary !== 'string' || body.summary.length > MAX_RESPONSE_BYTES
            || (body.clearAll !== undefined && typeof body.clearAll !== 'boolean') || (body.clearAll && body.summary.trim())) {
            throw fail('The manual memory summary is invalid.');
        }
        const current = readConversationTarget(request, body.target);
        if (String(current.branch.createdAt) !== String(body.branchCreatedAt)) throw fail('The Conversation branch was replaced.', 409);
        const summary = body.summary.trim();
        const thread = current.store.characters[getConversationThreadKey(body.target.avatar, body.target.groupId, body.target.personaId)];
        const branches = body.clearAll ? Object.values(thread.branches || {}) : [current.branch];
        for (const branch of branches) {
            const messages = eligibleMessages(branch);
            Object.assign(branch, { memorySummary: summary, memoryMessageCount: messages.length,
                memoryUpdatedAt: Date.now(), memorySummaryThrough: messages.at(-1)?.id || '' });
        }
        if (body.clearAll || thread.activeBranchId === body.target.branchId) {
            for (const field of ['memorySummary', 'memoryMessageCount', 'memoryUpdatedAt', 'memorySummaryThrough']) thread[field] = current.branch[field];
        }
        const saved = await saveConversationStore(request, current.store, current.version, { trustedConversationEffects: true });
        if (!saved.ok) throw fail('The Conversation memory could not be saved.', saved.status || 409);
        return { created: false, applied: true };
    }
    const requestHash = maintenanceRequestHash(body, 'summary');
    const recorded = listJobs(directories, { owner, includeDismissed: true }).find(item => item.submissionKey === body.submissionKey);
    if (recorded?.intent?.requestHash) {
        if (recorded.type !== 'conversation.summary' || recorded.intent.requestHash !== requestHash) throw fail('This submission key already belongs to another operation.', 409);
        return { created: false, job: recorded };
    }
    const target = await prepareConversationTarget(request, body.target);
    const current = readConversationTarget(request, target);
    const force = body.force === true;
    const messages = eligibleMessages(current.branch);
    if (!messages.length) return { created: false, skipped: 'not-enough-messages' };
    if (!force) {
        if (messages.length < MEMORY_SUMMARY_MIN_MESSAGES || countNewMessages(messages, current.branch.memorySummaryThrough, current.branch.memoryMessageCount) < MEMORY_SUMMARY_INTERVAL_MESSAGES) {
            return { created: false, skipped: 'not-enough-messages' };
        }
    }
    if (automatic && !automaticSummaryAllowed(request, current, target)) return { created: false, skipped: 'disabled' };
    const existing = listJobs(directories, { owner, includeDismissed: true }).find(item => item.submissionKey === body.submissionKey);
    if (existing) {
        if (existing.type !== 'conversation.summary' || !sameThreadTarget(existing.intent?.target, target)) {
            throw fail('This submission key already belongs to another operation.', 409);
        }
        return { created: false, job: existing };
    }
    const binding = await captureMaintenanceBinding(request, body, target);
    const intent = { kind: 'summary', target, force, requestHash };
    const snapshot = await buildSummarySnapshot(request, { intent, credentialRef: binding });
    await validateMaintenanceSnapshot(request, snapshot, 'summary');
    if (automatic) {
        const fresh = readConversationTarget(request, target);
        if (!automaticSummaryAllowed(request, fresh, target)) return { created: false, skipped: 'disabled' };
        if (wasConversationAutomaticOccurrenceAccepted(fresh.store, body.submissionKey)) return { created: false, skipped: 'already-accepted' };
    }
    const accepted = acceptJob(directories, {
        owner, type: 'conversation.summary', submissionKey: body.submissionKey, intent,
        automatic, paused: true, coalesce: { deadline: 0, members: [] },
        target: { kind: 'conversation', id: getConversationThreadKey(target.avatar, target.groupId, target.personaId), branchId: target.branchId },
        credentialRef: binding, config: { requestHash: hash(snapshot) }, label: 'Conversation summary',
    });
    noteOwner(owner);
    const job = await finalizeSummarySubmission(request, accepted.job, snapshot);
    return { created: accepted.created, job };
}

async function runConversationSummaryJob(context, dependencies) {
    const snapshot = readArtifact(context.directories, context.job.id, 'request');
    if (!snapshot) throw fail('The summary request is missing.', 409);
    if (readArtifact(context.directories, context.job.id, 'result')) return { artifact: true };
    if (snapshot.memoryFingerprint === undefined) throw Object.assign(fail('The Conversation memory changed or cannot be verified. Refresh memory again.', 409), { recoverable: true });
    let response = readArtifact(context.directories, context.job.id, 'reply');
    if (!response) {
        response = await dependencies.generate({
            ...maintenanceGenerationOptions(snapshot, 'summary'), context, jobContext: context,
        });
        writeArtifact(context.directories, context.job.id, 'reply', { text: response.text });
    }
    const text = String(response.text || '').trim();
    if (!text || text.length > MAX_RESPONSE_BYTES) throw fail('The summary model returned unusable text.', 502);
    setJobResume(context.directories, context.job.id, 'apply');
    await commitConversationMemorySummary(context, snapshot.target, { summary: text, throughId: snapshot.throughId, count: snapshot.count,
        memoryFingerprint: snapshot.memoryFingerprint });
    const result = { summary: text };
    writeArtifact(context.directories, context.job.id, 'result', result);
    return { artifact: true };
}

async function buildScheduleSnapshot(request, job) {
    const character = await getCharacterData(request, job.intent.avatar, { allowOverride: false });
    const current = readConversationTarget(request, job.intent.target);
    const participant = await buildConversationParticipantSnapshot(request, current, job.intent.target, { avatar: job.intent.avatar }, {
        binding: job.credentialRef, directive: '', timeZone: 'UTC',
    });
    return {
        target: job.intent.target, binding: job.credentialRef, avatar: job.intent.avatar,
        character: { name: character.name, description: character.description, personality: character.personality },
        macros: participant.macros, userName: participant.userName, groupNames: participant.groupNames,
    };
}

async function finalizeScheduleSubmission(request, job, preparedSnapshot) {
    try {
        const snapshot = preparedSnapshot || readArtifact(request.user.directories, job.id, 'request') || await buildScheduleSnapshot(request, job);
        if (job.config?.requestHash && hash(snapshot) !== job.config.requestHash) throw fail('The accepted schedule request changed during preparation.', 409);
        await validateMaintenanceSnapshot(request, snapshot, 'schedule');
        writeArtifact(request.user.directories, job.id, 'request', snapshot);
    } catch (error) {
        updateJob(request.user.directories, job.id, {
            state: 'failed', stage: null, finishedAt: Date.now(),
            error: { message: error?.message || 'The schedule request could not be prepared.', code: error?.code || 'SCHEDULE_PREPARE_FAILED' },
            recoverability: 'needs-retry',
        });
        return getJob(request.user.directories, job.id);
    }
    releaseJob(request.user.directories, job.id);
    return getJob(request.user.directories, job.id);
}

/** Save a schedule edited by hand in one version-checked settings write. */
async function saveEditedConversationSchedule(request, body, avatar) {
    const schedule = normalizeEditedSchedule(body.schedule);
    if (!schedule || JSON.stringify(schedule).length > MAX_RESPONSE_BYTES) throw fail('The edited schedule is invalid.');
    const target = { avatar, groupId: String(body.target?.groupId || ''), personaId: String(body.target?.personaId || '') };
    const saved = readUserSettingsWithStatus(request);
    if (!saved.ok) throw fail('The Conversation settings could not be read.', 409);
    const store = ensureConversationStore(saved.data, group => normalizeConversationGroupRecord(group, normalizeConversationSettings));
    if (!authorizeConversationGroup(request, store, avatar, target.groupId, target.personaId, normalizeConversationSettings).authorized) {
        throw fail('The Conversation group is no longer available to this persona.', 409);
    }
    if (!getConversationThreadStore(store, avatar, target.groupId, { create: true, personaId: target.personaId })) throw fail('The Conversation target is invalid.');
    applyConversationSchedule(store, avatar, target, schedule);
    const result = await saveConversationStore(request, store, getSettingsVersion(saved.data), { trustedConversationEffects: true });
    if (!result.ok) throw fail('The schedule could not be saved.', result.status || 409);
    return { created: false, applied: true, schedule };
}

/** Accept a manual weekly-schedule generation for one character. */
export async function acceptConversationSchedule(request, body = {}) {
    const owner = request.user?.profile?.handle;
    const directories = request.user?.directories;
    if (!owner || !directories?.root) throw fail('An authenticated account is required.', 401);
    if (typeof body.submissionKey !== 'string' || !body.submissionKey || body.submissionKey.length > 256) throw fail('A submission key is required.');
    const avatar = String(body.target?.avatar || body.avatar || '');
    if (!avatar) throw fail('A character is required.');
    if (Object.hasOwn(body, 'schedule')) return saveEditedConversationSchedule(request, body, avatar);
    const requestHash = maintenanceRequestHash(body, 'schedule');
    const recorded = listJobs(directories, { owner, includeDismissed: true }).find(item => item.submissionKey === body.submissionKey);
    if (recorded?.intent?.requestHash) {
        if (recorded.type !== 'conversation.schedule' || recorded.intent.requestHash !== requestHash) throw fail('This submission key already belongs to another operation.', 409);
        return { created: false, job: recorded };
    }
    const groupId = String(body.target?.groupId || '');
    const target = await prepareConversationTarget(request, { avatar, groupId, personaId: body.target?.personaId || '', branchId: body.target?.branchId });
    const existing = listJobs(directories, { owner, includeDismissed: true }).find(item => item.submissionKey === body.submissionKey);
    if (existing) {
        if (existing.type !== 'conversation.schedule' || !sameThreadTarget(existing.intent?.target, target)) {
            throw fail('This submission key already belongs to another operation.', 409);
        }
        return { created: false, job: existing };
    }
    const binding = await captureMaintenanceBinding(request, body, target);
    const intent = { kind: 'schedule', avatar, target, requestHash };
    const snapshot = await buildScheduleSnapshot(request, { intent, credentialRef: binding });
    await validateMaintenanceSnapshot(request, snapshot, 'schedule');
    const accepted = acceptJob(directories, {
        owner, type: 'conversation.schedule', submissionKey: body.submissionKey, intent,
        automatic: false, paused: true, coalesce: { deadline: 0, members: [] },
        target: { kind: 'conversation', id: getConversationThreadKey(avatar, groupId, target.personaId), branchId: target.branchId },
        credentialRef: binding, config: { requestHash: hash(snapshot) }, label: 'Conversation schedule',
    });
    noteOwner(owner);
    const job = await finalizeScheduleSubmission(request, accepted.job, snapshot);
    return { created: accepted.created, job };
}

/**
 * Save a weekly schedule where both readers look for it. The schedule itself
 * belongs to the character's solo store; the pacing values follow the thread,
 * or the owned group record for a group DM. Legacy roleplay groups keep their
 * own group-level pacing because their file is edited under roleplay locks.
 */
export function applyConversationSchedule(store, avatar, target, schedule) {
    const personaId = target.personaId || '';
    const threadKey = getConversationThreadKey(avatar, target.groupId || '', personaId);
    if (!threadKey || !store.characters?.[threadKey]) throw fail('The character no longer has a Conversation store.', 409);
    const solo = getConversationThreadStore(store, avatar, '', { create: true, personaId });
    solo.schedule = schedule;
    const thread = store.characters[threadKey];
    const generated = { auto_schedule: JSON.stringify(schedule), schedule_generated_at: schedule.generatedAt };
    const pacing = { talkativeness: schedule.talkativeness, inactivity_threshold: schedule.inactivityThresholdMinutes };
    if (!target.groupId) {
        thread.settings = { ...(thread.settings || {}), ...generated, ...pacing };
        return;
    }
    thread.settings = { ...(thread.settings || {}), ...generated };
    const group = getConversationGroupRecord(store, target.groupId, personaId, normalizeConversationSettings);
    if (group) {
        group.conversation_settings = normalizeGroupConversationSettings({ ...group.conversation_settings, ...pacing }, normalizeConversationSettings);
        group.updatedAt = Date.now();
    }
}

async function runConversationScheduleJob(context, dependencies) {
    const snapshot = readArtifact(context.directories, context.job.id, 'request');
    if (!snapshot) throw fail('The schedule request is missing.', 409);
    if (readArtifact(context.directories, context.job.id, 'result')) return { artifact: true };
    let response = readArtifact(context.directories, context.job.id, 'reply');
    if (!response) {
        response = await dependencies.generate({
            ...maintenanceGenerationOptions(snapshot, 'schedule'), context, jobContext: context,
        });
        writeArtifact(context.directories, context.job.id, 'reply', { text: response.text });
    }
    const schedule = parseScheduleResponse(response.text);
    if (!schedule || !schedule.days) throw fail('The schedule model returned unusable output.', 502);
    setJobResume(context.directories, context.job.id, 'apply');
    await commitConversationStoreEffect(context, `schedule:${snapshot.avatar}`, store => {
        applyConversationSchedule(store, snapshot.avatar, snapshot.target, schedule);
        return { generatedAt: schedule.generatedAt };
    });
    const result = { schedule };
    writeArtifact(context.directories, context.job.id, 'result', result);
    return { artifact: true };
}

/** Finish a paused maintenance job the worker found after a crash. */
export async function finalizeConversationMaintenanceSubmission(request, job) {
    if (job?.type === 'conversation.summary') return finalizeSummarySubmission(request, job);
    if (job?.type === 'conversation.schedule') return finalizeScheduleSubmission(request, job);
    return job;
}

export function registerConversationMaintenanceJobs({ generate = runChatProfile } = {}) {
    registerHandler('conversation.summary', context => runConversationSummaryJob(context, { generate }));
    registerHandler('conversation.schedule', context => runConversationScheduleJob(context, { generate }));
}

registerConversationMaintenanceJobs();

export const testExports = { runConversationSummaryJob, runConversationScheduleJob };
