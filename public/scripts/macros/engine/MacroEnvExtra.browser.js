/**
 * Browser operation-data provider for the shared macro engine.
 *
 * Registration of macros is process-wide, so per-user/per-operation state must
 * never be captured in a macro handler closure. Instead, this provider fills
 * env.extra for every evaluation with the live SillyTavern values that the
 * shared definitions need. Node glue supplies the same fields from explicit
 * snapshots.
 *
 * This module is browser-only: it imports the running app's live globals.
 * The server never imports it; it builds env.extra itself.
 */
import { chat_metadata, main_api, getCurrentChatId, getMaxPromptTokens, getMaxContextTokens, getMaxResponseTokens, extension_prompts, chat } from '../../../script.js';
import { power_user } from '../../power-user.js';
import { parseMesExamples } from '../../../script.js';
import { formatInstructModeExamples } from '../../instruct-mode.js';
import { isMobile } from '../../RossAscends-mods.js';
import { timestampToMoment } from '../../utils.js';
import { textgenerationwebui_banned_in_macros } from '../../textgen-settings.js';
import { eventSource, event_types } from '../../events.js';
import { findExtension } from '../../extensions.js';

/**
 * Per-operation state shared by the state macros. The generation type is
 * event-tracked once for the lifetime of the page; the object identity is
 * per-provider (browser only), never per user.
 */
const generationState = { lastGenerationType: '' };
let generationTrackingInitialized = false;

export function ensureGenerationTracking() {
    if (generationTrackingInitialized) return;
    generationTrackingInitialized = true;
    eventSource?.on?.(event_types.GENERATION_STARTED, (type, _params, isDryRun) => {
        if (isDryRun) return;
        generationState.lastGenerationType = type || 'normal';
    });
    eventSource?.on?.(event_types.CHAT_CHANGED, () => {
        generationState.lastGenerationType = '';
    });
}

/**
 * The variables surface exposed to variable shorthands. The CST walker reads
 * env.extra.variables.local/global for `.var` and `$var` shorthand operations.
 * The browser uses the live context stores so shorthand side effects persist
 * exactly as they did before the extraction.
 *
 * @returns {import('./MacroEnv.types.js').MacroEnvVariables}
 */
function buildBrowserVariables() {
    return SillyTavern.getContext().variables;
}

/**
 * Populates env.extra from the live browser globals for one evaluation.
 *
 * @param {import('./MacroEnv.types.js').MacroEnv} env
 */
export function populateBrowserExtra(env) {
    ensureGenerationTracking();
    env.extra = {
        ...env.extra,
        variables: buildBrowserVariables(),
        getInput: () => /** @type {HTMLTextAreaElement} */(document.querySelector('#send_textarea'))?.value ?? '',
        chatMetadata: chat_metadata,
        setChatIdHash: value => { chat_metadata.chat_id_hash = value; },
        chat,
        getCurrentChatId: () => getCurrentChatId(),
        getMaxPromptTokens: () => getMaxPromptTokens(),
        getMaxContextTokens: () => getMaxContextTokens(),
        getMaxResponseTokens: () => getMaxResponseTokens(),
        extensionPrompts: extension_prompts,
        bannedWords: textgenerationwebui_banned_in_macros,
        mainApi: main_api,
        powerUser: power_user,
        isMobile: () => isMobile(),
        generationState,
        findExtension: (name) => findExtension(name),
        parseMesExamples: (text, instruct) => parseMesExamples(text, instruct),
        formatInstructModeExamples: (mesExamplesArray, user, char) => formatInstructModeExamples(mesExamplesArray, user, char),
        timestampToMoment: (timestamp) => timestampToMoment(timestamp),
        getFirstDisplayedMessageId: () => {
            const value = Number(document.querySelector('#chat .mes')?.getAttribute('mesid'));
            return !isNaN(value) && value >= 0 ? value : null;
        },
    };
}
