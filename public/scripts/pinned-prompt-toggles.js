import { RUNTIME_AGENTS_IDENTIFIER } from './in-chat-agent-inspection.js';

/** Preset metadata only. Enabled state always comes from the active prompt order. */
export const PINNED_PROMPTS_FIELD = 'neconyan_pinned_prompts';

export function normalizePinnedPromptIds(value) {
    if (value?.version !== 1 || !Array.isArray(value.identifiers)) return [];
    return [...new Set(value.identifiers.filter(id => typeof id === 'string' && id.trim().length > 0))];
}

export function setPinnedPromptId(value, identifier, pinned) {
    const identifiers = normalizePinnedPromptIds(value);
    if (typeof identifier !== 'string' || !identifier.trim()) return { version: 1, identifiers };
    return { version: 1, identifiers: pinned ? [...new Set([...identifiers, identifier])] : identifiers.filter(id => id !== identifier) };
}

export function getPinnedPromptRows(manager) {
    if (!manager?.activeCharacter || !manager.serviceSettings) return [];
    const pinned = new Set(normalizePinnedPromptIds(manager.serviceSettings.extensions?.[PINNED_PROMPTS_FIELD]));
    const seen = new Set();
    return manager.getPromptOrderForCharacter(manager.activeCharacter).flatMap(entry => {
        if (!entry || seen.has(entry.identifier)) return [];
        seen.add(entry.identifier);
        const prompt = manager.getPromptById(entry.identifier);
        if (!pinned.has(entry.identifier) || !prompt || entry.identifier === RUNTIME_AGENTS_IDENTIFIER || !manager.isPromptToggleAllowed(prompt)) return [];
        return [{ identifier: entry.identifier, name: String(prompt.name ?? entry.identifier), enabled: Boolean(entry.enabled), prompt, entry }];
    });
}

export function resolveChatWidgetLayout({ hostWidth, collapsed }) {
    return collapsed ? 'collapsed' : hostWidth >= 800 ? 'side' : 'stacked';
}
