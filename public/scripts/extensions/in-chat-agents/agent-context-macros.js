// Shared by the browser runner and the server Roleplay runner, so keep it free of DOM and app imports.

export const GROUP_CARDS_MACRO = 'group-cards';
const GROUP_CARD_FIELDS = [['description', 'Description'], ['personality', 'Personality'], ['scenario', 'Scenario']];

let preparedMewmory = null;

/** Remembers the memories Mewmory picked for the latest reply in a chat. */
export function setPreparedMewmoryContext(chatId, context) {
    preparedMewmory = chatId && context?.enabled ? { chatId: String(chatId), context } : null;
}

export function getPreparedMewmoryContext(chatId) {
    return preparedMewmory && chatId && preparedMewmory.chatId === String(chatId) ? preparedMewmory.context : null;
}

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * {{full-mewmory}} is the memory the writer saw, {{mewmory-facts}} the character
 * sheets, story records and source passages, {{mewmory-interview}} the interviews
 * and subjective views. All three are empty when Mewmory is off for the chat.
 */
export function buildMewmoryMacros(context) {
    const enabled = Boolean(context?.enabled);
    const full = enabled ? [text(context.npcText), text(context.memoryText)].filter(Boolean).join('\n\n') : '';
    return {
        'full-mewmory': full,
        'mewmory-facts': enabled ? text(context.factsText) : '',
        'mewmory-interview': enabled ? text(context.interviewText) : '',
    };
}

export function usesGroupCardsMacro(value) {
    return /\{\{\s*group-cards\s*\}\}/i.test(String(value ?? ''));
}

function cardField(card, key) {
    const value = card?.data?.[key] ?? card?.[key];
    return typeof value === 'string' ? value : '';
}

/** Collects the card fields {{group-cards}} needs from every member of a group chat. */
export function captureGroupCards(members) {
    return (Array.isArray(members) ? members : []).map(member => ({
        name: String(member?.card?.data?.name ?? member?.card?.name ?? '').trim(),
        muted: Boolean(member?.muted),
        fields: Object.fromEntries(GROUP_CARD_FIELDS.map(([key]) => [key, cardField(member?.card, key)])),
    })).filter(member => member.name);
}

function fillNames(value, name, userName) {
    return value.replace(/\{\{\s*char\s*\}\}/gi, name).replace(/\{\{\s*user\s*\}\}/gi, userName || '{{user}}');
}

/** One block per group member, in group order. Muted members are kept, because they can still appear in the scene. */
export function buildGroupCardsText(cards, userName = '') {
    return (Array.isArray(cards) ? cards : []).map(member => {
        const sections = GROUP_CARD_FIELDS
            .map(([key, label]) => [label, fillNames(text(member.fields?.[key]), member.name, userName)])
            .filter(([, value]) => value)
            .map(([label, value]) => `${label}:\n${value}`);
        const name = member.name.replace(/"/g, '\'');
        return `<character name="${name}"${member.muted ? ' muted="true"' : ''}>\n${sections.join('\n\n')}\n</character>`;
    }).join('\n\n');
}

/** Dynamic macros that give an agent prompt its Mewmory memories and group member cards. */
export function buildAgentContextMacros({ mewmory = null, groupCards = null, userName = '' } = {}) {
    return { ...buildMewmoryMacros(mewmory), [GROUP_CARDS_MACRO]: buildGroupCardsText(groupCards, userName) };
}
