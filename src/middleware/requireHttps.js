import { getConfigValue } from '../util.js';

const REQUIRE_HTTPS = getConfigValue('requireHttps', false, 'boolean');

/**
 * Middleware that rejects non-HTTPS connections when requireHttps is enabled.
 * Localhost connections are always allowed (for local development).
 */
const requireHttpsMiddleware = function (request, response, callback) {
    if (!REQUIRE_HTTPS) {
        return callback();
    }

    // Always allow localhost connections
    const host = request.hostname || request.ip;
    const isLocalhost = ['127.0.0.1', '::1', 'localhost'].includes(host)
        || host?.startsWith('127.')
        || host === '::ffff:127.0.0.1';

    if (isLocalhost) {
        return callback();
    }

    // Check if request is HTTPS (direct or via reverse proxy)
    const isHttps = request.secure || request.headers['x-forwarded-proto'] === 'https';

    if (!isHttps) {
        return response.status(403).json({
            error: 'HTTPS is required for non-localhost connections. Configure SSL in config.yaml or use a reverse proxy with HTTPS.',
        });
    }

    return callback();
};

export default requireHttpsMiddleware;
