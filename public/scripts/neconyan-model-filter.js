/**
 * Model list filtering for the Neconyan shell.
 *
 * Single-choice model selects use the searchable list in model-list-search.js.
 * Only selects that list cannot cover (multiple choice) get a filter input here.
 */
export const MODEL_FILTER_BOTH_VIEWPORTS_SELECTORS = [];

export const MODEL_FILTER_PHONE_ONLY_SELECTORS = [
    // Horde picks several models at once.
    '#horde_model',
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
