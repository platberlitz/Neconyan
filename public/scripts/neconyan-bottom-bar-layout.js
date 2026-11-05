// Layout model for the bottom chat bar: which controls exist, their default
// order and which ones the user has hidden. Pure data helpers so the settings
// UI and the bar itself share one source of truth.

export const BOTTOM_CHAT_BAR_LAYOUT_STORAGE_KEY = 'sb-bottom-chat-bar-buttons';

export const BOTTOM_CHAT_BAR_MAIN_ORDER = Object.freeze([
    'persona',
    'reasoning',
    'chats',
    'search',
    'scroll',
    'collapse',
]);

export const BOTTOM_CHAT_BAR_ACTIONS_ORDER = Object.freeze([
    'regenerate',
    'scratchpad',
    'purrks',
    'files',
    'newChat',
    'massDelete',
    'autoName',
    'rename',
    'searchToggle',
    'hideBar',
    'deleteChat',
]);

export const BOTTOM_CHAT_BAR_BUTTON_LABELS = Object.freeze({
    persona: 'Persona bubble',
    reasoning: 'Reasoning effort',
    chats: 'Chat switcher',
    search: 'Search field',
    scroll: 'Scroll to top and bottom',
    collapse: 'Collapse chat actions',
    regenerate: 'Regenerate the last reply',
    scratchpad: 'Scratchpad',
    purrks: 'Character Purrks',
    files: 'View chat files',
    newChat: 'New chat',
    massDelete: 'Mass delete chats',
    autoName: 'Ask the LLM to name this chat',
    rename: 'Rename chat',
    searchToggle: 'Search chat',
    hideBar: 'Hide bottom chat bar',
    deleteChat: 'Delete chat',
});

const BOTTOM_CHAT_BAR_ZONES = {
    main: BOTTOM_CHAT_BAR_MAIN_ORDER,
    actions: BOTTOM_CHAT_BAR_ACTIONS_ORDER,
};

function bottomChatBarZoneOf(id) {
    if (BOTTOM_CHAT_BAR_ZONES.main.includes(id)) {
        return 'main';
    }

    if (BOTTOM_CHAT_BAR_ZONES.actions.includes(id)) {
        return 'actions';
    }

    return null;
}

export function normalizeBottomChatBarLayout(raw) {
    const source = (raw && typeof raw === 'object') ? raw : {};
    const order = { main: [], actions: [] };

    for (const zone of ['main', 'actions']) {
        const wanted = Array.isArray(source.order?.[zone]) ? source.order[zone] : [];
        const seen = new Set();

        for (const id of wanted) {
            if (typeof id !== 'string' || bottomChatBarZoneOf(id) !== zone || seen.has(id)) {
                continue;
            }

            seen.add(id);
            order[zone].push(id);
        }

        for (const id of BOTTOM_CHAT_BAR_ZONES[zone]) {
            if (!seen.has(id)) {
                order[zone].push(id);
            }
        }
    }

    const hiddenWanted = Array.isArray(source.hidden) ? source.hidden : [];
    const hidden = [...new Set(hiddenWanted.filter(id => typeof id === 'string' && bottomChatBarZoneOf(id) !== null))];

    return { order, hidden };
}

export function parseBottomChatBarLayout(json) {
    if (typeof json !== 'string' || !json) {
        return normalizeBottomChatBarLayout(null);
    }

    try {
        return normalizeBottomChatBarLayout(JSON.parse(json));
    } catch {
        return normalizeBottomChatBarLayout(null);
    }
}

export function serializeBottomChatBarLayout(layout) {
    return JSON.stringify(normalizeBottomChatBarLayout(layout));
}

export function readBottomChatBarLayout(storage) {
    if (!storage || typeof storage.getItem !== 'function') {
        return normalizeBottomChatBarLayout(null);
    }

    try {
        return parseBottomChatBarLayout(storage.getItem(BOTTOM_CHAT_BAR_LAYOUT_STORAGE_KEY));
    } catch {
        return normalizeBottomChatBarLayout(null);
    }
}

export function writeBottomChatBarLayout(storage, layout) {
    if (!storage || typeof storage.setItem !== 'function') {
        return;
    }

    try {
        storage.setItem(BOTTOM_CHAT_BAR_LAYOUT_STORAGE_KEY, serializeBottomChatBarLayout(layout));
    } catch {
        // Storage can be full or blocked; the bar keeps working with defaults.
    }
}
