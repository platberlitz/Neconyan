/**
 * Model list filtering for the Neconyan shell.
 *
 * The select ids here are the ones without a built-in search: desktop Select2
 * covers another set, and the Model ID providers have their own filter inputs.
 */
export const MODEL_FILTER_BOTH_VIEWPORTS_SELECTORS = [
    '#model_mistralai_select',
    '#model_groq_select',
    '#model_siliconflow_select',
    '#model_minimax_select',
    '#model_deepseek_select',
    '#model_fireworks_select',
    '#model_cometapi_select',
    '#model_xai_select',
    '#model_pollinations_select',
    '#model_moonshot_select',
    '#model_novel_select',
];

export const MODEL_FILTER_PHONE_ONLY_SELECTORS = [
    // Chat completion selects that only get Select2 on desktop.
    '#model_openai_select',
    '#model_openrouter_select',
    '#model_aimlapi_select',
    '#model_electronhub_select',
    '#model_chutes_select',
    '#model_nanogpt_select',
    '#model_workers_ai_select',
    '#horde_model',
    // Text completion selects.
    '#mancer_model',
    '#model_togetherai_select',
    '#ollama_model',
    '#tabby_model',
    '#llamacpp_model',
    '#model_infermaticai_select',
    '#model_dreamgen_select',
    '#openrouter_model',
    '#vllm_model',
    '#aphrodite_model',
];

/**
 * Decides which options stay visible for a query. Matching is a case-insensitive
 * substring against the option text or its value. The currently selected value is
 * always kept so filtering can never silently change the model in use, and a
 * multiple select keeps every selected option.
 *
 * @param {{ value: string, text: string }[]} masterOptions
 * @param {string} query
 * @param {{ currentValue?: string, selectedValues?: string[], multiple?: boolean }} [state]
 * @returns {{ value: string, text: string }[]}
 */
export function computeVisibleModelOptions(masterOptions, query, {
    currentValue = '',
    selectedValues = [],
    multiple = false,
} = {}) {
    const normalizedQuery = String(query ?? '').toLowerCase().trim();
    if (!normalizedQuery) {
        return masterOptions.slice();
    }

    const selected = new Set(selectedValues);
    return masterOptions.filter(option => {
        if (multiple ? selected.has(option.value) : option.value === currentValue) {
            return true;
        }
        return String(option.text ?? '').toLowerCase().includes(normalizedQuery)
            || String(option.value ?? '').toLowerCase().includes(normalizedQuery);
    });
}
