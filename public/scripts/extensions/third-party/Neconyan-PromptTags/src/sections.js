export const MODULE_NAME = 'promptTags';

/** Longest accepted prompt identifier. Preset data is user-editable JSON, so it is bounded. */
export const MAX_IDENTIFIER_LENGTH = 200;

/** Keys that must never become rule-map entries, because they would poison a plain object. */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Longest suggested tag name, so a verbose prompt title cannot produce an unreadable tag. */
const MAX_SUGGESTED_TAG_LENGTH = 40;

/** Display groups, in render order. */
export const GROUPS = [
    { id: 'character', label: 'Character & world' },
    { id: 'instructions', label: 'Instructions' },
    { id: 'injected', label: 'Injected blocks' },
    { id: 'advanced', label: 'Advanced' },
];

/**
 * The single source of truth for what can be tagged.
 *
 * `id` doubles as the Chat Completion prompt identifier (see the systemPrompts array in
 * openai.js and chatCompletionDefaultPrompts in PromptManager.js). `storyVar` is the matching
 * Text Completion story-string variable, or null when the section has no story-string equivalent.
 */
export const SECTIONS = [
    { id: 'worldInfoBefore', label: 'World Info (before)', tag: 'world_info', storyVar: 'wiBefore', group: 'character', enabled: true },
    { id: 'worldInfoAfter', label: 'World Info (after)', tag: 'world_info', storyVar: 'wiAfter', group: 'character', enabled: true },
    { id: 'charDescription', label: 'Character Description', tag: 'character_description', storyVar: 'description', group: 'character', enabled: true },
    { id: 'charPersonality', label: 'Personality', tag: 'character_personality', storyVar: 'personality', group: 'character', enabled: true },
    { id: 'scenario', label: 'Scenario', tag: 'scenario', storyVar: 'scenario', group: 'character', enabled: true },
    { id: 'personaDescription', label: 'Persona', tag: 'persona', storyVar: 'persona', group: 'character', enabled: true },

    { id: 'main', label: 'Main Prompt', tag: 'system_prompt', storyVar: 'system', group: 'instructions', enabled: false },
    { id: 'nsfw', label: 'Auxiliary Prompt', tag: 'auxiliary_prompt', storyVar: null, group: 'instructions', enabled: false },
    { id: 'jailbreak', label: 'Post-History Instructions', tag: 'post_history_instructions', storyVar: null, group: 'instructions', enabled: false },
    { id: 'enhanceDefinitions', label: 'Enhance Definitions', tag: 'enhance_definitions', storyVar: null, group: 'instructions', enabled: false },

    { id: 'summary', label: 'Summary', tag: 'summary', storyVar: null, group: 'injected', enabled: false },
    { id: 'authorsNote', label: "Author's Note", tag: 'authors_note', storyVar: null, group: 'injected', enabled: false },
    { id: 'vectorsMemory', label: 'Vector Memory', tag: 'vector_memory', storyVar: null, group: 'injected', enabled: false },
    { id: 'vectorsDataBank', label: 'Data Bank', tag: 'data_bank', storyVar: null, group: 'injected', enabled: false },
    { id: 'smartContext', label: 'Smart Context', tag: 'smart_context', storyVar: null, group: 'injected', enabled: false },

    { id: 'groupNudge', label: 'Group Nudge', tag: 'group_nudge', storyVar: null, group: 'advanced', enabled: false },
    { id: 'bias', label: 'Author Bias', tag: 'bias', storyVar: null, group: 'advanced', enabled: false },
    { id: 'impersonate', label: 'Impersonation Prompt', tag: 'impersonation', storyVar: null, group: 'advanced', enabled: false },
    { id: 'quietPrompt', label: 'Quiet Prompt', tag: 'instruction', storyVar: null, group: 'advanced', enabled: false },

    // Text Completion only: examples are per-message in Chat Completion, so there is no
    // single identifier to hang a block tag on.
    { id: 'mesExamples', label: 'Example Messages (Text Completion only)', tag: 'example_messages', storyVar: 'mesExamples', group: 'advanced', enabled: false, textCompletionOnly: true },
];

export const SECTION_IDS = SECTIONS.map(s => s.id);

/**
 * Identifiers that must never be wrapped, because preparePrompt sees them once per message
 * rather than once per block. Wrapping these would tag every individual chat message.
 */
const PER_MESSAGE_PATTERNS = [
    /^chatHistory-\d+$/,
    /^dialogueExamples /,
    /^toolCall-/,
];

export function isPerMessageIdentifier(identifier) {
    return PER_MESSAGE_PATTERNS.some(pattern => pattern.test(String(identifier ?? '')));
}

/**
 * Marker prompts that stand in for a run of messages rather than one block. They appear in a
 * preset's prompt list, but tagging them would put one wrapper around every message.
 */
export const NON_TAGGABLE_MARKERS = ['chatHistory', 'dialogueExamples'];

/** True when a preset prompt identifier may be offered for block tagging. */
export function isTaggablePromptIdentifier(identifier) {
    const id = String(identifier ?? '').trim();
    if (!id || id.length > MAX_IDENTIFIER_LENGTH) {
        return false;
    }
    if (RESERVED_KEYS.has(id)) {
        return false;
    }
    return !NON_TAGGABLE_MARKERS.includes(id) && !isPerMessageIdentifier(id);
}

export function getSection(id) {
    return SECTIONS.find(section => section.id === id) ?? null;
}

/** The shape every rule takes, wherever it is stored. */
export function createBlankRule(tag = 'prompt') {
    return { enabled: false, tag, template: '', advanced: false };
}

/**
 * Coerces one stored rule to the four-field shape, falling back per field.
 *
 * Shared by profile rules and preset rules so both apply the same type checks.
 */
export function normalizeRuleFields(rule, fallback) {
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
        return { ...fallback };
    }

    return {
        enabled: typeof rule.enabled === 'boolean' ? rule.enabled : fallback.enabled,
        tag: typeof rule.tag === 'string' ? rule.tag : fallback.tag,
        template: typeof rule.template === 'string' ? rule.template : fallback.template,
        advanced: typeof rule.advanced === 'boolean' ? rule.advanced : fallback.advanced,
    };
}

/**
 * Derives a usable tag name from a prompt's display name.
 *
 * The result always satisfies isValidTagName, so a row can be enabled straight away without
 * the user having to invent a name first.
 */
export function suggestTagName(promptName) {
    const collapsed = String(promptName ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');

    if (!collapsed) {
        return 'prompt';
    }

    // A tag may not start with a digit, so a name like "3rd person" gets a prefix.
    const safe = /^[a-z_]/.test(collapsed) ? collapsed : `p_${collapsed}`;
    return safe.slice(0, MAX_SUGGESTED_TAG_LENGTH).replace(/_+$/, '') || 'prompt';
}

/** Default rule set: every section keyed by id, with its shipped tag and enabled state. */
export function createDefaultRules() {
    const rules = {};
    for (const section of SECTIONS) {
        rules[section.id] = {
            enabled: section.enabled,
            tag: section.tag,
            template: '',
            advanced: false,
        };
    }
    return rules;
}
