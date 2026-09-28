import { Fuse } from '../../../lib.js';
import { MacrosParser } from '../../macros.js';

import { characters, eventSource, event_types, generateQuietPrompt, generateRaw, getRequestHeaders, online_status, saveSettingsDebounced, substituteParams, substituteParamsExtended, system_message_types, this_chid, captureExpressionTarget, isExpressionTargetCurrent, recordMessageExpression, getSavedMessageExpression, getMessageExpressionAvatar, getChatGeneration, getCurrentChatId } from '../../../script.js';
import { dragElement, isMobile } from '../../RossAscends-mods.js';
import { getContext, extension_settings, ModuleWorkerWrapper, renderExtensionTemplateAsync } from '../../extensions.js';
import { loadMovingUIState, performFuzzySearch, power_user } from '../../power-user.js';
import { onlyUnique, debounce, getCharaFilename, trimToEndSentence, trimToStartSentence, waitUntilCondition, findChar, isFalseBoolean, includesIgnoreCaseAndAccents } from '../../utils.js';
import { hideMutedSprites, selected_group } from '../../group-chats.js';
import { isJsonSchemaSupported } from '../../textgen-settings.js';
import { debounce_timeout } from '../../constants.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue, enumTypes } from '../../slash-commands/SlashCommandEnumValue.js';
import { commonEnumProviders } from '../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { slashCommandReturnHelper } from '../../slash-commands/SlashCommandReturnHelper.js';
import { generateWebLlmChatPrompt, isWebLlmSupported } from '../shared.js';
import { Popup, POPUP_RESULT } from '../../popup.js';
import { t } from '../../i18n.js';
import { removeReasoningFromString } from '../../reasoning.js';
import {
    DEFAULT_EXPRESSION_SPRITE_PROMPT,
    LEGACY_DEFAULT_EXPRESSION_SPRITE_PROMPT,
    getAgentExpressionLabel,
    getAgentExpressionState,
    getExpressionsAgentStatus,
    maybeGenerateExpressionSprite,
    maybeGenerateExpressionSpriteSheet,
    stopExpressionSpriteGeneration,
    cleanupExpressionAgentSpinner,
} from './expressions-agent.js';
export { MODULE_NAME };

/**
* @typedef {object} Expression Expression definition with label and file path
* @property {string} label The label of the expression
* @property {ExpressionImage[]} files One or more images to represent this expression
*/

/**
 * @typedef {object} ExpressionImage An expression image
 * @property {string} expression - The expression
 * @property {boolean} [isCustom=false] - If the expression is added by user
 * @property {string} fileName - The filename with extension
 * @property {string} title - The title for the image
 * @property {string} imageSrc - The image source / full path
 * @property {'success' | 'additional' | 'failure'} type - The type of the image
 * @property {boolean} [canGenerate=false] - Whether the tile can generate a missing sprite
 * @property {boolean} [canRegenerate=false] - Whether the tile can replace an existing sprite with a generated one
 */

const MODULE_NAME = 'expressions';
const UPDATE_INTERVAL = 2000;
const DEFAULT_FALLBACK_EXPRESSION = 'joy';
const DEFAULT_LLM_PROMPT = 'Ignore previous instructions. Classify the emotion of the last message. Output just one word, e.g. "joy" or "anger". Choose only one of the following labels: {{labels}}';
const DEFAULT_EXPRESSIONS = [
    'admiration',
    'amusement',
    'anger',
    'annoyance',
    'approval',
    'caring',
    'confusion',
    'curiosity',
    'desire',
    'disappointment',
    'disapproval',
    'disgust',
    'embarrassment',
    'excitement',
    'fear',
    'gratitude',
    'grief',
    'joy',
    'love',
    'nervousness',
    'optimism',
    'pride',
    'realization',
    'relief',
    'remorse',
    'sadness',
    'surprise',
    'neutral',
];

const OPTION_NO_FALLBACK = '#none';
const OPTION_EMOJI_FALLBACK = '#emoji';
const RESET_SPRITE_LABEL = '#reset';


/** @enum {number} */
const EXPRESSION_API = {
    local: 0,
    llm: 2,
    webllm: 3,
    agent: 4,
    none: 99,
};

/** @enum {string} */
const PROMPT_TYPE = {
    raw: 'raw',
    full: 'full',
};

/** @enum {string} */
const EXPRESSION_SPRITE_FRAMING = {
    bust: 'bust',
    fullBody: 'full_body',
};

const DEFAULT_EXPRESSION_SPRITE_FRAMING = EXPRESSION_SPRITE_FRAMING.bust;

/** @enum {string} */
const EXPRESSION_SPRITE_GENERATION_MODE = {
    individual: 'individual',
    sheet: 'sheet',
};

const DEFAULT_EXPRESSION_SPRITE_GENERATION_MODE = EXPRESSION_SPRITE_GENERATION_MODE.individual;
const DEFAULT_EXPRESSION_SPRITE_REMOVE_BACKGROUND = false;
const SHEET_BACKGROUND_RGB_THRESHOLD = 238;
const SHEET_BACKGROUND_CHANNEL_SPREAD = 28;
const SHEET_BACKGROUND_NEUTRAL_SPREAD = 48;
const SHEET_BACKGROUND_BUCKET_SIZE = 16;
const SHEET_BACKGROUND_PALETTE_LIMIT = 5;
const SHEET_BACKGROUND_COLOR_DISTANCE = 58;
const SHEET_BACKGROUND_MIN_NEUTRAL_LIGHTNESS = 36;
const SHEET_TILE_SOURCE_INSET_RATIO = 0.045;
const SPRITE_FOREGROUND_ALPHA_THRESHOLD = 24;
/**
 * Minimum fraction of a tile's smaller dimension that foreground content must span
 * before content-aware centering is applied. Prevents centering noise/artifacts.
 */
const SPRITE_CENTER_MIN_CONTENT_RATIO = 0.08;

let expressionsList = null;
let processedExpressions = new WeakMap();

function getExpressionClassificationSnapshot(message, swipe = message.swipe_id ?? 0) {
    const extra = message.swipe_info?.[swipe]?.extra;
    const results = extra && Object.hasOwn(extra, 'inChatAgentCompanionResults')
        ? extra.inChatAgentCompanionResults
        : message.extra?.inChatAgentCompanionResults;
    return Object.fromEntries(Object.entries(results ?? {}).map(([id, result]) => [id, JSON.stringify([result?.status, result?.content])]));
}

function rememberExpressionMessage(message) {
    if (!message) return;
    const swipes = processedExpressions.get(message) ?? new Map();
    swipes.set(message.swipe_id ?? 0, { text: message.mes, classifications: getExpressionClassificationSnapshot(message) });
    processedExpressions.set(message, swipes);
}

function seedExpressionHistory() {
    processedExpressions = new WeakMap();
    for (const message of getContext().chat) {
        processedExpressions.set(message, new Map((message.swipes ?? [message.mes]).map((text, swipe) => [swipe, {
            text, classifications: getExpressionClassificationSnapshot(message, swipe),
        }])));
        rememberExpressionMessage(message);
    }
}

function needsExpression(message) {
    return getMessageExpressionAvatar(message) && message.mes && message.mes !== '...'
        && processedExpressions.get(message)?.get(message.swipe_id ?? 0)?.text !== message.mes;
}

async function onAgentExpressionUpdated({ messageIndex, agentId }, update) {
    if (extension_settings.expressions.api !== EXPRESSION_API.agent) return;
    const context = getContext();
    const message = context.chat[messageIndex];
    if (!message) return;
    const generation = getChatGeneration();
    const swipe = message.swipe_id ?? 0;
    const state = await getAgentExpressionState(context, await getExpressionsList({ filterAvailable: false }), {
        message, index: messageIndex, swipe, text: message.mes,
    });
    if (generation !== getChatGeneration() || getContext().chat[messageIndex] !== message || (message.swipe_id ?? 0) !== swipe) return;
    if (agentId && state.agentId !== agentId) return;
    if (state.status === 'pending' || state.status === 'stale') return;
    const previous = processedExpressions.get(message)?.get(swipe);
    if (previous?.classifications?.[state.agentId] === JSON.stringify([state.result?.status, state.result?.content])) return;
    processedExpressions.get(message)?.delete(swipe);
    await update();
}
/** @type {{[characterKey: string]: Expression[]}} */
let spriteCache = {};
let spriteListLoadRevision = 0;
let inApiCall = false;
let inSpriteGeneration = false;
let expressionGenerationCancelRequested = false;

/** @type {{[characterName: string]: string}} */
export let lastExpression = {};

/**
 * Returns a placeholder image object for a given expression
 * @param {string} expression - The expression label
 * @param {boolean} [isCustom=false] - Whether the expression is custom
 * @returns {ExpressionImage} The placeholder image object
 */
function getPlaceholderImage(expression, isCustom = false) {
    return {
        expression: expression,
        isCustom: isCustom,
        canGenerate: true,
        title: 'No Image',
        type: 'failure',
        fileName: 'No-Image-Placeholder.png',
        imageSrc: '/img/No-Image-Placeholder.png',
    };
}

function isVisualNovelMode() {
    return Boolean(!isMobile() && power_user.waifuMode && getContext().groupId);
}

async function forceUpdateVisualNovelMode() {
    if (isVisualNovelMode()) {
        await updateVisualNovelMode();
    }
}

const updateVisualNovelModeDebounced = debounce(forceUpdateVisualNovelMode, debounce_timeout.quick);

async function updateVisualNovelMode() {
    const vnContainer = $('#visual-novel-wrapper');

    await visualNovelRemoveInactive(vnContainer);

    const setSpritePromises = await visualNovelSetCharacterSprites(vnContainer);

    // calculate layer indices based on recent messages
    await visualNovelUpdateLayers(vnContainer);

    await Promise.allSettled(setSpritePromises);

    // update again based on new sprites
    if (setSpritePromises.length > 0) {
        await visualNovelUpdateLayers(vnContainer);
    }
}

async function visualNovelRemoveInactive(container) {
    const context = getContext();
    const group = context.groups.find(x => x.id == context.groupId);
    const removeInactiveCharactersPromises = [];

    // remove inactive characters after 1 second
    container.find('.expression-holder').each((_, current) => {
        const promise = new Promise(resolve => {
            const element = $(current);
            const avatar = element.data('avatar');

            if (!group.members.includes(avatar) || group.disabled_members.includes(avatar)) {
                element.fadeOut(250, () => {
                    element.remove();
                    resolve();
                });
            } else {
                resolve();
            }
        });

        removeInactiveCharactersPromises.push(promise);
    });

    await Promise.allSettled(removeInactiveCharactersPromises);
}

/**
 * Sets the character sprites for visual novel mode based on the provided container, name, and expression.
 *
 * @param {JQuery<HTMLElement>} vnContainer - The container element where the sprites will be set
 * @param {string} spriteFolderName - The name of the sprite folder
 * @param {string} expression - The expression to set for the characters
 * @returns {Promise<Array>} - An array of promises that resolve when the sprites are set
 */
async function visualNovelSetCharacterSprites(vnContainer) {
    const context = getContext();
    const group = context.groups.find(x => x.id == context.groupId);
    const generation = getChatGeneration();
    const setSpritePromises = [];
    for (const avatar of group?.members ?? []) {
        // skip disabled characters
        const isDisabled = group.disabled_members.includes(avatar);
        if (isDisabled && hideMutedSprites) {
            continue;
        }

        const character = context.characters.find(x => x.avatar == avatar);
        if (!character) {
            continue;
        }

        let holder = vnContainer.find('.expression-holder').filter((_, element) => element.dataset.avatar === avatar);
        if (!holder.length) {
            holder = $('#expression-holder').clone();
            holder.attr({ id: `expression-${avatar}`, 'data-avatar': avatar });
            holder.find('img').removeAttr('id').attr('src', '');
            holder.find('.drag-grabber').attr('id', `expression-${avatar}header`);
            vnContainer.append(holder);
            dragElement(holder);
        }
        const message = context.chat.slice().reverse().find(item => getMessageExpressionAvatar(item) === avatar);
        const saved = getSavedMessageExpression(message);
        const isCurrent = () => getChatGeneration() === generation && getSavedMessageExpression(message)?.src === saved?.src;
        setSpritePromises.push(setImage(holder.find('img'), saved?.src ?? null, { isCurrent }).then(src => {
            if (src !== undefined) holder.toggleClass('hidden', !src);
        }));
    }

    return setSpritePromises;
}

export async function visualNovelUpdateLayers(container) {
    const context = getContext();
    const group = context.groups.find(x => x.id == context.groupId);
    const recentMessages = context.chat.map(x => x.original_avatar).filter(x => x).reverse().filter(onlyUnique);
    const filteredMembers = group.members.filter(x => !group.disabled_members.includes(x));
    const layerIndices = filteredMembers.slice().sort((a, b) => {
        const aRecentIndex = recentMessages.indexOf(a);
        const bRecentIndex = recentMessages.indexOf(b);
        const aFilteredIndex = filteredMembers.indexOf(a);
        const bFilteredIndex = filteredMembers.indexOf(b);

        if (aRecentIndex !== -1 && bRecentIndex !== -1) {
            return bRecentIndex - aRecentIndex;
        } else if (aRecentIndex !== -1) {
            return 1;
        } else if (bRecentIndex !== -1) {
            return -1;
        } else {
            return aFilteredIndex - bFilteredIndex;
        }
    });

    const setLayerIndicesPromises = [];

    const sortFunction = (a, b) => {
        const avatarA = $(a).data('avatar');
        const avatarB = $(b).data('avatar');
        const indexA = filteredMembers.indexOf(avatarA);
        const indexB = filteredMembers.indexOf(avatarB);
        return indexA - indexB;
    };

    const containerWidth = container.width();
    const pivotalPoint = containerWidth * 0.5;

    let images = Array.from($('#visual-novel-wrapper .expression-holder')).sort(sortFunction);
    let imagesWidth = [];

    for (const image of images) {
        if (image instanceof HTMLImageElement && !image.complete) {
            await new Promise(resolve => image.addEventListener('load', resolve, { once: true }));
        }
    }

    images.forEach(image => {
        imagesWidth.push($(image).width());
    });

    let totalWidth = imagesWidth.reduce((a, b) => a + b, 0);
    let currentPosition = pivotalPoint - (totalWidth / 2);

    if (totalWidth > containerWidth) {
        let totalOverlap = totalWidth - containerWidth;
        let totalWidthWithoutWidest = imagesWidth.reduce((a, b) => a + b, 0) - Math.max(...imagesWidth);
        let overlaps = imagesWidth.map(width => (width / totalWidthWithoutWidest) * totalOverlap);
        imagesWidth = imagesWidth.map((width, index) => width - overlaps[index]);
        currentPosition = 0; // Reset the initial position to 0
    }

    images.forEach((current, index) => {
        const element = $(current);
        const elementID = element.attr('id');

        // skip repositioning of dragged elements
        if (element.data('dragged')
            || (power_user.movingUIState[elementID]
                && (typeof power_user.movingUIState[elementID] === 'object')
                && Object.keys(power_user.movingUIState[elementID]).length > 0)) {
            loadMovingUIState();
            //currentPosition += imagesWidth[index];
            return;
        }

        const avatar = element.data('avatar');
        const layerIndex = layerIndices.indexOf(avatar);
        element.css('z-index', layerIndex);
        element.show();

        const promise = new Promise(resolve => {
            if (power_user.reduced_motion) {
                element.css('left', currentPosition + 'px');
                requestAnimationFrame(() => resolve());
            } else {
                element.animate({ left: currentPosition + 'px' }, 500, () => {
                    resolve();
                });
            }
        });

        currentPosition += imagesWidth[index];

        setLayerIndicesPromises.push(promise);
    });

    await Promise.allSettled(setLayerIndicesPromises);
}

/**
 * Sets the expression for the given character image.
 * @param {JQuery<HTMLElement>} img - The image element to set the image on
 * @param {string} path - The path to the image
 * @returns {Promise<void>} - A promise that resolves when the image is set
 */
async function setImage(img, path, { isCurrent = () => true, fallback = null, force = false } = {}) {
    if (!img.length || !isCurrent() || (!force && img.hasClass('expression-animating'))) return undefined;
    // Load before changing the visible image so errors and fallbacks have one result.
    const load = async src => {
        if (!src) return null;
        const image = new Image();
        image.src = src;
        try {
            await image.decode();
            return src;
        } catch {
            return null;
        }
    };
    const src = await load(path) ?? await load(fallback);
    if (!isCurrent() || !img[0].isConnected) return undefined;
    const changed = img.attr('src') !== (src ?? '');
    img.stop(true, true).off('error').attr('src', src ?? '');
    img.toggleClass('default', !!src?.startsWith('/img/default-expressions/'));
    if (changed && src && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        img.addClass('expression-animating').css('opacity', 0);
        await img.animate({ opacity: 1 }, 200).promise();
        img.removeClass('expression-animating');
    }
    return isCurrent() ? src : undefined;
}

async function restoreExpressionHistory() {
    if (extension_settings.disabledExtensions?.includes(MODULE_NAME)) return;
    if (isVisualNovelMode()) return updateVisualNovelMode();
    const message = getLastCharacterMessage();
    const saved = getSavedMessageExpression(message);
    const generation = getChatGeneration();
    await setImage($('#expression-image'), saved?.src ?? null, {
        force: true,
        isCurrent: () => getChatGeneration() === generation && getLastCharacterMessage() === message
            && getSavedMessageExpression(message)?.src === saved?.src,
    });
}

async function moduleWorker({ newChat = false } = {}) {
    const context = getContext();
    if (extension_settings.disabledExtensions?.includes(MODULE_NAME)) return;

    // non-characters not supported
    if (!context.groupId && context.characterId === undefined) {
        removeExpression();
        return;
    }

    const vnMode = isVisualNovelMode();
    const vnWrapperVisible = $('#visual-novel-wrapper').is(':visible');

    if (vnMode) {
        $('#expression-wrapper').hide();
        $('#visual-novel-wrapper').show();
    } else {
        $('#expression-wrapper').show();
        $('#visual-novel-wrapper').hide();
    }

    const vnStateChanged = vnMode !== vnWrapperVisible;

    if (vnStateChanged) {
        $('#visual-novel-wrapper').empty();
        $('#expression-holder').css({ top: '', left: '', right: '', bottom: '', height: '', width: '', margin: '' });
    }

    // Persist only completed replies, rather than saving every streaming fragment.
    if (context.streamingProcessor && !context.streamingProcessor.isFinished) return;
    // ponytail: one linear scan per poll; use an event queue if very large chats need it.
    const usingAgent = extension_settings.expressions.api === EXPRESSION_API.agent;
    let currentLastMessage = context.chat.find(needsExpression) ?? getLastCharacterMessage();
    let target = null;
    let agentState = null;
    if (usingAgent) {
        const labels = await getExpressionsList({ filterAvailable: false });
        for (const message of context.chat) {
            if (!needsExpression(message)) continue;
            const candidate = captureExpressionTarget(message);
            const state = await getAgentExpressionState(context, labels, candidate);
            if (!isExpressionTargetCurrent(candidate)) return;
            if (state.status === 'pending') continue;
            if (!state.label) {
                rememberExpressionMessage(message);
                continue;
            }
            currentLastMessage = message;
            target = candidate;
            agentState = state;
            break;
        }
    } else {
        target = needsExpression(currentLastMessage) ? captureExpressionTarget(currentLastMessage) : null;
    }
    let spriteFolderName = getSpriteFolderName(currentLastMessage, currentLastMessage.name);

    // character has no expressions or it is not loaded
    if (Object.keys(spriteCache).length === 0) {
        await validateImages(spriteFolderName);
    }

    const offlineMode = $('.expression_settings .offline_mode');
    if (extension_settings.expressions.api === EXPRESSION_API.none) {
        $('#open_chat_expressions').show();
        $('#no_chat_expressions').hide();
        offlineMode.css('display', 'block');
        if (target && isExpressionTargetCurrent(target)) {
            const previous = context.chat.slice(0, target.index).reverse()
                .find(message => getSavedMessageExpression(message)?.avatar === target.avatar);
            const saved = getSavedMessageExpression(previous);
            if (saved) await recordMessageExpression(target, saved.src);
            rememberExpressionMessage(currentLastMessage);
        }
        return;
    } else {
        // force reload expressions list on connect to API
        if (offlineMode.is(':visible')) {
            expressionsList = null;
            spriteCache = {};
            expressionsList = await getExpressionsList();
            await validateImages(spriteFolderName, true);
            await forceUpdateVisualNovelMode();
        }

        if (context.groupId && !Array.isArray(spriteCache[spriteFolderName])) {
            await validateImages(spriteFolderName, true);
            await forceUpdateVisualNovelMode();
        }

        offlineMode.css('display', 'none');
    }

    if (context.groupId && vnMode && newChat) {
        await forceUpdateVisualNovelMode();
    }

    // Don't bother classifying if current char has no sprites and no default expressions are enabled
    if ((!Array.isArray(spriteCache[spriteFolderName]) || spriteCache[spriteFolderName].length === 0)
        && !extension_settings.expressions.showDefault && !(usingAgent && extension_settings.expressions.agentAutoGenerateSprites)) {
        if (target && isExpressionTargetCurrent(target)) rememberExpressionMessage(currentLastMessage);
        return;
    }

    if (!target || !isExpressionTargetCurrent(target)) {
        return;
    }

    // API is busy (only relevant for synchronous classifiers, not the agent companion)
    if (inApiCall && extension_settings.expressions.api !== EXPRESSION_API.agent) {
        console.debug('Classification API is busy');
        return;
    }

    let shouldUpdateLastMessage = false;

    try {
        if (!usingAgent) inApiCall = true;
        let expression = usingAgent ? agentState.label : await getExpressionLabel(currentLastMessage.mes, extension_settings.expressions.api, { target });
        if (!isExpressionTargetCurrent(target)) return;

        // If we're not already overriding the folder name, account for group chats.
        if (spriteFolderName === currentLastMessage.name && !context.groupId) {
            spriteFolderName = context.name2;
        }

        const force = !!context.groupId;

        // Neconyan divergence: the agent classifier is asynchronous. If it has not
        // produced a result yet, leave this message unprocessed
        // so the next poll retries instead of flickering to the fallback expression.
        if (usingAgent && !expression) {
            shouldUpdateLastMessage = false;
            return;
        }

        const needsSprite = usingAgent && extension_settings.expressions.agentAutoGenerateSprites
            && !spriteCache[spriteFolderName]?.some(item => item.label === expression);
        // Leave the result unprocessed while another sprite is being generated; the next poll can retry it.
        if (needsSprite && inSpriteGeneration) return;
        shouldUpdateLastMessage = await sendExpressionCall(spriteFolderName, expression, { force, vnMode, target });

        // Neconyan divergence: optionally generate missing sprites via Quick Image Gen.
        // This runs after the expression is displayed so it never blocks the UI update.
        if (needsSprite && !inSpriteGeneration) {
            setExpressionGenerationBusy(true);
            const generationTarget = {
                characterName: currentLastMessage.name,
                characterAvatar: target.avatar,
                uploadName: target.avatar || currentLastMessage.name,
            };
            generateAndUploadExpressionSprite(expression, spriteFolderName, { showToast: false, generationTarget }).then(async generated => {
                throwIfExpressionGenerationStopped();
                if (generated && isExpressionTargetCurrent(target)) {
                    await sendExpressionCall(spriteFolderName, expression, { force: true, vnMode, target });
                }
            }).catch((error) => {
                if (isExpressionGenerationAbortError(error)) return;
                console.error('[Expressions Agent] Auto sprite generation failed:', error);
            }).finally(() => {
                setExpressionGenerationBusy(false);
            });
        }
    } catch (error) {
        console.log(error);
    } finally {
        inApiCall = false;
        if (shouldUpdateLastMessage && isExpressionTargetCurrent(target)) {
            rememberExpressionMessage(currentLastMessage);
        }
    }
}

function getSpriteFolderName(characterMessage = null, characterName = null) {
    const context = getContext();
    let spriteFolderName = characterName ?? context.name2;
    const message = characterMessage ?? getLastCharacterMessage();
    const avatarFileName = getFolderNameByMessage(message);
    const expressionOverride = extension_settings.expressionOverrides.find(e => e.name == avatarFileName);

    if (expressionOverride && expressionOverride.path) {
        spriteFolderName = expressionOverride.path;
    }

    return spriteFolderName;
}

function getFolderNameByMessage(message) {
    const context = getContext();
    let avatarPath = '';

    if (context.groupId) {
        avatarPath = message.original_avatar || context.characters.find(x => message.force_avatar && message.force_avatar.includes(encodeURIComponent(x.avatar)))?.avatar;
    } else if (context.characterId !== undefined) {
        avatarPath = getCharaFilename();
    }

    if (!avatarPath) {
        return '';
    }

    const folderName = avatarPath.replace(/\.[^/.]+$/, '');
    return folderName;
}

/**
 * Update the expression for the given character.
 *
 * @param {string} spriteFolderName The character name, optionally with a sprite folder override, e.g. "folder/expression".
 * @param {string} expression The expression label, e.g. "amusement", "joy", etc.
 * @param {Object} [options] Additional options
 * @param {boolean} [options.force=false] If true, the expression will be sent even if it is the same as the current expression.
 * @param {boolean} [options.vnMode=null] If true, the expression will be sent in Visual Novel mode. If null, it will be determined by the current chat mode.
 * @param {string?} [options.overrideSpriteFile=null] - Set if a specific sprite file should be used. Must be sprite file name.
 */
export async function sendExpressionCall(spriteFolderName, expression, { force = false, vnMode = null, overrideSpriteFile = null, target = captureExpressionTarget(getLastCharacterMessage()) } = {}) {
    const generation = getChatGeneration();
    const chatId = getCurrentChatId();
    const isCurrent = () => !extension_settings.disabledExtensions?.includes(MODULE_NAME)
        && (target ? isExpressionTargetCurrent(target) : getChatGeneration() === generation && getCurrentChatId() === chatId);
    if (!isCurrent()) return false;
    if (vnMode === null) {
        vnMode = isVisualNovelMode();
    }

    if (vnMode) {
        await updateVisualNovelMode();
    }
    if (!isCurrent()) return false;
    const src = await setExpression(spriteFolderName, expression, { force, overrideSpriteFile, vnMode, target, isCurrent });
    if (src === undefined || !isCurrent()) return false;
    lastExpression[spriteFolderName.split('/')[0]] = expression;
    if (target) {
        await recordMessageExpression(target, src);
        if (isCurrent()) rememberExpressionMessage(target.message);
    }
    return true;
}

/**
 * Slash command callback for /setspritefolder
 * @param {object} param Command parameters
 * @param {string} param.name Character name override
 * @param {string} folder Folder path, can be full or partial with leading slash
 * @returns {Promise<string>} Empty string
 */
async function setSpriteFolderCommand({ name }, folder) {
    if (!folder) {
        console.log('Clearing sprite set');
        folder = '';
    }

    if (folder.startsWith('/') || folder.startsWith('\\')) {
        const currentLastMessage = getLastCharacterMessage();
        if (currentLastMessage.name === null && !name) {
            toastr.error('At least one character message is required to set a sprites subfolder.', 'Provide the name with "name=" argument.');
            return '';
        }
        folder = folder.slice(1);
        folder = `${name || currentLastMessage.name}/${folder}`;
    }

    $('#expression_override').val(folder.trim());
    onClickExpressionOverrideButton();

    // No need to resend the expression, the folder override will automatically update the currently displayed one.
    return '';
}

async function classifyCallback(/** @type {{api: string?, filter: string?, prompt: string?}} */ { api = null, filter = null, prompt = null }, text) {
    if (!text) {
        toastr.error('No text provided');
        return '';
    }
    if (api && !Object.keys(EXPRESSION_API).includes(api)) {
        toastr.error('Invalid API provided');
        return '';
    }

    const expressionApi = EXPRESSION_API[api] || extension_settings.expressions.api;
    const filterAvailable = !isFalseBoolean(filter);

    if (expressionApi === EXPRESSION_API.none) {
        toastr.warning('No classifier API selected');
        return '';
    }

    const label = await getExpressionLabel(text, expressionApi, { filterAvailable: filterAvailable, customPrompt: prompt });
    console.debug(`Classification result for "${text}": ${label}`);
    return label;
}

/** @type {(args: {type: 'expression' | 'sprite'}, searchTerm: string) => Promise<string>} */
async function setSpriteSlashCommand({ type }, searchTerm) {
    type ??= 'expression';
    searchTerm = searchTerm.trim().toLowerCase();
    if (!searchTerm) {
        toastr.error(t`No expression or sprite name provided`, t`Set Sprite`);
        return '';
    }

    const currentLastMessage = getLastCharacterMessage();
    const target = captureExpressionTarget(currentLastMessage);
    rememberExpressionMessage(currentLastMessage);
    const spriteFolderName = getSpriteFolderName(currentLastMessage, currentLastMessage?.name);

    let label = searchTerm;

    /** @type {string?} */
    let spriteFile = null;

    await validateImages(spriteFolderName);

    // Handle reset as a special term and just reset the sprite via expression call
    if (searchTerm === RESET_SPRITE_LABEL) {
        await sendExpressionCall(spriteFolderName, label, { force: true, target });
        return lastExpression[spriteFolderName] ?? '';
    }

    switch (type) {
        case 'expression': {
            // Fuzzy search for expression
            const existingExpressions = getCachedExpressions().map(x => ({ label: x }));
            const results = performFuzzySearch('expression-expressions', existingExpressions, [
                { name: 'label', weight: 1 },
            ], searchTerm);
            const matchedExpression = results[0]?.item;
            if (!matchedExpression) {
                toastr.warning(t`No expression found for search term ${searchTerm}`, t`Set Sprite`);
                return '';
            }

            label = matchedExpression.label;
            break;
        }
        case 'sprite': {
            // Fuzzy search for sprite file
            const sprites = spriteCache[spriteFolderName].map(x => x.files).flat();
            const results = performFuzzySearch('expression-expressions', sprites, [
                { name: 'title', weight: 1 },
                { name: 'fileName', weight: 1 },
            ], searchTerm);
            const matchedSprite = results[0]?.item;
            if (!matchedSprite) {
                toastr.warning(t`No sprite file found for search term ${searchTerm}`, t`Set Sprite`);
                return '';
            }

            label = matchedSprite.expression;
            spriteFile = matchedSprite.fileName;
            break;
        }
        default: throw Error('Invalid sprite set type: ' + type);
    }

    await sendExpressionCall(spriteFolderName, label, { force: true, overrideSpriteFile: spriteFile, target });

    return label;
}

/**
 * @param {string} expressionName - Label of the expression to set as fallback
 */
function setFallBackExpressionSlashCommand(args, expressionName) {
    expressionName = expressionName.trim().toLowerCase();

    if (!expressionName) return extension_settings?.expressions?.fallback_expression || '';

    const select = /** @type {HTMLSelectElement} */(document.getElementById('expression_fallback'));
    const fallbackExpressions = Array
        .from(select?.options || [])
        .map(option => option.value)
        .filter(expression => expression?.length > 0);

    const expressionMatch = fallbackExpressions.find(expression => includesIgnoreCaseAndAccents(expression, expressionName));

    if (!expressionMatch) {
        toastr.warning(t`No expression found for search term ${expressionName}`, t`Set Fallback Expression`);
        return '';
    }

    $(select).val(expressionMatch).trigger('change');

    return expressionMatch;
}

/**
 * Returns the sprite folder name (including override) for a character.
 * @param {object} char Character object
 * @param {string} char.avatar Avatar filename with extension
 * @returns {string} Sprite folder name
 * @throws {Error} If character not found or avatar not set
 */
function spriteFolderNameFromCharacter(char) {
    const avatarFileName = char.avatar.replace(/\.[^/.]+$/, '');
    const expressionOverride = extension_settings.expressionOverrides.find(e => e.name === avatarFileName);
    return expressionOverride?.path ? expressionOverride.path : avatarFileName;
}

/**
 * Generates a unique sprite name by appending an index to the given expression. *
 * @param {string} expression - The base expression to be used as the prefix for the sprite name.
 * @param {ExpressionImage[]} existingFiles - An array of existing file objects, each containing a fileName property.
 * @returns {string} - A unique sprite name with the format "expression-index".
 */
function generateUniqueSpriteName(expression, existingFiles) {
    let index = existingFiles.length;
    let newSpriteName;
    do {
        newSpriteName = `${expression}-${index++}`;
    } while (existingFiles.some(file => withoutExtension(file.fileName) === newSpriteName));
    return newSpriteName;
}

/**
 * Slash command callback for /uploadsprite
 *
 * label= is required
 * if name= is provided, it will be used as a findChar lookup
 * if name= is not provided, the last character's name will be used
 * if folder= is a full path, it will be used as the folder
 * if folder= is a partial path, it will be appended to the character's name
 * if folder= is not provided, the character's override folder will be used, if set
 *
 * @param {object} args
 * @param {string} args.name Character name or avatar key, passed through findChar
 * @param {string} args.label Expression label
 * @param {string} [args.folder=null] Optional sprite folder path, processed using backslash rules
 * @param {string?} [args.spriteName=null] Optional sprite name
 * @param {string} imageUrl Image URI to fetch and upload
 * @returns {Promise<string>} the sprite name
 */
async function uploadSpriteCommand({ name, label, folder = null, spriteName = null }, imageUrl) {
    if (!imageUrl) throw new Error('Image URL is required');
    if (!label || typeof label !== 'string') {
        toastr.error(t`Expression label is required`, t`Error Uploading Sprite`);
        return '';
    }

    label = label.replace(/[^a-z]/gi, '').toLowerCase().trim();
    if (!label) {
        toastr.error(t`Expression label must contain at least one letter`, t`Error Uploading Sprite`);
        return '';
    }

    spriteName = spriteName || label;
    if (!validateExpressionSpriteName(label, spriteName)) {
        toastr.error(t`Invalid sprite name. Must follow the naming pattern for expression sprites.`, t`Error Uploading Sprite`);
        return '';
    }

    name = name || getLastCharacterMessage().original_avatar || getLastCharacterMessage().name;
    const char = findChar({ name });

    if (!folder) {
        folder = spriteFolderNameFromCharacter(char);
    } else if (folder.startsWith('/') || folder.startsWith('\\')) {
        const subfolder = folder.slice(1);
        folder = `${char.name}/${subfolder}`;
    }

    try {
        const response = await fetch(imageUrl);
        if (response.ok === false) throw new Error(`Could not download the sprite (${response.status}).`);
        const blob = await response.blob();
        const file = new File([blob], 'image.png', { type: 'image/png' });

        const formData = new FormData();
        formData.append('name', folder); // this is the folder or character name
        formData.append('label', label); // this is the expression label
        formData.append('avatar', file); // this is the image file
        formData.append('spriteName', spriteName); // this is a redundant comment

        const uploaded = await handleFileUpload('/api/sprites/upload', formData);
        if (uploaded === null) {
            throw new Error(`Sprite upload failed for ${name} (${label})`);
        }
        console.debug(`[${MODULE_NAME}] Upload of ${imageUrl} completed for ${name} with label ${label}`);
    } catch (error) {
        console.error(`[${MODULE_NAME}] Error uploading file:`, error);
        throw error;
    }

    return spriteName;
}

function setExpressionGenerationBusy(isBusy) {
    inSpriteGeneration = !!isBusy;
    $('#expressions_generate_missing_sprites, #expressions_upload_sprite_sheet, #expressions_redo_sprite_cleanup, #expressions_remove_all_sprites, .expression_list_generate, .expression_list_regenerate')
        .toggleClass('disabled', inSpriteGeneration)
        .attr('aria-disabled', String(inSpriteGeneration));
    $('#expressions_stop_sprite_generation')
        .toggleClass('active', inSpriteGeneration)
        .attr('aria-disabled', String(!inSpriteGeneration));

    if (!inSpriteGeneration) {
        expressionGenerationCancelRequested = false;
    }
}

function isExpressionGenerationAbortError(error) {
    return error?.name === 'AbortError';
}

function throwIfExpressionGenerationStopped() {
    if (expressionGenerationCancelRequested) {
        throw new DOMException('Expression sprite generation stopped by user', 'AbortError');
    }
}

async function requestExpressionGenerationStop() {
    if (!inSpriteGeneration) {
        toastr.info(t`No sprite generation is running.`, t`Sprite Generation`);
        return;
    }

    expressionGenerationCancelRequested = true;
    const stopped = await stopExpressionSpriteGeneration();
    toastr.info(stopped ? t`Stopping sprite generation...` : t`Stopping after the current step...`, t`Sprite Generation`);
}

function getExpressionSpriteGenerationMode() {
    const mode = extension_settings.expressions.agentSpriteGenerationMode;
    return Object.values(EXPRESSION_SPRITE_GENERATION_MODE).includes(mode)
        ? mode
        : DEFAULT_EXPRESSION_SPRITE_GENERATION_MODE;
}

function getExpressionGenerationTarget(spriteFolderName) {
    const currentLastMessage = getLastCharacterMessage();
    const context = getContext();
    const folderCharacterName = String(spriteFolderName || '').split('/')[0];
    const character = context.characters?.find(x => x.avatar === currentLastMessage.original_avatar)
        || context.characters?.find(x => x.name === currentLastMessage.name)
        || context.characters?.find(x => x.name === folderCharacterName || x.avatar?.replace(/\.[^/.]+$/, '') === folderCharacterName)
        || context.characters?.[context.characterId];

    return {
        characterName: currentLastMessage.name || character?.name || context.name2 || folderCharacterName || 'character',
        characterAvatar: currentLastMessage.original_avatar || character?.avatar || null,
        uploadName: currentLastMessage.original_avatar || currentLastMessage.name || character?.avatar || folderCharacterName || context.name2,
    };
}

async function generateAndUploadExpressionSprite(expression, spriteFolderName, { showToast = true, spriteName = null, replaceExisting = false, generationTarget = null } = {}) {
    if (!expression || !spriteFolderName) {
        toastr.warning(t`Open a chat before generating expression sprites.`, t`Sprite Generation`);
        return false;
    }

    const existingFiles = spriteCache[spriteFolderName]?.find(x => x.label === expression)?.files || [];
    if (!replaceExisting && existingFiles.length > 0 && !extension_settings.expressions.allowMultiple) {
        toastr.warning(t`Enable multiple sprites per expression before generating another sprite for ${expression}.`, t`Sprite Generation`);
        return false;
    }

    const targetSpriteName = spriteName || (existingFiles.length > 0
        ? generateUniqueSpriteName(expression, existingFiles)
        : expression);
    const { characterName, characterAvatar, uploadName } = generationTarget ?? getExpressionGenerationTarget(spriteFolderName);
    throwIfExpressionGenerationStopped();
    const imageUrl = await maybeGenerateExpressionSprite(expression, characterName, characterAvatar);
    throwIfExpressionGenerationStopped();

    if (!imageUrl) {
        if (showToast) toastr.warning(t`Quick Image Gen did not return an image.`, t`Sprite Generation`);
        return false;
    }

    // Run background removal / centering on individually generated sprites too, not just sheet
    // tiles. Without this, the "Remove background" option never applies to single sprites.
    let uploadUrl = imageUrl;
    let processedUrl = null;
    if (extension_settings.expressions.agentSpriteRemoveBackground) {
        try {
            processedUrl = await postProcessSpriteImage(imageUrl);
            uploadUrl = processedUrl;
        } catch (error) {
            if (isExpressionGenerationAbortError(error)) throw error;
            console.error('[Expressions] Failed to post-process generated sprite:', error);
        }
    }

    try {
        throwIfExpressionGenerationStopped();
        let uploadedSpriteName = '';
        try {
            uploadedSpriteName = await uploadSpriteCommand({
                name: uploadName,
                label: expression,
                folder: spriteFolderName,
                spriteName: targetSpriteName,
            }, uploadUrl);
        } catch (error) {
            if (isExpressionGenerationAbortError(error)) throw error;
            console.error('[Expressions] Sprite upload failed:', error);
        }
        throwIfExpressionGenerationStopped();
        setExpressionGenerationBusy(inSpriteGeneration);

        if (!uploadedSpriteName) return false;
        if (showToast) {
            const message = replaceExisting ? t`Regenerated sprite for ${expression}.` : t`Generated sprite for ${expression}.`;
            toastr.success(message, t`Sprite Generation`);
        }
        return true;
    } finally {
        if (processedUrl) URL.revokeObjectURL(processedUrl);
    }
}

function getExpressionSpriteSheetGrid(tileCount) {
    const count = Math.max(1, Number(tileCount) || 1);
    const columns = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / columns);
    return { columns, rows };
}

function loadImageElement(src) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Failed to load generated sprite sheet image.'));
        image.src = src;
    });
}

function canvasToPngObjectUrl(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error('Failed to split generated sprite sheet.'));
                return;
            }
            resolve(URL.createObjectURL(blob));
        }, 'image/png');
    });
}

function getPixelChannels(data, pixelIndex) {
    return {
        red: data[pixelIndex],
        green: data[pixelIndex + 1],
        blue: data[pixelIndex + 2],
        alpha: data[pixelIndex + 3],
    };
}

function getChannelSpread(red, green, blue) {
    return Math.max(red, green, blue) - Math.min(red, green, blue);
}

function isNeutralSheetPixel(red, green, blue) {
    return getChannelSpread(red, green, blue) <= SHEET_BACKGROUND_NEUTRAL_SPREAD;
}

function getAverageLightness(red, green, blue) {
    return (red + green + blue) / 3;
}

function getSheetBackgroundPalette(data, width, height) {
    const buckets = new Map();
    const addPixel = (x, y) => {
        const pixelIndex = ((y * width) + x) * 4;
        const { red, green, blue, alpha } = getPixelChannels(data, pixelIndex);
        if (alpha < 24 || !isNeutralSheetPixel(red, green, blue)) return;
        if (getAverageLightness(red, green, blue) < SHEET_BACKGROUND_MIN_NEUTRAL_LIGHTNESS) return;

        const key = [
            Math.floor(red / SHEET_BACKGROUND_BUCKET_SIZE),
            Math.floor(green / SHEET_BACKGROUND_BUCKET_SIZE),
            Math.floor(blue / SHEET_BACKGROUND_BUCKET_SIZE),
        ].join(',');
        const bucket = buckets.get(key) || { count: 0, red: 0, green: 0, blue: 0 };
        bucket.count += 1;
        bucket.red += red;
        bucket.green += green;
        bucket.blue += blue;
        buckets.set(key, bucket);
    };

    for (let x = 0; x < width; x++) {
        addPixel(x, 0);
        addPixel(x, height - 1);
    }

    for (let y = 1; y < height - 1; y++) {
        addPixel(0, y);
        addPixel(width - 1, y);
    }

    const sortedBuckets = Array.from(buckets.values()).sort((a, b) => b.count - a.count);
    const maxCount = sortedBuckets[0]?.count || 0;
    const minCount = Math.max(4, Math.floor(maxCount * 0.08));
    return sortedBuckets
        .filter(bucket => bucket.count >= minCount)
        .slice(0, SHEET_BACKGROUND_PALETTE_LIMIT)
        .map(bucket => ({
            red: bucket.red / bucket.count,
            green: bucket.green / bucket.count,
            blue: bucket.blue / bucket.count,
        }));
}

function isCloseToSheetBackgroundPalette(red, green, blue, backgroundPalette) {
    const maxDistanceSquared = SHEET_BACKGROUND_COLOR_DISTANCE ** 2;
    return backgroundPalette.some(color => {
        const redDistance = red - color.red;
        const greenDistance = green - color.green;
        const blueDistance = blue - color.blue;
        return ((redDistance ** 2) + (greenDistance ** 2) + (blueDistance ** 2)) <= maxDistanceSquared;
    });
}

function isSheetBackgroundPixel(data, pixelIndex, backgroundPalette = []) {
    const { red, green, blue, alpha } = getPixelChannels(data, pixelIndex);
    if (alpha === 0) return true;
    if (alpha < SPRITE_FOREGROUND_ALPHA_THRESHOLD) return true;

    const isFlatLightBackground = red >= SHEET_BACKGROUND_RGB_THRESHOLD
        && green >= SHEET_BACKGROUND_RGB_THRESHOLD
        && blue >= SHEET_BACKGROUND_RGB_THRESHOLD
        && getChannelSpread(red, green, blue) <= SHEET_BACKGROUND_CHANNEL_SPREAD;

    return isFlatLightBackground
        || (isNeutralSheetPixel(red, green, blue)
            && getAverageLightness(red, green, blue) >= SHEET_BACKGROUND_MIN_NEUTRAL_LIGHTNESS
            && isCloseToSheetBackgroundPalette(red, green, blue, backgroundPalette));
}

function makeCanvasBackgroundTransparent(canvas) {
    const context = canvas.getContext('2d');
    if (!context) return;

    const { width, height } = canvas;
    if (!width || !height) return;

    const imageData = context.getImageData(0, 0, width, height);
    const { data } = imageData;
    const backgroundPalette = getSheetBackgroundPalette(data, width, height);

    // Determine whether to also do a global flat-white pass.
    // When the character fills the entire tile boundary (e.g. after scale-to-fill), no edge
    // pixel qualifies as background and the edge-seeded flood-fill removes nothing.  Detect
    // this situation by checking the four corners; if at least two corners have flat-white (or
    // very light neutral) pixels we know the background is present in the image and fall back to
    // a global removal of pixels that match the flat-light threshold.  We only do this when the
    // edge palette came back empty, to avoid clobbering interior whites when a proper edge-based
    // palette was found.
    const CORNER_INSET = Math.max(2, Math.round(Math.min(width, height) * 0.03));
    const sampleCorners = [
        [CORNER_INSET, CORNER_INSET],
        [width - 1 - CORNER_INSET, CORNER_INSET],
        [CORNER_INSET, height - 1 - CORNER_INSET],
        [width - 1 - CORNER_INSET, height - 1 - CORNER_INSET],
    ];
    const cornerIsBackground = sampleCorners.map(([cx, cy]) => {
        const i = ((cy * width) + cx) * 4;
        return data[i + 3] >= SPRITE_FOREGROUND_ALPHA_THRESHOLD && isSheetBackgroundPixel(data, i, backgroundPalette);
    });
    const backgroundCornerCount = cornerIsBackground.filter(Boolean).length;
    const useGlobalFlatWhitePass = backgroundPalette.length === 0 && backgroundCornerCount >= 2;

    const visited = new Uint8Array(width * height);
    const stack = [];
    const enqueue = (x, y) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return;
        const pixel = (y * width) + x;
        if (visited[pixel]) return;
        visited[pixel] = 1;
        if (isSheetBackgroundPixel(data, pixel * 4, backgroundPalette)) stack.push(pixel);
    };

    for (let x = 0; x < width; x++) {
        enqueue(x, 0);
        enqueue(x, height - 1);
    }

    for (let y = 1; y < height - 1; y++) {
        enqueue(0, y);
        enqueue(width - 1, y);
    }

    while (stack.length > 0) {
        throwIfExpressionGenerationStopped();
        const pixel = stack.pop();
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        data[(pixel * 4) + 3] = 0;

        enqueue(x + 1, y);
        enqueue(x - 1, y);
        enqueue(x, y + 1);
        enqueue(x, y - 1);
    }

    // Global flat-white pass: when the edge-seeded flood-fill found no background (character
    // fills the full tile boundary) but at least two corners are flat-white/light, do a full
    // image sweep removing all flat-light background pixels.  This handles interior background
    // regions not connected to any edge.  We use a stricter threshold than the edge-seeded pass
    // (RGB >= 250, spread <= 10) to avoid clobbering highlights, pale skin, or teeth — we only
    // want to remove pixels that are essentially pure white.
    if (useGlobalFlatWhitePass) {
        for (let pixel = 0; pixel < width * height; pixel++) {
            throwIfExpressionGenerationStopped();
            const i = pixel * 4;
            if (data[i + 3] === 0) continue;
            const { red, green, blue } = getPixelChannels(data, i);
            if (red >= 250 && green >= 250 && blue >= 250 && getChannelSpread(red, green, blue) <= 10) {
                data[i + 3] = 0;
            }
        }
    }

    context.putImageData(imageData, 0, 0);
}

/**
 * Returns the axis-aligned bounding box of all pixels with alpha > threshold.
 * Returns null when the canvas is fully transparent or too small to be useful.
 * @param {HTMLCanvasElement} canvas
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}|null}
 */
function getSpriteForegroundBounds(canvas) {
    const context = canvas.getContext('2d');
    if (!context) return null;

    const { width, height } = canvas;
    if (!width || !height) return null;

    const { data } = context.getImageData(0, 0, width, height);
    let minX = width, minY = height, maxX = -1, maxY = -1;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (data[((y * width) + x) * 4 + 3] > SPRITE_FOREGROUND_ALPHA_THRESHOLD) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }

    if (maxX < minX || maxY < minY) return null;

    const contentWidth = maxX - minX + 1;
    const contentHeight = maxY - minY + 1;
    const minDimension = Math.min(width, height);
    if (contentWidth < minDimension * SPRITE_CENTER_MIN_CONTENT_RATIO
        && contentHeight < minDimension * SPRITE_CENTER_MIN_CONTENT_RATIO) return null;

    return { minX, minY, maxX, maxY };
}

/**
 * Redraws the foreground content of a canvas centered with equal padding on all sides.
 * The canvas dimensions are preserved. Only acts when centering would move the content
 * by more than 1px in either axis — avoids unnecessary redraws.
 * @param {HTMLCanvasElement} canvas
 */
function centerSpriteContent(canvas) {
    const bounds = getSpriteForegroundBounds(canvas);
    if (!bounds) return;

    const { width, height } = canvas;
    const contentWidth = bounds.maxX - bounds.minX + 1;
    const contentHeight = bounds.maxY - bounds.minY + 1;

    // Where the content center currently is vs where it should be
    const currentCenterX = bounds.minX + contentWidth / 2;
    const currentCenterY = bounds.minY + contentHeight / 2;
    const targetCenterX = width / 2;
    const targetCenterY = height / 2;

    const shiftX = targetCenterX - currentCenterX;
    const shiftY = targetCenterY - currentCenterY;

    // Skip if the shift is negligible
    if (Math.abs(shiftX) <= 1 && Math.abs(shiftY) <= 1) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    // Snapshot the current pixels, clear, redraw shifted
    const snapshot = context.getImageData(0, 0, width, height);
    context.clearRect(0, 0, width, height);
    context.putImageData(snapshot, Math.round(shiftX), Math.round(shiftY));
}

/**
 * Post-processes a sprite tile canvas after cropping:
 * - Optionally removes solid/near-solid backgrounds (edge-connected flood-fill, opt-in only).
 * - Always re-centers the visible content so off-center tiles from sheet splits align.
 *
 * Background removal is opt-in because full-bleed art (e.g. GPT Image 2) has no plain
 * background to strip and the flood-fill would destroy character pixels.
 * @param {HTMLCanvasElement} canvas
 */
function postProcessSpriteCanvas(canvas) {
    if (extension_settings.expressions.agentSpriteRemoveBackground) {
        makeCanvasBackgroundTransparent(canvas);
    }
    centerSpriteContent(canvas);
}

async function postProcessSpriteImage(imageUrl) {
    throwIfExpressionGenerationStopped();
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`Failed to fetch expression sprite: ${response.status}`);

    const blob = await response.blob();
    const sourceUrl = URL.createObjectURL(blob);
    try {
        const image = await loadImageElement(sourceUrl);
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        if (!width || !height) throw new Error('Expression sprite has invalid dimensions.');

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas is not available for expression sprite cleanup.');
        context.drawImage(image, 0, 0, width, height);
        postProcessSpriteCanvas(canvas);
        return await canvasToPngObjectUrl(canvas);
    } finally {
        URL.revokeObjectURL(sourceUrl);
    }
}

async function splitSpriteSheetImage(imageUrl, grid, tileCount) {
    throwIfExpressionGenerationStopped();
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`Failed to fetch generated sprite sheet: ${response.status}`);

    const blob = await response.blob();
    const sourceUrl = URL.createObjectURL(blob);
    const tileUrls = [];

    try {
        const image = await loadImageElement(sourceUrl);
        const sourceWidth = image.naturalWidth || image.width;
        const sourceHeight = image.naturalHeight || image.height;
        if (!sourceWidth || !sourceHeight) throw new Error('Generated sprite sheet has invalid dimensions.');

        const sourceTileWidth = sourceWidth / grid.columns;
        const sourceTileHeight = sourceHeight / grid.rows;
        // Use a fixed, uniform output size for every tile so all sprites share the same canvas.
        const outputTileWidth = Math.max(1, Math.round(sourceTileWidth));
        const outputTileHeight = Math.max(1, Math.round(sourceTileHeight));

        for (let index = 0; index < tileCount; index++) {
            throwIfExpressionGenerationStopped();
            const column = index % grid.columns;
            const row = Math.floor(index / grid.columns);
            // Compute integer pixel boundaries per tile from cumulative edges so columns/rows
            // tile the full image exactly with no accumulated rounding drift.
            const srcLeft = Math.round(column * sourceTileWidth);
            const srcRight = Math.round((column + 1) * sourceTileWidth);
            const srcTop = Math.round(row * sourceTileHeight);
            const srcBottom = Math.round((row + 1) * sourceTileHeight);
            const srcTileWidth = Math.max(1, srcRight - srcLeft);
            const srcTileHeight = Math.max(1, srcBottom - srcTop);
            // Trim the source edges to cut away any bleed from adjacent cells (gridlines,
            // neighbour sprites, background fragments), then scale the trimmed region to
            // fill the entire output canvas so the character is not boxed in by blank borders.
            const sourceInsetX = Math.min(srcTileWidth / 4, Math.max(1, srcTileWidth * SHEET_TILE_SOURCE_INSET_RATIO));
            const sourceInsetY = Math.min(srcTileHeight / 4, Math.max(1, srcTileHeight * SHEET_TILE_SOURCE_INSET_RATIO));
            const canvas = document.createElement('canvas');
            canvas.width = outputTileWidth;
            canvas.height = outputTileHeight;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Canvas is not available for sprite sheet splitting.');
            context.drawImage(
                image,
                srcLeft + sourceInsetX,
                srcTop + sourceInsetY,
                srcTileWidth - (sourceInsetX * 2),
                srcTileHeight - (sourceInsetY * 2),
                0,
                0,
                outputTileWidth,
                outputTileHeight,
            );
            postProcessSpriteCanvas(canvas);
            tileUrls.push(await canvasToPngObjectUrl(canvas));
        }

        return tileUrls;
    } catch (error) {
        tileUrls.forEach(url => URL.revokeObjectURL(url));
        throw error;
    } finally {
        URL.revokeObjectURL(sourceUrl);
    }
}

async function splitAndUploadExpressionSpriteSheet(imageUrl, grid, expressions, spriteFolderName, { splitErrorMessage = t`Sprite sheet could not be split into expression sprites.` } = {}) {
    const labels = Array.isArray(expressions) ? expressions.filter(Boolean) : [];
    if (labels.length === 0) return { generatedCount: 0, failedCount: 0 };

    if (!imageUrl || !grid?.columns || !grid?.rows) {
        return { generatedCount: 0, failedCount: labels.length };
    }

    const { uploadName } = getExpressionGenerationTarget(spriteFolderName);
    /** @type {string[]} */
    let tileUrls = [];
    try {
        tileUrls = await splitSpriteSheetImage(imageUrl, grid, labels.length);
    } catch (error) {
        if (isExpressionGenerationAbortError(error)) throw error;
        console.error('[Expressions] Failed to split sprite sheet:', error);
        toastr.warning(splitErrorMessage, t`Sprite Generation`);
        return { generatedCount: 0, failedCount: labels.length };
    }

    let generatedCount = 0;
    let failedCount = Math.max(0, labels.length - tileUrls.length);

    try {
        for (let index = 0; index < labels.length && index < tileUrls.length; index++) {
            throwIfExpressionGenerationStopped();
            const expression = labels[index];
            let uploadedSpriteName = '';
            try {
                uploadedSpriteName = await uploadSpriteCommand({
                    name: uploadName,
                    label: expression,
                    folder: spriteFolderName,
                    spriteName: expression,
                }, tileUrls[index]);
            } catch (error) {
                if (isExpressionGenerationAbortError(error)) throw error;
                console.error('[Expressions] Sprite sheet tile upload failed:', error);
            }
            throwIfExpressionGenerationStopped();
            setExpressionGenerationBusy(inSpriteGeneration);

            if (uploadedSpriteName) generatedCount++;
            else failedCount++;
        }
    } finally {
        tileUrls.forEach(url => URL.revokeObjectURL(url));
    }

    return { generatedCount, failedCount };
}

async function generateAndUploadExpressionSpriteSheet(expressions, spriteFolderName) {
    const labels = Array.isArray(expressions) ? expressions.filter(Boolean) : [];
    if (labels.length === 0) return { generatedCount: 0, failedCount: 0 };

    const { characterName, characterAvatar } = getExpressionGenerationTarget(spriteFolderName);
    throwIfExpressionGenerationStopped();
    const sheet = await maybeGenerateExpressionSpriteSheet(labels, characterName, characterAvatar);
    throwIfExpressionGenerationStopped();
    if (!sheet?.imageUrl) {
        return { generatedCount: 0, failedCount: labels.length };
    }

    return splitAndUploadExpressionSpriteSheet(sheet.imageUrl, sheet.grid, labels, spriteFolderName, {
        splitErrorMessage: t`Generated sheet could not be split into expression sprites.`,
    });
}

async function withExpressionGenerationLock(task) {
    if (inSpriteGeneration) {
        toastr.info(t`Sprite generation is already running.`, t`Sprite Generation`);
        return null;
    }

    setExpressionGenerationBusy(true);
    try {
        return await task();
    } catch (error) {
        if (isExpressionGenerationAbortError(error)) {
            toastr.info(t`Sprite generation stopped.`, t`Sprite Generation`);
            return null;
        }
        throw error;
    } finally {
        setExpressionGenerationBusy(false);
    }
}

async function getMissingSpriteLabels(spriteFolderName) {
    await validateImages(spriteFolderName);
    const labels = await getExpressionsList();
    return labels.filter(label => !(spriteCache[spriteFolderName]?.find(x => x.label === label)?.files?.length > 0));
}

function getSpriteFilesForFolder(spriteFolderName) {
    const seen = new Set();
    return (spriteCache[spriteFolderName] || [])
        .flatMap(sprite => (sprite.files || []).map(file => ({
            label: file.expression || sprite.label,
            fileName: file.fileName,
            imageSrc: file.imageSrc,
            spriteName: withoutExtension(file.fileName || ''),
        })))
        .filter(file => {
            if (!file.label || !file.spriteName || !file.imageSrc) return false;
            const key = `${file.label}/${file.spriteName}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

async function deleteExpressionSpriteFile(name, label, spriteName) {
    const result = await fetch('/api/sprites/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name, label, spriteName }),
    });

    if (!result.ok) {
        throw new Error(`Sprite delete failed with status ${result.status}`);
    }
}

async function reprocessExpressionSpriteFile(name, uploadName, file) {
    let processedUrl = null;
    try {
        processedUrl = await postProcessSpriteImage(file.imageSrc);
        throwIfExpressionGenerationStopped();
        const uploadedSpriteName = await uploadSpriteCommand({
            name: uploadName,
            label: file.label,
            folder: name,
            spriteName: file.spriteName,
        }, processedUrl);
        throwIfExpressionGenerationStopped();
        setExpressionGenerationBusy(inSpriteGeneration);
        return Boolean(uploadedSpriteName);
    } finally {
        if (processedUrl) URL.revokeObjectURL(processedUrl);
    }
}

async function onClickExpressionGenerate(event) {
    event.stopPropagation();

    const expressionListItem = $(this).closest('.expression_list_item');
    const expression = String(expressionListItem.data('expression') || '');
    const spriteFolderName = $('#image_list').data('name');

    await withExpressionGenerationLock(async () => generateAndUploadExpressionSprite(expression, spriteFolderName));
}

async function onClickExpressionRegenerate(event) {
    event.stopPropagation();

    const expressionListItem = $(this).closest('.expression_list_item');
    const expression = String(expressionListItem.data('expression') || '');
    const fileName = String(expressionListItem.attr('data-filename') || '');
    const spriteFolderName = $('#image_list').data('name');
    const spriteName = withoutExtension(fileName);

    if (!spriteName) {
        toastr.warning(t`Choose an existing sprite before regenerating.`, t`Sprite Generation`);
        return;
    }

    const confirmed = await Popup.show.confirm(
        t`Regenerate Sprite`,
        t`Replace ${fileName} for ${expression} with a new Quick Image Gen sprite? This can use provider credits.`,
    );

    if (!confirmed) return;

    await withExpressionGenerationLock(async () => generateAndUploadExpressionSprite(expression, spriteFolderName, {
        spriteName,
        replaceExisting: true,
    }));
}

async function onClickStopExpressionGeneration(event) {
    event.stopPropagation();
    await requestExpressionGenerationStop();
}

async function onClickRemoveAllSprites(event) {
    event.stopPropagation();

    if (inSpriteGeneration) {
        toastr.info(t`Stop sprite generation before removing sprites.`, t`Sprite Generation`);
        return;
    }

    const name = $('#image_list').data('name');
    if (!name) {
        toastr.warning(t`Open a chat before removing expression sprites.`, t`Sprite Generation`);
        return;
    }

    await validateImages(name);
    const spriteFiles = getSpriteFilesForFolder(name);
    if (spriteFiles.length === 0) {
        toastr.info(t`This sprite set has no images to remove.`, t`Sprite Generation`);
        return;
    }

    const confirmed = await Popup.show.confirm(
        t`Remove All Sprites`,
        t`Remove ${spriteFiles.length} sprite image(s) from ${name}? This cannot be undone.`,
    );

    if (!confirmed) return;

    const deleteToast = toastr.info(t`Removing expression sprites...`, t`Sprite Generation`, { timeOut: 0, extendedTimeOut: 0 });
    let deletedCount = 0;
    let failedCount = 0;

    try {
        for (const file of spriteFiles) {
            try {
                await deleteExpressionSpriteFile(name, file.label, file.spriteName);
                deletedCount++;
            } catch (error) {
                failedCount++;
                console.error(`[${MODULE_NAME}] Failed to delete sprite ${file.fileName}:`, error);
            }
        }
    } finally {
        toastr.clear(deleteToast);
        delete spriteCache[name];
        await fetchImagesNoCache();
        await validateImages(name);
    }

    if (deletedCount > 0) {
        toastr.success(t`Removed ${deletedCount} expression sprite(s).`, t`Sprite Generation`);
    }

    if (failedCount > 0) {
        toastr.warning(t`${failedCount} expression sprite(s) could not be removed. Check the console.`, t`Sprite Generation`);
    }
}

async function onClickRedoSpriteCleanup(event) {
    event.stopPropagation();

    const name = $('#image_list').data('name');
    if (!name) {
        toastr.warning(t`Open a chat before cleaning expression sprites.`, t`Sprite Generation`);
        return;
    }

    await validateImages(name);
    const spriteFiles = getSpriteFilesForFolder(name);
    if (spriteFiles.length === 0) {
        toastr.info(t`This sprite set has no images to clean.`, t`Sprite Generation`);
        return;
    }

    const confirmed = await Popup.show.confirm(
        t`Redo Crop and Transparency`,
        t`Reprocess ${spriteFiles.length} sprite image(s) in ${name} with the improved crop and transparency cleanup? Existing sprite files will be overwritten.`,
    );

    if (!confirmed) return;

    await withExpressionGenerationLock(async () => {
        const cleanupToast = toastr.info(t`Cleaning expression sprites...`, t`Sprite Generation`, { timeOut: 0, extendedTimeOut: 0 });
        const { uploadName } = getExpressionGenerationTarget(name);
        let cleanedCount = 0;
        let failedCount = 0;

        try {
            for (const file of spriteFiles) {
                try {
                    throwIfExpressionGenerationStopped();
                    const cleaned = await reprocessExpressionSpriteFile(name, uploadName, file);
                    if (cleaned) cleanedCount++;
                    else failedCount++;
                } catch (error) {
                    if (isExpressionGenerationAbortError(error)) throw error;
                    failedCount++;
                    console.error(`[${MODULE_NAME}] Failed to clean sprite ${file.fileName}:`, error);
                }
            }
        } finally {
            toastr.clear(cleanupToast);
            delete spriteCache[name];
            await fetchImagesNoCache();
            await validateImages(name);
        }

        if (cleanedCount > 0) {
            toastr.success(t`Cleaned ${cleanedCount} expression sprite(s).`, t`Sprite Generation`);
        }

        if (failedCount > 0) {
            toastr.warning(t`${failedCount} expression sprite(s) could not be cleaned. Check the console.`, t`Sprite Generation`);
        }
    });
}

async function onClickUploadSpriteSheet(event) {
    event.stopPropagation();

    const spriteFolderName = $('#image_list').data('name');
    if (!spriteFolderName) {
        toastr.warning(t`Open a chat before uploading a character sheet.`, t`Sprite Generation`);
        return;
    }

    const missingLabels = await getMissingSpriteLabels(spriteFolderName);
    if (missingLabels.length === 0) {
        toastr.success(t`This sprite set already has images for every expression.`, t`Sprite Generation`);
        return;
    }

    const grid = getExpressionSpriteSheetGrid(missingLabels.length);
    const confirmed = await Popup.show.confirm(
        t`Upload Character Sheet`,
        t`Upload a character sheet for ${missingLabels.length} missing sprite(s) in ${spriteFolderName}. The extension will split it as a ${grid.columns} x ${grid.rows} grid, left-to-right, top-to-bottom in this order: ${missingLabels.join(', ')}.`,
    );

    if (!confirmed) return;

    const handleSheetUploadChange = async (e) => {
        const input = e.target;
        const file = input.files?.[0];

        try {
            if (!file) return;

            await withExpressionGenerationLock(async () => {
                const uploadToast = toastr.info(t`Splitting uploaded character sheet...`, t`Sprite Generation`, { timeOut: 0, extendedTimeOut: 0 });
                const sourceUrl = URL.createObjectURL(file);
                let generatedCount = 0;
                let failedCount = 0;

                try {
                    const result = await splitAndUploadExpressionSpriteSheet(sourceUrl, grid, missingLabels, spriteFolderName, {
                        splitErrorMessage: t`Uploaded sheet could not be split into expression sprites.`,
                    });
                    generatedCount = result.generatedCount;
                    failedCount = result.failedCount;
                } finally {
                    URL.revokeObjectURL(sourceUrl);
                    toastr.clear(uploadToast);
                }

                if (generatedCount > 0) {
                    toastr.success(t`Uploaded ${generatedCount} expression sprite(s).`, t`Sprite Generation`);
                }

                if (failedCount > 0) {
                    toastr.warning(t`${failedCount} expression sprite(s) could not be uploaded from the sheet. Check the image layout and the console.`, t`Sprite Generation`);
                }
            });
        } finally {
            input.form?.reset();
        }
    };

    $('#expression_upload_sheet')
        .off('change')
        .on('change', handleSheetUploadChange)
        .trigger('click');
}

async function onClickGenerateMissingSprites(event) {
    event.stopPropagation();

    const spriteFolderName = $('#image_list').data('name');
    if (!spriteFolderName) {
        toastr.warning(t`Open a chat before generating expression sprites.`, t`Sprite Generation`);
        return;
    }

    const missingLabels = await getMissingSpriteLabels(spriteFolderName);
    if (missingLabels.length === 0) {
        toastr.success(t`This sprite set already has images for every expression.`, t`Sprite Generation`);
        return;
    }

    const confirmed = await Popup.show.confirm(
        t`Generate Missing Sprites`,
        getExpressionSpriteGenerationMode() === EXPRESSION_SPRITE_GENERATION_MODE.sheet && missingLabels.length > 1
            ? t`Generate one character sheet for ${missingLabels.length} missing sprite(s) in ${spriteFolderName}, then split it into individual expression images? This can use provider credits.`
            : t`Generate ${missingLabels.length} missing sprite(s) for ${spriteFolderName} with Quick Image Gen? This may take a while and can use provider credits.`,
    );

    if (!confirmed) return;

    await withExpressionGenerationLock(async () => {
        const generationToast = toastr.info(t`Generating missing expression sprites...`, t`Sprite Generation`, { timeOut: 0, extendedTimeOut: 0 });
        let generatedCount = 0;
        let failedCount = 0;

        try {
            if (getExpressionSpriteGenerationMode() === EXPRESSION_SPRITE_GENERATION_MODE.sheet && missingLabels.length > 1) {
                const result = await generateAndUploadExpressionSpriteSheet(missingLabels, spriteFolderName);
                generatedCount = result.generatedCount;
                failedCount = result.failedCount;
            } else {
                for (const expression of missingLabels) {
                    const generated = await generateAndUploadExpressionSprite(expression, spriteFolderName, { showToast: false });
                    if (generated) generatedCount++;
                    else failedCount++;
                }
            }
        } finally {
            toastr.clear(generationToast);
        }

        if (generatedCount > 0) {
            toastr.success(t`Generated ${generatedCount} expression sprite(s).`, t`Sprite Generation`);
        }

        if (failedCount > 0) {
            toastr.warning(t`${failedCount} expression sprite(s) could not be generated. Check Quick Image Gen settings and the console.`, t`Sprite Generation`);
        }
    });
}

function onExpressionGenerationKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    $(event.currentTarget).trigger('click');
}

/**
 * Processes the classification text to reduce the amount of text sent to the API.
 * Quotes and asterisks are to be removed. If the text is less than 300 characters, it is returned as is.
 * If the text is more than 300 characters, the first and last 150 characters are returned.
 * The result is trimmed to the end of sentence.
 * @param {string} text The text to process.
 * @returns {string}
 */
function sampleClassifyText(text) {
    if (!text) {
        return text;
    }

    // Replace macros, remove asterisks and quotes
    let result = substituteParams(text).replace(/[*"]/g, '');

    // If using LLM api there is no need to check length of characters
    if (extension_settings.expressions.api === EXPRESSION_API.llm) {
        return result.trim();
    }

    const SAMPLE_THRESHOLD = 500;
    const HALF_SAMPLE_THRESHOLD = SAMPLE_THRESHOLD / 2;

    if (text.length < SAMPLE_THRESHOLD) {
        result = trimToEndSentence(result);
    } else {
        result = trimToEndSentence(result.slice(0, HALF_SAMPLE_THRESHOLD)) + ' ' + trimToStartSentence(result.slice(-HALF_SAMPLE_THRESHOLD));
    }

    return result.trim();
}

/**
 * Gets the classification prompt for the LLM API.
 * @param {string[]} labels A list of labels to search for.
 * @returns {Promise<string>} Prompt for the LLM API.
 */
async function getLlmPrompt(labels) {
    const labelsString = labels.map(x => `"${x}"`).join(', ');
    const prompt = substituteParamsExtended(String(extension_settings.expressions.llmPrompt), { labels: labelsString });
    return prompt;
}

/**
 * Parses the emotion response from the LLM API.
 * @param {string} emotionResponse The response from the LLM API.
 * @param {string[]} labels A list of labels to search for.
 * @returns {string} The parsed emotion or the fallback expression.
 */
function parseLlmResponse(emotionResponse, labels) {
    try {
        const parsedEmotion = JSON.parse(emotionResponse);
        const response = parsedEmotion?.emotion?.trim()?.toLowerCase();

        if (!response || !labels.includes(response)) {
            console.debug(`Parsed emotion response: ${response} not in labels: ${labels}`);
            throw new Error('Emotion not in labels');
        }

        return response;
    } catch {
        // Clean possible reasoning from response
        emotionResponse = removeReasoningFromString(emotionResponse);

        const fuse = new Fuse(labels, { includeScore: true });
        console.debug('Using fuzzy search in labels:', labels);
        const result = fuse.search(emotionResponse);
        if (result.length > 0) {
            console.debug(`fuzzy search found: ${result[0].item} as closest for the LLM response:`, emotionResponse);
            return result[0].item;
        }
        const lowerCaseResponse = String(emotionResponse || '').toLowerCase();
        for (const label of labels) {
            if (lowerCaseResponse.includes(label.toLowerCase())) {
                console.debug(`Found label ${label} in the LLM response:`, emotionResponse);
                return label;
            }
        }
    }

    throw new Error('Could not parse emotion response ' + emotionResponse);
}

/**
 * Gets the JSON schema for the LLM API.
 * @param {string[]} emotions A list of emotions to search for.
 * @returns {object} The JSON schema for the LLM API.
 */
function getJsonSchema(emotions) {
    return {
        $schema: 'http://json-schema.org/draft-04/schema#',
        type: 'object',
        properties: {
            emotion: {
                type: 'string',
                enum: emotions,
            },
        },
        required: [
            'emotion',
        ],
        additionalProperties: false,
    };
}

function onTextGenSettingsReady(args) {
    // Only call if inside an API call
    if (inApiCall && extension_settings.expressions.api === EXPRESSION_API.llm && isJsonSchemaSupported()) {
        const emotions = DEFAULT_EXPRESSIONS;
        Object.assign(args, {
            top_k: 1,
            stop: [],
            stopping_strings: [],
            custom_token_bans: [],
            json_schema: getJsonSchema(emotions),
        });
    }
}

/**
 * Retrieves the label of an expression via classification based on the provided text.
 * Optionally allows to override the expressions API being used.
 * @param {string} text - The text to classify and retrieve the expression label for.
 * @param {EXPRESSION_API} [expressionsApi=extension_settings.expressions.api] - The expressions API to use for classification.
 * @param {object} [options={}] - Optional arguments.
 * @param {boolean?} [options.filterAvailable=null] - Whether to filter available expressions. If not specified, uses the extension setting.
 * @param {string?} [options.customPrompt=null] - The custom prompt to use for classification.
 * @returns {Promise<string?>} - The label of the expression.
 */
export async function getExpressionLabel(text, expressionsApi = extension_settings.expressions.api, { filterAvailable = null, customPrompt = null, target = null } = {}) {
    // Return if text is undefined, saving a costly fetch request
    if (!text) {
        return extension_settings.expressions.fallback_expression;
    }

    if (extension_settings.expressions.translate && typeof globalThis.translate === 'function') {
        text = await globalThis.translate(text, 'en');
    }

    text = sampleClassifyText(text);

    filterAvailable ??= extension_settings.expressions.filterAvailable;
    if (filterAvailable && ![EXPRESSION_API.llm, EXPRESSION_API.webllm].includes(expressionsApi)) {
        console.debug('Filter available is only supported for LLM and WebLLM expressions');
    }

    try {
        switch (expressionsApi) {
            // Local BERT pipeline
            case EXPRESSION_API.local: {
                const localResult = await fetch('/api/extra/classify', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ text: text }),
                });

                if (localResult.ok) {
                    const data = await localResult.json();
                    return data.classification[0].label;
                }
            } break;
            // Using LLM
            case EXPRESSION_API.llm: {
                try {
                    await waitUntilCondition(() => online_status !== 'no_connection', 3000, 250);
                } catch (error) {
                    console.warn('No LLM connection. Using fallback expression', error);
                    return extension_settings.expressions.fallback_expression;
                }

                const expressionsList = await getExpressionsList({ filterAvailable: filterAvailable });
                const prompt = substituteParamsExtended(customPrompt, { labels: expressionsList }) || await getLlmPrompt(expressionsList);
                eventSource.once(event_types.TEXT_COMPLETION_SETTINGS_READY, onTextGenSettingsReady);

                let emotionResponse;
                try {
                    inApiCall = true;
                    switch (extension_settings.expressions.promptType) {
                        case PROMPT_TYPE.raw:
                            emotionResponse = await generateRaw({ prompt: text, systemPrompt: prompt });
                            break;
                        case PROMPT_TYPE.full:
                            emotionResponse = await generateQuietPrompt({ quietPrompt: prompt });
                            break;
                    }
                } finally {
                    inApiCall = false;
                }
                return parseLlmResponse(emotionResponse, expressionsList);
            }
            // Using WebLLM
            case EXPRESSION_API.webllm: {
                if (!isWebLlmSupported()) {
                    console.warn('WebLLM is not supported. Using fallback expression');
                    return extension_settings.expressions.fallback_expression;
                }

                const expressionsList = await getExpressionsList({ filterAvailable: filterAvailable });
                const prompt = substituteParamsExtended(customPrompt, { labels: expressionsList }) || await getLlmPrompt(expressionsList);
                const messages = [
                    { role: 'user', content: text + '\n\n' + prompt },
                ];

                const emotionResponse = await generateWebLlmChatPrompt(messages);
                return parseLlmResponse(emotionResponse, expressionsList);
            }
            // Neconyan divergence: In-Chat Agent companion classifier.
            // Reads the emotion the companion agent already classified for the latest
            // assistant reply instead of making a blocking API call here.
            case EXPRESSION_API.agent: {
                const agentLabel = await getAgentExpressionLabel(undefined, await getExpressionsList({ filterAvailable: false }), target);
                if (agentLabel) return agentLabel;
                // Not ready yet (agent pending/missing) - return empty so the fallback is used.
                return '';
            }
            // None
            case EXPRESSION_API.none: {
                // Return empty, the fallback expression will be used
                return '';
            }
            default: {
                toastr.error('Invalid API selected');
                return '';
            }
        }
    } catch (error) {
        toastr.error('Could not classify expression. Check the console or your backend for more information.');
        console.error(error);
        return extension_settings.expressions.fallback_expression;
    }
}

function getLastCharacterMessage() {
    const context = getContext();
    const reversedChat = context.chat.slice().reverse();

    for (let mes of reversedChat) {
        if (mes.is_user || mes.is_system || mes.extra?.type === system_message_types.NARRATOR) {
            continue;
        }

        return mes;
    }

    return { mes: '', name: null, original_avatar: null, force_avatar: null };
}

function removeExpression() {
    $('img.expression').off('error');
    $('img.expression').prop('src', '');
    $('img.expression').removeClass('default');
    $('#open_chat_expressions').hide();
    $('#no_chat_expressions').show();
}

/**
 * Validate a character's sprites, and redraw the sprites list if not done before or forced to redraw.
 * @param {string} spriteFolderName - The character sprite folder to validate
 * @param {boolean} [forceRedrawCached=false] - Whether to force redrawing the sprites list even if it's already been drawn before
 */
async function validateImages(spriteFolderName, forceRedrawCached = false) {
    if (!spriteFolderName) {
        return;
    }

    const revision = ++spriteListLoadRevision;
    const generation = getChatGeneration();
    const chatId = getCurrentChatId();
    const isCurrent = () => revision === spriteListLoadRevision && generation === getChatGeneration() && chatId === getCurrentChatId();
    const labels = await getExpressionsList();
    if (!isCurrent()) return;

    if (spriteCache[spriteFolderName]) {
        if (forceRedrawCached && $('#image_list').data('name') !== spriteFolderName) {
            console.debug('force redrawing character sprites list');
            await drawSpritesList(spriteFolderName, labels, spriteCache[spriteFolderName], isCurrent);
        }

        return;
    }

    const sprites = await getSpritesList(spriteFolderName);
    if (!isCurrent()) return;
    const validExpressions = await drawSpritesList(spriteFolderName, labels, sprites, isCurrent);
    if (isCurrent()) spriteCache[spriteFolderName] = validExpressions;
}

/**
 * Takes a given sprite as returned from the server, and enriches it with additional data for display/sorting
 * @param {{ path: string, label: string }} sprite
 * @returns {ExpressionImage}
 */
function getExpressionImageData(sprite) {
    const fileName = sprite.path.split('/').pop().split('?')[0];
    const fileNameWithoutExtension = fileName.replace(/\.[^/.]+$/, '');
    return {
        expression: sprite.label,
        fileName: fileName,
        title: fileNameWithoutExtension,
        imageSrc: sprite.path,
        type: 'success',
        canRegenerate: true,
        isCustom: extension_settings.expressions.custom?.includes(sprite.label),
    };
}

/**
 * Populate the character expression list with sprites for the given character.
 * @param {string} spriteFolderName - The name of the character to populate the list for
 * @param {string[]} labels - An array of expression labels that are valid
 * @param {Expression[]} sprites - An array of sprites
 * @returns {Promise<Expression[]>} An array of valid expression labels
 */
async function drawSpritesList(spriteFolderName, labels, sprites, isCurrent = () => true) {
    /** @type {Expression[]} */
    let validExpressions = [];

    if (!Array.isArray(labels)) {
        return [];
    }

    const items = [];
    for (const expression of [...labels].sort()) {
        const isCustom = extension_settings.expressions.custom?.includes(expression);
        const images = sprites
            .filter(s => s.label === expression)
            .map(s => s.files)
            .flat();

        if (images.length === 0) {
            const listItem = await getListItem(expression, {
                isCustom,
                images: [getPlaceholderImage(expression, isCustom)],
            });
            items.push(listItem);
            continue;
        }

        validExpressions.push({ label: expression, files: images });

        // Render main = first file, additional = rest
        let listItem = await getListItem(expression, {
            isCustom,
            images,
        });
        items.push(listItem);
    }
    if (!isCurrent()) return validExpressions;
    $('#no_chat_expressions').hide();
    $('#open_chat_expressions').show();
    $('#image_list').empty().data('name', spriteFolderName).append(items);
    $('#image_list_header_name').text(spriteFolderName);
    return validExpressions;
}

/**
 * Renders a list item template for the expressions list.
 * @param {string} expression Expression name
 * @param {object} args Arguments object
 * @param {ExpressionImage[]} [args.images] Array of image objects
 * @param {boolean} [args.isCustom=false] If expression is added by user
 * @returns {Promise<string>} Rendered list item template
 */
async function getListItem(expression, { images, isCustom = false } = {}) {
    return renderExtensionTemplateAsync(MODULE_NAME, 'list-item', { expression, images, isCustom: isCustom ?? false });
}

/**
 * Fetches and processes the list of sprites for a given character name.
 * Retrieves sprite data from the server and organizes it into labeled groups.
 *
 * @param {string} name - The character name to fetch sprites for
 * @returns {Promise<Expression[]>} A promise that resolves to an array of grouped expression objects, each containing a label and associated image data
 */

async function getSpritesList(name) {
    console.debug('getting sprites list');

    try {
        const result = await fetch(`/api/sprites/get?name=${encodeURIComponent(name)}`);
        /** @type {{ label: string, path: string }[]} */
        let sprites = result.ok ? (await result.json()) : [];

        /** @type {Expression[]} */
        const grouped = sprites.reduce((acc, sprite) => {
            const imageData = getExpressionImageData(sprite);
            let existingExpression = acc.find(exp => exp.label === sprite.label);
            if (existingExpression) {
                existingExpression.files.push(imageData);
            } else {
                acc.push({ label: sprite.label, files: [imageData] });
            }

            return acc;
        }, []);

        // Sort the sprites for each expression alphabetically, but keep the main expression file at the front
        for (const expression of grouped) {
            expression.files.sort((a, b) => {
                if (a.title === expression.label) return -1;
                if (b.title === expression.label) return 1;
                return a.title.localeCompare(b.title);
            });

            // Mark all besides the first sprite as 'additional'
            for (let i = 1; i < expression.files.length; i++) {
                expression.files[i].type = 'additional';
            }
        }

        return grouped;
    } catch (err) {
        console.log(err);
        return [];
    }
}

async function renderAdditionalExpressionSettings() {
    renderCustomExpressions();
    await renderFallbackExpressionPicker();
}

function renderCustomExpressions() {
    if (!Array.isArray(extension_settings.expressions.custom)) {
        extension_settings.expressions.custom = [];
    }

    const customExpressions = extension_settings.expressions.custom.sort((a, b) => a.localeCompare(b));
    $('#expression_custom').empty();

    for (const expression of customExpressions) {
        const option = document.createElement('option');
        option.value = expression;
        option.text = expression;
        $('#expression_custom').append(option);
    }

    if (customExpressions.length === 0) {
        $('#expression_custom').append('<option value="" disabled selected>[ No custom expressions ]</option>');
    }
}

async function renderFallbackExpressionPicker() {
    const expressions = await getExpressionsList();

    const defaultPicker = $('#expression_fallback');
    defaultPicker.empty();


    addOption(OPTION_NO_FALLBACK, '[ No fallback ]', !extension_settings.expressions.fallback_expression && !extension_settings.expressions.showDefault);
    addOption(OPTION_EMOJI_FALLBACK, '[ Default emojis ]', !!extension_settings.expressions.showDefault);

    for (const expression of expressions) {
        addOption(expression, expression, expression == extension_settings.expressions.fallback_expression);
    }

    /** @type {(value: string, label: string, isSelected: boolean) => void} */
    function addOption(value, label, isSelected) {
        const option = document.createElement('option');
        option.value = value;
        option.text = label;
        option.selected = isSelected;
        defaultPicker.append(option);
    }
}

/**
 * Retrieves a unique list of cached expressions.
 * Combines the default expressions list with custom user-defined expressions.
 *
 * @returns {string[]} An array of unique expression labels
 */

function getCachedExpressions() {
    if (!Array.isArray(expressionsList)) {
        return [];
    }

    return [...expressionsList, ...extension_settings.expressions.custom].filter(onlyUnique);
}

export async function getExpressionsList({ filterAvailable = false } = {}) {
    // If there is no cached list, load and cache it
    if (!Array.isArray(expressionsList)) {
        expressionsList = await resolveExpressionsList();
    }

    const expressions = getCachedExpressions();

    // Filtering is only available for llm and webllm APIs
    if (!filterAvailable || ![EXPRESSION_API.llm, EXPRESSION_API.webllm].includes(extension_settings.expressions.api)) {
        return expressions;
    }

    // Get expressions with available sprites
    const currentLastMessage = selected_group ? getLastCharacterMessage() : null;
    const spriteFolderName = getSpriteFolderName(currentLastMessage, currentLastMessage?.name);

    return expressions.filter(label => {
        const expression = spriteCache[spriteFolderName]?.find(x => x.label === label);
        return (expression?.files.length ?? 0) > 0;
    });

    /**
     * Returns the list of expressions from the API or fallback in offline mode.
     * @returns {Promise<string[]>}
     */
    async function resolveExpressionsList() {
        // See if we can retrieve a specific expression list from the API
        try {
            // If running the local classify model (not using the LLM), we ask that one
            if (extension_settings.expressions.api == EXPRESSION_API.local) {
                const apiResult = await fetch('/api/extra/classify/labels', {
                    method: 'POST',
                    headers: getRequestHeaders({ omitContentType: true }),
                });

                if (apiResult.ok) {
                    const data = await apiResult.json();
                    expressionsList = data.labels;
                    return expressionsList;
                }
            }
        } catch (error) {
            console.log(error);
        }

        // If there was no specific list, or an error, just return the default expressions
        expressionsList = DEFAULT_EXPRESSIONS.slice();
        return expressionsList;
    }
}

/**
 * Selects a sprite from the given sprite folder for the given expression.
 *
 * If multiple sprites are allowed for the expression, it will randomly select one.
 * If the rerollIfSame option is enabled, it will only select a different sprite if the previous sprite was the same.
 * If the overrideSpriteFile option is set, it will look for the sprite with the given file name instead of randomly selecting one.
 *
 * @param {string} spriteFolderName - The name of the sprite folder
 * @param {string} expression - The expression to find the sprite for
 * @param {object} [options] - Options to select the sprite
 * @param {string} [options.prevExpressionSrc=null] - The source of the previous expression
 * @param {string} [options.overrideSpriteFile=null] - The file name of the sprite to select
 * @returns {ExpressionImage?} - The selected sprite
 */
function chooseSpriteForExpression(spriteFolderName, expression, { prevExpressionSrc = null, overrideSpriteFile = null } = {}) {
    if (!spriteCache[spriteFolderName]) return null;
    if (expression === RESET_SPRITE_LABEL) return null;

    // Search for sprites of that expression - or fallback expression sprites if enabled
    let sprite = spriteCache[spriteFolderName].find(x => x.label === expression);
    if (!(sprite?.files.length > 0) && extension_settings.expressions.fallback_expression) {
        sprite = spriteCache[spriteFolderName].find(x => x.label === extension_settings.expressions.fallback_expression);
        console.debug('Expression', expression, 'not found. Using fallback expression', extension_settings.expressions.fallback_expression);
    }
    if (!(sprite?.files.length > 0)) return null;

    let spriteFile = sprite.files[0];

    // If a specific sprite file should be set, we are looking it up here
    if (overrideSpriteFile) {
        const searched = sprite.files.find(x => x.fileName === overrideSpriteFile);
        if (searched) spriteFile = searched;
        else toastr.warning(t`Couldn't find sprite file ${overrideSpriteFile} for expression ${expression}.`, t`Sprite Not Found`);
    } else if (extension_settings.expressions.allowMultiple && sprite.files.length > 1) {
        // Else calculate next expression, if multiple are allowed
        let possibleFiles = sprite.files;
        if (extension_settings.expressions.rerollIfSame) {
            possibleFiles = possibleFiles.filter(x => !prevExpressionSrc || x.imageSrc !== prevExpressionSrc);
        }
        spriteFile = possibleFiles[Math.floor(Math.random() * possibleFiles.length)];
    }

    return spriteFile;
}

/**
 * Set the expression of a character.
 * @param {string} spriteFolderName - The name of the character (folder name - can also be a costume override)
 * @param {string} expression - The expression or sprite name to set
 * @param {Object} options - Optional parameters
 * @param {boolean} [options.force=false] - Whether to force the expression change even if Visual Novel mode is on
 * @param {string?} [options.overrideSpriteFile=null] - Set if a specific sprite file should be used. Must be sprite file name.
 * @returns {Promise<void>} A promise that resolves when the expression has been set.
 */
async function setExpression(spriteFolderName, expression, { force = false, overrideSpriteFile = null, vnMode = false, target = null, isCurrent = () => true } = {}) {
    await validateImages(spriteFolderName);
    if (!isCurrent()) return undefined;
    const img = vnMode
        ? $('#visual-novel-wrapper .expression-holder').filter((_, element) => element.dataset.avatar === target?.avatar).find('img')
        : $('#expression-image');
    const prevExpressionSrc = img.attr('src');
    const spriteFile = chooseSpriteForExpression(spriteFolderName, expression, { prevExpressionSrc: prevExpressionSrc, overrideSpriteFile: overrideSpriteFile });
    const emoji = extension_settings.expressions.custom?.includes(expression) ? DEFAULT_FALLBACK_EXPRESSION : expression;
    const fallback = extension_settings.expressions.showDefault && expression !== RESET_SPRITE_LABEL
        ? `/img/default-expressions/${emoji}.png` : null;
    const src = await setImage(img, spriteFile?.imageSrc ?? null, { isCurrent, fallback, force });
    if (src === undefined) return undefined;
    img.attr({ 'data-sprite-folder-name': spriteFolderName, 'data-expression': expression,
        'data-sprite-filename': spriteFile?.fileName ?? null, title: expression });
    img.parent().toggleClass('hidden', vnMode && !src);
    if (!vnMode) document.getElementById('expression-holder').style.display = '';
    return src;
}

function onClickExpressionImage() {
    // If there is no expression image and we clicked on the placeholder, we remove the sprite by calling via the expression label
    if ($(this).attr('data-expression-type') === 'failure') {
        const label = $(this).attr('data-expression');
        setSpriteSlashCommand({ type: 'expression' }, label);
        return;
    }

    const spriteFile = $(this).attr('data-filename');
    setSpriteSlashCommand({ type: 'sprite' }, spriteFile);
}

async function onClickExpressionAddCustom() {
    const template = await renderExtensionTemplateAsync(MODULE_NAME, 'add-custom-expression');
    let expressionName = await Popup.show.input(null, template);

    if (!expressionName) {
        console.debug('No custom expression name provided');
        return;
    }

    expressionName = expressionName.trim().toLowerCase();

    // a-z, 0-9, dashes and underscores only
    if (!/^[a-z0-9-_]+$/.test(expressionName)) {
        toastr.warning('Invalid custom expression name provided', 'Add Custom Expression');
        return;
    }
    if (DEFAULT_EXPRESSIONS.includes(expressionName) || DEFAULT_EXPRESSIONS.some(x => expressionName.startsWith(x))) {
        toastr.warning('Expression name already exists', 'Add Custom Expression');
        return;
    }
    if (extension_settings.expressions.custom.includes(expressionName)) {
        toastr.warning('Custom expression already exists', 'Add Custom Expression');
        return;
    }

    // Add custom expression into settings
    extension_settings.expressions.custom.push(expressionName);
    await renderAdditionalExpressionSettings();
    saveSettingsDebounced();

    // Force refresh sprites list
    expressionsList = null;
    spriteCache = {};
    moduleWorker();
}

async function onClickExpressionRemoveCustom() {
    const selectedExpression = String($('#expression_custom').val());
    const noCustomExpressions = extension_settings.expressions.custom.length === 0;

    if (!selectedExpression || noCustomExpressions) {
        console.debug('No custom expression selected');
        return;
    }

    const template = await renderExtensionTemplateAsync(MODULE_NAME, 'remove-custom-expression', { expression: selectedExpression });
    const confirmation = await Popup.show.confirm(null, template);

    if (!confirmation) {
        console.debug('Custom expression removal cancelled');
        return;
    }

    // Remove custom expression from settings
    const index = extension_settings.expressions.custom.indexOf(selectedExpression);
    extension_settings.expressions.custom.splice(index, 1);
    if (selectedExpression == extension_settings.expressions.fallback_expression) {
        toastr.warning(`Deleted custom expression '${selectedExpression}' that was also selected as the fallback expression.\nFallback expression has been reset to '${DEFAULT_FALLBACK_EXPRESSION}'.`, 'Remove Custom Expression');
        extension_settings.expressions.fallback_expression = DEFAULT_FALLBACK_EXPRESSION;
    }
    await renderAdditionalExpressionSettings();
    saveSettingsDebounced();

    // Force refresh sprites list
    expressionsList = null;
    spriteCache = {};
    moduleWorker();
}

function onExpressionApiChanged() {
    const tempApi = this.value;
    if (tempApi) {
        extension_settings.expressions.api = Number(tempApi);
        $('.expression_llm_prompt_block').toggle([EXPRESSION_API.llm, EXPRESSION_API.webllm].includes(extension_settings.expressions.api));
        $('.expression_prompt_type_block').toggle(extension_settings.expressions.api === EXPRESSION_API.llm);
        $('.expression_agent_block').toggle(extension_settings.expressions.api === EXPRESSION_API.agent);
        if (extension_settings.expressions.api === EXPRESSION_API.agent) {
            updateExpressionsAgentStatus();
        }
        expressionsList = null;
        spriteCache = {};
        moduleWorker();
        saveSettingsDebounced();
    }
}

async function updateExpressionsAgentStatus() {
    const statusEl = $('#expressions_agent_status_text');
    if (!statusEl.length) return;

    const { status } = await getExpressionsAgentStatus();
    if (status === 'ready') {
        statusEl.text(t`Expressions Agent is enabled and ready.`);
        statusEl.removeClass('unavailable').addClass('available');
    } else {
        const messages = {
            missing: t`Add the Expressions Agent template from the Agents library.`,
            disabled: t`Enable Agents and the Expressions Agent for this chat type.`,
            inline: t`Set the Expressions Agent to Companion execution.`,
            hidden: t`Unhide the Expressions Agent to allow automatic classification.`,
            manual: t`Set the Expressions Agent to run automatically.`,
        };
        statusEl.text(messages[status]);
        statusEl.removeClass('available').addClass('unavailable');
    }
}

async function onExpressionFallbackChanged() {
    /** @type {HTMLSelectElement} */
    const select = this;
    const selectedValue = select.value;

    switch (selectedValue) {
        case OPTION_NO_FALLBACK:
            extension_settings.expressions.fallback_expression = null;
            extension_settings.expressions.showDefault = false;
            break;
        case OPTION_EMOJI_FALLBACK:
            extension_settings.expressions.fallback_expression = null;
            extension_settings.expressions.showDefault = true;
            break;
        default:
            extension_settings.expressions.fallback_expression = selectedValue;
            extension_settings.expressions.showDefault = false;
            break;
    }

    const img = $('img.expression');
    const spriteFolderName = img.attr('data-sprite-folder-name');
    const expression = img.attr('data-expression');

    if (spriteFolderName && expression) {
        await sendExpressionCall(spriteFolderName, expression, { force: true });
    }

    saveSettingsDebounced();
}

/**
 * Handles the file upload process for a sprite image.
 * @param {string} url URL to upload the file to
 * @param {FormData} formData FormData object containing the file and other data to upload
 * @returns {Promise<any>} - The response data from the server
 */
async function handleFileUpload(url, formData) {
    const generation = getChatGeneration();
    const chatId = getCurrentChatId();
    const listedFolder = $('#image_list').data('name');
    const canRefresh = () => generation === getChatGeneration() && chatId === getCurrentChatId()
        && listedFolder === $('#image_list').data('name');
    try {
        const result = await fetch(url, {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
            body: formData,
            cache: 'no-cache',
        });

        if (!result.ok) {
            throw new Error(`Upload failed with status ${result.status}`);
        }

        const data = await result.json();

        // Refresh sprites list
        const name = formData.get('name').toString();
        delete spriteCache[name];
        if (canRefresh() && listedFolder === name) {
            await fetchImagesNoCache();
            if (canRefresh()) await validateImages(name);
        }

        return data ?? {};
    } catch (error) {
        console.error('Error uploading image:', error);
        toastr.error('Failed to upload image');
        // null tells callers the upload did not happen; {} used to look like success.
        return null;
    }
}

/**
 * Removes the file extension from a file name
 * @param {string} fileName The file name to remove the extension from
 * @returns {string} The file name without the extension
 */
function withoutExtension(fileName) {
    return fileName.replace(/\.[^/.]+$/, '');
}

function validateExpressionSpriteName(expression, spriteName) {
    const filenameValidationRegex = new RegExp(`^${expression}(?:[-\\.].*?)?$`);
    const validFileName = filenameValidationRegex.test(spriteName);
    return validFileName;
}

async function onClickExpressionUpload(event) {
    // Prevents the expression from being set
    event.stopPropagation();

    const expressionListItem = $(this).closest('.expression_list_item');

    const clickedFileName = expressionListItem.attr('data-expression-type') !== 'failure' ? expressionListItem.attr('data-filename') : null;
    const expression = expressionListItem.data('expression');
    const name = $('#image_list').data('name');

    const handleExpressionUploadChange = async (e) => {
        const file = e.target.files[0];

        if (!file || !file.name) {
            console.debug('No valid file selected');
            return;
        }

        const existingFiles = spriteCache[name]?.find(x => x.label === expression)?.files || [];

        let spriteName = expression;

        if (extension_settings.expressions.allowMultiple) {
            const matchesExisting = existingFiles.some(x => x.fileName === file.name);
            const fileNameWithoutExtension = withoutExtension(file.name);
            const validFileName = validateExpressionSpriteName(expression, fileNameWithoutExtension);

            if (!clickedFileName && validFileName) {
                // If there is no expression yet and it's a valid expression, we just take it
                spriteName = fileNameWithoutExtension;
            } else if (clickedFileName === file.name) {
                // If the filename matches the one that was clicked, we just take it and replace it
                spriteName = fileNameWithoutExtension;
            } else if (!matchesExisting && validFileName) {
                // If it's a valid filename and there's no existing file with the same name, we just take it
                spriteName = fileNameWithoutExtension;
            } else {
                /** @type {import('../../popup.js').CustomPopupButton[]} */
                const customButtons = [];
                if (clickedFileName) {
                    customButtons.push({
                        text: t`Replace Existing`,
                        result: POPUP_RESULT.NEGATIVE,
                        action: () => {
                            console.debug('Replacing existing sprite');
                            spriteName = withoutExtension(clickedFileName);
                        },
                    });
                }

                spriteName = null;
                const suggestedSpriteName = generateUniqueSpriteName(expression, existingFiles);

                const message = await renderExtensionTemplateAsync(MODULE_NAME, 'templates/upload-expression', { expression, clickedFileName });

                const input = await Popup.show.input(t`Upload Expression Sprite`, message,
                    suggestedSpriteName, { customButtons: customButtons });

                if (input) {
                    if (!validateExpressionSpriteName(expression, input)) {
                        toastr.warning(t`The name you entered does not follow the naming schema for the selected expression '${expression}'.`, t`Invalid Expression Sprite Name`);
                        return;
                    }
                    spriteName = input;
                }
            }
        } else {
            spriteName = withoutExtension(expression);
        }

        if (!spriteName) {
            toastr.warning(t`Cancelled uploading sprite.`, t`Upload Cancelled`);
            // Reset the input
            e.target.form.reset();
            return;
        }

        const formData = new FormData();
        formData.append('name', name);
        formData.append('label', expression);
        formData.append('avatar', file);
        formData.append('spriteName', spriteName);

        await handleFileUpload('/api/sprites/upload', formData);

        // Reset the input
        e.target.form.reset();
    };

    $('#expression_upload')
        .off('change')
        .on('change', handleExpressionUploadChange)
        .trigger('click');
}

async function onClickExpressionOverrideButton() {
    const context = getContext();
    const currentLastMessage = getLastCharacterMessage();
    const target = captureExpressionTarget(currentLastMessage);
    rememberExpressionMessage(currentLastMessage);
    const avatarFileName = getFolderNameByMessage(currentLastMessage);

    // If the avatar name couldn't be found, abort.
    if (!avatarFileName) {
        console.debug(`Could not find filename for character with name ${currentLastMessage.name} and ID ${context.characterId}`);

        return;
    }

    const overridePath = String($('#expression_override').val());
    const existingOverrideIndex = extension_settings.expressionOverrides.findIndex((e) =>
        e.name == avatarFileName,
    );

    // If the path is empty, delete the entry from overrides
    if (overridePath === undefined || overridePath.length === 0) {
        if (existingOverrideIndex === -1) {
            return;
        }

        extension_settings.expressionOverrides.splice(existingOverrideIndex, 1);
        console.debug(`Removed existing override for ${avatarFileName}`);
    } else {
        // Properly override objects and clear the sprite cache of the previously set names
        const existingOverride = extension_settings.expressionOverrides[existingOverrideIndex];
        if (existingOverride) {
            Object.assign(existingOverride, { path: overridePath });
            delete spriteCache[existingOverride.name];
        } else {
            const characterOverride = { name: avatarFileName, path: overridePath };
            extension_settings.expressionOverrides.push(characterOverride);
            delete spriteCache[currentLastMessage.name];
        }

        console.debug(`Added/edited expression override for character with filename ${avatarFileName} to folder ${overridePath}`);
    }

    saveSettingsDebounced();

    // Refresh sprites list. Assume the override path has been properly handled.
    try {
        inApiCall = true;
        $('#visual-novel-wrapper').empty();
        await validateImages(overridePath.length === 0 ? currentLastMessage.name : overridePath, true);
        const name = overridePath.length === 0 ? currentLastMessage.name : overridePath;
        const expression = await getExpressionLabel(currentLastMessage.mes, extension_settings.expressions.api, { target });
        await sendExpressionCall(name, expression, { force: true, target });
        forceUpdateVisualNovelMode();
    } catch (error) {
        console.debug(`Setting expression override for ${avatarFileName} failed with error: ${error}`);
    } finally {
        inApiCall = false;
    }
}

async function onClickExpressionOverrideRemoveAllButton() {
    // Remove all the overrided entries from sprite cache
    for (const element of extension_settings.expressionOverrides) {
        delete spriteCache[element.name];
    }

    extension_settings.expressionOverrides = [];
    saveSettingsDebounced();

    console.debug('All expression image overrides have been cleared.');

    // Refresh sprites list to use the default name if applicable
    try {
        $('#visual-novel-wrapper').empty();
        const currentLastMessage = getLastCharacterMessage();
        const target = captureExpressionTarget(currentLastMessage);
        rememberExpressionMessage(currentLastMessage);
        await validateImages(currentLastMessage.name, true);
        const expression = await getExpressionLabel(currentLastMessage.mes, extension_settings.expressions.api, { target });
        await sendExpressionCall(currentLastMessage.name, expression, { force: true, target });
        forceUpdateVisualNovelMode();

        console.debug(extension_settings.expressionOverrides);
    } catch (error) {
        console.debug(`The current expression could not be set because of error: ${error}`);
    }
}

async function onClickExpressionUploadPackButton() {
    const name = $('#image_list').data('name');

    const handleFileUploadChange = async (e) => {
        const file = e.target.files[0];

        if (!file) {
            return;
        }

        const formData = new FormData();
        formData.append('name', name);
        formData.append('avatar', file);

        const uploadToast = toastr.info('Please wait...', 'Upload is processing', { timeOut: 0, extendedTimeOut: 0 });
        const { count } = (await handleFileUpload('/api/sprites/upload-zip', formData)) ?? {};
        toastr.clear(uploadToast);

        // Only show success message if at least one image was uploaded
        if (count) {
            toastr.success(`Uploaded ${count} image(s) for ${name}`);
        }

        // Reset the input
        e.target.form.reset();
    };

    $('#expression_upload_pack')
        .off('change')
        .on('change', handleFileUploadChange)
        .trigger('click');
}

async function onClickExpressionDelete(event) {
    // Prevents the expression from being set
    event.stopPropagation();

    const expressionListItem = $(this).closest('.expression_list_item');
    const expression = expressionListItem.data('expression');

    if (expressionListItem.attr('data-expression-type') === 'failure') {
        return;
    }

    const confirmation = await Popup.show.confirm(t`Delete Expression`, t`Are you sure you want to delete this expression? Once deleted, it\'s gone forever!`
        + '<br /><br />'
        + t`Expression:` + ' <tt>' + expressionListItem.attr('data-filename') + '</tt>');
    if (!confirmation) {
        return;
    }

    const fileName = withoutExtension(expressionListItem.attr('data-filename'));
    const name = $('#image_list').data('name');

    try {
        await deleteExpressionSpriteFile(name, expression, fileName);
    } catch (error) {
        toastr.error('Failed to delete image. Try again later.');
    }

    // Refresh sprites list
    delete spriteCache[name];
    await fetchImagesNoCache();
    await validateImages(name);
}

function setExpressionOverrideHtml(forceClear = false) {
    const currentLastMessage = getLastCharacterMessage();
    const avatarFileName = getFolderNameByMessage(currentLastMessage);
    if (!avatarFileName) {
        return;
    }

    const expressionOverride = extension_settings.expressionOverrides.find((e) =>
        e.name == avatarFileName,
    );

    if (expressionOverride && expressionOverride.path) {
        $('#expression_override').val(expressionOverride.path);
    } else if (expressionOverride) {
        delete extension_settings.expressionOverrides[expressionOverride.name];
    }

    if (forceClear && !expressionOverride) {
        $('#expression_override').val('');
    }
}

async function fetchImagesNoCache() {
    const promises = [];
    $('#image_list img').each(function () {
        const src = $(this).attr('src');

        if (!src) {
            return;
        }

        const promise = fetch(src, {
            method: 'GET',
            cache: 'no-cache',
            headers: {
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Expires': '0',
            },
        });
        promises.push(promise);
    });

    return await Promise.allSettled(promises);
}

function migrateSettings() {
    if (Number(extension_settings.expressions.api) === 1) {
        extension_settings.expressions.api = EXPRESSION_API.none;
        saveSettingsDebounced();
    }

    if (extension_settings.expressions.api === undefined) {
        extension_settings.expressions.api = EXPRESSION_API.none;
        saveSettingsDebounced();
    }

    if (Object.keys(extension_settings.expressions).includes('local')) {
        if (extension_settings.expressions.local) {
            extension_settings.expressions.api = EXPRESSION_API.local;
        }

        delete extension_settings.expressions.local;
        saveSettingsDebounced();
    }

    if (extension_settings.expressions.llmPrompt === undefined) {
        extension_settings.expressions.llmPrompt = DEFAULT_LLM_PROMPT;
        saveSettingsDebounced();
    }

    if (extension_settings.expressions.allowMultiple === undefined) {
        extension_settings.expressions.allowMultiple = true;
        saveSettingsDebounced();
    }

    if (extension_settings.expressions.showDefault && extension_settings.expressions.fallback_expression) {
        extension_settings.expressions.showDefault = false;
        saveSettingsDebounced();
    }

    if (extension_settings.expressions.promptType === undefined) {
        extension_settings.expressions.promptType = PROMPT_TYPE.raw;
        saveSettingsDebounced();
    }

    if (extension_settings.expressions.agentAutoGenerateSprites === undefined) {
        extension_settings.expressions.agentAutoGenerateSprites = false;
        saveSettingsDebounced();
    }

    if (extension_settings.expressions.agentUseQigLlmProfile === undefined) {
        extension_settings.expressions.agentUseQigLlmProfile = false;
        saveSettingsDebounced();
    }

    if (!Object.values(EXPRESSION_SPRITE_FRAMING).includes(extension_settings.expressions.agentSpriteFraming)) {
        extension_settings.expressions.agentSpriteFraming = DEFAULT_EXPRESSION_SPRITE_FRAMING;
        saveSettingsDebounced();
    }

    if (!Object.values(EXPRESSION_SPRITE_GENERATION_MODE).includes(extension_settings.expressions.agentSpriteGenerationMode)) {
        extension_settings.expressions.agentSpriteGenerationMode = DEFAULT_EXPRESSION_SPRITE_GENERATION_MODE;
        saveSettingsDebounced();
    }

    if (typeof extension_settings.expressions.agentSpriteRemoveBackground !== 'boolean') {
        extension_settings.expressions.agentSpriteRemoveBackground = DEFAULT_EXPRESSION_SPRITE_REMOVE_BACKGROUND;
        saveSettingsDebounced();
    }

    const previousDefaultSpritePrompt = DEFAULT_EXPRESSION_SPRITE_PROMPT.replace(
        'true transparent background.\nIf true alpha transparency is unavailable, use flat pure white only. Never draw a checkerboard or transparency grid.',
        'transparent background.',
    );
    const previousPlainBackgroundDefaultSpritePrompt = previousDefaultSpritePrompt.replace('transparent background.', 'plain white or transparent background.');
    if (extension_settings.expressions.agentSpritePrompt === undefined
        || extension_settings.expressions.agentSpritePrompt === LEGACY_DEFAULT_EXPRESSION_SPRITE_PROMPT
        || extension_settings.expressions.agentSpritePrompt === previousDefaultSpritePrompt
        || extension_settings.expressions.agentSpritePrompt === previousPlainBackgroundDefaultSpritePrompt) {
        extension_settings.expressions.agentSpritePrompt = DEFAULT_EXPRESSION_SPRITE_PROMPT;
        saveSettingsDebounced();
    }
}

export async function init() {
    function addExpressionImage() {
        const html = `
        <div id="expression-wrapper">
            <div id="expression-holder" class="expression-holder" style="display:none;">
                <div id="expression-holderheader" class="fa-solid fa-grip drag-grabber"></div>
                <img id="expression-image" class="expression">
            </div>
        </div>`;
        $('body').append(html);
        loadMovingUIState();
    }
    function addVisualNovelMode() {
        const html = `
        <div id="visual-novel-wrapper">
        </div>`;
        const element = $(html);
        element.hide();
        $('body').append(element);
    }
    async function addSettings() {
        const template = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
        $('#expressions_container').append(template);
        $('#expression_override_button').on('click', onClickExpressionOverrideButton);
        $('#expression_upload_pack_button').on('click', onClickExpressionUploadPackButton);
        $('#expressions_generate_missing_sprites')
            .on('click', onClickGenerateMissingSprites)
            .on('keydown', onExpressionGenerationKeydown);
        $('#expressions_upload_sprite_sheet')
            .on('click', onClickUploadSpriteSheet)
            .on('keydown', onExpressionGenerationKeydown);
        $('#expressions_redo_sprite_cleanup')
            .on('click', onClickRedoSpriteCleanup)
            .on('keydown', onExpressionGenerationKeydown);
        $('#expressions_stop_sprite_generation')
            .on('click', onClickStopExpressionGeneration)
            .on('keydown', onExpressionGenerationKeydown);
        $('#expressions_remove_all_sprites')
            .on('click', onClickRemoveAllSprites)
            .on('keydown', onExpressionGenerationKeydown);
        setExpressionGenerationBusy(inSpriteGeneration);
        $('#expression_translate').prop('checked', extension_settings.expressions.translate).on('input', function () {
            extension_settings.expressions.translate = !!$(this).prop('checked');
            saveSettingsDebounced();
        });
        $('#expressions_allow_multiple').prop('checked', extension_settings.expressions.allowMultiple).on('input', function () {
            extension_settings.expressions.allowMultiple = !!$(this).prop('checked');
            saveSettingsDebounced();
        });
        $('#expressions_reroll_if_same').prop('checked', extension_settings.expressions.rerollIfSame).on('input', function () {
            extension_settings.expressions.rerollIfSame = !!$(this).prop('checked');
            saveSettingsDebounced();
        });
        $('#expressions_filter_available').prop('checked', extension_settings.expressions.filterAvailable).on('input', function () {
            extension_settings.expressions.filterAvailable = !!$(this).prop('checked');
            saveSettingsDebounced();
        });
        $('#expression_override_cleanup_button').on('click', onClickExpressionOverrideRemoveAllButton);
        $(document).on('dragstart', '.expression', (e) => {
            e.preventDefault();
            return false;
        });
        $(document).on('click', '.expression_list_item', onClickExpressionImage);
        $(document).on('click', '.expression_list_upload', onClickExpressionUpload);
        $(document).on('click', '.expression_list_generate', onClickExpressionGenerate);
        $(document).on('click', '.expression_list_regenerate', onClickExpressionRegenerate);
        $(document).on('keydown', '.expression_list_generate', onExpressionGenerationKeydown);
        $(document).on('keydown', '.expression_list_regenerate', onExpressionGenerationKeydown);
        $(document).on('click', '.expression_list_delete', onClickExpressionDelete);
        $(window).on('resize', () => updateVisualNovelModeDebounced());
        $('#open_chat_expressions').hide();

        await renderAdditionalExpressionSettings();
        $('#expression_api').val(extension_settings.expressions.api ?? EXPRESSION_API.none);
        $('.expression_llm_prompt_block').toggle([EXPRESSION_API.llm, EXPRESSION_API.webllm].includes(extension_settings.expressions.api));
        $('.expression_agent_block').toggle(extension_settings.expressions.api === EXPRESSION_API.agent);
        $('#expressions_agent_auto_generate_sprites')
            .prop('checked', extension_settings.expressions.agentAutoGenerateSprites)
            .on('input', function () {
                extension_settings.expressions.agentAutoGenerateSprites = !!$(this).prop('checked');
                if (extension_settings.expressions.agentAutoGenerateSprites && extension_settings.expressions.api !== EXPRESSION_API.agent) {
                    $('#expression_api').val(EXPRESSION_API.agent).trigger('change');
                    toastr.info(t`Classifier API switched to In-Chat Agent for expression auto-generation.`, t`Expressions Agent`);
                    return;
                }
                saveSettingsDebounced();
            });
        $('#expressions_agent_use_qig_llm_profile')
            .prop('checked', extension_settings.expressions.agentUseQigLlmProfile)
            .on('input', function () {
                extension_settings.expressions.agentUseQigLlmProfile = !!$(this).prop('checked');
                saveSettingsDebounced();
            });
        $('#expressions_agent_sprite_generation_mode')
            .val(getExpressionSpriteGenerationMode())
            .on('change', function () {
                const mode = String($(this).val() || '');
                extension_settings.expressions.agentSpriteGenerationMode = Object.values(EXPRESSION_SPRITE_GENERATION_MODE).includes(mode)
                    ? mode
                    : DEFAULT_EXPRESSION_SPRITE_GENERATION_MODE;
                saveSettingsDebounced();
            });
        $('#expressions_agent_sprite_framing')
            .val(extension_settings.expressions.agentSpriteFraming)
            .on('change', function () {
                const framing = String($(this).val() || '');
                extension_settings.expressions.agentSpriteFraming = Object.values(EXPRESSION_SPRITE_FRAMING).includes(framing)
                    ? framing
                    : DEFAULT_EXPRESSION_SPRITE_FRAMING;
                saveSettingsDebounced();
            });
        $('#expressions_agent_sprite_remove_background')
            .prop('checked', !!extension_settings.expressions.agentSpriteRemoveBackground)
            .on('input', function () {
                extension_settings.expressions.agentSpriteRemoveBackground = !!$(this).prop('checked');
                saveSettingsDebounced();
            });
        $('#expressions_agent_sprite_prompt')
            .val(extension_settings.expressions.agentSpritePrompt || DEFAULT_EXPRESSION_SPRITE_PROMPT)
            .on('input', function () {
                extension_settings.expressions.agentSpritePrompt = String($(this).val());
                saveSettingsDebounced();
            });
        $('#expressions_agent_sprite_prompt_restore').on('click', function () {
            $('#expressions_agent_sprite_prompt').val(DEFAULT_EXPRESSION_SPRITE_PROMPT).trigger('input');
        });
        updateExpressionsAgentStatus();
        $('#expression_llm_prompt').val(extension_settings.expressions.llmPrompt ?? '');
        $('#expression_llm_prompt').on('input', function () {
            extension_settings.expressions.llmPrompt = String($(this).val());
            saveSettingsDebounced();
        });
        $('#expression_llm_prompt_restore').on('click', function () {
            $('#expression_llm_prompt').val(DEFAULT_LLM_PROMPT);
            extension_settings.expressions.llmPrompt = DEFAULT_LLM_PROMPT;
            saveSettingsDebounced();
        });
        $('#expression_prompt_raw').on('input', function () {
            extension_settings.expressions.promptType = PROMPT_TYPE.raw;
            saveSettingsDebounced();
        });
        $('#expression_prompt_full').on('input', function () {
            extension_settings.expressions.promptType = PROMPT_TYPE.full;
            saveSettingsDebounced();
        });
        $(`input[name="expression_prompt_type"][value="${extension_settings.expressions.promptType}"]`).prop('checked', true);
        $('.expression_prompt_type_block').toggle(extension_settings.expressions.api === EXPRESSION_API.llm);

        $('#expression_custom_add').on('click', onClickExpressionAddCustom);
        $('#expression_custom_remove').on('click', onClickExpressionRemoveCustom);
        $('#expression_fallback').on('change', onExpressionFallbackChanged);
        $('#expression_api').on('change', onExpressionApiChanged);
    }

    addExpressionImage();
    addVisualNovelMode();
    migrateSettings();
    await addSettings();
    seedExpressionHistory();
    const wrapper = new ModuleWorkerWrapper(moduleWorker);
    const updateFunction = wrapper.update.bind(wrapper);
    eventSource.on('in_chat_agent_companion_results_updated', event => onAgentExpressionUpdated(event, updateFunction));
    setInterval(updateFunction, UPDATE_INTERVAL);
    moduleWorker();
    dragElement($('#expression-holder'));
    eventSource.on(event_types.CHAT_CHANGED, () => {
        seedExpressionHistory();
        // character changed
        removeExpression();
        spriteCache = {};
        lastExpression = {};
        cleanupExpressionAgentSpinner();

        //clear expression
        let imgElement = document.getElementById('expression-image');
        if (imgElement && imgElement instanceof HTMLImageElement) {
            imgElement.src = '';
        }

        setExpressionOverrideHtml(true); // force-clear, as the character might not have an override defined

        if (isVisualNovelMode()) {
            $('#visual-novel-wrapper').empty();
        }

        updateFunction({ newChat: true });
        void restoreExpressionHistory();
    });
    eventSource.on(event_types.MESSAGE_SWIPED, messageId => {
        const message = getContext().chat[messageId];
        if (message?.swipes?.[message.swipe_id] === message.mes && message.mes !== '...') {
            rememberExpressionMessage(message);
            void restoreExpressionHistory();
        }
    });
    document.addEventListener('sb:chat-style-updated', () => void restoreExpressionHistory());
    eventSource.on(event_types.MOVABLE_PANELS_RESET, updateVisualNovelModeDebounced);
    eventSource.on(event_types.GROUP_UPDATED, updateVisualNovelModeDebounced);
    // Refresh the agent status when settings change (e.g. the user enables the
    // Expressions Agent template in In-Chat Agents after this panel was opened).
    eventSource.on(event_types.SETTINGS_UPDATED, () => {
        if (extension_settings.expressions.api === EXPRESSION_API.agent) {
            updateExpressionsAgentStatus();
        }
    });

    const localEnumProviders = {
        expressions: () => {
            const currentLastMessage = selected_group ? getLastCharacterMessage() : null;
            const spriteFolderName = getSpriteFolderName(currentLastMessage, currentLastMessage?.name);
            const expressions = getCachedExpressions();
            return expressions.map(expression => {
                const spriteCount = spriteCache[spriteFolderName]?.find(x => x.label === expression)?.files.length ?? 0;
                const isCustom = extension_settings.expressions.custom?.includes(expression);
                const subtitle = spriteCount == 0 ? '❌ No sprites available for this expression' :
                    spriteCount > 1 ? `${spriteCount} sprites` : null;
                return new SlashCommandEnumValue(expression,
                    subtitle,
                    isCustom ? enumTypes.name : enumTypes.enum,
                    isCustom ? 'C' : 'D');
            });
        },
        sprites: () => {
            const currentLastMessage = selected_group ? getLastCharacterMessage() : null;
            const spriteFolderName = getSpriteFolderName(currentLastMessage, currentLastMessage?.name);
            const sprites = spriteCache[spriteFolderName]?.map(x => x.files)?.flat() ?? [];
            return sprites.map(x => {
                return new SlashCommandEnumValue(x.title,
                    x.title !== x.expression ? x.expression : null,
                    x.isCustom ? enumTypes.name : enumTypes.enum,
                    x.isCustom ? 'C' : 'D');
            });
        },
    };

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'expression-set',
        aliases: ['sprite', 'emote'],
        callback: setSpriteSlashCommand,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'type',
                description: 'Whether to set an expression or a specific sprite.',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'expression',
                enumList: ['expression', 'sprite'],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'expression label to set',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: (executor, _) => {
                    // Check if command is used to set a sprite, then use those enums
                    const type = executor.namedArgumentList.find(it => it.name == 'type')?.value || 'expression';
                    if (type == 'sprite') return localEnumProviders.sprites();
                    else return [
                        ...localEnumProviders.expressions(),
                        new SlashCommandEnumValue(RESET_SPRITE_LABEL, 'Resets the expression (to either default or no sprite)', enumTypes.enum, '❌'),
                    ];
                },
            }),
        ],
        helpString: 'Force sets the expression for the current character.',
        returns: 'The currently set expression label after setting it.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'expression-fallback',
        callback: setFallBackExpressionSlashCommand,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'expression label to set',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumProvider: () => [
                    new SlashCommandEnumValue('#none', 'Sets the fallback expression to no image'),
                    new SlashCommandEnumValue('#emoji', 'Sets the fallback expression to emojis'),
                    ...localEnumProviders.expressions(),
                ],
            }),
        ],
        helpString: `
            <div>
                Gets the currently selected expression fallback for all characters.<br />
                If a valid expression label is sent, it will be set as the new fallback.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/expression-fallback | /echo</code></pre>
                        <small>Returns the currently selected fallback.</small>
                    </li>
                    <li>
                        <pre><code>/expression-fallback admiration</code></pre>
                        <small>Sets a new expression as fallback.</small>
                    </li>
                </ul>
            </div>
        `,
        returns: 'The currently set expression label after setting it.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'expression-folder-override',
        aliases: ['spriteoverride', 'costume'],
        callback: setSpriteFolderCommand,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'Character name to set a subfolder for. If not provided, the character who last sent a message will be used.',
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: commonEnumProviders.characters('character'),
                isRequired: false,
                acceptsMultiple: false,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'optional folder', [ARGUMENT_TYPE.STRING], false,
            ),
        ],
        helpString: `
            <div>
                Sets an override sprite folder for the current character.<br />
                In groups, this will apply to the character who last sent a message.
            </div>
            <div>
                If the name starts with a slash or a backslash, selects a sub-folder in the character-named folder. Empty value to reset to default.
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'expression-last',
        aliases: ['lastsprite'],
        /** @type {(args: object, name: string) => Promise<string>} */
        callback: async (_, name) => {
            if (typeof name !== 'string') throw new Error('name must be a string');
            if (!name) {
                if (selected_group) {
                    toastr.error(t`In group chats, you must specify a character name.`, t`No character name specified`);
                    return '';
                }
                name = characters[this_chid]?.avatar;
            }

            const char = findChar({ name: name });
            if (!char) toastr.warning(t`Couldn't find character ${name}.`, t`Character not found`);

            const sprite = lastExpression[char?.name ?? name] ?? '';
            return sprite;
        },
        returns: 'the last set expression for the named character.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Character name - or unique character identifier (avatar key). If not provided, the current character for this chat will be used (does not work in group chats)',
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: commonEnumProviders.characters('character'),
            }),
        ],
        helpString: 'Returns the last set expression for the named character.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'expression-list',
        aliases: ['expressions'],
        /** @type {(args: {return: string, filter: string}) => Promise<string>} */
        callback: async (args) => {
            let returnType =
                /** @type {import('../../slash-commands/SlashCommandReturnHelper.js').SlashCommandReturnType} */
                (args.return);

            const list = await getExpressionsList({ filterAvailable: !isFalseBoolean(args.filter) });

            return await slashCommandReturnHelper.doReturn(returnType ?? 'pipe', list, { objectToStringFunc: list => list.join(', ') });
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'return',
                description: 'The way how you want the return value to be provided',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'pipe',
                enumList: slashCommandReturnHelper.enumList({ allowObject: true }),
                forceEnum: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'filter',
                description: 'Filter the list to only include expressions that have available sprites for the current character.',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'true',
            }),
        ],
        returns: 'The comma-separated list of available expressions, including custom expressions.',
        helpString: 'Returns a list of available expressions, including custom expressions.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'expression-classify',
        aliases: ['classify'],
        callback: classifyCallback,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'api',
                description: 'The Classifier API to classify with. If not specified, the configured one will be used.',
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: Object.keys(EXPRESSION_API).map(api => new SlashCommandEnumValue(api, null, enumTypes.enum)),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'filter',
                description: 'Filter the list to only include expressions that have available sprites for the current character.',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'true',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'prompt',
                description: 'Custom prompt for classification. Only relevant if Classifier API is set to LLM.',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'text', [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        returns: 'emotion classification label for the given text',
        helpString: `
            <div>
                Performs an emotion classification of the given text and returns a label.
            </div>
            <div>
                Allows to specify which Classifier API to perform the classification with.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/classify I am so happy today!</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'expression-upload',
        aliases: ['uploadsprite'],
        /** @type {(args: {name: string, label: string, folder: string?, spriteName: string?}, url: string) => Promise<string>} */
        callback: async (args, url) => {
            return await uploadSpriteCommand(args, url);
        },
        returns: 'the resulting sprite name',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'URL of the image to upload',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: 'Character name or avatar key (default is current character)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'label',
                description: 'Sprite label/expression name',
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: localEnumProviders.expressions,
                isRequired: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'folder',
                description: 'Override folder to upload into',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'spriteName',
                description: 'Override sprite name to allow multiple sprites per expressions. Has to follow the naming pattern. If unspecified, the label will be used as sprite name.',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: `
            <div>
                Upload a sprite from a URL.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/uploadsprite name=Mira label=joy /user/images/Mira/joy.png</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));

    const getAvailableExpressionsList = (includeMissing = false) => {
        const expressions = getCachedExpressions();

        if (includeMissing && extension_settings.expressions.agentAutoGenerateSprites) {
            return expressions.length ? expressions : [...DEFAULT_EXPRESSIONS, ...(extension_settings.expressions.custom ?? [])].filter(onlyUnique);
        }

        const currentLastMessage = selected_group ? getLastCharacterMessage() : null;
        const spriteFolderName = getSpriteFolderName(currentLastMessage, currentLastMessage?.name);

        if (!spriteCache[spriteFolderName] || expressions.length === 0) {
            return expressions.length === 0 ? DEFAULT_EXPRESSIONS : expressions;
        }

        const available = expressions.filter(label => {
            const expression = spriteCache[spriteFolderName]?.find(x => x.label === label);
            return (expression?.files.length ?? 0) > 0;
        });

        if (available.length === 0) {
            return expressions;
        }
        return available;
    };

    MacrosParser.registerMacro('availableSprites', () => {
        return getAvailableExpressionsList().join(', ');
    }, 'Returns a comma-separated list of expressions that have available sprites for the current character.');

    MacrosParser.registerMacro('availableExpressions', () => {
        return getAvailableExpressionsList(true).join(', ');
    }, 'Returns expression labels, including missing sprites when automatic sprite generation is enabled.');
}
