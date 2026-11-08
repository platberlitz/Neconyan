import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GITHUB_DOWNLOAD_PATH = /^\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)\/releases\/download\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;
const GRADLE_DISTRIBUTION_PATH = /^\/distributions\/([A-Za-z0-9][A-Za-z0-9._-]*\.zip)$/;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const USER_AGENT = 'Neconyan-Release-Download';

export const DEFAULT_ATTEMPTS = 2;
export const DEFAULT_RETRY_DELAY_MS = 1000;
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const TOKEN_ENV = 'NECONYAN_GITHUB_TOKEN';

const GITHUB_DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const GRADLE_DOWNLOAD_HOSTS = new Set([...GITHUB_DOWNLOAD_HOSTS, 'services.gradle.org']);
const ASSET_REDIRECT_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

export class ReleaseDownloadError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'ReleaseDownloadError';
    }
}

export class ChecksumMismatchError extends ReleaseDownloadError {
    constructor(message) {
        super(message);
        this.name = 'ChecksumMismatchError';
        this.code = 'CHECKSUM_MISMATCH';
    }
}

class NetworkError extends ReleaseDownloadError {
    constructor(message, options) {
        super(message, options);
        this.name = 'NetworkError';
        this.code = 'NETWORK_ERROR';
    }
}

class UnsafeRedirectError extends ReleaseDownloadError {
    constructor(message, secrets = []) {
        super(redact(message, secrets));
        this.name = 'UnsafeRedirectError';
        this.code = 'UNSAFE_REDIRECT';
    }
}

class HttpStatusError extends ReleaseDownloadError {
    constructor(status, url, secrets = []) {
        super(`HTTP ${status} from ${redact(url, secrets)}`);
        this.name = 'HttpStatusError';
        this.code = 'HTTP_STATUS';
        this.status = status;
    }
}

function parseHttpsUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new ReleaseDownloadError('The download source is not a valid URL.');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
        throw new ReleaseDownloadError('The download source must be a plain HTTPS URL without credentials, a port, a query or a fragment.');
    }
    return url;
}

/** Accept only an exact, public GitHub release download URL. */
export function parseGithubReleaseUrl(value) {
    const url = parseHttpsUrl(value);
    if (url.hostname !== 'github.com') throw new ReleaseDownloadError('Only github.com release download URLs are supported.');
    const match = GITHUB_DOWNLOAD_PATH.exec(url.pathname);
    if (!match) throw new ReleaseDownloadError('The GitHub URL is not an exact release asset download URL.');
    const [, owner, repo, tag, asset] = match;
    if (![owner, repo, tag, asset].every(part => NAME_PATTERN.test(part))) {
        throw new ReleaseDownloadError('The GitHub release URL contains an unsupported owner, repository, tag or asset name.');
    }
    return { kind: 'github', owner, repo, tag, asset, url: url.href };
}

/** Accept only the exact Gradle distribution URL shape the wrapper already pins. */
export function parseGradleDistributionUrl(value) {
    const url = parseHttpsUrl(value);
    if (url.hostname !== 'services.gradle.org') throw new ReleaseDownloadError('Only services.gradle.org distribution URLs are supported.');
    const match = GRADLE_DISTRIBUTION_PATH.exec(url.pathname);
    if (!match || !NAME_PATTERN.test(match[1])) {
        throw new ReleaseDownloadError('The Gradle URL is not an exact distribution download URL.');
    }
    return { kind: 'gradle', asset: match[1], url: url.href };
}

function parseSourceUrl(value) {
    try {
        return parseGithubReleaseUrl(value);
    } catch {
        try {
            return parseGradleDistributionUrl(value);
        } catch {
            throw new ReleaseDownloadError('Only exact GitHub release download URLs and pinned Gradle distribution URLs are supported.');
        }
    }
}

/** Remove token values, URL queries and signed parameters from anything written to a log or error. */
export function redact(value, secrets = []) {
    let text = String(value ?? '');
    for (const secret of secrets) {
        if (typeof secret === 'string' && secret.length >= 8) text = text.split(secret).join('[redacted]');
    }
    text = text.replace(/https?:\/\/[^\s"'<>]+/g, match => {
        try {
            const url = new URL(match);
            return `${url.origin}${url.pathname}`;
        } catch {
            return '[url]';
        }
    });
    return text.replace(/(?:[?&](?:X-Amz-[^=&\s]+|Signature|token|sig|se|sp|sv)=)[^&\s]*/gi, '?[redacted]');
}

function describeError(error, secrets) {
    return redact(error instanceof Error ? error.message : String(error), secrets);
}

export function sha256File(filename) {
    const hash = createHash('sha256');
    const descriptor = fs.openSync(filename, 'r');
    try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let read;
        while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
    } finally {
        fs.closeSync(descriptor);
    }
    return hash.digest('hex');
}

async function cancelBody(response) {
    try {
        await response.body?.cancel();
    } catch {
        // The body may already be consumed or locked.
    }
}

async function readLimitedText(response, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) {
            await cancelBody(response);
            throw new ReleaseDownloadError('GitHub returned too much release metadata.');
        }
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
}

function requestHeaders(accept, hostname) {
    const headers = new Headers({
        Accept: accept,
        'User-Agent': USER_AGENT,
    });
    if (hostname === 'api.github.com') headers.set('X-GitHub-Api-Version', '2022-11-28');
    return headers;
}

async function fetchFollowingRedirects(fetchImpl, initialUrl, {
    allowedHosts, token, accept, maxRedirects = MAX_REDIRECTS, timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
    let current = initialUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
        const hostname = new URL(current).hostname;
        let response;
        try {
            const headers = requestHeaders(accept, hostname);
            // Credentials go only to GitHub's API. Every redirect hop rebuilds
            // the headers, so a redirect target never receives them.
            if (token && hostname === 'api.github.com') headers.set('Authorization', `Bearer ${token}`);
            response = await fetchImpl(current, {
                headers,
                redirect: 'manual',
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            throw new NetworkError(`Could not reach ${new URL(current).origin}: ${describeError(error, [token])}`);
        }
        if (!REDIRECT_STATUS.has(response.status)) return { response, url: current };
        const location = response.headers.get('location');
        await cancelBody(response);
        if (!location) throw new NetworkError('The download server returned a redirect without a location.');
        let next;
        try {
            next = new URL(location, current);
        } catch {
            throw new NetworkError('The download server returned an invalid redirect location.');
        }
        if (next.protocol !== 'https:' || next.username || next.password || next.port || !allowedHosts.has(next.hostname)) {
            throw new UnsafeRedirectError(`Blocked a redirect to an untrusted host: ${next.origin}${next.pathname}`, [token]);
        }
        current = next.href;
    }
    throw new NetworkError('The download server redirected too many times.');
}

async function saveVerifiedResponse(response, destination, expectedChecksum, { token }) {
    if (!response.body) throw new ReleaseDownloadError('The download server returned an empty response.');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.part-${process.pid}-${randomBytes(6).toString('hex')}`;
    const hash = createHash('sha256');
    let bytes = 0;
    try {
        const meter = new Transform({
            transform(chunk, _encoding, callback) {
                hash.update(chunk);
                bytes += chunk.length;
                callback(null, chunk);
            },
        });
        await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o644 }));
        const descriptor = fs.openSync(temporary, 'r+');
        try {
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
        const actual = hash.digest('hex');
        if (actual !== expectedChecksum) {
            throw new ChecksumMismatchError(`The downloaded ${path.basename(destination)} does not match its pinned SHA-256 checksum (expected ${expectedChecksum}, got ${actual}).`);
        }
        fs.renameSync(temporary, destination);
        return { sha256: actual, bytes };
    } catch (error) {
        await cancelBody(response);
        fs.rmSync(temporary, { force: true });
        if (error instanceof ChecksumMismatchError) throw error;
        throw new NetworkError(`Could not save the downloaded asset: ${describeError(error, [token])}`);
    }
}

async function readReleaseAsset(parsed, {
    fetchImpl, token, timeoutMs, expectedChecksum,
}) {
    const metadataUrl = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/releases/tags/${encodeURIComponent(parsed.tag)}`;
    let response;
    try {
        const headers = requestHeaders('application/vnd.github+json', 'api.github.com');
        if (token) headers.set('Authorization', `Bearer ${token}`);
        response = await fetchImpl(metadataUrl, {
            headers,
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        throw new NetworkError(`Could not reach the GitHub release API: ${describeError(error, [token])}`);
    }
    if (!response.ok) {
        await cancelBody(response);
        throw new HttpStatusError(response.status, metadataUrl, [token]);
    }
    let release;
    try {
        release = JSON.parse(await readLimitedText(response, MAX_METADATA_BYTES));
    } catch (error) {
        if (error instanceof ReleaseDownloadError) throw error;
        throw new ReleaseDownloadError('The GitHub release API returned invalid metadata.');
    }
    if (!release || release.tag_name !== parsed.tag || !Array.isArray(release.assets)) {
        throw new ReleaseDownloadError(`The GitHub release API did not return release ${parsed.tag}.`);
    }
    const matches = release.assets.filter(asset => asset?.name === parsed.asset);
    if (matches.length !== 1) {
        throw new ReleaseDownloadError(`GitHub release ${parsed.tag} does not contain exactly one ${parsed.asset} asset.`);
    }
    const asset = matches[0];
    if (asset.browser_download_url !== parsed.url) {
        throw new ReleaseDownloadError(`The GitHub release API returned a different URL for ${parsed.asset}.`);
    }
    if (asset.state && asset.state !== 'uploaded') {
        throw new ReleaseDownloadError(`The ${parsed.asset} release asset is not fully uploaded.`);
    }
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || !Number.isSafeInteger(asset.id) || asset.id <= 0) {
        throw new ReleaseDownloadError(`The GitHub release API returned an unusable ${parsed.asset} asset.`);
    }
    if (typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(asset.digest)
        && asset.digest.slice(7).toLowerCase() !== expectedChecksum) {
        throw new ChecksumMismatchError(`The GitHub release API digest for ${parsed.asset} does not match the pinned SHA-256 checksum.`);
    }
    return asset;
}

async function downloadFromApi(parsed, options) {
    const asset = await readReleaseAsset(parsed, options);
    const assetUrl = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/releases/assets/${asset.id}`;
    const { response, url } = await fetchFollowingRedirects(options.fetchImpl, assetUrl, {
        allowedHosts: ASSET_REDIRECT_HOSTS,
        token: options.token,
        accept: 'application/octet-stream',
        timeoutMs: options.timeoutMs,
    });
    if (!response.ok) {
        await cancelBody(response);
        throw new HttpStatusError(response.status, url, [options.token]);
    }
    return saveVerifiedResponse(response, options.destination, options.expectedChecksum, options);
}

function isTransient(error) {
    if (error instanceof ChecksumMismatchError || error instanceof UnsafeRedirectError) return false;
    if (error instanceof HttpStatusError) return error.status === 408 || error.status === 429 || error.status >= 500;
    return true;
}

/**
 * Download an immutable, pinned release asset.
 *
 * The normal URL is tried first. Transient failures are retried a bounded number
 * of times. If an exact GitHub release download still fails, the GitHub release
 * API finds the same named asset by tag and downloads it through the API asset
 * endpoint. Every path must match the caller's pinned SHA-256, and bytes reach
 * the destination only through an atomic rename after verification.
 */
export async function downloadPinnedAsset({
    url,
    sha256,
    destination,
    fallbackUrl = '',
    fetchImpl = globalThis.fetch,
    logger = () => {},
    attempts = DEFAULT_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
    token = (process.env[TOKEN_ENV] || '').trim(),
    maxRedirects = MAX_REDIRECTS,
} = {}) {
    if (typeof fetchImpl !== 'function') throw new ReleaseDownloadError('A fetch implementation is required.');
    if (!destination || typeof destination !== 'string') throw new ReleaseDownloadError('A destination file is required.');
    const expectedChecksum = String(sha256 ?? '').toLowerCase();
    if (!CHECKSUM_PATTERN.test(expectedChecksum)) throw new ReleaseDownloadError('A pinned 64-character SHA-256 checksum is required.');
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 4) throw new ReleaseDownloadError('The retry count must be between 1 and 4.');
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 60000) throw new ReleaseDownloadError('The retry delay must be between 0 and 60000 milliseconds.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) throw new ReleaseDownloadError('The timeout must be between 1000 and 900000 milliseconds.');

    const primary = parseSourceUrl(url);
    let fallback = null;
    if (fallbackUrl) {
        fallback = parseGithubReleaseUrl(fallbackUrl);
        if (primary.kind !== 'gradle') throw new ReleaseDownloadError('A fallback URL is only accepted for a pinned Gradle distribution URL.');
        if (fallback.asset !== primary.asset) throw new ReleaseDownloadError('The GitHub fallback asset must have the same file name as the Gradle distribution.');
    } else if (primary.kind === 'gradle') {
        throw new ReleaseDownloadError('A pinned Gradle distribution needs an explicit GitHub release fallback URL.');
    }

    if (fs.existsSync(destination)) {
        let existing = '';
        try {
            existing = sha256File(destination);
        } catch {
            existing = '';
        }
        if (existing === expectedChecksum) {
            logger(`Using the existing verified ${path.basename(destination)}.`);
            return { source: 'existing', sha256: existing, bytes: fs.statSync(destination).size };
        }
        logger(`The existing ${path.basename(destination)} does not match its pinned checksum; replacing it from the verified source.`);
    }

    const errors = [];
    const options = { fetchImpl, token, timeoutMs, expectedChecksum, destination };

    async function trySource(source, label, sourceAttempts, allowedHosts) {
        for (let attempt = 1; attempt <= sourceAttempts; attempt++) {
            logger(`${label} attempt ${attempt}/${sourceAttempts}: ${source.url}`);
            try {
                const { response, url: finalUrl } = await fetchFollowingRedirects(fetchImpl, source.url, {
                    allowedHosts, token, accept: '*/*', maxRedirects, timeoutMs,
                });
                if (!response.ok) {
                    await cancelBody(response);
                    throw new HttpStatusError(response.status, finalUrl, [token]);
                }
                const result = await saveVerifiedResponse(response, destination, expectedChecksum, options);
                return { ...result, source: label };
            } catch (error) {
                if (error instanceof ChecksumMismatchError || error instanceof UnsafeRedirectError) throw error;
                errors.push(`${label}: ${describeError(error, [token])}`);
                logger(`${label} failed: ${describeError(error, [token])}`);
                if (!isTransient(error)) return null;
                if (attempt < sourceAttempts) await sleep(retryDelayMs * attempt);
            }
        }
        return null;
    }

    const primaryResult = await trySource(primary, 'download', attempts, primary.kind === 'gradle' ? GRADLE_DOWNLOAD_HOSTS : GITHUB_DOWNLOAD_HOSTS);
    if (primaryResult) return primaryResult;

    if (fallback) {
        const fallbackResult = await trySource(fallback, 'GitHub release fallback', attempts, GITHUB_DOWNLOAD_HOSTS);
        if (fallbackResult) return fallbackResult;
    }

    const apiSource = fallback || primary;
    logger(`Trying the GitHub release API for ${apiSource.asset}.`);
    try {
        const result = await downloadFromApi(apiSource, options);
        return { ...result, source: 'GitHub release API' };
    } catch (error) {
        if (!isTransient(error)) throw error;
        errors.push(`GitHub release API: ${describeError(error, [token])}`);
    }

    throw new ReleaseDownloadError(`Could not download ${primary.asset} from its verified sources. ${errors.join(' ')}`);
}
