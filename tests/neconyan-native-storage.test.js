/* eslint-disable playwright/no-standalone-expect -- These assertions are inside Jest's test.each callback. */
import { afterEach, describe, expect, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { info, init as initHopper, mutateMeowerStore, readMeowerStore } from '../public/scripts/extensions/third-party/Neconyan-Hopper/server/index.js';

const temporaryDirectories = [];
function privateDirectory() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-native-storage-'));
    temporaryDirectories.push(root);
    const files = path.join(root, 'files');
    fs.mkdirSync(files);
    return { root, files };
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('native private storage', () => {
    test('keeps the legacy server id while presenting Meower metadata', () => {
        expect(info).toMatchObject({ id: 'hopper', name: 'Meower' });
    });
    test('keeps BotSearcher signing state private and valid across process restarts', () => {
        const { root } = privateDirectory();
        const moduleUrl = new URL('../public/scripts/extensions/third-party/Neconyan-BotSearcher/server/refs.js', import.meta.url).href;
        const script = `
            globalThis.DATA_ROOT = process.argv[1];
            const refs = await import(${JSON.stringify(moduleUrl)});
            const token = process.argv[2] || refs.mintToken('test', { id: 'example' });
            process.stdout.write(JSON.stringify({ token, payload: refs.verifyToken('test', token) }));
        `;
        const run = token => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, root, token || ''], { encoding: 'utf8' }));
        const first = run();
        expect(run(first.token)).toEqual(first);
        expect(first.payload).toEqual({ id: 'example' });
        const secret = path.join(root, 'neconyan-botsearcher/.cursor-key');
        expect(fs.statSync(secret).size).toBe(32);
        expect(fs.statSync(secret).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.dirname(secret)).mode & 0o777).toBe(0o700);
        expect(fs.existsSync(new URL('../public/scripts/extensions/third-party/Neconyan-BotSearcher/.cursor-key', import.meta.url))).toBe(false);
    });

    test.each([
        ['empty', false], ['legacy-file', false], ['empty', true], ['legacy-file', true],
    ])('Meower preserves %s data, backups, and conflicts with relative paths: %s', async (origin, relative) => {
        const absoluteDirectories = privateDirectory();
        const directories = relative ? Object.fromEntries(Object.entries(absoluteDirectories).map(([key, value]) => [key, path.relative(process.cwd(), value)])) : absoluteDirectories;
        const router = express.Router();
        await initHopper(router);
        const request = async (method, body, privatePaths = directories) => {
            const route = router.stack.find(layer => layer.route?.methods[method]).route.stack[0].handle;
            const result = { status: 200, body: undefined };
            const response = {
                set() {},
                status(value) { result.status = value; return this; },
                json(value) { result.body = value; return this; },
            };
            await route({ user: { profile: { handle: 'native-test' }, directories: privatePaths }, headers: {}, query: {}, body }, response);
            return result;
        };
        const empty = await request('get');
        const legacyPath = path.join(directories.files, 'hopper-store.json');
        const markerPath = path.join(directories.files, 'hopper-server-storage.json');
        const legacyBytes = Buffer.from(JSON.stringify({ ...empty.body, revision: 5 }, null, 2)).toString('base64');
        if (origin === 'legacy-file') fs.writeFileSync(legacyPath, legacyBytes);
        const baseRevision = origin === 'legacy-file' ? 5 : 0;
        const initial = await request('get');
        expect(fs.existsSync(markerPath)).toBe(false);
        expect(initial.status).toBe(200);
        expect(initial.body.revision).toBe(baseRevision);
        expect(fs.existsSync(path.join(directories.root, 'hopper/store.json'))).toBe(false);
        const first = await request('post', initial.body);
        expect(first.status).toBe(200);
        expect(first.body.revision).toBe(baseRevision + 1);
        const savedPath = path.join(directories.root, 'hopper/store.json');
        const backupPath = path.join(directories.root, 'hopper/store.previous.json');
        const firstBytes = fs.readFileSync(savedPath, 'utf8');
        expect(JSON.parse(fs.readFileSync(backupPath, 'utf8')).revision).toBe(baseRevision);
        expect(JSON.parse(fs.readFileSync(markerPath, 'utf8'))).toEqual({ format: 1, storage: 'server' });
        if (origin === 'legacy-file') expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacyBytes);
        const second = await request('post', first.body);
        expect(second.status).toBe(200);
        expect(second.body.revision).toBe(baseRevision + 2);
        expect(fs.readFileSync(backupPath, 'utf8')).toBe(firstBytes);
        const savedBytes = fs.readFileSync(savedPath, 'utf8');
        const stale = await request('post', first.body);
        expect(stale.status).toBe(409);
        expect(stale.body.revision).toBe(baseRevision + 2);
        const wrongAccount = await request('post', { ...second.body, account: 'another-user' });
        expect(wrongAccount.status).toBe(409);
        expect(fs.readFileSync(savedPath, 'utf8')).toBe(savedBytes);
        expect((await request('get', undefined, privateDirectory())).body.revision).toBe(0);
        expect((await request('get', undefined, { ...directories, root: '' })).status).toBe(500);
        const receipt = { version: 1, jobId: 'permanent', units: { applied: { posts: ['deleted-post'] } }, closed: true };
        await mutateMeowerStore(directories, 'native-test', (_store, receipts) => { receipts['a'.repeat(64)] = receipt; });
        const visible = await request('get');
        expect(visible.body.jobReceipts).toBeUndefined();
        expect((await request('post', { ...visible.body, jobReceipts: {} })).status).toBe(200);
        expect((await readMeowerStore(directories, 'native-test')).receipts['a'.repeat(64)]).toEqual(receipt);
    });
});
