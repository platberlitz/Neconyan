import { initializeNeconyanHome, NECONYAN_WHISKERS } from './neconyan-home.js';
import { characters, chat, deleteCharacterChatByName, displayVersion, doNewChat, event_types, eventSource, flushCharacterSaveDebounced, getCharacters, getChatGeneration, getCurrentChatId, getRequestHeaders, getThumbnailUrl, is_send_press, newAssistantChat, openCharacterChat, printCharactersDebounced, renameGroupOrCharacterChat, saveSettings, saveSettingsDebounced, selectCharacterById, setActiveCharacter, setActiveGroup, system_avatar, this_chid } from '../script.js';
import { deleteGroupChatByName, getGroupAvatar, groups, is_group_generating, openGroupById, openGroupChat } from './group-chats.js';
import { extension_settings } from './extensions.js';
import { t, translate } from './i18n.js';
import { getCurrentUserHandle } from './user.js';

import { isIOSWebKitPlatform } from './mobile-send-button.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { renderTemplateAsync } from './templates.js';
import { syncNeconyanAssistantTools } from './neconyan-assistant-tools.js';

import { accountStorage } from './util/AccountStorage.js';
import { getAssistantGender, getAssistantTourSrc, setAssistantGender } from './neconyan-assistant-art.js';
import { clamp, flashHighlight, getSortableDelay, isElementInViewport, sortMoments, timestampToMoment } from './utils.js';

const assistantAvatarKey = 'assistant';
const assistantVariantKey = 'neconyanAssistantVariant';
const pinnedChatsKey = 'pinnedChats';

const tutorialStatusKey = 'NeconyanTutorialStatus.v1';
const tutorialIndexKey = 'NeconyanTutorialIndex.v1';
const tutorialHiddenKey = 'NeconyanTutorialHidden.v1';
const welcomePanelModeKey = 'WelcomePage_PanelMode';

let activeTutorialPanel = null;
let welcomeRequestId = 0;
let assistantCatalogPromise = null;
let assistantSelectionPending = false;

const AGENT_MESSAGE_EXTRA_KEY = 'inChatAgents';
const AGENT_PROMPT_TRANSFORM_HISTORY_KEY = 'inChatAgentTransformHistory';

const WELCOME_TUTORIAL_STEPS = Object.freeze([
    { speaker: 'Miso', image: 'img/neconyan/tour/tour-01-miso-connect.webp?v=20260916-assistants', title: 'First paws: connect a model', body: 'Meowlcome~! Before anything else, you need something, that LLM thing, to connect to Neconyan before you can get to talk. This still feels like magic to me, I get so excited every single time!\nCheck **Connections** to select a provider and paste your key in after deciding on the backend.', hint: 'Take your time finding the key! I once waited forty minutes waiting for the train at the other side, so… hehe. Tell me if it connects, I wanna cheer!', actions: [{ label: 'Open connections', type: 'open-tab', value: 'left:api' }] },
    { speaker: 'Miso', image: 'img/neconyan/tour/tour-02-miso-characters.webp?v=20260916-assistants', title: 'Meet your chat pal', body: 'Now, who are we meeting? This is my favourite part, honestly! Create a character or import one, then choose Open chat, and if a line on the card reads wrong later, Edit card is where you change what is written on it.', hint: 'Taro, Nori and I can draft a card or suggest an edit when your model supports tools, but we ask first and you approve every change; nothing is saved until you say so. I will still be excited about it, but I will wait until you say the magic word yes!', actions: [{ label: 'Open characters', type: 'open-characters-menu' }, { label: 'Try a temporary chat', type: 'open-temporary-chat' }] },
    { speaker: 'Taro', image: 'img/neconyan/tour/tour-03-taro-modes.webp?v=20260916-assistants', title: 'Four ways to chat', body: 'Four workspaces, each with one job: Roleplay is the usual chat, Conversation is reminiscent of Signal and Telegram, Meower is a social media, and Story Mode gives you a co-writing interface.', hint: 'Switch whenever you like, because your draft survives the move; I expected it to, and then I checked, which is the order I prefer, and the order matters purr me. … Tell me that was funny.', actions: [{ label: 'Use Roleplay', type: 'open-roleplay' }, { label: 'Open Conversation', type: 'open-conversation' }, { label: 'Open Meower', type: 'open-meower' }, { label: 'Open Story Mode', type: 'open-story' }] },
    { speaker: 'Nori', image: 'img/neconyan/tour/tour-04-nori-lorebooks.webp?v=20260916-assistants', title: 'A purrfect place for every detail', body: 'That side character with the terrible secret deserves an address, so make a lorebook, then add entries with the keywords that should pull them into a scene; folders are how you find them again once the pile grows.', hint: 'Back to library keeps your draft, and deleting a folder drops its books into Unfiled rather than the bin, so the character is out of my paper pile but still in the story. I would claim I invented libraries, but I am lying; the pile was here first.', actions: [{ label: 'Open lorebooks', type: 'open-tab', value: 'characters:world-info' }] },
    { speaker: 'Taro', image: 'img/neconyan/tour/tour-05-taro-agents.webp?v=20260916-assistants', title: 'Give Agents a paw', body: 'Each agent has a job you specify, or pick a built-in one created by our maker. I’m paw-sitive this will improve your roleplaying and writing experience. Check for any agents you might like, transfer the trackers to Companion if you so wish… just make sure to leave me some fish.', hint: '… Okay, I can explain better. They can change your reply or run alongside the generation as extra context. Happy, hmm?', actions: [{ label: 'Open agents', type: 'open-tab', value: 'left:agents' }, { label: 'Model presets', type: 'open-tab', value: 'left:presets' }] },
    { speaker: 'Nori', image: 'img/neconyan/tour/tour-06-nori-extensions.webp?v=20260916-assistants', title: 'Find your extra tools', body: 'Neconyan has its own included tools and extensions. You can see ‘em in the sidebar, no problem. The third-party extensions you install are in Extensions. Wow, who’da thunk?', hint: 'Make sure to check first if any of the bundled tools fit your purpose before scouring around for others. I’m territorial, you know… hehe, kidding!', actions: [{ label: 'Open extensions', type: 'open-tab', value: 'right:extensions' }] },
    { speaker: 'Miso', image: 'img/neconyan/tour/tour-07-miso-home.webp?v=20260916-assistants', title: 'Make yourself at home', body: 'Come in properly and put your cup down!\nCheck the Appearance for ways to, well, you guessed it, change the look of Neconyan. Don’t worry, you can change it any time!\nIf you want the kitty and the ears to stop moving, make sure to check Reduced Motion.', hint: 'What’s your favourite colour? Mine’s orange! Maybe we can match~?', actions: [{ label: 'Open appearance', type: 'open-tab', value: 'right:settings' }] },
    { speaker: 'Taro', image: 'img/neconyan/tour/tour-08-taro-sampling.webp?v=20260916-assistants', title: 'Find it, then fine-tune it', body: 'Change one setting, then look at what happened before you change the next. Search finds a control by name, and Sampling shows which settings your provider and model will actually accept.', hint: 'Turning every slider at once is a poor experiment, however satisfying, because you learn nothing about which one helped. Your saved sampler values stay put when you switch models.', actions: [{ label: 'Search settings', type: 'open-global-search' }, { label: 'Open sampling', type: 'open-tab', value: 'left:sampling' }] },
    { speaker: 'Miso, Taro and Nori', title: 'We’re here to help!', body: 'You can replay the tour any time from Home → Home layout, and if you have any questions, come chat with any of us. We’re purr-eaty much available 24/7!', ending: true, actions: [] },
]);

const WELCOME_PANEL_MODES = Object.freeze({
    full: 'full',
    compact: 'compact',
    list: 'list',
});
const recentChatsSettingsKey = 'recentChatsSettings';

const DEFAULT_MAX_DISPLAYED = 15;
const DEFAULT_COLLAPSED_DISPLAYED = 3;

/**
 * Gets the current recent chats settings from account storage.
 * @returns {{ maxDisplayed: number, collapsedDisplayed: number }}
 */
function getRecentChatsSettings() {
    const value = accountStorage.getItem(recentChatsSettingsKey);
    if (value) {
        try {
            const parsed = JSON.parse(value);
            return {
                maxDisplayed: Math.max(1, parseInt(parsed.maxDisplayed) || DEFAULT_MAX_DISPLAYED),
                collapsedDisplayed: Math.max(1, parseInt(parsed.collapsedDisplayed) || DEFAULT_COLLAPSED_DISPLAYED),
            };
        } catch {
            // Ignore parse errors
        }
    }
    return { maxDisplayed: DEFAULT_MAX_DISPLAYED, collapsedDisplayed: DEFAULT_COLLAPSED_DISPLAYED };
}

/**
 * Saves recent chats settings to account storage.
 * @param {{ maxDisplayed: number, collapsedDisplayed: number }} settings
 */
function saveRecentChatsSettings(settings) {
    accountStorage.setItem(recentChatsSettingsKey, JSON.stringify(settings));
}

/**
 * @typedef {Pick<RecentChat, 'group' | 'avatar' | 'file_name' | 'is_conversation' | 'conversation_branch_id'>} PinnedChat
 */

/**
 * Manages pinned chat storage and operations.
 */
class PinnedChatsManager {
    /** @type {Record<string, PinnedChat> | null} */
    static #cachedState = null;

    /**
     * Initializes the cached state from storage.
     * Should be called once on app init.
     */
    static init() {
        this.#cachedState = this.#loadFromStorage();
    }

    /**
     * Loads state from storage.
     * @returns {Record<string, PinnedChat>}
     */
    static #loadFromStorage() {
        const pinnedState = /** @type {Record<string, PinnedChat>} */ ({});
        const value = accountStorage.getItem(pinnedChatsKey);
        if (value) {
            try {
                Object.assign(pinnedState, JSON.parse(value));
            } catch (error) {
                console.warn('Failed to parse pinned chats from storage.', error);
            }
        }
        return pinnedState;
    }

    /**
     * Generates a key for pinned chat storage.
     * @param {Partial<RecentChat>} recentChat Recent chat data
     * @returns {string} Key for pinned chat storage
     */
    static getKey(recentChat) {
        if (recentChat.is_conversation && recentChat.conversation_branch_id) {
            const ownerKey = recentChat.group ? `group_${recentChat.group}` : `char_${recentChat.avatar || ''}`;
            return `conversation_${ownerKey}_branch_${recentChat.conversation_branch_id}`;
        }
        return `${recentChat.group ? 'group_' + recentChat.group : ''}${recentChat.avatar ? 'char_' + recentChat.avatar : ''}_${recentChat.file_name}`;
    }

    /**
     * Gets the pinned chat state from cache.
     * @returns {Record<string, PinnedChat>}
     */
    static getState() {
        if (this.#cachedState === null) {
            this.#cachedState = this.#loadFromStorage();
        }
        return this.#cachedState;
    }

    /**
     * Saves the pinned chat state to storage and updates cache.
     * @param {Record<string, PinnedChat>} state The state to save
     */
    static #saveState(state) {
        this.#cachedState = state;
        accountStorage.setItem(pinnedChatsKey, JSON.stringify(state));
    }

    /**
     * Checks if a chat is pinned.
     * @param {RecentChat} recentChat Recent chat data
     * @returns {boolean} True if the chat is pinned, false otherwise
     */
    static isPinned(recentChat) {
        const pinKey = this.getKey(recentChat);
        const pinState = this.getState();
        return pinKey in pinState;
    }

    /**
     * Toggles the pinned state of a chat.
     * @param {RecentChat} recentChat Recent chat data
     * @param {boolean} pinned New pinned state
     */
    static toggle(recentChat, pinned) {
        const pinKey = this.getKey(recentChat);
        const pinState = { ...this.getState() };
        if (pinned) {
            pinState[pinKey] = {
                group: recentChat.group,
                avatar: recentChat.avatar,
                file_name: recentChat.file_name,
                is_conversation: recentChat.is_conversation,
                conversation_branch_id: recentChat.conversation_branch_id,
            };
        } else {
            delete pinState[pinKey];
        }
        this.#saveState(pinState);
    }

    /**
     * Removes a deleted chat from pinned storage.
     * @param {{ avatar?: string, group?: string, fileName: string }} chat Chat identity
     */
    static removeDeleted({ avatar = '', group = '', fileName }) {
        const pinState = { ...this.getState() };
        const normalizedFileName = String(fileName).replace(/\.jsonl$/i, '');
        let changed = false;

        for (const [key, pinnedChat] of Object.entries(pinState)) {
            if (pinnedChat.is_conversation) {
                continue;
            }
            const pinnedFileName = String(pinnedChat.file_name || '').replace(/\.jsonl$/i, '');
            const matchesOwner = group
                ? String(pinnedChat.group || '') === String(group)
                : String(pinnedChat.avatar || '') === String(avatar);
            if (pinnedFileName === normalizedFileName && matchesOwner) {
                delete pinState[key];
                changed = true;
            }
        }

        if (changed) {
            this.#saveState(pinState);
        }
    }

    /**
     * Removes one exact chat from pinned storage.
     * @param {RecentChat} recentChat Recent chat data
     */
    static remove(recentChat) {
        const pinKey = this.getKey(recentChat);
        const pinState = { ...this.getState() };
        if (!(pinKey in pinState)) {
            return;
        }
        delete pinState[pinKey];
        this.#saveState(pinState);
    }

    /**
     * Migrates pinned state when a chat is renamed.
     * @param {Partial<RecentChat>} recentChat Recent chat data (with original file_name)
     * @param {string} newFileName New file name after rename
     */
    static rename(recentChat, newFileName) {
        const oldKey = this.getKey(recentChat);
        const pinState = { ...this.getState() };
        if (!(oldKey in pinState)) {
            return;
        }
        const updatedChat = { ...recentChat, file_name: newFileName };
        const newKey = this.getKey(updatedChat);
        pinState[newKey] = {
            ...pinState[oldKey],
            group: recentChat.group,
            avatar: recentChat.avatar,
            file_name: newFileName,
        };
        if (oldKey !== newKey) {
            delete pinState[oldKey];
        }
        this.#saveState(pinState);
    }

    /**
     * Gets all pinned chats.
     * @returns {PinnedChat[]}
     */
    static getAll() {
        const pinState = this.getState();
        return Object.values(pinState).filter(pinnedChat => !pinnedChat.is_conversation);
    }
}

export function getPermanentAssistantAvatar() {
    const avatar = accountStorage.getItem(assistantAvatarKey);
    return characters.some(character => character.avatar === avatar) ? avatar : null;
}

function getPermanentAssistantVariant() {
    const variant = accountStorage.getItem(assistantVariantKey);
    return typeof variant === 'string' && variant ? variant : null;
}

function normalizeAssistantCatalog(payload) {
    if (!Array.isArray(payload?.personalities)) return [];
    return payload.personalities.map(personality => ({
        id: String(personality?.id || ''),
        name: String(personality?.name || ''),
        role: String(personality?.role || ''),
        summary: String(personality?.summary || ''),
        variants: Array.isArray(personality?.variants) ? personality.variants.map(variant => {
            const installed = Array.isArray(variant?.installed)
                ? variant.installed.filter(record => record?.avatar)
                    .sort((left, right) => Number(left.version || 0) - Number(right.version || 0))
                : [];
            const hasCurrentCopy = installed.some(record => Number(record.version) >= Number(variant?.bundledVersion));
            const update = hasCurrentCopy ? null : installed.find(record => record.updateAvailable) || null;
            return {
                id: String(variant?.id || ''),
                gender: String(variant?.gender || 'neutral'),
                pronouns: String(variant?.pronouns || ''),
                portrait: String(variant?.portrait || ''),
                installedAvatar: update?.avatar || '',
                updateAvailable: Boolean(update),
                bundledVersion: Number(variant?.bundledVersion || 0),
            };
        }).filter(variant => variant.id && variant.portrait) : [],
    })).filter(personality => personality.id && personality.name && personality.variants.length);
}

function fetchAssistantCatalog({ retry = false } = {}) {
    if (retry) assistantCatalogPromise = null;
    assistantCatalogPromise ??= fetch('/api/characters/assistants', { headers: getRequestHeaders() })
        .then(response => {
            if (!response.ok) throw new Error(`Assistant catalog request failed: ${response.status}`);
            return response.json();
        })
        .then(normalizeAssistantCatalog)
        .catch(error => {
            console.warn('Neconyan assistant catalog unavailable.', error);
            return null;
        });
    return assistantCatalogPromise;
}

function isWelcomePanelMode(mode) {
    return Object.values(WELCOME_PANEL_MODES).includes(mode);
}

function getWelcomePanelMode() {
    const storedMode = getWelcomeUiPreference(welcomePanelModeKey) || WELCOME_PANEL_MODES.full;
    return isWelcomePanelMode(storedMode) ? storedMode : WELCOME_PANEL_MODES.full;
}

function getWelcomeUiPreference(key) {
    const accountValue = accountStorage.getItem(key);
    if (accountValue !== null || key === tutorialStatusKey || key === tutorialIndexKey || key === tutorialHiddenKey) {
        return accountValue;
    }

    try {
        const localValue = globalThis.localStorage?.getItem(key) ?? null;

        if (localValue !== null) {
            accountStorage.setItem(key, localValue);
            return localValue;
        }
    } catch {
        // Fall through to the account-backed preference.
    }

    return accountStorage.getItem(key);
}

function setWelcomeUiPreference(key, value) {
    const stringValue = String(value);
    accountStorage.setItem(key, stringValue);
    if (key === tutorialStatusKey || key === tutorialIndexKey || key === tutorialHiddenKey) return;

    try {
        globalThis.localStorage?.setItem(key, stringValue);
    } catch {
        // Ignore storage access failures and keep the account-backed preference.
    }
}

function restoreWelcomeUiPreference(key, value) {
    if (value === null || value === undefined) {
        accountStorage.removeItem(key);
        try {
            globalThis.localStorage?.removeItem(key);
        } catch {
            // Ignore storage access failures and keep the account-backed preference.
        }
        return;
    }

    setWelcomeUiPreference(key, value);
}

function buildWelcomeTemplateData(chats, assistantPersonalities = null) {
    const welcomePanelMode = getWelcomePanelMode();
    const conversationStage = document.getElementById('sb_conversation_stage');
    const hasActiveConversation = document.getElementById('sheld')?.dataset.sbConversationMode === 'on'
        && conversationStage instanceof HTMLElement
        && !conversationStage.hidden;
    const hasActiveChat = getCurrentChatId() !== undefined || Boolean(document.querySelector('#chat .mes')) || hasActiveConversation;
    const assistantVariant = getPermanentAssistantVariant();
    const pickerPersonalities = Array.isArray(assistantPersonalities)
        ? assistantPersonalities.map(personality => ({
            ...personality,
            genderLegend: t`${personality.name} gender`,
            variants: personality.variants.map(variant => ({ ...variant, label: assistantGenderLabel(variant.gender), selected: variant.gender === getAssistantGender(personality.id) })),
            initialPortrait: personality.variants.find(variant => variant.gender === getAssistantGender(personality.id))?.portrait || '',
        }))
        : assistantPersonalities;

    return {
        chats,
        assistantPersonalities: pickerPersonalities,
        assistantVariant,
        empty: !chats.length,
        hasActiveChat,
        version: displayVersion,
        more: chats.length > getRecentChatsSettings().collapsedDisplayed,
        welcomePanelMode,
        welcomePanelFull: welcomePanelMode === WELCOME_PANEL_MODES.full,
        welcomePanelCompact: welcomePanelMode === WELCOME_PANEL_MODES.compact,
        welcomePanelListOnly: welcomePanelMode === WELCOME_PANEL_MODES.list,
        separateAgentRecentChats: shouldSeparateAgentRecentChats(),
    };
}

async function highlightLaunchpadItem(extensionId) {
    return Boolean(extensionId) && openShellTab('right:extensions');
}

globalThis.NeconyanShell = /** @type {any} */ (globalThis.NeconyanShell || {});
globalThis.NeconyanShell.highlightLaunchpadItem = highlightLaunchpadItem;

/**
 * Gets the filter bucket used by the Recent Chats tabs.
 * @param {RecentChat} chat Recent chat data
 * @returns {'agent'|'group'|'conversation'|'individual'}
 */
function getRecentChatType(chat) {
    if (chat.is_agent) {
        return 'agent';
    }

    if (chat.is_group) {
        return 'group';
    }

    if (chat.is_conversation) {
        return 'conversation';
    }

    return 'individual';
}

/**
 * Gets the filter bucket for a rendered Recent Chat item.
 * @param {Element} item Recent chat element
 * @returns {'agent'|'group'|'conversation'|'individual'}
 */
function getRecentChatItemType(item) {
    if (item instanceof HTMLElement && ['agent', 'group', 'conversation', 'individual'].includes(item.dataset.recentChatType || '')) {
        return /** @type {'agent'|'group'|'conversation'|'individual'} */ (item.dataset.recentChatType);
    }

    if (item.classList.contains('agent')) {
        return 'agent';
    }

    if (item.classList.contains('conversation')) {
        return 'conversation';
    }

    if (item.classList.contains('group')) {
        return 'group';
    }

    return 'individual';
}

/**
 * Applies the Recent Chats tab filter and per-filter collapsed state.
 * @param {HTMLElement} root Welcome panel root
 * @param {object} [options] Options
 * @param {boolean} [options.expanded] Whether all chats in the active filter should be shown
 */
function getExpandedRecentChatFilters(root) {
    return new Set((root.dataset.expandedRecentChatFilters || '').split(',').filter(Boolean));
}

function updateRecentChatFilterView(root, { expanded } = {}) {
    const filter = root.dataset.recentChatFilter || 'all';
    const expandedFilters = getExpandedRecentChatFilters(root);
    if (typeof expanded === 'boolean') {
        if (expanded) {
            expandedFilters.add(filter);
        } else {
            expandedFilters.delete(filter);
        }
        root.dataset.expandedRecentChatFilters = [...expandedFilters].join(',');
    }
    const filterExpanded = expandedFilters.has(filter);
    const chatItems = Array.from(root.querySelectorAll('.recentChat'));
    const { collapsedDisplayed } = getRecentChatsSettings();
    let matchingCount = 0;

    chatItems.forEach((chatItem) => {
        const chatType = getRecentChatItemType(chatItem);
        const matchesFilter = filter === 'all' || chatType === filter;
        const hiddenByLimit = matchesFilter && !filterExpanded && matchingCount >= collapsedDisplayed;

        if (matchesFilter) {
            matchingCount++;
        }

        chatItem.classList.toggle('recentChatFiltered', !matchesFilter);
        chatItem.classList.toggle('hidden', hiddenByLimit);
    });

    root.querySelectorAll('[data-recent-chat-empty-state="filtered"]').forEach((emptyState) => {
        emptyState.classList.toggle('displayNone', filter === 'all' || matchingCount > 0 || chatItems.length === 0);
    });

    root.querySelectorAll('button.showMoreChats').forEach((button) => {
        const hasMoreChats = matchingCount > collapsedDisplayed;
        const expandedAndVisible = filterExpanded && hasMoreChats;
        button.classList.toggle('displayNone', !hasMoreChats);
        button.classList.toggle('rotated', expandedAndVisible);
        button.setAttribute('aria-expanded', String(expandedAndVisible));
        button.textContent = expandedAndVisible ? 'Show fewer chats' : 'Show more chats';
        button.setAttribute('title', expandedAndVisible ? t`Show fewer recent chats` : t`Show more recent chats`);
    });
}

function setRecentChatFilter(root, filter) {
    root.dataset.recentChatFilter = filter;
    root.querySelectorAll('[data-recent-chat-filter]').forEach((button) => {
        const active = button.getAttribute('data-recent-chat-filter') === filter;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    updateRecentChatFilterView(root);
}

function openShellTab(route) {
    // Neconyan: accept historical launcher routes while opening relocated
    // World Info in the Characters panel instead of the old left shell.
    const normalizedRoute = route === 'left:world-info' ? 'characters:world-info' : route;
    const [shellKey, tabId] = String(normalizedRoute || '').split(':');

    if (!shellKey || !tabId) {
        return false;
    }

    if (globalThis.NeconyanShell?.openTab) {
        globalThis.NeconyanShell.openTab(shellKey, tabId);
        return true;
    }

    const fallbackRoute = {
        'left:presets': { selector: '#ai-config-button > .drawer-toggle', shellRoot: '#left-nav-panel' },
        'left:sampling': { selector: '#ai-config-button > .drawer-toggle', shellRoot: '#left-nav-panel', tabId: 'sampling' },
        'left:api': { selector: '#sys-settings-button > .drawer-toggle', shellRoot: '#left-nav-panel' },
        'left:agents': { selector: '#ai-config-button > .drawer-toggle', shellRoot: '#left-nav-panel', tabId: 'agents' },
        'characters:world-info': { selector: '#WI-SP-button > .drawer-toggle' },
        'right:settings': { selector: '#user-settings-button > .drawer-toggle', shellRoot: '#user-settings-block' },
        'right:extensions': { selector: '#extensions-settings-button > .drawer-toggle', shellRoot: '#user-settings-block' },
        'characters:persona': { selector: '#persona-management-button > .drawer-toggle' },
        'right:background': { selector: '#backgrounds-button > .drawer-toggle', shellRoot: '#user-settings-block' },
    }[normalizedRoute];

    if (!fallbackRoute) {
        return false;
    }

    const fallback = document.querySelector(fallbackRoute.selector);
    const shellRoot = fallbackRoute.shellRoot ? document.querySelector(fallbackRoute.shellRoot) : null;
    if (!(shellRoot instanceof HTMLElement) || !shellRoot.classList.contains('openDrawer')) {
        fallback?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    if (fallback && fallbackRoute.tabId) {
        window.requestAnimationFrame(() => {
            document.querySelector(`.sb-shell-tab[data-sb-tab="${fallbackRoute.tabId}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    }
    return Boolean(fallback);
}

function focusWelcomeControl(route) {
    globalThis.NeconyanShell?.focusTab?.(route);
}

function focusSendTextarea(sendTextArea, { skipIOS = false } = {}) {
    if (skipIOS && isIOSWebKitPlatform()) {
        return;
    }

    if (sendTextArea instanceof HTMLTextAreaElement) {
        sendTextArea.focus({ preventScroll: true });
    }
}

// Neconyan divergence: suppress the legacy chat shell briefly while Conversation Mode takes over from welcome-screen recent-chat entry points.
const conversationWelcomeOpeningVisibilityKey = 'sbConversationWelcomeOpeningVisibility';

function setConversationWelcomeOpeningSuppressed(suppressed) {
    [document.getElementById('chat'), document.getElementById('form_sheld')].forEach((element) => {
        if (!(element instanceof HTMLElement)) {
            return;
        }

        if (suppressed) {
            if (!(conversationWelcomeOpeningVisibilityKey in element.dataset)) {
                element.dataset[conversationWelcomeOpeningVisibilityKey] = element.style.visibility || 'default';
            }
            element.style.visibility = 'hidden';
            return;
        }

        if (!(conversationWelcomeOpeningVisibilityKey in element.dataset)) {
            return;
        }

        const previousVisibility = element.dataset[conversationWelcomeOpeningVisibilityKey] || 'default';
        element.style.visibility = previousVisibility === 'default' ? '' : previousVisibility;
        delete element.dataset[conversationWelcomeOpeningVisibilityKey];
    });
}

function clearConversationWelcomeOpeningSuppressionAfterRender() {
    const clearSuppression = () => setConversationWelcomeOpeningSuppressed(false);
    if (typeof requestAnimationFrame !== 'function') {
        setTimeout(clearSuppression, 0);
        return;
    }

    requestAnimationFrame(() => requestAnimationFrame(clearSuppression));
}

function setWelcomePanelMode(root, mode, { persist = true } = {}) {
    if (!(root instanceof HTMLElement)) {
        return;
    }

    const safeMode = isWelcomePanelMode(mode) ? mode : WELCOME_PANEL_MODES.full;

    root.dataset.homePanelMode = safeMode;
    root.classList.toggle('welcomePanel--compact', safeMode === WELCOME_PANEL_MODES.compact);
    root.classList.toggle('welcomePanel--listOnly', safeMode === WELCOME_PANEL_MODES.list);

    root.querySelectorAll('[data-welcome-panel-mode-target]').forEach((button) => {
        const isActive = button.getAttribute('data-welcome-panel-mode-target') === safeMode;
        button.classList.toggle('is-active', isActive);

        if (button instanceof HTMLButtonElement) {
            button.setAttribute('aria-pressed', String(isActive));
        }
    });

    if (persist) {
        setWelcomeUiPreference(welcomePanelModeKey, safeMode);
    }
}

function bindTourImageFallbacks(panel) {
    if (!(panel instanceof HTMLElement)) return;
    panel.querySelectorAll('img[data-tour-image]').forEach(image => {
        if (!(image instanceof HTMLImageElement) || image.dataset.tourFallbackBound === 'true') return;
        image.dataset.tourFallbackBound = 'true';
        const showFallback = () => {
            image.hidden = true;
            const fallback = image.nextElementSibling;
            if (fallback instanceof HTMLElement) {
                fallback.hidden = false;
                fallback.removeAttribute('aria-hidden');
            }
        };
        image.addEventListener('error', showFallback);
        image.addEventListener('load', () => {
            image.hidden = false;
            if (image.nextElementSibling) image.nextElementSibling.hidden = true;
        });
        if (image.getAttribute('src') && image.complete && image.naturalWidth === 0) showFallback();
    });
}

function setTutorialUiState(panel, index, expanded, { persist = true } = {}) {
    if (!(panel instanceof HTMLElement)) {
        return;
    }

    const safeIndex = clamp(Number.parseInt(index, 10) || 0, 0, WELCOME_TUTORIAL_STEPS.length - 1);
    panel.dataset.tutorialIndex = String(safeIndex);
    panel.dataset.tutorialExpanded = String(expanded);
    if (persist) {
        setWelcomeUiPreference(tutorialIndexKey, String(safeIndex));
    }
    syncTutorialCoachmark(panel);
}

function removeTutorialCoachmark() {
    activeTutorialPanel = null;
    document.getElementById('neconyan-tour-coachmark')?.remove();
    document.body.classList.remove('neconyan-tour-active');
}

function buildTourParagraph(text) {
    const paragraph = document.createElement('p');
    String(t([text])).split('**').forEach((segment, index) => {
        if (!segment) return;
        if (index % 2 === 1) {
            const strong = document.createElement('strong');
            strong.textContent = segment;
            paragraph.append(strong);
        } else {
            paragraph.append(document.createTextNode(segment));
        }
    });
    return paragraph;
}

function renderTourCopy(host, text) {
    if (!(host instanceof HTMLElement)) return;
    host.parentElement?.querySelectorAll('[data-tour-extra-copy]').forEach(node => node.remove());
    const paragraphs = String(text ?? '').split('\n').filter(line => line.trim());
    if (!paragraphs.length) {
        host.replaceChildren();
        return;
    }
    host.replaceChildren(...buildTourParagraph(paragraphs[0]).childNodes);
    let anchor = host;
    for (const line of paragraphs.slice(1)) {
        const extra = buildTourParagraph(line);
        extra.dataset.tourExtraCopy = '';
        anchor.after(extra);
        anchor = extra;
    }
}

function syncTutorialCoachmark(panel) {
    const coachmark = document.getElementById('neconyan-tour-coachmark');
    if (!(coachmark instanceof HTMLElement) || activeTutorialPanel !== panel) {
        return;
    }

    const index = Number.parseInt(panel.dataset.tutorialIndex || '0', 10) || 0;
    const count = WELCOME_TUTORIAL_STEPS.length;
    const step = WELCOME_TUTORIAL_STEPS[index];
    coachmark.classList.toggle('neconyan-tour-ending', Boolean(step.ending));
    coachmark.querySelector('[data-tour-coach-step]').textContent = t`Step ${index + 1} of ${count}`;
    coachmark.querySelector('[data-tour-coach-title]').textContent = t([step.title]);
    renderTourCopy(coachmark.querySelector('[data-tour-coach-body]'), step.body);
    const hint = coachmark.querySelector('[data-tour-coach-hint]');
    hint.textContent = step.hint ? t([step.hint]) : '';
    hint.hidden = !step.hint;
    coachmark.querySelector('[data-tour-coach-speaker]').textContent = step.speaker;
    const portraits = coachmark.querySelector('[data-tour-portraits]');
    portraits.replaceChildren();
    for (const guide of step.ending ? [WELCOME_TUTORIAL_STEPS[1], WELCOME_TUTORIAL_STEPS[2], WELCOME_TUTORIAL_STEPS[5]] : [step]) {
        const figure = document.createElement('figure');
        figure.innerHTML = '<div class="neconyan-tour-step-visual"><img width="512" height="768" data-tour-image><span class="neconyan-tour-image-fallback" hidden aria-hidden="true">🐾</span></div><figcaption></figcaption>';
        const image = figure.querySelector('img');
        image.dataset.assistantTourImage = guide.image;
        image.src = getAssistantTourSrc(guide.image);
        image.alt = t`${guide.speaker} speaking`;
        figure.querySelector('figcaption').textContent = step.ending ? guide.speaker : '';
        portraits.append(figure);
    }
    bindTourImageFallbacks(coachmark);
    coachmark.querySelector('[data-tour-paw-stamp]').hidden = !step.ending;
    const actionHost = coachmark.querySelector('[data-tour-coach-actions]');
    if (actionHost instanceof HTMLElement) {
        actionHost.replaceChildren();
        step.actions.forEach((definition) => {
            const action = document.createElement('button');
            action.type = 'button';
            action.className = 'menu_button';
            action.textContent = t([definition.label]);
            action.dataset.action = definition.type;
            action.dataset.actionValue = definition.value || '';
            if (definition.type === 'open-global-search') action.dataset.sbUniversalSearchTrigger = 'true';
            action.addEventListener('click', async () => {
                try {
                    await handleWelcomeAction(action);
                } catch (error) {
                    console.error('Tour action failed:', error);
                    toastr.error(t`Could not open that view. Try again.`);
                }
            });
            actionHost.append(action);
        });
    }
    const next = coachmark.querySelector('[data-tour-coach-next]');
    if (next instanceof HTMLButtonElement) {
        next.textContent = index >= count - 1 ? t`Finish` : t`Next`;
    }
    const back = coachmark.querySelector('[data-tour-coach-back]');
    if (back instanceof HTMLButtonElement) {
        back.disabled = index === 0;
    }
    coachmark.querySelector('[data-tour-content]').scrollTop = 0;
}

window.addEventListener('neconyan:assistant-gender-changed', () => {
    document.querySelectorAll('img[data-assistant-tour-image]').forEach(image => {
        image.src = getAssistantTourSrc(image.dataset.assistantTourImage);
    });
});

function showTutorialCoachmark() {
    let coachmark = document.getElementById('neconyan-tour-coachmark');
    if (!(coachmark instanceof HTMLElement)) {
        coachmark = document.createElement('aside');
        coachmark.id = 'neconyan-tour-coachmark';
        coachmark.className = 'neconyan-tour-coachmark';
        coachmark.setAttribute('role', 'region');
        coachmark.setAttribute('aria-label', 'Neconyan interactive tutorial');
        coachmark.innerHTML = `
            <strong>Neconyan tour</strong>
            <span data-tour-coach-step aria-live="polite"></span>
            <div data-tour-content><div class="neconyan-tour-coach-dialogue">
                <div data-tour-portraits></div>
                <div class="neconyan-tour-step-copy"><span class="neconyan-tour-speaker" data-tour-coach-speaker></span><strong data-tour-coach-title></strong><p data-tour-coach-body aria-live="polite"></p><p data-tour-coach-hint aria-live="polite" hidden></p><i class="fa-solid fa-paw" data-tour-paw-stamp hidden aria-hidden="true"></i></div>
            </div>
            <div data-tour-coach-actions></div></div>
            <div class="neconyan-tour-coachmark-actions">
                <button type="button" class="menu_button menu_button_icon" data-tour-coach-home>Home</button>
                <button type="button" class="menu_button menu_button_icon" data-tour-coach-back>Back</button>
                <button type="button" class="menu_button menu_button_icon" data-tour-coach-skip>Skip</button>
                <button type="button" class="menu_button menu_button_icon" data-tour-coach-next>Next</button>
            </div>
        `;
        coachmark.querySelector('[data-tour-coach-home]')?.addEventListener('click', () => {
            globalThis.NeconyanShell?.showHome?.();
        });
        coachmark.querySelector('[data-tour-coach-back]')?.addEventListener('click', () => {
            if (!activeTutorialPanel) return;
            const index = Number.parseInt(activeTutorialPanel.dataset.tutorialIndex || '0', 10) || 0;
            setTutorialUiState(activeTutorialPanel, index - 1, true);
        });
        coachmark.querySelector('[data-tour-coach-next]')?.addEventListener('click', () => {
            if (!activeTutorialPanel) return;
            const index = Number.parseInt(activeTutorialPanel.dataset.tutorialIndex || '0', 10) || 0;
            const lastIndex = WELCOME_TUTORIAL_STEPS.length - 1;
            if (index >= lastIndex) {
                dismissTutorial(activeTutorialPanel, 'completed');
                return;
            }
            setTutorialUiState(activeTutorialPanel, index + 1, true);
        });
        coachmark.querySelector('[data-tour-coach-skip]')?.addEventListener('click', () => {
            if (activeTutorialPanel) {
                dismissTutorial(activeTutorialPanel, 'skipped');
            }
        });
        document.body.append(coachmark);
    }
    activeTutorialPanel = coachmark;
    document.body.classList.add('neconyan-tour-active');
    setTutorialUiState(coachmark, getWelcomeUiPreference(tutorialIndexKey) || 0, true, { persist: false });
}

function resumeTutorial() {
    const status = getWelcomeUiPreference(tutorialStatusKey);
    if (status !== null && !['completed', 'skipped'].includes(status) && getWelcomeUiPreference(tutorialHiddenKey) !== 'true') {
        showTutorialCoachmark();
    }
}

async function activateNeconyanModeFromWelcome(mode) {
    if (typeof globalThis.NeconyanShell?.activateMode === 'function') {
        return globalThis.NeconyanShell.activateMode(mode);
    }

    window.dispatchEvent(new CustomEvent('sb:activate-neconyan-mode', { detail: { mode } }));
    return false;
}

async function openRoleplayWorkspaceFromWelcome() {
    return activateNeconyanModeFromWelcome('roleplay');
}

async function dismissTutorial(panel, status) {
    if (!(panel instanceof HTMLElement) || !status || panel.dataset.tutorialSaving === 'true') {
        return false;
    }

    const previousStatus = getWelcomeUiPreference(tutorialStatusKey);
    const previousIndex = getWelcomeUiPreference(tutorialIndexKey);
    const previousExpanded = panel.dataset.tutorialExpanded !== 'false';
    const controls = [...panel.querySelectorAll('button')].map(button => [button, button.disabled]);
    panel.dataset.tutorialSaving = 'true';
    controls.forEach(([button]) => { button.disabled = true; });
    if (status) {
        setWelcomeUiPreference(tutorialStatusKey, status);
    }

    const currentIndex = Number.parseInt(panel.dataset.tutorialIndex || '0', 10) || 0;
    try {
        if (await saveSettings(0, { returnResult: true }) !== true) {
            throw new Error('Tutorial preference was not acknowledged by the server.');
        }
    } catch (error) {
        restoreWelcomeUiPreference(tutorialStatusKey, previousStatus);
        restoreWelcomeUiPreference(tutorialIndexKey, previousIndex);
        const restoredIndex = Number.parseInt(previousIndex ?? String(currentIndex), 10) || 0;
        setTutorialUiState(panel, restoredIndex, previousExpanded, { persist: false });
        if (previousExpanded) {
            showTutorialCoachmark(panel);
        } else {
            removeTutorialCoachmark();
        }
        console.error('Could not save the tutorial preference:', error);
        globalThis.toastr?.error?.('The tour is still here. Try again when the connection is ready.');
        return false;
    } finally {
        delete panel.dataset.tutorialSaving;
        controls.forEach(([button, disabled]) => { button.disabled = disabled; });
    }

    setTutorialUiState(panel, currentIndex, false, { persist: false });
    removeTutorialCoachmark();
    return true;
}

/* The archive extension owns the drawer, so reuse its launcher button for every entry point. */
function openNeconyanChatArchive() {
    const launcher = document.getElementById('sbca_drawer_button');
    if (launcher instanceof HTMLElement) {
        launcher.click();
        return true;
    }
    globalThis.toastr?.info?.('Chat Archive is still loading.', 'Chat Archive');
    return false;
}

async function handleWelcomeAction(button) {
    const action = button.dataset.action || '';
    const value = button.dataset.actionValue || '';
    switch (action) {
        case 'toggle-assistants': {
            const picker = button.closest('[data-assistant-picker]');
            if (!picker) break;
            const expanded = picker.classList.toggle('is-expanded');
            button.setAttribute('aria-expanded', String(expanded));
            button.textContent = expanded ? t`Hide assistants` : t`Show assistants`;
            break;
        }
        case 'resume-chat':
            globalThis.NeconyanShell?.closeWorkspace?.();
            hideWelcomeHome();
            focusActiveComposer();
            break;
        case 'open-tab':
            openShellTab(value);
            focusWelcomeControl(value);
            break;
        case 'open-temporary-chat':
            await openNeconyanTemporaryChat();
            break;
        case 'open-roleplay':
            await openRoleplayWorkspaceFromWelcome();
            break;
        case 'open-conversation': {
            await activateNeconyanModeFromWelcome('conversation');
            break;
        }
        case 'open-meower':
        case 'open-story': {
            await activateNeconyanModeFromWelcome(action === 'open-meower' ? 'meower' : 'story');
            break;
        }
        case 'open-characters-menu':
        case 'open-import-characters':
            globalThis.NeconyanShell?.openCharacters?.();
            break;
        case 'open-global-search':
            globalThis.NeconyanShell?.openGlobalSearch?.({ focusInput: true });
            break;
        case 'open-chat-archive':
            openNeconyanChatArchive();
            break;
        case 'replay-tutorial':
            if (activeTutorialPanel?.dataset.tutorialSaving === 'true') break;
            setWelcomeUiPreference(tutorialStatusKey, 'pending');
            setWelcomeUiPreference(tutorialHiddenKey, '');
            setWelcomeUiPreference(tutorialIndexKey, '0');
            showTutorialCoachmark();
            activeTutorialPanel.querySelector('[data-tour-coach-next]')?.focus();
            break;
    }
}

/**
 * Opens a welcome screen if no chat is currently active.
 * @param {object} param Additional parameters
 * @param {boolean} [param.force] If true, opens Home while a chat is active.
 * @param {boolean} [param.expand] If true, expands the recent chats section.
 * @returns {Promise<void>}
 */
export async function openWelcomeScreen({ force = false, expand = false } = {}) {
    const requestId = ++welcomeRequestId;
    const currentChatId = getCurrentChatId();
    const hasActiveChat = currentChatId !== undefined || chat.length > 0;
    if (hasActiveChat && !force) {
        concealWelcomeHome();
        return;
    }

    const [recentChats, assistantPersonalities] = await Promise.all([
        getRecentChats(),
        fetchAssistantCatalog(),
    ]);
    const chatAfterFetch = getCurrentChatId();
    if (chatAfterFetch !== currentChatId || requestId !== welcomeRequestId) {
        console.debug('Chat changed while fetching recent chats.');
        return;
    }

    await sendWelcomePanel(recentChats, expand, requestId, assistantPersonalities);
}

function assistantGenderLabel(gender) {
    return ({ male: t`Male`, female: t`Female`, neutral: t`Neutral` })[gender] || gender;
}

function setAssistantPickerBusy(root, busy) {
    root.dataset.assistantBusy = String(busy);
    root.querySelectorAll('[data-assistant-variant], [data-assistant-open], [data-assistant-update]').forEach(control => {
        control.disabled = busy || (control.matches('[data-assistant-open]') && !control.dataset.assistantVariant);
    });
}

function updateAssistantPickerRow(row) {
    const selected = row.querySelector('input[data-assistant-variant]:checked');
    const button = row.querySelector('[data-assistant-open]');
    const portrait = row.querySelector('[data-assistant-portrait]');
    const label = row.querySelector('[data-assistant-action-label]');
    const status = row.querySelector('[data-assistant-selection]');
    const name = row.dataset.assistantName || 'assistant';
    const gender = selected?.dataset.gender || '';
    const variant = selected?.value || '';
    row.dataset.selectedAssistantVariant = variant;
    row.classList.toggle('is-selected', Boolean(selected));
    if (button instanceof HTMLButtonElement) {
        button.dataset.assistantVariant = variant;
        button.disabled = !selected || row.closest('[data-assistant-picker]')?.dataset.assistantBusy === 'true';
        button.setAttribute('aria-label', selected ? t`Open ${name}, ${assistantGenderLabel(gender)}` : t`Choose a gender for ${name}`);
    }
    if (portrait instanceof HTMLImageElement && selected?.dataset.portrait) {
        portrait.src = selected.dataset.portrait;
        portrait.alt = `${name}, ${assistantGenderLabel(gender)}`;
    }
    if (label) label.textContent = selected ? t`Open ${name}, ${assistantGenderLabel(gender)}` : t`Choose a gender`;
    if (status) status.textContent = selected ? t`${assistantGenderLabel(gender)} selected.` : '';
}

function setAssistantPickerStatus(root, message, error = false) {
    const status = root.querySelector('[data-assistant-picker-status]');
    if (!(status instanceof HTMLElement)) return;
    status.textContent = message;
    status.classList.toggle('is-error', error);
}

function assertAssistantOpeningCurrent(origin) {
    if (origin.account !== getCurrentUserHandle() || origin.generation !== getChatGeneration() || is_send_press || is_group_generating) {
        throw new Error('The workspace changed. Your installed assistant is available in Characters.');
    }
}

async function activateInstalledAssistant(assistantId, result, origin) {
    assertAssistantOpeningCurrent(origin);
    const previousAvatar = accountStorage.getItem(assistantAvatarKey);
    const previousVariant = accountStorage.getItem(assistantVariantKey);
    extension_settings.expressionOverrides ??= [];
    const overrides = extension_settings.expressionOverrides;
    let addedOverride;
    let shortcutAssigned = false;
    let opened = false;
    try {
        if (await flushCharacterSaveDebounced() === false) throw new Error('Save the current character before opening an assistant.');
        assertAssistantOpeningCurrent(origin);
        await getCharacters();
        assertAssistantOpeningCurrent(origin);
        const characterId = characters.findIndex(character => character.avatar === result.avatar);
        if (characterId < 0) throw new Error('The installed assistant was not returned by the character list.');

        const avatarStem = result.avatar.replace(/\.[^/.]+$/, '');
        if (!overrides.some(override => override?.name === avatarStem)) {
            addedOverride = { name: avatarStem, path: result.spriteFolder };
            overrides.push(addedOverride);
        }
        accountStorage.setItem(assistantAvatarKey, result.avatar);
        accountStorage.setItem(assistantVariantKey, assistantId);
        shortcutAssigned = true;
        if (await saveSettings(0, { returnResult: true }) !== true) throw new Error('The assistant was installed, but its shortcut could not be saved.');
        assertAssistantOpeningCurrent(origin);
        if (!await selectCharacterById(characterId, { switchMenu: false })) throw new Error('The assistant was installed, but its chat could not be opened.');
        opened = true;
        if (origin.account !== getCurrentUserHandle() || characters[this_chid]?.avatar !== result.avatar) return;
        setActiveCharacter(result.avatar);
        syncNeconyanAssistantTools();
        saveSettingsDebounced();
        globalThis.NeconyanShell?.closeWorkspace?.();
        hideWelcomeHome();
        focusSendTextarea(document.getElementById('send_textarea'), { skipIOS: true });
    } catch (error) {
        if (!opened && shortcutAssigned && origin.account === getCurrentUserHandle()
            && accountStorage.getItem(assistantAvatarKey) === result.avatar && accountStorage.getItem(assistantVariantKey) === assistantId) {
            if (previousAvatar === null) accountStorage.removeItem(assistantAvatarKey); else accountStorage.setItem(assistantAvatarKey, previousAvatar);
            if (previousVariant === null) accountStorage.removeItem(assistantVariantKey); else accountStorage.setItem(assistantVariantKey, previousVariant);
            if (addedOverride && overrides.includes(addedOverride) && addedOverride.path === result.spriteFolder) overrides.splice(overrides.indexOf(addedOverride), 1);
            try {
                if (await saveSettings(0, { returnResult: true }) !== true) throw new Error('Shortcut recovery failed.');
            } catch {
                error.message += ' The previous shortcut could not be saved; retry before reloading.';
            }
        }
        throw error;
    }
}

async function updateSelectedAssistant(root, button) {
    if (!(root instanceof HTMLElement) || !(button instanceof HTMLButtonElement) || assistantSelectionPending) return;
    if (is_send_press || is_group_generating) {
        setAssistantPickerStatus(root, 'Stop the current reply before installing an update.', true);
        return;
    }
    const assistantId = button.dataset.assistantId || '';
    const installedAvatar = button.dataset.assistantUpdateAvatar || '';
    const label = button.dataset.assistantLabel || 'assistant';
    const origin = { account: getCurrentUserHandle(), generation: getChatGeneration() };
    if (!assistantId || !installedAvatar) return;

    const review = document.createElement('div');
    const heading = document.createElement('p');
    heading.textContent = 'Install this assistant update?';
    const target = document.createElement('p');
    target.textContent = `A new copy of ${label} will be created. Your installed card and chats will be kept.`;
    review.append(heading, target);
    if (await callGenericPopup(review, POPUP_TYPE.CONFIRM, '', { wide: true }) !== POPUP_RESULT.AFFIRMATIVE) return;

    assistantSelectionPending = true;
    setAssistantPickerBusy(root, true);
    setAssistantPickerStatus(root, `Preparing an updated ${label} copy...`);
    try {
        assertAssistantOpeningCurrent(origin);
        const response = await fetch('/api/characters/assistants/update-copy', {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: assistantId, avatar: installedAvatar }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.avatar || !result.spriteFolder) throw new Error(result.error || 'The assistant update could not be installed.');
        assistantCatalogPromise = null;
        await activateInstalledAssistant(assistantId, result, origin);
    } catch (error) {
        console.error('Neconyan assistant update failed:', error);
        setAssistantPickerStatus(root, error instanceof Error ? error.message : 'The assistant update could not be installed. Try again.', true);
    } finally {
        assistantSelectionPending = false;
        setAssistantPickerBusy(root, false);
        root.querySelectorAll('.neconyan-assistant-row').forEach(updateAssistantPickerRow);
    }
}

async function openSelectedAssistant(root, row) {
    if (!(root instanceof HTMLElement) || !(row instanceof HTMLElement) || assistantSelectionPending) return;
    if (is_send_press || is_group_generating) {
        setAssistantPickerStatus(root, 'Stop the current reply before opening an assistant.', true);
        return;
    }
    const selected = row.querySelector('input[data-assistant-variant]:checked');
    if (!(selected instanceof HTMLInputElement) || !selected.value) {
        setAssistantPickerStatus(root, 'Choose Male, Female or Neutral first.', true);
        return;
    }

    const assistantId = selected.value;
    const origin = { account: getCurrentUserHandle(), generation: getChatGeneration() };
    const avatar = getPermanentAssistantAvatar();
    const previousVariant = getPermanentAssistantVariant();
    assistantSelectionPending = true;
    setAssistantPickerBusy(root, true);
    setAssistantPickerStatus(root, `Preparing ${row.dataset.assistantName || 'your assistant'}...`);
    try {
        const response = await fetch('/api/characters/assistants/install', {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: assistantId, preferred_avatar: previousVariant === assistantId ? avatar : undefined }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.avatar || !result.spriteFolder) {
            throw new Error(result.error || 'The assistant could not be installed.');
        }

        assistantCatalogPromise = null;
        await activateInstalledAssistant(assistantId, result, origin);
    } catch (error) {
        console.error('Neconyan assistant selection failed:', error);
        setAssistantPickerStatus(root, error instanceof Error ? error.message : 'The assistant could not be opened. Try again.', true);
    } finally {
        assistantSelectionPending = false;
        setAssistantPickerBusy(root, false);
        root.querySelectorAll('.neconyan-assistant-row').forEach(updateAssistantPickerRow);
        document.querySelectorAll('[data-assistant-picker]').forEach(picker => {
            setAssistantPickerBusy(picker, false);
            picker.querySelectorAll('.neconyan-assistant-row').forEach(updateAssistantPickerRow);
        });
    }
}

function initializeAssistantPicker(root) {
    const picker = root.querySelector('[data-assistant-picker]');
    if (!(picker instanceof HTMLElement)) return;
    setAssistantPickerBusy(picker, assistantSelectionPending);
    picker.querySelectorAll('.neconyan-assistant-row').forEach(row => {
        row.querySelectorAll('input[data-assistant-variant]').forEach(input => input.addEventListener('change', () => {
            setAssistantGender(row.dataset.assistantPersonality, input.dataset.gender);
            updateAssistantPickerRow(row);
            setAssistantPickerStatus(picker, `${row.dataset.assistantName || 'Assistant'} is ready to open.`);
        }));
        row.querySelector('[data-assistant-open]')?.addEventListener('click', () => void openSelectedAssistant(picker, row));
        row.querySelectorAll('[data-assistant-update]').forEach(button => button.addEventListener('click', () => void updateSelectedAssistant(picker, button)));
        updateAssistantPickerRow(row);
    });
    picker.querySelector('[data-assistant-catalog-retry]')?.addEventListener('click', async () => {
        const retry = picker.querySelector('[data-assistant-catalog-retry]');
        if (retry instanceof HTMLButtonElement) retry.disabled = true;
        setAssistantPickerStatus(picker, 'Trying the assistant catalog again...');
        await fetchAssistantCatalog({ retry: true });
        await refreshWelcomeScreen();
    });
}

/**
 * Sends the welcome panel to the chat.
 * @param {RecentChat[]} chats List of recent chats
 * @param {boolean} [expand=false] If true, expands the recent chats section
 * @param {number} requestId Current Home request; replaced requests cannot reopen it
 */
async function sendWelcomePanel(chats, expand, requestId, assistantPersonalities = null) {
    try {
        const chatElement = document.getElementById('chat');
        if (!chatElement) {
            console.error('Chat element not found');
            return;
        }
        const templateData = buildWelcomeTemplateData(chats, assistantPersonalities);
        const template = await renderTemplateAsync('/scripts/templates/welcomePanelOnboarding.html?v=20260930-kittyless1', templateData, true, true, true);
        if (requestId !== welcomeRequestId) {
            return;
        }
        const fragment = document.createRange().createContextualFragment(template);
        const nextPanel = fragment.querySelector('.welcomePanel');
        const welcomeHost = getWelcomeHost();
        if (!(welcomeHost instanceof HTMLElement)) {
            console.error('Neconyan Home host not found');
            return;
        }
        fragment.querySelectorAll('.welcomePanel').forEach((root) => {
            initializeNeconyanHome(root);
            initializeAssistantPicker(root);
            root.querySelectorAll('[data-welcome-panel-mode-target]').forEach((button) => {
                button.addEventListener('click', () => {
                    setWelcomePanelMode(root, button.getAttribute('data-welcome-panel-mode-target') || WELCOME_PANEL_MODES.full);
                });
            });
            root.querySelectorAll('[data-recent-chat-filter]').forEach((button) => {
                button.addEventListener('click', () => {
                    const filter = button.getAttribute('data-recent-chat-filter') || 'all';
                    setRecentChatFilter(root, filter);
                });
            });
            root.querySelectorAll('.recentChatsSettings').forEach((button) => {
                button.addEventListener('click', async (event) => {
                    event.stopPropagation();
                    await openRecentChatsSettingsPopup();
                });
            });

            setWelcomePanelMode(root, root.dataset.homePanelMode || getWelcomePanelMode(), { persist: false });
        });
        fragment.querySelectorAll('.welcomeActionButton').forEach((button) => {
            if (button.dataset.action === 'open-global-search') button.dataset.sbUniversalSearchTrigger = 'true';
            button.addEventListener('click', async (event) => {
                event.preventDefault();
                try {
                    await handleWelcomeAction(button);
                } catch (error) {
                    console.error('Home action failed:', error);
                    toastr.error(t`Could not open that view. Try again.`);
                }
            });
        });
        fragment.querySelectorAll('.recentChatOpen').forEach((button) => {
            button.addEventListener('click', () => {
                const item = button.closest('.recentChat');
                if (!(item instanceof HTMLElement)) {
                    return;
                }
                const avatarId = item.getAttribute('data-avatar');
                const groupId = item.getAttribute('data-group');
                const fileName = item.getAttribute('data-file');
                const isConversation = item.getAttribute('data-recent-chat-type') === 'conversation';
                if (isConversation && avatarId) {
                    const branchId = item.getAttribute('data-conversation-branch-id');
                    void openNeconyanRecentChat({ avatar: avatarId, group: groupId, conversation_branch_id: branchId, is_conversation: true });
                    return;
                }
                if (avatarId && fileName) {
                    void openNeconyanRecentChat({ avatar: avatarId, chat_name: fileName });
                }
                if (groupId && fileName) {
                    void openNeconyanRecentChat({ group: groupId, chat_name: fileName, is_group: true });
                }
            });
        });
        fragment.querySelectorAll('button.showMoreChats').forEach((button) => {
            const showRecentChatsTitle = t`Show more recent chats`;
            const hideRecentChatsTitle = t`Show fewer recent chats`;

            button.setAttribute('title', button.classList.contains('rotated') ? hideRecentChatsTitle : showRecentChatsTitle);
            button.addEventListener('click', () => {
                const rotate = button.classList.contains('rotated');
                const root = button.closest('.welcomePanel');
                if (root instanceof HTMLElement) {
                    updateRecentChatFilterView(root, { expanded: !rotate });
                }
                button.setAttribute('title', rotate ? showRecentChatsTitle : hideRecentChatsTitle);
            });
        });
        fragment.querySelectorAll('button.openTemporaryChat').forEach((button) => {
            button.addEventListener('click', openNeconyanTemporaryChat);
        });
        fragment.querySelectorAll('.recentChat.group').forEach((groupChat) => {
            const groupId = groupChat.getAttribute('data-group');
            const group = groups.find(x => x.id === groupId);
            if (group) {
                const avatar = groupChat.querySelector('.avatar');
                if (!avatar) {
                    return;
                }
                const groupAvatar = getGroupAvatar(group);
                $(avatar).replaceWith(groupAvatar);
            }
        });
        fragment.querySelectorAll('.recentChat .renameChat').forEach((renameButton) => {
            renameButton.addEventListener('click', (event) => {
                event.stopPropagation();
                const chatItem = renameButton.closest('.recentChat');
                if (!chatItem) {
                    return;
                }
                const avatarId = chatItem.getAttribute('data-avatar');
                const groupId = chatItem.getAttribute('data-group');
                const fileName = chatItem.getAttribute('data-file');
                const branchId = chatItem.getAttribute('data-conversation-branch-id');
                const branchName = chatItem.getAttribute('data-conversation-branch-name');
                if (chatItem.getAttribute('data-recent-chat-type') === 'conversation') {
                    if (avatarId && branchId && branchName) {
                        const recentChat = chats.find(chat => chat.is_conversation
                            && chat.avatar === avatarId
                            && String(chat.group || '') === String(groupId || '')
                            && chat.conversation_branch_id === branchId);
                        void renameRecentConversationChat(avatarId, groupId, branchId, branchName, recentChat);
                    }
                    return;
                }
                if (avatarId && fileName) {
                    void renameRecentCharacterChat(avatarId, fileName);
                }
                if (groupId && fileName) {
                    void renameRecentGroupChat(groupId, fileName);
                }
            });
        });
        fragment.querySelectorAll('.recentChat .deleteChat').forEach((deleteButton) => {
            deleteButton.addEventListener('click', (event) => {
                event.stopPropagation();
                const chatItem = deleteButton.closest('.recentChat');
                if (!chatItem) {
                    return;
                }
                const avatarId = chatItem.getAttribute('data-avatar');
                const groupId = chatItem.getAttribute('data-group');
                const fileName = chatItem.getAttribute('data-file');
                const branchId = chatItem.getAttribute('data-conversation-branch-id');
                if (chatItem.getAttribute('data-recent-chat-type') === 'conversation') {
                    if (avatarId && branchId) {
                        const recentChat = chats.find(chat => chat.is_conversation
                            && chat.avatar === avatarId
                            && String(chat.group || '') === String(groupId || '')
                            && chat.conversation_branch_id === branchId);
                        void deleteRecentConversationChat(avatarId, groupId, branchId, recentChat);
                    }
                    return;
                }
                if (avatarId && fileName) {
                    void deleteRecentCharacterChat(avatarId, fileName);
                }
                if (groupId && fileName) {
                    void deleteRecentGroupChat(groupId, fileName);
                }
            });
        });
        fragment.querySelectorAll('.recentChat .pinChat').forEach((pinButton) => {
            pinButton.addEventListener('click', async (event) => {
                event.stopPropagation();
                const chatItem = pinButton.closest('.recentChat');
                if (!chatItem) {
                    return;
                }
                const avatarId = chatItem.getAttribute('data-avatar');
                const groupId = chatItem.getAttribute('data-group');
                const fileName = chatItem.getAttribute('data-file');
                const branchId = chatItem.getAttribute('data-conversation-branch-id');
                const isConversation = chatItem.getAttribute('data-recent-chat-type') === 'conversation';
                const recentChat = chats.find(c => isConversation
                    ? c.is_conversation && c.avatar === avatarId && String(c.group || '') === String(groupId || '') && c.conversation_branch_id === branchId
                    : c.chat_name === fileName && ((c.is_group && c.group === groupId) || (!c.is_group && c.avatar === avatarId)));
                if (!recentChat) {
                    console.error('Recent chat not found for pinning.');
                    return;
                }
                const currentlyPinned = PinnedChatsManager.isPinned(recentChat);
                PinnedChatsManager.toggle(recentChat, !currentlyPinned);
                await refreshWelcomeScreen({ flashChat: recentChat });
            });
        });
        chatElement.querySelector('#neconyan-home-skeleton')?.remove();
        const existingPanel = welcomeHost.querySelector('.welcomePanel');
        if (existingPanel && nextPanel) {
            existingPanel.replaceWith(nextPanel);
        } else if (nextPanel) {
            welcomeHost.replaceChildren(nextPanel);
        }
        welcomeHost.querySelectorAll('.welcomePanel').forEach((root) => {
            if (root instanceof HTMLElement) {
                updateRecentChatFilterView(root);
            }
        });
        document.body.classList.add('neconyan-home-visible');
        window.NeconyanFrontendIcon?.apply?.();
        if (expand) {
            welcomeHost.querySelectorAll('button.showMoreChats').forEach((button) => {
                if (button instanceof HTMLButtonElement) {
                    button.click();
                }
            });
        }
    } catch (error) {
        console.error('Welcome screen error:', error);
    }
}

const NECONYAN_RAIL_COLLAPSED_KEY = 'NeconyanWorkspaceRailCollapsed.v1';
const NECONYAN_RAIL_ORDER_KEY = 'NeconyanWorkspaceRailOrder.v1';
const NECONYAN_ISSUES_URL = 'https://github.com/platberlitz/Neconyan/issues';
let neconyanRailOrder;
const neconyanRailGroups = {};
let neconyanRailRefreshId = 0;
let neconyanRailRefreshTimer = 0;

function normalizeNeconyanRailOrder(saved, defaults) {
    return [...new Set([...(Array.isArray(saved) ? saved : []).filter(id => defaults.includes(id)), ...defaults])];
}

function saveNeconyanRailOrder() {
    accountStorage.setItem(NECONYAN_RAIL_ORDER_KEY, JSON.stringify(neconyanRailOrder));
}

function applyNeconyanRailOrder() {
    const enabled = neconyanRailOrder.enabled;
    for (const [name, { host, buttons }] of Object.entries(neconyanRailGroups)) {
        neconyanRailOrder[name] = normalizeNeconyanRailOrder(neconyanRailOrder[name], [...buttons.keys()]);
        for (const id of neconyanRailOrder[name]) {
            const button = buttons.get(id);
            host.appendChild(button);
            if (enabled) button.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
            else button.removeAttribute('aria-keyshortcuts');
        }
        host.classList.toggle('neconyan-rail-reordering', enabled);
        $(host).sortable('option', 'disabled', !enabled);
    }
    document.querySelectorAll('[data-sb-rail-reorder-input]').forEach(input => {
        input.checked = enabled;
        input.disabled = false;
    });
    document.querySelectorAll('[data-sb-rail-order-reset]').forEach(button => { button.disabled = false; });
}

function setNeconyanRailReordering(enabled) {
    if (!neconyanRailOrder) return;
    neconyanRailOrder.enabled = Boolean(enabled);
    applyNeconyanRailOrder();
    saveNeconyanRailOrder();
}

function resetNeconyanRailOrder() {
    if (!neconyanRailOrder) return;
    for (const name of Object.keys(neconyanRailGroups)) neconyanRailOrder[name] = [];
    applyNeconyanRailOrder();
    saveNeconyanRailOrder();
}

function initializeNeconyanRailOrder(rail) {
    try {
        neconyanRailOrder = JSON.parse(accountStorage.getItem(NECONYAN_RAIL_ORDER_KEY));
    } catch { /* A malformed saved preference falls back to the default order. */ }
    neconyanRailOrder = { ...neconyanRailOrder, enabled: neconyanRailOrder?.enabled === true };
    const status = document.createElement('span');
    status.className = 'sr-only';
    status.setAttribute('role', 'status');
    rail.appendChild(status);
    for (const [name, selector] of Object.entries({ primary: '[data-neconyan-primary-nav]', advanced: '[data-neconyan-advanced-nav]', finer: '[data-neconyan-finer-nav]', modes: '[data-neconyan-mode-nav]' })) {
        const host = rail.querySelector(selector);
        const buttons = new Map([...host.children].map(button => [button.dataset.neconyanRoute || button.dataset.neconyanChatMode, button]));
        neconyanRailGroups[name] = { host, buttons };
        let suppressClickUntil = 0;
        const saveOrder = button => {
            neconyanRailOrder[name] = [...host.children].map(child => child.dataset.neconyanRoute || child.dataset.neconyanChatMode);
            saveNeconyanRailOrder();
            const position = [...host.children].indexOf(button) + 1;
            status.textContent = t`${button.getAttribute('aria-label')} moved to position ${position} of ${buttons.size}.`;
        };
        for (const button of buttons.values()) {
            const grip = document.createElement('span');
            grip.className = 'neconyan-rail-grip fa-solid fa-grip-vertical';
            grip.setAttribute('aria-hidden', 'true');
            grip.title = t`Drag to reorder`;
            button.appendChild(grip);
        }
        // Capture before the buttons' native navigation listeners and Touch Punch's synthetic click.
        host.addEventListener('click', event => {
            if (event.target.closest('.neconyan-rail-grip') || Date.now() < suppressClickUntil) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        }, true);
        host.addEventListener('keydown', event => {
            if (!neconyanRailOrder.enabled || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
            const button = event.target.closest('.neconyan-rail-button');
            if (button?.parentElement !== host) return;
            event.preventDefault();
            event.stopPropagation();
            const sibling = event.key === 'ArrowUp' ? button.previousElementSibling : button.nextElementSibling;
            if (!sibling) return;
            if (event.key === 'ArrowUp') host.insertBefore(button, sibling);
            else host.insertBefore(sibling, button);
            button.focus({ preventScroll: true });
            button.scrollIntoView({ block: 'nearest' });
            saveOrder(button);
        });
        $(host).sortable({
            items: '> .neconyan-rail-button', handle: '.neconyan-rail-grip', cancel: '',
            axis: 'y', containment: 'parent', delay: getSortableDelay(),
            disabled: true, tolerance: 'pointer',
            placeholder: 'neconyan-rail-placeholder',
            start: (_event, ui) => {
                ui.placeholder.outerHeight(ui.item.outerHeight());
                suppressClickUntil = Infinity;
            },
            stop: (_event, ui) => {
                suppressClickUntil = Date.now() + 400;
                saveOrder(ui.item[0]);
            },
        });
    }
    applyNeconyanRailOrder();
}

function isNeconyanRailCollapsed() {
    return accountStorage.getItem(NECONYAN_RAIL_COLLAPSED_KEY) === 'true';
}

function setNeconyanRailCollapsed(collapsed) {
    const nextCollapsed = Boolean(collapsed);
    accountStorage.setItem(NECONYAN_RAIL_COLLAPSED_KEY, String(nextCollapsed));
    document.documentElement.dataset.neconyanSidebar = nextCollapsed ? 'closed' : 'open';
    const toggle = document.getElementById('neconyan-sidebar-toggle');
    toggle?.setAttribute('aria-expanded', String(!nextCollapsed));
    toggle?.setAttribute('aria-label', nextCollapsed ? 'Expand sidebar' : 'Collapse sidebar');
    if (toggle instanceof HTMLButtonElement) {
        toggle.title = nextCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
        toggle.innerHTML = `<i class="fa-solid ${nextCollapsed ? 'fa-angles-right' : 'fa-angles-left'}" aria-hidden="true"></i>`;
    }
}

function createNeconyanRailButton({ label, icon, route = '', onClick }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'neconyan-rail-button';
    button.dataset.neconyanRoute = route;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i><span></span>`;
    button.querySelector('span').textContent = label;
    button.addEventListener('click', event => {
        event.preventDefault();
        onClick?.();
    });
    return button;
}

function createNeconyanRailModeButton(mode) {
    const label = mode === 'story' ? 'Story Mode' : mode[0].toUpperCase() + mode.slice(1);
    const icon = { roleplay: 'fa-masks-theater', conversation: 'fa-comments', meower: 'fa-paw', story: 'fa-feather-pointed' }[mode] || 'fa-circle';
    const button = createNeconyanRailButton({ label, icon, onClick: () => {
        const activation = globalThis.NeconyanShell?.activateMode?.(mode);
        if (activation === undefined) {
            window.dispatchEvent(new CustomEvent('sb:activate-neconyan-mode', { detail: { mode } }));
        }
    } });
    button.classList.add('neconyan-mode-button');
    button.removeAttribute('data-neconyan-route');
    button.dataset.neconyanChatMode = mode;
    button.setAttribute('aria-pressed', 'false');
    return button;
}

async function openNeconyanTemporaryChat() {
    if (is_send_press || is_group_generating) {
        toastr.info(t`Stop the current reply before starting a new chat.`);
        return false;
    }
    const sendTextArea = document.getElementById('send_textarea');
    focusSendTextarea(sendTextArea);
    await newAssistantChat({ temporary: true });
    globalThis.NeconyanShell?.closeWorkspace?.();
    hideWelcomeHome();
    focusSendTextarea(sendTextArea, { skipIOS: true });
    return true;
}

async function openNeconyanRecentChat(recentChat) {
    const chatFileName = recentChat?.chat_name || String(recentChat?.file_name || '').replace(/\.jsonl$/, '');
    let result;
    if (recentChat?.is_conversation) {
        result = await openRecentConversationChat(recentChat.avatar, recentChat.group, recentChat.conversation_branch_id);
    } else if (recentChat?.is_group) {
        result = await openRecentGroupChat(recentChat.group, chatFileName);
    } else {
        result = await openRecentCharacterChat(recentChat?.avatar, chatFileName);
    }
    if (result === true) globalThis.NeconyanShell?.closeWorkspace?.();
    return result;
}

function activateNeconyanRailRoute(route) {
    const shell = globalThis.NeconyanShell;
    switch (route) {
        case 'home':
            if (shell?.showHome) {
                return shell.showHome();
            }
            return openWelcomeScreen({ force: true });
        case 'new-chat':
            return openNeconyanTemporaryChat();
        case 'characters':
            shell?.openTab?.('characters', 'characters');
            break;
        case 'model':
            shell?.openTab?.('left', 'api');
            break;
        case 'presets':
            shell?.openTab?.('left', 'presets');
            break;
        case 'sampling':
            shell?.openTab?.('left', 'sampling');
            break;
        case 'formatting':
            shell?.openTab?.('left', 'advanced-formatting');
            break;
        case 'expressions':
            if (shell?.openIncludedTool?.('expressions')) break;
            void shell?.openExtensionSettings?.(route);
            break;
        case 'regex':
            void shell?.openExtensionSettings?.(route);
            break;
        case 'agents':
            shell?.openTab?.('left', 'agents');
            break;
        case 'mewmory':
            shell?.openTab?.('left', 'mewmory');
            break;
        case 'lorebooks':
            shell?.openTab?.('characters', 'world-info');
            break;
        case 'extensions':
            shell?.openTab?.('right', 'extensions');
            break;
        case 'persona':
            shell?.openTab?.('characters', 'persona');
            break;
        case 'pathfinder':
            void globalThis.NeconyanAgents?.openPathfinder?.();
            break;
        case 'dialogue-colors':
            void globalThis.NeconyanExtensions?.focusUnit?.('Dialogue Colors');
            break;
        case 'quick-image-gen':
            if (shell?.openIncludedTool?.('quick-image-gen')) break;
            shell?.openTab?.('right', 'extensions');
            void globalThis.NeconyanExtensions?.focusUnit?.('Quick Image Gen');
            break;
        case 'background':
            shell?.openTab?.('right', 'background');
            break;
        case 'settings':
            shell?.openTab?.('right', 'settings');
            break;
        case 'server':
        case 'console-logs':
            shell?.openTab?.('right', route);
            break;
        case 'search':
            shell?.openGlobalSearch?.({ focusInput: true });
            break;
        default:
            break;
    }
}

function getNeconyanRecentChatLabel(recentChat) {
    return String(recentChat?.chat_name || recentChat?.conversation_branch_name || 'Untitled chat').trim() || 'Untitled chat';
}

function renderNeconyanRailRecentChats(chats) {
    const recentHost = document.querySelector('#neconyan-workspace-rail [data-neconyan-recent-list]');
    if (!(recentHost instanceof HTMLElement)) {
        return;
    }

    recentHost.replaceChildren();
    const visibleChats = Array.isArray(chats) ? chats.slice(0, 6) : [];
    if (!visibleChats.length) {
        const empty = document.createElement('p');
        empty.className = 'neconyan-rail-empty';
        empty.textContent = 'No recent chats';
        recentHost.appendChild(empty);
        return;
    }

    for (const recentChat of visibleChats) {
        const label = getNeconyanRecentChatLabel(recentChat);
        const owner = String(recentChat.char_name || (recentChat.is_group ? 'Group chat' : 'Chat')).trim();
        const button = createNeconyanRailButton({
            label,
            icon: recentChat.is_conversation ? 'fa-comments' : recentChat.is_group ? 'fa-users' : 'fa-message',
            route: 'recent-chat',
            onClick: () => void openNeconyanRecentChat(recentChat),
        });
        button.dataset.neconyanRecentKey = PinnedChatsManager.getKey(recentChat);
        const detail = document.createElement('small');
        detail.textContent = owner;
        button.appendChild(detail);
        recentHost.appendChild(button);
    }
}

async function refreshNeconyanRail() {
    const rail = document.getElementById('neconyan-workspace-rail');
    if (!(rail instanceof HTMLElement)) {
        return;
    }

    const refreshId = ++neconyanRailRefreshId;
    try {
        const chats = await getRecentChats();
        if (refreshId === neconyanRailRefreshId) {
            renderNeconyanRailRecentChats(chats);
        }
    } catch (error) {
        console.warn('Failed to refresh Neconyan recent chats.', error);
    }
}

function scheduleNeconyanRailRefresh() {
    window.clearTimeout(neconyanRailRefreshTimer);
    neconyanRailRefreshTimer = window.setTimeout(() => {
        neconyanRailRefreshTimer = 0;
        void refreshNeconyanRail();
    }, 160);
}

function ensureNeconyanRail() {
    if (!document.body || document.getElementById('neconyan-workspace-rail')) {
        return;
    }

    const rail = document.createElement('aside');
    rail.id = 'neconyan-workspace-rail';
    rail.className = 'neconyan-workspace-rail';
    rail.setAttribute('aria-label', 'Neconyan workspace navigation');
    rail.innerHTML = `
        <div class="neconyan-rail-brand">
            <img src="img/icon-64x64.png" alt="" width="28" height="28">
            <span>Neconyan</span>
            <button id="neconyan-sidebar-toggle" class="neconyan-rail-icon-button" type="button" aria-label="Collapse sidebar" aria-expanded="true" title="Collapse sidebar">
                <i class="fa-solid fa-angles-left" aria-hidden="true"></i>
            </button>
        </div>
        <button class="neconyan-rail-new" type="button" data-neconyan-route="new-chat">
            <i class="fa-solid fa-plus" aria-hidden="true"></i><span>New chat</span>
            ${NECONYAN_WHISKERS}
        </button>
        <div class="neconyan-rail-scroll">
            <nav class="neconyan-rail-nav" aria-label="Workspace">
                <div class="neconyan-rail-section-label">Workspace</div>
                <div data-neconyan-primary-nav></div>
                <section class="neconyan-rail-advanced" aria-labelledby="neconyan-rail-advanced-title">
                    <div id="neconyan-rail-advanced-title" class="neconyan-rail-section-heading"><span>Fine-tuning</span></div>
                    <div data-neconyan-advanced-nav></div>
                </section>
                <section class="neconyan-rail-advanced neconyan-rail-finer" aria-labelledby="neconyan-rail-finer-title">
                    <div id="neconyan-rail-finer-title" class="neconyan-rail-section-heading"><span>Troubleshooting</span></div>
                    <div data-neconyan-finer-nav></div>
                </section>
                <div class="neconyan-rail-section-label neconyan-rail-modes-label">Modes</div>
                <div data-neconyan-mode-nav></div>
            </nav>
            <details class="neconyan-rail-tools">
                <summary id="neconyan-rail-tools-title" class="neconyan-native-tools-summary" aria-controls="neconyan-rail-tools-list" aria-expanded="false"><span>Included tools</span><i class="fa-solid fa-chevron-down neconyan-native-tools-chevron" aria-hidden="true"></i></summary>
                <div id="neconyan-rail-tools-list" class="neconyan-native-tool-list" data-neconyan-native-tool-list></div>
            </details>
            <div class="neconyan-rail-recent">
                <div class="neconyan-rail-section-heading"><span>Recent</span><button class="neconyan-rail-icon-button" type="button" data-neconyan-open-archive aria-label="Open Chat Archive" title="Open Chat Archive"><i class="fa-solid fa-box-archive" aria-hidden="true"></i></button><button class="neconyan-rail-icon-button" type="button" data-neconyan-refresh-recent aria-label="Refresh recent chats" title="Refresh recent chats"><i class="fa-solid fa-rotate" aria-hidden="true"></i></button></div>
                <div data-neconyan-recent-list></div>
            </div>
        </div>
        <div class="neconyan-rail-footer">
            <button class="neconyan-rail-footer-action" type="button" data-neconyan-route="search" data-sb-universal-search-trigger="true"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><span>Search</span><kbd>/</kbd></button>
            <button class="neconyan-rail-footer-action" type="button" data-neconyan-route="settings"><i class="fa-solid fa-gear" aria-hidden="true"></i><span>Settings</span></button>
        </div>
    `;

    const primaryNav = rail.querySelector('[data-neconyan-primary-nav]');
    const primaryRoutes = [
        ['home', 'Home', 'fa-house'],
        ['characters', 'Characters', 'fa-address-card'],
        ['model', 'Connections', 'fa-plug'],
        ['agents', 'Agents', 'fa-cat'],
        ['mewmory', 'Mewmory', 'fa-brain'],
        ['lorebooks', 'Lorebooks', 'fa-book-atlas'],
        ['extensions', 'Extensions', 'fa-cubes'],
    ];
    for (const [route, label, icon] of primaryRoutes) {
        primaryNav.appendChild(createNeconyanRailButton({
            label,
            icon,
            route,
            onClick: () => activateNeconyanRailRoute(route),
        }));
    }

    const modeNav = rail.querySelector('[data-neconyan-mode-nav]');
    if (modeNav instanceof HTMLElement) {
        for (const mode of ['roleplay', 'conversation', 'meower', 'story']) {
            modeNav.appendChild(createNeconyanRailModeButton(mode));
        }
    }

    const advancedNav = rail.querySelector('[data-neconyan-advanced-nav]');
    const advancedRoutes = [
        ['presets', 'Presets', 'fa-sliders'],
        ['sampling', 'Sampling', 'fa-wave-square'],
        ['formatting', 'Formatting', 'fa-text-height'],
        ['regex', translate('Regexes', 'ext_regex_title'), 'fa-code'],
        ['expressions', t`Character Expressions`, 'fa-masks-theater'],
        ['persona', 'Persona', 'fa-face-smile'],
        ['pathfinder', 'Pawthfinder', 'fa-diamond-turn-right'],
        ['dialogue-colors', 'Dialogue Colors', 'fa-palette'],
        ['quick-image-gen', 'Quick Image Gen', 'fa-image'],
        ['background', 'Background', 'fa-panorama'],
    ];
    for (const [route, label, icon] of advancedRoutes) {
        advancedNav.appendChild(createNeconyanRailButton({
            label,
            icon,
            route,
            onClick: () => activateNeconyanRailRoute(route),
        }));
    }

    const finerNav = rail.querySelector('[data-neconyan-finer-nav]');
    const finerRoutes = [
        ['server', 'Server', 'fa-server'],
        ['console-logs', 'Console Logs', 'fa-terminal'],
    ];
    for (const [route, label, icon] of finerRoutes) {
        finerNav.appendChild(createNeconyanRailButton({
            label,
            icon,
            route,
            onClick: () => activateNeconyanRailRoute(route),
        }));
    }
    const reportIssueButton = createNeconyanRailButton({
        label: 'Report an Issue',
        icon: 'fa-bug',
        route: 'report-issue',
        onClick: () => window.open(NECONYAN_ISSUES_URL, '_blank', 'noopener,noreferrer'),
    });
    reportIssueButton.title = 'Opens the Neconyan GitHub issues page in a new tab';
    finerNav.appendChild(reportIssueButton);

    rail.querySelector('[data-neconyan-route="new-chat"]').addEventListener('click', () => activateNeconyanRailRoute('new-chat'));
    rail.querySelectorAll('[data-neconyan-route="search"], [data-neconyan-route="settings"]').forEach(button => {
        button.addEventListener('click', () => activateNeconyanRailRoute(button.dataset.neconyanRoute));
    });
    rail.querySelector('[data-neconyan-refresh-recent]').addEventListener('click', () => void refreshNeconyanRail());
    rail.querySelector('[data-neconyan-open-archive]').addEventListener('click', () => openNeconyanChatArchive());
    const toolsDetails = rail.querySelector('.neconyan-rail-tools');
    const toolsSummary = rail.querySelector('.neconyan-rail-tools > .neconyan-native-tools-summary');
    toolsDetails?.addEventListener('toggle', () => {
        toolsSummary?.setAttribute('aria-expanded', String(toolsDetails.open));
        toolsSummary?.querySelector('.neconyan-native-tools-chevron')?.classList.toggle('is-open', toolsDetails.open);
    });
    rail.querySelector('#neconyan-sidebar-toggle').addEventListener('click', () => {
        const collapsed = document.documentElement.dataset.neconyanSidebar === 'closed';
        setNeconyanRailCollapsed(!collapsed);
    });

    document.body.insertBefore(rail, document.getElementById('sheld') || document.body.firstChild);
    initializeNeconyanRailOrder(rail);
    globalThis.NeconyanNativeTools?.mount?.();
    initializeNeconyanHome(rail);
    document.body.classList.add('neconyan-rail-ready');
    window.dispatchEvent(new Event('neconyan:rail-ready'));
    setNeconyanRailCollapsed(isNeconyanRailCollapsed());
    void refreshNeconyanRail();
}

function getWelcomeHost() {
    const sheld = document.getElementById('sheld');
    if (!(sheld instanceof HTMLElement)) {
        return document.getElementById('chat');
    }

    let host = document.getElementById('neconyan-home-host');
    if (!(host instanceof HTMLElement)) {
        host = document.createElement('div');
        host.id = 'neconyan-home-host';
        host.setAttribute('role', 'region');
        host.setAttribute('aria-label', 'Home');
        sheld.prepend(host);
    }

    return host;
}

export function concealWelcomeHome() {
    welcomeRequestId++;
    const wasVisible = document.body.classList.contains('neconyan-home-visible');
    document.body.classList.remove('neconyan-home-visible');
    if (wasVisible) {
        window.dispatchEvent(new Event('neconyan:home-hidden'));
    }
}

globalThis.NeconyanWelcome = {
    ...(globalThis.NeconyanWelcome ?? {}),
    concealHome: concealWelcomeHome,
    isRailReordering: () => neconyanRailOrder?.enabled,
    setRailReordering: setNeconyanRailReordering,
    resetRailOrder: resetNeconyanRailOrder,
};

export function hideWelcomeHome() {
    concealWelcomeHome();
    document.querySelector('.welcomePanel')?.remove();
}

function focusActiveComposer() {
    const conversationInput = document.getElementById('sb_conversation_input');
    const roleplayInput = document.getElementById('send_textarea');
    const activeComposer = conversationInput instanceof HTMLElement
        && document.getElementById('sheld')?.dataset.sbConversationMode === 'on'
        ? conversationInput
        : roleplayInput;
    activeComposer?.focus?.({ preventScroll: false });
}

/**
 * Opens a recent character chat.
 * @param {string} avatarId Avatar file name
 * @param {string} fileName Chat file name
 */
async function openRecentCharacterChat(avatarId, fileName) {
    const characterId = characters.findIndex(x => x.avatar === avatarId);
    if (characterId === -1) {
        console.error(`Character not found for avatar ID: ${avatarId}`);
        return false;
    }

    try {
        const selected = await selectCharacterById(characterId);
        if (!selected) {
            toastr.warning(t`Failed to open recent chat. See console for details.`);
            return false;
        }
        setActiveCharacter(avatarId);
        saveSettingsDebounced();
        const currentChatId = getCurrentChatId();
        if (currentChatId === fileName) {
            console.debug(`Chat ${fileName} is already open.`);
            hideWelcomeHome();
            return true;
        }
        await openCharacterChat(fileName);
        if (getCurrentChatId() === fileName) hideWelcomeHome();
        return getCurrentChatId() === fileName;
    } catch (error) {
        console.error('Error opening recent chat:', error);
        toastr.error(t`Failed to open recent chat. See console for details.`);
        return false;
    }
}

/**
 * Opens a character in Conversation Mode from the welcome page.
 * @param {string} avatarId Avatar file name
 * @param {string} groupId Group ID, when opening a group-scoped Conversation
 * @param {string} branchId Conversation branch ID
 */
async function openRecentConversationChat(avatarId, groupId = '', branchId = '') {
    const characterId = characters.findIndex(x => x.avatar === avatarId);
    if (characterId === -1) {
        console.error(`Character not found for avatar ID: ${avatarId}`);
        return false;
    }

    try {
        setConversationWelcomeOpeningSuppressed(true);
        const conversationModule = await import('./neconyan-conversation.js');
        const opened = conversationModule.openConversationWorkspaceForAvatar?.(avatarId, {
            branchId,
            groupId: groupId || null,
            showToast: false,
        });
        if (!opened) {
            setConversationWelcomeOpeningSuppressed(false);
            toastr.warning(t`Failed to open Conversation Mode for this chat.`);
            return false;
        }
        hideWelcomeHome();
        clearConversationWelcomeOpeningSuppressionAfterRender();
        return true;
    } catch (error) {
        setConversationWelcomeOpeningSuppressed(false);
        console.error('Error opening conversation chat:', error);
        toastr.error(t`Failed to open conversation chat. See console for details.`);
        return false;
    }
}

/**
 * Renames a Conversation Mode branch from the welcome page.
 * @param {string} avatarId Avatar file name
 * @param {string} groupId Group ID, when renaming a group-scoped Conversation
 * @param {string} branchId Conversation branch ID
 * @param {string} branchName Current branch name
 * @param {RecentChat|undefined} recentChat Recent chat record
 */
async function renameRecentConversationChat(avatarId, groupId, branchId, branchName, recentChat) {
    try {
        const popupText = await renderTemplateAsync('chatRename');
        const newName = await callGenericPopup(popupText, POPUP_TYPE.INPUT, branchName);
        if (!newName || typeof newName !== 'string' || newName === branchName) {
            return;
        }

        const conversationModule = await import('./neconyan-conversation.js');
        const renamed = conversationModule.renameConversationBranch?.(avatarId, branchId, newName, { groupId });
        if (!renamed) {
            toastr.warning(t`Failed to rename Conversation chat.`);
            return;
        }

        if (recentChat && !groupId) {
            PinnedChatsManager.rename(recentChat, newName.trim());
        }
        await refreshWelcomeScreen();
        toastr.success(t`Chat renamed.`);
    } catch (error) {
        console.error('Error renaming recent Conversation chat:', error);
        toastr.error(t`Failed to rename Conversation chat. See console for details.`);
    }
}

/**
 * Deletes a Conversation Mode branch from the welcome page.
 * @param {string} avatarId Avatar file name
 * @param {string} groupId Group ID, when deleting a group-scoped Conversation
 * @param {string} branchId Conversation branch ID
 * @param {RecentChat|undefined} recentChat Recent chat record
 */
async function deleteRecentConversationChat(avatarId, groupId, branchId, recentChat) {
    try {
        const confirm = await callGenericPopup(t`Delete the Chat File?`, POPUP_TYPE.CONFIRM);
        if (!confirm) {
            return;
        }

        const conversationModule = await import('./neconyan-conversation.js');
        const result = conversationModule.deleteConversationWelcomeBranch?.(avatarId, branchId, { groupId });
        const deleted = Boolean(result?.deleted);
        if (!deleted) {
            toastr.warning(t`Failed to delete Conversation chat.`);
            return;
        }

        if (recentChat) {
            PinnedChatsManager.remove(recentChat);
        }
        await refreshWelcomeScreen();
        if (!result.reset) {
            toastr.success(t`Chat deleted.`);
        }
    } catch (error) {
        console.error('Error deleting recent Conversation chat:', error);
        toastr.error(t`Failed to delete Conversation chat. See console for details.`);
    }
}

/**
 * Opens a recent group chat.
 * @param {string} groupId Group ID
 * @param {string} fileName Chat file name
 */
async function openRecentGroupChat(groupId, fileName) {
    const group = groups.find(x => x.id === groupId);
    if (!group) {
        console.error(`Group not found for ID: ${groupId}`);
        return false;
    }

    try {
        const selected = await openGroupById(groupId);
        if (!selected) {
            toastr.warning(t`Failed to open recent group chat. See console for details.`);
            return false;
        }
        setActiveGroup(groupId);
        saveSettingsDebounced();
        const currentChatId = getCurrentChatId();
        if (currentChatId === fileName) {
            console.debug(`Chat ${fileName} is already open.`);
            hideWelcomeHome();
            return true;
        }
        await openGroupChat(groupId, fileName);
        if (getCurrentChatId() === fileName) hideWelcomeHome();
        return getCurrentChatId() === fileName;
    } catch (error) {
        console.error('Error opening recent group chat:', error);
        toastr.error(t`Failed to open recent group chat. See console for details.`);
        return false;
    }
}

/**
 * Renames a recent character chat.
 * @param {string} avatarId Avatar file name
 * @param {string} fileName Chat file name
 */
async function renameRecentCharacterChat(avatarId, fileName) {
    const characterId = characters.findIndex(x => x.avatar === avatarId);
    if (characterId === -1) {
        console.error(`Character not found for avatar ID: ${avatarId}`);
        return;
    }
    try {
        const popupText = await renderTemplateAsync('chatRename');
        const newName = await callGenericPopup(popupText, POPUP_TYPE.INPUT, fileName);
        if (!newName || typeof newName !== 'string' || newName === fileName) {
            console.log('No new name provided, aborting');
            return;
        }
        await renameGroupOrCharacterChat({
            characterId: String(characterId),
            oldFileName: fileName,
            newFileName: newName,
            loader: false,
        });
        await refreshWelcomeScreen();
        toastr.success(t`Chat renamed.`);
    } catch (error) {
        console.error('Error renaming recent character chat:', error);
        toastr.error(t`Failed to rename recent chat. See console for details.`);
    }
}

/**
 * Renames a recent group chat.
 * @param {string} groupId Group ID
 * @param {string} fileName Chat file name
 */
async function renameRecentGroupChat(groupId, fileName) {
    const group = groups.find(x => x.id === groupId);
    if (!group) {
        console.error(`Group not found for ID: ${groupId}`);
        return;
    }
    try {
        const popupText = await renderTemplateAsync('chatRename');
        const newName = await callGenericPopup(popupText, POPUP_TYPE.INPUT, fileName);
        if (!newName || newName === fileName) {
            console.log('No new name provided, aborting');
            return;
        }
        await renameGroupOrCharacterChat({
            groupId: String(groupId),
            oldFileName: fileName,
            newFileName: String(newName),
            loader: false,
        });
        await refreshWelcomeScreen();
        toastr.success(t`Group chat renamed.`);
    } catch (error) {
        console.error('Error renaming recent group chat:', error);
        toastr.error(t`Failed to rename recent group chat. See console for details.`);
    }
}

/**
 * Deletes a recent character chat.
 * @param {string} avatarId Avatar file name
 * @param {string} fileName Chat file name
 */
async function deleteRecentCharacterChat(avatarId, fileName) {
    const characterId = characters.findIndex(x => x.avatar === avatarId);
    if (characterId === -1) {
        console.error(`Character not found for avatar ID: ${avatarId}`);
        return;
    }
    try {
        const confirm = await callGenericPopup(t`Delete the Chat File?`, POPUP_TYPE.CONFIRM);
        if (!confirm) {
            console.log('Deletion cancelled by user');
            return;
        }
        const deleted = await deleteCharacterChatByName(String(characterId), fileName);
        if (!deleted) {
            return;
        }
        PinnedChatsManager.removeDeleted({ avatar: avatarId, fileName });
        await refreshWelcomeScreen();
        toastr.success(t`Chat deleted.`);
    } catch (error) {
        console.error('Error deleting recent character chat:', error);
        toastr.error(t`Failed to delete recent chat. See console for details.`);
    }
}

/**
 * Deletes a recent group chat.
 * @param {string} groupId Group ID
 * @param {string} fileName Chat file name
 */
async function deleteRecentGroupChat(groupId, fileName) {
    const group = groups.find(x => x.id === groupId);
    if (!group) {
        console.error(`Group not found for ID: ${groupId}`);
        return;
    }
    try {
        const confirm = await callGenericPopup(t`Delete the Chat File?`, POPUP_TYPE.CONFIRM);
        if (!confirm) {
            console.log('Deletion cancelled by user');
            return;
        }
        const deleted = await deleteGroupChatByName(groupId, fileName);
        if (!deleted) {
            return;
        }
        PinnedChatsManager.removeDeleted({ group: groupId, fileName });
        await refreshWelcomeScreen();
        toastr.success(t`Group chat deleted.`);
    } catch (error) {
        console.error('Error deleting recent group chat:', error);
        toastr.error(t`Failed to delete recent group chat. See console for details.`);
    }
}

/**
 * Reopens the welcome screen and restores the scroll position.
 * @param {object} param Additional parameters
 * @param {RecentChat} [param.flashChat] Recent chat to flash (if any)
 * @returns {Promise<void>}
 */
async function refreshWelcomeScreen({ flashChat = null } = {}) {
    const chatElement = getWelcomeHost();
    if (!chatElement) {
        console.error('Chat element not found');
        return;
    }

    const scrollTop = chatElement.scrollTop;
    const scrollHeight = chatElement.scrollHeight;
    const currentPanel = getWelcomeHost()?.querySelector('.welcomePanel');
    const recentChatFilter = currentPanel instanceof HTMLElement ? currentPanel.dataset.recentChatFilter || 'all' : 'all';
    const expandedRecentChatFilters = currentPanel instanceof HTMLElement ? currentPanel.dataset.expandedRecentChatFilters || '' : '';

    await openWelcomeScreen({ force: true });
    scheduleNeconyanRailRefresh();

    const nextPanel = getWelcomeHost()?.querySelector('.welcomePanel');
    if (nextPanel instanceof HTMLElement) {
        nextPanel.dataset.recentChatFilter = recentChatFilter;
        nextPanel.dataset.expandedRecentChatFilters = expandedRecentChatFilters;
        nextPanel.querySelectorAll('[data-recent-chat-filter]').forEach((button) => {
            const active = button.getAttribute('data-recent-chat-filter') === recentChatFilter;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        updateRecentChatFilterView(nextPanel);
    }

    // Restore scroll position or flash specific chat
    if (flashChat) {
        const recentChats = Array.from(chatElement.querySelectorAll('.recentChat'));
        const chatToFlash = recentChats.find(el => {
            const file = el.getAttribute('data-file');
            const group = el.getAttribute('data-group');
            const avatar = el.getAttribute('data-avatar');
            return file === flashChat.chat_name &&
                ((flashChat.is_group && group === flashChat.group) || (!flashChat.is_group && avatar === flashChat.avatar));
        });
        if (chatToFlash instanceof HTMLElement) {
            if (!isElementInViewport(chatToFlash)) {
                chatElement.scrollTop = chatToFlash.offsetTop - chatElement.offsetTop - (chatToFlash.clientHeight / 2);
            }
            flashHighlight($(chatToFlash), 1000);
        }
    } else {
        // Restore scroll position
        chatElement.scrollTop = scrollTop + (chatElement.scrollHeight - scrollHeight);
    }
}

/**
 * Opens a popup to configure recent chats settings.
 */
async function openRecentChatsSettingsPopup() {
    const settings = getRecentChatsSettings();

    const MIN_CHATS = 1;
    const MAX_CHATS = 1000;

    /** @type {import('./popup.js').CustomPopupInput} */
    const maxRecentChatsInput = {
        id: 'maxRecentChats',
        type: 'number',
        label: t`Max recent chats`,
        tooltip: t`${MIN_CHATS} - ${MAX_CHATS}`,
        defaultState: String(settings.maxDisplayed),
        min: MIN_CHATS,
        max: MAX_CHATS,
        step: 1,
    };

    /** @type {import('./popup.js').CustomPopupInput} */
    const collapsedRecentChatsInput = {
        id: 'collapsedRecentChats',
        type: 'number',
        label: t`Collapsed recent chats`,
        tooltip: t`${MIN_CHATS} - ${MAX_CHATS}`,
        defaultState: String(settings.collapsedDisplayed),
        min: MIN_CHATS,
        max: MAX_CHATS,
        step: 1,
    };

    await callGenericPopup(t`Recent Chats Settings`, POPUP_TYPE.CONFIRM, null, {
        okButton: t`Save`,
        cancelButton: t`Cancel`,
        customInputs: [maxRecentChatsInput, collapsedRecentChatsInput],
        onClose: (popup) => {
            if (!popup.result) {
                return;
            }

            const maxInputValue = popup.inputResults.get(maxRecentChatsInput.id)?.toString() ?? String(DEFAULT_MAX_DISPLAYED);
            const collapsedInputValue = popup.inputResults.get(collapsedRecentChatsInput.id)?.toString() ?? String(DEFAULT_COLLAPSED_DISPLAYED);

            const newMax = clamp(parseInt(maxInputValue) || DEFAULT_MAX_DISPLAYED, maxRecentChatsInput.min, maxRecentChatsInput.max);
            const newCollapsed = clamp(parseInt(collapsedInputValue) || DEFAULT_COLLAPSED_DISPLAYED, collapsedRecentChatsInput.min, newMax);

            saveRecentChatsSettings({ maxDisplayed: newMax, collapsedDisplayed: newCollapsed });
        },
    });

    await refreshWelcomeScreen();
}

/**
 * Gets the list of recent chats from the server.
 * @returns {Promise<RecentChat[]>} List of recent chats
 *
 * @typedef {object} RecentChat
 * @property {string} file_name Name of the chat file
 * @property {string} chat_name Name of the chat (without extension)
 * @property {string} file_size Size of the chat file
 * @property {number} chat_items Number of items in the chat
 * @property {string} mes Last message content
 * @property {string} last_mes Timestamp of the last message
 * @property {string} avatar Avatar URL
 * @property {string} char_thumbnail Thumbnail URL
 * @property {string} char_name Character or group name
 * @property {string} date_short Date in short format
 * @property {string} date_long Date in long format
 * @property {string} group Group ID (if applicable)
 * @property {boolean} is_group Indicates if the chat is a group chat
 * @property {boolean} hidden Chat will be hidden by default
 * @property {boolean} pinned Indicates if the chat is pinned
 * @property {boolean} is_agent Indicates if the chat contains Agent-authored edits or transform history
 * @property {boolean} [is_conversation] Indicates if the chat is a Conversation Mode branch
 * @property {string} [conversation_branch_id] Conversation Mode branch ID
 * @property {string} [conversation_branch_name] Conversation Mode branch name
 */
function shouldSeparateAgentRecentChats() {
    return Boolean(extension_settings?.inChatAgents?.globalSettings?.separateRecentChats);
}

function isAgentRecentChat(chatData) {
    const metadata = chatData?.chat_metadata;
    if (metadata?.inChatAgents || metadata?.agentChat || metadata?.isAgentChat) {
        return true;
    }

    const messages = Array.isArray(chatData?.preview_messages) ? chatData.preview_messages : [];
    return messages.some(message => Boolean(
        message?.extra?.[AGENT_MESSAGE_EXTRA_KEY] ||
        message?.extra?.[AGENT_PROMPT_TRANSFORM_HISTORY_KEY],
    ));
}

async function getRecentChats() {
    const settings = getRecentChatsSettings();
    const finalizeRecentChats = chats => chats
        .slice(0, settings.maxDisplayed)
        .map((recentChat, index) => ({
            ...recentChat,
            hidden: index >= settings.collapsedDisplayed,
            pinned: PinnedChatsManager.isPinned(recentChat),
        }));
    const getConversationChats = async () => {
        try {
            const conversationModule = await import('./neconyan-conversation.js');
            const conversationChats = conversationModule.getConversationWelcomeChats?.({ max: settings.maxDisplayed }) || [];
            return conversationChats;
        } catch (error) {
            console.warn('Failed to load Conversation Mode recent chats', error);
            return [];
        }
    };
    const response = await fetch('/api/chats/recent', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ max: settings.maxDisplayed, pinned: PinnedChatsManager.getAll(), metadata: shouldSeparateAgentRecentChats(), previewMessages: shouldSeparateAgentRecentChats() ? 8 : 0 }),
        cache: 'no-cache',
    });

    if (!response.ok) {
        console.warn('Failed to fetch recent character chats');
        return finalizeRecentChats(await getConversationChats());
    }

    /** @type {RecentChat[]} */
    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
        return finalizeRecentChats(await getConversationChats());
    }

    const dataWithEntities = data
        .map(chat => ({ chat, character: characters.find(x => x.avatar === chat.avatar), group: groups.find(x => x.id === chat.group) }))
        .filter(t => t.character || t.group)
        .sort((a, b) => {
            const isAPinned = PinnedChatsManager.isPinned(a.chat);
            const isBPinned = PinnedChatsManager.isPinned(b.chat);
            const momentComparison = sortMoments(timestampToMoment(a.chat.last_mes), timestampToMoment(b.chat.last_mes));

            if (isAPinned && !isBPinned) {
                return -1;
            }
            if (!isAPinned && isBPinned) {
                return 1;
            }

            return momentComparison;
        });

    dataWithEntities.forEach(({ chat, character, group }) => {
        const chatTimestamp = timestampToMoment(chat.last_mes);
        chat.char_name = character?.name || group?.name || '';
        chat.date_short = chatTimestamp.format('l');
        chat.date_long = chatTimestamp.format('LL LT');
        chat.chat_name = chat.file_name.replace('.jsonl', '');
        chat.char_thumbnail = character ? getThumbnailUrl('avatar', character.avatar) : system_avatar;
        chat.is_group = !!group;
        chat.hidden = false;
        chat.avatar = chat.avatar || '';
        chat.group = chat.group || '';
        chat.pinned = PinnedChatsManager.isPinned(chat);
        chat.is_agent = shouldSeparateAgentRecentChats() && isAgentRecentChat(chat);
        chat.recent_chat_type = getRecentChatType(chat);
    });

    const roleplayChats = dataWithEntities.map(t => t.chat);
    const conversationChats = await getConversationChats();
    const mergedChats = [...roleplayChats, ...conversationChats].sort((first, second) => {
        const firstPinned = PinnedChatsManager.isPinned(first);
        const secondPinned = PinnedChatsManager.isPinned(second);

        if (firstPinned && !secondPinned) {
            return -1;
        }
        if (!firstPinned && secondPinned) {
            return 1;
        }

        return sortMoments(timestampToMoment(first.last_mes), timestampToMoment(second.last_mes));
    });
    return finalizeRecentChats(mergedChats);
}

export async function openPermanentAssistantChat() {
    const avatar = getPermanentAssistantAvatar();
    const characterId = characters.findIndex(character => character.avatar === avatar);
    if (characterId < 0) {
        await newAssistantChat({ temporary: true });
        return;
    }
    await selectCharacterById(characterId);
    await doNewChat({ deleteCurrentChat: false });
}

export async function openPermanentAssistantCard() {
    const avatar = getPermanentAssistantAvatar();
    const characterId = characters.findIndex(character => character.avatar === avatar);
    if (characterId < 0) {
        globalThis.NeconyanShell?.openCharacters?.();
        return;
    }
    await selectCharacterById(characterId);
}

export function assignCharacterAsAssistant(characterId) {
    const character = characters[characterId];
    if (!character) return;
    if (getPermanentAssistantAvatar() === character.avatar) {
        accountStorage.removeItem(assistantAvatarKey);
        accountStorage.removeItem(assistantVariantKey);
        toastr.info(t`Assistant shortcut cleared.`);
    } else {
        accountStorage.setItem(assistantAvatarKey, character.avatar);
        accountStorage.removeItem(assistantVariantKey);
        toastr.success(t`Assistant shortcut set to ${character.name}.`);
    }
    printCharactersDebounced();
}

/**
 * Shows the top bar and composer once Home or clearChat removes the boot skeleton from #chat.
 * A body-level :has(#neconyan-home-skeleton) rule did this before, but it made Chromium restyle
 * the whole page on every later DOM change.
 */
function releaseChromeAfterBootSkeleton() {
    const release = () => {
        if (document.getElementById('neconyan-home-skeleton')) {
            return false;
        }
        document.body.classList.remove('neconyan-home-booting');
        return true;
    };
    const chatElement = document.getElementById('chat');
    if (release() || !chatElement) {
        return;
    }
    const observer = new MutationObserver(() => {
        if (release()) {
            observer.disconnect();
        }
    });
    observer.observe(chatElement, { childList: true });
}

export function initWelcomeScreen() {
    releaseChromeAfterBootSkeleton();
    PinnedChatsManager.init();
    ensureNeconyanRail();
    window.addEventListener('sb:conversation-workspace-state-changed', concealWelcomeHome);
    eventSource.on(event_types.APP_READY, async () => {
        resumeTutorial();
        if (getCurrentChatId() === undefined && chat.length === 0) {
            await openWelcomeScreen({ force: true });
        }
        syncAssistantTools();
        scheduleNeconyanRailRefresh();
    });
    eventSource.makeFirst(event_types.CHAT_CHANGED, openWelcomeScreen);
    const syncAssistantTools = syncNeconyanAssistantTools;
    eventSource.on(event_types.CHAT_CHANGED, syncAssistantTools);
    eventSource.on(event_types.CHAT_LOADED, syncAssistantTools);
    eventSource.on(event_types.CHARACTER_EDITED, syncAssistantTools);
    eventSource.on(event_types.CHARACTER_RENAMED, syncAssistantTools);
    eventSource.on(event_types.CHARACTER_DELETED, syncAssistantTools);
    eventSource.on(event_types.GROUP_UPDATED, syncAssistantTools);
    eventSource.on(event_types.GROUP_CHAT_CREATED, syncAssistantTools);
    eventSource.on(event_types.GROUP_CHAT_DELETED, syncAssistantTools);
    const railRefreshEvents = [
        event_types.CHAT_CHANGED, event_types.CHAT_CREATED, event_types.GROUP_CHAT_CREATED,
        event_types.CHAT_DELETED, event_types.GROUP_CHAT_DELETED, event_types.GROUP_UPDATED,
        event_types.CHARACTER_DELETED, event_types.CHARACTER_RENAMED,
    ].filter(Boolean);
    for (const eventName of new Set(railRefreshEvents)) {
        eventSource.on(eventName, scheduleNeconyanRailRefresh);
    }
    eventSource.on(event_types.CHARACTER_MANAGEMENT_DROPDOWN, target => {
        if (target === 'set_as_assistant') assignCharacterAsAssistant(this_chid);
    });
    eventSource.on(event_types.CHARACTER_RENAMED, (oldAvatar, newAvatar) => {
        if (accountStorage.getItem(assistantAvatarKey) === oldAvatar) {
            accountStorage.setItem(assistantAvatarKey, newAvatar);
        }
        syncAssistantTools();
    });
    eventSource.on(event_types.CHARACTER_DELETED, event => {
        syncAssistantTools();
        if (accountStorage.getItem(assistantAvatarKey) === event?.character?.avatar) {
            accountStorage.removeItem(assistantAvatarKey);
            accountStorage.removeItem(assistantVariantKey);
        }
    });
    eventSource.on(event_types.CHAT_RENAMED, async ({ avatarId, groupId, oldFileName, newFileName }) => {
        PinnedChatsManager.rename({ avatar: avatarId, group: groupId, file_name: oldFileName }, newFileName);
        scheduleNeconyanRailRefresh();
    });
}
