/**
 * Preset domain rules. Pure data work only: no host access, no storage, no DOM.
 *
 * Neconyan keeps Chat Completion in a single preset and splits Text
 * Completion across five independent preset types. This module keeps that
 * distinction intact instead of inventing a combined format.
 */

export const CC_API_ID = 'openai';

export const TC_API_IDS = Object.freeze([
    'textgenerationwebui',
    'context',
    'instruct',
    'sysprompt',
    'reasoning',
]);

export const PRESET_API_IDS = Object.freeze([CC_API_ID, ...TC_API_IDS]);

export const PRESET_API_LABEL = Object.freeze({
    openai: 'Chat Completion',
    textgenerationwebui: 'Text Completion sampler',
    context: 'Context template',
    instruct: 'Instruct template',
    sysprompt: 'System prompt',
    reasoning: 'Reasoning template',
});

export const MODE = Object.freeze({ CC: 'cc', TC: 'tc' });

export const MODE_LABEL = Object.freeze({
    cc: 'Chat Completion',
    tc: 'Text Completion',
});

/** The Prompt Manager stores its order under this stand-in character id. */
export const GLOBAL_PROMPT_ORDER_ID = 100001;

/** Fields Neconyan itself treats as secrets when a preset is shared. */
export const SENSITIVE_FIELDS = Object.freeze([
    'reverse_proxy',
    'proxy_password',
    'custom_url',
    'custom_include_body',
    'custom_exclude_body',
    'custom_include_headers',
    'vertexai_region',
    'vertexai_express_project_id',
    'azure_base_url',
    'azure_deployment_name',
    'workers_ai_account_id',
]);

/**
 * Fields that describe where and how the request is sent. They are not secret
 * on their own, but they still point at someone's private setup.
 */
const CONNECTION_PATTERNS = [
    /^chat_completion_source$/,
    /_model$/,
    /^openrouter_/,
    /^custom_/,
    /^azure_/,
    /^vertexai_/,
    /_endpoint$/,
    /_account_id$/,
    /^show_external_models$/,
    /^bypass_status_check$/,
    /^reverse_proxy$/,
    /^proxy_password$/,
];

export function isCcApiId(apiId) {
    return apiId === CC_API_ID;
}

export function modeOf(apiId) {
    return isCcApiId(apiId) ? MODE.CC : MODE.TC;
}

export function apiIdsForMode(mode) {
    return mode === MODE.CC ? [CC_API_ID] : [...TC_API_IDS];
}

export function isSupportedApiId(apiId) {
    return PRESET_API_IDS.includes(apiId);
}

export function labelForApiId(apiId) {
    return PRESET_API_LABEL[apiId] ?? apiId;
}

/**
 * Describes a saved preset reference in words a reader can follow.
 * @param {{apiId: string, name: string}} ref
 */
export function describePresetRef(ref) {
    if (!ref?.name) {
        return '';
    }
    return `${labelForApiId(ref.apiId)}: ${ref.name}`;
}

/**
 * Sorts object keys so the same preset always produces the same text.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
    return JSON.stringify(sortValue(value));
}

function sortValue(value) {
    if (Array.isArray(value)) {
        return value.map(sortValue);
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            out[key] = sortValue(value[key]);
        }
        return out;
    }
    return value;
}

/**
 * A short, stable marker for preset contents so a run can say whether the
 * preset changed since last time.
 * @param {unknown} value
 * @returns {Promise<string>}
 */
export async function fingerprint(value) {
    const text = canonicalJson(value ?? null);
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
        const bytes = new TextEncoder().encode(text);
        const digest = await subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(digest)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/**
 * The prompt order entry the Prompt Manager actually uses.
 * @param {object} payload
 * @returns {Array<{identifier: string, enabled: boolean}>}
 */
export function getPromptOrder(payload, characterId = GLOBAL_PROMPT_ORDER_ID) {
    const list = Array.isArray(payload?.prompt_order) ? payload.prompt_order : [];
    const entry = list.find(item => Number(item?.character_id) === characterId);
    return Array.isArray(entry?.order) ? entry.order : [];
}

/**
 * Replaces the global order while leaving per-character orders alone.
 * @returns {object} a new payload
 */
export function withPromptOrder(payload, order, characterId = GLOBAL_PROMPT_ORDER_ID) {
    const next = structuredClone(payload ?? {});
    const list = Array.isArray(next.prompt_order) ? next.prompt_order : [];
    const index = list.findIndex(item => Number(item?.character_id) === characterId);
    const entry = { character_id: characterId, order: order.map(item => ({ ...item })) };
    if (index === -1) {
        list.push(entry);
    } else {
        list[index] = { ...list[index], ...entry };
    }
    next.prompt_order = list;
    return next;
}

/** Prompt definitions joined to their order entry, in the order they are used. */
export function listPromptModules(payload) {
    const prompts = Array.isArray(payload?.prompts) ? payload.prompts : [];
    const byIdentifier = new Map(prompts.map(prompt => [prompt?.identifier, prompt]));
    const modules = [];
    const seen = new Set();
    for (const entry of getPromptOrder(payload)) {
        const prompt = byIdentifier.get(entry?.identifier);
        if (!prompt) {
            continue;
        }
        seen.add(entry.identifier);
        modules.push({ prompt, enabled: entry.enabled !== false, inOrder: true });
    }
    for (const prompt of prompts) {
        if (!seen.has(prompt?.identifier)) {
            modules.push({ prompt, enabled: false, inOrder: false });
        }
    }
    return modules;
}

/** Moves one module up or down in the order the prompt is built. */
export function movePromptModule(payload, identifier, offset) {
    const order = getPromptOrder(payload).map(item => ({ ...item }));
    const index = order.findIndex(item => item.identifier === identifier);
    const target = index + offset;
    if (index === -1 || target < 0 || target >= order.length) {
        return structuredClone(payload ?? {});
    }
    const [moved] = order.splice(index, 1);
    order.splice(target, 0, moved);
    return withPromptOrder(payload, order);
}

/** Turns one module on or off without removing it. */
export function setPromptModuleEnabled(payload, identifier, enabled) {
    const order = getPromptOrder(payload).map(item => (
        item.identifier === identifier ? { ...item, enabled: Boolean(enabled) } : { ...item }
    ));
    if (!order.some(item => item.identifier === identifier)) {
        order.push({ identifier, enabled: Boolean(enabled) });
    }
    return withPromptOrder(payload, order);
}

/** Adds a prompt definition and places it at the end of the order. */
export function addPromptModule(payload, prompt) {
    const next = structuredClone(payload ?? {});
    next.prompts = Array.isArray(next.prompts) ? next.prompts : [];
    next.prompts.push(structuredClone(prompt));
    const order = getPromptOrder(next).map(item => ({ ...item }));
    order.push({ identifier: prompt.identifier, enabled: true });
    return withPromptOrder(next, order);
}

/** Updates a prompt definition in place, keeping fields this editor never shows. */
export function updatePromptModule(payload, identifier, changes) {
    if ((Array.isArray(payload?.prompts) ? payload.prompts : [])
        .some(prompt => prompt?.identifier === identifier && !canEditPrompt(prompt))) {
        return structuredClone(payload ?? {});
    }
    const next = structuredClone(payload ?? {});
    next.prompts = (Array.isArray(next.prompts) ? next.prompts : []).map(prompt => (
        prompt?.identifier === identifier ? { ...prompt, ...changes } : prompt
    ));
    return next;
}

/** Removes an allowed prompt definition and its order entry. */
export function removePromptModule(payload, identifier) {
    if ((Array.isArray(payload?.prompts) ? payload.prompts : [])
        .some(prompt => prompt?.identifier === identifier && !canRemovePrompt(prompt))) {
        return structuredClone(payload ?? {});
    }
    const next = structuredClone(payload ?? {});
    next.prompts = (Array.isArray(next.prompts) ? next.prompts : []).filter(prompt => prompt?.identifier !== identifier);
    const order = getPromptOrder(next).filter(item => item.identifier !== identifier);
    return withPromptOrder(next, order);
}

/** Prompt identities that must survive copy and paste unchanged. */
export function isReservedPrompt(prompt) {
    return Boolean(prompt?.marker) || Boolean(prompt?.system_prompt);
}

export function canEditPrompt(prompt) {
    return !Boolean(prompt?.marker);
}

export function canRemovePrompt(prompt) {
    return !Boolean(prompt?.system_prompt);
}

/**
 * Lists the fields that would tell someone else where your requests go.
 * Only Chat Completion presets carry them.
 * @returns {Array<{field: string, value: string, sensitive: boolean}>}
 */
export function reviewConnectionFields(apiId, payload) {
    if (!isCcApiId(apiId) || !payload || typeof payload !== 'object') {
        return [];
    }
    const found = [];
    for (const [field, value] of Object.entries(payload)) {
        if (value === '' || value === null || value === undefined || value === false) {
            continue;
        }
        const sensitive = SENSITIVE_FIELDS.includes(field);
        if (!sensitive && !CONNECTION_PATTERNS.some(pattern => pattern.test(field))) {
            continue;
        }
        found.push({ field, value: previewValue(value), sensitive });
    }
    found.sort((a, b) => Number(b.sensitive) - Number(a.sensitive) || a.field.localeCompare(b.field));
    return found;
}

function previewValue(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/** Returns a copy of the payload without the named fields. */
export function withoutFields(payload, fields) {
    const next = structuredClone(payload ?? {});
    for (const field of fields) {
        delete next[field];
    }
    return next;
}

/**
 * Checks a preset before it is saved or published.
 * @returns {string[]} problems in plain language
 */
export function validatePresetPayload(apiId, payload) {
    const problems = [];
    if (!isSupportedApiId(apiId)) {
        problems.push('This preset type is not supported.');
        return problems;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        problems.push('The preset must be a set of settings.');
        return problems;
    }
    if (isCcApiId(apiId)) {
        if (payload.prompts !== undefined && !Array.isArray(payload.prompts)) {
            problems.push('The prompt list is damaged.');
        }
        if (Array.isArray(payload.prompts)) {
            const seen = new Set();
            for (const prompt of payload.prompts) {
                const identifier = typeof prompt?.identifier === 'string' ? prompt.identifier.trim() : '';
                if (!identifier) {
                    problems.push('Every prompt needs an identifier.');
                    break;
                }
                if (seen.has(identifier)) {
                    problems.push(`Two prompts share the identifier "${identifier}".`);
                    break;
                }
                seen.add(identifier);
            }
        }
        if (payload.prompt_order !== undefined && !Array.isArray(payload.prompt_order)) {
            problems.push('The prompt order is damaged.');
        }
        const orphan = getPromptOrder(payload).find(entry => (
            !(Array.isArray(payload.prompts) ? payload.prompts : []).some(prompt => prompt?.identifier === entry?.identifier)
        ));
        if (orphan) {
            problems.push(`The order refers to a prompt that is missing: "${orphan.identifier}".`);
        }
    }
    return problems;
}

/**
 * Neconyan stores context, instruct, system prompt and reasoning presets
 * under the name inside the file, so it has to match the saved name.
 */
export function payloadNeedsName(apiId) {
    return ['context', 'instruct', 'sysprompt', 'reasoning'].includes(apiId);
}

/** Prepares the payload for saving under a given name. */
export function withCanonicalName(apiId, payload, name) {
    if (!payloadNeedsName(apiId)) {
        return structuredClone(payload ?? {});
    }
    return { ...structuredClone(payload ?? {}), name };
}

/**
 * The fields each Text Completion preset type is made of, in the order they
 * read best. Anything not listed here stays editable through the full text
 * view, so no setting is ever lost.
 */
export const PRESET_FIELDS = Object.freeze({
    context: [
        { key: 'story_string', label: 'Story string', type: 'prompt', rows: 8 },
        { key: 'example_separator', label: 'Example separator', type: 'text' },
        { key: 'chat_start', label: 'Chat start', type: 'text' },
        { key: 'use_stop_strings', label: 'Use stop strings', type: 'boolean' },
        { key: 'names_as_stop_strings', label: 'Names as stop strings', type: 'boolean' },
        { key: 'always_force_name2', label: 'Always add the character name', type: 'boolean' },
        { key: 'trim_sentences', label: 'Trim incomplete sentences', type: 'boolean' },
        { key: 'single_line', label: 'Single line replies', type: 'boolean' },
        { key: 'story_string_position', label: 'Story string position', type: 'number' },
        { key: 'story_string_depth', label: 'Story string depth', type: 'number' },
    ],
    instruct: [
        { key: 'system_sequence_prefix', label: 'System prefix', type: 'text' },
        { key: 'system_sequence', label: 'System sequence', type: 'text' },
        { key: 'system_suffix', label: 'System suffix', type: 'text' },
        { key: 'system_sequence_suffix', label: 'System end', type: 'text' },
        { key: 'input_sequence', label: 'User sequence', type: 'text' },
        { key: 'input_suffix', label: 'User suffix', type: 'text' },
        { key: 'output_sequence', label: 'Assistant sequence', type: 'text' },
        { key: 'output_suffix', label: 'Assistant suffix', type: 'text' },
        { key: 'first_input_sequence', label: 'First user sequence', type: 'text' },
        { key: 'first_output_sequence', label: 'First assistant sequence', type: 'text' },
        { key: 'last_input_sequence', label: 'Last user sequence', type: 'text' },
        { key: 'last_output_sequence', label: 'Last assistant sequence', type: 'text' },
        { key: 'stop_sequence', label: 'Stop sequence', type: 'text' },
        { key: 'user_alignment_message', label: 'User filler message', type: 'prompt', rows: 3 },
        { key: 'wrap', label: 'Wrap sequences with a new line', type: 'boolean' },
        { key: 'macro', label: 'Replace macros in sequences', type: 'boolean' },
        { key: 'skip_examples', label: 'Skip example dialogues', type: 'boolean' },
        { key: 'sequences_as_stop_strings', label: 'Sequences as stop strings', type: 'boolean' },
        { key: 'activation_regex', label: 'Activation regex', type: 'text' },
    ],
    sysprompt: [
        { key: 'content', label: 'System prompt', type: 'prompt', rows: 8 },
        { key: 'post_history', label: 'Post-history instructions', type: 'prompt', rows: 5 },
    ],
    reasoning: [
        { key: 'prefix', label: 'Prefix', type: 'text' },
        { key: 'suffix', label: 'Suffix', type: 'text' },
        { key: 'separator', label: 'Separator', type: 'text' },
    ],
});

/** A blank preset of the requested type. */
export function blankPayload(apiId, name) {
    if (isCcApiId(apiId)) {
        return {
            prompts: [],
            prompt_order: [{ character_id: GLOBAL_PROMPT_ORDER_ID, order: [] }],
        };
    }
    return payloadNeedsName(apiId) ? { name } : {};
}
