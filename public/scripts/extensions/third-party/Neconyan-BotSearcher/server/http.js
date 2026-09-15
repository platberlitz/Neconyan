/**
 * The single point at which this plugin talks to the outside world.
 *
 * Adapters never import a fetch implementation; they are handed `fetchJson` /
 * `fetchBytes` bound to their own adapter object, so every request is checked
 * against that adapter's own allow-list. A URL that did not come from an
 * adapter's own base cannot be fetched at all — there is no code path that
 * accepts a URL from the client.
 *
 * node-fetch rather than global fetch on purpose: Neconyan's
 * initPrivateRequestFilter() patches http/https.globalAgent
 * (src/private-request-filter.js), which node-fetch honours and native fetch
 * does not. It is off by default, so this is defence in depth, never a control.
 */

import nodeFetch from 'node-fetch';

import { FIELD_LIMITS, MAX_REQUEST_BYTES } from '../shared/schema.js';
import { hasForbiddenKey } from './validate.js';
import { UpstreamError } from './guards.js';

export { UpstreamError };

/** Fixed and literal. Never derived from an incoming request. */
const BASE_HEADERS = Object.freeze({
    'Accept-Language': 'en-US,en;q=0.9',
    // Several card sites sit behind Cloudflare and reject unknown agents.
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
});

const MAX_REDIRECTS = 2;
const METHODS = new Set(['GET', 'POST', 'PATCH']);
const CONTENT_TYPES = new Set(['application/json', 'application/x-www-form-urlencoded']);

/**
 * Public service authorization is fixed here rather than supplied by adapters.
 * The JannyAI key is published by its own web clients and grants read-only
 * search access. It is still scoped like a credential so it cannot be replayed
 * to another endpoint or after a redirect.
 */
const PUBLIC_AUTH = Object.freeze({
    jannyai: Object.freeze({
        host: 'search.jannyai.com',
        pathname: '/multi-search',
        method: 'POST',
        contentType: 'application/json',
        token: '88a6463b66e04fb07ba87ee3db06af337f492ce511d93df6e2d2968cb2ff2b30',
    }),
});

function publicBearerFor(adapter, url, method, contentType) {
    const profile = PUBLIC_AUTH[adapter.id];
    if (!profile) {
        return undefined;
    }

    // This override only lets hardening tests use a throwaway local server. No
    // shipped adapter may carry allowInsecureForTests (asserted by the suite).
    const host = adapter.allowInsecureForTests === true && typeof adapter.publicAuthHostForTests === 'string'
        ? adapter.publicAuthHostForTests.toLowerCase()
        : profile.host;
    return url.hostname.toLowerCase() === host
        && url.pathname === profile.pathname
        && url.search === ''
        && method === profile.method
        && contentType === profile.contentType
        ? profile.token
        : undefined;
}

function requestShape(adapter, url, options) {
    const method = typeof options.method === 'string' ? options.method.toUpperCase() : 'GET';
    if (!METHODS.has(method)) {
        throw new UpstreamError('method_not_allowed', adapter.id);
    }

    const body = options.body;
    if (method === 'GET' && body !== undefined) {
        throw new UpstreamError('body_not_allowed', adapter.id);
    }
    if (method !== 'GET' && (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES)) {
        throw new UpstreamError('bad_request_body', adapter.id);
    }

    const contentType = options.contentType;
    if (body !== undefined && !CONTENT_TYPES.has(contentType)) {
        throw new UpstreamError('content_type_not_allowed', adapter.id);
    }

    const bearerToken = options.bearerToken;
    if (bearerToken !== undefined) {
        if (typeof bearerToken !== 'string'
            || bearerToken.length > FIELD_LIMITS.accountToken
            || !/^[\x21-\x7e]+$/.test(bearerToken)) {
            throw new UpstreamError('bad_authorization', adapter.id);
        }
        const authHost = typeof adapter.authHost === 'string' ? adapter.authHost.toLowerCase() : '';
        if (authHost === '' || !adapter.allowedHosts.includes(authHost)
            || url.hostname.toLowerCase() !== authHost) {
            throw new UpstreamError('authorization_not_allowed', adapter.id);
        }
    }

    const publicBearerToken = publicBearerFor(adapter, url, method, contentType);
    return { method, body, contentType, bearerToken, publicBearerToken };
}

/**
 * @param {{ id: string, allowedHosts: readonly string[], requestHeaders?: Record<string, string> }} adapter
 * @param {URL} url
 */
function assertReachable(adapter, url) {
    // `allowInsecureForTests` exists so the hardening tests can point a fake
    // adapter at a local http server. It can only be set by writing it into an
    // adapter's own source; tests/hardening.test.js asserts that no shipped
    // adapter has it, and registry.test.js re-checks on every future adapter.
    if (url.protocol !== 'https:' && adapter.allowInsecureForTests !== true) {
        throw new UpstreamError('insecure_scheme', url.protocol);
    }
    if (adapter.allowInsecureForTests !== true && url.port !== '' && url.port !== '443') {
        throw new UpstreamError('port_not_allowed', url.port);
    }
    if (url.username !== '' || url.password !== '') {
        throw new UpstreamError('credentials_not_allowed', adapter.id);
    }
    // Exact hostname match. A suffix test would accept "botbooru.com.evil.tld".
    if (!adapter.allowedHosts.includes(url.hostname.toLowerCase())) {
        throw new UpstreamError('host_not_allowed', url.hostname);
    }
}

/**
 * Performs one request, following at most MAX_REDIRECTS hops and re-validating
 * the destination at every hop. node-fetch's own `follow` does not re-check the
 * host, which is why redirects are handled manually here.
 *
 * @param {{ id: string, allowedHosts: readonly string[], requestHeaders?: Record<string, string> }} adapter
 * @param {URL | string} target
 * @param {{ accept: string, maxBytes: number, signal: AbortSignal, timedOut: () => boolean, method?: string, body?: string, contentType?: string, bearerToken?: string, headers?: Record<string, string> }} options
 */
async function request(adapter, target, options) {
    let url = target instanceof URL ? target : new URL(String(target));
    const startedAt = Date.now();
    const { accept, maxBytes, signal, timedOut } = options;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        assertReachable(adapter, url);
        const shape = requestShape(adapter, url, options);
        const headers = {
            ...BASE_HEADERS,
            ...(adapter.requestHeaders ?? {}),
            ...(options.headers ?? {}),
            Accept: accept,
        };
        if (shape.contentType) {
            headers['Content-Type'] = shape.contentType;
        }
        const authorization = shape.bearerToken ?? shape.publicBearerToken;
        if (authorization) {
            headers.Authorization = `Bearer ${authorization}`;
        }

        let response;
        try {
            response = await nodeFetch(url.toString(), {
                method: shape.method,
                redirect: 'manual',
                size: maxBytes,
                signal,
                headers,
                ...(shape.body === undefined ? {} : { body: shape.body }),
            });
        } catch (error) {
            const aborted = abortCode(error, signal, timedOut);
            if (aborted) {
                throw new UpstreamError(aborted, adapter.id);
            }
            if (error?.type === 'max-size') {
                throw new UpstreamError('too_large', adapter.id);
            }
            throw new UpstreamError('network', safeNetworkDetail(error));
        }

        const isRedirect = response.status >= 300 && response.status < 400;
        if (!isRedirect) {
            logUpstream(adapter, url, response.status, Date.now() - startedAt);
            return response;
        }

        // Never replay a password, account mutation, or bearer token after an
        // upstream redirect, even when the destination is on the same host.
        if (shape.body !== undefined || shape.bearerToken !== undefined || shape.publicBearerToken !== undefined) {
            discard(response);
            throw new UpstreamError('credential_redirect', adapter.id);
        }

        const location = response.headers.get('location');
        discard(response);
        if (!location) {
            throw new UpstreamError('bad_redirect', String(response.status));
        }

        // Resolve relative Locations against the URL we just requested.
        try {
            url = new URL(location, url);
        } catch {
            throw new UpstreamError('bad_redirect', 'unparseable');
        }
    }

    throw new UpstreamError('too_many_redirects', adapter.id);
}

/** Creates one deadline shared by every redirect hop and response body read. */
function createDeadline(timeoutMs, externalSignal) {
    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = () => controller.abort();
    if (externalSignal?.aborted) {
        onExternalAbort();
    } else {
        externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, Math.max(1, timeoutMs));
    timer.unref?.();
    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        stop: () => {
            clearTimeout(timer);
            externalSignal?.removeEventListener('abort', onExternalAbort);
        },
    };
}

function abortCode(error, signal, timedOut) {
    if (signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        return timedOut() ? 'timeout' : 'aborted';
    }
    return null;
}

/** Never retain dependency messages: node-fetch includes the full request URL. */
function safeNetworkDetail(error) {
    const detail = error?.code ?? error?.type ?? error?.name ?? 'network';
    return typeof detail === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(detail)
        ? detail
        : 'network';
}

function discard(response) {
    try {
        response?.body?.destroy();
    } catch {
        // The socket is already unusable or closed. There is nothing left to do.
    }
}

function declaredTooLarge(response, maxBytes) {
    const length = Number(response.headers.get('content-length'));
    return Number.isFinite(length) && length > maxBytes;
}

/**
 * Fetches and parses JSON, then rejects prototype-poisoning payloads before the
 * caller can walk them.
 *
 * @param {{ id: string, allowedHosts: readonly string[], requestHeaders?: Record<string, string> }} adapter
 * @param {URL | string} url
 * @param {{ maxBytes?: number, timeoutMs?: number, signal?: AbortSignal, method?: string, body?: string, contentType?: string, bearerToken?: string, headers?: Record<string, string> }} [options]
 * @returns {Promise<any>}
 */
export async function fetchJson(adapter, url, {
    maxBytes = 2 << 20,
    timeoutMs = 8000,
    signal,
    method,
    body,
    contentType,
    bearerToken,
    headers,
} = {}) {
    const deadline = createDeadline(timeoutMs, signal);
    let response;
    try {
        response = await request(adapter, url, {
            accept: 'application/json,text/plain;q=0.8,*/*;q=0.5',
            maxBytes,
            signal: deadline.signal,
            timedOut: deadline.timedOut,
            method,
            body,
            contentType,
            bearerToken,
            headers,
        });

        if (!response.ok) {
            discard(response);
            throw new UpstreamError('http_error', String(response.status));
        }
        if (declaredTooLarge(response, maxBytes)) {
            discard(response);
            throw new UpstreamError('too_large', adapter.id);
        }

        let text;
        try {
            text = await response.text();
        } catch (error) {
            const aborted = abortCode(error, deadline.signal, deadline.timedOut);
            if (aborted) {
                throw new UpstreamError(aborted, adapter.id);
            }
            if (error?.type === 'max-size') {
                throw new UpstreamError('too_large', adapter.id);
            }
            throw new UpstreamError('network', safeNetworkDetail(error));
        }

        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw new UpstreamError('bad_json', adapter.id);
        }

        if (hasForbiddenKey(parsed)) {
            throw new UpstreamError('unsafe_json', adapter.id);
        }

        return parsed;
    } finally {
        deadline.stop();
    }
}

/**
 * Fetches raw bytes with the same host and size discipline. Used by the card
 * byte path and the thumbnail proxy.
 *
 * @param {{ id: string, allowedHosts: readonly string[], requestHeaders?: Record<string, string> }} adapter
 * @param {URL | string} url
 * @param {{ accept?: string, maxBytes?: number, timeoutMs?: number, signal?: AbortSignal, bearerToken?: string, headers?: Record<string, string> }} [options]
 * @returns {Promise<{ buffer: Buffer, contentType: string, status: number }>}
 */
export async function fetchBytes(adapter, url, {
    accept = '*/*',
    maxBytes = 8 << 20,
    timeoutMs = 20000,
    signal,
    bearerToken,
    headers,
} = {}) {
    const deadline = createDeadline(timeoutMs, signal);
    let response;
    try {
        response = await request(adapter, url, {
            accept,
            maxBytes,
            signal: deadline.signal,
            timedOut: deadline.timedOut,
            bearerToken,
            headers,
        });

        if (!response.ok) {
            discard(response);
            throw new UpstreamError('http_error', String(response.status));
        }
        if (declaredTooLarge(response, maxBytes)) {
            discard(response);
            throw new UpstreamError('too_large', adapter.id);
        }

        let buffer;
        try {
            buffer = Buffer.from(await response.arrayBuffer());
        } catch (error) {
            const aborted = abortCode(error, deadline.signal, deadline.timedOut);
            if (aborted) {
                throw new UpstreamError(aborted, adapter.id);
            }
            if (error?.type === 'max-size') {
                throw new UpstreamError('too_large', adapter.id);
            }
            throw new UpstreamError('network', safeNetworkDetail(error));
        }

        return {
            buffer,
            contentType: String(response.headers.get('content-type') ?? ''),
            status: response.status,
        };
    } finally {
        deadline.stop();
    }
}

/**
 * Logs shape, not content: never an upstream body, never a query string (which
 * would put the user's search terms in the server log).
 */
function logUpstream(adapter, url, status, ms) {
    console.debug(`[BotSearcher] ${adapter.id} ${url.origin}${url.pathname} -> ${status} in ${ms}ms`);
}

/**
 * Builds the per-adapter context handed to search()/getDetail().
 * @param {{ id: string, allowedHosts: readonly string[] }} adapter
 */
export function contextFor(adapter, { bearerToken, signal } = {}) {
    const requestOptions = (options) => ({
        ...(options ?? {}),
        bearerToken,
        signal: signal && options?.signal
            ? AbortSignal.any([signal, options.signal])
            : signal ?? options?.signal,
    });
    return Object.freeze({
        fetchJson: (url, options) => fetchJson(adapter, url, requestOptions(options)),
        fetchBytes: (url, options) => fetchBytes(adapter, url, requestOptions(options)),
    });
}
