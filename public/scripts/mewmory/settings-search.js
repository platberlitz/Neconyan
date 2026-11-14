import { DECISION_ROLES } from './jev-presets.js';

/** Folded Settings sections, in page order, with the line shown under each title. */
export const SETTINGS_FOLDS = Object.freeze({
    automatic: 'When Mewmory records, and how much recent chat stays in replies',
    models: 'Which model does each job, backup connections and prefills',
    search: 'Search method and how many memories a reply may use',
    upkeep: 'Progress, whole-chat updates and model calls for this chat',
    transfers: 'Save or restore this chat’s memories',
    lorebook: 'Copy memories into a lorebook',
    continue: 'Link this chat to an earlier one',
});

export const DEFAULT_OPEN_FOLDS = Object.freeze(['automatic']);

const TEXT_ROLES = Object.freeze(['extractor', 'pawspective', 'selector', 'fallback']);

/** Settings that only one kind of model role shows, so a search can point to the role that has them. */
export const ROLE_ONLY_SETTINGS = Object.freeze([
    { label: 'Embedding connection', words: 'native vectorization provider', roles: ['embedding'] },
    { label: 'Prefix preset', words: 'query document prefix embeddings', roles: ['embedding'] },
    { label: 'Query prefix, optional', words: 'embeddings', roles: ['embedding'] },
    { label: 'Document prefix, optional', words: 'embeddings', roles: ['embedding'] },
    { label: 'Prefill, optional', words: 'assistant prefill start reply', roles: TEXT_ROLES },
    { label: 'Partial prefill for Kimi K3, optional', words: 'k3.1 pro partial think reasoning', roles: TEXT_ROLES },
    { label: 'Jev / decision model preset', words: 'system one decision', roles: DECISION_ROLES },
    { label: 'Decision protocol', words: 'jev system one decision api', roles: DECISION_ROLES },
    { label: 'Decision score threshold', words: 'jev system one decision', roles: DECISION_ROLES },
]);

const SYNONYMS = Object.freeze({
    backup: ['fallback'],
    fallback: ['backup'],
    timeout: ['took too long'],
});

/** A search word, its singular and the words that mean the same here. */
function wordForms(term) {
    const singular = term.length > 4 && term.endsWith('s') && !term.endsWith('ss') ? term.slice(0, -1) : term;
    return [...new Set([term, singular, ...(SYNONYMS[term] || []), ...(SYNONYMS[singular] || [])])];
}

function normalize(text) {
    return String(text ?? '').toLowerCase().replace(/[‘’]/g, '\'').replace(/[“”]/g, '"').replace(/\s+/g, ' ');
}

/** The lower-case words of a settings search, without empty entries. */
export function searchTerms(query) {
    return normalize(query).trim().split(' ').filter(Boolean);
}

/** True when every search word, or one of its synonyms, appears in the text. */
export function matchesTerms(text, terms) {
    const haystack = normalize(text);
    return terms.every(term => wordForms(term).some(form => haystack.includes(form)));
}

/**
 * Other model roles whose own settings match the search when the role on screen does not have them.
 * @param {string[]} terms
 * @param {string} currentRole
 * @param {Record<string, string>} roleLabels
 * @returns {{ role: string, label: string, settings: string[] }[]}
 */
export function otherRoleMatches(terms, currentRole, roleLabels) {
    if (!terms.length) return [];
    const found = new Map();
    for (const setting of ROLE_ONLY_SETTINGS) {
        if (setting.roles.includes(currentRole)) continue;
        for (const role of setting.roles) {
            if (!roleLabels[role] || !matchesTerms([roleLabels[role], setting.label, setting.words].join(' '), terms)) continue;
            if (!found.has(role)) found.set(role, { role, label: roleLabels[role], settings: [] });
            found.get(role).settings.push(setting.label);
        }
    }
    return Object.keys(roleLabels).filter(role => found.has(role)).map(role => found.get(role));
}

/** Which Settings sections start open: the saved choice, or only the first section. */
export function readOpenFolds(saved) {
    try {
        const list = JSON.parse(saved);
        if (Array.isArray(list)) return new Set(list.filter(key => Object.hasOwn(SETTINGS_FOLDS, key)));
    } catch {
        // A missing or damaged saved choice falls back to the default.
    }
    return new Set(DEFAULT_OPEN_FOLDS);
}
