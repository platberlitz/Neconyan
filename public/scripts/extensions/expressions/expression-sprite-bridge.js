/**
 * Non-blocking bridge from the Expressions extension to Quick Image Gen.
 *
 * SillyBunny divergence: QIG is vendored from an upstream repo, so this file lives
 * outside `quick-image-gen/` and discovers its activated runtime capability.
 * This avoids loading a disabled or second URL identity of the QIG entrypoint.
 */

import { getExtensionCapability } from '../../neconyan-conversation/extension-capabilities.js';
import { buildExpressionSpritePrompt, buildExpressionSpriteSheetPrompt, EXPRESSION_SPRITE_NEGATIVE, getExpressionSpriteSheetGrid } from './sprite-prompts.js';

const SPINNER_ID = 'expression-agent-spinner';

let activeGenerationAbortController = null;
let activeGenerationSerial = 0;

function beginExpressionGenerationRequest() {
    activeGenerationAbortController = new AbortController();
    activeGenerationSerial += 1;
    return {
        controller: activeGenerationAbortController,
        serial: activeGenerationSerial,
    };
}

function endExpressionGenerationRequest(serial) {
    if (serial === activeGenerationSerial) {
        activeGenerationAbortController = null;
    }
}

async function waitForQigReadiness(qig, signal) {
    if (signal.aborted) throw signal.reason;
    let abort;
    const aborted = new Promise((_, reject) => {
        abort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
    });
    try {
        await Promise.race([qig.ensureReady(), aborted]);
    } finally {
        signal.removeEventListener('abort', abort);
    }
}

async function runWithQigCapability(task) {
    const qig = getExtensionCapability('quick-image-gen');
    if (!qig) {
        console.debug('[Expression Sprite Bridge] Quick Image Gen is not active');
        return null;
    }

    const generationRequest = beginExpressionGenerationRequest();
    try {
        await waitForQigReadiness(qig, generationRequest.controller.signal);
        return await task(qig, generationRequest.controller.signal);
    } finally {
        endExpressionGenerationRequest(generationRequest.serial);
    }
}

/**
 * Abort the active Expressions Agent QIG request, if one is running.
 * @returns {boolean} True when a running request was asked to stop.
 */
export function stopExpressionSpriteGeneration() {
    if (!activeGenerationAbortController || activeGenerationAbortController.signal.aborted) return false;

    activeGenerationAbortController.abort();
    hideSpinner();
    return true;
}

/**
 * Find or create a small inline spinner inside the expression holder.
 * @returns {HTMLElement|null}
 */
function getSpinner() {
    let spinner = document.getElementById(SPINNER_ID);
    if (!spinner) {
        const holder = document.getElementById('expression-holder');
        if (!holder) return null;
        spinner = document.createElement('div');
        spinner.id = SPINNER_ID;
        spinner.className = 'expression_agent_spinner';
        spinner.title = 'Generating missing sprite…';
        holder.appendChild(spinner);
    }
    return spinner;
}

function showSpinner() {
    const spinner = getSpinner();
    if (spinner) spinner.classList.add('active');
}

function hideSpinner() {
    const spinner = document.getElementById(SPINNER_ID);
    if (spinner) spinner.classList.remove('active');
}

function removeSpinner() {
    const spinner = document.getElementById(SPINNER_ID);
    if (spinner) spinner.remove();
}

/**
 * Generate a character sprite for the given expression using Quick Image Gen.
 * This call is intentionally independent of QIG's global `isGenerating` flag so
 * that expression sprite creation never blocks or is blocked by manual QIG usage.
 *
 * @param {string} expression - The expression label (e.g. "joy").
 * @param {object} promptContext - Character prompt context.
 * @param {string} promptContext.characterName - The character name to seed the prompt.
 * @param {string} [promptContext.characterCard] - Character card details to preserve in the prompt.
 * @param {string} [promptContext.framing] - Desired sprite framing.
 * @param {string} [promptContext.promptTemplate] - Editable prompt template sent to Quick Image Gen.
 * @returns {Promise<string|null>} URL/data-URI of the generated image, or null on failure.
 */
export async function generateExpressionSprite(expression, promptContext) {
    if (!expression || !promptContext?.characterName) return null;

    showSpinner();

    try {
        return await runWithQigCapability(async (qig, signal) => {
            const qigSettings = qig.getSettingsSnapshot();
            const prompt = buildExpressionSpritePrompt(expression, promptContext);
            const negative = [qigSettings?.negativePrompt, EXPRESSION_SPRITE_NEGATIVE].filter(Boolean).join(', ');
            const entry = await qig.generateImage(prompt, negative, { signal });
            return entry?.url || null;
        });
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        console.error('[Expression Sprite Bridge] Failed to generate sprite:', error);
        return null;
    } finally {
        hideSpinner();
    }
}

/**
 * Generate a character expression sprite sheet using Quick Image Gen.
 * @param {string[]} expressions - Expression labels in desired sheet order.
 * @param {object} promptContext - Character prompt context.
 * @param {string} promptContext.characterName - The character name to seed the prompt.
 * @param {string} [promptContext.characterCard] - Character card details to preserve in the prompt.
 * @param {string} [promptContext.framing] - Desired sprite framing.
 * @param {string} [promptContext.promptTemplate] - Editable prompt template sent to Quick Image Gen.
 * @returns {Promise<{imageUrl: string, grid: {columns: number, rows: number}}|null>} Generated sheet and grid metadata.
 */
export async function generateExpressionSpriteSheet(expressions, promptContext) {
    const labels = Array.isArray(expressions) ? expressions.filter(Boolean) : [];
    if (labels.length === 0 || !promptContext?.characterName) return null;

    showSpinner();

    try {
        return await runWithQigCapability(async (qig, signal) => {
            const qigSettings = qig.getSettingsSnapshot();
            const grid = getExpressionSpriteSheetGrid(labels.length);
            const prompt = buildExpressionSpriteSheetPrompt(labels, promptContext, grid);
            const negative = [qigSettings?.negativePrompt, EXPRESSION_SPRITE_NEGATIVE].filter(Boolean).join(', ');
            const entry = await qig.generateImage(prompt, negative, { signal });
            return entry?.url ? { imageUrl: entry.url, grid } : null;
        });
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        console.error('[Expression Sprite Bridge] Failed to generate sprite sheet:', error);
        return null;
    } finally {
        hideSpinner();
    }
}

/**
 * Remove the inline spinner if it is still present. Safe to call on chat changes.
 */
export function cleanupExpressionSpriteSpinner() {
    removeSpinner();
}
