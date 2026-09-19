import { name1, saveSettingsDebounced } from '../../script.js';
import { event_types, eventSource } from '../events.js';
import { extension_settings } from '../extensions.js';
import { user_avatar } from '../personas.js';
import { power_user } from '../power-user.js';
import {
    AVAILABILITY_COPY,
    CHROME_IDS,
    PERSONA_APPENDICES_DEFAULT_SCOPE_KEY,
    PERSONA_APPENDICES_SELECTIONS_KEY,
    USER_STATUS_OPTIONS,
    USER_STATUS_STORAGE_KEY,
} from './constants.js';
import {
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getRawConversationThreadKey,
    getConversationStore,
    getConversationThreadKey,
    getCurrentCharAvatar,
    isAvatarInConversationGroup,
    persistConversationStore,
} from './context.js';
import { updateUserFooter } from './pickers.js';
import { composePersonaDescription, conversationPersonaAppendices } from './persona-description.js';

export function getAvailabilityCopy(status) {
    return AVAILABILITY_COPY[status] ?? AVAILABILITY_COPY.online;
}

export function getUserStatus() {
    const status = getConversationStore().userStatus || localStorage.getItem(USER_STATUS_STORAGE_KEY) || 'online';
    return USER_STATUS_OPTIONS.includes(status) ? status : 'online';
}

export function normalizeUserPersonaStatus(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function getUserPersonaStatus() {
    return normalizeUserPersonaStatus(getConversationStore().userPersonaStatus);
}

export function setUserStatus(status) {
    if (USER_STATUS_OPTIONS.includes(status)) {
        getConversationStore().userStatus = status;
        persistConversationStore();
    }
}

export function setUserPersonaStatus(statusText) {
    getConversationStore().userPersonaStatus = normalizeUserPersonaStatus(statusText);
    persistConversationStore();
}

export function editUserPersonaStatus() {
    const nextStatus = globalThis.prompt?.('Set your Conversation persona status. Leave blank to clear it.', getUserPersonaStatus());
    if (typeof nextStatus !== 'string') {
        return;
    }

    setUserPersonaStatus(nextStatus);
    document.getElementById(CHROME_IDS.personaPicker)?.setAttribute('hidden', '');
    document.getElementById(CHROME_IDS.userStatusPicker)?.setAttribute('hidden', '');
    updateUserFooter();
}

export function safeParseWeeklySchedule(value) {
    try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function getConnectionProfiles() {
    return extension_settings.connectionManager?.profiles ?? [];
}

export function getPersonaOptions() {
    const personas = power_user?.personas;
    if (!personas || typeof personas !== 'object') {
        return [];
    }

    return Object.entries(personas).map(([avatarId, personaName]) => ({ avatarId, personaName: String(personaName) }));
}

export function getConversationPersonaName(personaId, fallback = 'User') {
    const targetPersonaId = String(personaId || '').trim();
    const fallbackName = String(fallback || 'User').trim() || 'User';
    const storedName = String(power_user?.personas?.[targetPersonaId] || '').trim();
    if (storedName) {
        return storedName;
    }
    if (targetPersonaId && targetPersonaId === getConversationPersonaId()) {
        return String(name1 || fallbackName).trim() || fallbackName;
    }
    return fallbackName;
}

export function getConversationPersonaAppendixScopeKey({ avatar = getCurrentCharAvatar(), groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const targetGroupId = groupId && isAvatarInConversationGroup(avatar, groupId, { personaId }) ? groupId : '';
    return String(getConversationThreadKey(avatar, targetGroupId, { personaId }) || PERSONA_APPENDICES_DEFAULT_SCOPE_KEY);
}

function getLegacyConversationPersonaAppendixScopeKey({ avatar = getCurrentCharAvatar(), groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const targetGroupId = groupId && isAvatarInConversationGroup(avatar, groupId, { personaId }) ? groupId : '';
    return String(getRawConversationThreadKey(avatar, targetGroupId, '') || PERSONA_APPENDICES_DEFAULT_SCOPE_KEY);
}

function normalizeConversationPersonaAppendixSelections(descriptor) {
    const source = descriptor?.[PERSONA_APPENDICES_SELECTIONS_KEY];
    if (Array.isArray(source)) {
        const selections = { [PERSONA_APPENDICES_DEFAULT_SCOPE_KEY]: [...source] };
        descriptor[PERSONA_APPENDICES_SELECTIONS_KEY] = selections;
        return { selections, changed: true };
    }
    if (source && typeof source === 'object') {
        return { selections: source, changed: false };
    }

    const selections = {};
    if (descriptor) {
        descriptor[PERSONA_APPENDICES_SELECTIONS_KEY] = selections;
    }
    return { selections, changed: Boolean(descriptor && typeof source !== 'undefined') };
}

export function getConversationPersonaAppendices(avatarId) {
    return conversationPersonaAppendices(power_user?.persona_descriptions?.[avatarId]);
}

export function getActiveConversationPersonaAppendixIds(avatarId, options = {}) {
    const descriptor = power_user?.persona_descriptions?.[avatarId];
    const appendices = getConversationPersonaAppendices(avatarId);
    const appendixIds = new Set(appendices.map(appendix => appendix.id));
    const normalized = normalizeConversationPersonaAppendixSelections(descriptor);
    const selections = normalized.selections;
    const scopeKey = getConversationPersonaAppendixScopeKey(options);
    const legacyScopeKey = getLegacyConversationPersonaAppendixScopeKey(options);
    let changed = normalized.changed;
    if (!Object.prototype.hasOwnProperty.call(selections, scopeKey)) {
        const legacyIds = selections[legacyScopeKey] ?? selections[PERSONA_APPENDICES_DEFAULT_SCOPE_KEY];
        if (Array.isArray(legacyIds)) {
            selections[scopeKey] = [...legacyIds];
            changed = true;
        }
    }
    if (changed) {
        saveSettingsDebounced();
    }
    const activeIds = selections[scopeKey] ?? selections[PERSONA_APPENDICES_DEFAULT_SCOPE_KEY] ?? [];
    return Array.isArray(activeIds)
        ? activeIds.map(String).filter((id, index, array) => appendixIds.has(id) && array.indexOf(id) === index)
        : [];
}

export function composeConversationPersonaDescription(avatarId, options = {}) {
    return composePersonaDescription(power_user?.persona_descriptions?.[avatarId], getActiveConversationPersonaAppendixIds(avatarId, options));
}

export function setActiveConversationPersonaAppendixIds(avatarId, ids, options = {}) {
    const descriptor = power_user?.persona_descriptions?.[avatarId];
    if (!descriptor) {
        return;
    }

    const availableIds = new Set(getConversationPersonaAppendices(avatarId).map(appendix => appendix.id));
    const cleanIds = ids.map(String).filter((id, index, array) => availableIds.has(id) && array.indexOf(id) === index);
    const selections = normalizeConversationPersonaAppendixSelections(descriptor).selections;
    selections[getConversationPersonaAppendixScopeKey(options)] = cleanIds;
    descriptor[PERSONA_APPENDICES_SELECTIONS_KEY] = selections;

    if (avatarId === user_avatar) {
        power_user.persona_description = composeConversationPersonaDescription(avatarId, options);
    }

    saveSettingsDebounced();
    void eventSource.emit(event_types.PERSONA_UPDATED, avatarId);
}
