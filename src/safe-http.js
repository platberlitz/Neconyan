import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { Buffer } from 'node:buffer';
import fetch from 'node-fetch';
import { Agent } from 'agent-base';
import { isNonPublicIpAddress, parseAndUnwrapIpAddress } from './private-request-filter.js';

export const DEFAULT_MAX_REDIRECTS = 3;
export const DEFAULT_MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30 * 1000;

const CROSS_ORIGIN_SENSITIVE_HEADERS = new Set([
    'authorization',
    'proxy-authorization',
    'cookie',
    'cookie2',
]);

const BODY_SPECIFIC_HEADERS = new Set([
    'content-length',
    'content-type',
    'content-encoding',
    'content-language',
    'content-location',
    'transfer-encoding',
]);

/**
 * Checks whether a hostname string is a literal local/Docker alias or IP literal.
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLocalOrInternalHostname(hostname) {
    const host = String(hostname || '').trim().replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    if (!host) return true;
    if (host === 'localhost' || host === 'localhost.localdomain' || host.endsWith('.localhost') || host.endsWith('.local')) {
        return true;
    }
    if (host === 'host.docker.internal' || host === 'gateway.docker.internal' || host === 'docker.internal' || host.endsWith('.docker.internal')) {
        return true;
    }
    return isNonPublicIpAddress(host);
}

/**
 * Reusable URL and DNS target validator (also usable by extension repository URL checks).
 * Validates protocol, credentials, hostname, and resolved DNS addresses against non-public IP ranges.
 * @param {string | URL} targetUrl
 * @param {object} [options]
 * @param {boolean} [options.allowPrivate=false] Whether private/loopback addresses are permitted (e.g. for administrators or explicitly local localhost configs)
 * @param {boolean} [options.disallowIpLiterals=false] Whether literal IP addresses in the URL hostname are rejected
 * @param {boolean} [options.standardPortsOnly=false] Whether non-empty URL ports other than 80/443 are rejected
 * @param {(host: string, url: URL, addresses?: string[]) => boolean} [options.isAllowedHost] Optional hostname/address allowlist predicate
 * @param {(host: string) => Promise<string[]>} [options.lookupAddresses] Optional custom DNS resolver returning IP strings
 * @returns {Promise<{ url: URL, hostname: string, addresses: string[] }>}
 */
export async function validateOutboundTarget(targetUrl, {
    allowPrivate = false,
    disallowIpLiterals = false,
    standardPortsOnly = false,
    isAllowedHost = null,
    lookupAddresses = null,
} = {}) {
    let url;
    try {
        url = targetUrl instanceof URL ? new URL(targetUrl.href) : new URL(String(targetUrl));
    } catch {
        throw Object.assign(new Error('Invalid URL format.'), { code: 'SAFE_HTTP_INVALID_URL', status: 400 });
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw Object.assign(new Error('Only http: and https: URLs are allowed.'), { code: 'SAFE_HTTP_INVALID_PROTOCOL', status: 400 });
    }

    if (url.username || url.password) {
        throw Object.assign(new Error('Credentials in URLs are not allowed.'), { code: 'SAFE_HTTP_CREDENTIALS_FORBIDDEN', status: 400 });
    }

    if (standardPortsOnly && url.port !== '' && url.port !== '80' && url.port !== '443') {
        throw Object.assign(new Error('Non-standard ports are not allowed.'), { code: 'SAFE_HTTP_INVALID_PORT', status: 400 });
    }

    const rawHostname = url.hostname;
    const strippedHost = rawHostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!strippedHost) {
        throw Object.assign(new Error('Missing hostname in URL.'), { code: 'SAFE_HTTP_INVALID_HOST', status: 400 });
    }

    if (typeof isAllowedHost === 'function' && !isAllowedHost(strippedHost, url)) {
        throw Object.assign(new Error(`Host "${strippedHost}" is not in the allowed domain list.`), { code: 'SAFE_HTTP_HOST_NOT_WHITELISTED', status: 404 });
    }

    const parsedLiteral = parseAndUnwrapIpAddress(strippedHost);
    if (parsedLiteral && disallowIpLiterals) {
        throw Object.assign(new Error('Direct IP address URLs are not allowed.'), { code: 'SAFE_HTTP_IP_LITERAL_FORBIDDEN', status: 400 });
    }

    if (!allowPrivate && isLocalOrInternalHostname(strippedHost)) {
        throw Object.assign(new Error(`Blocked request to private or local host: ${strippedHost}`), { code: 'SAFE_HTTP_PRIVATE_HOST', status: 403 });
    }

    if (parsedLiteral) {
        const canonicalIp = parsedLiteral.toString();
        if (!allowPrivate && isNonPublicIpAddress(canonicalIp)) {
            throw Object.assign(new Error(`Blocked request to private IP address: ${canonicalIp}`), { code: 'SAFE_HTTP_PRIVATE_IP', status: 403 });
        }
        if (typeof isAllowedHost === 'function' && !isAllowedHost(strippedHost, url, [canonicalIp])) {
            throw Object.assign(new Error(`Host "${strippedHost}" is not in the allowed domain list.`), { code: 'SAFE_HTTP_HOST_NOT_WHITELISTED', status: 404 });
        }
        return { url, hostname: strippedHost, addresses: [canonicalIp] };
    }

    const resolveFn = lookupAddresses || (async (host) => {
        const records = await dns.promises.lookup(host, { all: true, verbatim: true });
        return Array.isArray(records) ? records.map(r => r.address) : [records.address];
    });

    let addresses;
    try {
        addresses = (await resolveFn(strippedHost)).filter(Boolean);
    } catch {
        addresses = [];
    }

    if (!addresses.length) {
        throw Object.assign(new Error(`Unable to resolve host: ${strippedHost}`), { code: 'SAFE_HTTP_UNRESOLVED_HOST', status: 502 });
    }

    for (const addr of addresses) {
        if (!allowPrivate && isNonPublicIpAddress(addr)) {
            throw Object.assign(new Error(`Blocked request to private IP address: ${addr}`), { code: 'SAFE_HTTP_PRIVATE_IP', status: 403 });
        }
    }

    if (typeof isAllowedHost === 'function' && !isAllowedHost(strippedHost, url, addresses)) {
        throw Object.assign(new Error(`Host "${strippedHost}" is not in the allowed domain list.`), { code: 'SAFE_HTTP_HOST_NOT_WHITELISTED', status: 404 });
    }

    return { url, hostname: strippedHost, addresses };
}

/**
 * Agent that pins the socket connection to a DNS-validated IP address for the current hop
 * (eliminating DNS rebinding between lookup and socket connect) while delegating to the
 * active globalAgent with the pinned IP so neither PrivateRequestAgent nor ProxyAgent
 * can re-resolve the hostname to a private IP or override `allowPrivate: false`.
 */
export class PinnedAddressAgent extends Agent {
    /**
     * @param {object} options
     * @param {boolean} options.allowPrivate
     * @param {(host: string) => Promise<string[]>} [options.lookupAddresses]
     */
    constructor({ allowPrivate = false, lookupAddresses = null } = {}) {
        super({ keepAlive: false });
        this.allowPrivate = allowPrivate;
        this.lookupAddresses = lookupAddresses;
    }

    async connect(req, options) {
        const activeAgent = options.secureEndpoint ? https.globalAgent : http.globalAgent;
        const rawHost = String(options.host || '').replace(/^\[|\]$/g, '');
        if (!rawHost) {
            throw new Error('No host specified in request options');
        }

        let connectIp;
        const parsedLiteral = parseAndUnwrapIpAddress(rawHost);
        if (parsedLiteral) {
            connectIp = parsedLiteral.toString();
            if (!this.allowPrivate && isNonPublicIpAddress(connectIp)) {
                throw Object.assign(new Error(`Blocked request to private IP address: ${connectIp}`), { code: 'SAFE_HTTP_PRIVATE_IP', status: 403 });
            }
        } else {
            if (!this.allowPrivate && isLocalOrInternalHostname(rawHost)) {
                throw Object.assign(new Error(`Blocked request to private or local host: ${rawHost}`), { code: 'SAFE_HTTP_PRIVATE_HOST', status: 403 });
            }
            const resolveFn = this.lookupAddresses || (async (host) => {
                const records = await dns.promises.lookup(host, { all: true, verbatim: true });
                return Array.isArray(records) ? records.map(r => r.address) : [records.address];
            });
            let addresses = [];
            try {
                addresses = (await resolveFn(rawHost)).filter(Boolean);
            } catch {
                addresses = [];
            }
            if (!addresses.length) {
                throw Object.assign(new Error(`Unable to resolve host: ${rawHost}`), { code: 'SAFE_HTTP_UNRESOLVED_HOST', status: 502 });
            }
            for (const addr of addresses) {
                if (!this.allowPrivate && isNonPublicIpAddress(addr)) {
                    throw Object.assign(new Error(`Blocked request to private IP address: ${addr}`), { code: 'SAFE_HTTP_PRIVATE_IP', status: 403 });
                }
            }
            const unwrappedFirst = parseAndUnwrapIpAddress(addresses[0]);
            connectIp = unwrappedFirst ? unwrappedFirst.toString() : addresses[0];
        }

        if (options.secureEndpoint && !options.servername && !parsedLiteral) {
            options.servername = rawHost;
        }
        options.host = connectIp;
        options.hostname = connectIp;

        // Delegate with options mutated in place (so agent-base's subAgent.addRequest(req, connectOpts)
        // also receives the pinned IP address). When ProxyAgent returns HttpProxyAgent for plain HTTP,
        // rewrite req.path to use the pinned IP target while keeping the original Host header so an
        // HTTP forward proxy connects to connectIp rather than re-resolving the hostname.
        if (activeAgent && (activeAgent.constructor?.name === 'PrivateRequestAgent' || activeAgent.constructor?.name === 'ProxyAgent') && typeof activeAgent.connect === 'function') {
            const subAgent = await activeAgent.connect(req, options);
            if (!options.secureEndpoint && subAgent && subAgent.constructor?.name === 'HttpProxyAgent' && req && typeof req.path === 'string' && !req.path.includes('://')) {
                const ipHostForUrl = net.isIPv6(connectIp) ? `[${connectIp}]` : connectIp;
                const portPart = options.port && Number(options.port) !== 80 ? `:${options.port}` : '';
                req.path = new URL(req.path, `http://${ipHostForUrl}${portPart}`).href;
            }
            // When ProxyAgent bypasses the proxy (no_proxy / empty proxy URL), it returns its fallback
            // httpAgent/httpsAgent. If that fallback is a PrivateRequestAgent, delegate to its connect();
            // if it is a plain core http.Agent/https.Agent, connect directly to connectIp so neither
            // Node's nor Bun's core Agent re-resolves the original hostname.
            if (subAgent && (subAgent === activeAgent.httpAgent || subAgent === activeAgent.httpsAgent)) {
                if (subAgent.constructor?.name === 'PrivateRequestAgent' && typeof subAgent.connect === 'function') {
                    return subAgent.connect(req, options);
                }
                return options.secureEndpoint ? tls.connect(options) : net.connect(options);
            }
            return subAgent;
        }

        if (options.secureEndpoint) {
            return tls.connect(options);
        }

        return net.connect(options);
    }
}

function discardBody(response) {
    try {
        response?.body?.destroy?.();
    } catch {
        // Ignore stream cleanup errors on discarded responses.
    }
}

function cloneRequestHeaders(headers) {
    const copy = {};
    if (!headers || typeof headers !== 'object') return copy;
    if (typeof headers.entries === 'function') {
        for (const [k, v] of headers.entries()) {
            copy[k] = v;
        }
        return copy;
    }
    for (const [k, v] of Object.entries(headers)) {
        if (v !== undefined) copy[k] = v;
    }
    return copy;
}

function deleteHeadersCaseInsensitive(headersObj, lowerNamesSet) {
    for (const key of Object.keys(headersObj)) {
        if (lowerNamesSet.has(key.toLowerCase())) {
            delete headersObj[key];
        }
    }
}

function attachStreamByteLimit(response, maxBytes) {
    const body = response?.body;
    if (!body || !(maxBytes > 0) || typeof body.on !== 'function' || body.__safeHttpMaxBytesAttached) {
        return;
    }
    Object.defineProperty(body, '__safeHttpMaxBytesAttached', { value: true, enumerable: false });
    let totalBytes = 0;
    let monitorAttached = false;
    const ensureDataMonitor = () => {
        if (monitorAttached) return;
        monitorAttached = true;
        body.on('data', (chunk) => {
            const len = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk ?? ''));
            totalBytes += len;
            if (totalBytes > maxBytes) {
                const err = Object.assign(
                    new Error(`Response stream exceeded maximum size of ${maxBytes} bytes.`),
                    { code: 'SAFE_HTTP_TOO_LARGE', status: 413, type: 'max-size' },
                );
                if (typeof body.destroy === 'function') {
                    body.destroy(err);
                } else {
                    body.emit('error', err);
                }
            }
        });
    };

    if (typeof body.pipe === 'function') {
        const origPipe = body.pipe.bind(body);
        body.pipe = function patchedPipe(dest, pipeOpts) {
            ensureDataMonitor();
            return origPipe(dest, pipeOpts);
        };
    }

    const origOn = body.on.bind(body);
    body.on = function patchedOn(event, listener) {
        if (event === 'data' && !monitorAttached) {
            ensureDataMonitor();
        }
        return origOn(event, listener);
    };
}

/**
 * Performs an HTTP/HTTPS request with manual redirect validation at every hop,
 * DNS resolution pinning against SSRF/rebinding, cross-origin credential stripping,
 * and response size caps on both buffered reads and piped streams.
 *
 * @param {string | URL} initialUrl
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {Record<string, string>} [options.headers]
 * @param {any} [options.body]
 * @param {number} [options.maxRedirects=DEFAULT_MAX_REDIRECTS]
 * @param {number} [options.maxBytes=DEFAULT_MAX_RESPONSE_BYTES]
 * @param {number} [options.timeoutMs=DEFAULT_TIMEOUT_MS]
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.allowPrivate=false]
 * @param {(url: URL) => boolean} [options.allowPrivateForUrl] Optional per-hop private-address allowance
 * @param {boolean} [options.disallowIpLiterals=false]
 * @param {boolean} [options.standardPortsOnly=false]
 * @param {(host: string, url: URL, addresses?: string[]) => boolean} [options.isAllowedHost]
 * @param {(host: string) => Promise<string[]>} [options.lookupAddresses]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<import('node-fetch').Response>}
 */
export async function safeFetchFollowRedirects(initialUrl, {
    method = 'GET',
    headers = {},
    body = undefined,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal = undefined,
    allowPrivate = false,
    allowPrivateForUrl = null,
    disallowIpLiterals = false,
    standardPortsOnly = false,
    isAllowedHost = null,
    lookupAddresses = null,
    fetchImpl = fetch,
} = {}) {
    let currentUrl = initialUrl instanceof URL ? new URL(initialUrl.href) : new URL(String(initialUrl));
    let currentMethod = String(method || 'GET').toUpperCase();
    let currentBody = body;
    const currentHeaders = cloneRequestHeaders(headers);

    const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
    const combinedSignal = signal && timeoutSignal
        ? AbortSignal.any([signal, timeoutSignal])
        : (signal || timeoutSignal || undefined);

    for (let hop = 0; hop <= maxRedirects; hop++) {
        const hopAllowPrivate = allowPrivate || (typeof allowPrivateForUrl === 'function' && Boolean(allowPrivateForUrl(currentUrl)));
        const validated = await validateOutboundTarget(currentUrl, {
            allowPrivate: hopAllowPrivate,
            disallowIpLiterals,
            standardPortsOnly,
            isAllowedHost,
            lookupAddresses,
        });

        const useCustomAgent = fetchImpl === fetch;
        const agent = useCustomAgent
            ? new PinnedAddressAgent({
                allowPrivate: hopAllowPrivate,
                lookupAddresses: async () => validated.addresses,
            })
            : undefined;

        const response = await fetchImpl(validated.url.toString(), {
            method: currentMethod,
            headers: currentHeaders,
            body: currentBody,
            redirect: 'manual',
            size: maxBytes,
            signal: combinedSignal,
            ...(agent ? { agent } : {}),
        });

        const status = response.status;
        const isRedirect = status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
        if (!isRedirect) {
            const declaredLength = Number(response.headers?.get?.('content-length'));
            if (Number.isFinite(declaredLength) && maxBytes > 0 && declaredLength > maxBytes) {
                discardBody(response);
                throw Object.assign(new Error(`Response exceeds maximum size of ${maxBytes} bytes.`), { code: 'SAFE_HTTP_TOO_LARGE', status: 413 });
            }
            attachStreamByteLimit(response, maxBytes);
            return response;
        }

        if (hop >= maxRedirects) {
            discardBody(response);
            throw Object.assign(new Error('Too many redirects.'), { code: 'SAFE_HTTP_TOO_MANY_REDIRECTS', status: 502 });
        }

        const location = response.headers?.get?.('location');
        discardBody(response);
        if (!location) {
            throw Object.assign(new Error('Redirect response missing Location header.'), { code: 'SAFE_HTTP_BAD_REDIRECT', status: 502 });
        }

        const nextUrl = new URL(location, validated.url);
        if (nextUrl.origin !== validated.url.origin || (validated.url.protocol === 'https:' && nextUrl.protocol === 'http:')) {
            deleteHeadersCaseInsensitive(currentHeaders, CROSS_ORIGIN_SENSITIVE_HEADERS);
        }
        if (status === 303 || ((status === 301 || status === 302) && currentMethod === 'POST')) {
            currentMethod = 'GET';
            currentBody = undefined;
            deleteHeadersCaseInsensitive(currentHeaders, BODY_SPECIFIC_HEADERS);
        }
        currentUrl = nextUrl;
    }

    throw Object.assign(new Error('Too many redirects.'), { code: 'SAFE_HTTP_TOO_MANY_REDIRECTS', status: 502 });
}
