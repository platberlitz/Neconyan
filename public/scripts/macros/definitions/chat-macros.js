import { MacroRegistry, MacroCategory, MacroValueType } from '../engine/MacroRegistry.js';

/** @typedef {import('../engine/MacroEnv.types.js').MacroEnv} MacroEnv */

/**
 * Registers macros that inspect the current chat log and swipe state
 * (message texts, indices, swipes, and context boundaries).
 *
 * Every handler reads the chat snapshot from env.extra so that registration
 * stays process-wide and per-user state is never captured. The browser
 * MacroEnvBuilder supplies the live chat array; server glue supplies an
 * explicit snapshot.
 */
export function registerChatMacros() {
    MacroRegistry.registerMacro('lastMessage', {
        category: MacroCategory.CHAT,
        description: 'Last message in the chat.',
        returns: 'Last message in the chat.',
        handler: ({ env }) => String(getLastMessage(env) ?? ''),
    });

    MacroRegistry.registerMacro('lastMessageId', {
        category: MacroCategory.CHAT,
        description: 'Index of the last message in the chat.',
        returns: 'Index of the last message in the chat.',
        returnType: MacroValueType.INTEGER,
        handler: ({ env }) => String(getLastMessageId(env) ?? ''),
    });

    MacroRegistry.registerMacro('lastUserMessage', {
        category: MacroCategory.CHAT,
        description: 'Last user message in the chat.',
        returns: 'Last user message in the chat.',
        handler: ({ env }) => String(getLastUserMessage(env) ?? ''),
    });

    MacroRegistry.registerMacro('lastCharMessage', {
        category: MacroCategory.CHAT,
        description: 'Last character/bot message in the chat.',
        returns: 'Last character/bot message in the chat.',
        handler: ({ env }) => String(getLastCharMessage(env) ?? ''),
    });

    MacroRegistry.registerMacro('firstIncludedMessageId', {
        category: MacroCategory.CHAT,
        description: 'Index of the first message included in the current context.',
        returns: 'Index of the first message included in the context.',
        returnType: MacroValueType.INTEGER,
        handler: ({ env }) => String(getFirstIncludedMessageId(env) ?? ''),
    });

    MacroRegistry.registerMacro('firstDisplayedMessageId', {
        category: MacroCategory.CHAT,
        description: 'Index of the first displayed message in the chat.',
        returns: 'Index of the first displayed message in the chat.',
        returnType: MacroValueType.INTEGER,
        handler: ({ env }) => String(getFirstDisplayedMessageId(env) ?? ''),
    });

    MacroRegistry.registerMacro('lastSwipeId', {
        category: MacroCategory.CHAT,
        description: '1-based index of the last swipe for the last message.',
        returns: '1-based index of the last swipe.',
        returnType: MacroValueType.INTEGER,
        handler: ({ env }) => String(getLastSwipeId(env) ?? ''),
    });

    MacroRegistry.registerMacro('currentSwipeId', {
        category: MacroCategory.CHAT,
        description: '1-based index of the current swipe.',
        returns: '1-based index of the current swipe.',
        returnType: MacroValueType.INTEGER,
        handler: ({ env }) => String(getCurrentSwipeId(env) ?? ''),
    });

    MacroRegistry.registerMacro('allChatRange', {
        category: MacroCategory.CHAT,
        description: 'Range of all message IDs in the chat (e.g. "0-10"). Empty string if the chat is empty.',
        returns: 'Range string from 0 to last message ID, or empty string.',
        handler: ({ env }) => {
            const chat = env.extra?.chat;
            if (!Array.isArray(chat) || chat.length === 0) {
                return '';
            }
            return `0-${chat.length - 1}`;
        },
    });
}

/**
 * @param {MacroEnv} env
 * @param {{ exclude_swipe_in_propress?: boolean, filter?: ((message: any) => boolean) | null }} [options]
 * @returns {number|null}
 */
function getLastMessageId(env, { exclude_swipe_in_propress = true, filter = null } = {}) {
    const chat = env.extra?.chat;
    if (!Array.isArray(chat) || chat.length === 0) {
        return null;
    }

    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];

        if (exclude_swipe_in_propress && message.swipes && message.swipe_id >= message.swipes.length) {
            continue;
        }

        if (!filter || filter(message)) {
            return i;
        }
    }

    return null;
}

function getLastMessage(env) {
    const chat = env.extra?.chat;
    const mid = getLastMessageId(env);
    return typeof mid === 'number' ? (chat[mid]?.mes ?? '') : '';
}

function getLastUserMessage(env) {
    const chat = env.extra?.chat;
    const mid = getLastMessageId(env, { filter: m => m.is_user && !m.is_system });
    return typeof mid === 'number' ? (chat[mid]?.mes ?? '') : '';
}

function getLastCharMessage(env) {
    const chat = env.extra?.chat;
    const mid = getLastMessageId(env, { filter: m => !m.is_user && !m.is_system });
    return typeof mid === 'number' ? (chat[mid]?.mes ?? '') : '';
}

function getFirstIncludedMessageId(env) {
    const value = env.extra?.chatMetadata?.lastInContextMessageId;
    return typeof value === 'number' ? value : null;
}

function getFirstDisplayedMessageId(env) {
    const getter = env.extra?.getFirstDisplayedMessageId;
    if (typeof getter !== 'function') {
        return null;
    }
    const value = getter();
    return typeof value === 'number' ? value : null;
}

function getLastSwipeId(env) {
    const chat = env.extra?.chat;
    const mid = getLastMessageId(env, { exclude_swipe_in_propress: false });
    if (typeof mid !== 'number') {
        return null;
    }
    const swipes = chat[mid]?.swipes;
    return Array.isArray(swipes) ? swipes.length : null;
}

function getCurrentSwipeId(env) {
    const chat = env.extra?.chat;
    const mid = getLastMessageId(env, { exclude_swipe_in_propress: false });
    if (typeof mid !== 'number') {
        return null;
    }
    const swipeId = chat[mid]?.swipe_id;
    return typeof swipeId === 'number' ? swipeId + 1 : null;
}
