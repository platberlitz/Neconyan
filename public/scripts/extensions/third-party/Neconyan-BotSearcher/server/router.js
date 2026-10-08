/**
 * Route table for /api/plugins/neconyan-botsearcher.
 *
 * Everything here is already behind whatever auth Neconyan is configured for
 * (requireLoginMiddleware, src/server-main.js:427) and behind csrfSyncProtection
 * (:362), because plugin routers mount after both (:496). GET routes skip CSRF
 * by csrf-sync's default ignoredMethods, which is why the availability probe is
 * a GET and everything else is a POST.
 *
 * The contract is deliberately narrow: the client names a SOURCE. The one URL
 * route below accepts only source-specific character URLs, parses them into a
 * validated id, and never becomes an arbitrary relay. /ingest accepts a PAYLOAD
 * the browser already fetched from a URL this server built.
 */

import {
    PROTOCOL_VERSION,
    VERSION,
    FIELD_LIMITS,
    THUMB_SIZES,
    MAX_INGEST_BYTES,
    MAX_CARD_BYTES,
    INGEST_KINDS,
    MAX_FANOUT,
} from '../shared/schema.js';
import { describeSources, getSource } from './registry.js';
import { wrap, jsonGuard, jsonGuardWithLimit, rawGuard, fail, UpstreamError, SAFE_UPSTREAM_CODES } from './guards.js';
import { clampInt, pick, own, readSourceId, isPlainObject, hasForbiddenKey, readFilters } from './validate.js';
import { contextFor, fetchBytes } from './http.js';
import { consume, acquire, acquireThumbnail, callerKey } from './limits.js';
import { mintCursor, verifyCursor, verifyRef, mintRef, mintToken, verifyToken } from './refs.js';
import { interleave, dedupe, identityFingerprint, sharePageBudget } from './merge.js';
import { BadCursorError } from './paging.js';
import { detectImageType } from './imagetype.js';
import {
    markSuccess,
    markFailure,
    isDown,
    stateOf,
    reset,
    reasonOf,
    classify,
    REROUTABLE_FAILURES,
} from './health.js';
import { CardBytesError, embedCardInPng, validateCardBytes } from './cardbytes.js';
import { cleanCard } from './cardclean.js';
import { getVocabulary, hasVocabulary } from './vocabulary.js';
import { AccountError, accountProfileHandle, createBotbooruAccounts, createSaucepanAccounts } from './accounts.js';
import { JannyBrowserError, createJannyBrowser, parseJannyUrl } from './janny-browser.js';

/**
 * Default thumbnail cap. A 320px preview is 20-60 KB, so anything near this is
 * not a thumbnail. Adapters whose source has no preview endpoint raise it via
 * `maxThumbBytes` — Pygmalion serves full-resolution avatars of 40 KB to 4.3 MB
 * and its CDN ignores every resize parameter, so at 512 KB three quarters of
 * its grid failed to load.
 */
const DEFAULT_MAX_THUMB_BYTES = 512 * 1024;

/** Ceiling no adapter may exceed, so one source cannot dominate a small box. */
const HARD_MAX_THUMB_BYTES = 6 * 1024 * 1024;

/**
 * Signing scope for a merged-search cursor.
 *
 * Distinct from the per-source `cursor:<id>` scope so a single-source cursor can
 * never be replayed as a merged one, or the reverse.
 */
const MULTI_CURSOR_SCOPE = 'cursor:multi';
const BOTBOORU_ACCOUNT_SCOPE = 'account-result:botbooru';
const MAX_CARRIED_DEDUPE = 64;
const TERMINAL_ACCOUNT_PARTIALS = new Set([
    'account_profile_required',
    'botbooru_login_required',
    'botbooru_session_expired',
    'botbooru_nsfw_disabled',
]);

/**
 * @param {import('express').Router} router
 * @param {{ startedAt: number }} state
 */
export function createRouter(router, state) {
    const accounts = state.accounts ?? createBotbooruAccounts();
    const saucepanAccounts = state.saucepan ?? createSaucepanAccounts();
    const jannyBrowser = state.jannyBrowser ?? createJannyBrowser();

    router.get('/healthz', wrap(async (request, response) => {
        response.set('Cache-Control', 'no-store');
        const jannyCapability = typeof jannyBrowser.capability === 'function'
            ? await jannyBrowser.capability()
            : { available: false, reason: 'unsupported' };
        response.json({
            ok: true,
            protocol: PROTOCOL_VERSION,
            version: VERSION,
            uptimeMs: Date.now() - state.startedAt,
            capabilities: { jannyBrowser: jannyCapability },
            sources: describeSources(stateOf, reasonOf).map((source) => source.id === 'jannyai'
                ? { ...source, bridgeAllowed: request.user?.profile?.admin === true }
                : source),
        });
    }));

    // Clears one source's cooldown so the next request retries immediately.
    router.post('/retry', jsonGuard, wrap(async (request, response) => {
        const resolved = resolveSource(request, response);
        if (!resolved) {
            return;
        }
        reset(resolved.adapter.id);
        response.json({ ok: true, state: stateOf(resolved.adapter.id) });
    }));

    router.post('/account/status', jsonGuard, wrap(async (request, response) => {
        response.set('Cache-Control', 'no-store');
        const resolved = resolveAccountSource(request, response);
        if (!resolved) {
            return;
        }
        const handle = accountHandle(request, response);
        if (!handle) {
            return;
        }
        const store = accountStoreFor(resolved.adapter, accounts, saucepanAccounts);
        await respondWithAccount(response, () => store.status(handle));
    }));

    router.post('/account/login', jsonGuard, wrap(async (request, response) => {
        response.set('Cache-Control', 'no-store');
        const resolved = resolveAccountSource(request, response);
        if (!resolved) {
            return;
        }
        const handle = accountHandle(request, response);
        if (!handle) {
            return;
        }

        const limited = await consume('accountLogin', handle, { failClosed: true });
        if (!limited.allowed) {
            response.set('Retry-After', String(limited.retryAfterSeconds));
            fail(response, 429, 'rate_limited', { retryAfter: limited.retryAfterSeconds });
            return;
        }

        const store = accountStoreFor(resolved.adapter, accounts, saucepanAccounts);
        request.sbbsSignal.throwIfAborted();
        await respondWithAccount(response, () => store.login(
            handle,
            own(request.body, 'username'),
            own(request.body, 'password'),
        ));
    }));

    router.post('/account/token', jsonGuard, wrap(async (request, response) => {
        response.set('Cache-Control', 'no-store');
        const resolved = resolveAccountSource(request, response);
        if (!resolved) {
            return;
        }
        if (resolved.adapter.id !== 'saucepan') {
            fail(response, 400, 'account_action_unsupported');
            return;
        }
        const handle = accountHandle(request, response);
        if (!handle) {
            return;
        }
        const limited = await consume('accountLogin', handle, { failClosed: true });
        if (!limited.allowed) {
            response.set('Retry-After', String(limited.retryAfterSeconds));
            fail(response, 429, 'rate_limited', { retryAfter: limited.retryAfterSeconds });
            return;
        }
        request.sbbsSignal.throwIfAborted();
        await respondWithAccount(response, () => saucepanAccounts.setToken(handle, own(request.body, 'token')));
    }));

    router.post('/account/nsfw', jsonGuard, wrap(async (request, response) => {
        response.set('Cache-Control', 'no-store');
        const resolved = resolveAccountSource(request, response);
        if (!resolved) {
            return;
        }
        if (resolved.adapter.id !== 'botbooru') {
            fail(response, 400, 'account_action_unsupported');
            return;
        }
        const handle = accountHandle(request, response);
        if (!handle) {
            return;
        }
        const limited = await consume('accountMutation', handle, { failClosed: true });
        if (!limited.allowed) {
            response.set('Retry-After', String(limited.retryAfterSeconds));
            fail(response, 429, 'rate_limited', { retryAfter: limited.retryAfterSeconds });
            return;
        }
        request.sbbsSignal.throwIfAborted();
        await respondWithAccount(response, () => accounts.setNsfw(handle, own(request.body, 'enabled')));
    }));

    router.post('/account/logout', jsonGuard, wrap(async (request, response) => {
        response.set('Cache-Control', 'no-store');
        const resolved = resolveAccountSource(request, response);
        if (!resolved) {
            return;
        }
        const handle = accountHandle(request, response);
        if (!handle) {
            return;
        }
        const store = accountStoreFor(resolved.adapter, accounts, saucepanAccounts);
        await respondWithAccount(response, () => store.logout(handle));
    }));

    router.post('/janny/status', jsonGuard, wrap(async (request, response) => {
        response.set('Cache-Control', 'no-store');
        if (!requireJannyAdmin(request, response)) {
            return;
        }
        await respondWithJanny(response, () => jannyBrowser.status());
    }));

    router.post('/janny/login', jsonGuard, wrap(async (request, response) => {
        response.set('Cache-Control', 'no-store');
        if (!requireJannyAdmin(request, response)) {
            return;
        }
        await respondWithJanny(response, () => jannyBrowser.login());
    }));

    router.post('/janny/logout', jsonGuard, wrap(async (request, response) => {
        response.set('Cache-Control', 'no-store');
        if (!requireJannyAdmin(request, response)) {
            return;
        }
        await respondWithJanny(response, () => jannyBrowser.logout());
    }));

    router.post('/tags', jsonGuard, wrap(async (request, response) => {
        const resolved = resolveSource(request, response);
        if (!resolved) {
            return;
        }
        const { adapter } = resolved;

        if (adapter.capabilities.tagVocabulary !== true || typeof adapter.fetchVocabulary !== 'function') {
            response.json({ tags: [] });
            return;
        }

        const caller = callerKey(request);
        const limited = await consume('search', caller);
        if (!limited.allowed) {
            response.set('Retry-After', String(limited.retryAfterSeconds));
            fail(response, 429, 'rate_limited', { retryAfter: limited.retryAfterSeconds });
            return;
        }

        // A cache hit is local data and must remain available while a source is
        // cooling down. A cache miss has the same source-wide egress gates as a
        // search so a failed tags endpoint cannot be hammered independently.
        if (hasVocabulary(adapter)) {
            response.json({ tags: await getVocabulary(adapter) });
            return;
        }

        const gate = await gateSource(caller, adapter.id, request.sbbsSignal);
        if (!gate.ok) {
            fail(response, gate.code === 'source_down' ? 503 : 429, gate.code);
            return;
        }

        let tags;
        try {
            tags = await getVocabulary(
                adapter,
                // Vocabulary is optional metadata. Its 404/timeout must not
                // globally mark card search and import operations unhealthy.
                () => callAdapter(adapter, () => adapter.fetchVocabulary(contextFor(adapter)), { trackHealth: false }),
            );
        } finally {
            gate.release();
        }
        response.json({ tags });
    }));

    /**
     * Thumbnail proxy.
     *
     * A GET because it is an <img> src, which cannot carry a CSRF header —
     * and csrf-sync skips GET anyway. It takes a signed ref, never a URL: see
     * refs.js for why that distinction is the whole design.
     */
    router.get('/thumb', wrap(async (request, response) => {
        const sourceId = own(request.query, 'source');
        const adapter = typeof sourceId === 'string' ? getSource(sourceId) : null;
        if (!adapter || typeof adapter.thumbUrlFromRef !== 'function') {
            fail(response, 404, 'unknown_source');
            return;
        }

        // Verified before parsing: a ref we did not mint is never JSON.parse'd.
        const payload = verifyRef(adapter.id, own(request.query, 'ref'));
        if (!payload) {
            fail(response, 400, 'bad_ref');
            return;
        }

        const size = pick(own(request.query, 'size'), THUMB_SIZES, 'grid');
        const caller = callerKey(request);

        for (const [name, key] of [
            ['thumbUser', caller],
            ['thumbSource', adapter.id],
            ['thumbGlobal', 'all'],
        ]) {
            const limited = await consume(name, key, { failClosed: true });
            if (!limited.allowed) {
                response.set('Retry-After', String(limited.retryAfterSeconds));
                fail(response, 429, 'rate_limited');
                return;
            }
        }

        const disconnected = new AbortController();
        const abortOnDisconnect = () => disconnected.abort();
        request.once?.('aborted', abortOnDisconnect);
        response.once?.('close', abortOnDisconnect);

        const releases = [];
        const releaseAll = () => {
            while (releases.length > 0) {
                releases.pop()();
            }
            request.off?.('aborted', abortOnDisconnect);
            response.off?.('close', abortOnDisconnect);
        };

        let sent = false;
        try {
            const release = await acquireThumbnail(caller, adapter.id, { signal: disconnected.signal });
            if (!release) {
                fail(response, 503, 'busy');
                return;
            }
            releases.push(release);

            let url;
            try {
                url = adapter.thumbUrlFromRef(payload, size);
            } catch {
                fail(response, 400, 'bad_ref');
                return;
            }

            const maxBytes = Math.min(
                clampInt(adapter.maxThumbBytes, 1024, HARD_MAX_THUMB_BYTES, DEFAULT_MAX_THUMB_BYTES),
                HARD_MAX_THUMB_BYTES,
            );

            const fetchOptions = {
                accept: 'image/webp,image/png,image/jpeg,image/avif,image/gif;q=0.8,*/*;q=0.5',
                maxBytes,
                timeoutMs: 15000,
                signal: disconnected.signal,
            };
            let result;
            const sessionNonce = own(payload, 's');
            if (adapter.id === 'botbooru' && sessionNonce !== undefined) {
                response.set('Cache-Control', 'private, no-store');
                let ctx;
                try {
                    ctx = await accounts.thumbnailRequest(accountProfileHandle(request), sessionNonce);
                } catch (error) {
                    if (sendAccountError(response, error)) {
                        return;
                    }
                    throw error;
                }
                result = await ctx.fetchBytes(url, fetchOptions);
            } else {
                result = await fetchBytes(adapter, url, fetchOptions);
            }

            // Magic bytes decide, not the upstream header. SVG is not in the
            // whitelist, so an SVG labelled image/png is refused here.
            const contentType = detectImageType(result.buffer);
            if (!contentType) {
                fail(response, 415, 'not_an_image');
                return;
            }

            response.set({
                'Content-Type': contentType,
                'Content-Length': String(result.buffer.length),
                'X-Content-Type-Options': 'nosniff',
                // Per-response CSP works even though the app sets none globally.
                'Content-Security-Policy': "default-src 'none'; sandbox",
                'Cross-Origin-Resource-Policy': 'same-origin',
                // A protected response must re-check the live session on every
                // load. Public thumbnails can retain the original long cache.
                'Cache-Control': sessionNonce === undefined
                    ? 'private, max-age=86400, immutable'
                    : 'private, no-store',
            });
            response.once?.('finish', releaseAll);
            response.once?.('close', releaseAll);
            response.send(result.buffer);
            sent = true;
        } finally {
            if (!sent) {
                releaseAll();
            }
        }
    }));

    router.post('/search', jsonGuard, wrap(async (request, response) => {
        // A list means a merged search. One source keeps the original path,
        // including the browser-direct fallback, which cannot apply to a merge.
        const many = readSourceIds(request.body);
        if (many !== null) {
            if (many.length === 0) {
                fail(response, 400, 'bad_source');
                return;
            }
            await searchMany(request, response, many, accounts);
            return;
        }

        const resolved = resolveSource(request, response);
        if (!resolved) {
            return;
        }
        const { adapter } = resolved;

        if (!supportsSearch(adapter)) {
            fail(response, 400, 'search_unsupported');
            return;
        }

        let args;
        try {
            args = buildSearchArgs(adapter, request.body);
        } catch (error) {
            if (error instanceof BadCursorError) {
                fail(response, 400, 'bad_cursor');
                return;
            }
            throw error;
        }

        // The server cannot reach this source, but the browser can. Hand back the
        // URL to fetch instead of an error. No egress happens on this path, so it
        // deliberately runs before the gate: a source in cooldown is exactly when
        // this is needed.
        if (directPlanWanted(adapter, request.body)) {
            respondWithDirectPlan(response, adapter, 'search', args);
            return;
        }

        if (!isDown(adapter.id)) {
            try {
                preflightSearchFor(accounts, request, adapter, args);
            } catch (error) {
                if (sendAccountError(response, error)) {
                    return;
                }
                throw error;
            }
        }

        const gate = await gateRequest(request, response, adapter.id, 'search');
        if (!gate) {
            return;
        }

        let sourceRequest;
        try {
            try {
                sourceRequest = await searchRequestFor(accounts, request, adapter, args);
            } catch (error) {
                if (sendAccountError(response, error)) {
                    return;
                }
                throw error;
            }

            let result;
            try {
                result = await callAdapter(
                    adapter,
                    () => adapter.search(sourceRequest.context, args),
                    { ignoreAuthenticationFailure: sourceRequest.sessionNonce !== null, signal: request.sbbsSignal },
                );
            } catch (error) {
                if (error instanceof BadCursorError || error?.code === 'bad_cursor') {
                    fail(response, 400, 'bad_cursor');
                    return;
                }
                if (canReroute(adapter, error)) {
                    respondWithDirectPlan(response, adapter, 'search', args);
                    return;
                }
                const translated = authenticatedFailure(accounts, request, sourceRequest, error);
                if (translated) {
                    if (sendAccountError(response, translated)) {
                        return;
                    }
                }
                throw error;
            }

            response.json(shapeSearchResponse(adapter, result, args.limit, sourceRequest.sessionNonce));
        } finally {
            gate.release();
        }
    }));

    /**
     * Normalizes a payload the BROWSER fetched, for a source this server cannot
     * reach. The client sends bytes, never a URL, so this adds no way to make the
     * server request anything — and the payload runs through the same
     * hasForbiddenKey scan and the same adapter parser as the server-side path,
     * so the field whitelist in normalize.js still governs everything that
     * reaches the DOM.
     */
    router.post('/ingest', jsonGuardWithLimit(MAX_INGEST_BYTES), wrap(async (request, response) => {
        const resolved = resolveSource(request, response);
        if (!resolved) {
            return;
        }
        const { adapter } = resolved;

        if (adapter.corsDirect !== true) {
            fail(response, 400, 'direct_unsupported');
            return;
        }

        const kind = pick(own(request.body, 'kind'), INGEST_KINDS, '');
        if (kind === '') {
            fail(response, 400, 'bad_ingest_kind');
            return;
        }

        // This route receives the largest JSON body. The host parser has already
        // run, but rate-limit before recursively walking attacker-controlled data.
        const caller = callerKey(request);
        const limited = await consume('search', caller);
        if (!limited.allowed) {
            response.set('Retry-After', String(limited.retryAfterSeconds));
            fail(response, 429, 'rate_limited', { retryAfter: limited.retryAfterSeconds });
            return;
        }

        const payload = own(request.body, 'payload');
        if (payload === undefined || payload === null) {
            fail(response, 400, 'bad_payload');
            return;
        }
        if (hasForbiddenKey(payload)) {
            fail(response, 422, 'unsafe_json');
            return;
        }

        if (kind === 'detail') {
            if (typeof adapter.parseDetail !== 'function') {
                fail(response, 400, 'direct_unsupported');
                return;
            }
            const id = readId(adapter, request.body);
            if (id === null) {
                fail(response, 400, 'bad_id');
                return;
            }
            const detail = adapter.parseDetail(payload, id);
            if (!isExpectedDetail(adapter, id, detail)) {
                fail(response, 502, 'bad_json');
                return;
            }
            response.json(detail);
            return;
        }

        if (typeof adapter.parseSearch !== 'function') {
            fail(response, 400, 'direct_unsupported');
            return;
        }

        let args;
        try {
            args = buildSearchArgs(adapter, request.body);
        } catch (error) {
            if (error instanceof BadCursorError) {
                fail(response, 400, 'bad_cursor');
                return;
            }
            throw error;
        }

        response.json(shapeSearchResponse(adapter, adapter.parseSearch(payload, args), args.limit));
    }));

    /**
     * Downloads and validates card bytes for a source Neconyan cannot import
     * by URL itself. This is the only route that hands the browser something it
     * will feed into the character importer, so everything here is deliberate:
     * the URL comes from the adapter's own base, the bytes are structurally
     * validated before they are sent, and nothing is re-encoded (re-encoding a
     * PNG would strip the embedded card, which IS the character).
     */
    router.post('/card', jsonGuard, wrap(async (request, response) => {
        const resolved = resolveSource(request, response);
        if (!resolved) {
            return;
        }
        const { adapter } = resolved;

        // Native sources must go through Neconyan's own importer, which is
        // already hardened. Offering a second path would only add surface.
        if (adapter.nativeImport === true) {
            fail(response, 400, 'use_native_import');
            return;
        }

        const id = readId(adapter, request.body);
        if (id === null) {
            fail(response, 400, 'bad_id');
            return;
        }

        const gate = await gateRequest(request, response, adapter.id, 'card');
        if (!gate) {
            return;
        }

        try {
            const ctx = contextFor(adapter, { signal: request.sbbsSignal });
            const target = adapter.getImportTarget(ctx, id);

            /** @type {Buffer} */
            let buffer;

            if (target?.kind === 'bytes' && typeof target.url === 'string') {
                const result = await callAdapter(adapter, () => ctx.fetchBytes(target.url, {
                    accept: 'image/png,application/json;q=0.9,*/*;q=0.5',
                    maxBytes: MAX_CARD_BYTES,
                    timeoutMs: 20000,
                }), { trackHealth: false, signal: request.sbbsSignal });
                buffer = result.buffer;
            } else if (target?.kind === 'inline' && typeof adapter.buildCard === 'function') {
                // Some sources publish full card data but no downloadable file.
                // The adapter assembles a card from it; the result then goes
                // through exactly the same validation as a downloaded one, so
                // this path is not a way to bypass any of the checks.
                const card = await callAdapter(adapter, () => adapter.buildCard(ctx, id), {
                    trackHealth: false, signal: request.sbbsSignal,
                });
                buffer = Buffer.from(JSON.stringify(card), 'utf8');
                if (buffer.length > MAX_CARD_BYTES) {
                    fail(response, 422, 'too_large');
                    return;
                }
            } else {
                fail(response, 500, 'bad_import_target');
                return;
            }

            let verdict;
            try {
                verdict = validateCardBytes(buffer, target.expect === 'json' ? 'json' : 'png');
            } catch (error) {
                if (error instanceof CardBytesError) {
                    console.warn(`[BotSearcher] ${adapter.id} card rejected: ${error.code} (${error.detail ?? ''})`);
                    fail(response, 422, error.code);
                    return;
                }
                throw error;
            }

            response.set({
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(buffer.length),
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': "default-src 'none'; sandbox",
                'Content-Disposition': `attachment; filename="${cardFileName(adapter.id, id, verdict.kind)}"`,
                // Tells the client which extension to declare on import. The
                // contents report is NOT sent here: it now carries the card's
                // own prompt text for measuring, which no header could hold.
                // The client posts these bytes to /inspect for that.
                'X-SBBS-Card-Kind': verdict.kind,
            });
            response.send(buffer);
        } finally {
            gate.release();
        }
    }));

    router.post('/url-card', jsonGuard, wrap(async (request, response) => {
        const resolved = resolveSource(request, response);
        if (!resolved) {
            return;
        }
        const { adapter } = resolved;
        const janny = adapter.id === 'jannyai';
        if (janny && !requireJannyAdmin(request, response)) {
            logJannyUrlCardFailure('janny_admin_required');
            return;
        }
        const rawUrl = own(request.body, 'url');
        const parsed = janny
            ? parseJannyUrl(rawUrl)
            : (typeof adapter.parseImportUrl === 'function' ? adapter.parseImportUrl(rawUrl) : null);
        if (!parsed) {
            if (janny) {
                logJannyUrlCardFailure('bad_import_url');
            }
            fail(response, 400, 'bad_import_url');
            return;
        }

        const gate = await gateRequest(request, response, adapter.id, 'card', {
            allowDown: janny,
        });
        if (!gate) {
            if (janny) {
                logJannyUrlCardFailure('refused_by_rate_limit_or_busy_gate', `HTTP ${response.statusCode}`, parsed.id);
            }
            return;
        }

        try {
            let card;
            let avatarPng = null;
            let sourceRequest;
            try {
                if (adapter.id === 'jannyai') {
                    ({ card, avatarPng = null } = await jannyBrowser.fetchCard(rawUrl));
                } else if (adapter.id === 'saucepan') {
                    const handle = accountProfileHandle(request);
                    sourceRequest = saucepanAccounts.cardRequest(handle, { signal: request.sbbsSignal });
                    card = await adapter.buildCard(sourceRequest.context, parsed.id);
                } else {
                    fail(response, 400, 'url_import_unsupported');
                    return;
                }
            } catch (error) {
                if (sendAccountError(response, error)) {
                    return;
                }
                if (error instanceof JannyBrowserError) {
                    logJannyUrlCardFailure(error.code, error.detail, parsed.id);
                    fail(response, error.status, error.code);
                    return;
                }
                if (adapter.id === 'saucepan' && error instanceof UpstreamError && error.code === 'http_error'
                    && String(error.detail) === '401') {
                    saucepanAccounts.invalidate(accountProfileHandle(request), sourceRequest.sessionVersion);
                    fail(response, 401, 'saucepan_session_expired');
                    return;
                }
                throw error;
            }

            // With a portrait the card travels inside a PNG so the host keeps
            // the picture; without one it is plain JSON and the host uses its
            // generic portrait.
            let buffer;
            let verdict;
            try {
                buffer = Buffer.isBuffer(avatarPng)
                    ? embedCardInPng(avatarPng, card)
                    : Buffer.from(JSON.stringify(card), 'utf8');
                if (buffer.length > MAX_CARD_BYTES) {
                    if (janny) {
                        logJannyUrlCardFailure('too_large', `${buffer.length} bytes`, parsed.id);
                    }
                    fail(response, 422, 'too_large');
                    return;
                }
                verdict = validateCardBytes(buffer, Buffer.isBuffer(avatarPng) ? 'png' : 'json');
            } catch (error) {
                if (error instanceof CardBytesError) {
                    if (janny) {
                        logJannyUrlCardFailure(error.code, error.detail, parsed.id);
                    }
                    fail(response, 422, error.code);
                    return;
                }
                throw error;
            }

            response.set({
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(buffer.length),
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': "default-src 'none'; sandbox",
                'Content-Disposition': `attachment; filename="${cardFileName(adapter.id, parsed.id, verdict.kind)}"`,
                'X-SBBS-Card-Kind': verdict.kind,
            });
            response.send(buffer);
        } finally {
            gate.release();
        }
    }));

    /**
     * Reports what is inside card bytes the browser already holds.
     *
     * Unlike every other route here, this one names no source and makes no
     * outbound request of any kind — it is a parser, nothing more. That is what
     * lets it serve all three ways a card reaches the browser: a native source
     * downloaded by Neconyan's own importer route, a byte-card from /card, and
     * a file the user obtained somewhere else entirely.
     *
     * It sends back no bytes, so it cannot become a second path into the
     * character importer.
     */
    router.post('/inspect', rawGuard(MAX_CARD_BYTES), wrap(async (request, response) => {
        const limited = await consume('search', callerKey(request));
        if (!limited.allowed) {
            response.set('Retry-After', String(limited.retryAfterSeconds));
            fail(response, 429, 'rate_limited', { retryAfter: limited.retryAfterSeconds });
            return;
        }

        let verdict;
        try {
            verdict = validateCardBytes(request.rawBody);
        } catch (error) {
            if (error instanceof CardBytesError) {
                fail(response, 422, error.code);
                return;
            }
            throw error;
        }

        response.set('Cache-Control', 'no-store');
        response.json({ kind: verdict.kind, spec: verdict.spec, inside: verdict.inside });
    }));

    /**
     * Returns the same card with the fixed clean profile applied.
     *
     * Separate from /inspect so the common path never pays for a rewrite the
     * user did not ask for. The client already knows what will go, from the
     * report, so the response is bytes alone.
     */
    router.post('/clean', rawGuard(MAX_CARD_BYTES), wrap(async (request, response) => {
        const limited = await consume('card', callerKey(request), { failClosed: true });
        if (!limited.allowed) {
            response.set('Retry-After', String(limited.retryAfterSeconds));
            fail(response, 429, 'rate_limited', { retryAfter: limited.retryAfterSeconds });
            return;
        }

        let cleaned;
        try {
            cleaned = cleanCard(request.rawBody);
        } catch (error) {
            if (error instanceof CardBytesError) {
                fail(response, 422, error.code);
                return;
            }
            throw error;
        }

        response.set({
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(cleaned.buffer.length),
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'Cache-Control': 'no-store',
        });
        response.send(cleaned.buffer);
    }));

    router.post('/detail', jsonGuard, wrap(async (request, response) => {
        const resolved = resolveSource(request, response);
        if (!resolved) {
            return;
        }
        const { adapter } = resolved;

        if (!adapter.capabilities.detail || typeof adapter.getDetail !== 'function') {
            fail(response, 400, 'detail_unsupported');
            return;
        }

        const id = readId(adapter, request.body);
        if (id === null) {
            fail(response, 400, 'bad_id');
            return;
        }

        if (directPlanWanted(adapter, request.body) && typeof adapter.buildDetailUrl === 'function') {
            respondWithDirectPlan(response, adapter, 'detail', null, id);
            return;
        }

        const gate = await gateRequest(request, response, adapter.id, 'search');
        if (!gate) {
            return;
        }

        try {
            let sourceRequest;
            try {
                sourceRequest = await detailRequestFor(accounts, request, adapter, id);
            } catch (error) {
                if (sendAccountError(response, error)) {
                    return;
                }
                throw error;
            }
            let detail;
            try {
                detail = await callAdapter(adapter, () => adapter.getDetail(sourceRequest.context, id), {
                    trackHealth: false, signal: request.sbbsSignal,
                });
            } catch (error) {
                if (canReroute(adapter, error) && typeof adapter.buildDetailUrl === 'function') {
                    respondWithDirectPlan(response, adapter, 'detail', null, id);
                    return;
                }
                const translated = authenticatedFailure(accounts, request, sourceRequest, error);
                if (translated) {
                    if (sendAccountError(response, translated)) {
                        return;
                    }
                }
                throw error;
            }
            if (!isExpectedDetail(adapter, id, detail)) {
                fail(response, 502, 'bad_json');
                return;
            }
            response.json(bindProtectedRef(adapter, detail, sourceRequest.sessionNonce));
        } finally {
            gate.release();
        }
    }));
}

/**
 * Builds the adapter argument set from a request body. Shared by /search and
 * /ingest so the direct path cannot end up with different arguments than the
 * server path would have used — the cursor, limit and filters are re-derived
 * from the body both times rather than echoed back by the client.
 *
 * @throws {BadCursorError} when the cursor is not one this server minted
 */
function buildSearchArgs(adapter, body, { parseCursor = true } = {}) {
    const filters = isPlainObject(own(body, 'filters')) ? own(body, 'filters') : {};
    const rawQuery = own(body, 'query');
    const rawCursor = own(body, 'cursor');
    let cursor = null;

    if (parseCursor && rawCursor !== undefined && rawCursor !== null) {
        cursor = verifyCursor(adapter.id, rawCursor);
        if (cursor === null) {
            throw new BadCursorError();
        }
    }

    return {
        // Cap before the adapter sees it, so no adapter can be tricked into
        // building a giant upstream URL.
        query: typeof rawQuery === 'string' ? rawQuery.slice(0, 128).trim() : '',
        limit: clampInt(own(body, 'limit'), 1, FIELD_LIMITS.itemsPerPage, 24),
        cursor,
        sort: pick(own(body, 'sort'), adapter.capabilities.sorts, adapter.capabilities.sorts[0]),
        // Only honour a filter the source can actually apply, so the UI is
        // never able to imply filtering that is not happening.
        sfwOnly: adapter.capabilities.sfwToggle
            ? (adapter.capabilities.nsfwRequiresAccount === true
                ? own(filters, 'sfwOnly') !== false
                : own(filters, 'sfwOnly') === true)
            : false,
        hideAi: adapter.capabilities.hideAiToggle ? own(filters, 'hideAi') === true : false,
        filters: readFilters(filters, adapter.capabilities.filters),
    };
}

/** Shapes an adapter search result into the wire response. */
function shapeSearchResponse(adapter, result, limit, sessionNonce = null) {
    return {
        total: typeof result?.total === 'number' && Number.isFinite(result.total)
            ? Math.max(0, Math.floor(result.total))
            : null,
        nextCursor: result?.next && typeof result.next === 'object'
            ? mintCursor(adapter.id, result.next)
            : null,
        items: Array.isArray(result?.items)
            ? result.items
                .filter((item) => item?.source === adapter.id)
                .slice(0, limit)
                .map((item) => bindProtectedRef(adapter, item, sessionNonce))
            : [],
    };
}

function bindProtectedRef(adapter, record, sessionNonce) {
    if (adapter.id !== 'botbooru' || typeof sessionNonce !== 'string' || typeof record?.id !== 'string') {
        return record;
    }

    const accountRef = mintToken(BOTBOORU_ACCOUNT_SCOPE, { i: record.id, s: sessionNonce });
    let protectedRecord = accountRef ? { ...record, accountRef } : record;
    if (typeof record.thumbRef !== 'string') {
        return protectedRecord;
    }
    const payload = verifyRef(adapter.id, record.thumbRef);
    if (!payload) {
        return protectedRecord;
    }
    const thumbRef = mintRef(adapter.id, { ...payload, s: sessionNonce });
    if (thumbRef) {
        protectedRecord = { ...protectedRecord, thumbRef };
    }
    return protectedRecord;
}

/**
 * Whether to hand this request to the browser instead of fetching it here.
 *
 * True when the source supports it AND either the breaker already knows this
 * server is blocked, or the user has chosen to always route this source through
 * their browser. Not a fallback the client can demand for an arbitrary source:
 * `corsDirect` is declared in the adapter, in this repo.
 */
function directPlanWanted(adapter, body) {
    if (adapter.corsDirect !== true || typeof adapter.buildSearchUrl !== 'function') {
        return false;
    }
    if (own(body, 'route') === 'direct') {
        return true;
    }
    return isDown(adapter.id) && REROUTABLE_FAILURES.has(reasonOf(adapter.id));
}

/** Whether a failure that just happened is worth retrying from the browser. */
function canReroute(adapter, error) {
    return adapter.corsDirect === true
        && typeof adapter.buildSearchUrl === 'function'
        && REROUTABLE_FAILURES.has(classify(error));
}

/**
 * Tells the client to fetch this URL itself and post the result back to /ingest.
 *
 * The URL is built here, from the adapter's own fixed base — the client never
 * constructs one. It re-checks the host against the source's published
 * clientHosts before fetching anyway, the same double-check images already get.
 */
function respondWithDirectPlan(response, adapter, kind, args, id) {
    const url = kind === 'detail'
        ? adapter.buildDetailUrl(id)
        : adapter.buildSearchUrl(args);

    response.json({
        mode: 'direct',
        kind,
        url: String(url),
        reason: reasonOf(adapter.id) ?? 'forbidden',
    });
}

/**
 * Reads the `sources` list for a merged search, or null when this is an
 * ordinary single-source request.
 *
 * Unknown ids are dropped rather than refused: sources come and go between
 * releases, and one stale entry in a saved selection should narrow the search,
 * not break it.
 *
 * @returns {string[] | null}
 */
function readSourceIds(body) {
    const raw = own(body, 'sources');
    if (!Array.isArray(raw)) {
        return null;
    }

    const seen = new Set();
    for (const id of raw) {
        if (typeof id !== 'string' || id === '' || id.length > 64 || seen.has(id)) {
            continue;
        }
        if (getSource(id)) {
            seen.add(id);
        }
        if (seen.size >= MAX_FANOUT) {
            break;
        }
    }

    return [...seen];
}

/**
 * Runs one search across several sources and merges the results.
 *
 * Every source is gated, rate-limited and breaker-checked on its own, and a
 * source that fails is reported in `partial` rather than failing the whole
 * search. One site being down should cost the user that site's results, not
 * their query.
 */
async function searchMany(request, response, ids, accounts) {
    const body = request.body;
    const rawCursor = own(body, 'cursor');
    const limit = clampInt(own(body, 'limit'), 1, FIELD_LIMITS.itemsPerPage, 24);
    const partial = ids.filter((id) => !supportsSearch(getSource(id)))
        .map((source) => ({ source, error: 'search_unsupported' }));
    ids = ids.filter((id) => supportsSearch(getSource(id)));
    /** @type {Record<string, unknown> | null} */
    let carried = null;
    let carriedDedupe = [];

    if (rawCursor !== undefined && rawCursor !== null) {
        const parsed = verifyToken(MULTI_CURSOR_SCOPE, rawCursor);
        const perSource = own(parsed, 's');
        // Each entry is [page size, upstream cursor]. Page-number APIs must
        // retain their original size even after other sources are exhausted.
        if (!isPlainObject(perSource) || Object.values(perSource).some((entry) => !Array.isArray(entry)
            || entry.length !== 2 || !Number.isSafeInteger(entry[0]) || entry[0] < 1
            || entry[0] > limit || (entry[1] !== null && !isPlainObject(entry[1])))) {
            fail(response, 400, 'bad_cursor');
            return;
        }
        const priorDedupe = own(parsed, 'd');
        if (priorDedupe !== undefined) {
            if (!Array.isArray(priorDedupe)
                || priorDedupe.length > MAX_CARRIED_DEDUPE
                || priorDedupe.some((value) => typeof value !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(value))) {
                fail(response, 400, 'bad_cursor');
                return;
            }
            carriedDedupe = priorDedupe;
        }
        carried = perSource;
        // Only sources that offered a next page stay in the search. The rest are
        // exhausted, and asking them again would repeat their first page.
        ids = Object.keys(perSource).filter((id) => ids.includes(id));
    }

    if (ids.length === 0) {
        response.json({ total: null, nextCursor: null, items: [], partial });
        return;
    }

    const shares = sharePageBudget(limit, ids.length);
    const pageSizes = new Map(ids.map((id, index) => [id, carried ? own(carried, id)[0] : shares[index]]));
    const sorts = isPlainObject(own(body, 'sorts')) ? own(body, 'sorts') : {};
    const caller = callerKey(request);

    // One search costs one search, however many sources it touches. The
    // per-source limiters below still keep any single site from being hammered.
    const perUser = await consume('search', caller);
    if (!perUser.allowed) {
        response.set('Retry-After', String(perUser.retryAfterSeconds));
        fail(response, 429, 'rate_limited', { retryAfter: perUser.retryAfterSeconds });
        return;
    }

    const nextBySource = Object.create(null);
    let budget = limit;
    // Deferred sources go first next time. Never fetch and advance a source
    // whose results would be discarded by the merged page's size limit.
    const scheduled = ids.filter((id) => {
        const size = pageSizes.get(id);
        if (size > budget) {
            nextBySource[id] = carried ? own(carried, id) : [size, null];
            return false;
        }
        budget -= size;
        return true;
    });

    const settled = await Promise.all(scheduled.map(async (id) => {
        const adapter = getSource(id);
        const args = {
            ...buildSearchArgs(adapter, body, { parseCursor: false }),
            limit: pageSizes.get(id),
            // Each source sorts by its own vocabulary; there is no shared one.
            sort: pick(own(sorts, id), adapter.capabilities.sorts, adapter.capabilities.sorts[0]),
            cursor: carried ? own(carried, id)[1] : null,
        };

        if (!isDown(id)) {
            try {
                preflightSearchFor(accounts, request, adapter, args);
            } catch (error) {
                return { id, error: partialErrorCode(error) };
            }
        }

        const gate = await gateSource(caller, id, request.sbbsSignal);
        if (!gate.ok) {
            return { id, error: gate.code };
        }

        let sourceRequest;
        try {
            try {
                sourceRequest = await searchRequestFor(accounts, request, adapter, args);
            } catch (error) {
                return { id, error: partialErrorCode(error) };
            }
            const result = await callAdapter(
                adapter,
                () => adapter.search(sourceRequest.context, args),
                { ignoreAuthenticationFailure: sourceRequest.sessionNonce !== null, signal: request.sbbsSignal },
            );
            return { id, result, sessionNonce: sourceRequest.sessionNonce };
        } catch (error) {
            const translated = authenticatedFailure(accounts, request, sourceRequest, error);
            return { id, error: partialErrorCode(translated ?? error) };
        } finally {
            gate.release();
        }
    }));

    const groups = [];
    let total = 0;
    let totalKnown = partial.length === 0 && scheduled.length === ids.length;
    let succeeded = false;

    for (const outcome of settled) {
        if (outcome.error) {
            partial.push({ source: outcome.id, error: outcome.error });
            // Keep the prior cursor (or a null first-page marker) so a transient
            // failure can rejoin a later page instead of disappearing forever.
            if (!TERMINAL_ACCOUNT_PARTIALS.has(outcome.error)) {
                nextBySource[outcome.id] = carried
                    ? own(carried, outcome.id)
                    : [pageSizes.get(outcome.id), null];
            }
            totalKnown = false;
            continue;
        }
        succeeded = true;
        const items = Array.isArray(outcome.result?.items)
            ? outcome.result.items
                .filter((item) => item?.source === outcome.id)
                .map((item) => bindProtectedRef(getSource(outcome.id), item, outcome.sessionNonce))
            : [];
        groups.push({ source: outcome.id, items });

        if (isPlainObject(outcome.result?.next)) {
            nextBySource[outcome.id] = [pageSizes.get(outcome.id), outcome.result.next];
        }
        // A sum across sources counts mirrored cards more than once, so it is
        // reported as what it is: how many the sources between them claim.
        if (typeof outcome.result?.total === 'number' && Number.isFinite(outcome.result.total)) {
            total += Math.max(0, Math.floor(outcome.result.total));
        } else {
            totalKnown = false;
        }
    }

    // Interleave first, then dedupe, so the surviving copy of a mirrored card is
    // the one from the source the user listed first.
    const seen = new Set(carriedDedupe);
    const items = dedupe(interleave(groups, limit), seen, identityFingerprint);
    const remaining = Object.keys(nextBySource);
    const dedupeState = [...seen].slice(-MAX_CARRIED_DEDUPE);

    response.json({
        total: succeeded && totalKnown ? total : null,
        nextCursor: remaining.length > 0
            ? mintToken(MULTI_CURSOR_SCOPE, { s: nextBySource, d: dedupeState })
            : null,
        items,
        partial,
    });
}

/** Per-source gate for a merged search: the same checks, reported not thrown. */
async function gateSource(caller, sourceId, signal) {
    signal?.throwIfAborted();
    if (isDown(sourceId)) {
        return { ok: false, code: 'source_down' };
    }

    const perSource = await consume('sourceGlobal', sourceId);
    if (!perSource.allowed) {
        return { ok: false, code: 'source_busy' };
    }

    const release = await acquire('source', sourceId, { signal });
    if (!release) {
        signal?.throwIfAborted();
        return { ok: false, code: 'source_busy' };
    }
    if (signal?.aborted || isDown(sourceId)) {
        release();
        signal?.throwIfAborted();
        return { ok: false, code: 'source_down' };
    }

    return { ok: true, release };
}

/** The classification a partial failure may carry, with details stripped. */
function partialErrorCode(error) {
    if (error instanceof AccountError) {
        return error.code;
    }
    if (error instanceof BadCursorError || error?.code === 'bad_cursor') {
        return 'bad_cursor';
    }
    if (error instanceof UpstreamError) {
        return SAFE_UPSTREAM_CODES.has(error.code) ? error.code : 'upstream_failed';
    }
    return 'upstream_failed';
}

async function respondWithAccount(response, operation) {
    try {
        response.json(await operation());
    } catch (error) {
        if (!sendAccountError(response, error)) {
            throw error;
        }
    }
}

async function respondWithJanny(response, operation) {
    try {
        response.json(await operation());
    } catch (error) {
        if (error instanceof JannyBrowserError) {
            fail(response, error.status, error.code);
            return;
        }
        throw error;
    }
}

// The client only receives an error code, so the server log is the one place
// that says why a JannyAI link import failed.
export function logJannyUrlCardFailure(code, detail, id) {
    const card = typeof id === 'string' && id ? ` for ${id}` : '';
    const reason = typeof detail === 'string' && detail.trim()
        ? ` (${detail.replace(/\s+/g, ' ').trim().slice(0, 300)})`
        : '';
    console.warn(`[BotSearcher] JannyAI link import failed${card}: ${code}${reason}`);
}

function requireJannyAdmin(request, response) {
    if (request.user?.profile?.admin === true) {
        return true;
    }
    response.set('Cache-Control', 'no-store');
    fail(response, 403, 'janny_admin_required');
    return false;
}

function supportsSearch(adapter) {
    return adapter?.capabilities.search === true && typeof adapter.search === 'function';
}

function sendAccountError(response, error) {
    if (!(error instanceof AccountError)) {
        return false;
    }
    fail(response, error.status, error.code);
    return true;
}

function resolveAccountSource(request, response) {
    const resolved = resolveSource(request, response);
    if (!resolved) {
        return null;
    }
    if (resolved.adapter.capabilities.accountLogin !== true) {
        fail(response, 400, 'account_unsupported');
        return null;
    }
    return resolved;
}

function accountStoreFor(adapter, botbooruAccounts, saucepanAccounts) {
    return adapter.id === 'saucepan' ? saucepanAccounts : botbooruAccounts;
}

function accountHandle(request, response) {
    const handle = accountProfileHandle(request);
    if (handle === null) {
        fail(response, 401, 'account_profile_required');
    }
    return handle;
}

async function searchRequestFor(accounts, request, adapter, args) {
    if (adapter.id !== 'botbooru' || adapter.capabilities.nsfwRequiresAccount !== true) {
        return { context: contextFor(adapter, { signal: request.sbbsSignal }), sessionNonce: null };
    }
    return accounts.searchRequest(accountProfileHandle(request), args.sfwOnly, { signal: request.sbbsSignal });
}

function preflightSearchFor(accounts, request, adapter, args) {
    if (adapter.id === 'botbooru' && adapter.capabilities.nsfwRequiresAccount === true
        && typeof accounts.preflightSearch === 'function') {
        accounts.preflightSearch(accountProfileHandle(request), args.sfwOnly);
    }
}

async function detailRequestFor(accounts, request, adapter, id) {
    if (adapter.id !== 'botbooru' || adapter.capabilities.accountLogin !== true) {
        return { context: contextFor(adapter, { signal: request.sbbsSignal }), sessionNonce: null };
    }
    const ref = own(request.body, 'accountRef');
    if (ref === undefined) {
        return accounts.detailRequest(accountProfileHandle(request), null, { signal: request.sbbsSignal });
    }
    const payload = verifyToken(BOTBOORU_ACCOUNT_SCOPE, ref);
    const protectedId = own(payload, 'i');
    const sessionNonce = own(payload, 's');
    if (protectedId !== id || typeof sessionNonce !== 'string') {
        throw new AccountError('botbooru_account_changed', 409);
    }
    return accounts.detailRequest(accountProfileHandle(request), sessionNonce, { signal: request.sbbsSignal });
}

function authenticatedFailure(accounts, request, sourceRequest, error) {
    if (typeof sourceRequest?.sessionNonce !== 'string'
        || !(error instanceof UpstreamError)
        || error.code !== 'http_error'
        || String(error.detail) !== '401') {
        return null;
    }
    accounts.invalidate(accountProfileHandle(request), sourceRequest.sessionNonce);
    return new AccountError('botbooru_session_expired', 401);
}

/**
 * Resolves and validates the `source` field, answering the client on failure.
 * @returns {{ adapter: any } | null}
 */
function resolveSource(request, response) {
    const parsed = readSourceId(request.body);
    if (!parsed.ok) {
        fail(response, 400, parsed.code);
        return null;
    }

    const adapter = getSource(parsed.source);
    if (!adapter) {
        fail(response, 404, 'unknown_source');
        return null;
    }

    return { adapter };
}

/**
 * Validates a card id against the adapter's own anchored pattern BEFORE it is
 * interpolated into any URL.
 * @returns {string | null}
 */
function readId(adapter, body) {
    const id = own(body, 'id');
    if (typeof id !== 'string' || id === '' || id.length > FIELD_LIMITS.id) {
        return null;
    }
    return adapter.idPattern.test(id) ? id : null;
}

/** Ensures a detail response cannot silently switch the selected source/card. */
function isExpectedDetail(adapter, id, detail) {
    return isPlainObject(detail) && detail.source === adapter.id && detail.id === id;
}

/**
 * A filename the client can hand to the importer. Built from values we control
 * — never from anything upstream sent — so no sanitizer is needed.
 */
function cardFileName(sourceId, id, kind) {
    const slug = String(id).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64) || 'card';
    return `${sourceId}-${slug}.${kind === 'json' ? 'json' : 'png'}`;
}

/**
 * Runs an adapter call and records the outcome with the circuit breaker, so a
 * source that has gone away stops being retried on every keystroke.
 */
async function callAdapter(adapter, fn, { trackHealth = true, ignoreAuthenticationFailure = false, signal } = {}) {
    try {
        signal?.throwIfAborted();
        const result = await fn();
        signal?.throwIfAborted();
        if (trackHealth) {
            markSuccess(adapter.id);
        }
        return result;
    } catch (error) {
        if (signal?.aborted || error?.code === 'aborted' || error?.name === 'AbortError'
            || error instanceof AccountError || error instanceof BadCursorError || error?.code === 'bad_cursor') {
            throw error;
        }
        const authenticationFailure = ignoreAuthenticationFailure
            && error instanceof UpstreamError
            && error.code === 'http_error'
            && ['401', '403'].includes(String(error.detail));
        if (trackHealth && !authenticationFailure) {
            markFailure(adapter.id, error);
        }
        throw error;
    }
}

/**
 * Applies the breaker, the per-user limit, the per-source limit and the
 * in-flight cap.
 * @returns {Promise<{ release: () => void } | null>}
 */
async function gateRequest(request, response, sourceId, limiterName, { allowDown = false } = {}) {
    request.sbbsSignal?.throwIfAborted();
    // While a source is in cooldown, answer immediately and make no outbound
    // request at all.
    if (!allowDown && isDown(sourceId)) {
        fail(response, 503, 'source_down');
        return null;
    }

    const caller = callerKey(request);

    const perUser = await consume(limiterName, caller);
    if (!perUser.allowed) {
        response.set('Retry-After', String(perUser.retryAfterSeconds));
        fail(response, 429, 'rate_limited', { retryAfter: perUser.retryAfterSeconds });
        return null;
    }

    const perSource = await consume('sourceGlobal', sourceId);
    if (!perSource.allowed) {
        response.set('Retry-After', String(perSource.retryAfterSeconds));
        fail(response, 429, 'source_busy', { retryAfter: perSource.retryAfterSeconds });
        return null;
    }

    const release = await acquire('source', sourceId, { signal: request.sbbsSignal });
    if (!release) {
        request.sbbsSignal?.throwIfAborted();
        fail(response, 503, 'source_busy');
        return null;
    }
    if (request.sbbsSignal?.aborted || (!allowDown && isDown(sourceId))) {
        release();
        request.sbbsSignal?.throwIfAborted();
        fail(response, 503, 'source_down');
        return null;
    }

    return { release };
}
