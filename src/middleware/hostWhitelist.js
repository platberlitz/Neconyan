import fs from 'node:fs';
import { color, getConfigFilePath, getConfigValue } from '../util.js';
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

const DISPLAYABLE_HOSTNAME_PATTERN = /^[a-z0-9_.-]{1,253}$/;

/**
 * Gets the hostname a blocked page can show and suggest listing: the Host header without its port, and only when it
 * looks like a DNS name, so the page never echoes arbitrary text.
 * @param {string|undefined} hostValue Normalized Host header
 * @returns {string|undefined} Hostname, or undefined when there is nothing safe to show
 */
export function displayableHostname(hostValue) {
    if (!hostValue) return undefined;
    const hostname = hostValue.replace(/:\d*$/, '');
    return DISPLAYABLE_HOSTNAME_PATTERN.test(hostname) ? hostname : undefined;
}

/**
 * Gets the config file to name in the log: the real file, so a Docker log points into the config volume.
 * @returns {string} Path to config.yaml
 */
function configFileForLog() {
    const configPath = getConfigFilePath();
    if (!configPath) return 'config.yaml';
    try {
        return fs.realpathSync(configPath);
    } catch {
        return configPath;
    }
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
        const configPath = configFileForLog();
        const hostname = displayableHostname(hostValue);
        console.warn(`If you trust this host, add ${hostname ? color.yellow(hostname) + ' ' : 'it '}under ${color.yellow('hostWhitelist')} -> ${color.yellow('hosts')} in ${color.green(configPath)} and restart Neconyan.`);
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

    return sendBlockedPage(req, res, 'host-not-allowed.html', { host: displayableHostname(hostValue) });
}
