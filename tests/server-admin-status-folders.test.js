import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let server;
let baseUrl;
let configDirectory;
let serverDirectory;

beforeAll(async () => {
    configDirectory = fs.mkdtempSync(`${os.tmpdir()}/neconyan-status-folders-`);
    const configPath = `${configDirectory}/config.yaml`;
    fs.writeFileSync(configPath, 'enableServerPlugins: false\n');
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(configPath);
    ({ serverDirectory } = await import('../src/server-directory.js'));
    const { router } = await import('../src/endpoints/server-admin.js');
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = {
            profile: {
                admin: request.headers['x-test-admin'] === 'true',
            },
            directories: request.headers['x-test-root']
                ? { root: String(request.headers['x-test-root']) }
                : undefined,
        };
        next();
    });
    app.use('/api/server-admin', router);

    await new Promise(resolve => {
        server = app.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(configDirectory, { recursive: true, force: true });
});

describe('server status folder paths', () => {
    test('keeps folder paths behind the administrator check', async () => {
        const response = await fetch(`${baseUrl}/api/server-admin/status`, { method: 'POST' });
        expect(response.status).toBe(403);
    });

    test('reports the Neconyan folder and the signed-in user\'s data folder as absolute paths', async () => {
        const response = await fetch(`${baseUrl}/api/server-admin/status`, {
            method: 'POST',
            headers: { 'X-Test-Admin': 'true', 'X-Test-Root': 'data/default-user' },
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.installPath).toBe(path.resolve(serverDirectory));
        expect(path.isAbsolute(body.installPath)).toBe(true);
        expect(body.dataPath).toBe(path.resolve('data/default-user'));
        expect(path.isAbsolute(body.dataPath)).toBe(true);
    }, 30000);

    test('leaves the data folder empty when the user has no directories', async () => {
        const response = await fetch(`${baseUrl}/api/server-admin/status`, {
            method: 'POST',
            headers: { 'X-Test-Admin': 'true' },
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.installPath).toBe(path.resolve(serverDirectory));
        expect(body.dataPath).toBe('');
    }, 30000);
});
