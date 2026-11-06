/** Fields Scratchpad may change in a shared preset, never connection settings. */
export const PRESET_FIELDS = Object.freeze({
    openai: ['content', 'name', 'role', 'enabled', 'injection_depth', 'injection_position'],
    sysprompt: ['content', 'post_history'],
    context: ['story_string', 'example_separator', 'chat_start'],
    instruct: ['input_sequence', 'input_suffix', 'output_sequence', 'output_suffix', 'system_sequence', 'system_suffix',
        'last_system_sequence', 'user_alignment_message', 'stop_sequence', 'first_output_sequence', 'last_output_sequence',
        'first_input_sequence', 'last_input_sequence', 'story_string_prefix', 'story_string_suffix'],
});

export function normalisePresetTargets(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(item => item && typeof item.api === 'string' && Object.hasOwn(PRESET_FIELDS, item.api)
        && typeof item.name === 'string' && item.name.trim() && item.name.length <= 300)
        .slice(0, 3).map(({ api, name }) => ({ api, name }));
}

export function validPresetValue(api, field, value) {
    if (typeof api !== 'string' || !Object.hasOwn(PRESET_FIELDS, api) || !PRESET_FIELDS[api].includes(field)) return false;
    if (api === 'openai') {
        if (field === 'enabled') return typeof value === 'boolean';
        if (field === 'injection_depth') return Number.isInteger(value) && value >= 0 && value <= 10000;
        if (field === 'injection_position') return value === 0 || value === 1;
        if (field === 'role') return ['system', 'user', 'assistant'].includes(value);
        if (field === 'name') return typeof value === 'string' && Boolean(value.trim()) && value.length <= 300;
    }
    return typeof value === 'string' && value.length <= 200_000;
}
