/* eslint-disable playwright/no-duplicate-hooks, playwright/no-standalone-expect */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { setConfigFilePath } from '../src/util.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
setConfigFilePath(path.join(projectRoot, 'default/config.yaml'));
const { router, restoreBundledBackgrounds } = await import('../src/endpoints/backgrounds.js');

let root;
let directories;
let baseUrl;
let server;

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { request.user = { directories }; next(); });
    app.use('/backgrounds', router);
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-background-restore-'));
    directories = {
        root,
        backgrounds: path.join(root, 'backgrounds'),
        thumbnailsBg: path.join(root, 'thumbnails'),
        thumbnailsBgMobile: path.join(root, 'thumbnails-mobile'),
    };
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
});

afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
});

afterAll(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

function makeSource(entries, files = {}) {
    const directory = path.join(root, 'source');
    fs.mkdirSync(path.join(directory, 'backgrounds'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify(entries));
    for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(directory, 'backgrounds', name), data);
    return [{ directory, optional: false }];
}

describe('restore default backgrounds', () => {
    test('copies missing indexed backgrounds once without replacing user files', async () => {
        const sources = makeSource([
            { type: 'background', filename: 'backgrounds/missing.png' },
            { type: 'background', filename: 'backgrounds/existing.png' },
            { type: 'theme', filename: 'backgrounds/not-a-background.png' },
        ], { 'missing.png': 'packaged', 'existing.png': 'default' });
        fs.writeFileSync(path.join(directories.backgrounds, 'existing.png'), 'custom');
        fs.writeFileSync(path.join(directories.thumbnailsBg, 'missing.png'), 'stale');

        expect(await restoreBundledBackgrounds(directories, sources)).toEqual({ restored: ['missing.png'], failed: [] });
        expect(fs.readFileSync(path.join(directories.backgrounds, 'missing.png'), 'utf8')).toBe('packaged');
        expect(fs.readFileSync(path.join(directories.backgrounds, 'existing.png'), 'utf8')).toBe('custom');
        expect(fs.existsSync(path.join(directories.thumbnailsBg, 'missing.png'))).toBe(false);
        expect(await restoreBundledBackgrounds(directories, sources)).toEqual({ restored: [], failed: [] });
    });

    test('reports missing packages and rejects paths outside the background directory', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const sources = makeSource([
            { type: 'background', filename: 'backgrounds/missing.png' },
            { type: 'background', filename: 'backgrounds/../outside.png' },
            { type: 'background', filename: 'backgrounds/nested/file.png' },
            { type: 'background', filename: 'backgrounds/invalid.svg' },
        ]);
        const result = await restoreBundledBackgrounds(directories, sources);
        expect(result.restored).toEqual([]);
        expect(result.failed).toHaveLength(4);
        expect(fs.readdirSync(directories.backgrounds)).toEqual([]);
    });

    test('reports partial failures and can retry them', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const sources = makeSource([
            { type: 'background', filename: 'backgrounds/one.png' },
            { type: 'background', filename: 'backgrounds/two.png' },
        ], { 'one.png': 'one', 'two.png': 'two' });
        const copyFile = fs.promises.copyFile.bind(fs.promises);
        jest.spyOn(fs.promises, 'copyFile').mockImplementation((source, target, flags) => String(source).endsWith('two.png')
            ? Promise.reject(Object.assign(new Error('disk error'), { code: 'EIO' }))
            : copyFile(source, target, flags));
        expect(await restoreBundledBackgrounds(directories, sources)).toEqual({ restored: ['one.png'], failed: ['two.png'] });
        jest.restoreAllMocks();
        expect(await restoreBundledBackgrounds(directories, sources)).toEqual({ restored: ['two.png'], failed: [] });
    });

    test('the authenticated route restores only the current account and is idempotent', async () => {
        const index = JSON.parse(fs.readFileSync(path.join(projectRoot, 'default/content/index.json'), 'utf8'));
        const names = index.filter(item => item.type === 'background').map(item => path.basename(item.filename));
        for (const name of names.slice(1)) fs.writeFileSync(path.join(directories.backgrounds, name), 'custom');
        const otherUser = path.join(root, 'other-user');
        fs.mkdirSync(otherUser);
        fs.writeFileSync(path.join(otherUser, names[0]), 'other account');
        const restore = () => fetch(`${baseUrl}/backgrounds/restore-defaults`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

        const response = await restore();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ restored: [names[0]], failed: [] });
        expect(fs.readFileSync(path.join(otherUser, names[0]), 'utf8')).toBe('other account');
        expect(fs.readFileSync(path.join(directories.backgrounds, names[1]), 'utf8')).toBe('custom');
        expect(await (await restore()).json()).toEqual({ restored: [], failed: [] });
    });

    test('reports a successful deletion even if a stale thumbnail cannot be removed', async () => {
        const background = path.join(directories.backgrounds, 'example.png');
        const thumbnail = path.join(directories.thumbnailsBg, 'example.png');
        fs.writeFileSync(background, 'background');
        fs.writeFileSync(thumbnail, 'thumbnail');
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const unlink = fs.unlinkSync.bind(fs);
        jest.spyOn(fs, 'unlinkSync').mockImplementation(file => {
            if (file === thumbnail) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
            return unlink(file);
        });
        const response = await fetch(`${baseUrl}/backgrounds/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bg: 'example.png' }),
        });
        expect(response.status).toBe(200);
        expect(fs.existsSync(background)).toBe(false);
        expect(fs.existsSync(thumbnail)).toBe(true);
    });
});
