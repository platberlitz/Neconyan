import { composeConversationPromptMessages } from './prompt-messages.js';
import { composeConversationSystemPrompt } from './prompt-system.js';
import { user_avatar } from '../personas.js';
import { power_user } from '../power-user.js';
import {
    MEMORY_SUMMARY_INTERVAL_MESSAGES,
    MEMORY_SUMMARY_MIN_MESSAGES,
    MEMORY_SUMMARY_RECENT_MESSAGES,
    MEMORY_SUMMARY_RESPONSE_TOKENS,
    TRANSCRIPT_MESSAGE_LIMIT,
} from './constants.js';
import {
    getActiveConversationBranch,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationThreadStore,
    getConversationThreadKey,
    getCurrentCharAvatar,
    getCurrentCharName,
    parsePositiveInt,
} from './context.js';
import { generateConversationRaw } from './generation.js';
import { getConversationMessagesRevision } from './message-identity-utils.js';
import { getCharacterAuthorNote, getCharacterForAvatar, getConversationParticipants, getParticipantNamesForDisplay } from './media.js';
import {
    composeConversationPersonaDescription,
    getAvailabilityCopy,
    getConversationPersonaName,
    getUserPersonaStatus,
    getUserStatus,
} from './personas.js';
import { getCurrentActivityFromSchedule, getStoredSchedule } from './schedule.js';
import { formatPromptText } from './shared-helpers.js';
import {
    getConversationGroupMemorySummaries,
    getConversationMemorySummary,
    getConversationSoloMemorySummary,
    getSettings,
    saveConversationMemorySummary,
} from './settings-store.js';
import { memorySummaryBusyAvatars, memorySummaryTimers } from './state.js';
import {
    getConversationAttachmentSummary,
    getConversationFileAttachments,
    getConversationMediaAttachments,
    hasConversationMessageContent,
} from './thread-store.js';

export function formatConversationFileSize(size) {
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '';
    }

    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

export function renderConversationAttachments(container, message) {
    const media = getConversationMediaAttachments(message);
    const files = getConversationFileAttachments(message);
    if (!media.length && !files.length) {
        return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'sb-conversation-attachments';

    media.forEach((attachment) => {
        const figure = document.createElement('figure');
        figure.className = 'sb-conversation-media-attachment';

        const title = String(attachment.title || '').trim();
        const type = String(attachment.type || 'image');
        if (type === 'video') {
            const video = document.createElement('video');
            video.src = attachment.url;
            video.controls = true;
            video.preload = 'metadata';
            video.title = title;
            figure.appendChild(video);
        } else if (type === 'audio') {
            const audio = document.createElement('audio');
            audio.src = attachment.url;
            audio.controls = true;
            audio.preload = 'metadata';
            audio.title = title;
            figure.appendChild(audio);
        } else {
            const img = document.createElement('img');
            img.src = attachment.url;
            img.alt = title || 'Uploaded image';
            img.loading = 'lazy';
            figure.appendChild(img);
        }

        if (title) {
            const caption = document.createElement('figcaption');
            caption.textContent = title;
            figure.appendChild(caption);
        }

        wrapper.appendChild(figure);
    });

    files.forEach((file) => {
        const link = document.createElement('a');
        link.className = 'sb-conversation-file-attachment';
        link.href = file.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.download = file.name || '';

        const icon = document.createElement('span');
        icon.className = 'fa-solid fa-file-lines';
        icon.setAttribute('aria-hidden', 'true');

        const copy = document.createElement('span');
        copy.className = 'sb-conversation-file-copy';
        const name = document.createElement('span');
        name.className = 'sb-conversation-file-name';
        name.textContent = file.name || 'Attached file';
        const size = document.createElement('span');
        size.className = 'sb-conversation-file-size';
        size.textContent = formatConversationFileSize(file.size);
        copy.append(name, size);

        link.append(icon, copy);
        wrapper.appendChild(link);
    });

    container.appendChild(wrapper);
}

function getConversationLocalTimeContext(now = new Date()) {
    const resolvedTimeZone = (() => {
        try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
        } catch {
            return '';
        }
    })();
    const dateTimeLabel = (() => {
        try {
            return now.toLocaleString([], {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                timeZoneName: 'short',
            });
        } catch {
            return now.toString();
        }
    })();

    return [
        `Current device time context: ${dateTimeLabel}.`,
        resolvedTimeZone ? `Timezone: ${resolvedTimeZone}.` : '',
        'Use this as the user\'s current computer/phone time for day of week, time of day, dates, timezones, reminders, scheduling, and natural chat timing.',
    ].filter(Boolean).join(' ');
}

export function formatConversationTranscript(messages) {
    return messages
        .slice(-TRANSCRIPT_MESSAGE_LIMIT)
        .map(message => {
            const parts = [
                formatPromptText(message.mes, 1800),
                getConversationAttachmentSummary(message),
            ].filter(Boolean);
            return parts.length ? `${message.name || 'Speaker'}: ${parts.join(' ')}` : '';
        })
        .filter(Boolean)
        .join('\n');
}

export async function convertImageUrlToBase64(imageUrl) {
    if (typeof imageUrl !== 'string' || !imageUrl) {
        return '';
    }
    if (imageUrl.startsWith('data:')) {
        return imageUrl;
    }

    try {
        const response = await fetch(imageUrl, { method: 'GET', cache: 'force-cache' });
        if (!response.ok) {
            throw new Error(`Failed to fetch image: status ${response.status}`);
        }
        const blob = await response.blob();
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('Conversation Mode: failed to convert image to base64', error);
        return imageUrl;
    }
}

export async function convertImageUrlsToBase64(imageUrls, concurrency = 3) {
    const urls = Array.isArray(imageUrls) ? imageUrls : [];
    if (!urls.length) {
        return [];
    }

    const results = new Array(urls.length).fill('');
    let nextIndex = 0;
    const workerCount = Math.max(1, Math.min(parsePositiveInt(concurrency, 3, 1), urls.length));
    const workers = Array.from({ length: workerCount }, async () => {
        while (nextIndex < urls.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await convertImageUrlToBase64(urls[index]);
        }
    });

    await Promise.all(workers);
    return results;
}

export async function buildConversationPromptMessages(messages, directive, speakerName = getCurrentCharName(), { groupId = '', personaId = getConversationPersonaId() } = {}) {
    return composeConversationPromptMessages(messages, directive, speakerName, {
        groupId,
        userName: getConversationPersonaName(personaId, 'User'),
        convertImages: convertImageUrlsToBase64,
    });
}

export function buildConversationMemoryPrompt(avatar, messages, { groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const character = getCharacterForAvatar(avatar);
    const participants = getParticipantNamesForDisplay(getConversationParticipants(avatar, getSettings(avatar, { groupId, personaId }), { groupId, personaId }));
    return [
        `Main DM: ${character?.name || 'Character'} with ${getConversationPersonaName(personaId, 'User')}.`,
        participants.length > 1 ? `Other possible participants: ${participants.slice(1).join(', ')}.` : '',
        'Summarize durable DM memory only: relationship tone, promises, unresolved topics, preferences, private jokes, boundaries, and emotionally important beats.',
        'Ignore filler small talk unless it changes the relationship. Keep it compact and useful for future replies.',
        '',
        formatConversationTranscript(messages.slice(-MEMORY_SUMMARY_RECENT_MESSAGES)),
    ].filter(Boolean).join('\n');
}

export async function updateConversationMemorySummary(avatar = getCurrentCharAvatar(), { branchId = '', force = false, groupId = getConversationGroupIdForAvatar(avatar), notify = false, personaId = getConversationPersonaId() } = {}) {
    const memoryKey = `${getConversationThreadKey(avatar, groupId, { personaId })}:${branchId}`;
    if (!avatar || !memoryKey || memorySummaryBusyAvatars.has(memoryKey)) {
        return false;
    }

    const branch = getActiveConversationBranch(avatar, { branchId, create: false, groupId, personaId });
    const messages = Array.isArray(branch?.messages) ? branch.messages.filter(message => hasConversationMessageContent(message) && message.role !== 'system') : [];
    if (!messages.length || (!force && messages.length < MEMORY_SUMMARY_MIN_MESSAGES)) {
        if (notify) {
            toastr.info(`Memory appears after at least ${MEMORY_SUMMARY_MIN_MESSAGES} messages, or when there is enough chat to summarize.`);
        }
        return false;
    }

    const threadStore = getConversationThreadStore(avatar, { create: false, groupId, personaId });
    const lastSummarizedCount = parsePositiveInt(branch?.memoryMessageCount ?? threadStore?.memoryMessageCount, 0, 0);
    if (!force && messages.length - lastSummarizedCount < MEMORY_SUMMARY_INTERVAL_MESSAGES) {
        return false;
    }
    const sourceRevision = getConversationMessagesRevision(messages);

    memorySummaryBusyAvatars.add(memoryKey);
    try {
        const previousSummary = getConversationMemorySummary(avatar, { branchId, groupId, personaId });
        const prompt = [
            previousSummary ? `Existing DM memory summary:\n${previousSummary}` : '',
            buildConversationMemoryPrompt(avatar, messages, { groupId, personaId }),
            'Return the updated memory summary in concise bullets. No preamble.',
        ].filter(Boolean).join('\n\n');
        const settings = getSettings(avatar, { groupId, personaId });
        const response = await generateConversationRaw({
            prompt,
            systemPrompt: 'You maintain a concise private DM memory summary for realistic ongoing chat continuity.',
            responseLength: MEMORY_SUMMARY_RESPONSE_TOKENS,
            trimNames: false,
            cacheScope: 'conversation-mode-memory',
            scope: { avatar, branchId, groupId, personaId, messages },
        }, settings);

        if (response?.trim()) {
            const currentBranch = getActiveConversationBranch(avatar, { branchId, create: false, groupId, personaId });
            const currentMessages = Array.isArray(currentBranch?.messages)
                ? currentBranch.messages.filter(message => hasConversationMessageContent(message) && message.role !== 'system')
                : [];
            if (getConversationMessagesRevision(currentMessages) !== sourceRevision) {
                return false;
            }
            saveConversationMemorySummary(avatar, response.trim(), messages.length, { branchId, groupId, personaId });
            if (notify) {
                toastr.success('Conversation memory refreshed.');
            }
            return true;
        }
    } catch (error) {
        console.warn('Conversation Mode: memory summary update failed', error);
        if (notify) {
            toastr.warning('Conversation memory refresh failed. Check console for details.');
        }
    } finally {
        memorySummaryBusyAvatars.delete(memoryKey);
    }

    return false;
}

export function scheduleConversationMemorySummary(avatar = getCurrentCharAvatar(), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return;
    }

    const capturedBranchId = branchId || getConversationThreadStore(avatar, { create: false, groupId, personaId })?.activeBranchId || '';
    const memoryKey = `${getConversationThreadKey(avatar, groupId, { personaId })}:${capturedBranchId}`;
    const existingTimer = memorySummaryTimers.get(memoryKey);
    if (existingTimer) {
        window.clearTimeout(existingTimer);
    }

    const timer = window.setTimeout(() => {
        memorySummaryTimers.delete(memoryKey);
        void updateConversationMemorySummary(avatar, { branchId: capturedBranchId, groupId, personaId });
    }, 2500);
    memorySummaryTimers.set(memoryKey, timer);
}

export function buildConversationSystemPrompt(settings, avatar = getCurrentCharAvatar(), { threadAvatar = avatar, branchId = '', groupId = getConversationGroupIdForAvatar(threadAvatar), personaId = getConversationPersonaId() } = {}) {
    const character = getCharacterForAvatar(avatar);
    const charName = character?.name || getCurrentCharName();
    const userName = getConversationPersonaName(personaId, 'User');
    const threadSettings = threadAvatar === avatar ? settings : getSettings(threadAvatar, { groupId, personaId });
    const threadCharacter = threadAvatar !== avatar ? getCharacterForAvatar(threadAvatar) : null;
    const partners = getConversationParticipants(threadAvatar, threadSettings, { branchId, groupId, personaId }).filter(participant => participant?.avatar && participant.avatar !== avatar);
    const partnerNames = getParticipantNamesForDisplay(partners);
    const now = new Date();
    const personaContext = composeConversationPersonaDescription(personaId || user_avatar, {
        avatar: threadAvatar,
        groupId,
        personaId,
    }).trim() || (personaId === getConversationPersonaId() ? String(power_user?.persona_description ?? '').trim() : '');
    const schedule = getStoredSchedule(avatar, { personaId });
    let lifeContext = '';
    if (schedule) {
        const current = getCurrentActivityFromSchedule(schedule, avatar, now, { personaId });
        const timeLabel = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        lifeContext = `Current life context: It is ${timeLabel} for ${charName}, who is currently ${current.activity} (status: ${current.status}). Let this naturally color your availability, mood, and what you mention. Stay in this moment of your day.`;
    }
    return composeConversationSystemPrompt({
        settings, character, charName, userName, groupId, partnerNames, threadCharacter, personaContext, lifeContext,
        timeContext: getConversationLocalTimeContext(now),
        authorNote: settings.authors_note || getCharacterAuthorNote(avatar),
        availability: getAvailabilityCopy(getUserStatus()).label.toLowerCase(),
        personaStatus: getUserPersonaStatus(),
        memorySummary: getConversationMemorySummary(threadAvatar, { branchId, groupId, personaId }),
        soloMemory: settings.include_related_memory && groupId ? getConversationSoloMemorySummary(avatar, { personaId }) : null,
        groupMemories: settings.include_related_memory && !groupId ? getConversationGroupMemorySummaries(avatar, { max: 4, personaId }) : [],
    });
}
