import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import express from 'express';
import cookieSession from 'cookie-session';
import { setConfigFilePath } from '../src/util.js';

test('Basic API access creates no browser session; hashed sessions survive restart and revoke', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-login-'));
    globalThis.DATA_ROOT = root;
    const config = path.join(root, 'config.yaml');
    fs.writeFileSync(config, 'basicAuthUser:\n  username: test-user\n  password: test-password\n');
    setConfigFilePath(config);
    const { default: basicAuth } = await import('../src/middleware/basicAuth.js');
    const { createSession, validateSession, destroySession } = await import('../src/middleware/sessionAuth.js');
    const app = express();
    // Small inherited cookie lifetime on purpose: the remembered login must
    // shadow it with its own 30 day lifetime instead of deleting a property.
    app.use(cookieSession({ name: 'test-session', secret: 'test-secret', httpOnly: true, sameSite: 'lax', maxAge: 5000 }));
    app.use(basicAuth);
    app.get('/', (_req, res) => res.send('signed in'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    try {
        // No HTTP Basic popup: unauthenticated API-style clients get a plain 401.
        const unauth = await fetch(url);
        assert.equal(unauth.status, 401);
        assert.ok(!unauth.headers.get('www-authenticate'));
        // API credentials must not silently undo browser logout.
        const response = await new Promise((resolve, reject) => http.get(url, { headers: { Authorization: 'Basic ' + Buffer.from('test-user:test-password').toString('base64') } }, res => { res.resume(); resolve(res); }).on('error', reject));
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['set-cookie'], undefined);
        const token = createSession('test-user');
        const persisted = fs.readFileSync(path.join(root, '_auth', 'sessions.json'), 'utf8');
        assert.ok(!persisted.includes(token));
        assert.ok(!persisted.includes('test-password'));
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
            import { setConfigFilePath } from './src/util.js';
            setConfigFilePath(process.env.TEST_CONFIG);
            globalThis.DATA_ROOT = process.env.TEST_ROOT;
            const { validateSession } = await import('./src/middleware/sessionAuth.js');
            if (validateSession(process.env.TEST_TOKEN)?.username !== 'test-user') process.exit(1);
        `], { cwd: new URL('..', import.meta.url), env: { ...process.env, TEST_ROOT: root, TEST_CONFIG: config, TEST_TOKEN: token } });
        assert.equal(child.status, 0, child.stderr.toString());
        destroySession(token);
        assert.equal(validateSession(token), null);
        assert.equal(validateSession('invalid'), null);
    } finally {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
/* global globalThis */
