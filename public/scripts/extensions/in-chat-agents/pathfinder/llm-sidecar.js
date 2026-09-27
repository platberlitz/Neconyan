import { generateRaw } from '../../../../script.js';
import { isAbortLikeError } from '../../../util/abort-error.js';
import { extractProfileResponseText } from '../llm-utils.js';
import { runAsInternalPromptTransform } from '../agent-runner.js';
import { getSettings } from './tree-store.js';
import { getRetrievalOutputLimit } from './retrieval-budget.js';
import { isGenerationLengthFinish } from '../../../generation-request-controls.js';

// Throttled so a multi-stage pipeline failure doesn't stack toasts
let lastSidecarIssueToastAt = 0;
function notifySidecarIssue(message, level = 'warning') {
    const now = Date.now();
    if (now - lastSidecarIssueToastAt < 60000) {
        return;
    }
    lastSidecarIssueToastAt = now;
    globalThis.toastr?.[level]?.(message, 'Pawthfinder sidecar');
}

/**
 * Generate using the default connection profile from settings
 * @param {string} prompt - User prompt
 * @param {string} [systemPrompt=''] - System prompt
 * @returns {Promise<string>}
 */
export async function sidecarGenerate(prompt, systemPrompt = '', signal = null) {
    const s = getSettings();
    const profileId = s.connectionProfile ?? '';
    return sidecarGenerateWithProfile(prompt, systemPrompt, profileId, 2048, signal);
}

function knownReplyError(message) {
    return Object.assign(new Error(message), { knownReply: true });
}

function isUnknownSidecarOutcome(error) {
    if (error?.knownReply) return false;
    const status = Number(error?.status ?? error?.response?.status ?? error?.cause?.status);
    if (!Number.isInteger(status)) return true;
    return status === 408 || (status >= 500 && status !== 503 && status !== 529);
}

/**
 * Generate using a specific connection profile
 * @param {string} prompt - User prompt
 * @param {string} [systemPrompt=''] - System prompt
 * @param {string} [profileId=''] - Connection profile ID (empty = use default/main model)
 * @param {number} [maxTokens=2048] - Maximum tokens for response
 * @param {AbortSignal?} [signal=null] - Optional abort signal
 * @returns {Promise<string>}
 */
export async function sidecarGenerateWithProfile(prompt, systemPrompt = '', profileId = '', maxTokens = 2048, signal = null, { temperature } = {}) {
    signal?.throwIfAborted();
    const ctx = window?.SillyTavern?.getContext?.();

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });
    const temperatureOverride = Number.isFinite(temperature) ? { temperature } : {};

    // Try specified profile first
    if (ctx?.ConnectionManagerRequestService && profileId) {
        const CMRS = ctx.ConnectionManagerRequestService;
        const outputLimit = await getRetrievalOutputLimit(messages, maxTokens, profileId);
        signal?.throwIfAborted();
        try {
            const result = await runAsInternalPromptTransform(() => CMRS.sendRequest(profileId, messages, outputLimit, {
                extractData: true,
                includePreset: true,
                stream: false,
                signal,
            }, temperatureOverride), signal);
            signal?.throwIfAborted();
            if (result?.lengthLimited || isGenerationLengthFinish(result)) throw knownReplyError('The retrieval reply reached its output limit.');
            const text = typeof result === 'string' ? result : extractProfileResponseText(result);
            if (!text.trim()) throw knownReplyError('Sidecar generation failed; Pawthfinder retrieval was skipped.');
            return text;
        } catch (err) {
            if (isAbortLikeError(err, signal)) {
                throw err;
            }
            // A lost connection or server error may already have produced a paid reply,
            // so it is never sent again through the main model.
            if (isUnknownSidecarOutcome(err)) {
                notifySidecarIssue('The connection profile request result is unknown, so Pawthfinder retrieval was skipped.', 'error');
                throw err;
            }
            console.warn(`[Pawthfinder] Sidecar via profile "${profileId}" failed:`, err);
            notifySidecarIssue('Connection profile request failed; falling back to the main model.');
        }
    }

    try {
        const outputLimit = await getRetrievalOutputLimit(messages, maxTokens);
        signal?.throwIfAborted();
        const result = await runAsInternalPromptTransform(() => (ctx?.generateRawData ?? generateRaw)({
            prompt: messages,
            responseLength: outputLimit,
            trimNames: false,
            signal,
            cacheScope: 'auxiliary',
            ...temperatureOverride,
        }), signal);
        signal?.throwIfAborted();
        if (isGenerationLengthFinish(result)) throw new Error('The retrieval reply reached its output limit.');
        const text = extractProfileResponseText(result);
        if (!text.trim()) throw new Error('Sidecar generation failed; Pawthfinder retrieval was skipped.');
        return text;
    } catch (err) {
        if (isAbortLikeError(err, signal)) {
            throw err;
        }
        console.warn('[Pawthfinder] Sidecar via main model failed:', err);
        notifySidecarIssue('Sidecar generation failed; Pawthfinder retrieval was skipped.', 'error');
        throw err;
    }
}
