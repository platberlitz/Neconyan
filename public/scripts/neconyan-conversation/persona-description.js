import { PERSONA_APPENDICES_DEFAULT_SCOPE_KEY, PERSONA_APPENDICES_SELECTIONS_KEY } from './constants.js';

export function conversationPersonaAppendices(descriptor) {
    if (!Array.isArray(descriptor?.appendices)) return [];
    return descriptor.appendices.map((appendix, index) => {
        const name = String(appendix?.name || `Scenario Note ${index + 1}`).trim() || `Scenario Note ${index + 1}`;
        return {
            id: String(appendix?.id || `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${index}`).trim(),
            name, description: String(appendix?.description ?? ''),
        };
    }).filter(appendix => appendix.id);
}

export function conversationPersonaSelection(descriptor, scopeKey, legacyScopeKey) {
    const source = descriptor?.[PERSONA_APPENDICES_SELECTIONS_KEY];
    const selections = Array.isArray(source) ? { [PERSONA_APPENDICES_DEFAULT_SCOPE_KEY]: source } : source || {};
    const scoped = Object.prototype.hasOwnProperty.call(selections, scopeKey)
        ? selections[scopeKey] : selections[legacyScopeKey] ?? selections[PERSONA_APPENDICES_DEFAULT_SCOPE_KEY];
    const selected = scoped ?? selections[PERSONA_APPENDICES_DEFAULT_SCOPE_KEY] ?? [];
    return Array.isArray(selected) ? selected.map(String) : [];
}

export function composePersonaDescription(descriptor, selected) {
    const chunks = [];
    const description = String(descriptor?.description ?? '').trim();
    if (description) chunks.push(description);
    const ids = new Set(selected);
    for (const appendix of conversationPersonaAppendices(descriptor)) {
        if (ids.has(appendix.id) && appendix.description.trim()) {
            // Parentheses keep note labels out of the reply command grammar.
            chunks.push(`(${appendix.name})\n${appendix.description.trim()}`);
        }
    }
    return chunks.join('\n\n');
}
