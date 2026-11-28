import { t } from './i18n.js';

// Neconyan: an AI provider or proxy that cannot reach its own upstream often answers with bare text
// such as 'Connection error.' Passed on as it is, that reads as if Neconyan itself had lost the
// connection. These helpers say which connection failed; the original text stays in the console.
export const PROVIDER_UNREACHABLE = 'provider_unreachable';

const CONNECTION_PHRASE = /^(?:[a-z]*error:\s*)?(?:connection error|network error|fetch failed|terminated|socket hang up|other side closed|premature close|(?:unexpected )?eof|econnreset|econnrefused|etimedout|bad gateway|service unavailable|gateway time-?out|connect timeout error|request timed out|connection (?:refused|reset|closed|timed out|lost))\.?$/i;
const CONNECTION_DETAIL = /connection reset by peer|unexpected eof|broken pipe|i\/o timeout|upstream connect error|disconnect\/reset before headers/i;

/**
 * The English text the server sends for each reason, matched so a reply job that kept only the message
 * still gets the translated wording.
 */
const SERVER_MESSAGES = Object.freeze({
    refused: 'Neconyan could not reach the AI provider because it refused the connection. Check that the provider is running and that its address in your connection settings is right, then try again.',
    not_found: 'Neconyan could not reach the AI provider because its address could not be found. Check the address in your connection settings, then try again.',
    timeout: 'Neconyan could not reach the AI provider because it took too long to answer. Wait a moment, then try again.',
    reset: 'Neconyan lost its connection to the AI provider before a reply arrived. Wait a moment, then try again.',
    certificate: 'Neconyan could not reach the AI provider because its security certificate was not accepted. Check the address in your connection settings, then try again.',
    unknown: 'Neconyan could not reach the AI provider. Check that the provider is online and that its address in your connection settings is right, then try again.',
});

/** @param {string} reason */
function unreachableText(reason) {
    switch (reason) {
        case 'refused':
            return t`Neconyan could not reach the AI provider because it refused the connection. Check that the provider is running and that its address in your connection settings is right, then try again.`;
        case 'not_found':
            return t`Neconyan could not reach the AI provider because its address could not be found. Check the address in your connection settings, then try again.`;
        case 'timeout':
            return t`Neconyan could not reach the AI provider because it took too long to answer. Wait a moment, then try again.`;
        case 'reset':
            return t`Neconyan lost its connection to the AI provider before a reply arrived. Wait a moment, then try again.`;
        case 'certificate':
            return t`Neconyan could not reach the AI provider because its security certificate was not accepted. Check the address in your connection settings, then try again.`;
        default:
            return t`Neconyan could not reach the AI provider. Check that the provider is online and that its address in your connection settings is right, then try again.`;
    }
}

/**
 * Whether a provider's error text only says that a connection failed somewhere upstream.
 * @param {unknown} message
 */
export function isProviderConnectionText(message) {
    const text = typeof message === 'string' ? message.trim() : '';
    if (!text || text.length > 300) return false;
    return CONNECTION_PHRASE.test(text) || CONNECTION_DETAIL.test(text);
}

/**
 * The text to show for an error that came back from the AI provider through Neconyan's server.
 * Anything that is not a connection failure is returned unchanged.
 * @param {unknown} message The provider's or server's error text.
 * @param {{ code?: unknown, reason?: unknown } | null} [details] The error object Neconyan's server sent, if any.
 * @returns {string}
 */
export function providerFailureText(message, details = null) {
    const text = typeof message === 'string' ? message.trim() : '';
    if (details?.code === PROVIDER_UNREACHABLE) return unreachableText(String(details.reason ?? ''));
    const known = Object.entries(SERVER_MESSAGES).find(([, english]) => english === text);
    if (known) return unreachableText(known[0]);
    if (isProviderConnectionText(text)) {
        return t`The connection to the AI provider failed ('${text}'). Neconyan itself is still connected. Wait a moment, then try again.`;
    }
    return typeof message === 'string' ? message : '';
}
