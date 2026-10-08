/**
 * JannyAI link import helpers shared by the core "Import from URL" flow.
 *
 * JannyAI sits behind a Cloudflare check that blocks the server's plain card
 * download, so a failed JannyAI import is retried through BotSearcher's
 * server-side browser import, and the user is told how to pass the check when
 * that fails too.
 */

const JANNY_UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export const JANNY_BRIDGE_URL = '/api/plugins/neconyan-botsearcher/url-card';
export const JANNY_IMPORT_GUIDANCE = 'JannyAI sits behind a Cloudflare check. Open BotSearcher (Extensions > BotSearcher), choose JannyAI, open "JannyAI imports need a Cloudflare check first", press "Open JannyAI login window" and pass the check there, then import the link again. You can also download the card PNG from JannyAI and import the file.';
const JANNY_SERVER_BROWSER_NOTE = 'Logging in or passing the check in your own browser does not count: the import runs in a separate browser on the Neconyan server.';
const JANNY_CHECK_SERVER_BROWSER = 'Open BotSearcher (Extensions > BotSearcher), choose JannyAI and press "Refresh status". If it does not show as ready and logged in, press "Open JannyAI login window", close any popups and finish any login or Cloudflare check in that window, then import the link again. If it keeps failing and BotSearcher shows no JanitorAI settings waiting to be restored, restart Neconyan.';

function retryAfterText(retryAfter) {
    const seconds = Math.ceil(Number(retryAfter));
    if (!Number.isFinite(seconds) || seconds <= 0) return 'in a moment';
    return seconds === 1 ? 'in 1 second' : `in ${seconds} seconds`;
}

function jannyCharacterUrl(uuid) {
    return `https://jannyai.com/characters/${uuid.toLowerCase()}`;
}

/**
 * Turns a JannyAI or JanitorAI character link, or a Janny "_character" UUID,
 * into the canonical address the BotSearcher browser import accepts.
 * @param {string} value URL or UUID given to the importer.
 * @returns {string|null} https://jannyai.com/characters/<uuid>, or null for anything else.
 */
export function canonicalJannyCharacterUrl(value) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    let parsed;
    try {
        parsed = new URL(text);
    } catch {
        const uuid = text.includes('_character') ? text.match(JANNY_UUID_PATTERN)?.[0] : null;
        return uuid ? jannyCharacterUrl(uuid) : null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'jannyai.com' && host !== 'janitorai.com') return null;
    const uuid = parsed.pathname.match(/^\/characters\/([^/]+)/i)?.[1]?.match(JANNY_UUID_PATTERN)?.[0];
    return uuid ? jannyCharacterUrl(uuid) : null;
}

/**
 * @param {string} code BotSearcher bridge error code
 * @param {number} [retryAfter] Seconds the server asked the client to wait, for busy or rate-limited errors.
 * @returns {{title: string, message: string}} What went wrong and what the user should do next
 */
export function jannyBridgeGuidance(code, retryAfter) {
    const title = 'JannyAI import needs a Cloudflare check';
    switch (code) {
        case 'janny_login_required':
            return { title: 'JannyAI login needed on the server', message: `The Neconyan server's JannyAI browser is logged out or stuck at a Cloudflare check. ${JANNY_SERVER_BROWSER_NOTE} ${JANNY_IMPORT_GUIDANCE}` };
        case 'janny_browser_request_failed':
            return { title: 'JannyAI browser did not answer', message: `The Neconyan server's JannyAI browser could not reach JanitorAI for this card. A popup, a logged-out session, a Cloudflare check or a slow JanitorAI can cause this. ${JANNY_SERVER_BROWSER_NOTE} ${JANNY_CHECK_SERVER_BROWSER}` };
        case 'janny_private_card_unsupported':
            return { title: 'JannyAI card definition is hidden', message: 'This JannyAI card hides its definition, so it cannot be imported from the link. Download the card PNG from JannyAI and import the file instead.' };
        case 'janny_private_capture_failed':
            return { title: 'JannyAI hidden card not captured', message: 'This JannyAI card hides its definition and the server browser could not read it through a chat. Try again, or download the card PNG from JannyAI and import the file.' };
        case 'rate_limited':
            return { title: 'JannyAI import rate limited', message: `Too many JannyAI imports in a short time. Try again ${retryAfterText(retryAfter)}.` };
        case 'source_busy':
            return { title: 'JannyAI import is busy', message: `The JannyAI browser is still working on another request. Try again ${retryAfterText(retryAfter)}.` };
        case 'source_down':
            return { title: 'JannyAI is not responding', message: 'JannyAI failed several requests in a row, so imports are paused for a short while. Try again in a few minutes.' };
        case 'bad_import_url':
            return { title: 'JannyAI link not recognised', message: 'Use a character link like https://jannyai.com/characters/<id> or https://janitorai.com/characters/<id>, without anything after a ? or #.' };
        case 'janny_bridge_unreachable':
            return { title: 'JannyAI import could not reach the server', message: 'Neconyan could not reach its JannyAI browser import. Check your connection to Neconyan, then import the link again.' };
        case 'janny_admin_required':
            return { title, message: 'JannyAI sits behind a Cloudflare check, and only a Neconyan administrator can pass it for this server. Ask an administrator to open BotSearcher, choose JannyAI and pass the check with "Open JannyAI login window", or download the card PNG from JannyAI and import the file.' };
        case 'janny_browser_unavailable':
            return { title, message: 'JannyAI sits behind a Cloudflare check and the JannyAI browser import is not set up on this server. Download the card PNG from JannyAI and import the file instead.' };
        case 'janny_restore_failed':
            return { title: 'JannyAI import is busy', message: 'The JannyAI browser import is still restoring its JanitorAI settings. Open BotSearcher, choose JannyAI, press "Refresh status", then import the link again.' };
        case 'janny_card_unavailable':
            return { title: 'JannyAI card unavailable', message: 'JannyAI could not return this card. Check that the link opens a public character on JannyAI, or download the card PNG and import the file.' };
        default:
            return { title: 'JannyAI import failed', message: `The JannyAI browser import failed (${code || 'unknown error'}). ${JANNY_CHECK_SERVER_BROWSER} You can also download the card PNG from JannyAI and import the file.` };
    }
}

/**
 * Fetches a JannyAI card through BotSearcher's server-side browser import,
 * which can pass the Cloudflare check that blocks the plain download.
 * @param {string} jannyUrl Canonical JannyAI character URL.
 * @param {Record<string, string>} headers Request headers, including the CSRF token.
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{file: File}|{error: string, retryAfter?: number}>} The card file, or the bridge's error code.
 */
export async function fetchJannyCardThroughBrowser(jannyUrl, headers, fetchImpl = fetch) {
    let response;
    try {
        response = await fetchImpl(JANNY_BRIDGE_URL, {
            method: 'POST',
            credentials: 'same-origin',
            headers,
            body: JSON.stringify({ source: 'jannyai', url: jannyUrl }),
        });
    } catch (error) {
        console.warn('JannyAI browser import could not be reached', error);
        return { error: 'janny_bridge_unreachable' };
    }
    if (!response.ok) {
        const body = await response.json().catch(() => null);
        const code = typeof body?.error === 'string' ? body.error : `http_${response.status}`;
        console.warn('JannyAI browser import failed', response.status, code);
        const retryAfter = Number(body?.retryAfter);
        return Number.isFinite(retryAfter) && retryAfter > 0 ? { error: code, retryAfter } : { error: code };
    }
    const kind = response.headers.get('X-SBBS-Card-Kind') === 'png' ? 'png' : 'json';
    const uuid = jannyUrl.match(JANNY_UUID_PATTERN)?.[0] ?? 'jannyai';
    const data = await response.blob();
    return { file: new File([data], `${uuid}.${kind}`, { type: kind === 'png' ? 'image/png' : 'application/json' }) };
}
