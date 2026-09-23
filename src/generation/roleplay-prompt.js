import { roleplayError } from '../roleplay-store.js';

const ROLES = ['system', 'user', 'assistant'];

/** Place saved depth entries within the captured history, never among system prompts. */
export function insertWorldInfoDepth(messages, entries, historyStart) {
    if (!Number.isSafeInteger(historyStart) || historyStart < 0 || historyStart > messages.length
        || !Array.isArray(entries) || entries.some(value => !value || !Number.isSafeInteger(value.depth)
            || value.depth < 0 || value.depth > 10000 || !Number.isInteger(value.role) || !ROLES[value.role]
            || !Array.isArray(value.entries) || value.entries.some(text => typeof text !== 'string'))) {
        throw roleplayError('ROLEPLAY_INVALID', 'World Info needs a saved chat history boundary for depth insertion.', 409);
    }
    const prefix = messages.slice(0, historyStart);
    const history = messages.slice(historyStart).reverse();
    let inserted = 0;
    for (const depth of [...new Set(entries.map(value => value.depth))].sort((a, b) => a - b)) {
        const injections = ROLES.flatMap((role, index) => entries
            .filter(value => value.depth === depth && value.role === index)
            .map(value => ({ role, content: value.entries.join('\n') })).filter(value => value.content));
        history.splice(depth + inserted, 0, ...injections);
        inserted += injections.length;
    }
    return [...prefix, ...history.reverse()];
}
