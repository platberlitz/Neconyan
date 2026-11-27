import net from 'node:net';

const HOSTNAME_PATTERN = /^\.?[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?$/;
const MAX_HOSTNAME_LENGTH = 254;
const URL_PREFIX_PATTERN = /^([a-z][a-z0-9+.-]*):\/\//;
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/;
const PORT_AFTER_COLON_PATTERN = /^\d+(?:[/?#]|$)/;
// Schemes people write without '//'. Any other 'name:' without '//' is read as a host with a broken port.
const SCHEMES_WITHOUT_SLASHES = new Set(['about', 'blob', 'data', 'file', 'ftp', 'ftps', 'javascript', 'mailto', 'sftp', 'ssh', 'tel', 'vbscript', 'ws', 'wss']);
const MAX_SHOWN_LENGTH = 100;

export const HOST_ENTRY_REASONS = Object.freeze({
    scheme: 'only http:// and https:// addresses can be listed',
    userinfo: 'it has a user name or password in it',
    wildcard: 'write .example.com to allow a name and all of its subdomains',
    dottedUrl: 'a leading dot only works on a bare name, such as .example.com',
    invalid: 'it is not a host name',
});

/**
 * Turns one hostWhitelist.hosts entry into the name host-validation-middleware compares against: the Host header's
 * name without its port, lower-cased. A pasted address such as https://example.com:8443/path becomes example.com.
 * Anything that is not plainly a host name is refused rather than guessed at, so an entry can never allow more than
 * the name it spells out.
 * @param {unknown} entry Entry as written in config.yaml
 * @returns {{ host: string }|{ reason: keyof typeof HOST_ENTRY_REASONS }|null} The host to list, why the entry was
 * refused, or null for a blank or non-text entry, which has always been skipped quietly
 */
export function normaliseHostWhitelistEntry(entry) {
    if (typeof entry !== 'string') return null;
    let value = entry.trim().toLowerCase();
    if (!value) return null;

    if (net.isIP(value) === 6) return { host: value };
    if (value.includes('@')) return { reason: 'userinfo' };
    if (value.includes('\\')) return { reason: 'invalid' };

    let fromUrl = false;
    const prefix = URL_PREFIX_PATTERN.exec(value);
    if (prefix) {
        if (prefix[1] !== 'http' && prefix[1] !== 'https') return { reason: 'scheme' };
        value = value.slice(prefix[0].length);
        fromUrl = true;
    } else if (SCHEME_PATTERN.test(value) && !PORT_AFTER_COLON_PATTERN.test(value.slice(value.indexOf(':') + 1))) {
        const name = value.slice(0, value.indexOf(':'));
        return { reason: SCHEMES_WITHOUT_SLASHES.has(name) || name.endsWith('-extension') ? 'scheme' : 'invalid' };
    }

    const authority = value.split(/[/?#]/, 1)[0];
    let host = authority;
    if (authority.startsWith('[')) {
        const end = authority.indexOf(']');
        const rest = end < 0 ? '' : authority.slice(end + 1);
        if (end < 0 || net.isIP(authority.slice(1, end)) !== 6 || !/^(?::\d+)?$/.test(rest)) return { reason: 'invalid' };
        return { host: authority.slice(0, end + 1) };
    }
    const colon = authority.indexOf(':');
    if (colon >= 0) {
        if (!/^\d+$/.test(authority.slice(colon + 1))) return { reason: 'invalid' };
        host = authority.slice(0, colon);
    }

    if (host.includes('*')) return { reason: 'wildcard' };
    if (fromUrl && host.startsWith('.')) return { reason: 'dottedUrl' };
    if (host.length > MAX_HOSTNAME_LENGTH || !HOSTNAME_PATTERN.test(host)) return { reason: 'invalid' };
    return { host };
}

/**
 * Shows an entry in the log without credentials, query strings or terminal control characters.
 * @param {string} entry Entry as written in config.yaml
 * @returns {string} Quoted entry, or a description when it holds a user name or password
 */
export function showHostWhitelistEntry(entry) {
    const trimmed = entry.trim();
    if (trimmed.includes('@')) return 'an entry with a user name or password (not shown)';
    const cut = trimmed.search(/[?#]/);
    let shown = cut < 0 ? trimmed : `${trimmed.slice(0, cut)}...`;
    if (shown.length > MAX_SHOWN_LENGTH) shown = `${shown.slice(0, MAX_SHOWN_LENGTH)}...`;
    return `'${shown.replace(/[\p{C}\u2028\u2029]/gu, '?')}'`;
}

/**
 * Reads SILLYTAVERN_HOSTWHITELIST_HOSTS as getConfigValue does, except that text which isn't JSON is kept as text
 * rather than quietly becoming an empty list, so a comma-separated list can be reported instead of dropped.
 * @param {string} text Value of the environment variable
 * @returns {unknown} The parsed value, the text itself when it isn't JSON, or null when it's blank
 */
export function parseHostListEnv(text) {
    if (!text.trim()) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/**
 * Describes a hostWhitelist.hosts value that isn't a list, for the startup warning.
 * @param {unknown} value hostWhitelist.hosts as read from config
 * @returns {string|null} What the value is, or null for a list, a missing value or blank text
 */
function describeNonList(value) {
    if (value === undefined || value === null || Array.isArray(value)) return null;
    if (typeof value === 'string') return value.trim() ? `the text ${showHostWhitelistEntry(value)}` : null;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'object') return 'a set of named values';
    return 'something that is not a list';
}

/**
 * Normalises every hostWhitelist.hosts entry, dropping duplicates and refused entries.
 * @param {unknown} entries hostWhitelist.hosts as read from config
 * @returns {{ hosts: string[], changed: { shown: string, host: string }[], ignored: { shown: string, reason: string }[], notAList: string|null }}
 * The hosts to compare against, entries that were rewritten (beyond case and surrounding spaces), entries refused,
 * and what the value was when it isn't a list at all (nothing is allowed from it then)
 */
export function normaliseHostWhitelist(entries) {
    const hosts = [];
    const changed = [];
    const ignored = [];
    const seen = new Set();
    const reported = new Set();
    for (const entry of Array.isArray(entries) ? entries : []) {
        const result = normaliseHostWhitelistEntry(entry);
        if (!result) continue;
        const written = /** @type {string} */ (entry).trim();
        const firstReport = !reported.has(written.toLowerCase());
        reported.add(written.toLowerCase());
        if ('reason' in result) {
            if (firstReport) ignored.push({ shown: showHostWhitelistEntry(written), reason: HOST_ENTRY_REASONS[result.reason] });
            continue;
        }
        if (firstReport && result.host !== written.toLowerCase()) {
            changed.push({ shown: showHostWhitelistEntry(written), host: result.host });
        }
        if (!seen.has(result.host)) {
            seen.add(result.host);
            hosts.push(result.host);
        }
    }
    return { hosts, changed, ignored, notAList: describeNonList(entries) };
}

/**
 * Words the startup log lines for rewritten and refused entries. Nothing is returned for a list of clean names.
 * @param {ReturnType<typeof normaliseHostWhitelist>} result Result of normaliseHostWhitelist
 * @param {object} where Where the list came from and how it's used
 * @param {string} where.source The config file path, or the environment variable's name
 * @param {boolean} [where.fromEnv] Whether the list came from the environment variable
 * @param {boolean} [where.enforced] Whether hostWhitelist.enabled is on, rather than only the scan
 * @returns {{ notes: string[], warnings: string[] }} Lines for console.info and console.warn
 */
export function describeHostWhitelist(result, { source, fromEnv = false, enforced = true }) {
    const notes = [];
    const warnings = [];
    if (result.notAList) {
        const effect = enforced ? 'only localhost and IP addresses get through' : 'the scan reports every host name except localhost as untrusted';
        const example = fromEnv ? 'SILLYTAVERN_HOSTWHITELIST_HOSTS=\'["example.com"]\'' : 'hosts: [\'example.com\']';
        warnings.push(`Host whitelist: hostWhitelist.hosts has to be a list of host names, but ${source} sets it to ${result.notAList}. Neconyan is ignoring it, so ${effect}.`);
        warnings.push(`Write it as a list, for example ${example}, and restart Neconyan.`);
    }
    if (result.changed.length) {
        notes.push('Host whitelist: hostWhitelist.hosts lists host names, so Neconyan is using the name on the right for each of these entries:');
        for (const { shown, host } of result.changed) notes.push(`  ${shown} -> ${host}`);
        notes.push(`To tidy up, write just the host name in ${source}. Neconyan hasn't changed it.`);
    }
    if (result.ignored.length) {
        const effect = enforced ? 'so they allow no requests' : 'so the scan reports requests for them as untrusted';
        warnings.push(`Host whitelist: ignoring these hostWhitelist.hosts entries, ${effect}:`);
        for (const { shown, reason } of result.ignored) warnings.push(`  ${shown}: ${reason}`);
        warnings.push(`Fix or remove them in ${source} and restart Neconyan.`);
    }
    return { notes, warnings };
}
