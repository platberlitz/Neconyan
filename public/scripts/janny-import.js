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
 * @returns {{title: string, message: string}} What went wrong and what the user should do next
 */
export function jannyBridgeGuidance(code) {
    const title = 'JannyAI import needs a Cloudflare check';
    switch (code) {
        case 'janny_admin_required':
            return { title, message: 'JannyAI sits behind a Cloudflare check, and only a Neconyan administrator can pass it for this server. Ask an administrator to open BotSearcher, choose JannyAI and pass the check with "Open JannyAI login window", or download the card PNG from JannyAI and import the file.' };
        case 'janny_browser_unavailable':
            return { title, message: 'JannyAI sits behind a Cloudflare check and the JannyAI browser import is not set up on this server. Download the card PNG from JannyAI and import the file instead.' };
        case 'janny_restore_failed':
            return { title: 'JannyAI import is busy', message: 'The JannyAI browser import is still restoring its JanitorAI settings. Open BotSearcher, choose JannyAI, press "Refresh status", then import the link again.' };
        case 'janny_card_unavailable':
            return { title: 'JannyAI card unavailable', message: 'JannyAI could not return this card. Check that the link opens a public character on JannyAI, or download the card PNG and import the file.' };
        default:
            return { title, message: JANNY_IMPORT_GUIDANCE };
    }
}

/**
 * Fetches a JannyAI card through BotSearcher's server-side browser import,
 * which can pass the Cloudflare check that blocks the plain download.
 * @param {string} jannyUrl Canonical JannyAI character URL.
 * @param {Record<string, string>} headers Request headers, including the CSRF token.
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{file: File}|{error: string}>} The card file, or the bridge's error code.
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
        return { error: code };
    }
    const kind = response.headers.get('X-SBBS-Card-Kind') === 'png' ? 'png' : 'json';
    const uuid = jannyUrl.match(JANNY_UUID_PATTERN)?.[0] ?? 'jannyai';
    const data = await response.blob();
    return { file: new File([data], `${uuid}.${kind}`, { type: kind === 'png' ? 'image/png' : 'application/json' }) };
}
