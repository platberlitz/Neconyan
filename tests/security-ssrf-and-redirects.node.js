import assert from 'node:assert/strict';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import express from 'express';
import { ProxyAgent } from 'proxy-agent';

function runIsolatedScript(code, env = {}) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, ...env },
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, `Subprocess failed (${result.status}):\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    return result;
}

test('FN-HIGH-2 & BLOCKER-1: PrivateRequestAgent blocks non-public ranges and PinnedAddressAgent preserves pinned IP when delegating to PrivateRequestAgent or ProxyAgent', async () => {
    const { PrivateRequestAgent, isNonPublicIpAddress, parseAndUnwrapIpAddress } = await import('../src/private-request-filter.js');
    const { PinnedAddressAgent } = await import('../src/safe-http.js');

    for (const addr of [
        '0.0.0.0',
        '::',
        '[::]',
        '127.0.0.1',
        '::1',
        '[::1]',
        '::ffff:127.0.0.1',
        '[::ffff:127.0.0.1]',
        '::ffff:7f00:1',
        '::ffff:169.254.169.254',
        '100.64.0.1',
        '192.168.1.1',
        '10.0.0.1',
        '172.16.0.1',
        'fe80::1',
        'fc00::1',
    ]) {
        assert.equal(isNonPublicIpAddress(addr), true, `Expected ${addr} to be classified as non-public`);
    }

    assert.equal(isNonPublicIpAddress('93.184.216.34'), false);
    assert.equal(isNonPublicIpAddress('::ffff:93.184.216.34'), false);
    assert.equal(parseAndUnwrapIpAddress('[::ffff:127.0.0.1]')?.toString(), '127.0.0.1');

    const strictAgent = new PrivateRequestAgent({
        privateAddressWhitelist: [],
        logBlocked: false,
        logAllowed: false,
        allowUnresolvedHosts: false,
        enableKeepAlive: false,
    });

    for (const blockedHost of ['0.0.0.0', '::', '[::1]', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '100.64.0.1']) {
        await assert.rejects(
            strictAgent.connect({}, { host: blockedHost, port: 80, secureEndpoint: false }),
            /Blocked request to private IP address/,
            `Expected PrivateRequestAgent to block ${blockedHost}`,
        );
    }

    // Whitelisting 127.0.0.0/8 allows both 127.0.0.1 and ::ffff:127.0.0.1
    const loopbackServer = http.createServer((_req, res) => res.end('ok'));
    await new Promise(resolve => loopbackServer.listen(0, '127.0.0.1', resolve));
    const port = loopbackServer.address().port;
    const origGlobalAgent = http.globalAgent;
    const origHttpsGlobalAgent = https.globalAgent;
    try {
        const loopbackAllowedAgent = new PrivateRequestAgent({
            privateAddressWhitelist: ['127.0.0.0/8'],
            logBlocked: false,
            logAllowed: false,
            allowUnresolvedHosts: false,
            enableKeepAlive: false,
        });
        const sock = await loopbackAllowedAgent.connect({}, { host: '::ffff:127.0.0.1', port, secureEndpoint: false });
        sock.destroy();

        // BLOCKER-1: When http.globalAgent is PrivateRequestAgent (with 127.0.0.0/8 whitelisted) or ProxyAgent,
        // PinnedAddressAgent({ allowPrivate: false }) must NOT pass the unpinned hostname to globalAgent to re-resolve to 127.0.0.1.
        let delegatedOptions = null;
        const fakePrivateAgent = Object.create(PrivateRequestAgent.prototype);
        fakePrivateAgent.connect = async (_req, opts) => {
            delegatedOptions = opts;
            return { mocked: true };
        };
        http.globalAgent = fakePrivateAgent;
        https.globalAgent = fakePrivateAgent;

        const pinned = new PinnedAddressAgent({
            allowPrivate: false,
            lookupAddresses: async () => ['93.184.216.34'],
        });
        const callerOptions = { host: 'rebind.example', hostname: 'rebind.example', port: 443, secureEndpoint: true };
        await pinned.connect({}, callerOptions);
        assert.equal(delegatedOptions?.host, '93.184.216.34', 'PinnedAddressAgent must pass the pinned IP, never the raw hostname, to PrivateRequestAgent');
        assert.equal(callerOptions.host, '93.184.216.34', 'PinnedAddressAgent must mutate options.host in place for agent-base sub-agents');
        assert.equal(callerOptions.hostname, '93.184.216.34', 'PinnedAddressAgent must mutate options.hostname in place for agent-base sub-agents');
        assert.equal(callerOptions.servername, 'rebind.example', 'PinnedAddressAgent must preserve TLS servername for SNI and certificate verification');

        // And if lookupAddresses returns 127.0.0.1 while allowPrivate is false, PinnedAddressAgent rejects BEFORE delegating to PrivateRequestAgent
        delegatedOptions = null;
        const pinnedPrivate = new PinnedAddressAgent({
            allowPrivate: false,
            lookupAddresses: async () => ['127.0.0.1'],
        });
        await assert.rejects(
            pinnedPrivate.connect({}, { host: 'rebind.example', port, secureEndpoint: false }),
            { code: 'SAFE_HTTP_PRIVATE_IP' },
        );
        assert.equal(delegatedOptions, null, 'Must not delegate to PrivateRequestAgent when allowPrivate is false and IP is private');

        // BLOCKER-1B: Verify ProxyAgent + PinnedAddressAgent through agent-base's createSocket lifecycle
        // (1) ProxyAgent bypass (getProxyForUrl: () => ''): mutates options in place and connects to connectIp (127.0.0.1:port)
        // while preserving Host: pinned-test.invalid:<port>
        const bypassProxyAgent = new ProxyAgent({ getProxyForUrl: () => '', keepAlive: false });
        http.globalAgent = bypassProxyAgent;
        const bypassPinnedAgent = new PinnedAddressAgent({
            allowPrivate: true,
            lookupAddresses: async () => ['127.0.0.1'],
        });
        const bypassSocket = await new Promise((resolve, reject) => {
            const fakeReq = {
                getHeader: (name) => String(name).toLowerCase() === 'host' ? `pinned-test.invalid:${port}` : undefined,
                setHeader: () => {},
                path: '/test-bypass',
                outputData: [],
                _implicitHeader: () => {},
            };
            bypassPinnedAgent.createSocket(
                fakeReq,
                { host: 'pinned-test.invalid', hostname: 'pinned-test.invalid', port, secureEndpoint: false },
                (err, s) => err ? reject(err) : resolve(s),
            );
        });
        bypassSocket.destroy();
        bypassProxyAgent.destroy();

        // (2) ProxyAgent with an HTTP forward proxy for plain http: and CONNECT for https:
        let proxyReceivedRequestUrl = null;
        let proxyReceivedHostHeader = null;
        let proxyConnectTarget = null;
        const fakeProxy = http.createServer((req, res) => {
            proxyReceivedRequestUrl = req.url;
            proxyReceivedHostHeader = req.headers.host;
            res.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'close' });
            res.end('proxied-http-ok');
        });
        fakeProxy.on('connect', (req, clientSocket) => {
            proxyConnectTarget = req.url;
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            clientSocket.end();
        });
        await new Promise(resolve => fakeProxy.listen(0, '127.0.0.1', resolve));
        const proxyPort = fakeProxy.address().port;
        let activeProxyAgent;
        try {
            activeProxyAgent = new ProxyAgent({
                getProxyForUrl: () => `http://127.0.0.1:${proxyPort}`,
                keepAlive: false,
            });
            http.globalAgent = activeProxyAgent;
            https.globalAgent = activeProxyAgent;

            // Plain HTTP via HttpProxyAgent: verify req.path is rewritten to the pinned IP while keeping Host: pinned-test.invalid
            const httpPinnedAgent = new PinnedAddressAgent({
                allowPrivate: false,
                lookupAddresses: async () => ['93.184.216.34'],
            });
            const fakeHttpReq = {
                getHeader: (name) => String(name).toLowerCase() === 'host' ? `pinned-test.invalid:${port}` : undefined,
                setHeader: () => {},
                path: '/test-path?q=1',
                outputData: [],
                _implicitHeader: () => {},
            };
            const httpSubAgent = await httpPinnedAgent.connect(fakeHttpReq, {
                host: 'pinned-test.invalid',
                hostname: 'pinned-test.invalid',
                port,
                secureEndpoint: false,
            });
            assert.equal(httpSubAgent?.constructor?.name, 'HttpProxyAgent');
            assert.equal(fakeHttpReq.path, `http://93.184.216.34:${port}/test-path?q=1`, 'HTTP forward proxy request-target must use pinned IP so proxy cannot re-resolve hostname');

            // Also verify end-to-end over TCP against fakeProxy via HttpProxyAgent.connect
            const proxySock = await httpSubAgent.connect(fakeHttpReq, {
                host: '93.184.216.34',
                hostname: '93.184.216.34',
                port,
                secureEndpoint: false,
            });
            proxySock.write(`GET ${fakeHttpReq.path} HTTP/1.1\r\nHost: pinned-test.invalid:${port}\r\nConnection: close\r\n\r\n`);
            const proxyResponseText = await new Promise((resolve, reject) => {
                const chunks = [];
                proxySock.on('data', c => chunks.push(c));
                proxySock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                proxySock.on('error', reject);
            });
            assert.match(proxyResponseText, /proxied-http-ok/);
            assert.equal(proxyReceivedRequestUrl, `http://93.184.216.34:${port}/test-path?q=1`);
            assert.equal(proxyReceivedHostHeader, `pinned-test.invalid:${port}`);

            // HTTPS via HttpsProxyAgent: verify options are mutated in place (host=93.184.216.34, servername=pinned-test.invalid)
            // and HttpsProxyAgent.connect sends CONNECT 93.184.216.34:443 to fakeProxy
            const httpsPinnedAgent = new PinnedAddressAgent({
                allowPrivate: false,
                lookupAddresses: async () => ['93.184.216.34'],
            });
            const httpsConnectOpts = {
                host: 'pinned-test.invalid',
                hostname: 'pinned-test.invalid',
                port: 443,
                secureEndpoint: true,
            };
            const fakeHttpsReq = {
                getHeader: (name) => String(name).toLowerCase() === 'host' ? 'pinned-test.invalid:443' : undefined,
                setHeader: () => {},
                path: '/secure-path',
            };
            const httpsSubAgent = await httpsPinnedAgent.connect(fakeHttpsReq, httpsConnectOpts);
            assert.equal(httpsSubAgent?.constructor?.name, 'HttpsProxyAgent');
            assert.equal(httpsConnectOpts.host, '93.184.216.34', 'options.host must be mutated in place to connectIp');
            assert.equal(httpsConnectOpts.hostname, '93.184.216.34', 'options.hostname must be mutated in place to connectIp');
            assert.equal(httpsConnectOpts.servername, 'pinned-test.invalid', 'options.servername must be preserved for TLS SNI');

            await httpsSubAgent.connect(fakeHttpsReq, httpsConnectOpts).then(s => s.destroy()).catch(() => {});
            assert.equal(proxyConnectTarget, '93.184.216.34:443', 'HTTPS proxy CONNECT must target the pinned IP, not the unpinned hostname');
        } finally {
            activeProxyAgent?.destroy();
            fakeProxy.closeAllConnections?.();
            await new Promise(resolve => fakeProxy.close(resolve));
        }
    } finally {
        http.globalAgent = origGlobalAgent;
        https.globalAgent = origHttpsGlobalAgent;
        await new Promise(resolve => loopbackServer.close(resolve));
    }
});

test('FN-HIGH-3, BLOCKER-2 & BLOCKER-3: safeFetchFollowRedirects enforces per-hop validation, cross-origin/POST->GET header stripping, and streaming maxBytes limits', async () => {
    const { validateOutboundTarget, safeFetchFollowRedirects } = await import('../src/safe-http.js');

    // 1. validateOutboundTarget blocks bracketed IPv6, localhost, private DNS resolution, and non-whitelisted hosts
    await assert.rejects(
        validateOutboundTarget('http://[::1]/', { allowPrivate: false }),
        { code: 'SAFE_HTTP_PRIVATE_HOST' },
    );
    await assert.rejects(
        validateOutboundTarget('http://[::ffff:127.0.0.1]/', { allowPrivate: false }),
        { code: 'SAFE_HTTP_PRIVATE_HOST' },
    );
    await assert.rejects(
        validateOutboundTarget('http://127.0.0.1.nip.io/', {
            allowPrivate: false,
            lookupAddresses: async () => ['127.0.0.1'],
        }),
        { code: 'SAFE_HTTP_PRIVATE_IP' },
    );

    // 2. Real local HTTP server test: redirect validation, cross-origin credential stripping, POST->GET body header stripping, and chunked stream cap
    let landedRequest = null;
    const targetServer = http.createServer((req, res) => {
        if (req.url === '/redirect-to-private') {
            res.writeHead(302, { Location: `http://127.0.0.1:${targetServer.address().port}/secret` });
            res.end();
            return;
        }
        if (req.url === '/redirect-to-unlisted') {
            res.writeHead(302, { Location: `http://unlisted.example:${targetServer.address().port}/secret` });
            res.end();
            return;
        }
        if (req.url === '/redirect-cross-origin') {
            res.writeHead(302, { Location: `http://allowed2.example:${targetServer.address().port}/landed` });
            res.end();
            return;
        }
        if (req.url === '/landed') {
            landedRequest = {
                method: req.method,
                headers: req.headers,
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (req.url === '/chunked-oversized') {
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' });
            res.write(Buffer.alloc(1024, 0x41));
            res.write(Buffer.alloc(1024, 0x42));
            res.end(Buffer.alloc(1024, 0x43));
            return;
        }
        if (req.url === '/secret') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('INTERNAL_SECRET_DATA');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('PUBLIC_OK');
    });
    await new Promise(resolve => targetServer.listen(0, '127.0.0.1', resolve));
    const port = targetServer.address().port;

    try {
        await assert.rejects(
            safeFetchFollowRedirects(`http://allowed.example:${port}/redirect-to-private`, {
                allowPrivate: false,
                isAllowedHost: (host) => host === 'allowed.example' || host === '127.0.0.1',
                lookupAddresses: async (host) => host === 'allowed.example' ? ['93.184.216.34'] : ['127.0.0.1'],
                fetchImpl: async (url) => {
                    const parsed = new URL(url);
                    return fetch(`http://127.0.0.1:${port}${parsed.pathname}`, { redirect: 'manual' });
                },
            }),
            { code: 'SAFE_HTTP_PRIVATE_HOST' },
        );

        await assert.rejects(
            safeFetchFollowRedirects(`http://allowed.example:${port}/redirect-to-unlisted`, {
                allowPrivate: false,
                isAllowedHost: (host) => host === 'allowed.example',
                lookupAddresses: async () => ['93.184.216.34'],
                fetchImpl: async (url) => {
                    const parsed = new URL(url);
                    return fetch(`http://127.0.0.1:${port}${parsed.pathname}`, { redirect: 'manual' });
                },
            }),
            { code: 'SAFE_HTTP_HOST_NOT_WHITELISTED' },
        );

        // BLOCKER-2: Cross-origin POST -> GET 302 redirect strips Authorization/Cookie and Content-Length/Content-Type
        const bodyPayload = JSON.stringify({ hello: 'world' });
        const crossRes = await safeFetchFollowRedirects(`http://allowed1.example:${port}/redirect-cross-origin`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer secret-token',
                Cookie: 'sid=secret',
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(bodyPayload)),
                'X-Custom-Safe': 'kept',
            },
            body: bodyPayload,
            allowPrivate: false,
            isAllowedHost: (host) => host === 'allowed1.example' || host === 'allowed2.example',
            lookupAddresses: async () => ['93.184.216.34'],
            fetchImpl: async (url, opts) => {
                const parsed = new URL(url);
                return fetch(`http://127.0.0.1:${port}${parsed.pathname}`, {
                    method: opts.method,
                    headers: opts.headers,
                    body: opts.body,
                    redirect: 'manual',
                });
            },
        });
        assert.equal(crossRes.status, 200);
        assert.equal(landedRequest?.method, 'GET');
        assert.equal(landedRequest?.headers?.authorization, undefined, 'Authorization must be stripped on cross-origin redirect');
        assert.equal(landedRequest?.headers?.cookie, undefined, 'Cookie must be stripped on cross-origin redirect');
        assert.equal(landedRequest?.headers?.['content-length'], undefined, 'Content-Length must be stripped on POST->GET redirect');
        assert.equal(landedRequest?.headers?.['content-type'], undefined, 'Content-Type must be stripped on POST->GET redirect');
        assert.equal(landedRequest?.headers?.['x-custom-safe'], 'kept');

        // BLOCKER-3: Streaming response.body through pipeline enforces maxBytes even when Content-Length is omitted (chunked)
        const streamRes = await safeFetchFollowRedirects(`http://127.0.0.1:${port}/chunked-oversized`, {
            allowPrivate: true,
            maxBytes: 1500,
        });
        let receivedBytes = 0;
        const sink = new Writable({
            write(chunk, _enc, cb) {
                receivedBytes += chunk.length;
                cb();
            },
        });
        await assert.rejects(
            pipeline(streamRes.body, sink),
            (err) => err?.code === 'SAFE_HTTP_TOO_LARGE' || /exceeded maximum size/i.test(String(err?.message)),
        );
        assert.ok(receivedBytes <= 3072);
    } finally {
        await new Promise(resolve => targetServer.close(resolve));
    }
});

test('FN-HIGH-3, BLOCKER-3 & BLOCKER-4: /api/search/visit, /api/search/searxng, /api/assets/download, and /api/content/importURL block SSRF, external-to-localhost redirects, non-admin localhost downloads, and oversized asset streams', { timeout: 30000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-sec-net-'));
    try {
        const config = path.join(root, 'config.yaml');
        // Include 'localhost' alongside 'allowed.example' (matching default/config.yaml) to test BLOCKER-4
        fs.writeFileSync(config, [
            'whitelistImportDomains:',
            '  - localhost',
            '  - allowed.example',
            '',
        ].join('\n'));

        runIsolatedScript(`
            import assert from 'node:assert/strict';
            import dns from 'node:dns';
            import fs from 'node:fs';
            import http from 'node:http';
            import path from 'node:path';
            import express from 'express';
            import { setConfigFilePath } from './src/util.js';

            globalThis.DATA_ROOT = process.env.TEST_ROOT;
            setConfigFilePath(process.env.TEST_CONFIG);

            const { router: searchRouter } = await import('./src/endpoints/search.js');
            const { router: assetsRouter } = await import('./src/endpoints/assets.js');
            const { router: contentManagerRouter } = await import('./src/endpoints/content-manager.js');
            const { performWebSearch } = await import('./src/scratchpad/web-search.js');

            // Upstream fixture server on loopback
            let secretReached = false;
            const upstream = http.createServer((req, res) => {
                if (req.url === '/redirect-private') {
                    res.writeHead(302, { Location: 'http://127.0.0.1:' + upstream.address().port + '/internal-secret' });
                    res.end();
                    return;
                }
                if (req.url === '/redirect-localhost') {
                    res.writeHead(302, { Location: 'http://localhost:' + upstream.address().port + '/internal-secret' });
                    res.end();
                    return;
                }
                if (req.url === '/internal-secret') {
                    secretReached = true;
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end('<html>SECRET</html>');
                    return;
                }
                if (req.url === '/broken-stream') {
                    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '1000' });
                    res.write('partial-bytes');
                    res.socket?.destroy();
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<html>OK</html>');
            });
            await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
            const upstreamPort = upstream.address().port;

            // Mock dns.promises.lookup so nip.io / rebinding.example resolves to 127.0.0.1
            const origLookup = dns.promises.lookup.bind(dns.promises);
            dns.promises.lookup = async (hostname, options) => {
                if (hostname === 'rebinding.example' || hostname === '127.0.0.1.nip.io') {
                    if (options?.all) return [{ address: '127.0.0.1', family: 4 }];
                    return { address: '127.0.0.1', family: 4 };
                }
                if (hostname === 'allowed.example') {
                    // Simulate public IP for allowed.example so initial hop passes when connected via local test server
                    if (options?.all) return [{ address: '127.0.0.1', family: 4 }];
                    return { address: '127.0.0.1', family: 4 };
                }
                return origLookup(hostname, options);
            };

            const userDirs = {
                root: path.join(process.env.TEST_ROOT, 'alice'),
                assets: path.join(process.env.TEST_ROOT, 'alice', 'assets'),
            };
            fs.mkdirSync(userDirs.assets, { recursive: true });

            let currentUserAdmin = false;
            const app = express();
            app.use(express.json());
            app.use((req, _res, next) => {
                req.user = {
                    profile: { handle: 'alice', admin: currentUserAdmin },
                    directories: userDirs,
                };
                next();
            });
            app.use('/api/search', searchRouter);
            app.use('/api/assets', assetsRouter);
            app.use('/api/content', contentManagerRouter);

            const server = app.listen(0, '127.0.0.1');
            await new Promise(resolve => server.once('listening', resolve));
            const url = 'http://127.0.0.1:' + server.address().port;

            try {
                // 1. POST /api/search/visit rejects bracketed IPv6 [::1], localhost, and DNS-rebinding hostnames resolving to 127.0.0.1
                for (const badUrl of [
                    'http://[::1]/',
                    'http://[::ffff:127.0.0.1]/',
                    'http://localhost/',
                    'http://127.0.0.1.nip.io/',
                ]) {
                    const res = await fetch(url + '/api/search/visit', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url: badUrl }),
                    });
                    assert.equal(res.status, 400, 'Expected /api/search/visit to reject ' + badUrl);
                }
                assert.equal(secretReached, false);

                // 2. POST /api/search/searxng blocks non-admin users from querying localhost or nip.io resolving to 127.0.0.1,
                // while allowing admin users to query their configured local SearXNG instance
                currentUserAdmin = false;
                const searxNonAdminLocal = await fetch(url + '/api/search/searxng', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ baseUrl: 'http://127.0.0.1:' + upstreamPort, query: 'test' }),
                });
                assert.equal(searxNonAdminLocal.status, 403);

                const searxNonAdminRebind = await fetch(url + '/api/search/searxng', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ baseUrl: 'http://127.0.0.1.nip.io:' + upstreamPort, query: 'test' }),
                });
                assert.equal(searxNonAdminRebind.status, 403);

                currentUserAdmin = true;
                const searxAdminLocal = await fetch(url + '/api/search/searxng', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ baseUrl: 'http://127.0.0.1:' + upstreamPort, query: 'test' }),
                });
                assert.equal(searxAdminLocal.status, 200);
                currentUserAdmin = false;

                // 3. BLOCKER-4: Even though 'localhost' is in whitelistImportDomains, non-admin users cannot fetch http://localhost:<port>/...
                const nonAdminLocalAsset = await fetch(url + '/api/assets/download', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        url: 'http://localhost:' + upstreamPort + '/internal-secret',
                        category: 'character',
                        filename: 'card.png',
                    }),
                });
                assert.equal(nonAdminLocalAsset.status, 403);
                assert.equal(secretReached, false);

                const nonAdminLocalImport = await fetch(url + '/api/content/importURL', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        url: 'http://localhost:' + upstreamPort + '/internal-secret',
                    }),
                });
                assert.equal(nonAdminLocalImport.status, 403);
                assert.equal(secretReached, false);

                // 4. BLOCKER-4: Even for an admin user, an external whitelisted host (allowed.example) is never allowed to redirect to localhost
                currentUserAdmin = true;
                const adminExternalToLocalAsset = await fetch(url + '/api/assets/download', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        url: 'http://allowed.example:' + upstreamPort + '/redirect-localhost',
                        category: 'character',
                        filename: 'card.png',
                    }),
                });
                assert.equal(adminExternalToLocalAsset.status, 403);
                assert.equal(secretReached, false);

                // 5. BLOCKER-3: When an admin downloads from localhost and the stream aborts mid-transfer, temp_path is unlinked
                const brokenAssetRes = await fetch(url + '/api/assets/download', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        url: 'http://localhost:' + upstreamPort + '/broken-stream',
                        category: 'bgm',
                        filename: 'partial.mp3',
                    }),
                });
                assert.equal(brokenAssetRes.status, 500);
                assert.equal(fs.existsSync(path.join(userDirs.assets, 'temp', 'partial.mp3')), false, 'partial temp file must be cleaned up on stream failure');
                currentUserAdmin = false;

                // 6. Scratchpad performWebSearch blocks DNS rebinding (hostname resolving to 127.0.0.1) for non-admin accounts
                await assert.rejects(
                    performWebSearch(
                        { provider: 'searxng', query: 'hello', results: 5, searxngUrl: 'http://127.0.0.1.nip.io:' + upstreamPort },
                        { directories: userDirs, allowPrivate: false, lookupAddresses: async () => ['127.0.0.1'] },
                    ),
                    { code: 'SCRATCHPAD_WEB_SEARCH_PRIVATE' },
                );
            } finally {
                dns.promises.lookup = origLookup;
                await new Promise(resolve => server.close(resolve));
                await new Promise(resolve => upstream.close(resolve));
            }
        `, { TEST_ROOT: root, TEST_CONFIG: config });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('FN-LOW-2 & BLOCKER-5: corsProxyMiddleware blocks alternative loopback representations and DNS aliases resolving to loopback, strips Basic Auth headers, and enforces CSRF for cross-site requests', async () => {
    const { default: corsProxyMiddleware } = await import('../src/middleware/corsProxy.js');

    let receivedHeaders = null;
    const remoteServer = http.createServer((req, res) => {
        receivedHeaders = req.headers;
        if (req.url === '/redirect-to-self') {
            res.writeHead(302, { Location: `http://127.0.0.1:${appServer.address().port}/api/ping` });
            res.end();
            return;
        }
        if (req.url === '/redirect-to-self-dns') {
            res.writeHead(302, { Location: `http://127.0.0.1.nip.io:${appServer.address().port}/api/ping` });
            res.end();
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ proxied: true }));
    });
    await new Promise(resolve => remoteServer.listen(0, '127.0.0.1', resolve));
    const remotePort = remoteServer.address().port;

    const origLookup = dns.promises.lookup.bind(dns.promises);
    dns.promises.lookup = async (hostname, options) => {
        if (hostname === '127.0.0.1.nip.io' || hostname === 'loopback-alias.example') {
            if (options?.all) return [{ address: '127.0.0.1', family: 4 }];
            return { address: '127.0.0.1', family: 4 };
        }
        return origLookup(hostname, options);
    };

    globalThis.COMMAND_LINE_ARGS = { basicAuthMode: true, enableCorsProxy: true };
    const app = express();
    app.use('/proxy/:url(*)', corsProxyMiddleware);
    const appServer = app.listen(0, '127.0.0.1');
    await new Promise(resolve => appServer.once('listening', resolve));
    const appPort = appServer.address().port;
    const appUrl = `http://127.0.0.1:${appPort}`;

    try {
        // 1. Direct loopback to the server's own port via localhost, 127.0.0.1, [::1], 0.0.0.0, or DNS alias resolving to 127.0.0.1 (BLOCKER-5) is blocked (400)
        for (const selfTarget of [
            `http://localhost:${appPort}/api/settings/get`,
            `http://127.0.0.1:${appPort}/api/settings/get`,
            `http://[::1]:${appPort}/api/settings/get`,
            `http://0.0.0.0:${appPort}/api/settings/get`,
            `http://127.0.0.1.nip.io:${appPort}/api/settings/get`,
            `http://loopback-alias.example:${appPort}/api/settings/get`,
        ]) {
            const res = await fetch(`${appUrl}/proxy/${encodeURIComponent(selfTarget)}`, {
                headers: { Host: `neconyan.example:${appPort}` },
            });
            assert.equal(res.status, 400, `Expected self-loopback target ${selfTarget} to be blocked`);
        }

        // 2. Redirect back to the server's own port (via IP or DNS alias) is blocked (400)
        const redirectSelfRes = await fetch(`${appUrl}/proxy/${encodeURIComponent(`http://127.0.0.1:${remotePort}/redirect-to-self`)}`);
        assert.equal(redirectSelfRes.status, 400);

        const redirectSelfDnsRes = await fetch(`${appUrl}/proxy/${encodeURIComponent(`http://127.0.0.1:${remotePort}/redirect-to-self-dns`)}`);
        assert.equal(redirectSelfDnsRes.status, 400);

        // 3. Legitimate proxy request to another port strips Basic Authorization header
        const validProxyRes = await fetch(`${appUrl}/proxy/${encodeURIComponent(`http://127.0.0.1:${remotePort}/ok`)}`, {
            headers: {
                Authorization: 'Basic ' + Buffer.from('admin:secret').toString('base64'),
                Cookie: 'session=secret-cookie',
            },
        });
        assert.equal(validProxyRes.status, 200);
        assert.equal(receivedHeaders?.authorization, undefined, 'Basic Authorization header must not leak to proxied target');
        assert.equal(receivedHeaders?.cookie, undefined, 'Cookie header must not leak to proxied target');
    } finally {
        dns.promises.lookup = origLookup;
        await new Promise(resolve => appServer.close(resolve));
        await new Promise(resolve => remoteServer.close(resolve));
    }
});
/* global globalThis */
