import ipaddr from 'ipaddr.js';
import ipMatching from 'ip-matching';
import { RateLimiterRes } from 'rate-limiter-flexible';
import { color, getConfigValue } from './util.js';

const noopMiddleware = (_req, _res, next) => next();
/** @deprecated Do not use. A global middleware is provided at the application level. */
export const jsonParser = noopMiddleware;
/** @deprecated Do not use. A global middleware is provided at the application level. */
export const urlencodedParser = noopMiddleware;

const DEFAULT_TRUSTED_PROXIES = Object.freeze(['127.0.0.1', '::1']);
let cachedTrustedProxiesRaw;
let cachedTrustedProxies = [];

function getTrustedProxies() {
    const configured = getConfigValue('sso.trustedProxies', DEFAULT_TRUSTED_PROXIES) ?? DEFAULT_TRUSTED_PROXIES;
    const rawKey = JSON.stringify(configured);
    if (rawKey !== cachedTrustedProxiesRaw) {
        cachedTrustedProxiesRaw = rawKey;
        if (!Array.isArray(configured)) {
            cachedTrustedProxies = [];
        } else if (configured.length === 1 && configured[0] === '*') {
            cachedTrustedProxies = ['*'];
        } else {
            cachedTrustedProxies = filterValidIpPatterns(configured, (entry, message) => `${color.red('Warning')}: Ignoring invalid sso.trustedProxies entry ${color.yellow(entry)} - ${message}`);
        }
    }
    return cachedTrustedProxies;
}

/**
 * Checks whether an IP address string is a valid IPv4 or IPv6 address.
 * @param {string} value Candidate IP string
 * @returns {boolean}
 */
export function isValidIpAddress(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 128) return false;
    return ipaddr.isValid(trimmed);
}

/**
 * Normalizes an IP address string (converting IPv4-mapped IPv6 addresses to IPv4).
 * @param {string} value IP address string
 * @returns {string|null} Normalized IP address or null if invalid
 */
export function normalizeIpAddress(value) {
    if (!isValidIpAddress(value)) return null;
    try {
        const ip = ipaddr.parse(value.trim());
        if (ip.kind() === 'ipv6' && ip instanceof ipaddr.IPv6 && ip.isIPv4MappedAddress()) {
            return ip.toIPv4Address().toString();
        }
        return ip.toString();
    } catch {
        return null;
    }
}

/**
 * Checks if an IP address matches any pattern in the provided list safely.
 * @param {string[]} patterns Validated IP/CIDR/wildcard patterns
 * @param {string} ip Candidate IP address
 * @returns {boolean}
 */
export function matchesIpPatternList(patterns, ip) {
    const normalized = normalizeIpAddress(ip);
    if (!normalized || !Array.isArray(patterns)) return false;
    for (const entry of patterns) {
        if (entry === '*') return true;
        try {
            const match = ipMatching.getMatch(entry);
            if (ipMatching.matches(normalized, match)) {
                return true;
            }
        } catch {
            continue;
        }
    }
    return false;
}

/**
 * Checks whether the socket peer is a loopback address.
 * @param {import('express').Request} req Request object
 * @returns {boolean}
 */
export function isLoopbackSocketPeer(req) {
    const normalized = normalizeIpAddress(req?.socket?.remoteAddress || '');
    if (!normalized) return false;
    return normalized === '127.0.0.1' || normalized === '::1' || normalized.startsWith('127.');
}

/**
 * Checks whether the direct socket peer of a request is a trusted reverse proxy.
 * Trusts loopback peers (matching Express 'trust proxy' = 'loopback') and sso.trustedProxies.
 * @param {import('express').Request} req Request object
 * @returns {boolean}
 */
export function isTrustedProxyPeer(req) {
    if (isLoopbackSocketPeer(req)) return true;
    const peerIp = getIpFromRequest(req);
    if (!peerIp || peerIp === 'unknown') return false;
    return matchesIpPatternList(getTrustedProxies(), peerIp);
}

/**
 * Gets the IP address of the client from the request object.
 * @param {import('express').Request} req Request object
 * @returns {string} IP address of the client
 */
export function getIpFromRequest(req) {
    const clientIp = req?.socket?.remoteAddress;
    if (!clientIp) {
        return 'unknown';
    }
    return normalizeIpAddress(clientIp) ?? 'unknown';
}

/**
 * Gets the IP address of the client when behind reverse proxy using x-real-ip header, falls back to socket remote address.
 * This function should be used when the application is running behind a reverse proxy (e.g., Nginx, traefik, Caddy...).
 * @param {import('express').Request} req Request object
 * @returns {string} IP address of the client
 */
export function getRealIpFromHeader(req) {
    if (isTrustedProxyPeer(req) && req?.headers?.['x-real-ip']) {
        const raw = req.headers['x-real-ip'].toString().trim();
        return normalizeIpAddress(raw) ?? raw;
    }

    return getIpFromRequest(req);
}

/**
 * Get the client IP address from the request headers when the direct peer is a trusted proxy.
 * Evaluates X-Forwarded-For (walking right-to-left to the first non-trusted hop) before
 * single-value headers so a proxy-appended X-Forwarded-For chain cannot be shadowed by a
 * client-supplied X-Real-IP header. When multiple headers are present, prefers a header
 * that parses as a valid IP address and falls back to raw unparsed strings only if no
 * enabled header contains a valid IP (so whitelistMiddleware still blocks malformed headers).
 * @param {import('express').Request} req Express request object
 * @returns {string|undefined} The client IP address
 */
export function getRealOrForwardedIp(req) {
    if (!isTrustedProxyPeer(req)) {
        return undefined;
    }

    const xRealIpEnabled = !!getConfigValue('forwardedHeaders.xRealIp', true, 'boolean');
    const cfConnectingIpEnabled = !!getConfigValue('forwardedHeaders.cfConnectingIp', false, 'boolean');
    const xForwardedForEnabled = !!getConfigValue('forwardedHeaders.xForwardedFor', true, 'boolean');

    let firstInvalidCandidate;

    if (req.headers['x-forwarded-for'] && xForwardedForEnabled) {
        const ipList = req.headers['x-forwarded-for'].toString().split(',').map(ip => ip.trim()).filter(Boolean);
        if (ipList.length > 0) {
            // Walk from the rightmost (proxy-appended) hop backwards and return the first hop that is not itself a trusted proxy.
            const trustedProxies = getTrustedProxies();
            let selectedCandidate;
            for (let i = ipList.length - 1; i >= 0; i--) {
                const candidate = ipList[i];
                const normalized = normalizeIpAddress(candidate);
                if (!normalized) {
                    selectedCandidate = candidate;
                    break;
                }
                const isTrustedHop = normalized === '127.0.0.1'
                    || normalized === '::1'
                    || normalized.startsWith('127.')
                    || matchesIpPatternList(trustedProxies, normalized);
                if (!isTrustedHop || i === 0) {
                    return normalized;
                }
            }
            if (selectedCandidate !== undefined) {
                firstInvalidCandidate ??= selectedCandidate;
            } else {
                const fallbackHop = ipList[ipList.length - 1];
                const normalizedFallback = normalizeIpAddress(fallbackHop);
                if (normalizedFallback) return normalizedFallback;
                firstInvalidCandidate ??= fallbackHop;
            }
        }
    }

    if (req.headers['cf-connecting-ip'] && cfConnectingIpEnabled) {
        const raw = req.headers['cf-connecting-ip'].toString().trim();
        const normalized = normalizeIpAddress(raw);
        if (normalized) return normalized;
        if (raw) firstInvalidCandidate ??= raw;
    }

    if (req.headers['x-real-ip'] && xRealIpEnabled) {
        const raw = req.headers['x-real-ip'].toString().trim();
        const normalized = normalizeIpAddress(raw);
        if (normalized) return normalized;
        if (raw) firstInvalidCandidate ??= raw;
    }

    return firstInvalidCandidate;
}

/**
 * Gets the IP address of the client, optionally including real/forwarded headers.
 * Only validated IP addresses are incorporated into the composite identifier so
 * malformed headers cannot bypass rate limiters or inject control characters into logs.
 * @param {import('express').Request} request Request object
 * @param {boolean} includeHeaderIp Whether to include the real/forwarded IP from headers
 * @returns {string} IP address of the client
 */
export function getIpAddress(request, includeHeaderIp) {
    const socketIp = getIpFromRequest(request);
    const rawForwarded = includeHeaderIp ? getRealOrForwardedIp(request) : undefined;
    const forwardedIp = rawForwarded ? normalizeIpAddress(rawForwarded) : null;
    return forwardedIp ? `${socketIp} (forwarded: ${forwardedIp})` : socketIp;
}

/**
 * Checks if the request is coming from a Firefox browser.
 * @param {import('express').Request} req Request object
 * @returns {boolean} True if the request is from Firefox, false otherwise.
 */
export function isFirefox(req) {
    const userAgent = req.headers['user-agent'] || '';
    return /firefox/i.test(userAgent);
}

/**
 * Filters and validates IP patterns.
 * @param {string[]} entries The list of IP patterns to validate
 * @param {(entry: string, message: string) => string} formatLog Function to format warnings for invalid entries
 * @returns {string[]} The list of valid IP patterns
 */
export function filterValidIpPatterns(entries, formatLog) {
    const validEntries = [];

    if (!Array.isArray(entries)) {
        return validEntries;
    }

    for (const entry of entries) {
        try {
            ipMatching.getMatch(entry);
            validEntries.push(entry);
        } catch (e) {
            if (typeof formatLog === 'function') {
                console.warn(formatLog(entry, e?.message || 'Unknown error'));
            }
        }
    }

    return validEntries;
}

/**
 * Sets the Retry-After header based on rate limit information.
 * @param {import('express').Response} response Express response object
 * @param {RateLimiterRes} rateLimit The rate limit information
 * @returns {import('express').Response} The response object
 */
export function retryAfter(response, rateLimit) {
    if (response.headersSent || !(rateLimit instanceof RateLimiterRes)) {
        return response;
    }
    const retryAfter = Math.ceil(rateLimit.msBeforeNext / 1000);
    response.set('Retry-After', retryAfter.toString());
    return response;
}
