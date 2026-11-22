import { escapeCharacterBookRegex, normalizeCharacterBookPosition } from './world-info-character-book.js';
import { newWorldInfoEntryTemplate } from './world-info-entry.js';
import { parseWorldInfoKeyRegex } from './world-info-scan-core.js';

export const worldInfoPositions = {
    before: 0,
    after: 1,
    ANTop: 2,
    ANBottom: 3,
    atDepth: 4,
    EMTop: 5,
    EMBottom: 6,
    outlet: 7,
};

/** Map a CharacterBook record into the native editor and scanner's fields. */
export function convertCharacterBookEntry(entry, uid, index) {
    const toRegex = key => entry.use_regex && !parseWorldInfoKeyRegex(key)
        ? `/${escapeCharacterBookRegex(key)}/`
        : key;
    return {
        ...newWorldInfoEntryTemplate,
        uid,
        key: Array.isArray(entry.keys) ? entry.keys.map(toRegex) : [],
        keysecondary: Array.isArray(entry.secondary_keys) ? entry.secondary_keys.map(toRegex) : [],
        comment: entry.comment || '',
        content: entry.content,
        constant: entry.constant || false,
        selective: entry.selective || false,
        order: entry.insertion_order,
        position: normalizeCharacterBookPosition(entry.extensions?.position, entry.position, worldInfoPositions),
        excludeRecursion: entry.extensions?.exclude_recursion ?? false,
        preventRecursion: entry.extensions?.prevent_recursion ?? false,
        delayUntilRecursion: entry.extensions?.delay_until_recursion ?? false,
        disable: entry.enabled === false,
        addMemo: !!entry.comment,
        displayIndex: entry.extensions?.display_index ?? index,
        probability: entry.extensions?.probability ?? 100,
        useProbability: entry.extensions?.useProbability ?? true,
        depth: entry.extensions?.depth ?? newWorldInfoEntryTemplate.depth,
        selectiveLogic: entry.extensions?.selectiveLogic ?? newWorldInfoEntryTemplate.selectiveLogic,
        outletName: entry.extensions?.outlet_name ?? '',
        group: entry.extensions?.group ?? '',
        groupOverride: entry.extensions?.group_override ?? false,
        groupWeight: entry.extensions?.group_weight ?? newWorldInfoEntryTemplate.groupWeight,
        scanDepth: entry.extensions?.scan_depth ?? null,
        caseSensitive: entry.case_sensitive ?? entry.extensions?.case_sensitive ?? null,
        matchWholeWords: entry.extensions?.match_whole_words ?? null,
        useGroupScoring: entry.extensions?.use_group_scoring ?? null,
        characterFilter: entry.character_filter,
        automationId: entry.extensions?.automation_id ?? '',
        role: entry.extensions?.role ?? newWorldInfoEntryTemplate.role,
        vectorized: entry.extensions?.vectorized ?? false,
        sticky: entry.extensions?.sticky ?? null,
        cooldown: entry.extensions?.cooldown ?? null,
        delay: entry.extensions?.delay ?? null,
        matchPersonaDescription: entry.extensions?.match_persona_description ?? false,
        matchCharacterDescription: entry.extensions?.match_character_description ?? false,
        matchCharacterPersonality: entry.extensions?.match_character_personality ?? false,
        matchCharacterDepthPrompt: entry.extensions?.match_character_depth_prompt ?? false,
        matchScenario: entry.extensions?.match_scenario ?? false,
        matchCreatorNotes: entry.extensions?.match_creator_notes ?? false,
        extensions: entry.extensions ?? {},
        triggers: entry.extensions?.triggers || [],
        ignoreBudget: entry.extensions?.ignore_budget ?? false,
        agentBlacklisted: entry.extensions?.agent_blacklisted ?? entry.agentBlacklisted ?? false,
    };
}
