import {
    MEMORY_SUMMARY_INTERVAL_MESSAGES,
    MEMORY_SUMMARY_MIN_MESSAGES,
    MEMORY_SUMMARY_RESPONSE_TOKENS,
} from '../../public/scripts/neconyan-conversation/constants.js';
import { parseScheduleResponse } from '../../public/scripts/neconyan-conversation/schedule-utils.js';
import { captureChatProfile } from './profiles.js';
import { runChatProfile } from './service.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { acceptJob, getJob, listJobs, releaseJob, setJobResume, updateJob } from '../jobs/store.js';
import { noteOwner, registerHandler } from '../jobs/runner.js';
import { getCharacterData, getConversationSettings } from '../endpoints/conversation-generation.js';
import { getConversationThreadKey } from '../endpoints/conversation-store.js';
import {
    prepareConversationTarget,
    commitConversationMemorySummary,
    commitConversationStoreEffect,
    readConversationTarget,
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
    return String(message?.mes ?? '').trim().length > 0;
}

function formatTranscript(messages, limit) {
    return messages.slice(-limit)
        .map(message => `${message.name || 'Speaker'}: ${String(message.mes || '').slice(0, 1800)}`)
        .join('\n');
}

function eligibleMessages(branch) {
    return (branch.messages || []).filter(message => message.role !== 'system' && hasContent(message));
}

/** New messages after the saved cursor; with no cursor, treat the whole history as uncounted. */
function countNewMessages(messages, cursor) {
    if (!cursor) return messages.length;
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
    return {
        target: job.intent.target,
        binding: job.credentialRef,
        characterName: character.name || 'Character',
        userName: 'User',
        previousSummary: branch.memorySummary || '',
        messages: messages.map(message => ({ id: message.id, name: message.name, mes: message.mes })),
        throughId,
        count: messages.length,
    };
}

async function finalizeSummarySubmission(request, job) {
    try {
        const snapshot = await buildSummarySnapshot(request, job);
        writeArtifact(request.user.directories, job.id, 'request', snapshot);
    } catch (error) {
        updateJob(request.user.directories, job.id, {
            state: 'failed', stage: null, finishedAt: Date.now(),
            error: { message: error?.message || 'The summary request could not be prepared.', code: error?.code || 'SUMMARY_PREPARE_FAILED' },
            recoverability: 'needs-retry',
        });
        return getJob(request.user.directories, job.id);
    }
    releaseJob(request.user.directories, job.id);
    return getJob(request.user.directories, job.id);
}

function sameThreadTarget(a, b) {
    return String(a?.avatar || '') === String(b?.avatar || '')
        && String(a?.groupId || '') === String(b?.groupId || '')
        && String(a?.personaId || '') === String(b?.personaId || '')
        && String(a?.branchId || '') === String(b?.branchId || '');
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
    const target = await prepareConversationTarget(request, body.target);
    const current = readConversationTarget(request, target);
    const force = body.force === true;
    if (!force) {
        const messages = eligibleMessages(current.branch);
        if (messages.length < MEMORY_SUMMARY_MIN_MESSAGES || countNewMessages(messages, current.branch.memorySummaryThrough) < MEMORY_SUMMARY_INTERVAL_MESSAGES) {
            return { created: false, skipped: 'not-enough-messages' };
        }
    }
    const existing = listJobs(directories, { owner, includeDismissed: true }).find(item => item.submissionKey === body.submissionKey);
    if (existing) {
        if (existing.type !== 'conversation.summary' || !sameThreadTarget(existing.intent?.target, target)) {
            throw fail('This submission key already belongs to another operation.', 409);
        }
        return { created: false, job: existing };
    }
    const settings = getConversationSettings(request, current.store, target.avatar, target.groupId, {}, { personaId: target.personaId });
    const binding = captureChatProfile(directories, settings.connection_profile);
    const intent = { kind: 'summary', target, force };
    const accepted = acceptJob(directories, {
        owner, type: 'conversation.summary', submissionKey: body.submissionKey, intent,
        automatic, paused: true, coalesce: { deadline: 0, members: [] },
        target: { kind: 'conversation', id: getConversationThreadKey(target.avatar, target.groupId, target.personaId), branchId: target.branchId },
        credentialRef: binding, config: {}, label: 'Conversation summary',
    });
    noteOwner(owner);
    const job = await finalizeSummarySubmission(request, accepted.job);
    return { created: accepted.created, job };
}

async function runConversationSummaryJob(context, dependencies) {
    const snapshot = readArtifact(context.directories, context.job.id, 'request');
    if (!snapshot) throw fail('The summary request is missing.', 409);
    if (readArtifact(context.directories, context.job.id, 'result')) return { artifact: true };
    let response = readArtifact(context.directories, context.job.id, 'reply');
    if (!response) {
        response = await dependencies.generate({
            context, jobContext: context, binding: snapshot.binding,
            messages: [
                { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
                { role: 'user', content: buildConversationSummaryPrompt(snapshot) },
            ],
            maxTokens: MEMORY_SUMMARY_RESPONSE_TOKENS,
            userName: snapshot.userName, characterName: snapshot.characterName,
        });
        writeArtifact(context.directories, context.job.id, 'reply', { text: response.text });
    }
    const text = String(response.text || '').trim();
    if (!text || text.length > MAX_RESPONSE_BYTES) throw fail('The summary model returned unusable text.', 502);
    setJobResume(context.directories, context.job.id, 'apply');
    await commitConversationMemorySummary(context, snapshot.target, { summary: text, throughId: snapshot.throughId, count: snapshot.count });
    const result = { summary: text };
    writeArtifact(context.directories, context.job.id, 'result', result);
    return { artifact: true };
}

async function finalizeScheduleSubmission(request, job) {
    try {
        const character = await getCharacterData(request, job.intent.avatar, { allowOverride: false });
        writeArtifact(request.user.directories, job.id, 'request', {
            target: job.intent.target, binding: job.credentialRef, avatar: job.intent.avatar,
            character: { name: character.name, description: character.description, personality: character.personality },
        });
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

/** Accept a manual weekly-schedule generation for one character. */
export async function acceptConversationSchedule(request, body = {}) {
    const owner = request.user?.profile?.handle;
    const directories = request.user?.directories;
    if (!owner || !directories?.root) throw fail('An authenticated account is required.', 401);
    if (typeof body.submissionKey !== 'string' || !body.submissionKey || body.submissionKey.length > 256) throw fail('A submission key is required.');
    const avatar = String(body.target?.avatar || body.avatar || '');
    if (!avatar) throw fail('A character is required.');
    const groupId = String(body.target?.groupId || '');
    const target = await prepareConversationTarget(request, { avatar, groupId, personaId: body.target?.personaId || '', branchId: body.target?.branchId });
    const current = readConversationTarget(request, target);
    const existing = listJobs(directories, { owner, includeDismissed: true }).find(item => item.submissionKey === body.submissionKey);
    if (existing) {
        if (existing.type !== 'conversation.schedule' || !sameThreadTarget(existing.intent?.target, target)) {
            throw fail('This submission key already belongs to another operation.', 409);
        }
        return { created: false, job: existing };
    }
    const settings = getConversationSettings(request, current.store, avatar, groupId, {}, { personaId: target.personaId });
    const binding = captureChatProfile(directories, settings.connection_profile);
    const intent = { kind: 'schedule', avatar, target };
    const accepted = acceptJob(directories, {
        owner, type: 'conversation.schedule', submissionKey: body.submissionKey, intent,
        automatic: false, paused: true, coalesce: { deadline: 0, members: [] },
        target: { kind: 'conversation', id: getConversationThreadKey(avatar, groupId, target.personaId), branchId: target.branchId },
        credentialRef: binding, config: {}, label: 'Conversation schedule',
    });
    noteOwner(owner);
    const job = await finalizeScheduleSubmission(request, accepted.job);
    return { created: accepted.created, job };
}

async function runConversationScheduleJob(context, dependencies) {
    const snapshot = readArtifact(context.directories, context.job.id, 'request');
    if (!snapshot) throw fail('The schedule request is missing.', 409);
    if (readArtifact(context.directories, context.job.id, 'result')) return { artifact: true };
    let response = readArtifact(context.directories, context.job.id, 'reply');
    if (!response) {
        response = await dependencies.generate({
            context, jobContext: context, binding: snapshot.binding,
            messages: [
                { role: 'system', content: SCHEDULE_SYSTEM_PROMPT },
                { role: 'user', content: buildConversationSchedulePrompt(snapshot.character) },
            ],
            maxTokens: 8000, userName: 'User', characterName: snapshot.character.name,
        });
        writeArtifact(context.directories, context.job.id, 'reply', { text: response.text });
    }
    const schedule = parseScheduleResponse(response.text);
    if (!schedule || !schedule.days) throw fail('The schedule model returned unusable output.', 502);
    setJobResume(context.directories, context.job.id, 'apply');
    await commitConversationStoreEffect(context, `schedule:${snapshot.avatar}`, store => {
        const key = getConversationThreadKey(snapshot.avatar, snapshot.target.groupId || '', snapshot.target.personaId);
        const characterStore = store.characters?.[key];
        if (!characterStore) throw fail('The character no longer has a Conversation store.', 409);
        characterStore.schedule = schedule;
        characterStore.settings = {
            ...(characterStore.settings || {}),
            auto_schedule: JSON.stringify(schedule),
            talkativeness: schedule.talkativeness,
            inactivity_threshold: schedule.inactivityThresholdMinutes,
            schedule_generated_at: schedule.generatedAt,
        };
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
