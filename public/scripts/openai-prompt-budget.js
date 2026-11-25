import { cleanMewmoryCountView } from './mewmory/prompt-proof.js';

/**
 * Determines whether a prompt-ready chat payload needs a post-mutation budget recount.
 *
 * @param {object} eventData CHAT_COMPLETION_PROMPT_READY event payload.
 * @returns {boolean}
 */
export function shouldCheckPostInterceptChatBudget(eventData) {
    return eventData?.chatChanged === true;
}

/** Copies of the messages without what the model never reads as text: signatures and inlined media. */
function withoutHiddenData(chat) {
    const bare = (value, strip) => (value && typeof value === 'object' ? strip({ ...value }) : value);
    return chat.map(message => bare(message, copy => {
        delete copy.signature;
        if (Array.isArray(copy.tool_calls)) copy.tool_calls = copy.tool_calls.map(call => bare(call, entry => { delete entry.signature; return entry; }));
        if (Array.isArray(copy.content)) {
            copy.content = copy.content.map(part => bare(part, entry => {
                for (const key of ['image_url', 'video_url', 'audio_url'])
                    if (String(entry[key]?.url).startsWith('data:')) entry[key] = { ...entry[key], url: '' };
                return entry;
            }));
        }
        return copy;
    }));
}

/**
 * Recounts a finalized chat-completion payload against the prompt budget.
 *
 * @param {object[]} chat Final chat-completion messages.
 * @param {object} userSettings Chat-completion settings.
 * @param {(chat: object[]) => Promise<number>|number} countTokens Token counter for the payload.
 * @returns {Promise<{promptTokens: number, promptTokenBudget: number, exceeded: boolean}>}
 */
export async function checkPostInterceptChatBudget(chat, userSettings = {}, countTokens, marker = null) {
    if (!Array.isArray(chat)) {
        throw new TypeError('Post-intercept chat payload must be an array.');
    }

    if (typeof countTokens !== 'function') {
        throw new TypeError('Post-intercept chat budget check requires a token counter.');
    }

    const promptTokenBudget = Number(userSettings?.openai_max_context) - Number(userSettings?.openai_max_tokens);
    const promptTokens = await countTokens(withoutHiddenData(cleanMewmoryCountView(chat, marker)));

    return {
        promptTokens,
        promptTokenBudget,
        exceeded: Number.isFinite(promptTokenBudget) && Number.isFinite(promptTokens) && promptTokens > promptTokenBudget,
    };
}
