import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
    GRADLE_RELEASE_FALLBACKS,
    gradleDistributionCachePath,
    primeGradleDistribution,
    readGradleWrapperConfiguration,
} from '../scripts/lib/gradle-distribution.js';
import { TOKEN_ENV } from '../scripts/lib/release-download.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wrapperProperties = path.join(root, 'android/gradle/wrapper/gradle-wrapper.properties');
const gradleUrl = 'https://services.gradle.org/distributions/gradle-8.13-bin.zip';
const fallbackUrl = 'https://github.com/gradle/gradle-distributions/releases/download/v8.13.0/gradle-8.13-bin.zip';
const metadataUrl = 'https://api.github.com/repos/gradle/gradle-distributions/releases/tags/v8.13.0';
const apiAssetUrl = 'https://api.github.com/repos/gradle/gradle-distributions/releases/assets/232373824';
const signedCdnUrl = 'https://release-assets.githubusercontent.com/release/gradle?X-Amz-Signature=signed-secret';

function temporary(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-gradle-download-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    return directory;
}

function propertiesFile(directory, { url = gradleUrl, sha256, zipStorePath = 'wrapper/dists' } = {}) {
    const filename = path.join(directory, 'gradle-wrapper.properties');
    fs.writeFileSync(filename, [
        'distributionBase=GRADLE_USER_HOME',
        'distributionPath=wrapper/dists',
        `distributionUrl=${url.replace(':', '\\:')}`,
        ...(sha256 ? [`distributionSha256Sum=${sha256}`] : []),
        'zipStoreBase=GRADLE_USER_HOME',
        `zipStorePath=${zipStorePath}`,
    ].join('\n'));
    return filename;
}

function json(value) {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function status(value, headers = {}) {
    return new Response(null, { status: value, headers });
}

test('the wrapper cache path matches Gradle 8.13 and keeps the existing checksum pin', () => {
    const configuration = readGradleWrapperConfiguration(wrapperProperties);
    assert.equal(configuration.distributionUrl, gradleUrl);
    assert.equal(configuration.distributionSha256Sum, '20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78');
    assert.equal(configuration.zipStorePath, 'wrapper/dists');
    assert.equal(GRADLE_RELEASE_FALLBACKS['gradle-8.13-bin.zip'], fallbackUrl);
    const destination = gradleDistributionCachePath('/gradle-home', configuration);
    assert.ok(destination.endsWith(path.join('wrapper', 'dists', 'gradle-8.13-bin', '5xuhj0ry160q40clulazy9h7d', 'gradle-8.13-bin.zip')));
    assert.ok(gradleDistributionCachePath('/gradle-home', { ...configuration, zipStorePath: 'custom/dists' })
        .includes(path.join('custom', 'dists', 'gradle-8.13-bin')));
});

test('a healthy Gradle distribution follows the official redirect without the API fallback', async t => {
    const directory = temporary(t);
    const gradleUserHome = path.join(directory, 'gradle-home');
    const payload = Buffer.from('healthy gradle distribution');
    const checksum = createHash('sha256').update(payload).digest('hex');
    const wrapper = propertiesFile(directory, { sha256: checksum });
    const calls = [];
    const result = await primeGradleDistribution({
        root,
        gradleUserHome,
        propertiesFile: wrapper,
        fetchImpl: async (url, request) => {
            calls.push({ url, request });
            if (calls.length === 1) return status(307, { location: fallbackUrl });
            return new Response(payload);
        },
        attempts: 1,
        retryDelayMs: 0,
        timeoutMs: 5000,
        sleep: async () => {},
        token: '',
    });
    assert.equal(result.source, 'download');
    assert.deepEqual(calls.map(call => call.url), [gradleUrl, fallbackUrl]);
    assert.deepEqual(fs.readFileSync(result.destination), payload);
});

test('Gradle priming falls back to the pinned GitHub release and verified API asset', async t => {
    const directory = temporary(t);
    const gradleUserHome = path.join(directory, 'gradle-home');
    const payload = Buffer.from('fake gradle distribution');
    const checksum = createHash('sha256').update(payload).digest('hex');
    const wrapper = propertiesFile(directory, { sha256: checksum });
    const token = 'gradle-environment-token-super-secret';
    const previousToken = process.env[TOKEN_ENV];
    process.env[TOKEN_ENV] = token;
    t.after(() => {
        if (previousToken === undefined) delete process.env[TOKEN_ENV];
        else process.env[TOKEN_ENV] = previousToken;
    });
    const responses = [
        () => status(504),
        () => status(504),
        () => json({
            tag_name: 'v8.13.0',
            assets: [{
                id: 232373824,
                name: 'gradle-8.13-bin.zip',
                browser_download_url: fallbackUrl,
                size: payload.length,
                state: 'uploaded',
                digest: null,
            }],
        }),
        () => status(302, { location: signedCdnUrl }),
        () => new Response(payload),
    ];
    const calls = [];
    const logs = [];
    let index = 0;
    const result = await primeGradleDistribution({
        root,
        gradleUserHome,
        propertiesFile: wrapper,
        fetchImpl: async (url, request) => {
            calls.push({ url, request });
            const next = responses[index++];
            assert.ok(next, `unexpected request to ${url}`);
            return next();
        },
        attempts: 1,
        retryDelayMs: 0,
        timeoutMs: 5000,
        sleep: async () => {},
        logger: message => logs.push(message),
    });
    const expected = path.join(gradleUserHome, 'wrapper', 'dists', 'gradle-8.13-bin', '5xuhj0ry160q40clulazy9h7d', 'gradle-8.13-bin.zip');
    assert.equal(result.destination, expected);
    assert.equal(result.source, 'GitHub release API');
    assert.deepEqual(fs.readFileSync(expected), payload);
    assert.deepEqual(calls.map(call => call.url), [gradleUrl, fallbackUrl, metadataUrl, apiAssetUrl, signedCdnUrl]);
    assert.deepEqual(calls.map(call => call.request.headers.get('authorization')), [
        null, null, `Bearer ${token}`, `Bearer ${token}`, null,
    ]);
    assert.doesNotMatch(logs.join('\n'), /gradle-environment-token-super-secret|signed-secret|X-Amz|Signature|\?/);
});

test('an unrecorded Gradle version is refused before any network request', async t => {
    const directory = temporary(t);
    const wrapper = propertiesFile(directory, {
        url: 'https://services.gradle.org/distributions/gradle-8.14-bin.zip',
        sha256: 'a'.repeat(64),
    });
    let called = false;
    await assert.rejects(primeGradleDistribution({
        root,
        gradleUserHome: path.join(directory, 'gradle-home'),
        propertiesFile: wrapper,
        fetchImpl: async () => {
            called = true;
            throw new Error('the network must not be used');
        },
    }), /No pinned GitHub release fallback is recorded for gradle-8\.14-bin\.zip/);
    assert.equal(called, false);
});

test('the wrapper configuration must keep a checksum and a safe cache path', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-gradle-config-'));
    try {
        assert.throws(() => readGradleWrapperConfiguration(propertiesFile(directory)), /no pinned distributionSha256Sum/);
        assert.throws(() => readGradleWrapperConfiguration(propertiesFile(directory, {
            sha256: 'a'.repeat(64), zipStorePath: '../outside',
        })), /must be a relative path without '\.\.'/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
