import {
    DEFAULT_CONVERSATION_REPLY_MAX_TOKENS,
    MAX_CONVERSATION_REPLY_MAX_TOKENS,
    MIN_CONVERSATION_REPLY_MAX_TOKENS,
    SCHEDULE_PREFIX,
} from './constants.js';
import {
    getCharacterConversationStore,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getCurrentCharAvatar,
    parsePositiveInt,
    persistConversationStore,
} from './context.js';
import { getCurrentUserHandle } from '../user.js';
import { requestConversationBinding } from './bindings.js';
import { captureConversationTextBinding } from './generation.js';
import { createConversationSubmissionKey } from './message-identity-utils.js';
import { waitForNativeConversationJob } from './native-jobs.js';
import { flushConversationStore, refreshConversationStore } from './store-sync.js';
import { runtimeStatusOverrides } from './state.js';
import {
    clamp,
    getCurrentActivityFromSchedule as getCurrentActivityFromScheduleBase,
} from './schedule-utils.js';

export {
    clamp,
    inferStatusFromActivity,
    normalizeEditedSchedule,
    normalizeScheduleBlock,
    parseDurationToMs,
    parsePositiveIntValue,
    parseScheduleResponse,
    parseScheduleTimeRange,
    repairScheduleJson,
} from './schedule-utils.js';

export function getConversationReplyMaxTokens(settings = {}) {
    return clamp(
        parsePositiveInt(settings?.reply_max_tokens, DEFAULT_CONVERSATION_REPLY_MAX_TOKENS, MIN_CONVERSATION_REPLY_MAX_TOKENS),
        MIN_CONVERSATION_REPLY_MAX_TOKENS,
        MAX_CONVERSATION_REPLY_MAX_TOKENS,
    );
}

export function getScheduleStorageKey(avatar) {
    return `${SCHEDULE_PREFIX}${avatar}`;
}

export function getConversationRuntimeStatusKey(avatar, personaId = getConversationPersonaId()) {
    return `${getConversationPersonaId(personaId)}\u001f${String(avatar || '').trim()}`;
}

export function getCurrentActivityFromSchedule(schedule, avatar = getCurrentCharAvatar(), now = new Date(), { personaId = getConversationPersonaId() } = {}) {
    return getCurrentActivityFromScheduleBase(schedule, getConversationRuntimeStatusKey(avatar, personaId), now, runtimeStatusOverrides);
}

export function getStoredSchedule(avatar = getCurrentCharAvatar(), { personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return null;
    }

    const schedule = getCharacterConversationStore(avatar, { create: false, personaId })?.schedule;
    return schedule && typeof schedule === 'object' ? schedule : null;
}

export function saveStoredSchedule(avatar, schedule, { personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return;
    }

    const characterStore = getCharacterConversationStore(avatar, { personaId });
    characterStore.schedule = schedule && typeof schedule === 'object' ? schedule : null;
    persistConversationStore();
}

/**
 * Ask the server to write a new weekly schedule. The job finishes and saves
 * even if this page closes; the promise only reports what this page saw.
 */
export async function generateCharacterSchedule(character, { groupId = getConversationGroupIdForAvatar(character?.avatar), personaId = getConversationPersonaId() } = {}) {
    if (!character?.avatar) {
        return null;
    }

    const { account, scope, bindingRequest } = await captureConversationTextBinding({ avatar: character.avatar, groupId, personaId, messages: [] });
    const response = await requestConversationBinding('schedule/submit', { ...scope, bindingRequest,
        submissionKey: createConversationSubmissionKey(), acknowledgement: bindingRequest.acknowledgement }, account);
    if (!response.job) {
        return null;
    }
    const job = await waitForNativeConversationJob(response.job.id, account);
    if (job === null) {
        throw Object.assign(new Error('The schedule is still being written on the server.'), { pending: true });
    }
    if (job.state !== 'completed') {
        throw new Error(job?.error?.message || 'Schedule generation did not finish.');
    }
    return getStoredSchedule(character.avatar, { personaId });
}

/** Save a hand-edited schedule on the server, then read the saved copy back. */
export async function saveEditedCharacterSchedule(avatar, schedule, { groupId = '', personaId = getConversationPersonaId() } = {}) {
    const account = getCurrentUserHandle();
    if (!await flushConversationStore(account)) {
        throw new Error('Conversation changes could not be saved. Try again.');
    }
    const response = await requestConversationBinding('schedule/submit', { target: { avatar, groupId, personaId },
        submissionKey: createConversationSubmissionKey(), schedule }, account);
    await refreshConversationStore(account);
    return response.schedule || null;
}
