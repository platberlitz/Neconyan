import { color, getConfigValue } from '../util.js';
import { sendBlockedPage } from '../error-pages.js';
import { isHostAllowed } from 'host-validation-middleware';

const knownHosts = new Set();
const maxKnownHosts = 1000;

const hostWhitelistEnabled = !!getConfigValue('hostWhitelist.enabled', true, 'boolean');
const configuredHosts = getConfigValue('hostWhitelist.hosts', []);
const hostWhitelist = Object.freeze((Array.isArray(configuredHosts) ? configuredHosts : [])
    .filter(host => typeof host === 'string' && host.trim())
    .map(host => host.trim().toLowerCase()));
const hostWhitelistScan = !!getConfigValue('hostWhitelist.scan', false, 'boolean');

/**
 * Lower-cases a Host header so matching is case-insensitive, as DNS names are.
 * @param {unknown} hostValue Raw Host header
 * @returns {string|undefined} Normalized host, or undefined when missing or empty
 */
function normalizeHostHeader(hostValue) {
    if (typeof hostValue !== 'string' || !hostValue.trim()) {
        return undefined;
    }
    return hostValue.trim().toLowerCase();
}

/**
 * Middleware to validate remote hosts.
 * Useful to protect against DNS rebinding attacks.
 * @param {import('express').Request} req Request
 * @param {import('express').Response} res Response
 * @param {import('express').NextFunction} next Next middleware
 */
export default function hostWhitelistMiddleware(req, res, next) {
    const hostValue = normalizeHostHeader(req.headers.host);
    if (hostWhitelistScan && hostValue && !isHostAllowed(hostValue, hostWhitelist) && !knownHosts.has(hostValue) && knownHosts.size < maxKnownHosts) {
        const isFirstWarning = knownHosts.size === 0;
        console.warn(color.red('Request from untrusted host:'), hostValue);
        console.warn(`If you trust this host, you can add it to ${color.yellow('hostWhitelist.hosts')} in config.yaml`);
        if (!hostWhitelistEnabled && isFirstWarning) {
            console.warn(`To protect against host spoofing, consider setting ${color.yellow('hostWhitelist.enabled')} to true`);
        }
        if (isFirstWarning) {
            console.warn(`To disable this warning, set ${color.yellow('hostWhitelist.scan')} to false`);
        }
        knownHosts.add(hostValue);
    }

    if (!hostWhitelistEnabled) {
        return next();
    }

    if (!hostValue) {
        return sendBlockedPage(req, res, 'host-not-allowed.html', {});
    }

    if (isHostAllowed(hostValue, hostWhitelist)) {
        return next();
    }

    return sendBlockedPage(req, res, 'host-not-allowed.html', {});
}
