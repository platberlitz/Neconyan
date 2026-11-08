import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ReleaseDownloadError, downloadPinnedAsset, parseGradleDistributionUrl } from './release-download.js';

/**
 * Immutable GitHub release fallbacks for Gradle distributions. The wrapper's
 * distributionSha256Sum remains the only accepted checksum. A new wrapper
 * version must add its exact release URL here before a release build can prime
 * the cache.
 */
export const GRADLE_RELEASE_FALLBACKS = Object.freeze({
    'gradle-8.13-bin.zip': 'https://github.com/gradle/gradle-distributions/releases/download/v8.13.0/gradle-8.13-bin.zip',
});

const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

function readProperty(text, key) {
    const match = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
    return match ? match[1].replace(/\\([:= ])/g, '$1').trim() : '';
}

function safeRelativePath(value, key) {
    if (!value || path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
        throw new ReleaseDownloadError(`The Gradle wrapper ${key} must be a relative path without '..'.`);
    }
    return value;
}

export function readGradleWrapperConfiguration(propertiesFile) {
    const text = fs.readFileSync(propertiesFile, 'utf8');
    const distributionUrl = readProperty(text, 'distributionUrl');
    const distributionSha256Sum = readProperty(text, 'distributionSha256Sum').toLowerCase();
    const configuration = {
        distributionUrl,
        distributionSha256Sum,
        distributionBase: readProperty(text, 'distributionBase') || 'GRADLE_USER_HOME',
        distributionPath: safeRelativePath(readProperty(text, 'distributionPath') || 'wrapper/dists', 'distributionPath'),
        zipStoreBase: readProperty(text, 'zipStoreBase') || 'GRADLE_USER_HOME',
        zipStorePath: safeRelativePath(readProperty(text, 'zipStorePath') || 'wrapper/dists', 'zipStorePath'),
    };
    if (!distributionUrl) throw new ReleaseDownloadError('The Gradle wrapper has no distributionUrl.');
    if (!CHECKSUM_PATTERN.test(distributionSha256Sum)) {
        throw new ReleaseDownloadError('The Gradle wrapper has no pinned distributionSha256Sum.');
    }
    for (const key of ['distributionBase', 'zipStoreBase']) {
        if (configuration[key] !== 'GRADLE_USER_HOME') {
            throw new ReleaseDownloadError(`The Gradle wrapper ${key} must be GRADLE_USER_HOME for cache priming.`);
        }
    }
    parseGradleDistributionUrl(distributionUrl);
    return configuration;
}

/** Match the wrapper's distribution directory name and MD5-base36 hash. */
export function gradleDistributionCachePath(gradleUserHome, configuration) {
    const parsed = parseGradleDistributionUrl(configuration.distributionUrl);
    const filename = parsed.asset;
    const dot = filename.lastIndexOf('.');
    const distributionName = dot > 0 ? filename.slice(0, dot) : filename;
    const digest = createHash('md5').update(parsed.url, 'utf8').digest('hex');
    const distributionHash = BigInt(`0x${digest}`).toString(36);
    return path.join(gradleUserHome, configuration.zipStorePath, distributionName, distributionHash, filename);
}

/** Put the verified Gradle distribution where the wrapper already looks. */
export async function primeGradleDistribution({
    root = process.cwd(),
    gradleUserHome = process.env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle'),
    propertiesFile = path.join(root, 'android/gradle/wrapper/gradle-wrapper.properties'),
    fetchImpl,
    logger = () => {},
    ...downloadOptions
} = {}) {
    const configuration = readGradleWrapperConfiguration(propertiesFile);
    const parsed = parseGradleDistributionUrl(configuration.distributionUrl);
    const fallbackUrl = GRADLE_RELEASE_FALLBACKS[parsed.asset];
    if (!fallbackUrl) {
        throw new ReleaseDownloadError(`No pinned GitHub release fallback is recorded for ${parsed.asset}. Add one in scripts/lib/gradle-distribution.js.`);
    }
    const destination = gradleDistributionCachePath(gradleUserHome, configuration);
    const result = await downloadPinnedAsset({
        url: parsed.url,
        fallbackUrl,
        sha256: configuration.distributionSha256Sum,
        destination,
        fetchImpl,
        logger,
        ...downloadOptions,
    });
    return { destination, ...result };
}
