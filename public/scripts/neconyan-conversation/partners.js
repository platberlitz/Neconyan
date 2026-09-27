import { PARTNER_FOLLOWUP_RECENT_WINDOW } from './constants.js';
import { getConversationGroupIdForAvatar, getConversationPersonaId, getCurrentCharAvatar } from './context.js';
import { getCharacterForAvatar, getConversationPartnerAvatars } from './media.js';
import { getSettings } from './settings-store.js';
import { getConversationThread } from './thread-store.js';
import {
    getLastPartnerMessageIndex,
    getRecentlySilentMentionedPartnerFromThread,
    isCharacterMentionedInText,
    parseAvatarList,
    mergeConversationPartnerSettings,
} from './partners-utils.js';

export {
    escapeRegExp,
    getCharacterMentionHandles,
    getLastPartnerMessageIndex,
    getRecentlySilentMentionedPartnerFromThread,
    hasMentionBoundaryMatch,
    isCharacterMentionedInText,
    parseAvatarList,
} from './partners-utils.js';

export function getAllowedPartnerCharacters(selectedAvatars, currentAvatar = getCurrentCharAvatar(), settings = getSettings(currentAvatar), { branchId = '', groupId = getConversationGroupIdForAvatar(currentAvatar), includeThreadPartners = true, personaId = getConversationPersonaId() } = {}) {
    const configuredAvatars = Array.isArray(selectedAvatars)
        ? selectedAvatars
        : parseAvatarList(selectedAvatars ?? settings?.multi_char_names);
    const avatars = Array.from(new Set([
        ...configuredAvatars,
        ...getConversationPartnerAvatars(currentAvatar, {
            ...settings,
            multi_char_names: configuredAvatars.join(','),
        }, { branchId, groupId, includeThreadPartners, personaId }),
    ]));
    return avatars
        .map(avatar => getCharacterForAvatar(avatar))
        .filter(character => character?.avatar && character.avatar !== currentAvatar);
}

export function getLastUserConversationText(avatar, { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const userMessage = [...getConversationThread(avatar, { branchId, create: false, groupId, personaId })].reverse().find(message => message?.role === 'user' && message.mes);
    return userMessage?.mes || '';
}

export function chooseConversationPartner(avatar, selectedAvatars, settings = getSettings(avatar), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const partners = getAllowedPartnerCharacters(selectedAvatars, avatar, settings, { branchId, groupId, personaId });
    if (!partners.length) {
        return null;
    }

    const lastUserText = getLastUserConversationText(avatar, { branchId, groupId, personaId });
    const mentioned = partners.find(character => isCharacterMentionedInText(character, lastUserText, partners));
    return mentioned || (Math.random() < 0.75 ? getLeastRecentPartner(avatar, selectedAvatars, settings, { branchId, groupId, personaId }) : partners[Math.floor(Math.random() * partners.length)]);
}

export function getConversationPartnerSettings(partnerAvatar, hostSettings, { groupId = getConversationGroupIdForAvatar(partnerAvatar), personaId = getConversationPersonaId() } = {}) {
    if (!partnerAvatar) {
        return hostSettings;
    }

    const partnerSettings = getSettings(partnerAvatar, { groupId, personaId });
    return mergeConversationPartnerSettings(hostSettings, partnerSettings);
}

export function getLeastRecentPartner(avatar, selectedAvatars, settings = getSettings(avatar), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const partners = getAllowedPartnerCharacters(selectedAvatars, avatar, settings, { branchId, groupId, personaId });
    if (!partners.length) {
        return null;
    }

    const thread = getConversationThread(avatar, { branchId, create: false, groupId, personaId });
    return [...partners].sort((left, right) => {
        const leftIndex = getLastPartnerMessageIndex(thread, left);
        const rightIndex = getLastPartnerMessageIndex(thread, right);
        return leftIndex - rightIndex;
    })[0];
}

export function getRecentlySilentMentionedPartner(avatar, selectedAvatars, settings = getSettings(avatar), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const partners = getAllowedPartnerCharacters(selectedAvatars, avatar, settings, { branchId, groupId, personaId });
    if (!partners.length) {
        return null;
    }

    const thread = getConversationThread(avatar, { branchId, create: false, groupId, personaId });
    return getRecentlySilentMentionedPartnerFromThread(thread, partners, PARTNER_FOLLOWUP_RECENT_WINDOW);
}
