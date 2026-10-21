/**
 * Bridge between the Character Expressions extension and the In-Chat Agents system.
 *
 * Neconyan divergence: this module lets expression classification run as a companion
 * agent instead of blocking the main generation pipeline with a synchronous classifier.
 *
 * The expressions agent is a bundled companion template (`tpl-expressions-agent`).
 * After each assistant reply the companion classifies the emotional tone and stores the
 * result in `message.extra.inChatAgentCompanionResults`. New persona messages with a
 * sprite set use the same agent connection in the background and save their own portrait.
 */

import { getContext, extension_settings } from '../../extensions.js';
import { system_message_types } from '../../../script.js';
import { normalizeAgentExpressionLabel, parseAgentExpressionAnswer, resolveExpressionsAgentProfile as resolveProfile } from './expressions-agent-utils.js';
import { DEFAULT_EXPRESSION_SPRITE_PROMPT, getExpressionSpriteBackground, TRANSPARENT_DEFAULT_EXPRESSION_SPRITE_PROMPT } from './sprite-prompts.js';

const EXPRESSIONS_AGENT_TEMPLATE_ID = 'tpl-expressions-agent';
const CHARACTER_CARD_PROMPT_LIMIT = 2400;
const CHARACTER_CARD_FIELD_LIMITS = {
    description: 1400,
    creatorNotes: 650,
    personality: 450,
    scenario: 450,
    charDepthPrompt: 350,
};
const EXPRESSION_SPRITE_FRAMING = {
    bust: 'bust',
    fullBody: 'full_body',
};
const DEFAULT_EXPRESSION_SPRITE_FRAMING = EXPRESSION_SPRITE_FRAMING.bust;
export const LEGACY_DEFAULT_EXPRESSION_SPRITE_PROMPT = [
    'Create one image in a matching character expression sprite set for {{characterName}}.',
    'Expression to show: {{expression}}.',
    'Use these character card details as the source of truth for the character\'s actual appearance:',
    '{{characterCard}}',
    '{{framingInstructions}}',
    'Preserve the same character identity, species, body, hair, eyes, clothing, accessories, colors, and style described in the card.',
    'Consistency rules: same front-facing angle, same crop, same scale, same head and body position, same outfit, same hairstyle, same accessories, plain white or transparent background.',
    'Only the facial expression should change. Keep pose, camera, composition, and silhouette stable across all generated expressions.',
    'Clean isolated character sprite, emotional face, production-ready expression sheet tile.',
].join('\n');
export { DEFAULT_EXPRESSION_SPRITE_PROMPT, TRANSPARENT_DEFAULT_EXPRESSION_SPRITE_PROMPT };

/**
 * Cached import handles for the companion subsystem. Populated lazily because the
 * in-chat-agents extension loads after expressions (loading_order 20 vs 6).
 * @type {{agentStore?: object, companionShared?: object, qigBridge?: object, personaRunner?: object}}
 */
const moduleCache = {
    agentStore: null,
    companionShared: null,
    qigBridge: null,
    personaRunner: null,
};

async function getPersonaExpressionRunner() {
    if (!moduleCache.personaRunner) {
        const [runner, companion] = await Promise.all([
            import('../in-chat-agents/agent-runner.js'),
            import('../in-chat-agents/companion/companion-runner.js'),
        ]);
        moduleCache.personaRunner = {
            requestPromptTransform: runner.requestPromptTransform,
            getAgentGenerationCancelRevision: runner.getAgentGenerationCancelRevision,
            buildCompanionPromptMessages: companion.buildCompanionPromptMessages,
            getAutomaticCompanionAgents: companion.getAutomaticCompanionAgents,
        };
    }
    return moduleCache.personaRunner;
}

/**
 * Lazily load the in-chat-agents store. Failure is non-fatal and returns null so the
 * expression extension degrades gracefully when the agent subsystem is disabled.
 * @returns {Promise<object|null>}
 */
async function getAgentStore() {
    if (moduleCache.agentStore) return moduleCache.agentStore;
    try {
        moduleCache.agentStore = await import('../in-chat-agents/agent-store.js');
        return moduleCache.agentStore;
    } catch (error) {
        console.debug('[Expressions Agent] agent-store not available:', error.message);
        return null;
    }
}

/**
 * Lazily load the companion shared constants module.
 * @returns {Promise<object|null>}
 */
async function getCompanionShared() {
    if (moduleCache.companionShared) return moduleCache.companionShared;
    try {
        moduleCache.companionShared = await import('../in-chat-agents/companion/companion-shared.js');
        return moduleCache.companionShared;
    } catch (error) {
        console.debug('[Expressions Agent] companion-shared not available:', error.message);
        return null;
    }
}

/**
 * Lazily load the expression sprite bridge. This avoids pulling in Quick Image Gen
 * until a sprite actually needs to be generated.
 * @returns {Promise<object|null>}
 */
async function getQigBridge() {
    if (moduleCache.qigBridge) return moduleCache.qigBridge;
    try {
        moduleCache.qigBridge = await import('./expression-sprite-bridge.js');
        return moduleCache.qigBridge;
    } catch (error) {
        console.debug('[Expressions Agent] expression-sprite-bridge not available:', error.message);
        return null;
    }
}

/**
 * Returns the last assistant-authored message in the current chat.
 * @param {object} context
 * @returns {object|null}
 */
function getLatestAssistantMessage(context) {
    if (!Array.isArray(context?.chat)) return null;
    for (let i = context.chat.length - 1; i >= 0; i--) {
        const mes = context.chat[i];
        if (!mes || mes.is_user || mes.is_system || mes.extra?.type === system_message_types.NARRATOR) {
            continue;
        }
        return mes;
    }
    return null;
}

function normalizePromptText(value) {
    return String(value || '')
        .replace(/\r/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function truncatePromptText(value, limit) {
    const text = normalizePromptText(value);
    if (!text || text.length <= limit) return text;
    return `${text.slice(0, limit).trim()}...`;
}

function normalizeLookupValue(value) {
    return String(value || '')
        .split(/[\\/]/)
        .pop()
        .replace(/\.[^/.]+$/, '')
        .trim()
        .toLowerCase();
}

function findCharacterIndex(context, characterName, characterAvatar) {
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    const avatarKey = normalizeLookupValue(characterAvatar);
    const nameKey = String(characterName || '').trim().toLowerCase();

    if (avatarKey) {
        const avatarIndex = characters.findIndex(character => normalizeLookupValue(character?.avatar) === avatarKey);
        if (avatarIndex !== -1) return avatarIndex;
    }

    if (nameKey) {
        const nameIndex = characters.findIndex(character => String(character?.name || '').trim().toLowerCase() === nameKey);
        if (nameIndex !== -1) return nameIndex;
    }

    const activeIndex = Number(context?.characterId);
    if (Number.isInteger(activeIndex) && characters[activeIndex]) return activeIndex;

    return -1;
}

function getCharacterCardFieldsForSprite(context, characterIndex, character = {}) {
    if (typeof context?.getCharacterCardFields === 'function' && characterIndex !== -1) {
        try {
            const fields = context.getCharacterCardFields({ chid: characterIndex });
            if (fields && typeof fields === 'object') return fields;
        } catch (error) {
            console.warn('[Expressions Agent] Character card lookup failed:', error);
        }
    }

    return {
        description: character.description,
        personality: character.personality,
        scenario: character.scenario,
        creatorNotes: character.data?.creator_notes || character.creatorcomment,
        charDepthPrompt: character.data?.extensions?.depth_prompt?.prompt,
    };
}

function buildCharacterCardPrompt(fields = {}) {
    const parts = [
        ['Description', fields.description, CHARACTER_CARD_FIELD_LIMITS.description],
        ['Creator notes', fields.creatorNotes, CHARACTER_CARD_FIELD_LIMITS.creatorNotes],
        ['Personality', fields.personality, CHARACTER_CARD_FIELD_LIMITS.personality],
        ['Scenario', fields.scenario, CHARACTER_CARD_FIELD_LIMITS.scenario],
        ['Depth note', fields.charDepthPrompt, CHARACTER_CARD_FIELD_LIMITS.charDepthPrompt],
    ]
        .map(([label, value, limit]) => {
            const text = truncatePromptText(value, limit);
            return text ? `${label}: ${text}` : '';
        })
        .filter(Boolean)
        .join('\n');

    return truncatePromptText(parts, CHARACTER_CARD_PROMPT_LIMIT);
}

function getExpressionSpriteFraming() {
    const framing = extension_settings?.expressions?.agentSpriteFraming;
    return Object.values(EXPRESSION_SPRITE_FRAMING).includes(framing)
        ? framing
        : DEFAULT_EXPRESSION_SPRITE_FRAMING;
}

function getExpressionSpritePromptTemplate() {
    const prompt = String(extension_settings?.expressions?.agentSpritePrompt || '').trim();
    return prompt || DEFAULT_EXPRESSION_SPRITE_PROMPT;
}

export function getExpressionSpritePromptContext(characterName, characterAvatar) {
    const context = getContext();
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    const characterIndex = findCharacterIndex(context, characterName, characterAvatar);
    const character = characterIndex !== -1 ? characters[characterIndex] : null;
    const fields = getCharacterCardFieldsForSprite(context, characterIndex, character || {});

    return {
        characterName: character?.name || characterName || context.name2 || 'character',
        characterCard: buildCharacterCardPrompt(fields),
        framing: getExpressionSpriteFraming(),
        background: getExpressionSpriteBackground(extension_settings?.expressions?.agentSpriteBackground),
        promptTemplate: getExpressionSpritePromptTemplate(),
    };
}

export function getPersonaExpressionSpritePromptContext(name, description) {
    return {
        characterName: name || 'Persona',
        characterCard: buildCharacterCardPrompt({ name, description }),
        framing: getExpressionSpriteFraming(),
        background: getExpressionSpriteBackground(extension_settings?.expressions?.agentSpriteBackground),
        promptTemplate: getExpressionSpritePromptTemplate(),
    };
}

/**
 * Find the enabled expressions agent among active in-chat agents.
 * @returns {Promise<object|null>}
 */
export async function getExpressionsAgent() {
    const agentStore = await getAgentStore();
    if (!agentStore) return null;

    const { getEnabledAgents } = agentStore;
    if (typeof getEnabledAgents !== 'function') return null;

    const enabledAgents = getEnabledAgents();
    if (!Array.isArray(enabledAgents)) return null;

    const companionShared = await getCompanionShared();
    const isExpressionsAgent = companionShared?.isExpressionsAgent
        ? companionShared.isExpressionsAgent.bind(companionShared)
        : (agent) => (agent?.sourceTemplateId || agent?.id) === EXPRESSIONS_AGENT_TEMPLATE_ID;

    return enabledAgents.find(isExpressionsAgent) ?? null;
}

export async function getExpressionsAgentStatus() {
    const store = await getAgentStore();
    const enabled = await getExpressionsAgent();
    const agent = enabled ?? store?.getAgents?.().find(item => (item.sourceTemplateId || item.id) === EXPRESSIONS_AGENT_TEMPLATE_ID);
    if (!agent) return { status: 'missing', agent: null };
    if (!enabled) return { status: 'disabled', agent };
    if (!store.isCompanionAgent(agent)) return { status: 'inline', agent };
    if (store.isAgentHidden(agent.id)) return { status: 'hidden', agent };
    if (store.getCompanionConfig(agent).trigger !== 'auto') return { status: 'manual', agent };
    return { status: 'ready', agent };
}

/**
 * Check whether the expressions agent is installed, enabled, and ready to use.
 * @returns {Promise<boolean>}
 */
export async function isExpressionsAgentAvailable() {
    return (await getExpressionsAgentStatus()).status === 'ready';
}

/**
 * Resolve the Connection Manager profile id that should be used by the Expressions Agent.
 *
 * When the user has enabled "Use Quick Image Gen LLM override profile" in the expression
 * settings, the agent shares that profile so classification and QIG's LLM tasks use the
 * same model/endpoint.
 *
 * @param {object} agent - The expressions agent.
 * @returns {string}
 */
export function resolveExpressionsAgentProfile(agent) {
    return resolveProfile(agent, extension_settings);
}

/**
 * Compatibility entrypoint. The effective profile is resolved for each request;
 * sharing never changes the independently saved agent profile.
 *
 * @returns {Promise<boolean>} True if an enabled agent was found.
 */
export async function syncExpressionsAgentProfile() {
    return Boolean(await getExpressionsAgent());
}

export async function getAgentExpressionState(context, allowedExpressions, target = null) {
    const ctx = context || getContext();
    const message = target?.message ?? getLatestAssistantMessage(ctx);
    const { status, agent } = await getExpressionsAgentStatus();
    if (!message || !agent || status === 'disabled' || status === 'inline') return { status: 'unavailable', label: null };
    const shared = await getCompanionShared();
    if (target && (ctx.chat[target.index] !== message || (message.swipe_id ?? 0) !== target.swipe || message.mes !== target.text)) {
        return { status: 'stale', label: null };
    }
    const result = shared?.getActiveCompanionResults(message)?.[agent.id];
    const { label, speaker } = result?.status === 'done' ? parseAgentExpressionAnswer(result.content, allowedExpressions) : { label: null, speaker: '' };
    return { agentId: agent.id, result, label, speaker, status: result?.status ?? (status === 'ready' ? 'pending' : 'unavailable') };
}

/**
 * Read the expression label the companion agent stored for the latest assistant reply.
 *
 * @param {object} [context] - Optional Neconyan context. Defaults to getContext().
 * @param {string[]} [allowedExpressions] - Optional list of valid expression labels.
 * @returns {Promise<string|null>} The classified expression label, or null if not ready.
 */
export async function getAgentExpressionLabel(context, allowedExpressions, target = null) {
    return (await getAgentExpressionState(context, allowedExpressions, target)).label;
}

/** Classify a new persona message using the Expressions Agent's connection and rules. */
export async function classifyPersonaExpression(target, allowedExpressions, description, isCurrent) {
    if (!allowedExpressions.length || !isCurrent()) return null;
    const { status, agent } = await getExpressionsAgentStatus();
    if (status !== 'ready') return null;
    const runner = await getPersonaExpressionRunner();
    const companion = (await getAgentStore()).getCompanionConfig(agent);
    const canRun = () => isCurrent() && runner.getAutomaticCompanionAgents(target.index).some(item => item.id === agent.id);
    if (!canRun()) return null;
    const cancelRevision = runner.getAgentGenerationCancelRevision();
    const labels = allowedExpressions.join(', ');
    // Scope macros before normal expansion: their global values belong to the chat character.
    // Keep saved/custom prompts intact, including older assistant-only template wording.
    const scopedAgent = {
        ...agent,
        prompt: [
            String(agent.prompt ?? '').replace(/{{\s*(?:availableExpressions|availableSprites)\s*}}/gi, () => labels),
            'Classification target for this request: the persona\'s user-authored message below. Apply the emotion rules above to this persona, even if they refer to an assistant or character.',
            `Return exactly one label from this persona's own expression set: ${labels}.`,
        ].join('\n\n'),
        companion: { ...companion, includeCharacterCard: false, includePersona: false, includeHistory: false },
    };
    const messages = await runner.buildCompanionPromptMessages(scopedAgent, target.index, 'normal', {
        extraContextSections: [{
            title: 'Persona to classify',
            content: [`Name: ${target.name}`, description && `Description: ${description}`, `Message: ${target.text}`].filter(Boolean).join('\n'),
        }],
    });
    if (!canRun()) return null;
    const response = await runner.requestPromptTransform(scopedAgent, messages, companion.maxTokens, {
        cancelRevision, isCurrent: canRun,
    });
    return canRun() ? normalizeAgentExpressionLabel(response?.output, allowedExpressions) : null;
}

/**
 * Trigger Quick Image Gen to create a sprite for the given expression. This is best-effort:
 * failures are logged but never block the expression update. The caller is responsible for
 * saving the returned URL into the character's sprite folder via the existing upload path.
 *
 * @param {string} expression - The expression label to generate a sprite for.
 * @param {string} [characterName] - Optional character name to include in the image prompt.
 * @param {string} [characterAvatar] - Optional avatar filename used to resolve the character card.
 * @returns {Promise<string|null>} A URL/data-URI for the generated image, or null on failure.
 */
export async function maybeGenerateExpressionSprite(expression, characterName = null, characterAvatar = null, promptContext = getExpressionSpritePromptContext(characterName, characterAvatar)) {
    if (!expression) return null;

    const qigBridge = await getQigBridge();
    if (!qigBridge?.generateExpressionSprite) {
        console.debug('[Expressions Agent] Quick Image Gen sprite generator is not available');
        return null;
    }

    try {
        console.debug(`[Expressions Agent] Requesting sprite for ${expression} from QIG`);
        const imageUrl = await qigBridge.generateExpressionSprite(expression, promptContext);
        return imageUrl || null;
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        console.error('[Expressions Agent] Failed to generate sprite:', error);
        return null;
    }
}

/**
 * Trigger Quick Image Gen to create a sprite sheet for multiple expressions.
 * @param {string[]} expressions - Expression labels to generate in sheet order.
 * @param {string} [characterName] - Optional character name to include in the image prompt.
 * @param {string} [characterAvatar] - Optional avatar filename used to resolve the character card.
 * @returns {Promise<{imageUrl: string, grid: {columns: number, rows: number}}|null>} Generated sheet image and grid metadata.
 */
export async function maybeGenerateExpressionSpriteSheet(expressions, characterName = null, characterAvatar = null, promptContext = getExpressionSpritePromptContext(characterName, characterAvatar)) {
    const labels = Array.isArray(expressions) ? expressions.filter(Boolean) : [];
    if (labels.length === 0) return null;

    const qigBridge = await getQigBridge();
    if (!qigBridge?.generateExpressionSpriteSheet) {
        console.debug('[Expressions Agent] Quick Image Gen sprite sheet generator is not available');
        return null;
    }

    try {
        console.debug(`[Expressions Agent] Requesting sprite sheet for ${labels.length} expressions from QIG`);
        const sheet = await qigBridge.generateExpressionSpriteSheet(labels, promptContext);
        return sheet?.imageUrl ? sheet : null;
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        console.error('[Expressions Agent] Failed to generate sprite sheet:', error);
        return null;
    }
}

/**
 * Stop the active Quick Image Gen sprite request, if one is running.
 * @returns {Promise<boolean>} True when a running request was asked to stop.
 */
export async function stopExpressionSpriteGeneration() {
    const qigBridge = await getQigBridge();
    if (qigBridge?.stopExpressionSpriteGeneration) {
        return !!qigBridge.stopExpressionSpriteGeneration();
    }
    return false;
}

/**
 * Remove the inline sprite-generation spinner. Safe to call on chat changes.
 */
export async function cleanupExpressionAgentSpinner() {
    const qigBridge = await getQigBridge();
    if (qigBridge?.cleanupExpressionSpriteSpinner) {
        qigBridge.cleanupExpressionSpriteSpinner();
    }
}
