// Shared by the browser runner and the server Roleplay runner, so keep it free of DOM and app imports.

import { getTrackerMetadataKey } from './tracker-state.js';

export const GROUP_CARDS_MACRO = 'group-cards';
export const ACTIVE_LORE_MACRO = 'active-lore';
export const ACTIVE_AUTHORS_NOTE_MACRO = 'active-authors-note';
export const TRACKER_STATE_MACRO = 'tracker-state';
export const SECRETS_TRACKER_MACRO = 'secrets-tracker';
const GROUP_CARD_FIELDS = [['description', 'Description'], ['personality', 'Personality'], ['scenario', 'Scenario']];

let preparedMewmory = null;
let preparedLore = null;

/** Remembers the memories Mewmory picked for the latest reply in a chat. */
export function setPreparedMewmoryContext(chatId, context) {
    preparedMewmory = chatId && context?.enabled ? { chatId: String(chatId), context } : null;
}

export function getPreparedMewmoryContext(chatId) {
    return preparedMewmory && chatId && preparedMewmory.chatId === String(chatId) ? preparedMewmory.context : null;
}

/** Remembers the lorebook entries that switched on for the latest reply in a chat. */
export function setPreparedActiveLore(chatId, lore) {
    preparedLore = chatId ? { chatId: String(chatId), lore: text(lore) } : null;
}

export function getPreparedActiveLore(chatId) {
    return preparedLore && chatId && preparedLore.chatId === String(chatId) ? preparedLore.lore : '';
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

export function usesAgentMacro(value, name) {
    const pattern = String(name ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return Boolean(pattern) && new RegExp(`\\{\\{\\s*${pattern}\\s*\\}\\}`, 'i').test(String(value ?? ''));
}

export function usesGroupCardsMacro(value) {
    return usesAgentMacro(value, GROUP_CARDS_MACRO);
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

/**
 * The latest value each enabled tracker saved in the chat, read from the same
 * agent_<variable> keys {{getvar::agent_x}} uses. Trackers with nothing saved are left out.
 */
export function captureTrackerState(agents, metadata) {
    if (!metadata || typeof metadata !== 'object') return [];
    return (Array.isArray(agents) ? agents : [])
        .filter(agent => agent?.postProcess?.enabled !== false && agent?.postProcess?.type === 'extract')
        .map(agent => {
            const key = getTrackerMetadataKey(agent);
            return { name: String(agent.name ?? '').trim() || key, value: key ? text(metadata.variables?.[key] ?? metadata[key]) : '' };
        })
        .filter(tracker => tracker.value);
}

/** A secrets-only view, including renamed template copies and older secret_data trackers. */
export function captureSecretsTrackerState(agents, metadata) {
    return captureTrackerState((Array.isArray(agents) ? agents : []).filter(agent =>
        agent?.sourceTemplateId === 'tpl-secrets-tracker' || agent?.id === 'tpl-secrets-tracker'
        || getTrackerMetadataKey(agent) === 'agent_secret_data'), metadata);
}

export function buildTrackerStateText(trackers) {
    return (Array.isArray(trackers) ? trackers : [])
        .filter(tracker => text(tracker?.value))
        .map(tracker => `<tracker name="${String(tracker.name ?? '').replace(/"/g, '\'')}">\n${text(tracker.value)}\n</tracker>`)
        .join('\n\n');
}

/**
 * Dynamic macros that give an agent prompt its Mewmory memories, group member cards,
 * the lorebook entries and Author's Note in effect for the reply, and the saved tracker state.
 * Lore and the note keep their own {{char}} and {{user}} names filled in.
 */
export function buildAgentContextMacros({ mewmory = null, groupCards = null, userName = '', charName = '', lore = '', authorsNote = '', trackers = null, secretsTrackers = null } = {}) {
    const names = value => {
        const filled = text(value);
        return filled && charName ? fillNames(filled, charName, userName) : filled;
    };
    return {
        ...buildMewmoryMacros(mewmory),
        [GROUP_CARDS_MACRO]: buildGroupCardsText(groupCards, userName),
        [ACTIVE_LORE_MACRO]: names(lore),
        [ACTIVE_AUTHORS_NOTE_MACRO]: names(authorsNote),
        [TRACKER_STATE_MACRO]: buildTrackerStateText(trackers),
        [SECRETS_TRACKER_MACRO]: buildTrackerStateText(secretsTrackers),
    };
}
