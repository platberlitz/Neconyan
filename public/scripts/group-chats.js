import { Fuse } from '../lib.js';

import { roleplayLoadErrorMessage } from './roleplay-load-error.js';
import {
    shuffle,
    onlyUnique,
    debounce,
    delay,
    isDataURL,
    createThumbnail,
    extractAllWords,
    saveBase64AsFile,
    PAGINATION_TEMPLATE,
    getBase64Async,
    resetScrollHeight,
    initScrollHeight,
    localizePagination,
    toggleDrawer,
    renderPaginationDropdown,
    paginationDropdownChangeHandler,
    uuidv4,
} from './utils.js';
import { ensureMewmoryMessageIds } from './mewmory/message-identity.js';
import { RA_CountCharTokens, humanizedDateTime, dragElement, favsToHotswap, getMessageTimeStamp } from './RossAscends-mods.js';
import { power_user, loadMovingUIState, sortEntitiesList } from './power-user.js';
import { getCurrentUserHandle } from './user.js';
import { debounce_timeout } from './constants.js';

import {
    chat,
    sendSystemMessage,
    printMessages,
    scrollReopenedChatToBottom,
    printCharacters,
    characters,
    default_avatar,
    clearChat,
    Generate,
    select_rm_info,
    setCharacterId,
    setCharacterName,
    setEditedMessageId,
    is_send_press,
    resetChatState,
    setSendButtonState,
    getCharacters,
    system_message_types,
    online_status,
    talkativeness_default,
    selectRightMenuWithAnimation,
    deleteLastMessage,
    showSwipeButtons,
    hideSwipeButtons,
    chat_metadata,
    updateChatMetadata,
    getThumbnailUrl,
    setMenuType,
    menu_type,
    select_selected_character,
    cancelTtsPlay,
    sendMessageAsUser,
    getBiasStrings,
    flushPendingChatSavesForNavigation,
    flushCharacterSaveDebounced,
    deactivateSendButtons,
    activateSendButtons,
    eventSource,
    event_types,
    getCurrentChatId,
    setCharacterSettingsOverrides,
    system_avatar,
    getRequestHeaders,
    refreshCsrfToken,
    sendChatImport,
    substituteParams,
    loadRoleplayChat,
    saveRoleplayChatRequest,
    setExternalAbortController,
    baseChatReplace,
    createLazyFields,
    depth_prompt_depth_default,
    loadItemizedPrompts,
    animation_duration,
    depth_prompt_role_default,
    shouldAutoContinue,
    unshallowCharacter,
    chatElement,
    ensureMessageMediaIsArray,
    syncCharacterMenuActiveEntity,
    incrementChatGeneration,
    getChatGeneration,
    name1,
    name2,
    main_api,
    generateRawData,
    extractMessageFromData,
    stopGeneration,
    this_chid,
} from '../script.js';
import { getQueuedChatSaveAbortReason } from './chat-save-guard.js';
import { getChatBackupSaveOptions } from './chat-backup-sequence.js';
import { roleplaySaveNotice } from './roleplay-reply-notice.js';
import { beginRoleplaySave, confirmRoleplayOverwrite, finishRoleplaySave, rememberRoleplayRead, roleplayAccountStamp, sendRoleplayLifecycle, sendRoleplaySave } from './roleplay-save-chain.js';
import { printTagList, createTagMapFromList, applyTagsOnCharacterSelect, tag_map, applyTagsOnGroupSelect, printTagFilters, tag_filter_type } from './tags.js';
import { FILTER_TYPES, FilterHelper } from './filters.js';
import { isExternalMediaAllowed } from './chats.js';
import { POPUP_TYPE, Popup, callGenericPopup } from './popup.js';
import { t } from './i18n.js';
import { isImageInputIssue } from './prompt-media-policy.js';
import { accountStorage } from './util/AccountStorage.js';
import { fetchWithCsrfRetry } from './csrf-token-refresh.js';
import { chat_completion_sources, oai_settings } from './openai.js';
import { getRegexedString, regex_placement } from './extensions/regex/engine.js';
import {
    appendGroupSpeakerStops,
    buildDirectorPrompt,
    buildOwnLinesReminder,
    getGroupTalkBurstCount,
    getOtherMemberNames,
    GROUP_DIRECTOR_MAX_SPEAKERS,
    GROUP_DIRECTOR_RESPONSE_TOKENS,
    GROUP_DIRECTOR_STRATEGY,
    GROUP_DIRECTOR_TIMEOUT_MS,
    isKeepOwnLinesEnabled,
    parseDirectorResponse,
    pickNextListSpeaker,
    summariseMemberCard,
} from './group-chat-scene.js';
import { buildEnsemblePrompt, createEnsembleMessages } from './group-chat-ensemble.js';
import { messageAutomaticGenerationSuppressed } from './generation-outcome.js';
import { beginGroupPromptScope, canGroupMemberSee, groupMessageAudience, groupScenePrompt, readGroupScene } from './group-chat-visibility.js';
import { initGroupSceneControls, renderGroupScene } from './group-chat-scene-ui.js';
import { getGroupSpeakerPool } from './group-chat-speakers.js';
import { initGroupSpeakerMenu } from './group-chat-speaker-menu.js';
import { buildNarratorReminder, getGroupMemberRole } from './group-chat-roles.js';

export {
    selected_group,
    openGroupId,
    hideMutedSprites,
    is_group_generating,
    group_generation_id,
    groups,
    saveGroupChat,
    generateGroupWrapper,
    deleteGroup,
    getGroupAvatar,
    getGroups,
    regenerateGroup,
    resetSelectedGroup,
    select_group_chats,
    getGroupChatNames,
    getSelectedGroupSpeakerAvatar,
    updateGroupSpeakerControls,
};

let is_group_generating = false; // Group generation flag
let hideMutedSprites = false;
/** @type {Group[]} */
let groups = [];
/** @type {string|null} */
let selected_group = null;
let group_generation_id = null;
let fav_grp_checked = false;
let openGroupId = null;
let newGroupMembers = [];
let groupChatSaveQueue = Promise.resolve();
/** @type {{groupId: string, chatId: string, remaining: number, cancelled: boolean, controller: AbortController}|null} */
let activeGroupTalkBurst = null;
let activeGroupEnsemble = null;

export function isGroupEnsembleActive() {
    return Boolean(activeGroupEnsemble && activeGroupEnsemble.groupId === selected_group
        && activeGroupEnsemble.chatId === getCurrentChatId());
}
const groupSaveStates = new Map();
let groupMetadataSaveQueue = Promise.resolve();
let groupListReadGeneration = 0;
const groupReadEvidence = new WeakMap();
const groupBackgroundState = new WeakMap();
const queuedGroupMetadataById = new Map();
const queuedGroupChatIntegrityByFile = new Map();

/** Finish the selected group's existing metadata queue before freezing an import source. */
export async function captureGroupImportTarget(groupId = selected_group) {
    const group = groups.find(item => item.id === groupId);
    const stamp = roleplayAccountStamp();
    if (!group || selected_group !== groupId || stamp.owner !== getCurrentUserHandle()) throw new Error('The selected group changed.');
    const delayed = pendingGroupMetadataSaves.get(groupId);
    if (delayed) {
        clearTimeout(delayed.timer);
        pendingGroupMetadataSaves.delete(groupId);
        await _save(delayed.job);
    }
    await groupMetadataSaveQueue.catch(() => {});
    if (selected_group !== groupId || groups.find(item => item.id === groupId) !== group
        || roleplayAccountStamp() !== stamp || stamp.owner !== getCurrentUserHandle()
        || (groupSaveStates.get(groupId)?.status && groupSaveStates.get(groupId).status !== 'saved')) {
        throw new Error('The selected group changed before import.');
    }
    const applied = groupBackgroundState.get(group);
    if (applied?.failed) throw new Error('Reload the group before importing a chat.');
    if (applied && JSON.stringify(snapshotGroupMetadata(group)) !== JSON.stringify(applied.contents)) {
        throw new Error('Save the group changes before importing a chat.');
    }
    const source = applied?.evidence?.source ?? groupReadEvidence.get(group)?.source;
    if (!source) throw new Error('Reload the group before importing a chat.');
    return { groupId, group, stamp, source: structuredClone(source),
        revision: groupSaveStates.get(groupId)?.revision, readEvidence: groupReadEvidence.get(group),
        backgroundState: groupBackgroundState.get(group), contents: snapshotGroupMetadata(group) };
}

const GROUP_MEMBER_MODELS_KEY = 'member_models';
const ENTITY_SELECTION_PULSE_CLEANUP_MS = 900;
let entitySelectionPulseId = 0;

const GROUP_SAVE_STATUS_COPY = Object.freeze({
    draft: 'Draft, not saved',
    unsaved: 'Unsaved changes',
    saving: 'Saving...',
    saved: 'Saved',
    error: 'Couldn\'t save',
});

function setGroupSaveStatus(status, groupId = openGroupId, revision = groupSaveStates.get(groupId)?.revision ?? 0) {
    const state = groupSaveStates.get(groupId);
    if (revision !== (state?.revision ?? 0)) {
        return;
    }

    const normalizedStatus = GROUP_SAVE_STATUS_COPY[status] ? status : 'saved';
    if (groupId) {
        groupSaveStates.set(groupId, { revision, status: normalizedStatus });
    }
    const element = document.getElementById('sb_group_save_status');
    if (!(element instanceof HTMLElement) || openGroupId !== groupId) {
        return;
    }

    element.dataset.saveStatus = normalizedStatus;
    element.textContent = GROUP_SAVE_STATUS_COPY[normalizedStatus];
}

function markGroupSaveDirty(groupId = openGroupId) {
    const revision = (groupSaveStates.get(groupId)?.revision ?? 0) + 1;
    groupSaveStates.set(groupId, { revision, status: 'unsaved' });
    setGroupSaveStatus('unsaved', groupId, revision);
    return revision;
}

function pulseSelectedEntityCard(card) {
    const charactersBlock = card?.closest?.('#rm_print_characters_block');
    if (!(charactersBlock instanceof HTMLElement) || !(card instanceof HTMLElement)) {
        return;
    }

    charactersBlock.querySelectorAll('.sb-just-selected').forEach(element => {
        element.classList.remove('sb-just-selected');
        element.removeAttribute('data-sb-selection-pulse');
    });

    const pulseToken = String(++entitySelectionPulseId);
    let cleanupTimer = 0;
    const cleanupPulse = () => {
        window.clearTimeout(cleanupTimer);
        card.removeEventListener('animationend', cleanupPulseOnAnimationEnd);
        if (card.dataset.sbSelectionPulse !== pulseToken) {
            return;
        }

        card.classList.remove('sb-just-selected');
        card.removeAttribute('data-sb-selection-pulse');
    };
    const cleanupPulseOnAnimationEnd = (event) => {
        if (event.target !== card || event.animationName !== 'sb-entity-select-pulse') {
            return;
        }

        cleanupPulse();
    };

    card.dataset.sbSelectionPulse = pulseToken;
    card.classList.add('sb-just-selected');
    card.addEventListener('animationend', cleanupPulseOnAnimationEnd, { once: true });
    cleanupTimer = window.setTimeout(cleanupPulse, ENTITY_SELECTION_PULSE_CLEANUP_MS);
}

function getGroupMemberModels(group) {
    if (!group || typeof group !== 'object') {
        return {};
    }

    if (!group[GROUP_MEMBER_MODELS_KEY] || typeof group[GROUP_MEMBER_MODELS_KEY] !== 'object') {
        group[GROUP_MEMBER_MODELS_KEY] = {};
    }

    return group[GROUP_MEMBER_MODELS_KEY];
}

function getGroupMemberModel(group, avatarId) {
    return String(getGroupMemberModels(group)[avatarId] ?? '').trim();
}

function setGroupMemberModel(group, avatarId, model) {
    if (!group || !avatarId) {
        return;
    }

    const models = getGroupMemberModels(group);
    const value = String(model ?? '').trim();
    if (value) {
        models[avatarId] = value;
    } else {
        delete models[avatarId];
    }
}

function getCurrentChatCompletionModelSettingKey() {
    switch (oai_settings.chat_completion_source) {
        case chat_completion_sources.CLAUDE: return 'claude_model';
        case chat_completion_sources.OPENAI:
        case chat_completion_sources.OPENAI_RESPONSES: return 'openai_model';
        case chat_completion_sources.MAKERSUITE: return 'google_model';
        case chat_completion_sources.VERTEXAI: return 'vertexai_model';
        case chat_completion_sources.OPENROUTER: return 'openrouter_model';
        case chat_completion_sources.AI21: return 'ai21_model';
        case chat_completion_sources.MISTRALAI: return 'mistralai_model';
        case chat_completion_sources.CUSTOM: return 'custom_model';
        case chat_completion_sources.COHERE: return 'cohere_model';
        case chat_completion_sources.PERPLEXITY: return 'perplexity_model';
        case chat_completion_sources.GROQ: return 'groq_model';
        case chat_completion_sources.SILICONFLOW: return 'siliconflow_model';
        case chat_completion_sources.ELECTRONHUB: return 'electronhub_model';
        case chat_completion_sources.CHUTES: return 'chutes_model';
        case chat_completion_sources.NANOGPT: return 'nanogpt_model';
        case chat_completion_sources.DEEPSEEK: return 'deepseek_model';
        case chat_completion_sources.AIMLAPI: return 'aimlapi_model';
        case chat_completion_sources.XAI: return 'xai_model';
        case chat_completion_sources.POLLINATIONS: return 'pollinations_model';
        case chat_completion_sources.COMETAPI: return 'cometapi_model';
        case chat_completion_sources.MOONSHOT: return 'moonshot_model';
        case chat_completion_sources.FIREWORKS: return 'fireworks_model';
        case chat_completion_sources.AZURE_OPENAI: return 'azure_openai_model';
        case chat_completion_sources.ZAI: return 'zai_model';
        default: return '';
    }
}

async function runWithGroupMemberModelOverride(group, avatarId, callback) {
    const model = getGroupMemberModel(group, avatarId);
    const settingKey = model ? getCurrentChatCompletionModelSettingKey() : '';

    if (!model || !settingKey) {
        return callback();
    }

    const previousModel = oai_settings[settingKey];
    oai_settings[settingKey] = model;
    try {
        console.debug(`[Group] Using model override for ${avatarId}: ${model}`);
        return await callback();
    } finally {
        oai_settings[settingKey] = previousModel;
    }
}

const GROUP_SPEAKER_CONTROLS_HIDDEN_KEY = 'GroupSpeakerControlsHidden';
let selectedGroupSpeakerAvatar = '';
let groupSpeakerControlsInitialized = false;
let activeGroupTypingName = '';
let groupSpeakerAvatarRenderKey = '';

function getCharacterIdByAvatar(avatarId) {
    return characters.findIndex(character => character.avatar === avatarId);
}

function getSelectedGroupSpeakerAvatar() {
    return selectedGroupSpeakerAvatar;
}

function getGroupEnabledMembers(group) {
    if (!group || !Array.isArray(group.members)) {
        return [];
    }

    const away = group.id === selected_group ? readGroupScene(chat_metadata, group.members).away : [];
    return group.members.filter(member => !group.disabled_members?.includes(member) && !away.includes(member));
}

let activeGroupAudience = null;
let activeGroupTurnAudience = null;

export function getGroupMessageAudience({ forUser = false } = {}) {
    if (!forUser && (activeGroupAudience || activeGroupTurnAudience)) return structuredClone(activeGroupAudience || activeGroupTurnAudience);
    const group = groups.find(item => item.id === selected_group);
    if (!group || !chat_metadata.group_scene) return null;
    const scene = readGroupScene(chat_metadata, group.members);
    return groupMessageAudience(scene, group.members, scene.whisper_to);
}

function beginGroupTurnAudience(type) {
    const previous = activeGroupTurnAudience;
    const saved = ['swipe', 'continue'].includes(type)
        ? chat.at(-1)?.extra?.group_scene || { present: groups.find(item => item.id === selected_group)?.members || [], whisper_to: [] } : null;
    activeGroupTurnAudience = saved ? structuredClone(saved) : getGroupMessageAudience({ forUser: true });
    return () => { activeGroupTurnAudience = previous; };
}

function usesGroupSceneVisibility() {
    return Boolean(chat_metadata.group_scene || chat.some(message => message.extra?.group_scene));
}

function getGroupScenePrompt(group) {
    if (!chat_metadata.group_scene) return '';
    const prompt = groupScenePrompt(readGroupScene(chat_metadata, group.members), group.members.map(avatar => ({ avatar, name: characters[getCharacterIdByAvatar(avatar)]?.name || avatar })));
    const targets = getGroupMessageAudience()?.whisper_to || [];
    return prompt + (targets.length ? `\n[Private whisper between ${name1} and ${targets.map(avatar => characters[getCharacterIdByAvatar(avatar)]?.name || avatar).join(', ')}. Other members cannot hear or react to it. Keep the reply private.]` : '');
}

async function runWithGroupScene(avatars, callback) {
    const previous = activeGroupAudience;
    activeGroupAudience = getGroupMessageAudience();
    const restore = beginGroupPromptScope(avatars, chat);
    try { return await callback(); } finally { restore(); activeGroupAudience = previous; }
}

function getSelectedGroupSpeakerChid(group) {
    if (!selectedGroupSpeakerAvatar) {
        return -1;
    }

    if (!getGroupEnabledMembers(group).includes(selectedGroupSpeakerAvatar)) {
        selectedGroupSpeakerAvatar = '';
        return -1;
    }

    return getCharacterIdByAvatar(selectedGroupSpeakerAvatar);
}

/**
 * Resolves macros in a member's greeting as that member, so {{char}} and card fields name the greeter.
 * @param {string} text Greeting text
 * @param {number} chid Greeting member's character index
 * @param {string} characterName Greeting member's name
 * @returns {string}
 */
function substituteGroupGreetingMacros(text, chid, characterName) {
    if (!text) {
        return text;
    }

    const previousChid = this_chid;
    setCharacterId(chid);
    try {
        return substituteParams(text, { name2Override: characterName });
    } finally {
        setCharacterId(previousChid);
    }
}

function buildGroupGreetingMessage(avatarId) {
    const chid = getCharacterIdByAvatar(avatarId);
    const character = characters[chid];
    if (!character) {
        return null;
    }

    const prepareGreeting = greeting => substituteGroupGreetingMacros(getRegexedString(greeting, regex_placement.AI_OUTPUT), chid, character.name);
    const firstMes = character.first_mes || '';
    const alternateGreetings = character.data?.alternate_greetings;
    const message = {
        name: character.name,
        is_user: false,
        is_system: false,
        force_avatar: getThumbnailUrl('avatar', character.avatar),
        original_avatar: character.avatar,
        send_date: getMessageTimeStamp(),
        mes: prepareGreeting(firstMes),
        extra: getGroupMessageAudience() ? { group_scene: getGroupMessageAudience() } : {},
    };

    if (Array.isArray(alternateGreetings) && alternateGreetings.length > 0) {
        const swipes = [message.mes, ...alternateGreetings.map(prepareGreeting)];

        if (!message.mes) {
            swipes.shift();
            message.mes = swipes[0];
        }

        message.swipe_id = 0;
        message.swipes = swipes;
        message.swipe_info = swipes.map(_ => ({
            send_date: message.send_date,
            gen_started: void 0,
            gen_finished: void 0,
            extra: {},
        }));
    }

    return message.mes ? message : null;
}

function getGroupGreetingMember(group, preferredAvatar = '') {
    const members = getGroupEnabledMembers(group);
    const orderedMembers = members.includes(preferredAvatar)
        ? [preferredAvatar, ...members.filter(avatarId => avatarId !== preferredAvatar)]
        : members;

    for (const avatarId of orderedMembers) {
        const message = buildGroupGreetingMessage(avatarId);
        if (message) {
            return { avatarId, message };
        }
    }

    return null;
}

function captureGroupGreetingValidity(group, messageId) {
    const generation = getChatGeneration();
    const chatId = group.chat_id;
    const account = roleplayAccountStamp();
    const message = chat[messageId];
    return () => {
        try {
            return generation === getChatGeneration() && selected_group === group.id
                && groups.find(x => x.id === group.id) === group && group.chat_id === chatId
                && account === roleplayAccountStamp() && account.owner === getCurrentUserHandle()
                && chat[messageId] === message;
        } catch { return false; }
    };
}

async function emitGroupGreetingMessageEvents(messageId, isCurrent) {
    if (!isCurrent()) return;
    await eventSource.emit(event_types.MESSAGE_RECEIVED, messageId, 'first_message');
    if (!isCurrent()) return;
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'first_message');
}

function addFreshGroupGreeting(group) {
    const greeting = getGroupGreetingMember(group, selectedGroupSpeakerAvatar);
    if (!greeting) {
        return -1;
    }

    const messageId = chat.length;
    chat.push(greeting.message);
    return messageId;
}

async function addSelectedGroupGreeting() {
    if (!selected_group || !selectedGroupSpeakerAvatar) {
        toastr.warning(t`Pick a group member first.`);
        return;
    }

    const group = groups.find(x => x.id === selected_group);
    if (!getGroupEnabledMembers(group).includes(selectedGroupSpeakerAvatar)) {
        selectedGroupSpeakerAvatar = '';
        updateGroupSpeakerControls();
        toastr.warning(t`Pick a group member first.`);
        return;
    }

    const message = buildGroupGreetingMessage(selectedGroupSpeakerAvatar);
    if (!message) {
        toastr.warning(t`Selected group member has no greeting.`);
        return;
    }

    const messageId = chat.length;
    chat.push(message);
    const isCurrent = captureGroupGreetingValidity(group, messageId);
    await saveGroupChat(selected_group, false);
    if (!isCurrent()) return;
    await printMessages();
    await emitGroupGreetingMessageEvents(messageId, isCurrent);
}

function buildContextAwareGroupPrompt(speakerName, options = {}) {
    const targetName = options.targetName || '';
    const targetText = targetName ? ` The immediate call or message is directed at ${speakerName} by ${targetName}; ${speakerName} should answer ${targetName}.` : '';
    const ownLinesText = options.ownLines ? buildOwnLinesReminder(speakerName, options.otherNames, options.userName) : '';
    return `[Group context: write only as ${speakerName}. Pay attention to who addressed whom in the recent chat. If the user calls for ${speakerName}, answer the user. If another character calls for ${speakerName}, answer that character. Characters may also talk to each other naturally when the context calls for it.${targetText}${ownLinesText}]`;
}

function getSelectedGroupRecord() {
    return selected_group ? groups.find(x => x.id == selected_group) : undefined;
}

export function isGroupNarratorActive() {
    return Boolean(selected_group) && getGroupMemberRole(getSelectedGroupRecord(), characters[this_chid]) === 'narrator';
}

/**
 * Whether reply cleanup should also cut at markdown-styled member names such as `**Mira:**`.
 * @returns {boolean}
 */
export function shouldTrimGroupMarkdownNames() {
    const group = getSelectedGroupRecord();
    return Boolean(group) && isKeepOwnLinesEnabled(group);
}

/**
 * Add `\nName:` stops for the other members of the open group to a Chat Completion request.
 * @param {string[]} existing Stop strings the user configured
 * @param {number} [limit] Provider stop limit
 * @param {string} [type] Generation type
 * @returns {string[]}
 */
export function getGroupSpeakerStopStrings(existing, limit, type) {
    const group = getSelectedGroupRecord();
    if (!group || isGroupEnsembleActive() || isGroupNarratorActive() || !isKeepOwnLinesEnabled(group) || ['quiet', 'impersonate'].includes(type)) {
        return existing;
    }
    return appendGroupSpeakerStops(existing, getOtherMemberNames(getGroupNames(), name2), limit);
}

function findDirectlyAddressedMember(group, text) {
    const lowerText = String(text || '').toLowerCase();
    if (!lowerText || !group) {
        return -1;
    }

    for (const avatar of getGroupEnabledMembers(group)) {
        const character = characters.find(x => x.avatar === avatar);
        if (!character?.name) continue;
        const escapedName = character.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const directMention = new RegExp(`(^|[^\\p{L}\\p{N}_])@?${escapedName}([^\\p{L}\\p{N}_]|$)`, 'iu');
        if (directMention.test(lowerText)) {
            return getCharacterIdByAvatar(avatar);
        }
    }

    return -1;
}

function isAddressedToEntireGroup(text) {
    return /(^|[^\p{L}\p{N}_])(?:everyone|everybody|you\s+all|y['’]?all|all)([^\p{L}\p{N}_]|$)/iu.test(String(text || ''));
}


function getMessageSpeakerName(message) {
    if (!message) return '';
    return message.is_user ? 'the user' : (message.name || 'another character');
}

function clearSelectedGroupSpeaker() {
    selectedGroupSpeakerAvatar = '';
    $('#group_speaker_controls .group_speaker_avatar').removeClass('selected');
}

function limitGroupSpeakersForControl(activatedMembers, forceSingleSpeaker) {
    if (!forceSingleSpeaker || activatedMembers.length <= 1) {
        return activatedMembers;
    }

    return activatedMembers.slice(0, 1);
}

function setGroupDirectorChoosingIndicator(active) {
    activeGroupTypingName = '';
    const indicator = $('#group_typing_indicator');
    if (!indicator.length) {
        return;
    }

    indicator.text(active ? t`Choosing who speaks next...` : '');
    indicator.toggleClass('displayNone', !active);
    $('#group_speaker_controls').toggleClass('is-typing', Boolean(active));
}

function setGroupTypingIndicator(characterName = '', directorNote = '') {
    const nextTypingName = String(characterName || '');
    activeGroupTypingName = nextTypingName;
    const indicator = $('#group_typing_indicator');
    if (!indicator.length) {
        return;
    }

    const note = activeGroupTypingName && directorNote ? ` · ${directorNote}` : '';
    indicator.text(activeGroupTypingName ? `${activeGroupTypingName} is typing...${note}` : '');
    indicator.toggleClass('displayNone', !activeGroupTypingName);
    $('#group_speaker_controls').toggleClass('is-typing', Boolean(activeGroupTypingName));
}

function isGroupSpeakerControlsHidden() {
    return accountStorage.getItem(GROUP_SPEAKER_CONTROLS_HIDDEN_KEY) === 'true';
}

function setGroupSpeakerControlsHidden(hidden) {
    accountStorage.setItem(GROUP_SPEAKER_CONTROLS_HIDDEN_KEY, String(Boolean(hidden)));
    updateGroupSpeakerControls();
}

function updateGroupSpeakerControls() {
    renderGroupScene();
    const container = $('#group_speaker_controls');
    if (!container.length) {
        return;
    }

    const group = selected_group ? groups.find(x => x.id === selected_group) : null;
    const members = getGroupEnabledMembers(group);
    const isAvailable = Boolean(group) && members.length > 0;
    const isHidden = isGroupSpeakerControlsHidden();
    container.toggleClass('displayNone', !isAvailable || isHidden);
    // The wand entry is injected later than this runs, so gate it with a body class instead of a direct toggle.
    // Keyed on the hidden flag alone: the way back must exist whenever the bar is hidden.
    document.body.classList.toggle('groupSpeakerControlsHidden', isHidden);
    if (!isAvailable) {
        clearSelectedGroupSpeaker();
        setGroupTypingIndicator('');
        groupSpeakerAvatarRenderKey = '';
        updateGroupNextUp();
        return;
    }

    const avatarRenderKey = JSON.stringify({
        groupId: group.id,
        members,
    });
    if (avatarRenderKey !== groupSpeakerAvatarRenderKey) {
        groupSpeakerAvatarRenderKey = avatarRenderKey;
        const avatarList = container.find('.group_speaker_list').empty();
        for (const avatarId of members) {
            const character = characters.find(x => x.avatar === avatarId);
            if (!character) {
                continue;
            }

            const item = $('<button type="button" class="group_speaker_avatar"></button>');
            item.attr('title', `${character.name}: speak next / now`);
            item.attr('data-avatar', avatarId);
            item.toggleClass('selected', avatarId === selectedGroupSpeakerAvatar);
            item.append($('<img alt="">').attr({
                src: getThumbnailUrl('avatar', avatarId),
                loading: 'lazy',
                decoding: 'async',
            }));
            item.append($('<span></span>').text(character.name));
            avatarList.append(item);
        }
    }

    container.find('.group_speaker_avatar').each(function () {
        const avatarId = String($(this).data('avatar') || '');
        $(this).toggleClass('selected', avatarId === selectedGroupSpeakerAvatar);
    });
    updateGroupNextUp();
}

function syncGroupTalkButton() {
    const button = $('#group_let_them_talk');
    if (!button.length) {
        return;
    }

    const running = Boolean(activeGroupTalkBurst);
    button.toggleClass('is-running', running).attr('aria-pressed', String(running));
    button.attr('title', running ? t`Stop the characters talking` : t`Let the characters talk among themselves`);
    button.find('i').toggleClass('fa-comments', !running).toggleClass('fa-circle-stop', running);
    button.find('span').text(running ? t`Stop` : t`Let them talk`);
}

/**
 * Ends a running 'Let them talk' burst and stops the reply being written, if any.
 */
export function stopGroupTalkBurst() {
    if (!activeGroupTalkBurst) {
        return;
    }

    activeGroupTalkBurst.cancelled = true;
    activeGroupTalkBurst.controller.abort();
    if (is_send_press || is_group_generating) {
        stopGeneration();
    }
}

/**
 * Lets the group members take several turns in a row while the user listens.
 * Each reply is saved as soon as it finishes; Stop, a user message or leaving the chat ends the burst.
 * @returns {Promise<void>}
 */
export async function letGroupMembersTalk() {
    if (activeGroupTalkBurst) {
        stopGroupTalkBurst();
        return;
    }

    const group = selected_group ? groups.find(x => x.id === selected_group) : null;
    if (!group || getGroupEnabledMembers(group).length < 2) {
        toastr.warning(t`Unmute at least two members first.`);
        return;
    }

    if (is_send_press || is_group_generating) {
        toastr.info(t`Wait for the current reply to finish.`);
        return;
    }

    const chatId = String(getCurrentChatId() || '');
    const burst = { groupId: group.id, chatId, remaining: getGroupTalkBurstCount(group), cancelled: false, controller: new AbortController() };
    const cancel = () => {
        burst.cancelled = true;
        burst.controller.abort();
    };
    activeGroupTalkBurst = burst;
    eventSource.on(event_types.GENERATION_STOPPED, cancel);
    eventSource.on(event_types.MESSAGE_SENT, cancel);
    eventSource.on(event_types.CHAT_CHANGED, cancel);
    syncGroupTalkButton();

    try {
        while (!burst.cancelled && burst.remaining > 0) {
            if (selected_group !== burst.groupId || String(getCurrentChatId() || '') !== burst.chatId) {
                break;
            }

            const before = chat.length;
            const result = await Generate('normal', { suppressUserMessage: true, suppressAutoContinue: true, signal: burst.controller.signal });
            const added = chat.slice(before).filter(message => message && !message.is_user && !message.is_system);
            if (result?.generationOutcome || added.some(messageAutomaticGenerationSuppressed) || added.length === 0) {
                break;
            }
            burst.remaining -= added.length;
        }
    } catch (error) {
        if (!burst.cancelled) {
            console.warn('[Group talk] The conversation stopped early.', error);
        }
    } finally {
        eventSource.removeListener(event_types.GENERATION_STOPPED, cancel);
        eventSource.removeListener(event_types.MESSAGE_SENT, cancel);
        eventSource.removeListener(event_types.CHAT_CHANGED, cancel);
        if (activeGroupTalkBurst === burst) {
            activeGroupTalkBurst = null;
        }
        syncGroupTalkButton();
    }
}

function initGroupSpeakerControls() {
    initGroupSceneControls();
    initGroupSpeakerMenu({ saveGroup: id => editGroup(id, false, false), editMember: openCharacterDefinition });
    if (groupSpeakerControlsInitialized) {
        return;
    }

    groupSpeakerControlsInitialized = true;
    const container = $('#group_speaker_controls');
    container.on('click', '.group_speaker_avatar', async function (event) {
        const avatarId = String($(this).data('avatar') || '');
        const alreadySelected = selectedGroupSpeakerAvatar === avatarId;
        selectedGroupSpeakerAvatar = alreadySelected ? '' : avatarId;
        updateGroupSpeakerControls();

        if (event.shiftKey && selected_group) {
            const chid = getCharacterIdByAvatar(avatarId);
            if (chid !== -1) {
                Generate('normal', { force_chid: chid });
            }
        }
    });

    container.on('click', '#group_speaker_now', async function () {
        if (!selected_group || !selectedGroupSpeakerAvatar) {
            toastr.warning(t`Pick a group member first.`);
            return;
        }

        const chid = getCharacterIdByAvatar(selectedGroupSpeakerAvatar);
        if (chid !== -1) {
            Generate('normal', { force_chid: chid });
        }
    });

    container.on('click', '#group_add_greeting', addSelectedGroupGreeting);
    container.on('click', '#group_let_them_talk', letGroupMembersTalk);
    container.on('click', '#group_speaker_hide', () => setGroupSpeakerControlsHidden(true));
    $(document).on('click', '#wand_group_speaker_controls', () => setGroupSpeakerControlsHidden(false));
    eventSource.on(event_types.MESSAGE_RECEIVED, () => updateGroupNextUp());
    eventSource.on(event_types.MESSAGE_SENT, () => updateGroupNextUp());
}

let groupDirectorPreview = null;
let groupDirectorFailure = '';
let groupDirectorFallbackNoticeChat = '';

/**
 * Tell the user once per chat that the Scene Director did not choose this turn, and why.
 * @param {string} failure 'timeout', 'error' or 'unusable'
 */
function notifyGroupDirectorFallback(failure) {
    const chatId = String(getCurrentChatId() || '');
    if (groupDirectorFallbackNoticeChat === chatId) {
        return;
    }
    groupDirectorFallbackNoticeChat = chatId;
    const seconds = Math.round(GROUP_DIRECTOR_TIMEOUT_MS / 1000);
    const message = failure === 'timeout'
        ? t`The Scene Director took longer than ${seconds} seconds, so the usual order picked who speaks. A faster connection profile for the director, in the group's settings, helps.`
        : t`The Scene Director's answer could not be used, so the usual order picked who speaks. Check the director's connection profile in the group's settings.`;
    toastr.warning(message, t`Scene Director`);
}

function describeGroupDirectorStatus(preview, names) {
    if (!preview) {
        return t`Scene Director is on: before each reply it picks who answers.`;
    }
    if (preview.fallback === 'timeout') {
        return t`Last turn: the Scene Director took longer than ${Math.round(GROUP_DIRECTOR_TIMEOUT_MS / 1000)} seconds, so the usual order picked the speaker.`;
    }
    if (preview.fallback) {
        return t`Last turn: the Scene Director's answer could not be used, so the usual order picked the speaker.`;
    }
    const picked = names(preview.chids.map(chid => characters[chid]?.avatar).filter(Boolean));
    const reason = preview.reason ? ` · ${preview.reason}` : '';
    return `${picked ? t`Last turn: the Scene Director picked ${picked}` : t`Last turn: the Scene Director handed the scene back to you`}${reason}`;
}

function updateGroupNextUp(directed = null) {
    const group = groups.find(item => item.id === selected_group);
    if (directed) groupDirectorPreview = { groupId: selected_group, chatId: getCurrentChatId(), ...directed };
    const avatarButtons = $('#group_speaker_controls .group_speaker_avatar');
    const directorStatus = $('#group_scene_director_status');
    if (!group) {
        $('#group_next_up').text('').addClass('displayNone');
        directorStatus.text('').addClass('displayNone');
        avatarButtons.removeClass('is-next-up');
        return;
    }
    const names = avatars => avatars.map(avatar => characters[getCharacterIdByAvatar(avatar)]?.name).filter(Boolean).join(', ');
    const members = getGroupEnabledMembers(group);
    const whispers = getGroupMessageAudience()?.whisper_to || [];
    const strategy = Number(group.activation_strategy);
    const currentPreview = groupDirectorPreview?.groupId === selected_group && groupDirectorPreview.chatId === getCurrentChatId() ? groupDirectorPreview : null;
    let text = '';
    let next = [];
    let reason = '';
    if (whispers.length) {
        next = whispers;
        text = t`Whisper to ${names(whispers)}`;
    } else if (selectedGroupSpeakerAvatar && members.includes(selectedGroupSpeakerAvatar)) {
        next = [selectedGroupSpeakerAvatar];
        text = t`Next up: ${names(next)}`;
    } else if (strategy === group_activation_strategy.LIST) {
        next = members.slice(0, 1);
        text = t`Next up: ${names(next)}`;
    } else if (strategy === group_activation_strategy.POOLED) {
        next = getGroupSpeakerPool(members, chat);
        text = t`Next from: ${names(next)}`;
    } else if (strategy === group_activation_strategy.DIRECTOR && currentPreview && !currentPreview.fallback) {
        next = currentPreview.chids.map(chid => characters[chid]?.avatar).filter(Boolean);
        reason = currentPreview.reason || '';
        const picked = names(next);
        text = `${picked ? t`Director picked: ${picked}` : t`Waiting for you`}${reason ? ` · ${reason}` : ''}`;
    }
    $('#group_next_up').text(text).toggleClass('displayNone', !text);
    // The scene panel says what the director did last, so its work is visible without reading the console.
    const isDirector = strategy === group_activation_strategy.DIRECTOR;
    directorStatus.text(isDirector ? describeGroupDirectorStatus(currentPreview, names) : '').toggleClass('displayNone', !isDirector);
    // Ring the avatars instead of spending a row of the composer on the preview.
    avatarButtons.each(function () {
        const avatar = String($(this).data('avatar') || '');
        const name = characters[getCharacterIdByAvatar(avatar)]?.name || avatar;
        const isNext = next.includes(avatar);
        $(this).toggleClass('is-next-up', isNext)
            .attr('title', isNext ? `${t`Next up: ${name}`}${reason ? ` · ${reason}` : ''}` : `${name}: speak next / now`);
    });
}

export const group_activation_strategy = {
    NATURAL: 0,
    LIST: 1,
    MANUAL: 2,
    POOLED: 3,
    DIRECTOR: GROUP_DIRECTOR_STRATEGY,
};

export const group_generation_mode = {
    SWAP: 0,
    APPEND: 1,
    APPEND_DISABLED: 2,
};

export const groupCandidatesFilter = new FilterHelper(debounce(printGroupCandidates, debounce_timeout.quick));
export const groupMembersFilter = new FilterHelper(debounce(printGroupMembers, debounce_timeout.quick));
const pendingGroupMetadataSaves = new Map();
function snapshotGroupMetadata(group) {
    const snapshot = structuredClone(group);
    for (const key of ['__roleplay', 'date_added', 'create_date', 'date_last_chat', 'chat_size']) delete snapshot[key];
    return snapshot;
}

function saveGroupDebounced(job) {
    const timer = setTimeout(() => {
        if (pendingGroupMetadataSaves.get(job.groupId)?.job !== job) return;
        pendingGroupMetadataSaves.delete(job.groupId);
        void _save(job).catch(error => console.error('Error while saving group.', error));
    }, debounce_timeout.relaxed);
    pendingGroupMetadataSaves.set(job.groupId, { timer, job });
}
/** @type {Map<string, number>} */
let groupChatQueueOrder = new Map();

/**
 * Saves a group to the server.
 * @param {Group} group Group object to save
 * @param {boolean} reload Whether to refresh the character and group library after saving
 */
async function _save(job) {
    const { group, groupId, reload, account, revision, token, snapshot, background } = job;
    // ponytail: one metadata queue; split by group only if independent saves become slow.
    const save = groupMetadataSaveQueue.catch(() => {}).then(async () => {
        if (!background && typeof setGroupSaveStatus === 'function') {
            setGroupSaveStatus('saving', groupId, revision);
        }
        try {
            if (account !== getCurrentUserHandle()) throw new Error('account_changed');
            const response = await sendRoleplaySave(token, snapshot, (body, stamp) => fetchWithCsrfRetry('/api/groups/edit', () => ({
                method: 'POST', headers: { ...getRequestHeaders(), 'X-Neconyan-Account': stamp.owner }, body,
            }), { refreshCsrfToken }));
            // Neconyan: surface metadata-save failures so chat rename can roll back consistently.
            if (!response.ok || account !== getCurrentUserHandle()) {
                throw new Error(`Could not save group ${groupId}.`);
            }
            if (groups.includes(group)) {
                const evidence = { account: roleplayAccountStamp().account, source: response.data.roleplay.source };
                if (!background) groupReadEvidence.set(group, evidence);
                groupBackgroundState.set(group, { evidence, contents: snapshot, failed: false });
            }
            await finishRoleplaySave(token);
            if (!background && reload && revision === (groupSaveStates.get(groupId)?.revision ?? 0)) {
                // The edited group is already current in memory; a server reload can replace newer input.
                await printCharacters();
            }
            if (!background && typeof setGroupSaveStatus === 'function') {
                setGroupSaveStatus('saved', groupId, revision);
            }
        } catch (error) {
            if (background && groups.includes(group)) {
                const state = groupBackgroundState.get(group);
                if (state) state.failed = true;
            }
            if (!background && typeof setGroupSaveStatus === 'function') {
                setGroupSaveStatus('error', groupId, revision);
            }
            throw error;
        } finally {
            await finishRoleplaySave(token);
            if (queuedGroupMetadataById.get(groupId) === job) queuedGroupMetadataById.delete(groupId);
        }
    });
    groupMetadataSaveQueue = save;
    return save;
}

// Group chats
async function regenerateGroup() {
    let generationId = getLastMessageGenerationId();

    while (chat.length > 0) {
        const lastMes = chat[chat.length - 1];
        const this_generationId = lastMes.extra?.gen_id;

        // for new generations after the update
        if ((generationId && this_generationId) && generationId !== this_generationId) {
            break;
        } else if (lastMes.is_user || lastMes.is_system) {
            // legacy for generations before the update
            break;
        }

        await deleteLastMessage();
    }

    const abortController = new AbortController();
    setExternalAbortController(abortController);
    return generateGroupWrapper(false, 'normal', { signal: abortController.signal });
}

/**
 * Loads group chat messages from the server.
 * @param {string} chatId Chat ID
 * @param {boolean} allowCreate Whether a missing file is an explicitly new chat
 * @returns {Promise<{records: ChatFile, evidence: object}>} Chat messages and their captured save authority
 */
async function loadGroupChat(chatId, allowCreate = false) {
    return loadRoleplayChat({ group: true, chat: String(chatId) }, { allowCreate });
}

/**
 * Checks whether a group chat file currently exists on the server.
 * @param {string} chatId Chat ID
 * @returns {Promise<'present'|'missing'|'unknown'>} Current availability state
 */
async function groupChatExists(chatId) {
    if (!chatId) {
        return 'missing';
    }

    try {
        const response = await fetchWithCsrfRetry('/api/chats/group/info', () => ({
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ id: chatId }),
        }), { refreshCsrfToken });

        if (response.ok) {
            return 'present';
        }

        return response.status === 404 ? 'missing' : 'unknown';
    } catch {
        return 'unknown';
    }
}

/**
 * Validates a group by checking if all members exist and removing duplicates.
 * @param {Group} group Group to validate
 * @param {object} [options] Validation options
 * @param {boolean} [options.trustActiveChat=false] Whether to keep the active chat id even before its JSONL exists
 * @returns {Promise<void>}
 */
async function validateGroup(group, { trustActiveChat = false } = {}) {
    if (!group) return;

    // Validate that all members exist as characters
    let dirty = false;
    group.members = group.members.filter(member => {
        const character = characters.find(x => x.avatar === member || x.name === member);
        if (!character) {
            const msg = t`${member} is listed in this group but no longer exists as a character, so they will be removed from the group.`;
            toastr.warning(msg, t`Group Validation`);
            console.warn(msg);
            dirty = true;
        }
        return character;
    });

    if (typeof group.chat_id === 'number') {
        group.chat_id = String(group.chat_id);
        dirty = true;
    }

    // Remove duplicate chat ids and normalize IDs to strings
    if (Array.isArray(group.chats)) {
        const lengthBefore = group.chats.length;
        group.chats = group.chats.map(chatId => String(chatId)).filter(onlyUnique);
        const lengthAfter = group.chats.length;
        if (lengthBefore !== lengthAfter) {
            dirty = true;
        }
    }

    // Recover from stale chat IDs that no longer have a JSONL on disk.
    if (Array.isArray(group.chats) && group.chats.length) {
        const presentChats = [];
        const retainedChats = [];
        const results = await Promise.allSettled(group.chats.map(chatId => groupChatExists(chatId)));

        for (let i = 0; i < results.length; i++) {
            const chatId = group.chats[i];
            const availability = results[i].status === 'fulfilled' ? results[i].value : 'unknown';
            const isActiveChat = chatId === String(group.chat_id ?? '');

            if (availability === 'present') {
                presentChats.push(chatId);
                retainedChats.push(chatId);
                continue;
            }

            if (availability !== 'missing' || isActiveChat) {
                retainedChats.push(chatId);
            }
        }

        if (retainedChats.length !== group.chats.length) {
            group.chats = retainedChats;
            dirty = true;
        }

        // Neconyan: a newly-created group chat has no JSONL yet, so keep its active branch id.
        if (!trustActiveChat && presentChats.length && !presentChats.includes(String(group.chat_id ?? ''))) {
            group.chat_id = presentChats[presentChats.length - 1];
            dirty = true;
        }
    }

    if (!Array.isArray(group.chats)) {
        group.chats = [];
        dirty = true;
    }

    if (dirty) {
        await editGroup(group.id, true, false);
    }
}

/**
 * Loads the chat messages for a specific group.
 * @param {string} groupId - The ID of the group to load chat messages for.
 * @param {boolean} reload - Whether to reload the group chat after loading.
 * @param {object} options - Load options.
 * @param {boolean} [options.switchMenu=true] Whether to switch the right menu to the group editor.
 * @param {boolean} [options.newlyCreated=false] Whether the active group chat was created before loading.
 * @returns {Promise<void>} A promise that resolves when the chat messages have been loaded.
 */
export async function getGroupChat(groupId, reload = false, { switchMenu = true, newlyCreated = false, readOnlyRoute = false, navigationGuard = () => true, expectedSourceId = '', verifyTarget = () => true } = {}) {
    incrementChatGeneration();
    const generation = getChatGeneration();
    const account = roleplayAccountStamp();

    const group = groups.find((x) => x.id === groupId);
    if (!group) {
        console.warn('Group not found', groupId);
        return;
    }
    const stillCurrent = (chatId = group.chat_id) => {
        try {
            return navigationGuard() && generation === getChatGeneration() && selected_group === groupId && groups.find(x => x.id === groupId) === group
                && group.chat_id === chatId && getCurrentUserHandle() === account.owner && roleplayAccountStamp() === account;
        } catch { return false; }
    };

    // Run validation before any loading
    if (!readOnlyRoute) await validateGroup(group, { trustActiveChat: newlyCreated });
    if (!stillCurrent()) return;
    await unshallowGroupMembers(groupId);
    if (!stillCurrent()) return;

    if (!group.chat_id) {
        if (readOnlyRoute) return false;
        const freshChatId = humanizedDateTime();
        group.chat_id = freshChatId;
        group.chats = Array.isArray(group.chats) ? group.chats : [];
        group.chats.push(freshChatId);
        await editGroup(group.id, true, false);
        if (!stillCurrent(freshChatId)) return;
    }

    const chat_id = group.chat_id;
    let data;
    let loaded;
    try {
        // A listed chat with no file yet (API-created group, or never saved) opens as an empty vacancy;
        // the server only offers one when no live record owns that name.
        loaded = await loadGroupChat(chat_id, !readOnlyRoute);
        if (!stillCurrent(chat_id)) return;
        if (expectedSourceId && loaded.evidence?.source?.instanceId !== expectedSourceId) throw Object.assign(new Error('The saved chat changed while opening.'), { status: 409 });
        data = loaded.records;
    } catch (error) {
        if (readOnlyRoute) throw error;
        console.error(error);
        toastr.error(roleplayLoadErrorMessage(error));
        return;
    }
    const metadata = data?.[0]?.chat_metadata ?? {};

    // Remove chat file header if present
    if (Array.isArray(data) && data.length && Object.hasOwn(data[0], 'chat_metadata')) {
        data.shift();
    }

    // Neconyan: initialize empty, untainted group chats even when the chat id was created before this load.
    const freshChat = !readOnlyRoute && !metadata.tainted && (!Array.isArray(data) || !data.length);

    // Neconyan: no integrity slug means the server treats the file as intact and mints one on the
    // first real save. Stamping one in on load only dirtied legacy chats into a needless rewrite.
    await loadItemizedPrompts(chat_id);
    if (!stillCurrent(chat_id)) return;
    if (readOnlyRoute && !await verifyTarget()) return false;
    if (!stillCurrent(chat_id)) return false;
    if (!rememberRoleplayRead({ group: true, chat: String(chat_id) }, loaded.evidence)) {
        toastr.error(t`The last save has not finished yet. Your current edits are kept, so try again in a moment.`);
        return;
    }

    let freshGroupGreetingMessageId = -1;
    let greetingStillCurrent;

    if (group && Array.isArray(group.members) && freshChat) {
        chat.splice(0, chat.length);
        chatElement.find('.mes').remove();
        freshGroupGreetingMessageId = addFreshGroupGreeting(group);
        if (freshGroupGreetingMessageId !== -1) greetingStillCurrent = captureGroupGreetingValidity(group, freshGroupGreetingMessageId);
        metadata.tainted = true;
        updateChatMetadata(metadata, true);
        const savedFreshGroupChat = await saveGroupChat(groupId, false);
        if (!stillCurrent(chat_id)) return;
        if (savedFreshGroupChat && chat_metadata.integrity) {
            metadata.integrity = chat_metadata.integrity;
        }
        await printMessages();
        if (!stillCurrent(chat_id)) return;
    } else if (Array.isArray(data) && data.length) {
        chat.splice(0, chat.length, ...data);
        chat.forEach(ensureMessageMediaIsArray);
        chatElement.find('.mes').remove();
        await printMessages();
        if (!stillCurrent(chat_id)) return;
    }

    updateChatMetadata(metadata, true);

    if (reload && switchMenu) {
        select_group_chats(groupId, true);
    }

    await eventSource.emit(event_types.CHAT_CHANGED, getCurrentChatId());
    if (!stillCurrent(chat_id)) return;
    if (freshChat) await eventSource.emit(event_types.GROUP_CHAT_CREATED);
    if (!stillCurrent(chat_id)) return;
    if (freshGroupGreetingMessageId !== -1) await emitGroupGreetingMessageEvents(freshGroupGreetingMessageId, greetingStillCurrent);
    return stillCurrent(chat_id);
}

/** The saved-only adapter skips group repair, vacancy creation and greetings. */
export async function openSavedGroupChat(groupId, chatName, navigationGuard = () => true, { expectedSourceId = '', verifyTarget = () => true } = {}) {
    const group = groups.find(item => String(item.id) === groupId);
    if (!group || !group.chats?.map(String).includes(chatName) || is_send_press || is_group_generating || !navigationGuard()) return false;
    if (!await flushPendingChatSavesForNavigation() || !navigationGuard()) return false;
    setCharacterId(undefined);
    setCharacterName('');
    resetSelectedGroup();
    await clearChat({ clearData: true, navigationGuard });
    if (!navigationGuard()) return false;
    cancelTtsPlay();
    selected_group = group.id;
    group.chat_id = chatName;
    updateChatMetadata({}, true);
    return getGroupChat(group.id, false, { switchMenu: false, readOnlyRoute: true, navigationGuard, expectedSourceId, verifyTarget });
}

/**
 * Retrieves the members of a group
 *
 * @param {string} [groupId=selected_group] - The ID of the group to retrieve members from. Defaults to the currently selected group.
 * @returns {Character[]} An array of character objects representing the members of the group. If the group is not found, an empty array is returned.
 */
export function getGroupMembers(groupId = selected_group) {
    const group = groups.find((x) => x.id === groupId);
    return group?.members.map(member => characters.find(x => x.avatar === member)) ?? [];
}

/**
 * Retrieves the member names of a group. If the group is not selected, an empty array is returned.
 * @returns {string[]} An array of character names representing the members of the group.
 */
export function getGroupNames() {
    if (!selected_group) {
        return [];
    }
    const groupMembers = groups.find(x => x.id == selected_group)?.members;
    return Array.isArray(groupMembers)
        ? groupMembers.map(x => characters.find(y => y.avatar === x)?.name).filter(x => x)
        : [];
}

/**
 * Finds the character ID for a group member.
 * @param {number|string} arg 0-based member index or character name
 * @param {Boolean} full Whether to return a key-value object containing extra data
 * @returns {number|Object} 0-based character ID or key-value object if full is true
 */
export function findGroupMemberId(arg, full = false) {
    arg = arg?.toString()?.trim();

    if (!arg) {
        console.warn('WARN: No argument provided for findGroupMemberId');
        return;
    }

    const group = groups.find(x => x.id == selected_group);

    if (!group || !Array.isArray(group.members)) {
        console.warn('WARN: No group found for selected group ID');
        return;
    }

    const index = parseInt(arg);
    const searchByString = isNaN(index);

    if (searchByString) {
        const memberNames = group.members.map(x => ({
            avatar: x,
            name: characters.find(y => y.avatar === x)?.name,
            index: characters.findIndex(y => y.avatar === x),
        }));
        const fuse = new Fuse(memberNames, { keys: ['avatar', 'name'] });
        const result = fuse.search(arg);

        if (!result.length) {
            console.warn(`WARN: No group member found using string ${arg}`);
            return;
        }

        const chid = result[0].item.index;

        if (chid === -1) {
            console.warn(`WARN: No character found for group member ${arg}`);
            return;
        }

        console.log(`Targeting group member ${chid} (${arg}) from search result`, result[0]);

        return !full ? chid : { ...{ id: chid }, ...result[0].item };
    } else {
        const memberAvatar = group.members[index];

        if (memberAvatar === undefined) {
            console.warn(`WARN: No group member found at index ${index}`);
            return;
        }

        const chid = characters.findIndex(x => x.avatar === memberAvatar);

        if (chid === -1) {
            console.warn(`WARN: No character found for group member ${memberAvatar} at index ${index}`);
            return;
        }

        console.log(`Targeting group member ${memberAvatar} at index ${index}`);

        return !full ? chid : {
            id: chid,
            avatar: memberAvatar,
            name: characters.find(y => y.avatar === memberAvatar)?.name,
            index: index,
        };
    }
}

/**
 * Gets depth prompts for group members.
 * @param {string} groupId Group ID
 * @param {number} characterId Current Character ID
 * @returns {{depth: number, text: string, role: string}[]} Array of depth prompts
 */
export function getGroupDepthPrompts(groupId, characterId) {
    if (!groupId) {
        return [];
    }

    console.debug('getGroupDepthPrompts entered for group: ', groupId);
    const group = groups.find(x => x.id === groupId);

    if (!group || !Array.isArray(group.members) || !group.members.length) {
        return [];
    }

    if (group.generation_mode === group_generation_mode.SWAP) {
        return [];
    }

    const depthPrompts = [];

    for (const member of group.members) {
        const index = characters.findIndex(x => x.avatar === member);
        const character = characters[index];

        if (index === -1 || !character) {
            console.debug(`Skipping missing member: ${member}`);
            continue;
        }

        if (group.disabled_members.includes(member) && characterId !== index) {
            console.debug(`Skipping disabled group member: ${member}`);
            continue;
        }

        const depthPromptText = baseChatReplace(character.data?.extensions?.depth_prompt?.prompt?.trim(), null, character.name) || '';
        const depthPromptDepth = character.data?.extensions?.depth_prompt?.depth ?? depth_prompt_depth_default;
        const depthPromptRole = character.data?.extensions?.depth_prompt?.role ?? depth_prompt_role_default;

        if (depthPromptText) {
            depthPrompts.push({ text: depthPromptText, depth: depthPromptDepth, role: depthPromptRole });
        }
    }

    return depthPrompts;
}

/**
 * Combines group members cards into a single string. Only for groups with generation mode set to APPEND or APPEND_DISABLED.
 * @param {string} groupId Group ID
 * @param {number} characterId Current Character ID
 * @returns {{description: string, personality: string, scenario: string, mesExamples: string}} Group character cards combined
 */
export function getGroupCharacterCards(groupId, characterId) {
    const lazy = getGroupCharacterCardsLazy(groupId, characterId);
    if (!lazy) return null;

    // Resolve all lazy fields into a plain object
    return {
        description: lazy.description,
        personality: lazy.personality,
        scenario: lazy.scenario,
        mesExamples: lazy.mesExamples,
    };
}

/**
 * Returns group character cards with lazy evaluation.
 * Each field is only processed when first accessed.
 * @param {string} groupId Group ID
 * @param {number} characterId Current Character ID
 * @returns {{description: string, personality: string, scenario: string, mesExamples: string}} Group character cards with lazy getters
 */
export function getGroupCharacterCardsLazy(groupId, characterId) {
    const group = groups.find(x => x.id === groupId);

    // If no group cards should be generated, return null so caller knows to fall back
    const ensemble = isGroupEnsembleActive() ? activeGroupEnsemble : null;
    if (!group || (!group?.generation_mode && !ensemble) || !Array.isArray(group.members) || !group.members.length) {
        return null;
    }

    /**
     * Runs baseChatReplace on a text, with custom <FIELDNAME> replace
     * @param {string} value Value to replace
     * @param {string} fieldName Name of the field
     * @param {string} characterName Name of the character
     * @param {boolean} trim Whether to trim the value
     * @returns {string} Replaced text
     */
    function customTransform(value, fieldName, characterName, trim) {
        if (!value) return '';
        value = value.replace(/<FIELDNAME>/gi, fieldName);
        value = trim ? value.trim() : value;
        return baseChatReplace(value, null, characterName);
    }

    /**
     * Prepares text with prefix/suffix for a character field
     * @param {string} value Value to replace
     * @param {string} characterName Name of the character
     * @param {string} fieldName Name of the field
     * @param {function(string): string} [preprocess] Preprocess function
     * @returns {string} Prepared text
     */
    function replaceAndPrepareForJoin(value, characterName, fieldName, preprocess = null) {
        value = value?.trim() ?? '';
        if (!value) return '';
        if (typeof preprocess === 'function') {
            value = preprocess(value);
        }
        const prefix = customTransform(group.generation_mode_join_prefix, fieldName, characterName, false);
        const suffix = customTransform(group.generation_mode_join_suffix, fieldName, characterName, false);
        value = customTransform(value, fieldName, characterName, true);
        return `${ensemble ? `${characterName}:\n` : ''}${prefix}${value}${suffix}`;
    }

    /**
     * Collects and joins field values from all group members
     * @param {string} fieldName Display name of the field
     * @param {function(Character): string} getter Function to get field value from character
     * @param {function(string): string} [preprocess] Optional preprocess function
     * @returns {string} Combined field values
     */
    function collectField(fieldName, getter, preprocess = null) {
        const values = [];
        for (const member of group.members) {
            if (ensemble && !ensemble.members.some(speaker => speaker.avatar === member)) continue;
            const index = characters.findIndex(x => x.avatar === member);
            const character = characters[index];
            if (index === -1 || !character) continue;
            if (group.disabled_members.includes(member) && characterId !== index && group.generation_mode !== group_generation_mode.APPEND_DISABLED) {
                continue;
            }
            values.push(replaceAndPrepareForJoin(getter(character), character.name, fieldName, preprocess));
        }
        return values.filter(x => x.length).join('\n');
    }

    const scenarioOverride = String(chat_metadata.scenario || '');
    const mesExamplesOverride = String(chat_metadata.mes_example || '');

    return createLazyFields({
        description: () => collectField('Description', c => c.description),
        personality: () => collectField('Personality', c => c.personality),
        scenario: () => baseChatReplace(scenarioOverride?.trim()) || collectField('Scenario', c => c.scenario),
        mesExamples: () => baseChatReplace(mesExamplesOverride?.trim()) ||
            collectField('Example Messages', c => c.mes_example, x => !x.startsWith('<START>') ? `<START>\n${x}` : x),
    });
}

function resetSelectedGroup() {
    selected_group = null;
    is_group_generating = false;
}

function cloneGroupChatSavePayload(chatData) {
    ensureMewmoryMessageIds(chatData, uuidv4);
    return structuredClone(chatData);
}

function applyQueuedGroupChatIntegrity(metadata, chatId, isActiveGroupChatSave) {
    if (isActiveGroupChatSave && typeof chat_metadata.integrity === 'string' && chat_metadata.integrity) {
        metadata.integrity = chat_metadata.integrity;
        return;
    }

    const queuedIntegrity = chatId ? queuedGroupChatIntegrityByFile.get(chatId) : undefined;
    if (typeof queuedIntegrity === 'string' && queuedIntegrity) {
        metadata.integrity = queuedIntegrity;
    }
}

function rememberQueuedGroupChatIntegrity(chatId, integrity) {
    if (chatId && typeof integrity === 'string' && integrity) {
        queuedGroupChatIntegrityByFile.set(chatId, integrity);
    }
}

/**
 * Saves a group chat to the server.
 * @param {string} groupId Group ID
 * @param {boolean} shouldSaveGroup Whether to save the group after saving the chat
 * @param {boolean} force Force the saving on integrity error
 * @param {boolean} throwOnError Rethrow save errors after notifying the user
 * @param {object} [options] Additional save options
 * @param {boolean} [options.deferBackup] Save chat data without creating a regular chat backup yet
 * @returns {Promise<boolean>} A promise that resolves when the group chat has been saved.
 */
function saveGroupChat(groupId, shouldSaveGroup, force = false, throwOnError = false, options = {}) {
    const group = groups.find(x => x.id == groupId);
    if (!group) {
        console.warn('Group not found', groupId);
        return Promise.resolve(false);
    }

    const chatSnapshot = cloneGroupChatSavePayload(chat);
    const metadataSnapshot = structuredClone(chat_metadata);
    const chatIdSnapshot = group.chat_id;
    const currentGeneration = getChatGeneration();
    options = getChatBackupSaveOptions(options, JSON.stringify([groupId, chatIdSnapshot, currentGeneration]), uuidv4);
    const account = options.account ?? getCurrentUserHandle();
    let roleplaySave;
    try {
        roleplaySave = beginRoleplaySave({ group: true, chat: String(chatIdSnapshot) }, { operationKey: uuidv4(), owner: account });
    } catch (error) {
        console.error(error);
        toastr.error(t`Could not reach the server, so your changes may not be saved. Check your connection, then reload the page to avoid losing them.`, t`Group Chat could not be saved`);
        return throwOnError ? Promise.reject(error) : Promise.resolve(false);
    }
    const saveTask = groupChatSaveQueue
        .catch(error => console.warn('Previous group chat save failed before queued save.', error))
        .then(() => saveGroupChatImmediately({
            groupId,
            shouldSaveGroup,
            force,
            throwOnError,
            chatId: chatIdSnapshot,
            chatData: chatSnapshot,
            metadata: metadataSnapshot,
            deferBackup: Boolean(options.deferBackup),
            deferSequenceId: options.deferSequenceId,
            allowShrink: Boolean(options.allowShrink),
            mewmoryHidePolicy: options.mewmoryHidePolicy,
            onMewmoryHideSaved: options.onMewmoryHideSaved,
            scheduledGeneration: currentGeneration,
            account,
            roleplaySave,
        }))
        .finally(() => finishRoleplaySave(roleplaySave));

    groupChatSaveQueue = saveTask.catch(() => {});
    return saveTask;
}

/**
 * Waits for saves already queued on the serial group chat save queue to settle.
 * Neconyan: group saves run on their own queue, so navigation has to drain it separately.
 * @returns {Promise<void>}
 */
export async function waitForQueuedGroupChatSaves() {
    for (let attempt = 0; attempt < 5; attempt++) {
        const queue = groupChatSaveQueue;
        await queue.catch(() => {});
        if (queue === groupChatSaveQueue) {
            return;
        }
    }
}

async function saveGroupChatImmediately({ groupId, shouldSaveGroup, force = false, throwOnError = false, chatId, chatData, metadata, deferBackup = false, deferSequenceId, allowShrink = false, scheduledGeneration, account, roleplaySave, mewmoryHidePolicy, onMewmoryHideSaved }) {
    if (account !== undefined && account !== getCurrentUserHandle()) return false;
    const group = groups.find(x => x.id == groupId);
    if (!group) {
        console.warn('Group not found', groupId);
        return false;
    }

    // Neconyan: abort saves whose identity or generation changed while queued to prevent chat cloning.
    const abortReason = getQueuedChatSaveAbortReason({
        scheduledGroupId: groupId,
        currentGroupId: selected_group,
        scheduledChatId: chatId,
        currentChatId: group.chat_id,
        scheduledGeneration,
        currentGeneration: getChatGeneration(),
    });

    if (abortReason) {
        console.warn(`saveGroupChatImmediately aborted, but ${abortReason} changed while queued.`);
        return false;
    }

    if (chatId && Array.isArray(group.chats) && !group.chats.includes(chatId)) {
        group.chats.push(chatId);
        shouldSaveGroup = true;
    }
    group.date_last_chat = Date.now();
    const isActiveGroupChatSave = selected_group === groupId && group.chat_id === chatId;
    const metadataForSave = structuredClone(metadata || chat_metadata);
    applyQueuedGroupChatIntegrity(metadataForSave, chatId, isActiveGroupChatSave);
    /** @type {ChatHeader} */
    const chatHeader = {
        chat_metadata: metadataForSave,
        user_name: 'unused',
        character_name: 'unused',
    };
    const chatMessages = Array.isArray(chatData) ? chatData : cloneGroupChatSavePayload(chat);
    const response = await saveRoleplayChatRequest(roleplaySave, {
        id: chatId, chat: [chatHeader, ...chatMessages], force: force,
        deferBackup: Boolean(deferBackup), deferSequenceId, allowShrink: Boolean(allowShrink),
        ...(mewmoryHidePolicy ? { mewmoryHidePolicy } : {}),
    });

    if (!response.ok) {
        const errorData = response.data;
        const isIntegrityError = errorData?.error === 'integrity' && !force
            && (errorData.roleplay?.source || Number.isSafeInteger(errorData.roleplay?.vacancy));
        if (!isIntegrityError) {
            toastr.error(roleplaySaveNotice(errorData) || t`Could not reach the server, so your changes may not be saved. Check your connection, then reload the page to avoid losing them.`, t`Group Chat could not be saved`);
            console.error('Group chat could not be saved', response);
            if (throwOnError) {
                throw new Error('Group chat could not be saved');
            }
            return false;
        }

        const popupResult = await Popup.show.input(
            t`ERROR: Chat integrity check failed while saving the file.`,
            t`<p>After you click OK, the page will be reloaded to prevent data corruption.</p>
              <p>To confirm an overwrite (and potentially <b>LOSE YOUR DATA</b>), enter <code>OVERWRITE</code> (in all caps) in the box below before clicking OK.</p>`,
            '',
            { okButton: 'OK', cancelButton: false },
        );

        const forceSaveConfirmed = popupResult === 'OVERWRITE';

        if (!forceSaveConfirmed) {
            console.warn('Chat integrity check failed, and user did not confirm the overwrite. Reloading the page.');
            window.location.reload();
            return false;
        }

        confirmRoleplayOverwrite(roleplaySave, uuidv4());
        return await saveGroupChatImmediately({ groupId, shouldSaveGroup, force: true, throwOnError, chatId, chatData: chatMessages, metadata: metadataForSave, deferBackup, deferSequenceId, allowShrink, scheduledGeneration, account, roleplaySave, mewmoryHidePolicy, onMewmoryHideSaved });
    }

    const responseData = response.data;
    if (account !== undefined && account !== getCurrentUserHandle()) return false;
    rememberQueuedGroupChatIntegrity(chatId, responseData?.integrity);
    if (isActiveGroupChatSave && typeof responseData?.integrity === 'string' && responseData.integrity) {
        chat_metadata.integrity = responseData.integrity;
    }
    if (mewmoryHidePolicy) {
        try {
            onMewmoryHideSaved?.(responseData);
        } catch (error) {
            console.warn('Mewmory hide result callback failed after the group chat was saved.', error);
        }
    }

    if (shouldSaveGroup) {
        // Neconyan: strict saves cannot acknowledge deferred group metadata writes.
        if (throwOnError && !groups.some(candidate => candidate.id === group.id)) {
            throw new Error('Group not found');
        }
        await editGroup(throwOnError ? group.id : groupId, throwOnError, false, account);
    }

    return true;
}

/**
 * Renames a group member across all groups and their chats.
 * @param {string} oldAvatar Old avatar name
 * @param {string} newAvatar New avatar name
 * @param {string} newName New character name
 */
export async function renameGroupMember(oldAvatar, newAvatar, newName) {
    // Scan every group for our renamed character
    for (const group of groups) {
        try {
            // Try finding the member by old avatar link
            const memberIndex = group.members.findIndex(x => x == oldAvatar);

            // Character was not present in the group...
            if (memberIndex == -1) {
                continue;
            }

            // Replace group member avatar id and save the changes
            group.members[memberIndex] = newAvatar;
            await editGroup(group.id, true, false, getCurrentUserHandle(), { background: true,
                backgroundChanges: { memberRename: { from: oldAvatar, to: newAvatar } } });
            console.log(`Renamed character ${newName} in group: ${group.name}`);

            // Load all chats from this group
            for (const chatId of group.chats) {
                const { records: messages, evidence } = await loadGroupChat(chatId);

                // Only save the chat if there were any changes to the chat content
                let hadChanges = false;
                // Chat shouldn't be empty
                if (Array.isArray(messages) && messages.length) {
                    // Iterate over every chat message
                    for (const message of messages) {
                        // Skip the chat header
                        if (Object.hasOwn(message, 'chat_metadata')) {
                            continue;
                        }

                        // Only look at character messages
                        if (message.is_user || message.is_system) {
                            continue;
                        }

                        // Message belonged to the old-named character:
                        // Update name, avatar thumbnail URL and original avatar link
                        if (message.force_avatar && message.force_avatar.indexOf(encodeURIComponent(oldAvatar)) !== -1) {
                            message.name = newName;
                            message.force_avatar = message.force_avatar.replace(encodeURIComponent(oldAvatar), encodeURIComponent(newAvatar));
                            message.original_avatar = newAvatar;
                            hadChanges = true;
                        }
                    }

                    if (hadChanges) {
                        await eventSource.emit(event_types.CHARACTER_RENAMED_IN_PAST_CHAT, messages, oldAvatar, newAvatar);

                        const token = beginRoleplaySave({ group: true, chat: String(chatId) }, { operationKey: uuidv4(), evidence });
                        try {
                            const saved = await saveRoleplayChatRequest(token, { id: chatId, chat: [...messages] });
                            if (!saved.ok) throw new Error('Group member could not be renamed');
                        } finally {
                            await finishRoleplaySave(token);
                        }

                        console.log(`Renamed character ${newName} in group chat: ${chatId}`);
                    }
                }
            }
        } catch (error) {
            console.log(`An error during renaming the character ${newName} in group: ${group.name}`);
            console.error(error);
        }
    }
}

/**
 * Fetches all groups from the server and processes them.
 */
async function getGroups() {
    const readGeneration = ++groupListReadGeneration;
    const account = roleplayAccountStamp();
    const started = new Map(groups.map(group => [group.id, { group, revision: groupSaveStates.get(group.id)?.revision,
        evidence: groupReadEvidence.get(group), background: groupBackgroundState.get(group) }]));
    const response = await fetch('/api/groups/all', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        try {
            if (readGeneration !== groupListReadGeneration || getCurrentUserHandle() !== account.owner
                || roleplayAccountStamp() !== account) return;
        } catch { return; }
        toastr.error(roleplayLoadErrorMessage({ code: error.code ?? error.error }));
        return;
    }

    if (response.ok) {
        /** @type {Group[]} */
        const data = await response.json();
        try {
            if (readGeneration !== groupListReadGeneration || getCurrentUserHandle() !== account.owner
                || roleplayAccountStamp() !== account) return;
        } catch { return; }
        const previous = groups;
        const applied = [];

        // Convert groups to new format
        for (const group of data) {
            const read = group.__roleplay;
            delete group.__roleplay;
            if (typeof group.id === 'number') {
                group.id = String(group.id);
            }
            if (group.disabled_members == undefined) {
                group.disabled_members = [];
            }
            if (group.chat_id == undefined) {
                group.chat_id = group.id;
                group.chats = [group.id];
                group.members = group.members
                    .map(x => characters.find(y => y.name == x)?.avatar)
                    .filter(x => x)
                    .filter(onlyUnique);
            }
            if (typeof group.chat_id === 'number') {
                group.chat_id = String(group.chat_id);
            }
            if (Array.isArray(group.chats) && group.chats.some(x => typeof x === 'number')) {
                group.chats = group.chats.map(x => String(x));
            }
            const current = previous.find(item => item.id === group.id);
            const atStart = started.get(group.id);
            const saveState = groupSaveStates.get(group.id);
            if (current && (current !== atStart?.group || saveState?.revision !== atStart?.revision
                || (saveState && saveState.status !== 'saved') || groupReadEvidence.get(current) !== atStart?.evidence
                || groupBackgroundState.get(current) !== atStart?.background || groupBackgroundState.get(current)?.failed)) {
                applied.push(current);
                continue;
            }
            if (!read || read.locator?.kind !== 'group' || read.locator.groupId !== group.id
                || !rememberRoleplayRead(read.locator, read)) {
                if (current) applied.push(current);
                continue;
            }
            const evidence = { account: read.account, source: read.source };
            groupReadEvidence.set(group, evidence);
            groupBackgroundState.set(group, { evidence, contents: snapshotGroupMetadata(group), failed: false });
            applied.push(group);
        }
        groups = applied;
    }
}

/**
 * Gets a group UI block for the list.
 * @param {Group} group Group object
 * @returns {JQuery<HTMLElement>} jQuery element representing the group block
 */
export function getGroupBlock(group) {
    let count = 0;
    let namesList = [];

    // Build inline name list
    if (Array.isArray(group.members) && group.members.length) {
        for (const member of group.members) {
            const character = characters.find(x => x.avatar === member || x.name === member);
            if (character) {
                namesList.push(character.name);
                count++;
            }
        }
    }

    const template = $('#group_list_template .group_select').clone();
    template.data('id', group.id);
    template.attr({ 'data-grid': group.id, 'data-chid': group.id });
    template.find('.ch_name').text(group.name).attr('title', `[Group] ${group.name}`);
    template.find('.group_fav_icon').css('display', 'none');
    template.addClass(group.fav ? 'is_fav' : '');
    template.toggleClass('is-active-entity', String(selected_group) === String(group.id));
    template.find('.ch_fav').val(String(group.fav));
    template.find('.group_select_counter').text(count + ' ' + (count != 1 ? t`characters` : t`character`));
    template.find('.group_select_block_list').text(namesList.join(', '));
    const isCurrentChat = String(selected_group) === String(group.id);
    template.find('.group_current_chat').toggle(isCurrentChat);
    template.toggleClass('is-current-chat', isCurrentChat);
    template.attr('aria-current', isCurrentChat ? 'page' : null);
    // Preserve names when the localiser revisits translated captions.
    template.find('[data-entity-action="open-chat"]').attr('aria-label', t`Open ${group.name}`).attr('data-i18n-ignore', '');
    template.find('[data-entity-action="edit-group"]').attr('aria-label', t`Edit ${group.name}`).attr('data-i18n-ignore', '');

    // Display inline tags
    const tagsElement = template.find('.tags');
    printTagList(tagsElement, { forEntityOrKey: group.id, tagOptions: { isCharacterList: true } });

    const avatar = getGroupAvatar(group);
    if (avatar) {
        $(template).find('.avatar').replaceWith(avatar);
    }

    return template;
}

/**
 * Updates the avatar display for a given group.
 * @param {Group} group Group object
 */
function updateGroupAvatar(group) {
    $('#group_avatar_preview').empty().append(getGroupAvatar(group));

    $('.group_select').each(function () {
        if ($(this).data('id') == group.id) {
            $(this).find('.avatar').replaceWith(getGroupAvatar(group));
        }
    });

    favsToHotswap();
}

/**
 * Checks if a URL is a valid image URL.
 * @param {string} url URL to check
 * @returns {boolean} True if valid, false otherwise
 */
function isValidImageUrl(url) {
    // check if empty dict
    if (!url || Object.keys(url).length === 0) {
        return false;
    }
    return isDataURL(url) || (url && (url.startsWith('user') || url.startsWith('/user')));
}

/**
 * Gets a group avatar element.
 * @param {Group} group Group object
 * @returns {JQuery<HTMLElement>} Group avatar element
 */
function getGroupAvatar(group) {
    if (!group) {
        return $(`<div class="avatar"><img src="${default_avatar}"></div>`);
    }
    // if isDataURL or if it's a valid local file url
    if (isValidImageUrl(group.avatar_url)) {
        return $(`<div class="avatar" title="[Group] ${group.name}"><img src="${group.avatar_url}"></div>`);
    }

    const memberAvatars = [];
    if (group && Array.isArray(group.members) && group.members.length) {
        for (const member of group.members) {
            const charIndex = characters.findIndex(x => x.avatar === member);
            if (charIndex !== -1 && characters[charIndex].avatar !== 'none') {
                const avatar = getThumbnailUrl('avatar', characters[charIndex].avatar);
                memberAvatars.push(avatar);
            }
            if (memberAvatars.length === 4) {
                break;
            }
        }
    }

    const avatarCount = memberAvatars.length;

    if (avatarCount >= 1 && avatarCount <= 4) {
        const groupAvatar = $(`#group_avatars_template .collage_${avatarCount}`).clone();

        for (let i = 0; i < avatarCount; i++) {
            groupAvatar.find(`.img_${i + 1}`).attr({
                src: memberAvatars[i],
                loading: 'lazy',
                decoding: 'async',
            });
        }

        groupAvatar.attr('title', `[Group] ${group.name}`);
        return groupAvatar;
    }

    // catch edge case where group had one member and that member is deleted
    if (avatarCount === 0) {
        return $('<div class="missing-avatar fa-solid fa-user-slash"></div>');
    }

    // default avatar
    const groupAvatar = $('#group_avatars_template .collage_1').clone();
    groupAvatar.find('.img_1').attr({
        src: group.avatar_url || system_avatar,
        loading: 'lazy',
        decoding: 'async',
    });
    groupAvatar.attr('title', `[Group] ${group.name}`);
    return groupAvatar;
}

/**
 * Gets chat IDs for a group.
 * @param {string} groupId Group ID
 * @returns {string[]} Array of chat IDs
 */
function getGroupChatNames(groupId) {
    const group = groups.find(x => x.id === groupId);

    if (!group) {
        return [];
    }

    const names = [];
    for (const chatId of group.chats) {
        names.push(chatId);
    }
    return names;
}

/**
 * Tells the user a server-run group turn did not start. An image refusal has already raised its own notice
 * (see postSubmission in roleplay-workflows.js), so it gets no second, generic toast. An error whose text this feature
 * already put into the reader's language is marked, so the run-time localiser cannot match it again.
 * @param {any} error The failure
 */
function reportGroupReplyFailure(error) {
    console.error('Group reply failed', error);
    if (isImageInputIssue(error)) return;
    const shown = toastr.error(error?.message || t`The group reply could not start. Please try again.`, t`Group reply failed`);
    if (error?.localized === true) shown?.find?.('.toast-message, .toast-title').attr('data-i18n-ignore', '');
}

/**
 * Generates text for the group chat by queueing members according to the activation strategy.
 * @param {boolean} byAutoMode If the generation was triggered programmatically.
 * @param {string?} type Generation type
 * @param {object} params Additional Generate parameters
 * @returns {Promise<string|void>} Generated text or nothing if no generation occurred
 */
async function generateGroupWrapper(byAutoMode, type = null, params = {}) {
    function throwIfAborted() {
        if (params.signal instanceof AbortSignal && params.signal.aborted) {
            throw new Error('AbortSignal was fired. Group generation stopped');
        }
    }

    if (online_status === 'no_connection') {
        is_group_generating = false;
        setSendButtonState(false);
        return Promise.resolve();
    }

    if (is_group_generating) {
        return Promise.resolve();
    }

    // Auto-navigate back to group menu
    if (menu_type !== 'group_edit') {
        select_group_chats(selected_group, false);
        if (typeof document === 'undefined' || (document.hidden !== true && document.visibilityState !== 'hidden')) {
            await delay(1);
        }
    }

    /** @type {any} Caution: JS war crimes ahead */
    let textResult = '';
    const group = groups.find((x) => x.id === selected_group);

    if (!group || !Array.isArray(group.members) || !group.members.length) {
        sendSystemMessage(system_message_types.EMPTY, '', { isSmallSys: true });
        return Promise.resolve();
    }

    const restoreAudience = beginGroupTurnAudience(type);
    try {
        throwIfAborted();
        hideSwipeButtons();
        is_group_generating = true;
        setSendButtonState(true);
        setCharacterName('');
        setCharacterId(undefined);
        const userInput = params.suppressUserMessage ? '' : String($('#send_textarea').val());

        // id of this specific batch for regeneration purposes
        group_generation_id = Date.now();
        const lastMessage = chat[chat.length - 1];
        let activationText = '';
        let isUserInput = false;

        if (userInput?.length && !byAutoMode) {
            isUserInput = true;
            activationText = userInput;
        } else {
            if (lastMessage && !lastMessage.is_system) {
                activationText = lastMessage.mes;
            }
        }

        const activationStrategy = Number(group.activation_strategy ?? group_activation_strategy.NATURAL);
        const whisperTargets = getGroupMessageAudience()?.whisper_to || [];
        const enabledMembers = getGroupEnabledMembers(group).filter(avatar => !whisperTargets.length || whisperTargets.includes(avatar));
        if ((whisperTargets.length && !enabledMembers.length)
            || (!['swipe', 'continue'].includes(type) && chat_metadata.group_scene?.whisper_to?.length && !whisperTargets.length)) {
            toastr.warning(t`Your whisper recipient is unavailable. Choose someone present or switch to everyone.`);
            return;
        }
        let activatedMembers = [];

        const selectedSpeakerChid = getSelectedGroupSpeakerChid(group);
        const addressedMemberChid = activeGroupTalkBurst && !isUserInput ? -1 : findDirectlyAddressedMember(group, activationText);
        const isWholeGroupAddress = isAddressedToEntireGroup(activationText);
        let useSceneDirector = false;
        let directorNote = '';
        if (whisperTargets.length && !['swipe', 'continue', 'quiet', 'impersonate'].includes(type)) {
            activatedMembers = enabledMembers.map(avatar => getCharacterIdByAvatar(avatar)).filter(chid => chid !== -1);
        } else if (params && Array.isArray(params.force_chids)) {
            activatedMembers = params.force_chids;
        } else if (params && typeof params.force_chid == 'number') {
            activatedMembers = [params.force_chid];
        } else if (!['quiet', 'swipe', 'continue', 'impersonate'].includes(type) && isWholeGroupAddress && isUserInput) {
            activatedMembers = enabledMembers.map(avatar => getCharacterIdByAvatar(avatar)).filter(chid => chid !== -1);
        } else if (!['quiet', 'swipe', 'continue', 'impersonate'].includes(type) && addressedMemberChid !== -1) {
            activatedMembers = [addressedMemberChid];
        } else if (!['quiet', 'swipe', 'continue', 'impersonate'].includes(type) && selectedSpeakerChid !== -1) {
            activatedMembers = [selectedSpeakerChid];
        } else if (type === 'quiet') {
            activatedMembers = activateSwipe(enabledMembers, { allowSystem: true }).slice(0, 1);

            if (activatedMembers.length === 0) {
                activatedMembers = activateListOrder(enabledMembers.slice(0, 1));
            }
        } else if (type === 'swipe' || type === 'continue') {
            activatedMembers = activateSwipe(enabledMembers, { allowSystem: false });

            if (activatedMembers.length === 0) {
                toastr.warning(t`Deleted group member swiped. To get a reply, add them back to the group.`);
                throw new Error('Deleted group member swiped');
            }
        } else if (type === 'impersonate') {
            activatedMembers = activateImpersonate(enabledMembers);
        } else if (activationStrategy === group_activation_strategy.NATURAL || activationStrategy === group_activation_strategy.DIRECTOR) {
            useSceneDirector = activationStrategy === group_activation_strategy.DIRECTOR;
            activatedMembers = activateNaturalOrder(enabledMembers, activationText, lastMessage, group.allow_self_responses, isUserInput);
        } else if (activationStrategy === group_activation_strategy.LIST && activeGroupTalkBurst && !isUserInput) {
            activatedMembers = activateListOrder([pickNextListSpeaker(enabledMembers, lastMessage?.original_avatar || '')]);
        } else if (activationStrategy === group_activation_strategy.LIST) {
            activatedMembers = activateListOrder(enabledMembers);
        } else if (activationStrategy === group_activation_strategy.POOLED) {
            activatedMembers = activatePooledOrder(enabledMembers, lastMessage, isUserInput);
        } else if (activationStrategy === group_activation_strategy.MANUAL && !isUserInput) {
            activatedMembers = shuffle(enabledMembers).slice(0, 1).map(x => characters.findIndex(y => y.avatar === x)).filter(x => x !== -1);
        }

        const canUseMultiSpeakerTurn = (params && Array.isArray(params.force_chids)) || (isWholeGroupAddress && isUserInput);
        const shouldForceSingleSpeaker = !canUseMultiSpeakerTurn && !['quiet', 'swipe', 'continue', 'impersonate'].includes(type);
        activatedMembers = limitGroupSpeakersForControl(activatedMembers, shouldForceSingleSpeaker);
        const shouldRenderUserMessage = Boolean(userInput) && !byAutoMode && !['quiet', 'swipe', 'continue', 'impersonate'].includes(type);
        let didRenderUserMessage = false;

        if (shouldRenderUserMessage) {
            if (activatedMembers.length > 0) {
                setCharacterId(activatedMembers[0]);
            }

            const bias = getBiasStrings(userInput, type);
            if (bias.messageBias && !userInput.replace(/\{\{[\s\S]*?\}\}/gm, '').trim()) {
                sendSystemMessage(system_message_types.GENERIC, ' ', { bias: bias.messageBias });
            } else {
                await sendMessageAsUser(userInput, bias.messageBias);
            }
            didRenderUserMessage = true;
            $('#send_textarea').val('')[0].dispatchEvent(new Event('input', { bubbles: true }));
        }

        if (useSceneDirector) {
            setGroupDirectorChoosingIndicator(true);
            await unshallowGroupMembers(selected_group);
            const burst = activeGroupTalkBurst && !isUserInput ? activeGroupTalkBurst : null;
            const directed = await runGroupSceneDirector(group, enabledMembers, {
                signal: params?.signal ?? null,
                maxSpeakers: burst ? Math.max(1, Math.min(GROUP_DIRECTOR_MAX_SPEAKERS, burst.remaining)) : GROUP_DIRECTOR_MAX_SPEAKERS,
                continuing: Boolean(burst),
            });
            setGroupDirectorChoosingIndicator(false);
            throwIfAborted();
            if (directed) {
                activatedMembers = directed.chids;
                directorNote = directed.reason;
                updateGroupNextUp(directed);
                if (!directed.chids.length) {
                    toastr.info(directed.reason || t`The scene is waiting for you.`, t`Waiting for you`);
                }
            } else if (groupDirectorFailure) {
                directorNote = t`usual order, the Scene Director did not choose`;
                updateGroupNextUp({ chids: [], reason: '', fallback: groupDirectorFailure });
                notifyGroupDirectorFallback(groupDirectorFailure);
            }
        }

        activatedMembers = activatedMembers.filter(chid => enabledMembers.includes(characters[chid]?.avatar));
        if (activatedMembers.length === 0) {
            return Promise.resolve();
        }

        const ensembleTurn = group.ensemble_replies === true && activatedMembers.length > 1
            && !['quiet', 'swipe', 'continue', 'impersonate'].includes(type);
        // Scene-specific turns use the browser's prompt and visibility rules.
        const ordinaryTurn = !ensembleTurn && !usesGroupSceneVisibility() && activationStrategy !== group_activation_strategy.DIRECTOR
            && !activatedMembers.some(chid => getGroupMemberRole(group, characters[chid]) === 'narrator')
            && !['quiet', 'swipe', 'continue', 'impersonate'].includes(type) && !params?.quiet_prompt && getCurrentChatId();
        const automaticRouting = ordinaryTurn && params?.skipNativeRoleplay === undefined;
        const routing = automaticRouting ? await import('./browser-reply-routing.js') : null;
        const preferServer = routing?.prefersServerReplies() === true;
        let serverRequired = Boolean(routing) && !preferServer && await routing.requiresServerReply(activatedMembers);
        let serverRequirementKnown = Boolean(routing) && !preferServer;
        // A preferred server turn may fall back to the browser only when no
        // Notebook context needs the server's prompt. Probe only on that fallback.
        const serverMustOwn = async () => {
            if (serverRequired || !preferServer) return serverRequired;
            if (!serverRequirementKnown) {
                serverRequired = await routing.requiresServerReply(activatedMembers);
                serverRequirementKnown = true;
            }
            return serverRequired;
        };
        let groupWorkflows = null;
        let forcedAvatars = [];
        let groupReady = false;
        if (ordinaryTurn && (params?.skipNativeRoleplay === false || preferServer || serverRequired)) {
            groupWorkflows = await import('./neconyan-conversation/roleplay-workflows.js');
            const { roleplayAccountStamp } = await import('./roleplay-save-chain.js');
            let ready = true;
            try { roleplayAccountStamp(); } catch { ready = false; }
            forcedAvatars = activatedMembers.map(chid => characters[chid]?.avatar).filter(Boolean);
            groupReady = ready && forcedAvatars.length === activatedMembers.length;
            // Explicit server callers keep their existing path. Automatic routing
            // must not lose page instructions the group server payload cannot carry.
            if (automaticRouting && groupReady && await groupWorkflows.groupPagePromptsBlocked()) {
                if (await serverMustOwn()) {
                    throw new Error('The selected Notebook context cannot be combined with these page prompts. Nothing was generated.');
                }
                groupReady = false;
            }
        }
        throwIfAborted();
        const useGroupServer = ordinaryTurn && groupReady
            && (params?.skipNativeRoleplay === false || preferServer || serverRequired);
        if (useGroupServer) {
            deactivateSendButtons();
            setGroupTypingIndicator(characters[activatedMembers[0]]?.name || '');
            await eventSource.emit(event_types.GROUP_WRAPPER_STARTED, { selected_group, type, nativeRoleplay: true });
            try {
                textResult = await groupWorkflows.submitRoleplayGroupTurn({ groupId: selected_group, forcedAvatars,
                    generationId: group_generation_id, signal: params?.signal ?? null });
            } catch (error) {
                if (!params?.signal?.aborted && error?.name !== 'AbortError') reportGroupReplyFailure(error);
                throw error;
            }
            if (selectedSpeakerChid !== -1 && !(params && typeof params.force_chid == 'number')) {
                clearSelectedGroupSpeaker();
            }
            return Promise.resolve(textResult);
        }
        if (automaticRouting && (preferServer || serverRequired) && await serverMustOwn()) {
            throw new Error('The selected Notebook context needs a server reply. Please reload and try again.');
        }

        await unshallowGroupMembers(selected_group);
        groupChatQueueOrder = new Map();

        if (power_user.show_group_chat_queue) {
            for (let i = 0; i < activatedMembers.length; ++i) {
                groupChatQueueOrder.set(characters[activatedMembers[i]].avatar, i + 1);
            }
        }
        await eventSource.emit(event_types.GROUP_WRAPPER_STARTED, { selected_group, type });
        if (ensembleTurn) {
            textResult = await generateGroupEnsemble(group, activatedMembers, { ...params, suppressUserMessage: didRenderUserMessage || params.suppressUserMessage });
            clearSelectedGroupSpeaker();
            return textResult;
        }
        // now the real generation begins: cycle through every activated character
        for (const chId of activatedMembers) {
            throwIfAborted();
            deactivateSendButtons();
            setCharacterId(chId);
            setCharacterName(characters[chId].name);
            setGroupTypingIndicator(characters[chId].name, directorNote);
            if (power_user.show_group_chat_queue) {
                printGroupMembers();
            }
            await eventSource.emit(event_types.GROUP_MEMBER_DRAFTED, chId);

            // Wait for generation to finish
            const generateType = ['swipe', 'impersonate', 'quiet', 'continue'].includes(type) ? type : 'normal';
            const speakerName = characters[chId]?.name || 'the selected speaker';
            const contextPrompt = getGroupMemberRole(group, characters[chId]) === 'narrator' ? buildNarratorReminder(name1) : buildContextAwareGroupPrompt(speakerName, {
                targetName: addressedMemberChid === chId ? getMessageSpeakerName(lastMessage) : '',
                ownLines: isKeepOwnLinesEnabled(group),
                otherNames: getOtherMemberNames(getGroupNames(), speakerName),
                userName: name1,
            });
            const mergedParams = { ...(params || {}) };
            mergedParams.quiet_prompt = [mergedParams.quiet_prompt, contextPrompt, getGroupScenePrompt(group)].filter(Boolean).join('\n');
            mergedParams.quietToLoud = true;
            mergedParams.suppressUserMessage = didRenderUserMessage || mergedParams.suppressUserMessage;
            textResult = await runWithGroupScene([characters[chId].avatar], () => runWithGroupMemberModelOverride(group, characters[chId]?.avatar, () => Generate(generateType, { automatic_trigger: byAutoMode, ...mergedParams })));
            if (textResult?.generationOutcome) break;
            let messageChunk = textResult?.messageChunk;

            if (messageChunk) {
                while (shouldAutoContinue(messageChunk, type === 'impersonate', mergedParams)) {
                    textResult = await runWithGroupScene([characters[chId].avatar], () => runWithGroupMemberModelOverride(group, characters[chId]?.avatar, () => Generate('continue', { automatic_trigger: byAutoMode, ...mergedParams, companionHistoryTarget: undefined })));
                    if (textResult?.generationOutcome) break;
                    messageChunk = textResult?.messageChunk;
                }
            }

            if (textResult?.generationOutcome) break;
            if (power_user.show_group_chat_queue) {
                groupChatQueueOrder.delete(characters[chId].avatar);
                groupChatQueueOrder.forEach((value, key, map) => map.set(key, value - 1));
            }
            setGroupTypingIndicator('');
        }

        if (selectedSpeakerChid !== -1 && !(params && typeof params.force_chid == 'number')) {
            clearSelectedGroupSpeaker();
        }
    } finally {
        restoreAudience();
        setGroupTypingIndicator('');
        is_group_generating = false;
        setSendButtonState(false);
        setCharacterId(undefined);
        if (power_user.show_group_chat_queue) {
            groupChatQueueOrder = new Map();
            printGroupMembers();
        }
        setCharacterName('');
        activateSendButtons();
        showSwipeButtons();
        await eventSource.emit(event_types.GROUP_WRAPPER_FINISHED, { selected_group, type });
    }

    return Promise.resolve(textResult);
}

async function generateGroupEnsemble(group, chids, params) {
    const scope = { groupId: group.id, chatId: getCurrentChatId(), generation: getChatGeneration(),
        members: chids.map(chid => ({ name: characters[chid].name, avatar: characters[chid].avatar })) };
    const before = chat.length;
    activeGroupEnsemble = scope;
    deactivateSendButtons();
    setCharacterId(chids[0]);
    setCharacterName('Narrator');
    setGroupTypingIndicator(scope.members.map(member => member.name).join(', '));
    try {
        await eventSource.emit(event_types.GROUP_MEMBER_DRAFTED, chids[0]);
        return await runWithGroupScene(scope.members.map(member => member.avatar), () => Generate('normal', { ...params, skipNativeRoleplay: true, suppressAutoContinue: true, quietToLoud: true,
            quiet_prompt: [params.quiet_prompt, buildEnsemblePrompt(scope.members.map(member => member.name), name1), getGroupScenePrompt(group)].filter(Boolean).join('\n') }));
    } finally {
        activeGroupEnsemble = null;
        // Keep completed output even when an after-reply Agent or cancellation interrupts the call.
        if (selected_group === scope.groupId && getCurrentChatId() === scope.chatId && getChatGeneration() === scope.generation) {
            const index = chat.findIndex((message, i) => i >= before && !message.is_user && !message.is_system && message.extra?.gen_id === group_generation_id);
            if (index !== -1 && chat[index].mes) {
                const messages = createEnsembleMessages(chat[index], scope.members, avatar => getThumbnailUrl('avatar', avatar), system_avatar);
                chat.splice(index, 1, ...messages);
                await Promise.all([saveGroupChat(group.id, false, false, true), printMessages()]);
            }
        }
    }
}

/**
 * Gets the generation ID of the last chat message.
 * @returns {number|null} Generation ID or null
 */
function getLastMessageGenerationId() {
    let generationId = null;
    if (chat.length > 0) {
        const lastMes = chat[chat.length - 1];
        if (!lastMes.is_user && !lastMes.is_system && lastMes.extra) {
            generationId = lastMes.extra.gen_id;
        }
    }
    return generationId;
}

/**
 * Activate group chat members for 'impersonate' generation type.
 * @param {string[]} members Array of group member avatar ids
 * @returns {number[]} Array of character ids
 */
function activateImpersonate(members) {
    const randomIndex = Math.floor(Math.random() * members.length);
    const activatedMembers = [members[randomIndex]];
    const memberIds = activatedMembers
        .map((x) => characters.findIndex((y) => y.avatar === x))
        .filter((x) => x !== -1);
    return memberIds;
}

/**
 * Activates a group member based on the last message.
 * @param {string[]} members Array of group member avatar ids
 * @param {Object} [options] Options object
 * @param {boolean} [options.allowSystem] Whether to allow system messages
 * @returns {number[]} Array of character ids
 */
function activateSwipe(members, { allowSystem = false } = {}) {
    let activatedNames = [];
    const lastMessage = chat[chat.length - 1];

    if (!lastMessage) {
        return [];
    }

    if (lastMessage.is_user || (!allowSystem && lastMessage.is_system) || lastMessage.extra?.type === system_message_types.NARRATOR) {
        for (const message of chat.slice().reverse()) {
            if (message.is_user || (!allowSystem && message.is_system) || message.extra?.type === system_message_types.NARRATOR) {
                continue;
            }

            if (message.original_avatar) {
                activatedNames.push(message.original_avatar);
                break;
            }
        }

        if (activatedNames.length === 0) {
            activatedNames.push(shuffle(members.slice())[0]);
        }
    }

    // pre-update group chat swipe
    if (!lastMessage.original_avatar) {
        const matches = characters.filter(x => x.name == lastMessage.name);

        for (const match of matches) {
            if (members.includes(match.avatar)) {
                activatedNames.push(match.avatar);
                break;
            }
        }
    } else {
        activatedNames.push(lastMessage.original_avatar);
    }

    const memberIds = activatedNames
        .map((x) => characters.findIndex((y) => y.avatar === x))
        .filter((x) => x !== -1);
    return memberIds;
}

/**
 * Activate group members for the list activation order.
 * @param {string[]} members Array of group member avatar ids
 * @returns {number[]} Array of character ids
 */
function resolveCardMacros(text, characterName) {
    return String(text || '')
        .replace(/\{\{char\}\}/gi, characterName)
        .replace(/\{\{user\}\}/gi, name1 || 'User');
}

function getGroupDirectorMembers(members) {
    return members.map(avatar => {
        const chid = getCharacterIdByAvatar(avatar);
        const character = characters[chid];
        if (!character?.name) {
            return null;
        }
        const card = character.description || character.personality || '';
        return { chid, avatar, name: character.name, role: getGroupMemberRole(getSelectedGroupRecord(), character), summary: summariseMemberCard(resolveCardMacros(card, character.name)) };
    }).filter(Boolean);
}

function getGroupDirectorHistory(members) {
    return chat
        .filter(message => message && !message.is_system && !message.extra?.group_scene?.whisper_to?.length
            && members.every(avatar => canGroupMemberSee(message, avatar)) && String(message.mes || '').trim())
        .slice(-12)
        .map(message => ({ name: message.name, text: message.mes, isUser: Boolean(message.is_user) }));
}

async function requestGroupDirectorText(group, prompt, signal) {
    const profileId = String(group?.director_profile || '');
    const { ConnectionManagerRequestService } = profileId ? await import('./extensions/shared.js') : {};
    let hasProfile = false;
    try {
        hasProfile = Boolean(profileId) && ConnectionManagerRequestService.getSupportedProfiles().some(profile => profile.id === profileId);
    } catch {
        hasProfile = false;
    }
    if (hasProfile) {
        const response = await ConnectionManagerRequestService.sendRequest(profileId, prompt, GROUP_DIRECTOR_RESPONSE_TOKENS,
            { stream: false, signal, extractData: true, includePreset: false, includeInstruct: true });
        return typeof response === 'string' ? response : String(response?.content ?? '');
    }
    const data = await generateRawData({
        prompt,
        api: main_api,
        instructOverride: main_api === 'openai',
        responseLength: GROUP_DIRECTOR_RESPONSE_TOKENS,
        signal,
        cacheScope: 'auxiliary',
    });
    return String(extractMessageFromData(data, main_api, { excludeReasoning: true }) || '');
}

/**
 * Ask the scene director who speaks next. Resolves to null on a timeout, a failure or an unusable answer,
 * so the caller keeps its own pick and the reply is never held up for long.
 * @param {object} group Group record
 * @param {string[]} members Avatars of members who may speak
 * @param {object} [options]
 * @param {AbortSignal|null} [options.signal] Stop signal for the whole turn
 * @param {number} [options.maxSpeakers] Most speakers to pick
 * @param {boolean} [options.continuing] The user is listening while the characters talk among themselves
 * @returns {Promise<{chids: number[], reason: string}|null>}
 */
export async function runGroupSceneDirector(group, members, { signal = null, maxSpeakers = GROUP_DIRECTOR_MAX_SPEAKERS, continuing = false } = {}) {
    groupDirectorFailure = '';
    const entries = getGroupDirectorMembers(Array.isArray(members) ? members : []);
    if (entries.length < 2 || signal?.aborted) {
        return null;
    }
    let timedOut = false;

    const prompt = buildDirectorPrompt({ members: entries, messages: getGroupDirectorHistory(members), userName: name1, maxSpeakers, continuing });
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener?.('abort', stop, { once: true });
    let timer = null;
    const timeout = new Promise(resolve => {
        timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            resolve(null);
        }, GROUP_DIRECTOR_TIMEOUT_MS);
    });

    try {
        const text = await Promise.race([requestGroupDirectorText(group, prompt, controller.signal), timeout]);
        if (typeof text !== 'string' || controller.signal.aborted) {
            groupDirectorFailure = timedOut ? 'timeout' : '';
            return null;
        }
        const { speakers, reason, paused } = parseDirectorResponse(text, entries.map(entry => entry.name), maxSpeakers);
        const chids = speakers.map(name => entries.find(entry => entry.name === name)?.chid).filter(chid => Number.isInteger(chid));
        if (!chids.length && !paused) {
            groupDirectorFailure = 'unusable';
            console.warn('[Group director] The answer named no member, so the usual speaker choice is used.', text);
            return null;
        }
        return { chids, reason };
    } catch (error) {
        if (!signal?.aborted) {
            groupDirectorFailure = timedOut ? 'timeout' : 'error';
            console.warn('[Group director] Falling back to the usual speaker choice.', error);
        }
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', stop);
    }
}

function activateListOrder(members) {
    let activatedMembers = members.filter(onlyUnique);

    // map to character ids
    const memberIds = activatedMembers
        .map((x) => characters.findIndex((y) => y.avatar === x))
        .filter((x) => x !== -1);
    return memberIds;
}

/**
 * Activate group members based on the last message.
 * @param {string[]} members List of member avatars
 * @param {Object} lastMessage Last message
 * @param {boolean} isUserInput Whether the user has input text
 * @returns {number[]} List of character ids
 */
function activatePooledOrder(members, lastMessage, isUserInput) {
    /** @type {string} */
    let activatedMember = null;
    /** @type {string[]} */
    const spokenSinceUser = [];

    for (const message of chat.slice().reverse()) {
        if (message.is_user || isUserInput) {
            break;
        }

        if (message.is_system || message.extra?.type === system_message_types.NARRATOR) {
            continue;
        }

        if (message.original_avatar) {
            spokenSinceUser.push(message.original_avatar);
        }
    }

    const haveNotSpoken = members.filter(x => !spokenSinceUser.includes(x));

    if (haveNotSpoken.length) {
        activatedMember = haveNotSpoken[Math.floor(Math.random() * haveNotSpoken.length)];
    }

    if (activatedMember === null) {
        const lastMessageAvatar = members.length > 1 && lastMessage && !lastMessage.is_user && lastMessage.original_avatar;
        const randomPool = lastMessageAvatar ? members.filter(x => x !== lastMessage.original_avatar) : members;
        activatedMember = randomPool[Math.floor(Math.random() * randomPool.length)];
    }

    const memberId = characters.findIndex(y => y.avatar === activatedMember);
    return memberId !== -1 ? [memberId] : [];
}

/**
 * Activate group members for the natural activation order.
 * @param {string[]} members Array of group member avatar ids
 * @param {string} input User input that triggered the generation
 * @param {ChatMessage} lastMessage Last message in the chat
 * @param {boolean} allowSelfResponses If the group allows self-responses
 * @param {boolean} isUserInput If the generation was triggered by user input
 * @returns {number[]} Array of character ids
 */
function activateNaturalOrder(members, input, lastMessage, allowSelfResponses, isUserInput) {
    let activatedMembers = [];

    // prevents the same character from speaking twice
    let bannedUser = !isUserInput && lastMessage && !lastMessage.is_user && lastMessage.name;

    // ...unless allowed to do so
    if (allowSelfResponses) {
        bannedUser = undefined;
    }

    // find mentions (excluding self)
    if (input && input.length) {
        for (let inputWord of extractAllWords(input)) {
            for (let member of members) {
                const character = characters.find(x => x.avatar === member);

                if (!character || character.name === bannedUser) {
                    continue;
                }

                if (extractAllWords(character.name).includes(inputWord)) {
                    activatedMembers.push(member);
                    break;
                }
            }
        }
    }

    const chattyMembers = [];
    // activation by talkativeness (in shuffled order, except banned)
    const shuffledMembers = shuffle([...members]);
    for (let member of shuffledMembers) {
        const character = characters.find((x) => x.avatar === member);

        if (!character || character.name === bannedUser) {
            continue;
        }

        const rollValue = Math.random();
        const talkativeness = isNaN(character.talkativeness)
            ? talkativeness_default
            : Number(character.talkativeness);
        if (talkativeness >= rollValue) {
            activatedMembers.push(member);
        }
        if (talkativeness > 0) {
            chattyMembers.push(member);
        }
    }

    // pick 1 at random if no one was activated
    let retries = 0;
    // try to limit the selected random character to those with talkativeness > 0
    const randomPool = chattyMembers.length > 0 ? chattyMembers : members;
    while (activatedMembers.length === 0 && ++retries <= randomPool.length) {
        const randomIndex = Math.floor(Math.random() * randomPool.length);
        const character = characters.find((x) => x.avatar === randomPool[randomIndex]);

        if (!character) {
            continue;
        }

        activatedMembers.push(randomPool[randomIndex]);
    }

    // de-duplicate array of character avatars
    activatedMembers = activatedMembers.filter(onlyUnique);

    // map to character ids
    const memberIds = activatedMembers
        .map((x) => characters.findIndex((y) => y.avatar === x))
        .filter((x) => x !== -1);
    return memberIds;
}

/**
 * Deletes a group from the server by ID.
 * @param {string} id Group ID to delete
 * @returns {Promise<void>} Promise that resolves when the group is deleted
 */
async function deleteGroup(id) {
    const group = groups.find((x) => x.id === id);

    const response = await sendRoleplayLifecycle('/api/groups/delete', { id }, uuidv4(),
        body => fetch('/api/groups/delete', { method: 'POST', headers: getRequestHeaders(), body }));

    if (group && Array.isArray(group.chats)) {
        for (const chatId of group.chats) {
            await eventSource.emit(event_types.GROUP_CHAT_DELETED, chatId);
        }
    }

    if (response.ok) {
        await clearChat();
        selected_group = null;
        delete tag_map[id];
        resetChatState();
        await printMessages();
        await getCharacters();

        select_rm_info('group_delete', id);

        $('#rm_button_selected_ch').children('h2').text('');
    }
}

/**
 * Edits a group by ID.
 * @param {string} id Group ID to edit
 * @param {boolean} immediately Whether to save immediately
 * @param {boolean} reload Whether to reload the groups after saving
 * @returns {Promise<void>} Promise that resolves when the group is edited
 */
export async function editGroup(id, immediately, reload = true, account = getCurrentUserHandle(), { background = false, backgroundChanges = null } = {}) {
    let group = groups.find((x) => x.id === id);

    if (!group) {
        return;
    }

    const previous = pendingGroupMetadataSaves.get(id);
    let coalesced = null;
    if (previous) {
        clearTimeout(previous.timer);
        pendingGroupMetadataSaves.delete(id);
        if (previous.job.background === background) {
            coalesced = previous.job;
            if (queuedGroupMetadataById.get(id) === coalesced) queuedGroupMetadataById.delete(id);
            void finishRoleplaySave(coalesced.token);
        } else {
            // Different actors own different contents and authority; dispatch both in order.
            void _save(previous.job).catch(error => console.error('Error while saving group.', error));
        }
    }
    const prior = queuedGroupMetadataById.get(id);
    const applied = groupBackgroundState.get(group);
    if (background && (!backgroundChanges || Object.keys(backgroundChanges).some(key => !['memberRename', 'conversation_settings'].includes(key))
        || (!prior && !coalesced && !applied))) {
        if (applied) applied.failed = true;
        throw new Error('Reload the group before background changes.');
    }
    const revision = background ? groupSaveStates.get(id)?.revision ?? 0 : markGroupSaveDirty(id);
    const base = background ? structuredClone(coalesced?.snapshot ?? prior?.snapshot ?? applied.contents) : null;
    const changes = background ? structuredClone(backgroundChanges) : null;
    if (changes?.memberRename) {
        const { from, to } = changes.memberRename;
        if (typeof from !== 'string' || typeof to !== 'string' || !Array.isArray(base.members) || !base.members.includes(from)) {
            throw new Error('Reload the group before renaming its member.');
        }
        changes.members = base.members.map(member => member === from ? to : member);
        delete changes.memberRename;
    }
    const snapshot = background ? { ...base, ...changes } : snapshotGroupMetadata(group);
    const sourceAfter = background ? coalesced ? coalesced.sourceAfter : prior?.token ?? null : null;
    const sourceEvidence = background && !sourceAfter ? coalesced?.sourceEvidence ?? applied.evidence : null;
    const token = beginRoleplaySave({ kind: 'group', groupId: String(id) }, { operationKey: uuidv4(), owner: account,
        ...(background ? sourceAfter ? { after: sourceAfter } : { evidence: sourceEvidence } : {}) });
    const job = { group, groupId: id, reload, account, revision, token, snapshot, background, sourceAfter, sourceEvidence };
    queuedGroupMetadataById.set(id, job);
    if (immediately) {
        return await _save(job);
    }

    saveGroupDebounced(job);
}

/**
 * Unshallows all definitions of group members.
 * @param {string} groupId Id of the group
 * @returns {Promise<void>} Promise that resolves when all group members are unshallowed
 */
export async function unshallowGroupMembers(groupId) {
    const group = groups.find(x => x.id == groupId);
    if (!group) {
        return;
    }
    const members = group.members;
    if (!Array.isArray(members)) {
        return;
    }
    for (const member of members) {
        const index = characters.findIndex(x => x.avatar === member);
        if (index === -1) {
            continue;
        }
        await unshallowCharacter(String(index));
    }
}

/**
 * Modifies a group member by adding or removing them.
 * @param {string} groupId Group ID
 * @param {JQuery<HTMLElement>} groupMember Group member element
 * @param {boolean} isDelete If true, removes the member; otherwise adds the member
 */
async function modifyGroupMember(groupId, groupMember, isDelete) {
    const id = groupMember.data('id');
    const thisGroup = groups.find((x) => x.id == groupId);
    const membersArray = thisGroup?.members ?? newGroupMembers;

    if (isDelete) {
        const index = membersArray.findIndex((x) => x === id);
        if (index !== -1) {
            membersArray.splice(membersArray.indexOf(id), 1);
            if (thisGroup) {
                setGroupMemberModel(thisGroup, id, '');
            }
        }
    } else {
        if (!membersArray.includes(id)) {
            membersArray.unshift(id);
        }
    }

    if (openGroupId) {
        await unshallowGroupMembers(openGroupId);
        await editGroup(openGroupId, false, false);
        updateGroupAvatar(thisGroup);
    } else {
        markGroupSaveDirty();
    }

    printGroupCandidates();
    printGroupMembers();

    // Refresh the tag filters for both lists to reflect any new tags
    printTagFilters(tag_filter_type.group_candidates_list);
    printTagFilters(tag_filter_type.group_members_list);

    const groupHasMembers = openGroupId
        ? (thisGroup?.members?.length ?? 0) > 0
        : newGroupMembers.length > 0;
    $('#rm_group_submit').prop('disabled', !groupHasMembers);
}

/**
 * Reorders a group member up or down.
 * @param {string} groupId Group ID
 * @param {JQuery<HTMLElement>} groupMember Group member element
 * @param {string} direction Direction to move the member ('up' or 'down')
 * @returns {Promise<void>} Promise that resolves when the member has been reordered
 */
async function reorderGroupMember(groupId, groupMember, direction) {
    const id = groupMember.data('id');
    const thisGroup = groups.find((x) => x.id == groupId);
    const memberArray = thisGroup?.members ?? newGroupMembers;

    const indexOf = memberArray.indexOf(id);
    if (direction == 'down') {
        const next = memberArray[indexOf + 1];
        if (next) {
            memberArray[indexOf + 1] = memberArray[indexOf];
            memberArray[indexOf] = next;
        }
    }
    if (direction == 'up') {
        const prev = memberArray[indexOf - 1];
        if (prev) {
            memberArray[indexOf - 1] = memberArray[indexOf];
            memberArray[indexOf] = prev;
        }
    }

    printGroupMembers();

    // Existing groups need to modify members list
    if (openGroupId) {
        await editGroup(groupId, false, false);
        updateGroupAvatar(thisGroup);
    }
}

async function onGroupActivationStrategyInput(e) {
    const strategy = Number(e.target.value);
    const group = openGroupId && groups.find((x) => x.id == openGroupId);
    syncGroupDirectorProfileBlock(strategy, group ? group.director_profile : $('#rm_group_director_profile').val());
    if (group) {
        group.activation_strategy = strategy;
        await editGroup(openGroupId, false, false);
    }
}

async function onGroupDirectorProfileInput(e) {
    const group = openGroupId && groups.find((x) => x.id == openGroupId);
    if (group) {
        group.director_profile = String(e.target.value || '');
        await editGroup(openGroupId, false, false);
    }
}

async function onGroupTalkBurstInput(e) {
    const count = getGroupTalkBurstCount({ talk_burst: e.target.value });
    $(e.target).val(count);
    const group = openGroupId && groups.find((x) => x.id == openGroupId);
    if (group && group.talk_burst !== count) {
        group.talk_burst = count;
        await editGroup(openGroupId, false, false);
    }
}

async function populateGroupDirectorProfiles(selectedId = '') {
    const select = $('#rm_group_director_profile');
    if (!select.length) {
        return;
    }
    let profiles = [];
    try {
        const { ConnectionManagerRequestService } = await import('./extensions/shared.js');
        profiles = ConnectionManagerRequestService.getSupportedProfiles();
    } catch {
        profiles = [];
    }
    const selected = String(selectedId || '');
    select.empty().append($('<option value=""></option>').text(t`Current chat model`));
    for (const profile of profiles) {
        select.append($('<option></option>').val(profile.id).text(profile.name || profile.id));
    }
    if (selected && !profiles.some(profile => profile.id === selected)) {
        select.append($('<option></option>').val(selected).text(t`Missing profile (uses the chat model)`));
    }
    select.val(selected);
}

function syncGroupDirectorProfileBlock(strategy, profileId = '') {
    const isDirector = Number(strategy) === group_activation_strategy.DIRECTOR;
    $('#rm_group_director_profile_block').toggleClass('displayNone', !isDirector);
    if (isDirector) {
        void populateGroupDirectorProfiles(profileId);
    }
}

async function onGroupGenerationModeInput(e) {
    if (openGroupId) {
        let _thisGroup = groups.find((x) => x.id == openGroupId);
        _thisGroup.generation_mode = Number(e.target.value);
        await editGroup(openGroupId, false, false);

        toggleHiddenControls(_thisGroup);
    }
}

async function onGroupGenerationModeTemplateInput(e) {
    if (openGroupId) {
        let _thisGroup = groups.find((x) => x.id == openGroupId);
        const prop = $(e.target).attr('setting');
        _thisGroup[prop] = String(e.target.value);
        await editGroup(openGroupId, false, false);
    }
}

async function onGroupNameInput() {
    if (openGroupId) {
        let _thisGroup = groups.find((x) => x.id == openGroupId);
        _thisGroup.name = $(this).val();
        $('#rm_button_selected_ch').children('h2').text(_thisGroup.name);
        await editGroup(openGroupId, false);
    }
}

async function renameOpenGroup() {
    if (menu_type !== 'group_edit' || !openGroupId) {
        return;
    }

    const group = groups.find((x) => x.id == openGroupId);
    if (!group) {
        return;
    }

    const newName = await callGenericPopup('<h3>' + t`New name:` + '</h3>', POPUP_TYPE.INPUT, group.name);
    if (!newName || newName === group.name) {
        return;
    }

    group.name = String(newName);
    $('#rm_group_chat_name').val(group.name);
    $('#rm_button_selected_ch').children('h2').text(group.name);
    await editGroup(openGroupId, true, true);
}

const neconyanShell = /** @type {any} */ (globalThis.NeconyanShell || {});
globalThis.NeconyanShell = Object.assign(neconyanShell, {
    renameOpenGroup,
});

/**
 * Checks if a character with the given avatar ID is a member of the group.
 * @param {Group} group Group object
 * @param {string} avatarId Avatar ID to check
 * @returns {boolean} True if the avatar is a member of the group, false otherwise
 */
function isGroupMember(group, avatarId) {
    if (group && Array.isArray(group.members)) {
        return group.members.includes(avatarId);
    } else {
        return newGroupMembers.includes(avatarId);
    }
}

/**
 * Gets group characters based on filters.
 * @param {object} param
 * @param {boolean} [param.doFilter=false] Whether to apply filters
 * @param {boolean} [param.onlyMembers=false] Whether to include only group members
 * @returns {Array<{item: Character, id: number, type: string}>} Array of group character objects
 */
function getGroupCharacters({ doFilter = false, onlyMembers = false } = {}) {
    function applyFilterAndSort(results, filter, filterSelector) {
        let filtered = results;
        if (doFilter) {
            filtered = filter.applyFilters(filtered);
        }
        const useFilterOrder = doFilter && !!$(filterSelector).val();
        sortEntitiesList(filtered, useFilterOrder, filter);
        filter.clearFuzzySearchCaches();
        return filtered;
    }

    function handleMembers(results, thisGroup) {
        const membersArray = thisGroup?.members ?? newGroupMembers;

        // Create index map for O(1) lookups in member sort function
        // (separate from characterIndexMap which maps character objects to their array indices)
        const memberIndexMap = new Map(membersArray.map((avatar, index) => [avatar, index]));

        function sortMembersFn(a, b) {
            const aIndex = memberIndexMap.get(a.item.avatar) ?? -1;
            const bIndex = memberIndexMap.get(b.item.avatar) ?? -1;
            return aIndex - bIndex;
        }

        // Apply manual member sort before filter and sort
        let filtered = results;
        if (doFilter) {
            filtered = groupMembersFilter.applyFilters(filtered);
        }
        filtered.sort(sortMembersFn);

        // Apply conditional filter-based sort and cleanup
        const useFilterOrder = doFilter && !!$('#rm_group_members_filter').val();
        if (useFilterOrder) {
            sortEntitiesList(filtered, useFilterOrder, groupMembersFilter);
        }
        groupMembersFilter.clearFuzzySearchCaches();
        return filtered;
    }

    const thisGroup = openGroupId && groups.find((x) => x.id == openGroupId);

    // Create index map for O(1) lookups when mapping characters to their array indices
    // (separate from memberIndexMap used later for sorting members by their group order)
    const characterIndexMap = new Map(characters.map((char, index) => [char, index]));

    const results = characters
        .filter((x) => isGroupMember(thisGroup, x.avatar) == onlyMembers)
        .map((x) => ({ item: x, id: characterIndexMap.get(x), type: 'character' }));

    // Early return for candidates (non-members)
    if (!onlyMembers) {
        return applyFilterAndSort(results, groupCandidatesFilter, '#rm_group_filter');
    }

    // Handle members with manual sort capability
    return handleMembers(results, thisGroup);
}

function printGroupCandidates() {
    const storageKey = 'GroupCandidates_PerPage';
    const pageSize = Number(accountStorage.getItem(storageKey)) || 5;
    const sizeChangerOptions = [5, 10, 25, 50, 100, 200, 500, 1000];
    const entities = getGroupCharacters({ doFilter: true, onlyMembers: false });
    const sourceCount = getGroupCharacters({ doFilter: false, onlyMembers: false }).length;
    $('#rm_group_add_members_pagination').pagination({
        dataSource: entities,
        pageRange: 1,
        position: 'top',
        showPageNumbers: false,
        prevText: '<',
        nextText: '>',
        formatNavigator: PAGINATION_TEMPLATE,
        formatSizeChanger: renderPaginationDropdown(pageSize, sizeChangerOptions),
        showNavigator: true,
        showSizeChanger: true,
        pageSize,
        afterSizeSelectorChange: function (e, size) {
            accountStorage.setItem(storageKey, e.target.value);
            paginationDropdownChangeHandler(e, size);
        },
        callback: function (data) {
            $('#rm_group_add_members').empty();
            if (!data.length) {
                $('#rm_group_add_members').append($('<div>', {
                    class: 'sb-group-empty',
                    text: sourceCount > 0 && $('#rm_group_filter').val() ? t`No matches` : t`No characters available`,
                }));
            }
            for (const i of data) {
                $('#rm_group_add_members').append(getGroupCharacterBlock(i.item));
            }
            $('#rm_group_add_members_pagination').prop('hidden', entities.length <= pageSize);
            localizePagination($('#rm_group_add_members_pagination'));
        },
    });
}

function printGroupMembers() {
    const storageKey = 'GroupMembers_PerPage';
    $('.rm_group_members_pagination').each(function () {
        let that = this;
        const pageSize = Number(accountStorage.getItem(storageKey)) || 5;
        const sizeChangerOptions = [5, 10, 25, 50, 100, 200, 500, 1000];
        const entities = getGroupCharacters({ doFilter: true, onlyMembers: true });
        const sourceCount = getGroupCharacters({ doFilter: false, onlyMembers: true }).length;
        $(this).pagination({
            dataSource: entities,
            pageRange: 1,
            position: 'top',
            showPageNumbers: false,
            prevText: '<',
            nextText: '>',
            formatNavigator: PAGINATION_TEMPLATE,
            showNavigator: true,
            showSizeChanger: true,
            formatSizeChanger: renderPaginationDropdown(pageSize, sizeChangerOptions),
            pageSize,
            afterSizeSelectorChange: function (e, size) {
                accountStorage.setItem(storageKey, e.target.value);
                paginationDropdownChangeHandler(e, size);
            },
            callback: function (data) {
                $('.rm_group_members').empty();
                if (!data.length) {
                    $('.rm_group_members').append($('<div>', {
                        class: 'sb-group-empty',
                        text: sourceCount > 0 && $('#rm_group_members_filter').val() ? t`No matches` : t`Group has no members yet`,
                    }));
                }
                for (const i of data) {
                    $('.rm_group_members').append(getGroupCharacterBlock(i.item));
                }
                $(that).prop('hidden', entities.length <= pageSize);
                localizePagination($(that));
            },
        });
    });
}

/**
 * Creates a jQuery element representing a group character block.
 * @param {Character} character Character object
 * @returns {JQuery<HTMLElement>} jQuery element representing the group character block
 */
function getGroupCharacterBlock(character) {
    const avatar = getThumbnailUrl('avatar', character.avatar);
    const template = $('#group_member_template .group_member').clone();
    const isFav = !!character.fav || character.fav == 'true';
    template.data('id', character.avatar);
    template.find('.avatar img').attr({ 'src': avatar, 'title': character.avatar });
    template.find('.ch_name').text(character.name);
    template.attr('data-chid', characters.indexOf(character));
    template.find('.ch_fav').val(String(isFav));
    template.toggleClass('is_fav', isFav);

    const auxFieldName = power_user.aux_field || 'character_version';
    const auxFieldValue = (character.data && character.data[auxFieldName]) || '';
    if (auxFieldValue) {
        template.find('.character_version').text(auxFieldValue);
    } else {
        template.find('.character_version').hide();
    }

    let queuePosition = groupChatQueueOrder.get(character.avatar);
    if (queuePosition) {
        template.find('.queue_position').text(queuePosition);
        template.toggleClass('is_queued', queuePosition > 1);
        template.toggleClass('is_active', queuePosition === 1);
    }

    template.toggleClass('disabled', isGroupMemberDisabled(character.avatar));

    const thisGroup = openGroupId && groups.find((x) => x.id == openGroupId);
    const modelInput = template.find('.group_member_model_input');
    modelInput.val(getGroupMemberModel(thisGroup, character.avatar));
    modelInput.toggle(!!thisGroup && isGroupMember(thisGroup, character.avatar));
    modelInput.closest('.group_member_model').toggle(!!thisGroup && isGroupMember(thisGroup, character.avatar));

    // Display inline tags
    const tagsElement = template.find('.tags');
    printTagList(tagsElement, { forEntityOrKey: characters.indexOf(character), tagOptions: { isCharacterList: true } });

    if (!openGroupId) {
        template.find('[data-action="speak"]').hide();
        template.find('[data-action="enable"]').hide();
        template.find('[data-action="disable"]').hide();
        modelInput.hide();
    }

    return template;
}

/**
 * Checks if a group member is disabled.
 * @param {string} avatarId Avatar ID of the group member
 * @returns {boolean} True if the group member is disabled, false otherwise
 */
function isGroupMemberDisabled(avatarId) {
    const thisGroup = openGroupId && groups.find((x) => x.id == openGroupId);
    return Boolean(thisGroup && thisGroup.disabled_members.includes(avatarId));
}

async function onDeleteGroupClick() {
    if (!openGroupId) {
        toastr.warning(t`Currently no group selected.`);
        return;
    }
    if (is_group_generating) {
        toastr.warning(t`Not so fast! Wait for the characters to stop typing before deleting the group.`);
        return;
    }

    const confirm = await Popup.show.confirm(t`Delete the group?`, '<p>' + t`This will also delete all your chats with that group. If you want to delete a single conversation, select a "View past chats" option in the lower left menu.` + '</p>');
    if (confirm) {
        deleteGroup(openGroupId);
    }
}

async function onFavoriteGroupClick() {
    updateFavButtonState(!fav_grp_checked);
    if (openGroupId) {
        let _thisGroup = groups.find((x) => x.id == openGroupId);
        _thisGroup.fav = fav_grp_checked;
        await editGroup(openGroupId, false, false);
        favsToHotswap();
    }
}

async function onGroupSelfResponsesClick() {
    if (openGroupId) {
        let _thisGroup = groups.find((x) => x.id == openGroupId);
        const value = $(this).prop('checked');
        _thisGroup.allow_self_responses = value;
        await editGroup(openGroupId, false, false);
    }
}

async function onGroupKeepOwnLinesClick() {
    if (openGroupId) {
        const _thisGroup = groups.find((x) => x.id == openGroupId);
        _thisGroup.keep_own_lines = Boolean($(this).prop('checked'));
        await editGroup(openGroupId, false, false);
    }
}

async function onHideMutedSpritesClick(value) {
    if (openGroupId) {
        let _thisGroup = groups.find((x) => x.id == openGroupId);
        _thisGroup.hideMutedSprites = value;
        console.log(`_thisGroup.hideMutedSprites = ${_thisGroup.hideMutedSprites}`);
        await editGroup(openGroupId, false, false);
        await eventSource.emit(event_types.GROUP_UPDATED);
    }
}

/**
 * Toggles the visibility of hidden controls based on the group's generation mode.
 * @param {Group} group Group object
 * @param {number|null} generationMode Generation mode, or null to use the group's current generation mode
 */
function toggleHiddenControls(group, generationMode = null) {
    const isJoin = [group_generation_mode.APPEND, group_generation_mode.APPEND_DISABLED].includes(generationMode ?? group?.generation_mode);
    $('#rm_group_generation_mode_join_prefix').parent().toggle(isJoin);
    $('#rm_group_generation_mode_join_suffix').parent().toggle(isJoin);

    if (!CSS.supports('field-sizing', 'content')) {
        initScrollHeight($('#rm_group_generation_mode_join_prefix'));
        initScrollHeight($('#rm_group_generation_mode_join_suffix'));
    }
}

function ensureGroupEditorLayout() {
    const block = document.getElementById('rm_group_chats_block');
    if (!(block instanceof HTMLElement)) {
        return;
    }

    const controls = document.getElementById('groupControlsToggle')?.closest('.inline-drawer');
    const currentMembers = document.getElementById('groupCurrentMemberListToggle')?.closest('.inline-drawer');
    const addMembers = document.getElementById('groupAddMemberListToggle')?.closest('.inline-drawer');
    if (currentMembers instanceof HTMLElement && addMembers instanceof HTMLElement) {
        let membersGrid = block.querySelector('.sb-group-members-grid');
        if (!(membersGrid instanceof HTMLElement)) {
            membersGrid = document.createElement('div');
            membersGrid.className = 'sb-group-members-grid';
            block.insertBefore(membersGrid, controls || block.lastElementChild);
        }
        if (currentMembers.parentElement !== membersGrid) {
            membersGrid.append(currentMembers);
        }
        if (addMembers.parentElement !== membersGrid) {
            membersGrid.append(addMembers);
        }
    }

    const commitBar = document.getElementById('sb_group_commit_bar');
    const submitButton = document.getElementById('rm_group_submit');
    const commitActions = commitBar?.querySelector('.sb-group-commit-actions');
    if (submitButton instanceof HTMLElement && commitActions instanceof HTMLElement && submitButton.parentElement !== commitActions) {
        commitActions.append(submitButton);
    }
}

/**
 * Opens a group creation/editing right menu.
 * @param {string|null} groupId ID of the group to select or null if creating a new group
 * @param {boolean} skipAnimation If true, skips the animation when selecting the group
 */
function select_group_chats(groupId, skipAnimation) {
    ensureGroupEditorLayout();
    openGroupId = groupId;
    newGroupMembers = [];
    const group = openGroupId && groups.find((x) => x.id == openGroupId);
    const groupName = group?.name ?? '';
    const replyStrategy = group
        ? Number(group.activation_strategy ?? group_activation_strategy.NATURAL)
        : group_activation_strategy.DIRECTOR;
    const generationMode = Number(group?.generation_mode ?? group_generation_mode.SWAP);

    setMenuType(group ? 'group_edit' : 'group_create');
    $('#group_avatar_preview').empty().append(getGroupAvatar(group));
    $('#rm_group_restore_avatar').toggle(!!group && isValidImageUrl(group.avatar_url));
    $('#rm_group_filter').val('').trigger('input');
    $('#rm_group_members_filter').val('').trigger('input');
    $('#rm_group_activation_strategy').val(replyStrategy);
    $(`#rm_group_activation_strategy option[value="${replyStrategy}"]`).prop('selected', true);
    syncGroupDirectorProfileBlock(replyStrategy, group?.director_profile);
    $('#rm_group_talk_burst').val(Math.min(8, Math.max(1, Math.round(Number(group?.talk_burst)) || 3)));
    $('#rm_group_generation_mode').val(generationMode);
    $(`#rm_group_generation_mode option[value="${generationMode}"]`).prop('selected', true);
    $('#rm_group_chat_name').val(groupName);

    if (!skipAnimation) {
        selectRightMenuWithAnimation('rm_group_chats_block');
    }

    // render tags
    applyTagsOnGroupSelect(groupId);

    // render characters list
    printGroupCandidates();
    printGroupMembers();

    const groupHasMembers = openGroupId
        ? Array.isArray(group?.members) && group.members.length > 0
        : newGroupMembers.length > 0;
    $('#rm_group_submit').prop('disabled', !groupHasMembers);
    $('#rm_group_allow_self_responses').prop('checked', group && group.allow_self_responses);
    $('#rm_group_keep_own_lines').prop('checked', group?.keep_own_lines !== false);
    $('#rm_group_ensemble_replies').prop('checked', group?.ensemble_replies === true);
    $('#rm_group_hidemutedsprites').prop('checked', group && group.hideMutedSprites);
    $('#rm_group_generation_mode_join_prefix').val(group?.generation_mode_join_prefix ?? '').attr('setting', 'generation_mode_join_prefix');
    $('#rm_group_generation_mode_join_suffix').val(group?.generation_mode_join_suffix ?? '').attr('setting', 'generation_mode_join_suffix');
    toggleHiddenControls(group, generationMode);

    // bottom buttons
    // Toggle a class instead of .show()/.hide(): jQuery's .show() can write an inline
    // `display: block` that overrides the editor's flex centring and pins the icons to the top.
    $('#rm_group_submit').toggleClass('displayNone', Boolean(openGroupId));
    $('#rm_group_delete, #rm_group_scenario, #group_open_media_overrides').css('display', '').toggleClass('displayNone', !openGroupId);
    if (openGroupId) {
        $('#sb_group_cancel').show().find('span').text(t`Back to groups`);
        $('#sb_group_cancel').attr('aria-label', t`Back to groups`);
        $('#group-metadata-controls .chat_lorebook_button').removeClass('disabled').prop('disabled', false);
        const isMediaAllowed = isExternalMediaAllowed();
        $('#group_media_allowed_icon').toggle(isMediaAllowed);
        $('#group_media_forbidden_icon').toggle(!isMediaAllowed);
    } else {
        $('#sb_group_cancel').show().find('span').text(t`Cancel`);
        $('#sb_group_cancel').attr('aria-label', t`Cancel`);
        const addMembersDrawer = document.getElementById('groupAddMemberListToggle')?.closest('.inline-drawer');
        if (addMembersDrawer instanceof HTMLElement) {
            toggleDrawer(addMembersDrawer, true);
        }
        $('#group-metadata-controls .chat_lorebook_button').addClass('disabled').prop('disabled', true);
    }

    updateFavButtonState(group?.fav ?? false);

    // top bar
    $('#rm_button_selected_ch').children('h2').text(group ? groupName : t`Create group`);

    // Toggle textbox sizes, as input events have not fired here
    if (!CSS.supports('field-sizing', 'content')) {
        $('#rm_group_chats_block .autoSetHeight').each(element => {
            resetScrollHeight(element);
        });
    }

    hideMutedSprites = group?.hideMutedSprites ?? false;
    $('#rm_group_hidemutedsprites').prop('checked', hideMutedSprites);

    setGroupSaveStatus(openGroupId ? groupSaveStates.get(openGroupId)?.status ?? 'saved' : 'draft', openGroupId);
    updateGroupSpeakerControls();
    eventSource.emit('groupSelected', { detail: { id: openGroupId, group: group } });
}

/**
 * Handles the upload and processing of a group avatar.
 * The selected image is read, cropped using a popup, processed into a thumbnail,
 * and then uploaded to the server.
 *
 * @param {Event} event - The event triggered by selecting a file input, containing the image file to upload.
 *
 * @returns {Promise<void>} - A promise that resolves when the processing and upload is complete.
 */
async function uploadGroupAvatar(event) {
    if (!(event.target instanceof HTMLInputElement) || !event.target.files.length) {
        return;
    }

    const file = event.target.files[0];

    if (!file) {
        return;
    }

    const result = await getBase64Async(file);

    $('#dialogue_popup').addClass('large_dialogue_popup wide_dialogue_popup');

    const croppedImage = await callGenericPopup('Set the crop position of the avatar image', POPUP_TYPE.CROP, '', { cropImage: result });

    if (!croppedImage) {
        return;
    }

    let thumbnail = await createThumbnail(String(croppedImage), 200, 300);
    //remove data:image/whatever;base64
    thumbnail = thumbnail.replace(/^data:image\/[a-z]+;base64,/, '');
    let _thisGroup = groups.find((x) => x.id == openGroupId);
    // filename should be group id + human readable timestamp
    const filename = _thisGroup ? `${_thisGroup.id}_${humanizedDateTime()}` : humanizedDateTime();
    let thumbnailUrl = await saveBase64AsFile(thumbnail, String(openGroupId ?? ''), filename, 'jpg');
    if (!openGroupId) {
        $('#group_avatar_preview img').attr('src', thumbnailUrl);
        $('#rm_group_restore_avatar').show();
        return;
    }

    _thisGroup.avatar_url = thumbnailUrl;
    $('#group_avatar_preview').empty().append(getGroupAvatar(_thisGroup));
    $('#rm_group_restore_avatar').show();
    await editGroup(openGroupId, true, true);
}

async function restoreGroupAvatar() {
    const confirm = await Popup.show.confirm('Are you sure you want to restore the group avatar?', 'Your custom image will be deleted, and a collage will be used instead.');
    if (!confirm) {
        return;
    }

    if (!openGroupId) {
        $('#group_avatar_preview img').attr('src', default_avatar);
        $('#rm_group_restore_avatar').hide();
        return;
    }

    let _thisGroup = groups.find((x) => x.id == openGroupId);
    _thisGroup.avatar_url = '';
    $('#group_avatar_preview').empty().append(getGroupAvatar(_thisGroup));
    $('#rm_group_restore_avatar').hide();
    await editGroup(openGroupId, true, true);
}

async function onGroupActionClick(event) {
    event.stopPropagation();
    const action = $(this).data('action');
    const member = $(this).closest('.group_member');

    if (action === 'remove') {
        await modifyGroupMember(openGroupId, member, true);
    }

    if (action === 'add') {
        await modifyGroupMember(openGroupId, member, false);
    }

    if (action === 'enable') {
        member.removeClass('disabled');
        const _thisGroup = groups.find(x => x.id === openGroupId);
        const index = _thisGroup.disabled_members.indexOf(member.data('id'));
        if (index !== -1) {
            _thisGroup.disabled_members.splice(index, 1);
            await editGroup(openGroupId, false, false);
        }
    }

    if (action === 'disable') {
        member.addClass('disabled');
        const _thisGroup = groups.find(x => x.id === openGroupId);
        if (!_thisGroup.disabled_members.includes(member.data('id'))) {
            _thisGroup.disabled_members.push(member.data('id'));
            await editGroup(openGroupId, false, false);
        }
    }

    if (action === 'up' || action === 'down') {
        await reorderGroupMember(openGroupId, member, action);
    }

    if (action === 'view') {
        await openCharacterDefinition(member);
    }

    if (action === 'speak') {
        const chid = Number(member.attr('data-chid'));
        if (Number.isInteger(chid)) {
            Generate('normal', { force_chid: chid });
        }
    }

    await eventSource.emit(event_types.GROUP_UPDATED);
}

function isMobileGroupCandidateRowTap(event) {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!target || target.closest('.right_menu_button, input, button, select, textarea, a')) {
        return false;
    }

    return globalThis.NeconyanShell?.isMobileViewport?.() ?? Boolean(globalThis.matchMedia?.('(max-width: 768px)')?.matches);
}

async function onGroupCandidateRowClick(event) {
    if (!isMobileGroupCandidateRowTap(event)) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    await modifyGroupMember(openGroupId, $(this), false);
    await eventSource.emit(event_types.GROUP_UPDATED);
}

function updateFavButtonState(state) {
    fav_grp_checked = state;
    $('#rm_group_fav').val(String(fav_grp_checked));
    $('#group_favorite_button').toggleClass('fav_on', fav_grp_checked);
    $('#group_favorite_button').toggleClass('fav_off', !fav_grp_checked);
}

/**
 * Opens a group chat by its ID and updates the UI accordingly.
 * @param {string} groupId ID of the group to open
 * @param {object} options Open options
 * @param {boolean} [options.switchMenu=true] Whether to switch the right menu to the group editor
 * @returns {Promise<boolean>} Whether the group was opened
 */
export async function openGroupById(groupId, { switchMenu = true } = {}) {
    if (!groups.find(x => x.id === groupId)) {
        console.log('Group not found', groupId);
        return false;
    }

    if (is_send_press || is_group_generating) {
        return false;
    }

    if (switchMenu) {
        select_group_chats(groupId, false);
    }

    if (selected_group === groupId) {
        syncCharacterMenuActiveEntity();
        await scrollReopenedChatToBottom();
        return true;
    }

    if (!await flushPendingChatSavesForNavigation()) {
        return false;
    }

    groupChatQueueOrder = new Map();
    setCharacterId(undefined);
    setCharacterName('');
    resetSelectedGroup();
    await clearChat({ clearData: true });
    cancelTtsPlay();
    selected_group = groupId;
    setEditedMessageId(undefined);
    updateChatMetadata({}, true);
    await getGroupChat(groupId, false, { switchMenu });
    syncCharacterMenuActiveEntity();
    return true;
}

/**
 * Peeks the character definition from a group member element.
 * @param {JQuery<HTMLElement>} characterSelect Character select element
 * @returns {Promise<void>}
 */
async function openCharacterDefinition(characterSelect) {
    if (is_group_generating) {
        toastr.warning(t`Can't peek a character while group reply is being generated`);
        console.warn('Can\'t peek a character def while group reply is being generated');
        return;
    }

    const chid = characterSelect.attr('data-chid');

    if (chid === null || chid === undefined) {
        return;
    }

    if (await flushCharacterSaveDebounced() === false) {
        return;
    }
    await unshallowCharacter(chid);
    setCharacterId(chid);
    select_selected_character(chid);
    // Gentle nudge to recalculate tokens
    RA_CountCharTokens();
    // Do a little tomfoolery to spoof the tag selector
    applyTagsOnCharacterSelect.call(characterSelect);
}

function filterGroupMembers() {
    const searchValue = String($(this).val()).toLowerCase();
    groupCandidatesFilter.setFilterData(FILTER_TYPES.SEARCH, searchValue);
}

function filterGroupMemberList() {
    const searchValue = String($(this).val()).toLowerCase();
    groupMembersFilter.setFilterData(FILTER_TYPES.SEARCH, searchValue);
}


function getSelectedGroupMemberAvatars() {
    if (openGroupId) {
        return groups.find(x => x.id === openGroupId)?.members ?? [];
    }

    return newGroupMembers;
}

function getGroupMemberSignature(members) {
    return [...new Set(Array.isArray(members) ? members : [])].sort().join('|');
}

function findGroupByMembers(members) {
    const signature = getGroupMemberSignature(members);
    if (!signature) {
        return null;
    }

    return groups.find(group => getGroupMemberSignature(group.members) === signature) || null;
}

async function createQuickGroupFromSelectedMembers() {
    const members = getSelectedGroupMemberAvatars().filter(onlyUnique);
    if (members.length === 0) {
        toastr.warning(t`Select at least one character first.`);
        return;
    }

    const existingGroup = !openGroupId ? findGroupByMembers(members) : null;
    if (existingGroup) {
        await createNewGroupChat(existingGroup.id);
        toastr.info(t`Opened a new chat branch for the existing group.`);
        return;
    }

    if (openGroupId) {
        await createNewGroupChat(openGroupId);
        toastr.info(t`Opened a new chat branch for this group.`);
        return;
    }

    const names = members
        .map(avatar => characters.find(character => character.avatar === avatar)?.name)
        .filter(Boolean);
    const defaultName = names.length ? t`Group: ${names.join(', ')}` : t`New Group`;
    const groupName = await Popup.show.input(t`Create Group Chat`, t`Name this group chat:`, defaultName);
    if (groupName === null) {
        return;
    }

    $('#rm_group_chat_name').val(String(groupName || defaultName));
    await createGroup();
}

async function onGroupMemberModelInput() {
    if (!openGroupId) {
        return;
    }

    const group = groups.find(x => x.id === openGroupId);
    const member = $(this).closest('.group_member');
    setGroupMemberModel(group, member.data('id'), $(this).val());
    await editGroup(openGroupId, false, false);
}

async function createGroup() {
    let name = $('#rm_group_chat_name').val().toString();
    let allowSelfResponses = !!$('#rm_group_allow_self_responses').prop('checked');
    const keepOwnLines = $('#rm_group_keep_own_lines').prop('checked') !== false;
    let activationStrategy = Number($('#rm_group_activation_strategy').find(':selected').val()) ?? group_activation_strategy.NATURAL;
    let generationMode = Number($('#rm_group_generation_mode').find(':selected').val()) ?? group_generation_mode.SWAP;
    const directorProfile = String($('#rm_group_director_profile').val() || '');
    const talkBurst = getGroupTalkBurstCount({ talk_burst: $('#rm_group_talk_burst').val() });
    const members = newGroupMembers.filter(onlyUnique);
    if (members.length === 0) {
        $('#rm_group_submit').prop('disabled', true);
        toastr.warning(t`Add at least one character before creating a group.`);
        return false;
    }
    const existingGroup = findGroupByMembers(members);
    if (existingGroup) {
        await createNewGroupChat(existingGroup.id);
        toastr.info(t`Opened a new chat branch for the existing group.`);
        return;
    }

    const memberNames = characters.filter(x => members.includes(x.avatar)).map(x => x.name).join(', ');

    if (!name) {
        name = t`Group: ${memberNames}`;
    }

    const avatarUrl = $('#group_avatar_preview img').attr('src');

    /** @type {Omit<Group, 'id'>} */
    const groupCreateModel = {
        name: name,
        members: members,
        avatar_url: isValidImageUrl(avatarUrl) ? avatarUrl : default_avatar,
        allow_self_responses: allowSelfResponses,
        keep_own_lines: keepOwnLines,
        ensemble_replies: $('#rm_group_ensemble_replies').prop('checked') === true,
        hideMutedSprites: hideMutedSprites,
        activation_strategy: activationStrategy,
        director_profile: directorProfile,
        talk_burst: talkBurst,
        generation_mode: generationMode,
        disabled_members: [],
        [GROUP_MEMBER_MODELS_KEY]: {},
        fav: fav_grp_checked,
        // The first open creates the chat; a preallocated ID would refer to a missing file.
        chat_id: '',
        chats: [],
        conversation_settings: {},
    };

    const createGroupResponse = await sendRoleplayLifecycle('/api/groups/create', groupCreateModel, uuidv4(),
        body => fetch('/api/groups/create', { method: 'POST', headers: getRequestHeaders(), body }));

    if (createGroupResponse.ok) {
        newGroupMembers = [];
        const data = await createGroupResponse.json();
        createTagMapFromList('#groupTagList', data.id);
        await getCharacters();
        select_rm_info('group_create', data.id);
        globalThis.NeconyanShell?.openTab?.('characters', 'groups');
        return true;
    }

    toastr.error(t`Could not create the group. Try again.`);
    return false;
}

/**
 * Creates a new group chat within the specified group.
 * @param {string} groupId Group ID
 * @param {object} [options] Creation options
 * @param {boolean} [options.chatAlreadyPrepared=false] Whether the caller already flushed saves and cleared the current chat.
 * @returns {Promise<void>} Promise that resolves when the new group chat is created
 */
export async function createNewGroupChat(groupId, { chatAlreadyPrepared = false } = {}) {
    const group = groups.find(x => x.id === groupId);

    if (!group) {
        return;
    }

    if (!chatAlreadyPrepared) {
        if (!await flushPendingChatSavesForNavigation()) {
            return;
        }

        await clearChat({ clearData: true });
    }

    const newChatName = humanizedDateTime();
    group.chats = Array.isArray(group.chats) ? group.chats : [];
    group.chats.push(newChatName);
    group.chat_id = newChatName;
    updateChatMetadata({ integrity: uuidv4() }, true);

    await editGroup(group.id, true, false);
    await getGroupChat(group.id, false, { newlyCreated: true });
}

/**
 * Retrieves past chats for a specified group.
 * @param {string} groupId Group ID
 * @returns {Promise<Array<import('../../src/endpoints/chats.js').ChatInfo>>} Array of past chats
 */
export async function getGroupPastChats(groupId) {
    const group = groups.find(x => x.id === groupId);

    if (!group) {
        return [];
    }

    const chats = [];

    try {
        for (const chatId of group.chats) {
            const response = await fetch('/api/chats/group/info', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ id: chatId }),
            });
            if (response.ok) {
                const data = await response.json();
                chats.push(data);
            }
        }
    } catch (err) {
        console.error(err);
    }
    return chats;
}

/**
 * Opens a specific group chat for the specified group by its ID.
 * @param {string} groupId Group ID
 * @param {string} chatId Chat ID
 * @returns {Promise<void>}
 */
export async function openGroupChat(groupId, chatId) {
    const group = groups.find(x => x.id === groupId);

    if (!group || !group.chats.includes(chatId)) {
        return;
    }

    if (!await flushPendingChatSavesForNavigation()) {
        return;
    }

    await clearChat({ clearData: true });
    group.chat_id = chatId;
    group.date_last_chat = Date.now();
    updateChatMetadata({}, true);

    await editGroup(groupId, true, false);
    await getGroupChat(groupId);
}

/**
 * Renames a group chat within the specified group.
 * @param {string} groupId Group ID
 * @param {string} oldChatId Old chat ID
 * @param {string} newChatId New chat ID
 * @returns {Promise<void>} Promise that resolves when the group chat is renamed
 */
export async function renameGroupChat(groupId, oldChatId, newChatId) {
    const group = groups.find(x => x.id === groupId);

    if (!group || !group.chats.includes(oldChatId)) {
        throw new Error(`Group chat ${oldChatId} is not registered in group ${groupId}.`);
    }

    const previousChatId = group.chat_id;
    const previousChats = [...group.chats];

    if (group.chat_id === oldChatId) {
        group.chat_id = newChatId;
    }

    group.chats.splice(group.chats.indexOf(oldChatId), 1);
    group.chats.push(newChatId);

    try {
        await editGroup(groupId, true, false);
    } catch (error) {
        group.chat_id = previousChatId;
        group.chats = previousChats;
        throw error;
    }
}

/**
 * Deletes a group chat by its name. Doesn't affect displayed chat.
 * @param {string} groupId Group ID
 * @param {string} chatName Name of the chat to delete
 * @returns {Promise<boolean>} Whether the chat was deleted
 */
export async function deleteGroupChatByName(groupId, chatName) {
    const group = groups.find(x => x.id === groupId);
    if (!group || !group.chats.includes(chatName)) {
        return false;
    }

    group.chats.splice(group.chats.indexOf(chatName), 1);

    const response = await sendRoleplayLifecycle('/api/chats/group/delete', { id: chatName }, uuidv4(),
        body => fetch('/api/chats/group/delete', { method: 'POST', headers: getRequestHeaders(), body }));

    if (!response.ok) {
        toastr.error(t`Could not reach the server, so your changes may not be saved. Check your connection, then reload the page to avoid losing them.`, t`Group chat could not be deleted`);
        console.error('Group chat could not be deleted');
        return false;
    }

    // If the deleted chat was the current chat, switch to the last chat in the group
    if (group.chat_id === chatName) {
        const newChatName = group.chats.length ? group.chats[group.chats.length - 1] : humanizedDateTime();
        group.chat_id = newChatName;
    }

    await editGroup(groupId, true, true);
    await eventSource.emit(event_types.GROUP_CHAT_DELETED, chatName);
    return true;
}

/**
 * Deletes a group chat by name.
 * @param {string} groupId The ID of the group containing the chat to delete.
 * @param {string} chatId The id/name of the chat to delete.
 * @param {object} [options={}] Options for the deletion.
 * @param {boolean} [options.jumpToNewChat=true] Whether to jump to a new chat after deletion (existing one, or create a new one if none exists)
 */
export async function deleteGroupChat(groupId, chatId, { jumpToNewChat = true } = {}) {
    const group = groups.find(x => x.id === groupId);

    if (!group || !group.chats.includes(chatId)) {
        return;
    }

    group.chats.splice(group.chats.indexOf(chatId), 1);

    if (group.chat_id === chatId) {
        group.chat_id = '';
        updateChatMetadata({}, true);
    }

    const response = await sendRoleplayLifecycle('/api/chats/group/delete', { id: chatId }, uuidv4(),
        body => fetch('/api/chats/group/delete', { method: 'POST', headers: getRequestHeaders(), body }));

    if (response.ok) {
        if (jumpToNewChat) {
            if (group.chats.length) {
                await openGroupChat(groupId, group.chats[group.chats.length - 1]);
            } else {
                await createNewGroupChat(groupId);
            }
        }

        await eventSource.emit(event_types.GROUP_CHAT_DELETED, chatId);
    }
}

/**
 * Imports a group chat from a file and adds it to the group.
 * @param {FormData} formData Form data to send to the server
 * @param {object} [options={}] Options for the import
 * @param {boolean} [options.refresh] Whether to refresh the group chat list after import
 * @returns {Promise<string[]>} List of imported file names
 */
export function applyGroupImportResult(target, result) {
    const group = groups.find(item => item.id === target.groupId);
    if (group !== target.group || selected_group !== target.groupId || roleplayAccountStamp() !== target.stamp) return false;
    const unchanged = JSON.stringify(snapshotGroupMetadata(group)) === JSON.stringify(target.contents);
    group.chats = [...new Set([...(group.chats ?? []), ...result.fileNames])];
    const applied = groupBackgroundState.get(group);
    if (applied) applied.contents.chats = [...new Set([...(applied.contents.chats ?? []), ...result.fileNames])];
    const saveState = groupSaveStates.get(target.groupId);
    if (unchanged && (!saveState || saveState.status === 'saved') && saveState?.revision === target.revision
        && groupReadEvidence.get(group) === target.readEvidence
        && groupBackgroundState.get(group) === target.backgroundState) {
        const evidence = { account: target.stamp.account, source: result.roleplay.group.source };
        const locator = { kind: 'group', groupId: target.groupId };
        if (rememberRoleplayRead(locator, { ...evidence, locator })) {
            groupReadEvidence.set(group, evidence);
            groupBackgroundState.set(group, { evidence, contents: snapshotGroupMetadata(group), failed: false });
            return true;
        }
    }
    return false;
}

export async function importGroupChat(formData, options = {}) {
    const target = options.target ?? await captureGroupImportTarget();
    return sendChatImport(formData, { ...options, target, group: true });
}

/**
 * Saves the current group chat as a bookmark chat.
 * @param {string} groupId Group ID
 * @param {string} name Name of the chat to save
 * @param {ChatMetadata?} metadata New metadata to save with the chat
 * @param {number|undefined} mesId Optional message ID to trim the chat up to
 * @param {ChatMessage[]|undefined} chatData Optional chat snapshot to save instead of the current in-memory chat
 * @param {{throwOnError?: boolean}} [options] Additional save options
 * @returns {Promise<boolean>} Promise that resolves to whether the group chat was saved
 */
export async function saveGroupBookmarkChat(groupId, name, metadata, mesId, chatData = undefined, { throwOnError = false } = {}) {
    const group = groups.find(x => x.id === groupId);

    if (!group) {
        return false;
    }

    /** @type {ChatHeader} */
    const chatHeader = {
        chat_metadata: { ...chat_metadata, ...(metadata || {}) },
        user_name: 'unused',
        character_name: 'unused',
    };

    /** @type {ChatMessage[]} */
    const trimmedChat = Array.isArray(chatData)
        ? chatData
        : (mesId !== undefined && mesId >= 0 && mesId < chat.length)
            ? chat.slice(0, Number(mesId) + 1)
            : chat;

    ensureMewmoryMessageIds(trimmedChat, uuidv4);

    let token;
    try {
        token = beginRoleplaySave({ group: true, chat: name }, { operationKey: uuidv4(), create: true });
        const payload = { id: name, chat: [chatHeader, ...trimmedChat] };
        let response = await saveRoleplayChatRequest(token, payload);
        if (!response.ok && response.data?.error === 'integrity' && response.data.roleplay?.source) {
            const confirmation = await Popup.show.input(t`A chat with this name already exists.`, t`Enter OVERWRITE to replace it.`, '');
            if (confirmation === 'OVERWRITE') {
                confirmRoleplayOverwrite(token, uuidv4());
                response = await saveRoleplayChatRequest(token, payload);
            }
        }
        if (!response.ok) throw new Error('Group chat could not be saved');
        if (!group.chats.includes(name)) group.chats.push(name);
        await editGroup(groupId, true, false, token.owner);
        return true;
    } catch (error) {
        toastr.error(t`Could not reach the server, so your changes may not be saved. Check your connection, then reload the page to avoid losing them.`, t`Group chat could not be saved`);
        console.error('Group chat could not be saved', error);
        if (throwOnError) {
            throw error;
        }
        return false;
    } finally {
        await finishRoleplaySave(token);
    }
}

function doCurMemberListPopout() {
    //repurposes the zoomed avatar template to server as a floating group member list
    if ($('#groupMemberListPopout').length === 0) {
        console.debug('did not see popout yet, creating');
        const memberListClone = $(this).parent().parent().find('.inline-drawer-content').html();
        const template = $('#zoomed_avatar_template').html();
        const controlBarHtml = `<div class="panelControlBar flex-container">
        <div id="groupMemberListPopoutheader" class="fa-solid fa-grip drag-grabber hoverglow"></div>
        <div id="groupMemberListPopoutClose" class="fa-solid fa-circle-xmark hoverglow"></div>
    </div>`;
        const newElement = $(template);

        newElement.attr('id', 'groupMemberListPopout')
            .removeClass('zoomed_avatar')
            .addClass('draggable')
            .empty()
            .append(controlBarHtml)
            .append(memberListClone);

        // Remove pagination from popout
        newElement.find('.group_pagination').empty();

        $('#movingDivs').append(newElement);
        loadMovingUIState();
        $('#groupMemberListPopout').fadeIn(animation_duration);
        dragElement(newElement);
        $('#groupMemberListPopoutClose').off('click').on('click', function () {
            $('#groupMemberListPopout').fadeOut(animation_duration, () => { $('#groupMemberListPopout').remove(); });
        });

        // Re-add pagination not working in popout
        printGroupMembers();
    } else {
        console.debug('saw existing popout, removing');
        $('#groupMemberListPopout').fadeOut(animation_duration, () => { $('#groupMemberListPopout').remove(); });
    }
}

jQuery(() => {
    ensureGroupEditorLayout();
    initGroupSpeakerControls();
    if (!CSS.supports('field-sizing', 'content')) {
        $(document).on('input', '#rm_group_chats_block .autoSetHeight', function () {
            resetScrollHeight($(this));
        });
    }

    $(document).on('click', '.group_select', async function (event) {
        const actionButton = $(event.target).closest('[data-entity-action]');
        if (actionButton.length) {
            event.preventDefault();
            event.stopImmediatePropagation();

            const groupId = $(this).attr('data-chid') || $(this).attr('data-grid');
            const action = actionButton.attr('data-entity-action');
            if (!groupId || !['open-chat', 'edit-group'].includes(action)) {
                return;
            }

            const didOpenGroup = await openGroupById(groupId, { switchMenu: false });
            if (!didOpenGroup) {
                return;
            }

            if (action === 'open-chat') {
                globalThis.NeconyanShell?.closeWorkspace?.();
            } else {
                globalThis.NeconyanShell?.openTab?.('characters', 'editor');
            }
            return;
        }

        const isCharactersBlockClick = $(this).closest('#rm_print_characters_block').length > 0;
        const shouldCloseCharacterMenu = isCharactersBlockClick && (globalThis.NeconyanShell?.isMobileViewport?.() ?? true);
        const groupId = $(this).attr('data-chid') || $(this).attr('data-grid');
        // Neconyan: drawer selection flashes Editor instead of opening it.
        const didOpenGroup = await openGroupById(groupId, { switchMenu: false });
        if (didOpenGroup && isCharactersBlockClick) {
            pulseSelectedEntityCard(this);
            globalThis.NeconyanShell?.highlightCharacterEditorTab?.();
        }
        if (shouldCloseCharacterMenu) {
            globalThis.NeconyanShell?.closeCharacters?.();
        }
    });
    $('#rm_group_filter').on('input', filterGroupMembers);
    $('#rm_group_members_filter').on('input', filterGroupMemberList);
    $('#rm_group_submit').on('click', createGroup);
    $('#sb_group_cancel').on('click', () => {
        globalThis.NeconyanShell?.openTab?.('characters', 'groups');
    });
    $('#rm_group_quick_create').on('click', createQuickGroupFromSelectedMembers);
    $('#rm_group_scenario').on('click', setCharacterSettingsOverrides);
    $('#rm_group_hidemutedsprites').on('input', function () {
        const value = $(this).prop('checked');
        hideMutedSprites = value;
        onHideMutedSpritesClick(value);
    });
    $('#groupCurrentMemberPopoutButton').on('click', doCurMemberListPopout);
    $('#rm_group_chat_name').on('input', onGroupNameInput);
    $('#rm_button_selected_ch h2').on('click', async function (event) {
        if (menu_type !== 'group_edit' || !openGroupId) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        await renameOpenGroup();
    });
    $('#rm_group_delete').off().on('click', onDeleteGroupClick);
    $('#group_favorite_button').on('click', onFavoriteGroupClick);
    $('#rm_group_allow_self_responses').on('input', onGroupSelfResponsesClick);
    $('#rm_group_keep_own_lines').on('input', onGroupKeepOwnLinesClick);
    $('#rm_group_ensemble_replies').on('input', async function () {
        const group = groups.find(item => item.id === openGroupId);
        if (group) {
            group.ensemble_replies = Boolean($(this).prop('checked'));
            await editGroup(openGroupId, false, false);
        }
    });
    $('#rm_group_activation_strategy').on('change', onGroupActivationStrategyInput);
    $('#rm_group_director_profile').on('change', onGroupDirectorProfileInput);
    $('#rm_group_talk_burst').on('change', onGroupTalkBurstInput);
    $('#rm_group_generation_mode').on('change', onGroupGenerationModeInput);
    $('#rm_group_generation_mode_join_prefix').on('input', onGroupGenerationModeTemplateInput);
    $('#rm_group_generation_mode_join_suffix').on('input', onGroupGenerationModeTemplateInput);
    $('#group_avatar_button').on('input', uploadGroupAvatar);
    $('#rm_group_restore_avatar').on('click', restoreGroupAvatar);
    $(document).on('click', '.group_member .right_menu_button', onGroupActionClick);
    $(document).on('click', '#rm_group_add_members .group_member', onGroupCandidateRowClick);
    $(document).on('change', '.group_member_model_input', onGroupMemberModelInput);
    eventSource.on(event_types.CHAT_CHANGED, updateGroupSpeakerControls);
    eventSource.on(event_types.GROUP_UPDATED, updateGroupSpeakerControls);
});
