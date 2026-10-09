import { nativeToolDefinitions } from '../generation/native-tool-definitions.js';
import { normaliseRoleplayToolCalls } from '../generation/roleplay-tool-calls.js';
import { normaliseCharacterDraft } from '../../public/scripts/neconyan-character-draft.js';
import { CREATE_CHARACTER_GUIDE } from '../../public/scripts/neconyan-assistant-tool-guidance.js';
import { supportsChatTools } from '../../public/scripts/chat-input-capabilities.js';
import { prepareRoleplayCapabilities } from '../generation/roleplay-capabilities.js';
import { resolveGenerationProfile } from '../generation/profiles.js';
import { fetchChatProfileModels } from '../generation/service.js';

const NAME = 'Neconyan_Assistant_CreateCharacter';
const CATALOGUE_TTL = 10 * 60 * 1000;
const catalogues = new Map();

/** Model lists only decide tool support, so a short reuse keeps every Scratchpad message from waiting on one. */
function cachedCatalogue(fetchModels) {
    return async options => {
        const { context, material } = options;
        const key = JSON.stringify([context.owner, material.source, material.profile?.['secret-id'] ?? '']);
        const saved = catalogues.get(key);
        if (saved && Date.now() - saved.at < CATALOGUE_TTL) return saved.models;
        const models = await fetchModels(options);
        catalogues.delete(key);
        catalogues.set(key, { at: Date.now(), models });
        if (catalogues.size > 64) catalogues.delete(catalogues.keys().next().value);
        return models;
    };
}

/**
 * Offer the character tool only where Roleplay would: function calling on, a tool-capable model and a prompt
 * format that keeps tools. Otherwise the model drafts the card in a fenced block.
 */
export async function scratchpadToolsFor(context, binding, tools, { artifactName, resolveProfile = resolveGenerationProfile,
    fetchModels = fetchChatProfileModels } = {}) {
    if (!tools?.length) return [];
    try {
        const material = resolveProfile(context.directories, binding);
        if (material.backend && material.backend !== 'chat') return [];
        const { settings, models } = await prepareRoleplayCapabilities(context, material, binding,
            { artifactName, fetchModels: cachedCatalogue(fetchModels) });
        return supportsChatTools(settings, material.profile?.model, { model_list: models }) ? tools : [];
    } catch (error) {
        if (context.signal?.aborted) throw error;
        console.warn('Scratchpad could not check tool support, so it will ask for a text draft instead.', error?.message ?? error);
        return [];
    }
}

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
        let draft;
        // One unusable draft should not throw away the reply text or the other drafts.
        try { draft = normaliseCharacterDraft(call.arguments); } catch (error) {
            return `A character draft could not be used: ${String(error?.message || 'it was not valid.').slice(0, 300)}`;
        }
        const change = { type: 'character', action: 'create', ...draft };
        // Markdown inside character fields must not close the surrounding change block.
        const json = JSON.stringify(change).replaceAll('`', '\\u0060');
        return '```scratchpad-change\n' + json + '\n```';
    });
    return { text: [text, ...drafts].filter(Boolean).join('\n\n'), hasTools: true };
}
