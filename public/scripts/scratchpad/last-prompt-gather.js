// Collects the 'Last prompt sent' section in the browser before a Scratchpad reply is requested.
// It is loaded only when the switch is on, so nothing here runs otherwise.
import { readItemizedPromptsForChat } from '../itemized-prompts.js';
import { readLastPrompt } from './api.js';
import {
    formatLastPrompt,
    formatMissingLastPrompt,
    hiddenEntryNeedles,
    itemizedPromptRecord,
    latestItemizedPrompt,
    pickLatestPrompt,
} from './last-prompt.js';

/**
 * Finds the newest prompt sent for the open chat, from this browser or from the server.
 * @param {object} source Scratchpad source for the open Roleplay chat or Conversation branch.
 * @param {object} wire The same source in the shape the server accepts.
 * @returns {Promise<object|null>} The newest prompt record, or null when none was sent.
 */
export async function findLastPrompt(source, wire) {
    if (source?.kind !== 'roleplay' && source?.kind !== 'conversation') return null;
    const records = [];
    if (source.kind === 'roleplay' && source.chatId) {
        const record = itemizedPromptRecord(latestItemizedPrompt(await readItemizedPromptsForChat(source.chatId)));
        if (record) records.push(record);
    }
    try {
        const payload = await readLastPrompt(wire);
        if (payload?.prompt) records.push(payload.prompt);
    } catch (error) {
        console.warn('Scratchpad could not read the last prompt kept on the server:', error);
    }
    return pickLatestPrompt(records);
}

/**
 * Builds the '## Last prompt sent' section with hidden lorebook entries scrubbed.
 * @param {object} source Scratchpad source.
 * @param {{ wire: object, hiddenEntries?: object[], substitutes?: ((text: string) => string)[], maxBytes: number }} options
 * @returns {Promise<{ text: string, shared: boolean, hidden: number, redactions: number, trimmed: number }>}
 */
export async function gatherLastPrompt(source, { wire, hiddenEntries = [], substitutes = [], maxBytes }) {
    const record = await findLastPrompt(source, wire);
    if (!record) return { text: formatMissingLastPrompt(), shared: false, hidden: 0, redactions: 0, trimmed: 0 };
    const formatted = formatLastPrompt(record, { hiddenNeedles: hiddenEntryNeedles(hiddenEntries, substitutes), maxBytes });
    return { ...formatted, shared: true };
}
