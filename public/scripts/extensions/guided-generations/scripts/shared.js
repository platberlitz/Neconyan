import { extension_settings, getContext } from '../../../extensions.js';
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
const guidedCorrectionInjectId = 'gg-guided-correction';
const guidedImpersonateInjectId = 'gg-impersonate-voice';
const guidedGenerationInjectIds = [
    guidedResponseInjectId,
    guidedSwipeInjectId,
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
 * Neconyan Stage 9: a guided generation is one named server workflow, so the
 * browser no longer injects a prompt and triggers a browser generation. Returns
 * false when the server cannot own this call (a group turn, or no protected
 * Roleplay account), and the caller then keeps its own path.
 */
async function submitGuidedWorkflow(name, prompt) {
    if (isGroupChat()) {
        return false;
    }
    const workflows = await import('../../../neconyan-conversation/roleplay-workflows.js').catch(() => null);
    if (!workflows?.isNativeRoleplayWorkflowReady?.()) {
        return false;
    }
    // Macros resolve in the page exactly as the injected guide would have, and a
    // page prompt addition the server cannot carry keeps the browser path.
    const text = workflows.resolvePageText(prompt?.text);
    const page = await workflows.capturePagePrompts(name);
    if (!text || !page) {
        return false;
    }
    debugLog('[Guided] Submitting named workflow', name);
    try {
        await workflows.submitRoleplayWorkflow({ name, intent: { prompt: { ...prompt, text } }, page });
    } catch (error) {
        // A refusal is final. Falling back here would inject the guide and pay for
        // a second generation the server already accounted for.
        console.error('[GuidedGenerations] The named workflow was refused:', error);
        globalThis.toastr?.error?.(error?.message || 'The guided workflow could not be started.', 'Nothing was generated');
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
        throw new Error('SillyTavern slash command execution is not available.');
    }

    for (const id of activeGuides) {
        await context.executeSlashCommandsWithOptions(`/flushinject ${id}`);
    }

    return activeGuides;
}

export {
    applyPromptTemplate,
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
