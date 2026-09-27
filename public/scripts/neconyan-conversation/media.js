import { characters, default_user_avatar, getThumbnailUrl } from '../../script.js';
import { DEFAULT_SETTINGS, MAX_STACKED_PARTICIPANT_AVATARS } from './constants.js';
import {
    getActiveConversationBranch,
    getConversationGroupById,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getCurrentCharacter,
    getCurrentCharAvatar,
} from './context.js';
import { collectConversationPartnerAvatars } from './partners-utils.js';
import { getCurrentActivityFromSchedule, getStoredSchedule } from './schedule.js';
import { getSettings } from './settings-store.js';
import { getConversationThread } from './thread-store.js';

export function getCharacterForAvatar(avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return getCurrentCharacter();
    }

    return (Array.isArray(characters) ? characters : []).find(character => character?.avatar === avatar) || null;
}

export function getCharacterIndexForAvatar(avatar) {
    return (Array.isArray(characters) ? characters : []).findIndex(character => character?.avatar === avatar);
}

export function addUniqueAvatar(avatars, avatar, currentAvatar = '') {
    if (!avatar || avatar === currentAvatar || avatars.includes(avatar)) {
        return;
    }

    avatars.push(avatar);
}

export function getConversationPartnerAvatars(avatar = getCurrentCharAvatar(), settings = null, { branchId = '', includeThreadPartners = true, groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const resolvedSettings = settings || getSettings(avatar, { groupId, personaId });
    const group = getConversationGroupById(groupId, { personaId });
    const partnerAvatars = collectConversationPartnerAvatars(avatar, resolvedSettings,
        includeThreadPartners ? getConversationThread(avatar, { branchId, create: false, groupId, personaId }) : [], group, includeThreadPartners);
    return partnerAvatars.filter(partnerAvatar => getCharacterForAvatar(partnerAvatar));
}

export function getConversationParticipants(avatar = getCurrentCharAvatar(), settings = null, options = {}) {
    const { groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = options;
    const resolvedSettings = settings || getSettings(avatar, { groupId, personaId });
    const participants = [];
    const primary = getCharacterForAvatar(avatar);
    if (primary?.avatar) {
        participants.push(primary);
    }

    getConversationPartnerAvatars(avatar, resolvedSettings, options).forEach((partnerAvatar) => {
        const partner = getCharacterForAvatar(partnerAvatar);
        if (partner?.avatar && !participants.some(participant => participant.avatar === partner.avatar)) {
            participants.push(partner);
        }
    });

    return participants;
}

export function getEffectiveConversationStatus(avatar = getCurrentCharAvatar(), settings = getSettings(avatar)) {
    const schedule = getStoredSchedule(avatar);
    if (schedule) {
        return getCurrentActivityFromSchedule(schedule, avatar).status;
    }

    return settings?.availability || DEFAULT_SETTINGS.availability;
}

export function getParticipantNamesForDisplay(participants) {
    return participants
        .map(participant => participant?.name || 'Character')
        .filter(Boolean);
}

export function renderConversationParticipantStack(container, participants, {
    status = 'online',
    max = MAX_STACKED_PARTICIPANT_AVATARS,
    groupId = getConversationGroupIdForAvatar(getCurrentCharAvatar()),
    onAvatarClick = null,
    zoomable = false,
} = {}) {
    if (!(container instanceof HTMLElement)) {
        return;
    }

    const participantList = Array.isArray(participants) ? participants : [];
    const visibleParticipants = participantList.filter(participant => participant?.avatar).slice(0, max);
    container.textContent = '';
    container.title = getParticipantNamesForDisplay(participantList).join(', ');

    if (!visibleParticipants.length) {
        const fallbackItem = document.createElement('span');
        fallbackItem.className = 'sb-conversation-participant-avatar';
        fallbackItem.dataset.primary = 'true';
        const fallbackImage = document.createElement('img');
        fallbackImage.alt = '';
        fallbackImage.loading = 'lazy';
        // Intrinsic size so the avatar cannot paint at the card's natural resolution before the
        // conversation stylesheet loads.
        fallbackImage.width = 44;
        fallbackImage.height = 44;
        fallbackImage.src = default_user_avatar;
        fallbackItem.appendChild(fallbackImage);
        container.appendChild(fallbackItem);
        return;
    }

    visibleParticipants.forEach((participant, index) => {
        const avatarItem = document.createElement('span');
        avatarItem.className = 'sb-conversation-participant-avatar';
        avatarItem.dataset.primary = String(index === 0);
        avatarItem.title = participant.name || 'Character';

        if (typeof onAvatarClick === 'function') {
            avatarItem.classList.add('is-interactive');
            avatarItem.tabIndex = 0;
            avatarItem.role = 'button';
            avatarItem.setAttribute('aria-label', `Open solo DM with ${participant.name || 'Character'}`);
            avatarItem.addEventListener('click', (event) => {
                event.stopPropagation();
                onAvatarClick(participant);
            });
            avatarItem.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onAvatarClick(participant);
                }
            });
        } else if (zoomable) {
            avatarItem.classList.add('is-interactive');
            avatarItem.dataset.sbConversationAction = 'zoom-avatar';
            avatarItem.dataset.avatarFile = participant.avatar;
            avatarItem.dataset.avatarType = 'avatar';
            avatarItem.tabIndex = 0;
            avatarItem.role = 'button';
            avatarItem.setAttribute('aria-label', `Show full picture for ${participant.name || 'Character'}`);
        }

        const image = document.createElement('img');
        image.alt = '';
        image.loading = index > 0 ? 'lazy' : 'eager';
        image.width = 44;
        image.height = 44;
        image.src = getThumbnailUrl('avatar', participant.avatar) || default_user_avatar;
        avatarItem.appendChild(image);

        const statusDot = document.createElement('span');
        statusDot.className = 'sb-conversation-status-dot';
        statusDot.dataset.status = participant.avatar
            ? getEffectiveConversationStatus(participant.avatar, getSettings(participant.avatar, { groupId }))
            : status;
        statusDot.setAttribute('aria-hidden', 'true');
        avatarItem.appendChild(statusDot);

        container.appendChild(avatarItem);
    });

    if (participantList.length > visibleParticipants.length) {
        const overflow = document.createElement('span');
        overflow.className = 'sb-conversation-participant-overflow';
        overflow.textContent = `+${participantList.length - visibleParticipants.length}`;
        overflow.setAttribute('aria-hidden', 'true');
        container.appendChild(overflow);
    }
}

export function getCharacterAuthorNote(avatar = getCurrentCharAvatar()) {
    const character = getCharacterForAvatar(avatar);
    return String(character?.data?.extensions?.depth_prompt?.prompt || '').trim();
}

export function getConversationDisplayName(avatar = getCurrentCharAvatar(), settings = getSettings(avatar), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const branch = getActiveConversationBranch(avatar, { create: false, groupId });
    if (branch?.name && branch.name !== 'Main') {
        return branch.name;
    }

    const names = getParticipantNamesForDisplay(getConversationParticipants(avatar, settings, { groupId }));
    return names.length ? names.join(', ') : 'Conversation';
}
