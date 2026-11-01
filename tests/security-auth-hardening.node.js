import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import express from 'express';
import cookieSession from 'cookie-session';
import { csrfSync } from 'csrf-sync';
import { setConfigFilePath } from '../src/util.js';

function runIsolatedScript(code, env = {}) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, ...env },
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, `Subprocess failed (${result.status}):\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    return result;
}

test('HIGH-3 & LOW-2: forwarded IP trust, X-Forwarded-For precedence over spoofed X-Real-IP, malformed header resilience, and access log sanitization', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-sec-ip-'));
    try {
        const config = path.join(root, 'config.yaml');
        fs.writeFileSync(config, [
            'whitelist:',
            '  - 127.0.0.1',
            '  - 198.51.100.10',
            'enableForwardedWhitelist: true',
            'whitelistDockerHosts: false',
            'rateLimiting:',
            '  preferRealIpHeader: true',
            'sso:',
            '  trustedProxies:',
            '    - 127.0.0.1',
            '    - ::1',
            'logging:',
            '  enableAccessLog: true',
            '',
        ].join('\n'));

        runIsolatedScript(`
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import express from 'express';
            import { setConfigFilePath } from './src/util.js';
            globalThis.DATA_ROOT = process.env.TEST_ROOT;
            setConfigFilePath(process.env.TEST_CONFIG);

            const { getRealOrForwardedIp, getIpAddress } = await import('./src/express-common.js');
            const { default: getWhitelistMiddleware } = await import('./src/middleware/whitelist.js');
            const { default: accessLoggerMiddleware, getAccessLogPath } = await import('./src/middleware/accessLogWriter.js');

            // (a) Untrusted remote socket peer cannot spoof X-Real-IP or X-Forwarded-For
            assert.equal(getRealOrForwardedIp({
                socket: { remoteAddress: '203.0.113.50' },
                headers: { 'x-real-ip': '127.0.0.1', 'x-forwarded-for': '127.0.0.1' },
            }), undefined);
            assert.equal(getIpAddress({
                socket: { remoteAddress: '203.0.113.50' },
                headers: { 'x-real-ip': '127.0.0.1' },
            }, true), '203.0.113.50');

            // (b) Trusted loopback proxy with X-Forwarded-For selects rightmost non-trusted hop, not client-prepended leftmost hop
            assert.equal(getRealOrForwardedIp({
                socket: { remoteAddress: '127.0.0.1' },
                headers: { 'x-forwarded-for': '127.0.0.1, 203.0.113.99' },
            }), '203.0.113.99');

            // (b2) BLOCKER-1: Client-supplied X-Real-IP cannot shadow proxy-appended X-Forwarded-For
            assert.equal(getRealOrForwardedIp({
                socket: { remoteAddress: '127.0.0.1' },
                headers: { 'x-real-ip': '127.0.0.1', 'x-forwarded-for': '203.0.113.99' },
            }), '203.0.113.99');
            assert.equal(getIpAddress({
                socket: { remoteAddress: '127.0.0.1' },
                headers: { 'x-real-ip': 'not-an-ip', 'x-forwarded-for': '203.0.113.99' },
            }, true), '127.0.0.1 (forwarded: 203.0.113.99)');

            // (c) Malformed forwarded IP does not pollute rate-limiter key and does not crash whitelistMiddleware
            assert.equal(getIpAddress({
                socket: { remoteAddress: '127.0.0.1' },
                headers: { 'x-real-ip': 'not-an-ip-address' },
            }, true), '127.0.0.1');

            const whitelistMiddleware = await getWhitelistMiddleware();
            const app = express();
            app.use(whitelistMiddleware);
            app.get('/login', (_req, res) => res.status(200).send('ok'));

            const server = app.listen(0, '127.0.0.1');
            await new Promise(resolve => server.once('listening', resolve));
            const url = 'http://127.0.0.1:' + server.address().port;

            try {
                // Real HTTP: Malformed X-Real-IP is rejected with 403 without crashing
                const malformedRes = await fetch(url + '/login', {
                    headers: { 'X-Real-IP': 'not-an-ip-address', Accept: 'text/plain' },
                });
                assert.equal(malformedRes.status, 403);

                // Real HTTP: Mixed headers (spoofed X-Real-IP: 127.0.0.1 + proxy X-Forwarded-For: 203.0.113.99) rejected with 403
                const mixedSpoofRes = await fetch(url + '/login', {
                    headers: { 'X-Real-IP': '127.0.0.1', 'X-Forwarded-For': '203.0.113.99', Accept: 'text/plain' },
                });
                assert.equal(mixedSpoofRes.status, 403);

                // Real HTTP: Whitelisted client behind loopback proxy passes
                const allowedRes = await fetch(url + '/login', {
                    headers: { 'X-Forwarded-For': '198.51.100.10' },
                });
                assert.equal(allowedRes.status, 200);
            } finally {
                await new Promise(resolve => server.close(resolve));
            }

            // (d) accessLoggerMiddleware strips CR/LF and control characters
            const logger = accessLoggerMiddleware();
            logger({
                socket: { remoteAddress: '127.0.0.1' },
                headers: {
                    'x-real-ip': '198.51.100.10',
                    'user-agent': 'Mozilla/5.0\\r\\n2026-01-01T00:00:00.000Z FAKE_ENTRY\\x00',
                },
            }, {}, () => {});
            await new Promise(resolve => setTimeout(resolve, 50));
            const lines = fs.readFileSync(getAccessLogPath(), 'utf8').trim().split('\\n');
            assert.equal(lines.length, 1);
            assert.ok(!lines[0].includes('\\r'));
        `, { TEST_ROOT: root, TEST_CONFIG: config });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('MEDIUM-5: requireHttpsMiddleware rejects spoofed Host: localhost and untrusted X-Forwarded-Proto while allowing real loopback and trusted proxy HTTPS', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-sec-https-'));
    try {
        const config = path.join(root, 'config.yaml');
        fs.writeFileSync(config, 'requireHttps: true\n');

        runIsolatedScript(`
            import assert from 'node:assert/strict';
            import { setConfigFilePath } from './src/util.js';
            globalThis.DATA_ROOT = process.env.TEST_ROOT;
            setConfigFilePath(process.env.TEST_CONFIG);

            const { default: requireHttpsMiddleware } = await import('./src/middleware/requireHttps.js');

            async function checkRequest(reqOverrides) {
                let allowed = false;
                let status = null;
                await requireHttpsMiddleware(
                    {
                        socket: { remoteAddress: '203.0.113.5' },
                        hostname: 'neconyan.example',
                        ip: '203.0.113.5',
                        secure: false,
                        protocol: 'http',
                        path: '/api/ping',
                        headers: {},
                        ...reqOverrides,
                    },
                    {
                        vary() { return this; },
                        status(code) { status = code; return this; },
                        json() { return this; },
                    },
                    () => { allowed = true; },
                );
                return { allowed, status };
            }

            // Remote client spoofing Host: localhost over HTTP is blocked
            const spoofedHost = await checkRequest({
                socket: { remoteAddress: '203.0.113.5' },
                hostname: 'localhost',
                headers: { host: 'localhost' },
            });
            assert.equal(spoofedHost.allowed, false);
            assert.equal(spoofedHost.status, 403);

            // Remote client spoofing X-Forwarded-Proto: https without trusted proxy is blocked
            const spoofedProto = await checkRequest({
                socket: { remoteAddress: '203.0.113.5' },
                hostname: 'neconyan.example',
                headers: { host: 'neconyan.example', 'x-forwarded-proto': 'https' },
            });
            assert.equal(spoofedProto.allowed, false);
            assert.equal(spoofedProto.status, 403);

            // Real loopback client with Host: localhost is allowed over HTTP
            const localDev = await checkRequest({
                socket: { remoteAddress: '127.0.0.1' },
                hostname: 'localhost',
                headers: { host: 'localhost' },
            });
            assert.equal(localDev.allowed, true);

            // Trusted loopback reverse proxy forwarding HTTPS for external hostname is allowed
            const trustedProxyHttps = await checkRequest({
                socket: { remoteAddress: '127.0.0.1' },
                hostname: 'neconyan.example',
                headers: { host: 'neconyan.example', 'x-forwarded-proto': 'https' },
            });
            assert.equal(trustedProxyHttps.allowed, true);

            // Trusted loopback reverse proxy forwarding plain HTTP for external hostname is blocked
            const trustedProxyHttp = await checkRequest({
                socket: { remoteAddress: '127.0.0.1' },
                hostname: 'neconyan.example',
                headers: { host: 'neconyan.example' },
            });
            assert.equal(trustedProxyHttp.allowed, false);
            assert.equal(trustedProxyHttp.status, 403);
        `, { TEST_ROOT: root, TEST_CONFIG: config });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('MEDIUM-2 & BLOCKER-4: POST /api/auth/login rate limiting and Bearer session revocation on credential change or unversioned legacy tokens', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-sec-bearer-'));
    try {
        const config = path.join(root, 'config.yaml');
        fs.writeFileSync(config, [
            'enableUserAccounts: true',
            'perUserBasicAuth: true',
            'sessionAuth:',
            '  enabled: true',
            'rateLimiting:',
            '  basicAuthMaxAttempts: 2',
            '',
        ].join('\n'));

        runIsolatedScript(`
            import assert from 'node:assert/strict';
            import http from 'node:http';
            import express from 'express';
            import storage from 'node-persist';
            import { setConfigFilePath } from './src/util.js';
            globalThis.DATA_ROOT = process.env.TEST_ROOT;
            setConfigFilePath(process.env.TEST_CONFIG);

            const { initUserStorage, toKey, getPasswordSalt, getPasswordHash } = await import('./src/users.js');
            const { default: basicAuthMiddleware } = await import('./src/middleware/basicAuth.js');
            const { createSession } = await import('./src/middleware/sessionAuth.js');
            const { handleSessionAuthLogin } = await import('./src/endpoints/auth.js');

            await initUserStorage(process.env.TEST_ROOT);
            const salt = getPasswordSalt();
            await storage.setItem(toKey('alice'), {
                handle: 'alice',
                name: 'Alice',
                created: Date.now(),
                password: getPasswordHash('initial-password', salt),
                salt,
                enabled: true,
                admin: false,
            });

            const app = express();
            app.post('/api/auth/login', express.json({ limit: '32kb', inflate: false }), handleSessionAuthLogin);
            app.use(basicAuthMiddleware);
            app.get('/api/protected', (_req, res) => res.json({ ok: true }));

            const server = app.listen(0, '127.0.0.1');
            await new Promise(resolve => server.once('listening', resolve));
            const url = 'http://127.0.0.1:' + server.address().port;

            try {
                // Valid login issues Bearer token bound to credentialVersion
                const goodLogin = await fetch(url + '/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: 'alice', password: 'initial-password' }),
                });
                assert.equal(goodLogin.status, 200);
                const { token } = await goodLogin.json();
                assert.ok(token);

                // Bearer token authenticates non-browser API client
                const apiCall1 = await new Promise((resolve, reject) => {
                    http.get(url + '/api/protected', { headers: { Authorization: 'Bearer ' + token } }, res => {
                        res.resume();
                        resolve(res.statusCode);
                    }).on('error', reject);
                });
                assert.equal(apiCall1, 200);

                // BLOCKER-4: Unversioned legacy Bearer token (created without credentialVersion) is rejected by active validation
                const legacyToken = createSession('alice');
                const legacyCall = await new Promise((resolve, reject) => {
                    http.get(url + '/api/protected', { headers: { Authorization: 'Bearer ' + legacyToken } }, res => {
                        res.resume();
                        resolve(res.statusCode);
                    }).on('error', reject);
                });
                assert.equal(legacyCall, 401);

                // Changing password immediately invalidates existing Bearer token
                const newSalt = getPasswordSalt();
                const user = await storage.getItem(toKey('alice'));
                user.password = getPasswordHash('rotated-password', newSalt);
                user.salt = newSalt;
                await storage.setItem(toKey('alice'), user);

                const apiCallAfterRotate = await new Promise((resolve, reject) => {
                    http.get(url + '/api/protected', { headers: { Authorization: 'Bearer ' + token } }, res => {
                        res.resume();
                        resolve(res.statusCode);
                    }).on('error', reject);
                });
                assert.equal(apiCallAfterRotate, 401);

                // Rate limiting on POST /api/auth/login after basicAuthMaxAttempts (2) failures
                const fail1 = await fetch(url + '/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: 'alice', password: 'wrong-1' }),
                });
                assert.equal(fail1.status, 401);
                const fail2 = await fetch(url + '/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: 'alice', password: 'wrong-2' }),
                });
                assert.equal(fail2.status, 401);
                const fail3 = await fetch(url + '/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: 'alice', password: 'wrong-3' }),
                });
                assert.equal(fail3.status, 429);
            } finally {
                await new Promise(resolve => server.close(resolve));
            }
        `, { TEST_ROOT: root, TEST_CONFIG: config });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('MEDIUM-1, LOW-1, BLOCKER-3 & BLOCKER-5: default 5-attempt budgets, reset-step1 rate limiting, reset-settings isolation, terminal-only codes, and getPasswordHash throwing on invalid input', { timeout: 30000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-sec-users-'));
    try {
        const config = path.join(root, 'config.yaml');
        // Use the default accountsRecoverMaxAttempts: 5 to prove full 5-attempt verification budget
        fs.writeFileSync(config, [
            'enableUserAccounts: true',
            'enableDiscreetLogin: true',
            'rateLimiting:',
            '  accountsLoginMaxAttempts: 5',
            '  accountsRecoverMaxAttempts: 5',
            '',
        ].join('\n'));

        runIsolatedScript(`
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import path from 'node:path';
            import express from 'express';
            import storage from 'node-persist';
            import { setConfigFilePath } from './src/util.js';
            globalThis.DATA_ROOT = process.env.TEST_ROOT;
            setConfigFilePath(process.env.TEST_CONFIG);

            const { initUserStorage, toKey, getPasswordSalt, getPasswordHash, verifyPasswordHash, getUserDirectories } = await import('./src/users.js');
            const { validateCredentials } = await import('./src/middleware/sessionAuth.js');
            const { getServerLogSnapshot } = await import('./src/server-log-buffer.js');
            const { router: usersPublicRouter } = await import('./src/endpoints/users-public.js');
            const { router: usersPrivateRouter } = await import('./src/endpoints/users-private.js');
            const { router: usersAdminRouter } = await import('./src/endpoints/users-admin.js');
            const { bootstrapRoleplayAccount } = await import('./src/roleplay-lifecycle.js');
            const { roleplayNativeHost } = await import('./src/endpoints/chats.js');

            await initUserStorage(process.env.TEST_ROOT);
            const salt = getPasswordSalt();

            // BLOCKER-5: getPasswordHash must throw on non-string or >4096 UTF-8 byte inputs, never return ''
            assert.throws(() => getPasswordHash({ bad: true }, salt), TypeError);
            assert.throws(() => getPasswordHash('a'.repeat(4097), salt), RangeError);
            assert.throws(() => getPasswordHash('é'.repeat(2049), salt), RangeError);
            assert.throws(() => getPasswordHash('valid', null), TypeError);
            assert.equal(verifyPasswordHash({ bad: true }, 'hash', salt), false);
            assert.equal(verifyPasswordHash('é'.repeat(2049), 'hash', salt), false);
            assert.equal(await validateCredentials('default-user', 'é'.repeat(2049)), false);

            // Passwordless admin account to test BLOCKER-3 (reset-settings / admin change-password must not clear reset verification budget)
            const userRecord = {
                handle: 'default-user',
                name: 'Default User',
                created: Date.now(),
                password: '',
                salt: '',
                enabled: true,
                admin: true,
            };
            await storage.setItem(toKey('default-user'), userRecord);
            await storage.setItem(toKey('disabled-user'), {
                handle: 'disabled-user',
                name: 'Disabled User',
                created: Date.now(),
                password: '',
                salt: '',
                enabled: false,
                admin: false,
            });

            const directories = getUserDirectories('default-user');
            fs.mkdirSync(directories.root, { recursive: true });
            fs.writeFileSync(path.join(directories.root, 'settings.json'), '{}');
            bootstrapRoleplayAccount({ owner: 'default-user', directories }, roleplayNativeHost);

            // Capture stdout writes without leaking codes to test output
            let capturedTerminal = '';
            const origStdoutWrite = process.stdout.write.bind(process.stdout);
            process.stdout.write = (chunk, encoding, cb) => {
                const str = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
                if (str.includes('recovery code is:') || str.includes('reset code is:')) {
                    capturedTerminal += str;
                    if (typeof encoding === 'function') encoding();
                    else if (typeof cb === 'function') cb();
                    return true;
                }
                return origStdoutWrite(chunk, encoding, cb);
            };

            const app = express();
            app.use(express.json({ limit: '10mb' }));
            app.use((req, _res, next) => {
                req.session = {};
                req.user = { profile: userRecord, directories };
                next();
            });
            app.use('/api/users', usersPublicRouter);
            app.use('/api/users', usersPrivateRouter);
            app.use('/api/users', usersAdminRouter);

            const server = app.listen(0, '127.0.0.1');
            await new Promise(resolve => server.once('listening', resolve));
            const url = 'http://127.0.0.1:' + server.address().port;

            try {
                // 1. Non-string and >4096 byte passwords on /api/users/login and /api/users/create return 400 (never 500 or passwordless account)
                const nonStringRes = await fetch(url + '/api/users/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ handle: 'default-user', password: { bad: true } }),
                });
                assert.equal(nonStringRes.status, 400);

                const hugePasswordRes = await fetch(url + '/api/users/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ handle: 'default-user', password: 'a'.repeat(5000) }),
                });
                assert.equal(hugePasswordRes.status, 400);

                const createBadPass = await fetch(url + '/api/users/create', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ handle: 'new-user', name: 'New User', password: 'a'.repeat(5000) }),
                });
                assert.equal(createBadPass.status, 400);
                assert.equal(await storage.getItem(toKey('new-user')), undefined);

                // 2. Discreet login mode returns uniform 204 on /api/users/recover-step1
                const recMissing = await fetch(url + '/api/users/recover-step1', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ handle: 'non-existent-handle' }),
                });
                const recDisabled = await fetch(url + '/api/users/recover-step1', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ handle: 'disabled-user' }),
                });
                const recValid = await fetch(url + '/api/users/recover-step1', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ handle: 'default-user' }),
                });
                assert.equal(recMissing.status, 204);
                assert.equal(recDisabled.status, 204);
                assert.equal(recValid.status, 204);

                const cleanTerminal1 = capturedTerminal.replace(/\\u001b\\[[0-9;]*m/g, '');
                const recoveryMatch1 = [...cleanTerminal1.matchAll(/password recovery code is: (\\d{6})/g)].at(-1);
                assert.ok(recoveryMatch1, 'recovery code was written to terminal stdout');

                // 3. BLOCKER-3c: Under default accountsRecoverMaxAttempts: 5, 4 wrong recover-step2 attempts still allow the 5th attempt with the valid code to succeed (204)
                for (let i = 0; i < 4; i++) {
                    const badAttempt = await fetch(url + '/api/users/recover-step2', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ handle: 'default-user', code: '000000', newPassword: '' }),
                    });
                    assert.equal(badAttempt.status, 403);
                }
                const fifthValidAttempt = await fetch(url + '/api/users/recover-step2', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ handle: 'default-user', code: recoveryMatch1[1], newPassword: '' }),
                });
                assert.equal(fifthValidAttempt.status, 204, '5th attempt with valid recovery code succeeds under default limit 5');

                // Issue a fresh recovery code and verify that 5 wrong guesses evict the code and the 6th hits 429
                const recValid2 = await fetch(url + '/api/users/recover-step1', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ handle: 'default-user' }),
                });
                assert.equal(recValid2.status, 204);
                for (let i = 0; i < 5; i++) {
                    const badAttempt = await fetch(url + '/api/users/recover-step2', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ handle: 'default-user', code: '000000', newPassword: '' }),
                    });
                    assert.equal(badAttempt.status, 403);
                }
                const sixthRecoverAttempt = await fetch(url + '/api/users/recover-step2', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ handle: 'default-user', code: '000000', newPassword: '' }),
                });
                assert.equal(sixthRecoverAttempt.status, 429);

                // 4. BLOCKER-3a & 3b: reset-step1 and reset-step2 under default limit 5, with interleaved reset-settings on a passwordless account
                const resetStep1 = await fetch(url + '/api/users/reset-step1', { method: 'POST' });
                assert.equal(resetStep1.status, 204);

                const cleanTerminal2 = capturedTerminal.replace(/\\u001b\\[[0-9;]*m/g, '');
                const resetMatch = [...cleanTerminal2.matchAll(/account reset code is: (\\d{4})/g)].at(-1);
                assert.ok(resetMatch, 'reset code was written to terminal stdout');

                const logSnapshot = getServerLogSnapshot({ limit: 600 });
                for (const entry of logSnapshot.entries) {
                    assert.ok(!entry.message.includes('password recovery code is:'), 'recovery code must not leak into server log buffer');
                    assert.ok(!entry.message.includes('account reset code is:'), 'reset code must not leak into server log buffer');
                }

                // Make 4 wrong reset-step2 guesses, then call reset-settings on the passwordless account
                for (let i = 0; i < 4; i++) {
                    const badReset = await fetch(url + '/api/users/reset-step2', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ key: 'reset-attempt-' + i, code: '0000' }),
                    });
                    assert.equal(badReset.status, 400);
                }
                const resetSettingsRes = await fetch(url + '/api/users/reset-settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({}),
                });
                assert.equal(resetSettingsRes.status, 204);

                // 5th wrong reset-step2 guess still counts as the 5th failure (evicting the code), and the 6th attempt is rate-limited with 429
                const fifthBadReset = await fetch(url + '/api/users/reset-step2', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: 'reset-attempt-4', code: '0000' }),
                });
                assert.equal(fifthBadReset.status, 400);

                const sixthReset = await fetch(url + '/api/users/reset-step2', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: 'reset-attempt-5', code: resetMatch[1] }),
                });
                assert.equal(sixthReset.status, 429, '6th reset-step2 attempt is rate limited with 429 even after reset-settings');

                // Calling reset-step1 while resetVerifyLimiter is exhausted is also blocked with 429
                const blockedResetStep1 = await fetch(url + '/api/users/reset-step1', { method: 'POST' });
                assert.equal(blockedResetStep1.status, 429);
            } finally {
                process.stdout.write = origStdoutWrite;
                await new Promise(resolve => server.close(resolve));
            }
        `, { TEST_ROOT: root, TEST_CONFIG: config });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('HIGH-4, MEDIUM-3 & BLOCKER-2: admission/auth ordering before large body parsers, anonymous login-font fallthrough blocked, and CSRF enforcement on POST /api/cookies/clear', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-sec-pipeline-'));
    globalThis.DATA_ROOT = root;
    const config = path.join(root, 'config.yaml');
    fs.writeFileSync(config, [
        'basicAuthUser:',
        '  username: test-user',
        '  password: test-password',
        '',
    ].join('\n'));
    setConfigFilePath(config);

    const { default: basicAuthMiddleware } = await import('../src/middleware/basicAuth.js');
    const { default: authRouter, setAuthRouterBasicAuthMode } = await import('../src/endpoints/auth.js');
    const { destroySession } = await import('../src/middleware/sessionAuth.js');
    const { setUserDataMiddleware, requireLoginMiddleware } = await import('../src/users.js');
    setAuthRouterBasicAuthMode(true);

    // Mirror the exact middleware pipeline ordering in src/server-main.js (including single-user setUserDataMiddleware + requireLoginMiddleware)
    const app = express();
    app.use(cookieSession({ name: 'pipeline-test', secret: 'pipeline-secret', httpOnly: true, sameSite: 'lax' }));
    app.use(basicAuthMiddleware);
    app.use(setUserDataMiddleware);
    app.use('/api/auth', express.json({ limit: '32kb', inflate: false }), express.urlencoded({ extended: false, limit: '32kb', inflate: false }));

    const csrfSyncProtection = csrfSync({
        getTokenFromState: (req) => req.session?.csrfToken,
        getTokenFromRequest: (req) => req.headers['x-csrf-token']?.toString(),
        storeTokenInState: (req, token) => {
            if (req.session) req.session.csrfToken = token;
        },
        size: 32,
    });
    app.get('/csrf-token', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json({ token: csrfSyncProtection.generateToken(req) });
    });
    app.use(csrfSyncProtection.csrfSynchronisedProtection);

    app.post('/api/cookies/clear', express.json({ limit: '32kb', inflate: false }), (req, res) => {
        if (req.session) {
            if (req.session.basicAuthToken) destroySession(req.session.basicAuthToken);
            req.session = null;
        }
        res.json({ success: true });
    });

    app.get('/webfonts/FredokaOne/existing.woff2', (_req, res) => res.status(200).send('font-bytes'));
    app.use('/api/auth', authRouter);
    app.use(requireLoginMiddleware);

    let largeParserInvoked = false;
    app.use((req, res, next) => {
        largeParserInvoked = true;
        return express.json({ limit: '500mb' })(req, res, next);
    });
    app.post('/api/chats/save', (req, res) => res.json({ saved: true, size: JSON.stringify(req.body).length }));

    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    const jar = [];
    const withCookies = (headers = {}) => ({ ...headers, cookie: jar.join('; ') });
    const storeCookies = (response) => {
        for (const value of response.headers.getSetCookie()) {
            const [pair] = value.split(';');
            const name = pair.split('=')[0];
            const index = jar.findIndex(entry => entry.startsWith(name + '='));
            if (index >= 0) jar[index] = pair; else jar.push(pair);
        }
    };

    try {
        // 1. Unauthenticated request with 1 MB body to /api/chats/save is rejected with 401 BEFORE the 500 MB parser runs
        largeParserInvoked = false;
        const unauthLarge = await fetch(url + '/api/chats/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload: 'x'.repeat(1024 * 1024) }),
        });
        assert.equal(unauthLarge.status, 401);
        assert.equal(largeParserInvoked, false, '500mb body parser must not run for unauthenticated requests');

        // 1b. BLOCKER-2: Unauthenticated GET to a missing login-font path (/webfonts/FredokaOne/missing.woff2) returns 404 at requireLoginMiddleware and never reaches the 500 MB parser
        const existingFont = await fetch(url + '/webfonts/FredokaOne/existing.woff2');
        assert.equal(existingFont.status, 200);

        largeParserInvoked = false;
        const missingFont = await fetch(url + '/webfonts/FredokaOne/missing.woff2');
        assert.equal(missingFont.status, 404);
        assert.equal(largeParserInvoked, false, 'anonymous login-font fallthrough must not reach 500mb parser');

        // 2. Gzip-compressed body on pre-auth /api/auth/browser/login is rejected (inflate: false)
        const tokenRes = await fetch(url + '/csrf-token');
        storeCookies(tokenRes);
        const { token: csrfToken } = await tokenRes.json();

        const compressedLogin = await fetch(url + '/api/auth/browser/login', {
            method: 'POST',
            headers: withCookies({
                'Content-Type': 'application/json',
                'Content-Encoding': 'gzip',
                'X-CSRF-Token': csrfToken,
            }),
            body: zlib.gzipSync(Buffer.from(JSON.stringify({ username: 'test-user', password: 'test-password' }))),
        });
        assert.equal(compressedLogin.status, 415);

        // 3. Sign in normally
        const loginRes = await fetch(url + '/api/auth/browser/login', {
            method: 'POST',
            headers: withCookies({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }),
            body: JSON.stringify({ username: 'test-user', password: 'test-password' }),
        });
        assert.equal(loginRes.status, 200);
        storeCookies(loginRes);

        // 4. Authenticated large payload succeeds
        const authLarge = await fetch(url + '/api/chats/save', {
            method: 'POST',
            headers: withCookies({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }),
            body: JSON.stringify({ payload: 'x'.repeat(512 * 1024) }),
        });
        assert.equal(authLarge.status, 200);
        assert.equal(largeParserInvoked, true);

        // 5. MEDIUM-3: POST /api/cookies/clear without X-CSRF-Token is rejected with 403
        const clearNoCsrf = await fetch(url + '/api/cookies/clear', {
            method: 'POST',
            headers: withCookies({ 'Content-Type': 'application/json' }),
            body: '{}',
        });
        assert.equal(clearNoCsrf.status, 403);

        // With valid X-CSRF-Token, POST /api/cookies/clear succeeds and clears session
        const clearWithCsrf = await fetch(url + '/api/cookies/clear', {
            method: 'POST',
            headers: withCookies({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }),
            body: '{}',
        });
        assert.equal(clearWithCsrf.status, 200);
    } finally {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
/* global globalThis */
