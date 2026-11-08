import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
    ChecksumMismatchError,
    TOKEN_ENV,
    downloadPinnedAsset,
    parseGithubReleaseUrl,
} from '../scripts/lib/release-download.js';

const assetUrl = 'https://github.com/example/project/releases/download/v1.2.3/asset.zip';
const tag = 'v1.2.3';
const assetName = 'asset.zip';
const payload = Buffer.from('verified release asset bytes');
const checksum = createHash('sha256').update(payload).digest('hex');
const metadataUrl = 'https://api.github.com/repos/example/project/releases/tags/v1.2.3';
const apiAssetUrl = 'https://api.github.com/repos/example/project/releases/assets/12345';
const signedCdnUrl = 'https://release-assets.githubusercontent.com/release/asset?X-Amz-Signature=signed-secret&X-Amz-Credential=credential';

function temporary(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-release-download-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    return root;
}

function release(overrides = {}) {
    return {
        tag_name: tag,
        assets: [{
            id: 12345,
            name: assetName,
            browser_download_url: assetUrl,
            size: payload.length,
            state: 'uploaded',
            digest: `sha256:${checksum}`,
            ...overrides,
        }],
    };
}

function json(value) {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function status(value, headers = {}) {
    return new Response(null, { status: value, headers });
}

function options(destination, fetchImpl, extra = {}) {
    return {
        url: assetUrl,
        sha256: checksum,
        destination,
        fetchImpl,
        attempts: 2,
        retryDelayMs: 0,
        timeoutMs: 5000,
        sleep: async () => {},
        token: '',
        ...extra,
    };
}

function tokenEnvironment(t, { token, genericToken = '' } = {}) {
    const names = [TOKEN_ENV, 'GITHUB_TOKEN', 'GH_TOKEN'];
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    if (token === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = token;
    for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
        if (genericToken) process.env[name] = genericToken;
        else delete process.env[name];
    }
    t.after(() => {
        for (const name of names) {
            const value = previous[name];
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
}

test('a healthy release download is used once, with no API fallback', async t => {
    const root = temporary(t);
    const destination = path.join(root, 'asset.zip');
    const calls = [];
    const result = await downloadPinnedAsset(options(destination, async (url, request) => {
        calls.push({ url, request });
        return new Response(payload);
    }));
    assert.equal(result.source, 'download');
    assert.deepEqual(fs.readFileSync(destination), payload);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, assetUrl);
    assert.equal(calls[0].request.redirect, 'manual');
    assert.equal(calls[0].request.headers.get('authorization'), null);
});

test('HTTP 504 falls back to the GitHub release API and keeps the pinned checksum', async t => {
    const root = temporary(t);
    const destination = path.join(root, 'asset.zip');
    const token = 'github-token-super-secret';
    const responses = [
        () => status(504),
        () => status(504),
        () => json(release()),
        () => status(302, { location: signedCdnUrl }),
        () => new Response(payload),
    ];
    const calls = [];
    const logs = [];
    let index = 0;
    const result = await downloadPinnedAsset(options(destination, async (url, request) => {
        calls.push({ url, request });
        const next = responses[index++];
        assert.ok(next, `unexpected request to ${url}`);
        return next();
    }, { token, logger: message => logs.push(message) }));
    assert.equal(result.source, 'GitHub release API');
    assert.deepEqual(fs.readFileSync(destination), payload);
    assert.deepEqual(calls.map(call => call.url), [assetUrl, assetUrl, metadataUrl, apiAssetUrl, signedCdnUrl]);
    assert.equal(calls[0].request.headers.get('authorization'), null);
    assert.equal(calls[1].request.headers.get('authorization'), null);
    assert.equal(calls[2].request.headers.get('authorization'), `Bearer ${token}`);
    assert.equal(calls[3].request.headers.get('authorization'), `Bearer ${token}`);
    assert.equal(calls[4].request.headers.get('authorization'), null);
    const logged = logs.join('\n');
    assert.doesNotMatch(logged, /signed-secret|X-Amz|Signature|github-token-super-secret|\?/);
});

test('the explicit environment token is used only for GitHub API requests', async t => {
    const root = temporary(t);
    const destination = path.join(root, 'asset.zip');
    const token = 'environment-token-super-secret';
    tokenEnvironment(t, { token });
    const responses = [
        () => status(504),
        () => json(release()),
        () => status(302, { location: signedCdnUrl }),
        () => new Response(payload),
    ];
    const calls = [];
    const logs = [];
    let index = 0;
    const result = await downloadPinnedAsset(options(destination, async (url, request) => {
        calls.push({ url, request });
        const next = responses[index++];
        assert.ok(next, `unexpected request to ${url}`);
        return next();
    }, { token: undefined, attempts: 1, logger: message => logs.push(message) }));
    assert.equal(result.source, 'GitHub release API');
    assert.deepEqual(calls.map(call => call.url), [assetUrl, metadataUrl, apiAssetUrl, signedCdnUrl]);
    assert.deepEqual(calls.map(call => call.request.headers.get('authorization')), [
        null, `Bearer ${token}`, `Bearer ${token}`, null,
    ]);
    assert.doesNotMatch(logs.join('\n'), /environment-token-super-secret|X-Amz|Signature|\?/);
});

test('generic GitHub token variables are not consumed', async t => {
    const root = temporary(t);
    const destination = path.join(root, 'asset.zip');
    tokenEnvironment(t, { token: undefined, genericToken: 'generic-token-must-not-be-used' });
    const responses = [
        () => status(504),
        () => json(release()),
        () => status(302, { location: signedCdnUrl }),
        () => new Response(payload),
    ];
    const calls = [];
    let index = 0;
    await downloadPinnedAsset(options(destination, async (url, request) => {
        calls.push({ url, request });
        const next = responses[index++];
        assert.ok(next, `unexpected request to ${url}`);
        return next();
    }, { token: undefined, attempts: 1 }));
    assert.deepEqual(calls.map(call => call.request.headers.get('authorization')), [null, null, null, null]);
});

test('a release redirect to the CDN never receives the environment token', async t => {
    const root = temporary(t);
    const destination = path.join(root, 'asset.zip');
    const token = 'redirect-token-super-secret';
    tokenEnvironment(t, { token });
    const calls = [];
    let index = 0;
    const result = await downloadPinnedAsset(options(destination, async (url, request) => {
        calls.push({ url, request });
        if (index++ === 0) return status(302, { location: signedCdnUrl });
        return new Response(payload);
    }, { token: undefined, attempts: 1 }));
    assert.equal(result.source, 'download');
    assert.deepEqual(calls.map(call => call.url), [assetUrl, signedCdnUrl]);
    assert.deepEqual(calls.map(call => call.request.headers.get('authorization')), [null, null]);
});

test('a checksum mismatch rejects the download and leaves the previous file untouched', async t => {
    const root = temporary(t);
    const destination = path.join(root, 'asset.zip');
    fs.writeFileSync(destination, 'previous verified bytes');
    let calls = 0;
    await assert.rejects(downloadPinnedAsset(options(destination, async () => {
        calls++;
        return new Response(Buffer.from('tampered bytes'));
    })), error => {
        assert.ok(error instanceof ChecksumMismatchError);
        assert.equal(error.code, 'CHECKSUM_MISMATCH');
        return true;
    });
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'previous verified bytes');
    assert.deepEqual(fs.readdirSync(root).filter(name => name.includes('.part-')), []);
});

test('network failures are bounded and never leak signed URLs or credentials', async t => {
    const root = temporary(t);
    const destination = path.join(root, 'asset.zip');
    const token = 'github-token-super-secret';
    let calls = 0;
    await assert.rejects(downloadPinnedAsset(options(destination, async () => {
        calls++;
        if (calls <= 2) throw new Error(`connect failed ${signedCdnUrl}`);
        throw new Error(`release API failed ${metadataUrl}?token=${token}`);
    }, { token })), error => {
        assert.doesNotMatch(error.message, /signed-secret|github-token-super-secret|X-Amz|Signature|token=/);
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(String(error.stack), /signed-secret|github-token-super-secret|X-Amz|Signature|token=/);
        return true;
    });
    assert.equal(calls, 3);
    assert.equal(fs.existsSync(destination), false);
});

test('missing assets and unsupported URLs are rejected without trying an unsafe host', async t => {
    const root = temporary(t);
    const destination = path.join(root, 'asset.zip');
    let called = false;
    await assert.rejects(downloadPinnedAsset({
        url: 'https://example.test/asset.zip', sha256: checksum, destination,
        fetchImpl: async () => {
            called = true;
            throw new Error('the network must not be used');
        },
    }), /Only exact GitHub release/);
    assert.equal(called, false);

    const calls = [];
    await assert.rejects(downloadPinnedAsset(options(destination, async url => {
        calls.push(url);
        if (calls.length <= 2) return status(504);
        return json({ tag_name: tag, assets: [] });
    })), /does not contain exactly one asset\.zip asset/);
    assert.deepEqual(calls, [assetUrl, assetUrl, metadataUrl]);
    assert.equal(fs.existsSync(destination), false);
});

test('a redirect to an untrusted host is blocked and no signed query is reported', async t => {
    const root = temporary(t);
    const destination = path.join(root, 'asset.zip');
    const calls = [];
    await assert.rejects(downloadPinnedAsset(options(destination, async url => {
        calls.push(url);
        return status(302, { location: 'https://evil.example/asset.zip?token=signed-secret' });
    })), error => {
        assert.match(error.message, /Blocked a redirect to an untrusted host: https:\/\/evil\.example\/asset\.zip/);
        assert.doesNotMatch(error.message, /signed-secret|token=/);
        return true;
    });
    assert.deepEqual(calls, [assetUrl]);
    assert.equal(calls.some(url => url.startsWith('https://evil.example')), false);
});

test('a GitHub API digest mismatch is rejected before the asset download', async t => {
    const root = temporary(t);
    const destination = path.join(root, 'asset.zip');
    const calls = [];
    await assert.rejects(downloadPinnedAsset(options(destination, async url => {
        calls.push(url);
        if (calls.length <= 2) return status(504);
        return json(release({ digest: `sha256:${'a'.repeat(64)}` }));
    })), error => error.code === 'CHECKSUM_MISMATCH');
    assert.deepEqual(calls, [assetUrl, assetUrl, metadataUrl]);
    assert.equal(fs.existsSync(destination), false);
});

test('an existing verified file is reused without any network request', async t => {
    const root = temporary(t);
    const destination = path.join(root, 'asset.zip');
    fs.writeFileSync(destination, payload);
    const result = await downloadPinnedAsset(options(destination, async () => {
        throw new Error('the network must not be used');
    }));
    assert.equal(result.source, 'existing');
    assert.deepEqual(fs.readFileSync(destination), payload);
});

test('release URLs require an exact repository, tag and asset shape', () => {
    assert.deepEqual(parseGithubReleaseUrl(assetUrl), {
        kind: 'github', owner: 'example', repo: 'project', tag, asset: assetName, url: assetUrl,
    });
    for (const invalid of [
        'https://github.com/example/project/releases/latest',
        'https://github.com/example/project/releases/download/v1.2.3/../asset.zip',
        'http://github.com/example/project/releases/download/v1.2.3/asset.zip',
        'https://github.com.evil.example/example/project/releases/download/v1.2.3/asset.zip',
        'https://github.com/example/project/releases/download/v1.2.3/asset.zip?token=secret',
        'https://user:pass@github.com/example/project/releases/download/v1.2.3/asset.zip',
    ]) {
        assert.throws(() => parseGithubReleaseUrl(invalid));
    }
});
