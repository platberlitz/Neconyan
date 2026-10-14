import { buildTrustedOuterDocument } from '../public/scripts/card-script-sandbox/outer.js';
import { CARD_SCRIPT_SANDBOX_CSP, CARD_SCRIPT_CONNECTION_ALLOWLIST } from '../public/scripts/card-script-sandbox/policy.js';

const document = buildTrustedOuterDocument();
export const CARD_SCRIPT_RESPONSE_HEADERS = Object.freeze({
    'Content-Type': 'text/html; charset=utf-8',
    'Connection-Allowlist': CARD_SCRIPT_CONNECTION_ALLOWLIST,
    'Content-Security-Policy': `sandbox allow-scripts; frame-ancestors 'self'; ${CARD_SCRIPT_SANDBOX_CSP}`,
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store, private',
    'X-DNS-Prefetch-Control': 'off',
    'Vary': 'Cookie',
});

export function serveCardScriptSandbox(_request, response) {
    response.set(CARD_SCRIPT_RESPONSE_HEADERS);
    return response.status(200).send(document);
}
