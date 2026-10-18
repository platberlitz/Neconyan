import { extension_settings, getContext } from '../../../extensions.js';
import { isImageInputIssue } from '../../../prompt-media-policy.js';
import {
    getCurrentProfile,
    getCurrentProfileId,
    getPresetsForApiType,
    getProfileApiType,
    getProfileById,
    getProfileList,
    handleSwitching,
    resolveStoredProfile,
} from './presetUtils.js';

const extensionName = 'guided-generations';
const guidedResponseInjectId = 'gg-guided-response';
const guidedSwipeInjectId = 'gg-guided-swipe';
const guidedRegenerateInjectId = 'gg-guided-regenerate';
const guidedCorrectionInjectId = 'gg-guided-correction';
const guidedImpersonateInjectId = 'gg-impersonate-voice';
const guidedGenerationInjectIds = [
    guidedResponseInjectId,
    guidedSwipeInjectId,
    guidedRegenerateInjectId,
    guidedCorrectionInjectId,
    guidedImpersonateInjectId,
];

let previousImpersonateInput = '';
let lastImpersonateResult = '';

function debugLog(...args) {
    if (extension_settings[extensionName]?.debugMode) {
        console.log(`[${extensionName}][DEBUG]`, ...args);
    }
}

function debugWarn(...args) {
    if (extension_settings[extensionName]?.debugMode) {
        console.warn(`[${extensionName}][DEBUG]`, ...args);
    }
}

function setPreviousImpersonateInput(input) {
    previousImpersonateInput = input ?? '';
}

function getPreviousImpersonateInput() {
    return previousImpersonateInput;
}

function setLastImpersonateResult(result) {
    lastImpersonateResult = result ?? '';
}

function getLastImpersonateResult() {
    return lastImpersonateResult;
}

function isGroupChat() {
    const context = getContext();
    return Boolean(context?.groupId && context?.groups);
}

/**
 * Responses and swipes use the browser unless scoped Notebook context needs the server.
 * Replacements still need the server's atomic write: their browser fallback
 * temporarily removes the target or following messages and can save that shortened
 * chat if the page closes. Returns false when no protected server workflow exists.
 */
async function submitGuidedWorkflow(name, prompt) {
    if (isGroupChat()) {
        return false;
    }
    const { chat, chatId, groupId } = getContext() ?? {};
    const isCurrent = () => {
        const current = getContext();
        return current?.chat === chat && current?.chatId === chatId && current?.groupId === groupId;
    };
    let serverRequired = false;
    if (!['guided.regenerate', 'guided.correction', 'roleplay.correct'].includes(name)) {
        const { requiresServerReply } = await import('../../../browser-reply-routing.js');
        serverRequired = await requiresServerReply();
        if (!isCurrent()) return true;
        if (!serverRequired) return false;
    }
    const workflows = await import('../../../neconyan-conversation/roleplay-workflows.js').catch(() => null);
    // Treat a chat switch as handled so no caller falls back into the new chat.
    if (!isCurrent()) return true;
    if (!workflows?.isNativeRoleplayWorkflowReady?.()) {
        if (serverRequired) throw new Error('The selected Notebook context needs a server reply. Please reload and try again.');
        return false;
    }
    // Macros resolve in the page exactly as the injected guide would have, and a
    // page prompt addition the server cannot carry keeps the browser path.
    const text = prompt === undefined ? null : workflows.resolvePageText(prompt.text);
    const page = await workflows.capturePagePrompts(name);
    if (!isCurrent()) return true;
    if ((prompt !== undefined && !text) || !page) {
        if (serverRequired) throw new Error('The selected Notebook context cannot be combined with these page prompts. Nothing was generated.');
        return false;
    }
    debugLog('[Guided] Submitting named workflow', name);
    try {
        await workflows.submitRoleplayWorkflow({ name, intent: prompt === undefined ? {} : { prompt: { ...prompt, text } }, page });
    } catch (error) {
        // A refusal is final. Falling back here would inject the guide and pay for
        // a second generation the server already accounted for.
        console.error('[GuidedGenerations] The named workflow was refused:', error);
        // An image refusal has already raised its own notice (postSubmission), so it gets no second, generic toast.
        if (!isImageInputIssue(error)) globalThis.toastr?.error?.(error?.message || 'The guided workflow could not be started.', 'Nothing was generated');
    }
    return true;
}

function getLastAiMessage() {
    const context = getContext();
    const chat = context?.chat;

    if (!Array.isArray(chat) || chat.length === 0) {
        return null;
    }

    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (message && !message.is_user && !message.is_system) {
            return { message, index: i };
        }
    }

    return null;
}

function applyPromptTemplate(template, input) {
    return String(template ?? '').split('{{input}}').join(input ?? '');
}

function getActiveGuides() {
    const injects = getContext()?.chatMetadata?.script_injects;
    if (!injects || typeof injects !== 'object') {
        return [];
    }

    return guidedGenerationInjectIds.filter(id => Boolean(injects[id]));
}

async function flushActiveGuides() {
    const activeGuides = getActiveGuides();
    if (activeGuides.length === 0) {
        return [];
    }

    const context = getContext();
    if (typeof context?.executeSlashCommandsWithOptions !== 'function') {
        throw new Error('Neconyan slash command execution is not available.');
    }

    for (const id of activeGuides) {
        await context.executeSlashCommandsWithOptions(`/flushinject ${id}`);
    }

    return activeGuides;
}

// Guide text is pasted into STscript; a bare `|` or `{:` would split or swallow the command.
function escapeSlashCommandText(value) {
    return String(value ?? '').replace(/(\\*)(\||\{:)/g, (_, slashes, sequence) => `${slashes}${slashes}\\${sequence}`);
}

export {
    applyPromptTemplate,
    escapeSlashCommandText,
    debugLog,
    debugWarn,
    extensionName,
    extension_settings,
    flushActiveGuides,
    getActiveGuides,
    getContext,
    getCurrentProfile,
    getCurrentProfileId,
    guidedCorrectionInjectId,
    guidedImpersonateInjectId,
    guidedRegenerateInjectId,
    guidedResponseInjectId,
    guidedSwipeInjectId,
    getLastAiMessage,
    getLastImpersonateResult,
    getPresetsForApiType,
    getPreviousImpersonateInput,
    getProfileApiType,
    getProfileById,
    getProfileList,
    handleSwitching,
    isGroupChat,
    resolveStoredProfile,
    submitGuidedWorkflow,
    setLastImpersonateResult,
    setPreviousImpersonateInput,
};
