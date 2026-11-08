/* eslint-disable playwright/no-duplicate-hooks, playwright/no-standalone-expect */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { setConfigFilePath } from '../src/util.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
setConfigFilePath(path.join(projectRoot, 'default/config.yaml'));
const { findMobileBackground, router } = await import('../src/endpoints/backgrounds.js');
const filename = 'Neconyan Theme - Example.jpg';
const original = Buffer.from('bundled original');
let root;
let directories;
let manifestFile;
let portrait;
let server;
let baseUrl;

beforeAll(async () => {
    const app = express();
    app.use((request, _response, next) => { request.user = { directories }; next(); });
    app.use('/api/backgrounds', router);
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-mobile-backgrounds-'));
    directories = { backgrounds: path.join(root, 'backgrounds') };
    fs.mkdirSync(directories.backgrounds);
    const mobileDir = path.join(root, 'mobile');
    fs.mkdirSync(mobileDir);
    portrait = path.join(mobileDir, 'example.jpg');
    manifestFile = path.join(mobileDir, 'artwork-provenance.json');
    fs.writeFileSync(path.join(directories.backgrounds, filename), original);
    fs.writeFileSync(portrait, 'portrait');
    fs.writeFileSync(manifestFile, JSON.stringify({ backgrounds: [{
        filename, mobileFile: 'example.jpg', originalBytes: original.length,
        originalSha256: createHash('sha256').update(original).digest('hex'),
    }] }));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
afterAll(async () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

describe('phone background compositions', () => {
    test('matches the bundled original by bytes, not only by name', async () => {
        expect(await findMobileBackground(directories, filename, manifestFile)).toBe(portrait);
        const custom = Buffer.from(original);
        custom[0] ^= 1;
        fs.writeFileSync(path.join(directories.backgrounds, filename), custom);
        expect(await findMobileBackground(directories, filename, manifestFile)).toBeNull();
        fs.unlinkSync(path.join(directories.backgrounds, filename));
        expect(await findMobileBackground(directories, filename, manifestFile)).toBeNull();
    });

    test('rejects traversal and symlinks in either image', async () => {
        expect(await findMobileBackground(directories, '../example.jpg', manifestFile)).toBeNull();
        expect(await findMobileBackground(directories, '..\\example.jpg', manifestFile)).toBeNull();
        fs.unlinkSync(path.join(directories.backgrounds, filename));
        fs.symlinkSync(path.join(root, 'outside.jpg'), path.join(directories.backgrounds, filename));
        fs.writeFileSync(path.join(root, 'outside.jpg'), original);
        expect(await findMobileBackground(directories, filename, manifestFile)).toBeNull();
        fs.unlinkSync(path.join(directories.backgrounds, filename));
        fs.writeFileSync(path.join(directories.backgrounds, filename), original);
        fs.unlinkSync(portrait);
        fs.symlinkSync(path.join(root, 'outside.jpg'), portrait);
        expect(await findMobileBackground(directories, filename, manifestFile)).toBeNull();
    });

    test('keeps accounts separate and fails safely when the manifest is unavailable', async () => {
        const other = { backgrounds: path.join(root, 'other-account') };
        fs.mkdirSync(other.backgrounds);
        fs.writeFileSync(path.join(other.backgrounds, filename), 'custom image');
        expect(await findMobileBackground(directories, filename, manifestFile)).toBe(portrait);
        expect(await findMobileBackground(other, filename, manifestFile)).toBeNull();
        expect(await findMobileBackground(directories, filename, path.join(root, 'missing.json'))).toBeNull();
    });

    test('redirects unknown backgrounds to the ordinary account-specific route without caching', async () => {
        const response = await fetch(`${baseUrl}/api/backgrounds/mobile/${encodeURIComponent(filename)}`, { redirect: 'manual' });
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe(`/backgrounds/${encodeURIComponent(filename)}`);
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect((await fetch(`${baseUrl}/api/backgrounds/mobile/${encodeURIComponent('../outside.jpg')}`, { redirect: 'manual' })).status).toBe(400);
    });

    test('serves the bundled portrait only for an unchanged original in the current account', async () => {
        const mobileDir = path.join(projectRoot, 'default/content/backgrounds-mobile');
        const item = JSON.parse(fs.readFileSync(path.join(mobileDir, 'artwork-provenance.json'), 'utf8')).backgrounds[0];
        const accountFile = path.join(directories.backgrounds, item.filename);
        fs.copyFileSync(path.join(projectRoot, item.reference), accountFile);
        const request = () => fetch(`${baseUrl}/api/backgrounds/mobile/${encodeURIComponent(item.filename)}`, { redirect: 'manual' });
        const response = await request();
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(Buffer.from(await response.arrayBuffer())).toEqual(fs.readFileSync(path.join(mobileDir, item.mobileFile)));

        const custom = fs.readFileSync(accountFile);
        custom[0] ^= 1;
        fs.writeFileSync(accountFile, custom);
        expect((await request()).status).toBe(302);
        fs.unlinkSync(accountFile);
        expect((await request()).status).toBe(302);
        fs.symlinkSync(path.join(projectRoot, item.reference), accountFile);
        expect((await request()).status).toBe(302);
    });
});
