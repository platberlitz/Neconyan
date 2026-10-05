import { roleplayError } from '../roleplay-store.js';
import { NOTE_MUTATING_KINDS, NOTE_TOOL_KINDS } from '../../public/scripts/notebooks/assistant-note-tools.js';

export const ASSISTANT_PREFIX = 'Neconyan_Assistant_';
export const ASSISTANT_TOOLS = Object.freeze({
    ListLorebooks: 'lorebooks', ListLorebookEntries: 'lorebook-entries', ReadLorebookEntry: 'lorebook-entry',
    EditLorebookEntry: 'edit-lorebook-entry', ListAgents: 'agents', ReadAgent: 'agent', CreateAgent: 'create-agent', EditAgent: 'edit-agent',
    ListModelPresets: 'presets', ReadModelPreset: 'preset', EditModelPreset: 'edit-preset',
    ListCharacters: 'characters', ReadCharacter: 'character', EditCharacter: 'edit-character',
    CreateCharacter: 'create-character', ...NOTE_TOOL_KINDS,
});
export const assistantToolMutates = tool => typeof tool === 'string'
    && (tool.startsWith('edit-') || tool === 'create-character' || tool === 'create-agent' || NOTE_MUTATING_KINDS.includes(tool));

export const EDITABLE_CHARACTER_FIELDS = Object.freeze(['name', 'description', 'personality', 'scenario', 'first_mes',
    'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions']);
export const EDITABLE_AGENT_FIELDS = Object.freeze(['name', 'description', 'prompt', 'tags', 'favorite', 'connectionProfile', 'modelOverride']);
export const PRESET_FIELDS = Object.freeze({
    kobold: ['grammar', 'temp', 'top_p', 'top_k', 'top_a', 'min_p', 'typical', 'tfs', 'rep_pen', 'rep_pen_range',
        'rep_pen_slope', 'mirostat', 'mirostat_tau', 'mirostat_eta', 'sampler_order'],
    novel: ['prefix', 'temperature', 'top_p', 'top_k', 'top_a', 'min_p', 'typical_p', 'tail_free_sampling',
        'repetition_penalty', 'repetition_penalty_range', 'repetition_penalty_slope', 'repetition_penalty_frequency',
        'repetition_penalty_presence', 'phrase_rep_pen', 'mirostat_tau', 'mirostat_lr', 'max_length', 'max_context', 'order'],
    openai: ['temperature', 'frequency_penalty', 'presence_penalty', 'top_p', 'top_k', 'top_a', 'min_p', 'typical_p',
        'repetition_penalty', 'seed', 'n', 'openai_max_context', 'openai_max_tokens', 'new_chat_prompt',
        'new_group_chat_prompt', 'new_example_chat_prompt', 'continue_nudge_prompt', 'impersonation_prompt',
        'assistant_prefill', 'continue_prefill', 'send_if_empty', 'squash_system_messages', 'names_behavior',
        'media_inlining', 'use_sysprompt'],
    textgenerationwebui: ['temp', 'temperature_last', 'rep_pen', 'rep_pen_range', 'rep_pen_decay', 'rep_pen_slope',
        'no_repeat_ngram_size', 'top_k', 'top_p', 'top_a', 'tfs', 'epsilon_cutoff', 'eta_cutoff', 'typical_p',
        'min_p', 'penalty_alpha', 'num_beams', 'length_penalty', 'min_length', 'dynatemp', 'min_temp', 'max_temp',
        'dynatemp_exponent', 'smoothing_factor', 'smoothing_curve', 'dry_allowed_length', 'dry_multiplier',
        'dry_base', 'dry_sequence_breakers', 'dry_penalty_last_n', 'max_tokens_second', 'encoder_rep_pen',
        'freq_pen', 'presence_pen', 'skew', 'do_sample', 'early_stopping', 'seed', 'add_bos_token', 'ban_eos_token',
        'skip_special_tokens', 'include_reasoning', 'mirostat_mode', 'mirostat_tau', 'mirostat_eta', 'grammar_string',
        'negative_prompt', 'sampler_order'],
});

const NUMERIC = Object.freeze({
    temperature: [0, 4], temp: [0, 4], top_p: [0, 1], top_a: [0, 1], min_p: [0, 1], typical: [0, 1],
    typical_p: [0, 1], tfs: [0, 1], tail_free_sampling: [0, 1], frequency_penalty: [-2, 2], presence_penalty: [-2, 2],
    repetition_penalty: [0, 10], rep_pen: [0, 10], rep_pen_range: [0, 1000000], repetition_penalty_range: [0, 1000000],
    rep_pen_slope: [0, 10], repetition_penalty_slope: [0, 10], repetition_penalty_frequency: [-10, 10],
    repetition_penalty_presence: [-10, 10], mirostat: [0, 2], mirostat_mode: [0, 2], mirostat_tau: [0, 100],
    mirostat_eta: [0, 10], mirostat_lr: [0, 10], top_k: [0, 1000000], seed: [-1, 2147483647], n: [1, 128],
    openai_max_context: [1, 1000000], openai_max_tokens: [1, 1000000], max_length: [0, 1000000],
    max_context: [1, 1000000], no_repeat_ngram_size: [0, 1000000], epsilon_cutoff: [0, 1], eta_cutoff: [0, 1],
    penalty_alpha: [0, 10], num_beams: [1, 1000], length_penalty: [-10, 10], min_length: [0, 1000000],
    min_temp: [0, 4], max_temp: [0, 4], dynatemp_exponent: [0, 10], smoothing_factor: [0, 10],
    smoothing_curve: [0, 10], dry_allowed_length: [0, 1000000], dry_multiplier: [0, 10], dry_base: [0, 10],
    dry_penalty_last_n: [0, 1000000], max_tokens_second: [0, 1000000], encoder_rep_pen: [0, 10],
    freq_pen: [-10, 10], presence_pen: [-10, 10], skew: [-10, 10], names_behavior: [0, 10],
});
const API_NUMERIC = Object.freeze({
    kobold: { temp: [0, 4], top_k: [0, 100], rep_pen: [1, 3], rep_pen_range: [0, 4096], mirostat_tau: [0, 20], mirostat_eta: [0, 1] },
    novel: { temperature: [0.1, 2.5], repetition_penalty: [1, 8], top_k: [0, 300], mirostat_tau: [0, 6], mirostat_lr: [0, 1] },
    openai: { temperature: [0, 2], top_k: [0, 500], openai_max_context: [512, 2000000], openai_max_tokens: [1, 128000] },
    textgenerationwebui: { temp: [0, 5], max_temp: [0, 5], top_k: [0, 1000000], rep_pen: [0, 10] },
});
const INTEGER = new Set(['top_k', 'rep_pen_range', 'repetition_penalty_range', 'mirostat', 'mirostat_mode', 'seed', 'n',
    'openai_max_context', 'openai_max_tokens', 'max_length', 'max_context', 'no_repeat_ngram_size', 'num_beams',
    'min_length', 'dry_allowed_length', 'dry_penalty_last_n', 'max_tokens_second', 'names_behavior']);

const invalid = message => roleplayError('ASSISTANT_TOOL_INVALID', message, 409);
export const assistantToolName = name => typeof name === 'string' && name.startsWith(ASSISTANT_PREFIX)
    && Object.hasOwn(ASSISTANT_TOOLS, name.slice(ASSISTANT_PREFIX.length))
    ? ASSISTANT_TOOLS[name.slice(ASSISTANT_PREFIX.length)] : null;

export function projectAssistantAgent(agent) {
    return { id: agent.id, name: String(agent.name ?? ''), description: String(agent.description ?? ''),
        prompt: String(agent.prompt ?? ''), tags: Array.isArray(agent.tags) ? [...agent.tags] : [],
        favorite: Boolean(agent.favorite), connectionProfile: String(agent.connectionProfile ?? ''),
        modelOverride: String(agent.modelOverride ?? '') };
}

export function projectAssistantCharacter(character, avatar) {
    const result = { avatar };
    for (const field of EDITABLE_CHARACTER_FIELDS) {
        const value = character.data?.[field] ?? character[field];
        if (value !== undefined) result[field] = String(value ?? '');
    }
    return result;
}

export function projectAssistantPreset(api, preset) {
    if (!Object.hasOwn(PRESET_FIELDS, api)) throw invalid('The model preset API is not supported by assistant tools.');
    return Object.fromEntries(PRESET_FIELDS[api].filter(field => Object.hasOwn(preset, field)).map(field => [field, structuredClone(preset[field])]));
}

export function validateAssistantPresetValue(api, field, value, current) {
    if (!Object.hasOwn(PRESET_FIELDS, api) || !PRESET_FIELDS[api].includes(field)) throw invalid('This model preset field cannot be edited.');
    if (Array.isArray(current)) {
        if (!Array.isArray(value) || value.some(item => !Number.isSafeInteger(item)) || value.length !== current.length
            || new Set(value).size !== value.length || value.some(item => !current.includes(item))) throw invalid('The sampler order must contain the existing IDs exactly once.');
        return [...value];
    }
    if (typeof current === 'boolean') {
        if (typeof value !== 'boolean') throw invalid('This preset field requires a boolean.');
        return value;
    }
    if (typeof current === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value) || INTEGER.has(field) && !Number.isSafeInteger(value)) throw invalid('This preset field requires a finite number of the saved type.');
        const [min, max] = API_NUMERIC[api]?.[field] ?? NUMERIC[field] ?? [-Infinity, Infinity];
        if (value < min || value > max) throw invalid('The requested preset value is outside its supported range.');
        return value;
    }
    if (typeof current === 'string') {
        if (typeof value !== 'string') throw invalid('This preset field requires a string.');
        return value;
    }
    throw invalid('This saved preset field has an unsupported value type.');
}
