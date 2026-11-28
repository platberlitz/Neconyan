// Neconyan: when the request to the AI provider fails before any reply arrives, say plainly that the
// provider could not be reached, instead of passing on raw text such as 'fetch failed'.
// The full error stays in the server log.
export const PROVIDER_UNREACHABLE = 'provider_unreachable';

const REASONS = new Map([
    ['ECONNREFUSED', 'refused'],
    ['ENOTFOUND', 'not_found'],
    ['EAI_AGAIN', 'not_found'],
    ['EAI_NONAME', 'not_found'],
    ['ETIMEDOUT', 'timeout'],
    ['ESOCKETTIMEDOUT', 'timeout'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
    ['UND_ERR_HEADERS_TIMEOUT', 'timeout'],
    ['UND_ERR_BODY_TIMEOUT', 'timeout'],
    ['ECONNRESET', 'reset'],
    ['ECONNABORTED', 'reset'],
    ['EPIPE', 'reset'],
    ['UND_ERR_SOCKET', 'reset'],
    ['UND_ERR_CLOSED', 'reset'],
    ['EHOSTUNREACH', 'unknown'],
    ['ENETUNREACH', 'unknown'],
    ['ENETDOWN', 'unknown'],
    ['EHOSTDOWN', 'unknown'],
]);
const CERTIFICATE = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/;
const FETCH_TIMEOUTS = new Set(['request-timeout', 'body-timeout']);

export const PROVIDER_UNREACHABLE_MESSAGES = Object.freeze({
    refused: 'Neconyan could not reach the AI provider because it refused the connection. Check that the provider is running and that its address in your connection settings is right, then try again.',
    not_found: 'Neconyan could not reach the AI provider because its address could not be found. Check the address in your connection settings, then try again.',
    timeout: 'Neconyan could not reach the AI provider because it took too long to answer. Wait a moment, then try again.',
    reset: 'Neconyan lost its connection to the AI provider before a reply arrived. Wait a moment, then try again.',
    certificate: 'Neconyan could not reach the AI provider because its security certificate was not accepted. Check the address in your connection settings, then try again.',
    unknown: 'Neconyan could not reach the AI provider. Check that the provider is online and that its address in your connection settings is right, then try again.',
});

function errorChain(error) {
    const chain = [];
    for (let current = error; current && typeof current === 'object' && chain.length < 5 && !chain.includes(current); current = current.cause) {
        chain.push(current);
    }
    return chain;
}

/**
 * Why a request to the AI provider failed to connect, or null when the error is not a connection failure
 * (for example a check inside Neconyan that refused the request on purpose).
 * @param {unknown} error
 * @returns {'refused'|'not_found'|'timeout'|'reset'|'certificate'|'unknown'|null}
 */
export function providerReachFailure(error) {
    let network = false;
    for (const link of errorChain(error)) {
        const code = typeof link.code === 'string' ? link.code : '';
        if (REASONS.has(code)) return REASONS.get(code);
        if (code && CERTIFICATE.test(code)) return 'certificate';
        if (link.name === 'TimeoutError' || (link.name === 'FetchError' && FETCH_TIMEOUTS.has(link.type))) return 'timeout';
        if ((link.name === 'FetchError' && link.type === 'system') || typeof link.syscall === 'string'
            || (link instanceof TypeError && /^(?:fetch failed|terminated)$/i.test(link.message))) {
            network = true;
        }
    }
    return network ? 'unknown' : null;
}

/**
 * The 502 body for a provider that could not be reached, or null when the error is something else.
 * @param {unknown} error
 */
export function providerUnreachableReply(error) {
    const reason = providerReachFailure(error);
    if (!reason) return null;
    return { error: { message: PROVIDER_UNREACHABLE_MESSAGES[reason], code: PROVIDER_UNREACHABLE, reason } };
}
