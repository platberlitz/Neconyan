import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import express from 'express';
import cookieSession from 'cookie-session';
import { setConfigFilePath } from '../src/util.js';

test('remembered Basic login survives a new browser connection and a server restart, with revocation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-login-'));
    globalThis.DATA_ROOT = root;
    const config = path.join(root, 'config.yaml');
    fs.writeFileSync(config, 'basicAuthUser:\n  username: test-user\n  password: test-password\n');
    setConfigFilePath(config);
    const { default: basicAuth } = await import('../src/middleware/basicAuth.js');
    const { createSession, validateSession, destroySession } = await import('../src/middleware/sessionAuth.js');
    const app = express();
    app.use(cookieSession({ name: 'test-session', secret: 'test-secret', httpOnly: true, sameSite: 'lax' }));
    app.use(basicAuth);
    app.get('/', (_req, res) => res.send('signed in'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    try {
        assert.equal((await fetch(url)).status, 401);
        const response = await fetch(url, { headers: { Authorization: 'Basic ' + Buffer.from('test-user:test-password').toString('base64') } });
        assert.equal(response.status, 200);
        const cookies = response.headers.getSetCookie();
        assert.ok(cookies.every(value => /httponly/i.test(value)));
        const cookie = cookies.map(value => value.split(';')[0]).join('; ');
        assert.equal((await fetch(url, { headers: { Cookie: cookie } })).status, 200);
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
