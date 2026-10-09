import { nativeToolDefinitions } from '../generation/native-tool-definitions.js';
import { normaliseRoleplayToolCalls } from '../generation/roleplay-tool-calls.js';
import { normaliseCharacterDraft } from '../../public/scripts/neconyan-character-draft.js';
import { CREATE_CHARACTER_GUIDE } from '../../public/scripts/neconyan-assistant-tool-guidance.js';

const NAME = 'Neconyan_Assistant_CreateCharacter';

/** Scratchpad tools end the turn with a review card, just like its other proposed changes. */
export function scratchpadCharacterTools() {
    const [tool] = structuredClone(nativeToolDefinitions([NAME]));
    tool.function.description = `Prepare a new character card for the owner's Scratchpad review. This ends your turn with a review card. Nothing is created until the owner presses Save change. Do not claim it is already saved. ${CREATE_CHARACTER_GUIDE}`;
    delete tool.function.parameters.properties.userConfirmed;
    tool.function.parameters.required = tool.function.parameters.required.filter(key => key !== 'userConfirmed');
    return [tool];
}

export const CHARACTER_CREATION_INSTRUCTIONS = [
    'You can create new character cards from any Scratchpad, including Notes.',
    `When available, call ${NAME} with the complete character draft. The call becomes a review card and ends your turn; it does not save the character yet.`,
    'Ask only for missing details about the character, format and avatar choice. Use the default picture unless the user wants a generated avatar.',
    'Without function tools, write the same draft in a scratchpad-change fenced JSON block: {"type":"character","action":"create","character":{"name":"Name","description":"Complete description","first_mes":"Opening greeting"},"characterNote":"","alternateGreetings":[],"avatarPrompt":""}.',
    'The owner can edit the draft and press Save change. Never say the character has been saved before that.',
].join('\n');

/** Persist tool-only replies as ordinary review cards, so reloads and round tables need no browser callback. */
export function characterToolReply(response, tools) {
    const calls = normaliseRoleplayToolCalls(response, tools.map(tool => tool.function.name));
    if (!calls.length) return { text: String(response?.text ?? '').trim(), hasTools: false };
    const text = String(response?.text ?? '').trim();
    const existingChanges = [...text.matchAll(/```scratchpad-change[^\n]*\n[\s\S]*?```/g)].length;
    if (calls.length + existingChanges > 24) throw new Error('Scratchpad can review up to 24 changes per reply.');
    const drafts = calls.map(call => {
        const change = { type: 'character', action: 'create', ...normaliseCharacterDraft(call.arguments) };
        // Markdown inside character fields must not close the surrounding change block.
        const json = JSON.stringify(change).replaceAll('`', '\\u0060');
        return '```scratchpad-change\n' + json + '\n```';
    });
    return { text: [text, ...drafts].filter(Boolean).join('\n\n'), hasTools: true };
}
