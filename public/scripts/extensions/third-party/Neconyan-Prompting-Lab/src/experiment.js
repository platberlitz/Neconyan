import { sendPrompt } from './ab.js';
import { ctxOf, getContext } from './host.js';

/**
 * Prompt experiments: send a prompt and a modified version of it through the
 * same connection, against the same scenario and character card, and show the
 * two replies next to each other. The only difference between the two requests
 * is the prompt text, so any difference in the replies points at the change.
 *
 * Like Compare models, this spends tokens, so nothing is sent until asked.
 */

const PROMPT_ROLES = new Set(['system', 'user', 'assistant']);

/** A character's card fields, read from what the host has loaded. */
export function readCharacterCard(avatar, hostRef = getContext) {
    const context = ctxOf(hostRef);
    const character = (context?.characters ?? []).find(item => item?.avatar === avatar);
    if (!character) {
        return null;
    }
    const data = character.data ?? {};
    const fieldOf = (own, stored) => String(own ?? stored ?? '');
    const firstMessage = fieldOf(character.first_mes, data.first_mes);
    const alternates = (Array.isArray(data.alternate_greetings) ? data.alternate_greetings : [])
        .map(text => String(text ?? ''))
        .filter(text => text.trim());
    return {
        avatar: String(character.avatar),
        name: String(character.name ?? character.avatar),
        description: fieldOf(character.description, data.description),
        personality: fieldOf(character.personality, data.personality),
        scenario: fieldOf(character.scenario, data.scenario),
        firstMessage,
        // A card can open several ways; the lab lets the user say which.
        greetings: [firstMessage, ...alternates].filter(text => text.trim()),
    };
}

/**
 * The openings a card offers, ready for a menu: the first message, then any
 * alternate greetings, each with enough of its own text to be told apart.
 */
export function greetingChoices(character) {
    const greetings = character?.greetings ?? [];
    return greetings.map((text, index) => ({
        index,
        text,
        label: index === 0 ? 'First message' : `Alternate greeting ${index}`,
        snippet: snippetOf(text),
    }));
}

const SNIPPET_LENGTH = 60;

function snippetOf(text) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH - 1)}…` : flat;
}

function characterCardText(character) {
    if (!character) {
        return '';
    }
    const parts = [];
    if (character.description.trim()) {
        parts.push(`Character description of ${character.name}:\n${character.description.trim()}`);
    }
    if (character.personality.trim()) {
        parts.push(`Personality of ${character.name}:\n${character.personality.trim()}`);
    }
    if (character.scenario.trim()) {
        parts.push(`Scenario:\n${character.scenario.trim()}`);
    }
    return parts.join('\n\n');
}

/**
 * Builds the message list one experiment variant sends: the prompt under its
 * role, then the character card, the character's greeting, and the scenario
 * message. Both variants use this builder, so the prompt text is the only
 * thing that can differ between them.
 */
export function buildExperimentMessages({
    prompt = '',
    role = 'system',
    character = null,
    scenario = '',
    greeting = null,
} = {}) {
    const messages = [];
    const content = String(prompt ?? '');
    if (content.trim()) {
        messages.push({ role: PROMPT_ROLES.has(role) ? role : 'system', content });
    }
    const card = characterCardText(character);
    if (card) {
        messages.push({ role: 'system', content: card });
    }
    // The chosen opening, or the card's own first message when none was picked.
    const opening = typeof greeting === 'string' ? greeting : (character?.firstMessage ?? '');
    if (opening.trim()) {
        messages.push({ role: 'assistant', content: opening });
    }
    messages.push({ role: 'user', content: String(scenario ?? '').trim() || 'Hello.' });
    return messages;
}

/**
 * Sends both prompt variants at the same time under the same profile.
 *
 * @returns {Promise<Array<{key: string, prompt: string, messages: Array,
 *   profileId: string, text: string, error: string|null}>>}
 */
export async function runExperiment({
    promptA = '',
    promptB = '',
    role = 'system',
    character = null,
    scenario = '',
    greeting = null,
    profileId = '',
    hostRef = getContext,
    maxTokens = 300,
    signal = null,
} = {}) {
    const variants = [
        { key: 'A', prompt: String(promptA ?? '') },
        { key: 'B', prompt: String(promptB ?? '') },
    ];
    return Promise.all(variants.map(async (variant) => {
        const messages = buildExperimentMessages({
            prompt: variant.prompt,
            role,
            character,
            scenario,
            greeting,
        });
        const result = await sendPrompt(profileId, messages, { hostRef, maxTokens, signal });
        return { ...variant, messages, ...result };
    }));
}

/**
 * The request behind the optional analysis: one model is shown both prompts
 * and both replies and asked what changed and what the replies show. The
 * instructions ask for evidence, and for honesty when there is no real
 * difference, so the analysis stays a reading aid rather than a verdict.
 */
export function buildAnalysisMessages({
    promptA = '',
    promptB = '',
    replyA = '',
    replyB = '',
    scenario = '',
    characterName = '',
} = {}) {
    const instructions = [
        'You are helping a prompt author compare two versions of a prompt.',
        'Answer in two short sections.',
        '1. "What changed": describe the differences between prompt A and prompt B in plain language, from the wording itself.',
        '2. "What the replies show": compare reply A and reply B and say what the differences suggest about the effect of the prompt change.',
        'Quote short fragments as evidence.',
        'If the prompts or the replies are effectively the same, say so plainly instead of inventing differences.',
    ].join(' ');
    const body = [
        characterName ? `Both prompts were tested with the character "${characterName}".` : '',
        scenario ? `The test message was:\n${scenario}` : '',
        `Prompt A:\n${String(promptA ?? '') || '(empty)'}`,
        `Prompt B:\n${String(promptB ?? '') || '(empty)'}`,
        `Reply to prompt A:\n${String(replyA ?? '') || '(no reply)'}`,
        `Reply to prompt B:\n${String(replyB ?? '') || '(no reply)'}`,
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: instructions },
        { role: 'user', content: body },
    ];
}

/**
 * Asks a model for the analysis. This is optional and costs tokens, so it
 * only ever runs from its own button.
 *
 * @returns {Promise<{profileId: string, text: string, error: string|null}>}
 */
export async function requestAnalysis(details, {
    profileId = '',
    hostRef = getContext,
    maxTokens = 800,
    signal = null,
} = {}) {
    return sendPrompt(profileId, buildAnalysisMessages(details), { hostRef, maxTokens, signal });
}
