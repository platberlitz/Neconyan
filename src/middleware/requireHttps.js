import { getConfigValue } from '../util.js';
import { sendHttpsRequired } from '../error-pages.js';
import { isLoopbackSocketPeer, isTrustedProxyPeer } from '../express-common.js';

const REQUIRE_HTTPS = getConfigValue('requireHttps', false, 'boolean');

function isLocalhostHostHeader(host) {
    if (typeof host !== 'string') return false;
    const clean = host.trim().toLowerCase();
    return ['127.0.0.1', '::1', 'localhost'].includes(clean)
        || clean.startsWith('127.')
        || clean === '::ffff:127.0.0.1';
}

/**
 * Middleware that rejects non-HTTPS connections when requireHttps is enabled.
 * Localhost connections are allowed only when the socket peer is actually loopback
 * and the request targets a local host header (not a proxied external domain).
 */
const requireHttpsMiddleware = function (request, response, callback) {
    if (!REQUIRE_HTTPS) {
        return callback();
    }

    const host = request.hostname || request.ip;
    const isLocalhost = isLoopbackSocketPeer(request) && isLocalhostHostHeader(host);

    if (isLocalhost) {
        return callback();
    }

    const forwardedProto = isTrustedProxyPeer(request)
        ? String(request.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
        : '';
    const isHttps = Boolean(request.secure || forwardedProto === 'https');

    if (!isHttps) {
        return sendHttpsRequired(request, response);
    }

    return callback();
};

export default requireHttpsMiddleware;
