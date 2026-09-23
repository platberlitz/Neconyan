import { roleplayError } from '../roleplay-store.js';
import { isDeepStrictEqual } from 'node:util';

const ROLES = ['system', 'user', 'assistant'];

/** Depth positions may use only an exact plain-text suffix of the protected chat. */
export function assertWorldInfoDepthHistory(records, messages, historyStart) {
    if (!Array.isArray(records) || !Array.isArray(messages) || !Number.isSafeInteger(historyStart)
        || historyStart < 0 || historyStart > messages.length) {
        throw roleplayError('ROLEPLAY_INVALID', 'World Info needs a saved chat history boundary for depth insertion.', 409);
    }
    const history = records.slice(1).map(record => {
        if (typeof record.mes !== 'string' || typeof record.is_user !== 'boolean'
            || Object.keys(record).some(key => !['name', 'is_user', 'mes', 'swipes', 'swipe_id', 'swipe_info', 'extra', 'send_date'].includes(key))
            || (record.extra && Object.keys(record.extra).length)) {
            throw roleplayError('ROLEPLAY_INVALID', 'This saved chat needs server handling for its non-text content.', 409);
        }
        return { role: record.is_user ? 'user' : 'assistant', content: record.mes };
    });
    const selected = messages.slice(historyStart);
    if (!selected.length || selected.length > history.length || !isDeepStrictEqual(selected, history.slice(-selected.length))) {
        throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'World Info depth history differs from the protected chat.', 409);
    }
}

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
