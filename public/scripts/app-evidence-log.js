// A small in-memory log of what went wrong in this tab, for the Scratchpad 'App diagnostics' switch.
// It keeps no prompt or reply text and nothing survives a reload. Other modules import it
// instead of the other way round, so it has no dependencies on the app.
import { redactEvidenceText } from './scratchpad/evidence.js';

const FAILURE_LIMIT = 5;
/** @type {{ at: number, provider: string, model: string, status: number, message: string }[]} */
let providerFailures = [];
/** @type {string[]} */
let extensionLoadErrors = [];

/**
 * Remembers one failed model request. Only the provider, model, HTTP status and the
 * provider's own error message are kept, never what was sent or received as text.
 * @param {{ provider?: unknown, model?: unknown, status?: unknown, message?: unknown }} failure
 */
export function recordProviderFailure({ provider, model, status, message } = {}) {
    const code = Math.trunc(Number(status));
    providerFailures.unshift({
        at: Date.now(),
        provider: redactEvidenceText(provider, 60),
        model: redactEvidenceText(model, 120),
        status: code > 0 && code < 600 ? code : 0,
        message: redactEvidenceText(message, 400),
    });
    providerFailures.length = Math.min(providerFailures.length, FAILURE_LIMIT);
}

export function getProviderFailures() {
    return providerFailures.map(failure => ({ ...failure }));
}

/** @param {Iterable<string>} errors Messages for extensions that failed to load, in load order */
export function setExtensionLoadErrors(errors) {
    extensionLoadErrors = [...errors].filter(error => typeof error === 'string' && error.trim()).map(error => redactEvidenceText(error, 300));
}

export function getExtensionLoadErrors() {
    return [...extensionLoadErrors];
}

export function clearAppEvidenceLog() {
    providerFailures = [];
    extensionLoadErrors = [];
}
