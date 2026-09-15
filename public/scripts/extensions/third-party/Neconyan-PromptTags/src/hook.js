import { isPerMessageIdentifier } from './sections.js';
import { applyWrap } from './wrap.js';
import { getActiveRules, isEnabled } from './settings.js';

let patch = null;
let hookActive = true;

/**
 * Wraps one prepared prompt in place.
 *
 * Runs inside PromptManager.preparePrompt, which is the only point where a section is visible
 * with its identifier and with macros already substituted. Because the tags end up inside the
 * message content, they survive squashSystemMessages and every prompt post-processing mode.
 */
function transform(prepared) {
    if (!hookActive) {
        return;
    }

    if (!prepared || typeof prepared.content !== 'string') {
        return;
    }

    const identifier = prepared.identifier;
    // preparePrompt is also called once per chat-history message; wrapping those would tag
    // every individual message instead of the block.
    if (!identifier || isPerMessageIdentifier(identifier)) {
        return;
    }

    if (!isEnabled()) {
        return;
    }

    const rule = getActiveRules()[identifier];
    if (!rule?.enabled) {
        return;
    }

    const substitute = SillyTavern.getContext().substituteParams;
    prepared.content = applyWrap(prepared.content, rule, { substitute });
}

/**
 * Patches the live PromptManager instance. The instance is created once and never replaced
 * (setupChatCompletionPromptManager early-returns when it already exists), so a single patch
 * holds for the session. Safe to call repeatedly.
 * @returns {boolean} Whether the hook is installed.
 */
export function installHook() {
    if (!hookActive) {
        return false;
    }

    const promptManager = SillyTavern.getContext()?.promptManager;
    if (!promptManager || typeof promptManager.preparePrompt !== 'function') {
        return false;
    }

    if (patch?.promptManager === promptManager) {
        if (promptManager.preparePrompt === patch.wrapper) {
            return true;
        }

        // Another extension owns the method now. Forget our stale ownership record, but do
        // not restore anything over the other extension's live wrapper.
        patch = null;
    }

    // A different instance than we patched before: drop the stale patch first.
    if (patch) {
        uninstallHook();
    }

    const hadOwnProperty = Object.prototype.hasOwnProperty.call(promptManager, 'preparePrompt');
    const previous = promptManager.preparePrompt;
    const original = previous.bind(promptManager);

    const wrapper = function (prompt, originalContent = null) {
        const prepared = original(prompt, originalContent);
        try {
            // A later extension may retain this wrapper after replacing the live method. The
            // ownership check keeps that stale wrapper inert if Prompt Tags is installed again.
            if (patch?.wrapper === wrapper) {
                transform(prepared);
            }
        } catch (error) {
            console.error('[Prompt Tags] Failed to wrap a prompt section:', error);
        }
        return prepared;
    };
    promptManager.preparePrompt = wrapper;

    patch = { promptManager, previous, hadOwnProperty, wrapper };
    return true;
}

export function setHookActive(value) {
    hookActive = !!value;
}

export function uninstallHook() {
    if (!patch) {
        return;
    }

    const { promptManager, previous, hadOwnProperty, wrapper } = patch;
    if (promptManager.preparePrompt !== wrapper) {
        // A later owner replaced our wrapper. Leaving it intact is the only safe cleanup.
        patch = null;
        return;
    }

    if (hadOwnProperty) {
        promptManager.preparePrompt = previous;
    } else {
        // Removing the own property exposes the prototype method again.
        delete promptManager.preparePrompt;
    }

    patch = null;
}

export function isHookInstalled() {
    return !!patch && patch.promptManager.preparePrompt === patch.wrapper;
}
