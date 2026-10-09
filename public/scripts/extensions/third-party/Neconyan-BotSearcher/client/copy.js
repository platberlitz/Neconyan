/**
 * Pure display formatting shared by the browser and detail views.
 * Machine values stay unchanged; only their user-facing labels live here.
 */

const NUMBER_FORMAT = new Intl.NumberFormat();

export const SORT_LABELS = Object.freeze({
    latest: 'Latest',
    curated: 'Curated',
    downloads: 'Most downloaded',
    favorites: 'Most favorited',
    views: 'Most viewed',
    random: 'Random',
    default: 'Source default',
    download_count: 'Most downloaded',
    star_count: 'Most starred',
    n_favorites: 'Most favorited',
    rating: 'Highest rated',
    trending: 'Trending',
    trending_downloads: 'Trending downloads',
    created_at: 'Newest',
    last_activity_at: 'Recently active',
    newcomer: 'Newcomers',
    n_tokens: 'Most tokens',
    name: 'Name',
    approved_at: 'Recently approved',
    stars: 'Most starred',
    chatCount: 'Most chats',
    createdAt: 'Newest',
    updatedAt: 'Recently updated',
    token_count: 'Most tokens',
    display_name: 'Name',
    recommended: 'Recommended',
    download: 'Most downloaded',
    newest: 'Newest',
    relevant: 'Most relevant',
    oldest: 'Oldest',
    tokens_desc: 'Most tokens',
    tokens_asc: 'Fewest tokens',
});

const STAT_FIELDS = Object.freeze({
    botbooru: Object.freeze([
        ['tokens', 'token'],
        ['downloads', 'download'],
        ['views', 'view'],
        ['favorites', 'fork'],
    ]),
    chub: Object.freeze([
        ['tokens', 'token'],
        ['views', 'chat'],
        ['downloads', 'star'],
        ['favorites', 'favorite'],
    ]),
    pygmalion: Object.freeze([
        ['tokens', 'token'],
        ['views', 'view'],
        ['downloads', 'star'],
        ['favorites', 'chat'],
    ]),
    wyvern: Object.freeze([
        ['tokens', 'token'],
        ['favorites', 'like'],
    ]),
    charactertavern: Object.freeze([
        ['tokens', 'token'],
        ['views', 'message'],
        ['downloads', 'download'],
        ['favorites', 'like'],
    ]),
    jannyai: Object.freeze([
        ['tokens', 'token'],
    ]),
});

function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function formatNumber(value) {
    const number = finiteNumber(value);
    return number === null ? '' : NUMBER_FORMAT.format(number);
}

export function formatCount(value, singular, plural = `${singular}s`) {
    const number = finiteNumber(value);
    if (number === null) {
        return '';
    }
    return `${formatNumber(number)} ${number === 1 ? singular : plural}`;
}

export function formatResultCount(shown, total) {
    const shownCount = finiteNumber(shown) ?? 0;
    const totalCount = finiteNumber(total);
    if (totalCount !== null) {
        const resultWord = totalCount === 1 ? 'result' : 'results';
        return `${formatNumber(shownCount)} of ${formatNumber(totalCount)} ${resultWord}`;
    }
    const resultWord = shownCount === 1 ? 'result' : 'results';
    return `${formatNumber(shownCount)} ${resultWord} shown`;
}

export function sortLabel(sort) {
    if (Object.prototype.hasOwnProperty.call(SORT_LABELS, sort)) {
        return SORT_LABELS[sort];
    }

    const text = String(sort ?? '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .trim()
        .toLowerCase();
    return text === '' ? 'Sort option' : text.charAt(0).toUpperCase() + text.slice(1);
}

export function sourceStatLine(sourceId, stats, omit = []) {
    if (!stats || typeof stats !== 'object') {
        return '';
    }

    const fields = STAT_FIELDS[sourceId] ?? [];
    return fields
        .filter(([key]) => !omit.includes(key))
        .map(([key, label]) => formatCount(stats[key], label))
        .filter(Boolean)
        .join(', ');
}

/**
 * External URL count, from either contents shape.
 *
 * A source-reported summary never carries one; a byte-derived report carries
 * `{ count, hosts }`. Reading both here keeps every caller from caring which
 * kind of summary it was handed.
 */
export function externalUrlCount(inside) {
    const value = inside?.externalUrls;
    return typeof value?.count === 'number' ? value.count : 0;
}

export function insideRows(inside) {
    if (!inside || typeof inside !== 'object') {
        return [];
    }

    const rows = [];
    const add = (label, value) => rows.push({ label, value });

    if (inside.lorebookEntries === null) {
        add('Lorebook', 'Not reported');
    } else if (inside.lorebookEntries > 0) {
        add('Lorebook', formatCount(inside.lorebookEntries, 'entry', 'entries'));
    }
    if (inside.alternateGreetings === null) {
        add('Alternate greetings', 'Not reported');
    } else if (inside.alternateGreetings > 0) {
        add('Alternate greetings', formatCount(inside.alternateGreetings, 'greeting'));
    }
    if (inside.hasSystemPrompt === null) {
        add('System prompt', 'Not reported');
    } else if (inside.hasSystemPrompt) {
        add('System prompt', 'Included');
    }
    if (inside.hasPostHistoryInstructions === null) {
        add('Post-history instructions', 'Not reported');
    } else if (inside.hasPostHistoryInstructions) {
        add('Post-history instructions', 'Included');
    }
    if (inside.hasDepthPrompt === null) {
        add('Depth prompt', 'Not reported');
    } else if (inside.hasDepthPrompt) {
        add('Depth prompt', 'Included');
    }
    if (inside.regexScripts === null) {
        add('Regex scripts', 'Not reported');
    } else if (inside.regexScripts > 0) {
        add('Regex scripts', formatCount(inside.regexScripts, 'script'));
    }
    if (inside.embeddedAssets === null) {
        add('Embedded assets', 'Not reported');
    } else if (inside.embeddedAssets > 0) {
        add('Embedded assets', formatCount(inside.embeddedAssets, 'asset'));
    }
    if (externalUrlCount(inside) > 0) {
        add('External URL references', formatCount(externalUrlCount(inside), 'reference'));
    }
    if (inside.originSite) {
        add('Reported origin', inside.originSite);
    }
    if (inside.specVersion) {
        add('Card format', inside.specVersion);
    }

    return rows;
}

/**
 * What an empty grid means, which depends on what was actually asked for.
 *
 * "Try a broader search" is unhelpful advice when the query is empty and it is
 * the filters doing the narrowing, so the sentence names whichever one applies.
 *
 * @param {string} sourceLabel
 * @param {string} query
 * @param {number} activeFilters
 */
export function emptyResultMessage(sourceLabel, query, activeFilters = 0) {
    if (query && activeFilters > 0) {
        return `No results for "${query}" on ${sourceLabel} with these filters. Try removing a filter or broadening the search.`;
    }
    if (activeFilters > 0) {
        return `No cards on ${sourceLabel} match these filters. Try removing one.`;
    }
    if (query) {
        return `No results for "${query}" on ${sourceLabel}. Try a broader search.`;
    }
    return `No cards are currently listed on ${sourceLabel}.`;
}

/**
 * Why a source could not be reached, in the words that fit what happened.
 *
 * "Not responding" is wrong for a refusal: the site answered, and it said no.
 * The two lead to different next actions, so they get different sentences.
 *
 * @param {string} sourceLabel
 * @param {string | null | undefined} reason a `classify()` kind from the server
 */
export function unreachableReason(sourceLabel, reason) {
    switch (reason) {
        case 'forbidden':
            return `${sourceLabel} refused the request from your Neconyan server.`;
        case 'dns':
            return `${sourceLabel} could not be found from your Neconyan server.`;
        case 'not_found':
            return `${sourceLabel} no longer offers the endpoint BotSearcher uses.`;
        default:
            return `${sourceLabel} is not responding.`;
    }
}

/**
 * Shown when requests for a source move from the server to this browser. States
 * the consequence rather than only the mechanism, because the consequence is the
 * part the user is being asked to accept.
 */
export function directRoutingNotice(sourceLabel, reason) {
    return `${unreachableReason(sourceLabel, reason)} BotSearcher is now requesting ${sourceLabel} from this browser instead, so ${sourceLabel} sees your browser's address rather than the server's. You can turn this off in Extensions > BotSearcher.`;
}

// ---- URL import via the search box ----

/**
 * Shown while a recognized card URL sits in the search box.
 * @param {string} sourceLabel
 * @param {boolean} [direct] the review screen is switched off in settings
 */
export function urlImportReadyMessage(sourceLabel, direct = false) {
    return direct
        ? `Press Enter to import this ${sourceLabel} card.`
        : `Press Enter to review this ${sourceLabel} card before importing.`;
}

/** Summary of the JannyAI hint shown while JannyAI can supply cards. */
export const JANNY_CLOUDFLARE_HINT_TITLE = 'JannyAI imports need a Cloudflare check first';

/** Body of the JannyAI hint: what to do before the first import. */
export function jannyCloudflareHint() {
    return 'JannyAI sits behind a Cloudflare check that blocks the Neconyan server until someone passes it. Searching works without it. Before importing, press "Open JannyAI login window" below and finish the check in that window on the Neconyan server, then import the card. You can also download the card from JannyAI and open it with "Inspect a card file".';
}

/** The pasted URL belongs to a source the user has switched off. */
export function urlImportDisabledMessage(sourceLabel) {
    return `Enable ${sourceLabel} under Extensions > BotSearcher > Sources to import cards from this address.`;
}

/** The pasted URL belongs to no source at all. */
export function urlImportUnsupportedMessage() {
    return 'No supported source imports cards from this address.';
}

/**
 * What the dialog can still do when no searchable source is enabled.
 *
 * @param {string[]} urlSourceLabels labels of enabled URL-import sources
 */
export function searchUnavailableMessage(urlSourceLabels) {
    if (urlSourceLabels.length === 0) {
        return 'No sources are enabled. Enable one in Extensions > BotSearcher > Sources.';
    }
    return `No searchable source is enabled. Paste a card URL from ${list(urlSourceLabels)} to review and import it.`;
}

export function searchErrorMessage(error, sourceLabel) {
    switch (error?.code) {
        case 'botbooru_login_required':
            return 'Log in to BotBooru under Extensions > BotSearcher to search non-SFW results.';
        case 'botbooru_session_expired':
            return 'Your BotBooru login expired. Log in again under Extensions > BotSearcher.';
        case 'botbooru_nsfw_disabled':
            return 'Enable NSFW for the BotBooru account under Extensions > BotSearcher, or search SFW only.';
        case 'botbooru_auth_unavailable':
            return 'BotBooru account access is unavailable. Try again shortly.';
        case 'account_profile_required':
            return 'Select a Neconyan profile before using source accounts.';
        case 'botbooru_account_changed':
            return 'The BotBooru account changed during this request. Try again.';
        case 'saucepan_login_required':
        case 'saucepan_session_expired':
        case 'saucepan_account_changed':
        case 'saucepan_auth_unavailable':
        case 'janny_admin_required':
        case 'janny_browser_unavailable':
        case 'janny_login_required':
        case 'janny_browser_request_failed':
        case 'janny_restore_failed':
            return accountErrorMessage(error, sourceLabel);
        case 'timeout':
            return `${sourceLabel} did not respond in time. Try again.`;
        case 'rate_limited':
            return 'Too many searches. Wait a moment and try again.';
        case 'source_busy':
            return `${sourceLabel} is busy. Try again shortly.`;
        case 'source_down':
            return `${sourceLabel} is not responding.`;
        case 'direct_blocked':
            return `${sourceLabel} refused the request from your Neconyan server and from this browser.`;
        case 'bad_direct_url':
            return `BotSearcher will not request ${sourceLabel} from an unexpected address.`;
        case 'direct_unsupported':
            return `${sourceLabel} cannot be requested from this browser.`;
        case 'http_error':
            return `${sourceLabel} returned an error.`;
        case 'too_large':
            return `${sourceLabel} sent more data than BotSearcher accepts.`;
        case 'bad_cursor':
            return `The ${sourceLabel} result page expired. Start a new search to continue.`;
        case 'bad_json':
        case 'unsafe_json':
            return `${sourceLabel} sent a response this version cannot read. The source API may have changed.`;
        default:
            return `Could not connect to ${sourceLabel}.`;
    }
}

export function detailErrorMessage(error, sourceLabel) {
    switch (error?.code) {
        case 'botbooru_login_required':
            return 'Log in to BotBooru under Extensions > BotSearcher to load this card.';
        case 'botbooru_session_expired':
            return 'Your BotBooru login expired. Log in again under Extensions > BotSearcher.';
        case 'botbooru_auth_unavailable':
            return 'BotBooru account access is unavailable. Try again shortly.';
        case 'botbooru_nsfw_disabled':
            return 'NSFW is disabled for this BotBooru account. Search again in SFW mode.';
        case 'botbooru_account_changed':
            return 'The BotBooru account changed after this result loaded. Search again.';
        case 'account_profile_required':
        case 'saucepan_login_required':
        case 'saucepan_session_expired':
        case 'saucepan_account_changed':
        case 'saucepan_auth_unavailable':
        case 'janny_admin_required':
        case 'janny_browser_unavailable':
        case 'janny_login_required':
        case 'janny_browser_request_failed':
        case 'janny_restore_failed':
            return accountErrorMessage(error, sourceLabel);
        case 'timeout':
            return `${sourceLabel} did not respond in time.`;
        case 'rate_limited':
            return 'Too many requests. Wait a moment and try again.';
        case 'source_busy':
            return `${sourceLabel} is busy. Try again shortly.`;
        default:
            return `Could not load this card from ${sourceLabel}.`;
    }
}

export function accountErrorMessage(error, sourceLabel = '') {
    switch (error?.code ?? error?.message) {
        case 'botbooru_invalid_credentials':
            return 'BotBooru did not accept that username and password.';
        case 'botbooru_login_required':
            return 'Log in to BotBooru first.';
        case 'botbooru_session_expired':
            return 'Your BotBooru login expired. Log in again.';
        case 'botbooru_nsfw_disabled':
            return 'NSFW is disabled for this BotBooru account.';
        case 'botbooru_auth_unavailable':
            return 'BotBooru account access is unavailable. Try again shortly.';
        case 'account_profile_required':
            return 'Select a Neconyan profile before using source accounts.';
        case 'botbooru_account_changed':
            return 'The BotBooru account changed during this request. Try again.';
        case 'bad_account_request':
            return 'Enter a valid BotBooru username and password.';
        case 'saucepan_invalid_credentials':
            return 'Saucepan.ai did not accept that handle and password.';
        case 'saucepan_login_required':
            return 'Log in to Saucepan.ai first.';
        case 'saucepan_session_expired':
            return 'Your Saucepan.ai token expired. Log in again.';
        case 'saucepan_account_changed':
            return 'The Saucepan.ai login changed during this request. Try again.';
        case 'saucepan_auth_unavailable':
            return 'Saucepan.ai account access is unavailable. Try again shortly.';
        case 'bad_saucepan_request':
            return 'Enter a valid Saucepan.ai handle/password or bearer token.';
        case 'janny_browser_unavailable':
            return 'The optional JannyAI browser bridge is unavailable on this host. Install Playwright and Chromium to enable it.';
        case 'janny_login_required':
            return 'Finish the JannyAI login and Cloudflare check in the browser window first.';
        case 'janny_admin_required':
            return 'Only a Neconyan administrator can use the JannyAI browser session. Sign in as an administrator or ask the server owner to import the card.';
        case 'janny_browser_request_failed':
            return 'The JannyAI browser request failed. Check the browser window on the Neconyan server for a login or Cloudflare check, then refresh status before trying again.';
        case 'janny_restore_failed':
            return 'JannyAI account settings could not be restored after the import attempt. Check the API and generation settings in the browser window on the Neconyan server before importing again.';
        case 'timeout':
            return sourceLabel === 'JannyAI'
                ? 'The JannyAI browser request timed out. Check the browser window on the Neconyan server, then refresh status before trying again.'
                : 'The account request did not finish in time. Try again shortly.';
        case 'rate_limited':
            return 'Too many login attempts. Wait before trying again.';
        default:
            return sourceLabel === 'JannyAI'
                ? 'Could not update the JannyAI browser session. Refresh status before trying again.'
                : `Could not update the ${sourceLabel ? `${sourceLabel} account` : 'account'}. Try again.`;
    }
}

export function importErrorMessage(error) {
    if (error?.name === 'TimeoutError') {
        return 'The request took too long. Try again.';
    }
    switch (error?.code ?? error?.message) {
        case 'generation_active':
            return 'Stop the current reply before importing or replacing a character.';
        case 'collection_unavailable':
            return 'Your collection could not be checked. Try again before importing.';
        case 'duplicate_detected':
            return 'A copy with this name appeared while preparing the import. Review it before adding another.';
        case 'character_changed':
            return 'The installed copy changed after this review. Reopen the review before replacing it.';
        case 'character_missing':
            return 'The selected installed copy no longer exists. Reopen the review.';
        case 'character_unverified':
            return 'The installed copy could not be verified. Nothing was replaced.';
        case 'clean_incomplete':
            return 'Clean import stopped because not all contents could be checked. Nothing was imported.';
        case 'import_url_rejected':
            return 'BotSearcher rejected the download link.';
        case 'import_unsupported':
            return 'This source does not support imports.';
        case 'import_failed':
            return 'The card could not be imported. It may have been removed.';
        case 'card_invalid':
            return 'The download is not a supported character card.';
        case 'png_malformed':
        case 'not_a_png':
            return 'The downloaded card is damaged or incomplete.';
        case 'too_large':
            return 'The card is larger than BotSearcher allows.';
        case 'use_native_import':
            return 'This card must use Neconyan\'s built-in importer. Report this BotSearcher error.';
        case 'rate_limited':
            return 'Too many downloads. Wait a moment and try again.';
        default:
            return 'The card could not be imported.';
    }
}

/** Removing a character that an import just added. */
export function undoErrorMessage(error) {
    switch (error?.code ?? error?.message) {
        case 'character_missing':
            return 'The character is no longer in your collection.';
        case 'character_changed':
            return 'This character changed after import. Undo will not delete your modified copy.';
        case 'character_unverified':
            return 'The imported file could not be verified. Undo will not delete an unverified copy.';
        case 'generation_active':
            return 'Stop the current reply before undoing an import.';
        case 'chat_close_failed':
            return 'The active chat could not be closed safely. Save or stop the chat, then try Undo again.';
        default:
            return 'The character could not be removed. Delete it from the character list.';
    }
}

/**
 * The closing line of a bulk import: what was added, what was skipped because
 * it was already installed, and what failed. Zero counts are left out.
 */
export function bulkImportSummary({ imported, installed, failed, unknown = 0, review = 0, pending = 0, uncertain = 0, replaced = 0, stopped = false }) {
    const parts = [];
    if (installed > 0) {
        parts.push(`${installed} already in your collection`);
    }
    if (failed > 0) {
        parts.push(`${failed} failed`);
    }
    if (unknown > 0) {
        parts.push(`${unknown} collection ${unknown === 1 ? 'check' : 'checks'} unavailable`);
    }
    if (review > 0) {
        parts.push(`${review} ${review === 1 ? 'card needs' : 'cards need'} inspection review`);
    }
    if (uncertain > 0) {
        parts.push(`${uncertain} ${uncertain === 1 ? 'import outcome' : 'import outcomes'} unconfirmed`);
    }
    if (replaced > 0) {
        parts.push(`${replaced} replaced`);
    }
    if (pending > 0) {
        parts.push(`${pending} not started`);
    }
    const head = `${stopped ? 'Stopped. ' : ''}Imported ${formatCount(imported, 'card')}.`;
    return parts.length === 0 ? head : `${head} ${list(parts)}.`;
}

function list(items) {
    if (items.length === 1) {
        return items[0];
    }
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function additionalImportContents(actual, reported) {
    if (!actual || typeof actual !== 'object') {
        return '';
    }

    const notes = [];
    const reportedCount = (key) => {
        const value = reported && typeof reported === 'object' ? reported[key] : null;
        return finiteNumber(value) ?? 0;
    };
    const reportedFlag = (key) => reported && typeof reported === 'object' && reported[key] === true;

    if (actual.lorebookEntries > reportedCount('lorebookEntries')) {
        notes.push(formatCount(actual.lorebookEntries, 'lorebook entry', 'lorebook entries'));
    }
    if (actual.alternateGreetings > reportedCount('alternateGreetings')) {
        notes.push(formatCount(actual.alternateGreetings, 'alternate greeting'));
    }
    if (actual.hasSystemPrompt && !reportedFlag('hasSystemPrompt')) {
        notes.push('a system prompt');
    }
    if (actual.hasPostHistoryInstructions && !reportedFlag('hasPostHistoryInstructions')) {
        notes.push('post-history instructions');
    }
    if (actual.hasDepthPrompt && !reportedFlag('hasDepthPrompt')) {
        notes.push('a depth prompt');
    }
    if (actual.regexScripts > reportedCount('regexScripts')) {
        notes.push(formatCount(actual.regexScripts, 'regex script'));
    }
    if (actual.embeddedAssets > reportedCount('embeddedAssets')) {
        notes.push(formatCount(actual.embeddedAssets, 'embedded asset'));
    }
    if (externalUrlCount(actual) > 0) {
        notes.push(formatCount(externalUrlCount(actual), 'external URL reference'));
    }

    return notes.length === 0 ? '' : `The imported card also contains ${list(notes)}.`;
}

/** Compares stable X.Y.Z releases, or returns null for an unknown format. */
export function compareReleaseVersions(left, right) {
    const parse = (value) => {
        const match = String(value ?? '').match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
        return match ? match.slice(1).map((part) => Number.parseInt(part, 10)) : null;
    };
    const a = parse(left);
    const b = parse(right);
    if (!a || !b) {
        return null;
    }
    for (let index = 0; index < a.length; index++) {
        if (a[index] !== b[index]) {
            return a[index] < b[index] ? -1 : 1;
        }
    }
    return 0;
}

export function availabilityCopy(status, health, frontendProtocol, frontendVersion, _capabilityStatus = '') {
    if (status === 'missing') {
        return {
            title: 'Native service unavailable',
            lead: 'Neconyan includes BotSearcher’s server service, but it is not available right now.',
            guidance: 'Restart Neconyan and choose Recheck. If the service remains unavailable, inspect the Neconyan server log.',
            showInstall: false,
            showManualUpdate: false,
            showUpdate: false,
        };
    }

    if (status === 'protocol-mismatch') {
        const protocols = `Frontend protocol: ${frontendProtocol}. Server protocol: ${health?.protocol ?? 'not reported'}.`;
        const versions = health?.version
            ? ` Frontend version: ${frontendVersion}. Server version: ${health.version}.`
            : ` Frontend version: ${frontendVersion}.`;
        const comparison = compareReleaseVersions(health?.version, frontendVersion);
        let recovery = ' Update Neconyan and restart it, then check again.';
        if (comparison === -1) {
            recovery = ` Update Neconyan to include the native service, then restart it.`;
        } else if (comparison === 1) {
            recovery = ` The server is newer; update the frontend extension to v${health.version}. A server downgrade is not offered.`;
        } else if (comparison === null) {
            recovery = ' The server version cannot be ordered safely. Verify both deployments manually; no server replacement is offered.';
        }
        return {
            title: 'Frontend and server are incompatible',
            lead: 'The BotSearcher frontend and Neconyan native service use different protocol versions.',
            guidance: `${protocols}${versions} ${recovery} Update Neconyan and restart it to apply the matching native service.`,
            showInstall: false,
            showManualUpdate: false,
            showUpdate: false,
        };
    }

    return {
        title: 'Native service unavailable',
        lead: 'BotSearcher could not connect to Neconyan’s native service.',
        guidance: 'Restart Neconyan. If the problem continues, check the Neconyan server log for BotSearcher errors.',
        showInstall: false,
        showManualUpdate: false,
        showUpdate: false,
    };
}


// ---- card intake ----

/**
 * The intake report, grouped so the parts that act on their own are not buried
 * among the parts that are simply the character.
 *
 * Counts and flags only. Lorebook text, script bodies and macro arguments are
 * the card's own content and are not reproduced here.
 */
export function intakeSections(inside) {
    if (!inside || typeof inside !== 'object') {
        return [];
    }

    const sections = [];
    const section = (title, rows) => {
        if (rows.length > 0) {
            sections.push({ title, rows });
        }
    };
    const row = (label, value, tone) => ({ label, value, tone });

    if (inside.scan?.complete !== true) {
        section('Inspection', [row(
            'Contents check',
            'Not fully inspected. Counts and findings may be incomplete. Token counts are measured separately.',
            'warn',
        )]);
    }

    // Things that change model input or message processing on their own.
    const automation = [];
    if (inside.regexScripts > 0) {
        automation.push(row('Regex scripts', formatCount(inside.regexScripts, 'script'), 'warn'));
    }
    if (inside.hasSystemPrompt) {
        automation.push(row('System prompt', 'Included'));
    }
    if (inside.hasPostHistoryInstructions) {
        automation.push(row('Post-history instructions', 'Included'));
    }
    if (inside.hasDepthPrompt) {
        automation.push(row('Depth prompt', 'Included'));
    }
    if (inside.macros?.count > 0) {
        automation.push(row('Macros', macroSummary(inside.macros)));
    }
    if (inside.html?.hasScriptOrIframe) {
        automation.push(row('Embedded script or iframe', 'Present', 'warn'));
    } else if (inside.html?.count > 0) {
        automation.push(row('HTML markup', htmlSummary(inside.html)));
    }
    if (inside.extensions?.unknown?.length > 0) {
        automation.push(row(
            'Unrecognised extension data',
            inside.extensions.unknown.join(', '),
            'warn',
        ));
    }
    section('Behaviour', automation);

    // Things that are simply the character.
    const content = [];
    if (inside.lorebookEntries === null) {
        content.push(row('Lorebook', 'Not reported'));
    } else if (inside.lorebookEntries > 0) {
        content.push(row('Lorebook', formatCount(inside.lorebookEntries, 'entry', 'entries')));
    }
    if (inside.alternateGreetings > 0) {
        content.push(row('Alternate greetings', formatCount(inside.alternateGreetings, 'greeting')));
    }
    if (inside.embeddedAssets > 0) {
        content.push(row('Embedded assets', formatCount(inside.embeddedAssets, 'asset')));
    }
    if (inside.tagCount > 0) {
        content.push(row('Tags', formatCount(inside.tagCount, 'tag')));
    }
    if (externalUrlCount(inside) > 0) {
        content.push(row('External URLs', externalUrlSummary(inside.externalUrls)));
    }
    section('Contents', content);

    // Things worth a second look before starting a chat.
    const findings = [];
    for (const hit of inside.privateInfo ?? []) {
        findings.push(row(privateInfoLabel(hit.kind), `${hit.redacted} in ${fieldLabel(hit.field)}`, 'warn'));
    }
    for (const problem of inside.malformed ?? []) {
        findings.push(row(fieldLabel(problem.field), problem.problem, 'note'));
    }
    section('Worth checking', findings);

    return sections;
}

function macroSummary(macros) {
    const identifiers = (Array.isArray(macros.names) ? macros.names : [])
        .filter((name) => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name));
    const names = identifiers.slice(0, 6).map((name) => `{{${name}}}`);
    const count = formatCount(macros.count, 'use');
    return names.length === 0 ? count : `${count}: ${names.join(', ')}${identifiers.length > names.length ? '...' : ''}`;
}

function htmlSummary(html) {
    const fields = (html.fields ?? []).slice(0, 4).map(fieldLabel);
    return fields.length === 0 ? 'Present' : `In ${list(fields)}`;
}

function externalUrlSummary(externalUrls) {
    const hosts = (externalUrls.hosts ?? []).slice(0, 4);
    const count = formatCount(externalUrls.count, 'reference');
    return hosts.length === 0 ? count : `${count}: ${hosts.join(', ')}${externalUrls.hosts.length > hosts.length ? '...' : ''}`;
}

const PRIVATE_INFO_LABELS = Object.freeze({
    email: 'Email address',
    apiKey: 'API key',
    bearer: 'Access token',
    homePath: 'File path with a user name',
    discordInvite: 'Discord invite',
});

function privateInfoLabel(kind) {
    return Object.prototype.hasOwnProperty.call(PRIVATE_INFO_LABELS, kind)
        ? PRIVATE_INFO_LABELS[kind]
        : 'Personal detail';
}

const FIELD_LABELS = Object.freeze({
    description: 'the description',
    personality: 'the personality',
    scenario: 'the scenario',
    first_mes: 'the first message',
    mes_example: 'the example messages',
    system_prompt: 'the system prompt',
    post_history_instructions: 'the post-history instructions',
    creator_notes: "the creator's notes",
    alternate_greetings: 'the alternate greetings',
    character_book: 'the lorebook',
    extensions: 'the extension data',
    spec_version: 'the card format version',
    card: 'the card',
});

function fieldLabel(field) {
    return Object.prototype.hasOwnProperty.call(FIELD_LABELS, field)
        ? FIELD_LABELS[field]
        : String(field ?? '').replace(/_/g, ' ');
}

/** The line under the card name: format, size and hash. */
export function intakeIdentity(inside) {
    const parts = [];
    if (inside?.specVersion) {
        parts.push(SPEC_LABELS[inside.specVersion] ?? inside.specVersion);
    }
    if (finiteNumber(inside?.byteSize) !== null) {
        parts.push(formatBytes(inside.byteSize));
    }
    if (typeof inside?.sha256 === 'string') {
        parts.push(`SHA-256 ${inside.sha256.slice(0, 12)}`);
    }
    return parts.join(' · ');
}

const SPEC_LABELS = Object.freeze({
    chara_card_v1: 'Card format v1',
    chara_card_v2: 'Card format v2',
    chara_card_v3: 'Card format v3',
});

export function formatBytes(value) {
    const bytes = finiteNumber(value);
    if (bytes === null) {
        return '';
    }
    if (bytes < 1024) {
        return `${bytes} bytes`;
    }
    if (bytes < 1024 * 1024) {
        return `${Math.round(bytes / 1024)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** How the installed copy compares, or that there is not one. */
export function duplicateMessage(match) {
    if (!match) {
        return 'This card is not in your collection.';
    }
    // Not knowing is its own answer. Reporting it as "not installed" would be a
    // false all-clear, and duplicates are one of the things this screen is for.
    if (match.unknown === true) {
        return 'BotSearcher could not read your collection, so it cannot say whether this card is already in it.';
    }
    if (Array.isArray(match.matches)) {
        return match.matches.length === 1
            ? duplicateMessage(match.matches[0])
            : `${formatCount(match.matches.length, 'installed copy', 'installed copies')} have this name. Choose a copy below to compare or replace.`;
    }
    if (!Array.isArray(match.differences)) {
        return `Already in your collection as "${match.name}". Its contents could not be compared.`;
    }
    if (match.differences.length === 0) {
        return `Already in your collection as "${match.name}". The compared fields and counts match.`;
    }
    return `Already in your collection as "${match.name}", with a different ${list(match.differences)}.`;
}

/** What clean import will do to THIS card, itemised. */
export function cleanPlan(inside) {
    if (!inside || typeof inside !== 'object') {
        return [];
    }
    if (inside.scan?.complete !== true) {
        return ['regex scripts, unrecognised extension blocks, fields outside the card format and matching personal details where present'];
    }

    const items = [];
    if (inside.regexScripts > 0) {
        items.push(formatCount(inside.regexScripts, 'regex script'));
    }
    const unknown = inside.extensions?.unknown ?? [];
    if (unknown.length > 0) {
        items.push(`${formatCount(unknown.length, 'unrecognised extension block')} (${unknown.slice(0, 3).join(', ')})`);
    }
    const unrecognized = (inside.malformed ?? []).filter((problem) => problem.problem === 'is not a field in this card format');
    if (unrecognized.length > 0) {
        items.push(formatCount(unrecognized.length, 'field outside the card format'));
    }
    if ((inside.privateInfo ?? []).length > 0) {
        items.push(formatCount(inside.privateInfo.length, 'personal detail'));
    }
    return items;
}

/** What clean import deliberately leaves alone, so the button cannot overpromise. */
export function cleanKeeps(inside) {
    const keeps = [];
    if (inside?.lorebookEntries > 0) {
        keeps.push(formatCount(inside.lorebookEntries, 'lorebook entry', 'lorebook entries'));
    }
    if (inside?.alternateGreetings > 0) {
        keeps.push(formatCount(inside.alternateGreetings, 'greeting'));
    }
    if (inside?.hasSystemPrompt) {
        keeps.push('the system prompt');
    }
    if (inside?.hasPostHistoryInstructions) {
        keeps.push('post-history instructions');
    }
    if (inside?.hasDepthPrompt) {
        keeps.push('the depth prompt');
    }
    if (inside?.macros?.count > 0) {
        keeps.push('macros in retained fields');
    }
    if (inside?.html?.hasScriptOrIframe) {
        keeps.push('embedded scripts or iframes in retained fields');
    } else if (inside?.html?.count > 0) {
        keeps.push('HTML formatting in retained fields');
    }
    return keeps;
}

/**
 * What the card costs, split by when each part is actually in context.
 *
 * A single number would be wrong in both directions. The example messages are
 * dropped once the chat fills the context, and a lorebook's keyword entries only
 * arrive when something triggers them — so the headline counts what is there
 * before the user has typed anything, and the rows say what the rest can add.
 *
 * @param {object|null} counts from countTokens(): per-bucket totals, each a
 *   number or null when it could not be measured.
 * @returns {{headline: string, rows: {label: string, value: string}[]}}
 */
export function tokenFootprint(counts) {
    if (!counts || counts.measured !== true) {
        return { headline: 'Token cost could not be measured for this card.', rows: [] };
    }

    const rows = [];
    const row = (label, value, suffix = '') => {
        if (typeof value === 'number') {
            rows.push({ label, value: `${formatNumber(value)} tokens${suffix}` });
        }
    };

    row('Always in context', counts.always);
    row('Opening message', counts.greeting);
    row('Example messages', counts.examples);

    if (counts.lorebook === null) {
        rows.push({ label: 'Lorebook', value: 'None in this card' });
    } else if (counts.lorebook?.measured !== true) {
        rows.push({ label: 'Lorebook', value: 'Too large to measure' });
    } else {
        if (counts.lorebook.alwaysEntries > 0) {
            row(
                'Lorebook, always on',
                counts.lorebook.always,
                ` across ${formatCount(counts.lorebook.alwaysEntries, 'entry', 'entries')}`,
            );
        }
        if (counts.lorebook.conditionalEntries > 0) {
            rows.push({
                label: 'Lorebook, only when triggered',
                value: `up to ${formatNumber(counts.lorebook.conditional)} tokens across ${formatCount(counts.lorebook.conditionalEntries, 'entry', 'entries')}`,
            });
        }
    }

    const permanent = [counts.always, counts.greeting, counts.examples, counts.lorebook?.always]
        .filter(value => typeof value === 'number')
        .reduce((sum, value) => sum + value, 0);

    return {
        headline: `About ${formatNumber(permanent)} tokens are in context before you send anything.`,
        rows,
    };
}

/**
 * Browser bridge errors that explain the card itself. They outrank the native
 * download failure, which for JannyAI can only guess at Cloudflare.
 */
export const JANNY_CARD_ERRORS = Object.freeze([
    'janny_private_card_unsupported',
    'janny_private_capture_failed',
    'janny_proxy_disabled',
    'janny_card_unavailable',
]);

export function intakeErrorMessage(error, sourceId) {
    if (error?.name === 'TimeoutError') {
        return 'The card request took too long. Try again.';
    }
    switch (error?.code ?? error?.message) {
        case 'botbooru_login_required':
            return 'Log in to BotBooru below, then retry this card.';
        case 'botbooru_session_expired':
            return 'Your BotBooru login expired. Log in below, then retry this card.';
        case 'botbooru_nsfw_disabled':
            return 'Enable NSFW for the BotBooru account below, then retry this card.';
        case 'janny_admin_required':
            return 'JannyAI browser import requires a Neconyan administrator. Ask an administrator or inspect a downloaded card file.';
        case 'janny_browser_request_failed':
            return 'The JannyAI browser request failed. Check the browser session, then retry this card.';
        case 'janny_restore_failed':
            return 'JannyAI could not restore its account settings after capture. Check those settings before retrying.';
        case 'clean_incomplete':
            return 'The card was not fully inspected, so clean import is unavailable.';
        case 'native_download_failed':
            if (sourceId === 'jannyai') {
                return 'Neconyan could not download this JannyAI card. JannyAI\'s Cloudflare check is probably blocking the server.';
            }
            return 'Neconyan could not download this card from the source.';
        case 'bad_import_url':
            return 'That URL is not a supported Saucepan.ai or JannyAI character address.';
        case 'saucepan_login_required':
            return 'This Saucepan.ai card requires a login.';
        case 'saucepan_session_expired':
            return 'Your Saucepan.ai login expired. Log in again.';
        case 'janny_login_required':
            return 'JannyAI\'s Cloudflare check has not been passed yet. Press "Open JannyAI login window" below, finish the check (and log in if asked), then press Try again.';
        case 'janny_browser_unavailable':
            return 'The optional JannyAI browser bridge is unavailable on this host. Install Playwright and Chromium to enable it.';
        case 'janny_private_card_unsupported':
            return 'This JannyAI card hides its definition, so it cannot be imported from the link. Download the card PNG from JannyAI and import the file instead.';
        case 'janny_private_capture_failed':
            return 'This JannyAI card hides its definition and the server browser could not read it through a chat. Try again, or download the card PNG from JannyAI and import the file.';
        case 'janny_proxy_disabled':
            return 'This JannyAI card hides its definition and its creator turned proxies off, so Neconyan cannot read it from the link. If JannyAI offers a download for this card, import that file instead.';
        case 'janny_card_unavailable':
            return 'JannyAI could not return this card. Check that the link opens a public character on JannyAI, or download the card PNG and import the file.';
        case 'not_a_character':
            return 'That link is not a character card.';
        case 'import_url_rejected':
            return 'BotSearcher rejected the import address for this card.';
        case 'too_large':
            return 'That file is larger than BotSearcher will inspect.';
        case 'card_invalid':
            return 'That file is not a character card BotSearcher recognizes.';
        case 'not_a_png':
            return 'That file is not a PNG card or a JSON card.';
        case 'png_malformed':
            return 'That card file is damaged and was not inspected.';
        case 'rate_limited':
            return 'Too many inspections. Wait a moment and try again.';
        case 'unsupported_media_type':
        case 'payload_too_large':
            return 'BotSearcher refused those bytes before reading them.';
        default:
            return 'The card could not be inspected.';
    }
}

/** Intake-only controls shared by single-card and batch review. */
export const INTAKE_COPY = Object.freeze({
    cleanUnavailable: 'Clean import is unavailable until all contents can be inspected.',
    replaced: 'Replaced',
    openFailed: 'The character could not be opened. Refresh your collection and try again.',
    importTarget: 'Import destination',
    addCopy: 'Add a new copy',
    replaceCopy: 'Replace an installed copy',
    installedCopy: 'Installed copy',
    replaceWarning: 'Replacement overwrites this copy. There is no Undo for a replacement. Chats are kept.',
    revisionUnknown: 'This installed file could not be verified. Replacement is unavailable; you can still add a new copy.',
    comparing: 'Comparing the installed copy...',
    importCopyExactly: 'Import a copy exactly',
    replaceExactly: 'Replace exactly',
    replaceClean: 'Clean and replace',
    undoUnavailable: 'Undo is unavailable because this imported file could not be verified.',
    undone: 'Import undone.',
    nativeFinished: 'Check collection',
    batchStart: 'Start import',
    batchContinue: 'Continue remaining',
    batchStop: 'Stop after current card',
    batchStopping: 'Stopping after current card...',
    batchRetry: 'Retry failed cards',
    batchReview: 'Review card',
    batchNotStarted: 'Not started',
    batchInspectionUnknown: 'Not fully inspected. Review this card before importing.',
    batchExactPolicy: 'Imports exactly as downloaded. Existing copies, unavailable collection checks and incomplete inspections wait for review.',
    batchCleanPolicy: 'Uses clean import. Existing copies, unavailable collection checks and incomplete inspections wait for review.',
});

export function intakeScanWarning(inside) {
    if (inside?.scan?.complete === true) {
        return '';
    }
    return inside?.scan?.complete === false
        ? 'Not fully inspected. Some contents were not checked. Review the reported findings before importing exactly; clean import is unavailable.'
        : 'Inspection coverage was not reported. Unreported contents are unknown, not absent. Review is required and clean import is unavailable.';
}

export function intakeCompletionMessage(receipt) {
    if (receipt?.committed !== true) {
        return 'The host did not confirm this import. Check your collection before trying again. Undo is unavailable.';
    }
    const parts = [receipt.replaced ? 'Replaced. There is no Undo for this replacement.' : 'Imported.'];
    if (!receipt.refreshed) {
        parts.push('The character list could not refresh. Reopen it to see the result.');
    }
    if (!receipt.replaced && !receipt.canUndo) {
        parts.push(INTAKE_COPY.undoUnavailable);
    }
    return parts.join(' ');
}

export const NAMED_SEARCH_COPY = Object.freeze({
    title: 'Named searches',
    optIn: 'Save named searches in Neconyan profile settings',
    privacy: 'Separate from search history. Names, search terms and filter values may be included in profile backups. Do not include private details in them. Card URLs, login fields and card contents are not saved. Turning this off clears all named searches.',
    name: 'Search name',
    save: 'Save search',
    load: 'Load search',
    remove: 'Delete search',
    clear: 'Clear all named searches',
    empty: 'No named searches',
    disabled: 'Turn on named searches under Extensions > BotSearcher to save a search.',
    invalid: 'Enter a name and a search without URLs or login details.',
    full: 'You can save up to 20 named searches. Delete one or replace an existing name.',
    saved: 'Search saved.',
    removed: 'Named search deleted.',
});
