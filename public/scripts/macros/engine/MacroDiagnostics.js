/** @typedef {import('./MacroCstWalker.js').MacroCall} MacroCall */
/** @typedef {import('./MacroRegistry.js').MacroDefinition} MacroDefinition */
/** @typedef {import('chevrotain').ILexingError} ILexingError */
/** @typedef {import('chevrotain').IRecognitionException} IRecognitionException */

import { t } from '/scripts/i18n.js';
import { Popup, POPUP_RESULT } from '/scripts/popup.js';
import { power_user } from '/scripts/power-user.js';
import { accountStorage } from '/scripts/util/AccountStorage.js';
import { SimpleMutex } from '/scripts/util/SimpleMutex.js';

/**
 * The shared console diagnostics live in the pure macro-console leaf so the
 * server macro modules can log without importing this browser module.
 */
export {
    createMacroRuntimeError,
    logMacroRuntimeWarning,
    logMacroInternalError,
    logMacroRegisterWarning,
    logMacroRegisterError,
    logMacroGeneralError,
    logMacroSyntaxWarning,
} from './macro-console.js';

// Use mutex here so even on parallel usage without awaiting the popup, this will only show up once.
export const onboardingExperimentalMacroEngineMutex = new SimpleMutex(onboardingExperimentalMacroEngineUnsafe);

/**
 * Onboards the user to use the experimental macro engine.
 * Asks the user to enable it if they haven't already.
 *
 * @param {string|null} feature - The feature that requires the experimental macro engine, or null if not applicable or unknown.
 * @returns {Promise<void>} - A promise that resolves when the user has been onboarded.
 */
export const onboardingExperimentalMacroEngine = onboardingExperimentalMacroEngineMutex.update.bind(onboardingExperimentalMacroEngineMutex);

async function onboardingExperimentalMacroEngineUnsafe(feature = null) {
    // Show a popup once telling a user that they are using experimental features that only work with the new engine.
    // Ask them if they want to turn the experimental engine on.
    if (power_user.experimental_macro_engine) return;

    // If already shown, do not show again
    const shown = accountStorage.getItem('slash_command_experimental_engine_warning_shown');
    if (shown === 'true') return;

    const result = await Popup.show.confirm(t`Experimental Macro Engine`, `
        <p>${t`You are using experimental macro features that require the new macro engine.`}</p>
        ${feature ? `<div class="info-block hint">
                <span>${t`Recognized Feature: `}<strong>${feature}</strong></span>
            </div>` : ''}
        <p>${t`For more information on the new macro engine, visit the <br />${`<a href="https://docs.sillytavern.app/usage/core-concepts/macros/">${t`Macro Documentation`}</a>`}.`}</p>
        <p>${t`You can enable the engine any time under:<br />${t`User Settings`} → ${t`Experimental Macro Engine`}`}</p>
        <p>${t`Would you like to enable it now?`}</p>`);
    if (result == POPUP_RESULT.AFFIRMATIVE) {
        power_user.experimental_macro_engine = true;
        $('#experimental_macro_engine').prop('checked', power_user.experimental_macro_engine).trigger('input');
    }

    // Only show this once
    accountStorage.setItem('slash_command_experimental_engine_warning_shown', 'true');
}
