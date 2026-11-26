import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { sync as commandExistsSync } from 'command-exists';
import { simpleGit } from 'simple-git';
import { isBunRuntime } from '../runtime.js';

/** @type {{ AUTO: 'auto', SYSTEM: 'system', BUILTIN: 'builtin' }} */
export const GIT_BACKENDS = {
    AUTO: 'auto',
    SYSTEM: 'system',
    BUILTIN: 'builtin',
};

/**
 * Configuration applied to every Git command that touches an extension or an untrusted remote.
 * It refuses bare repositories found by discovery, SSH command overrides, local and non-HTTP(S)
 * transports, filesystem monitor hooks and HTTP redirects.
 */
export const SAFE_GIT_CONFIG = Object.freeze([
    'safe.bareRepository=explicit',
    'core.sshCommand=',
    'protocol.file.allow=never',
    'core.fsmonitor=false',
    'protocol.allow=never',
    'protocol.http.allow=always',
    'protocol.https.allow=always',
    'http.followRedirects=false',
]);

export const SAFE_GIT_ALLOWED_CONFIG = Object.freeze([
    ...SAFE_GIT_CONFIG.map(entry => entry.slice(0, entry.indexOf('='))),
    'http.curloptResolve',
]);

export const SAFE_GIT_ENVIRONMENT_KEYS = Object.freeze([
    'GIT_CEILING_DIRECTORIES',
    'GIT_TERMINAL_PROMPT',
    'GIT_CONFIG_NOSYSTEM',
]);

const STRIPPED_ENVIRONMENT_KEYS = new Set(['EDITOR', 'VISUAL', 'PAGER', 'SSH_ASKPASS', 'PREFIX']);
const PROXY_ENVIRONMENT_KEYS = ['http_proxy', 'https_proxy', 'all_proxy'];
const DEFAULT_GIT_HTTP_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_GIT_HTTP_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Builds the environment for Git commands run on an extension directory. Ambient Git overrides
 * are dropped, repository discovery stops at the parent of `baseDir`, credential prompts are
 * disabled and the system-wide Git config is ignored.
 * @param {string} baseDir Directory the Git command runs in
 * @returns {Record<string, string>}
 */
export function getSafeGitEnvironment(baseDir) {
    /** @type {Record<string, string>} */
    const environment = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) {
            continue;
        }
        const upperKey = key.toUpperCase();
        if (upperKey.startsWith('GIT_') || STRIPPED_ENVIRONMENT_KEYS.has(upperKey)) {
            continue;
        }
        environment[key] = value;
    }

    environment.GIT_CEILING_DIRECTORIES = path.dirname(path.resolve(baseDir));
    environment.GIT_TERMINAL_PROMPT = '0';
    environment.GIT_CONFIG_NOSYSTEM = '1';
    return environment;
}

function hasProxyEnvironment() {
    return Object.entries(process.env).some(([key, value]) => Boolean(value) && PROXY_ENVIRONMENT_KEYS.includes(key.toLowerCase()));
}

/**
 * Returns the `http.curloptResolve` entry that pins Git's connection to the address that was
 * validated, so DNS cannot be changed between the check and the connection.
 * @param {{ url: URL, hostname: string, addresses: string[] } | null | undefined} target Result of validateOutboundTarget
 * @returns {string | null}
 */
export function getGitCurlResolveEntry(target) {
    const address = target?.addresses?.[0];
    if (!target?.url || !target.hostname || !address || net.isIP(target.hostname) || hasProxyEnvironment()) {
        return null;
    }

    const port = target.url.port || (target.url.protocol === 'https:' ? '443' : '80');
    const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
    const pinnedAddress = mappedIpv4 ? mappedIpv4[1] : address;
    const formattedAddress = net.isIPv6(pinnedAddress) ? `[${pinnedAddress}]` : pinnedAddress;
    return `${target.hostname}:${port}:${formattedAddress}`;
}

/**
 * Creates a simple-git instance with the hardened configuration and environment.
 * @param {string} baseDir Directory the Git commands run in
 * @param {{ resolve?: string | null, timeout?: import('simple-git').SimpleGitOptions['timeout'] }} [options]
 * @returns {import('simple-git').SimpleGit}
 */
export function createSafeSimpleGit(baseDir, { resolve = null, timeout } = {}) {
    const config = [...SAFE_GIT_CONFIG];
    if (resolve) {
        config.push(`http.curloptResolve=${resolve}`);
    }

    return simpleGit({
        baseDir,
        config,
        allowConfig: [...SAFE_GIT_ALLOWED_CONFIG],
        allowEnvironment: [...SAFE_GIT_ENVIRONMENT_KEYS],
        ...(timeout ? { timeout } : {}),
    }).env(getSafeGitEnvironment(baseDir));
}

/**
 * Checks that a Git remote is a public HTTP(S) address (or a private one when allowed).
 * @param {string | URL} url Remote address
 * @param {{ allowPrivate?: boolean }} [options]
 * @returns {Promise<{ url: URL, hostname: string, addresses: string[] }>}
 */
export async function validateGitRemote(url, { allowPrivate = false } = {}) {
    const { validateOutboundTarget } = await import('../safe-http.js');
    return validateOutboundTarget(url, { allowPrivate: Boolean(allowPrivate) });
}

/**
 * Collects an isomorphic-git request body into one buffer.
 * @param {AsyncIterable<Uint8Array> | Uint8Array[] | undefined} body
 * @returns {Promise<Buffer | undefined>}
 */
async function collectRequestBody(body) {
    if (!body) {
        return undefined;
    }
    const chunks = [];
    for await (const chunk of body) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

async function* emptyBody() {}

/**
 * HTTP client for isomorphic-git that validates every request, connects only to the validated
 * address and refuses redirects.
 * @param {{ target: { url: URL, hostname: string, addresses: string[] }, allowPrivate?: boolean, timeoutMs?: number, maxBytes?: number }} options
 */
export function createSafeGitHttpClient({
    target,
    allowPrivate = false,
    timeoutMs = DEFAULT_GIT_HTTP_TIMEOUT_MS,
    maxBytes = DEFAULT_GIT_HTTP_MAX_BYTES,
}) {
    return {
        /**
         * @param {{ url: string, method?: string, headers?: Record<string, string>, body?: AsyncIterable<Uint8Array> | Uint8Array[], signal?: AbortSignal }} request
         */
        async request({ url, method = 'GET', headers = {}, body, signal }) {
            const { safeFetchFollowRedirects } = await import('../safe-http.js');
            const requestBody = await collectRequestBody(body);
            const response = await safeFetchFollowRedirects(url, {
                method,
                headers,
                body: requestBody,
                maxRedirects: 0,
                maxBytes,
                timeoutMs,
                signal,
                allowPrivate: Boolean(allowPrivate),
                lookupAddresses: async (host) => {
                    if (host === target.hostname && target.addresses.length) {
                        return target.addresses;
                    }
                    const resolved = await validateGitRemote(new URL(url), { allowPrivate });
                    return resolved.addresses;
                },
            });

            return {
                url: response.url || url,
                method,
                statusCode: response.status,
                statusMessage: response.statusText,
                headers: Object.fromEntries(response.headers.entries()),
                body: response.body ?? emptyBody(),
            };
        },
    };
}

const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?:\..*)?$/i;
// eslint-disable-next-line no-control-regex
const UNSAFE_PATH_CHARACTERS = /[\\/:*?"<>|\u0000-\u001f]/;
const IGNORED_CHARACTERS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\ufeff]/g;

/**
 * Whether one path segment from a Git tree can be written safely on Linux, macOS and Windows.
 * @param {string} segment
 * @returns {boolean}
 */
export function isSafeGitTreeSegment(segment) {
    if (typeof segment !== 'string' || !segment || segment === '.' || segment === '..') {
        return false;
    }
    if (UNSAFE_PATH_CHARACTERS.test(segment) || /[ .]$/.test(segment)) {
        return false;
    }
    const normalized = segment.replace(IGNORED_CHARACTERS, '').toLowerCase();
    if (normalized === '.git' || normalized === 'git~1' || normalized.startsWith('.git ') || WINDOWS_RESERVED_NAMES.test(normalized)) {
        return false;
    }
    return true;
}

const SAFE_TREE_MODES = new Set(['100644', '100755', '040000']);

/**
 * Walks a commit tree and refuses symbolic links, submodules and unsafe file names before any file
 * is written to disk.
 * @param {any} git isomorphic-git module
 * @param {string} dir Repository directory
 * @param {string} oid Commit or tree object id
 * @returns {Promise<void>}
 */
export async function assertSafeIsomorphicGitTree(git, dir, oid) {
    const pending = [{ oid, prefix: '' }];
    while (pending.length) {
        const { oid: treeOid, prefix } = pending.pop();
        const { tree } = await git.readTree({ fs, dir, oid: treeOid });
        for (const entry of tree) {
            const entryPath = prefix ? `${prefix}/${entry.path}` : entry.path;
            if (!isSafeGitTreeSegment(entry.path)) {
                throw new Error(`The repository contains an unsafe path: ${entryPath}`);
            }
            if (entry.mode === '120000') {
                throw new Error(`The repository contains a symbolic link: ${entryPath}`);
            }
            if (entry.mode === '160000') {
                throw new Error(`The repository contains a submodule: ${entryPath}`);
            }
            if (!SAFE_TREE_MODES.has(entry.mode)) {
                throw new Error(`The repository contains an unsupported entry: ${entryPath}`);
            }
            if (entry.mode === '040000') {
                pending.push({ oid: entry.oid, prefix: entryPath });
            }
        }
    }
}

/**
 * @typedef {object} GitCloneOptions
 * @property {number} [depth]
 * @property {string} [branch]
 * @property {{ allowPrivate?: boolean }} [remotePolicy] Treat the remote as untrusted: validate it,
 * pin its address, refuse redirects and non-HTTP(S) transports. Private addresses need allowPrivate.
 */

const SUPPORTED_CLONE_OPTIONS = new Set(['depth', 'branch', 'remotePolicy']);

/**
 * @param {GitCloneOptions} [options]
 * @returns {{ depth?: number, branch?: string, remotePolicy?: { allowPrivate: boolean } }}
 */
function normalizeCloneOptions(options = {}) {
    for (const key of Object.keys(options)) {
        if (!SUPPORTED_CLONE_OPTIONS.has(key)) {
            throw new Error(`Unsupported clone option: ${key}`);
        }
    }
    const remotePolicy = options.remotePolicy ? { allowPrivate: options.remotePolicy.allowPrivate === true } : undefined;
    return { depth: options.depth, branch: options.branch, remotePolicy };
}

/**
 * @typedef {object} GitClient
 * @property {'system' | 'builtin'} backend
 * @property {(url: string, localPath: string, options?: GitCloneOptions) => Promise<void>} clone
 */

/**
 * @param {{ backend?: string }} [options]
 * @returns {GitClient}
 */
export function createGitClient(options = {}) {
    const backend = resolveBackend(options.backend);
    if (backend === GIT_BACKENDS.SYSTEM) {
        return new SimpleGitClient();
    }

    return new IsomorphicGitClient();
}

/**
 * @param {string | undefined | null} preferredBackend
 * @returns {'system' | 'builtin'}
 */
function resolveBackend(preferredBackend) {
    const normalized = typeof preferredBackend === 'string' ? preferredBackend.trim().toLowerCase() : GIT_BACKENDS.AUTO;
    const backend = normalized === GIT_BACKENDS.SYSTEM
        ? GIT_BACKENDS.SYSTEM
        : normalized === GIT_BACKENDS.BUILTIN
            ? GIT_BACKENDS.BUILTIN
            : GIT_BACKENDS.AUTO;
    const systemGitAvailable = commandExistsSync('git');

    if (backend === GIT_BACKENDS.SYSTEM && !systemGitAvailable) {
        throw new Error('System git backend is configured, but no git binary was found in PATH.');
    }

    if (backend === GIT_BACKENDS.SYSTEM || (backend === GIT_BACKENDS.AUTO && systemGitAvailable)) {
        return GIT_BACKENDS.SYSTEM;
    }

    if (isBunRuntime()) {
        throw new Error('The builtin git backend is not currently supported on Bun. Install system git or set git.backend to "system".');
    }

    return GIT_BACKENDS.BUILTIN;
}

/**
 * @implements {GitClient}
 */
class SimpleGitClient {
    constructor() {
        this.backend = GIT_BACKENDS.SYSTEM;
        this.git = simpleGit();
    }

    /**
     * @param {string} url
     * @param {string} localPath
     * @param {GitCloneOptions} [options]
     * @returns {Promise<void>}
     */
    async clone(url, localPath, options = {}) {
        const { depth, branch, remotePolicy } = normalizeCloneOptions(options);
        /** @type {Record<string, any>} */
        const cloneOptions = {};

        if (depth !== undefined) {
            cloneOptions['--depth'] = depth;
        }

        if (branch) {
            cloneOptions['--branch'] = branch;
        }

        if (!remotePolicy) {
            await this.git.clone(url, localPath, cloneOptions);
            return;
        }

        const target = await validateGitRemote(url, remotePolicy);
        const git = createSafeSimpleGit(path.dirname(path.resolve(localPath)), { resolve: getGitCurlResolveEntry(target) });
        cloneOptions['--no-recurse-submodules'] = null;
        await git.clone(target.url.href, localPath, cloneOptions);
    }
}

/**
 * @implements {GitClient}
 */
class IsomorphicGitClient {
    constructor() {
        this.backend = GIT_BACKENDS.BUILTIN;
    }

    /**
     * @param {string} url
     * @param {string} localPath
     * @param {GitCloneOptions} [options]
     * @returns {Promise<void>}
     */
    async clone(url, localPath, options = {}) {
        const { depth, branch, remotePolicy } = normalizeCloneOptions(options);
        const { default: git } = await import('isomorphic-git');

        if (!remotePolicy) {
            const { default: http } = await import('isomorphic-git/http/node');
            await git.clone({
                fs,
                http,
                dir: localPath,
                url,
                depth,
                ref: branch,
                singleBranch: depth !== undefined || Boolean(branch),
            });
            return;
        }

        const target = await validateGitRemote(url, remotePolicy);
        const http = createSafeGitHttpClient({ target, allowPrivate: remotePolicy.allowPrivate });
        const existedBefore = fs.existsSync(localPath);

        try {
            await git.clone({
                fs,
                http,
                dir: localPath,
                url: target.url.href,
                depth,
                ref: branch,
                singleBranch: depth !== undefined || Boolean(branch),
                noCheckout: true,
            });

            const headOid = await git.resolveRef({ fs, dir: localPath, ref: 'HEAD' });
            await assertSafeIsomorphicGitTree(git, localPath, headOid);
            const currentBranch = await git.currentBranch({ fs, dir: localPath });
            await git.checkout({ fs, dir: localPath, ref: currentBranch || headOid, force: true });
        } catch (error) {
            if (!existedBefore) {
                fs.rmSync(localPath, { recursive: true, force: true });
            }
            throw error;
        }
    }
}
