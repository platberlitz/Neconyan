/**
 * Enumerates the texts the Cache Auditor scans, in prompt-assembly order:
 * everything here is re-substituted through the macro engine on every generation
 * (user-typed chat messages excepted. those are baked at send time).
 */
import { getEnabledEntries, getSearchOrder } from '../lorebook-cache.js';

export const CHAT_SCAN_LIMIT = 50;

function loreTitle(entry) {
    const comment = String(entry.comment ?? '').trim();
    if (comment) {
        return comment;
    }
    const firstKey = Array.isArray(entry.key) ? entry.key[0] : undefined;
    return firstKey ? String(firstKey) : String(entry.uid);
}

/**
 * @returns {{sources: {kind: string, label: string, text: string, index?: number, isUser?: boolean}[], notes: string[]}}
 */
export function collectSources() {
    const ctx = SillyTavern.getContext();
    const sources = [];
    const notes = [];
    const push = (kind, label, text, meta = {}) => {
        if (typeof text === 'string' && text.trim()) {
            sources.push({ kind, label, text, ...meta });
        }
    };

    // Preset prompts (Chat Completion only. other APIs assemble prompts differently).
    if (ctx.mainApi === 'openai') {
        for (const prompt of ctx.chatCompletionSettings?.prompts ?? []) {
            if (prompt && !prompt.marker) {
                push('preset', `Preset prompt: ${prompt.name ?? prompt.identifier ?? '(unnamed)'}`, prompt.content);
            }
        }
    } else {
        notes.push('Preset prompts were skipped. the current API is not Chat Completion.');
    }

    const character = ctx.characters?.[ctx.characterId];
    if (character) {
        push('card', 'Character: description', character.description);
        push('card', 'Character: personality', character.personality);
        push('card', 'Character: scenario', character.scenario);
        push('card', 'Character: first message', character.first_mes);
        push('card', 'Character: example messages', character.mes_example);
        push('card', 'Character: system prompt', character.data?.system_prompt);
        push('card', 'Character: post-history instructions', character.data?.post_history_instructions);
        push('card', 'Character: depth prompt', character.data?.extensions?.depth_prompt?.prompt);
    } else {
        notes.push('No character is selected. card fields were skipped.');
    }

    push('persona', 'Persona description', ctx.powerUserSettings?.persona_description);

    // Enabled lorebook entries from the cached search-order books.
    for (const { entry, book } of getEnabledEntries(getSearchOrder(ctx))) {
        push('lore', `Lorebook "${book}": ${loreTitle(entry)}`, String(entry.content ?? ''));
    }

    // Recent chat. AI messages are re-substituted every generation; user messages
    // were baked at send time and only matter if literal {{...}} survived in them.
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    if (chat.length > CHAT_SCAN_LIMIT) {
        notes.push(`Only the last ${CHAT_SCAN_LIMIT} of ${chat.length} messages were scanned.`);
    }
    for (let i = Math.max(0, chat.length - CHAT_SCAN_LIMIT); i < chat.length; i++) {
        const message = chat[i];
        if (!message || message.is_system) {
            continue;
        }
        const who = message.is_user ? 'you. baked at send time' : 'AI. re-substituted every generation';
        push('chat', `Message #${i} (${who})`, message.mes, { index: i, isUser: !!message.is_user });
    }

    return { sources, notes };
}
