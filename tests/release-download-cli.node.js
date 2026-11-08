import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { TOKEN_ENV } from '../scripts/lib/release-download.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'scripts/fetch-release-asset.js');
const assetUrl = 'https://github.com/example/project/releases/download/v1.2.3/asset.zip';
const metadataUrl = 'https://api.github.com/repos/example/project/releases/tags/v1.2.3';
const apiAssetUrl = 'https://api.github.com/repos/example/project/releases/assets/12345';
const signedCdnUrl = 'https://release-assets.githubusercontent.com/release/asset?X-Amz-Signature=signed-secret';
const payload = Buffer.from('CLI verified release asset bytes');
const checksum = createHash('sha256').update(payload).digest('hex');

function temporary(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-release-cli-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    return directory;
}

function preloadSource(config) {
    return `import fs from 'node:fs';
const config = ${JSON.stringify(config)};
const payload = fs.readFileSync(config.payloadPath);
let calls = [];
globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, authorization: options.headers?.get?.('authorization') ?? null });
    fs.writeFileSync(config.capturePath, JSON.stringify(calls));
    if (url === config.assetUrl) return new Response(null, { status: 504 });
    if (url === config.metadataUrl) {
        return new Response(JSON.stringify({
            tag_name: 'v1.2.3',
            assets: [{
                id: 12345,
                name: 'asset.zip',
                browser_download_url: config.assetUrl,
                size: payload.length,
                state: 'uploaded',
                digest: 'sha256:' + config.checksum,
            }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === config.apiAssetUrl) return new Response(null, { status: 302, headers: { location: config.cdnUrl } });
    if (url === config.cdnUrl) return new Response(payload, { status: 200 });
    return new Response(null, { status: 500 });
};
`;
}

function run(args, environment) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, {
            cwd: root,
            env: { ...process.env, ...environment },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => resolve({ code, stdout, stderr }));
    });
}

test('the CLI consumes the explicit environment token only for GitHub API requests', async t => {
    const directory = temporary(t);
    const payloadPath = path.join(directory, 'payload.bin');
    const capturePath = path.join(directory, 'calls.json');
    const preloadPath = path.join(directory, 'mock-fetch.mjs');
    const destination = path.join(directory, 'asset.zip');
    fs.writeFileSync(payloadPath, payload);
    fs.writeFileSync(preloadPath, preloadSource({
        assetUrl, metadataUrl, apiAssetUrl, cdnUrl: signedCdnUrl, checksum, payloadPath, capturePath,
    }));
    const token = 'cli-environment-token-super-secret';
    const genericToken = 'generic-token-must-not-be-used';
    const nodeOptions = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preloadPath).href}`].filter(Boolean).join(' ');
    const result = await run([
        cli,
        '--url', assetUrl,
        '--sha256', checksum,
        '--output', destination,
        '--attempts', '1',
        '--retry-delay-ms', '0',
        '--timeout-ms', '5000',
    ], {
        NODE_OPTIONS: nodeOptions,
        [TOKEN_ENV]: token,
        GITHUB_TOKEN: genericToken,
        GH_TOKEN: genericToken,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(destination), payload);
    const calls = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    assert.deepEqual(calls.map(call => call.url), [assetUrl, metadataUrl, apiAssetUrl, signedCdnUrl]);
    assert.deepEqual(calls.map(call => call.authorization), [null, `Bearer ${token}`, `Bearer ${token}`, null]);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(output, /cli-environment-token-super-secret|generic-token-must-not-be-used|signed-secret|X-Amz|Signature|\?/);
});

test('the CLI help names the token environment variable and accepts no token argument', async () => {
    const result = await run([cli, '--help'], {});
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(TOKEN_ENV));
    assert.doesNotMatch(result.stdout, /--token\b/);
});

test('the CLI rejects a token supplied as an argument without printing its value', async t => {
    const directory = temporary(t);
    const destination = path.join(directory, 'asset.zip');
    for (const args of [
        ['--token=super-secret-argument'],
        ['--token', 'super-secret-argument'],
    ]) {
        const result = await run([
            cli,
            '--url', 'https://example.test/asset.zip',
            '--sha256', checksum,
            '--output', destination,
            ...args,
        ], { [TOKEN_ENV]: '' });
        assert.equal(result.code, 2, result.stderr);
        assert.match(result.stderr, /Unknown option: --token/);
        assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /super-secret-argument/);
    }
});
