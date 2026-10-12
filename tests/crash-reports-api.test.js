import { afterAll, beforeAll, expect, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initialiseCrashDiagnostics, writeCrashReport } from '../src/crash-diagnostics.js';

let directory, server, url;
beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-crash-api-'));
    const config = path.join(directory, 'config.yaml');
    fs.writeFileSync(config, 'enableServerPlugins: false\n');
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(config);
    initialiseCrashDiagnostics(directory);
    writeCrashReport('test', new Error('Retained server failure'));
    const { router } = await import('../src/endpoints/server-admin.js');
    const app = express();
    app.use((req, _res, next) => { req.user = { profile: { admin: req.headers['x-test-admin'] === 'true' } }; next(); });
    app.use('/api/server-admin', router);
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    url = `http://127.0.0.1:${server.address().port}/api/server-admin/crash-reports`;
});
afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

test('keeps detailed server reports behind the administrator boundary', async () => {
    const response = await fetch(url, { method: 'POST' });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('Retained server failure');
});

test('returns retained reports without allowing HTTP caching', async () => {
    const response = await fetch(url, { method: 'POST', headers: { 'X-Test-Admin': 'true' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).reports[0].error.message).toBe('Retained server failure');
});
