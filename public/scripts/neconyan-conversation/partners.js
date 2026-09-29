import { getConversationGroupIdForAvatar, getConversationPersonaId, getCurrentCharAvatar } from './context.js';
import { getCharacterForAvatar, getConversationPartnerAvatars } from './media.js';
import { getSettings } from './settings-store.js';
import { parseAvatarList } from './partners-utils.js';

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
