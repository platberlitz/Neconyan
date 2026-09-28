/* eslint-disable playwright/no-duplicate-hooks */
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';

const writeFileAtomicSync = jest.fn();
const saveSpriteFiles = jest.fn();

await jest.unstable_mockModule('../node_modules/write-file-atomic/lib/index.js', () => ({
    sync: writeFileAtomicSync,
}));
await jest.unstable_mockModule('../src/endpoints/assets.js', () => ({
    validateAssetFileName: () => ({}),
}));
await jest.unstable_mockModule('../src/util.js', () => ({
    clientRelativePath: () => '/files/memory.txt',
    getImageBuffers: jest.fn(),
}));
await jest.unstable_mockModule('../src/generation/sprite-storage.js', () => ({
    saveSpriteFiles, listSpriteFiles: jest.fn(), deleteSpriteFiles: jest.fn(),
}));
await jest.unstable_mockModule('../src/roleplay-store.js', () => ({
    roleplayAccountBase: jest.fn(), roleplayAccountStamp: jest.fn(),
}));

const { router: filesRouter } = await import('../src/endpoints/files.js');
const { importRisuSprites } = await import('../src/endpoints/sprites.js');

let baseUrl;
let directories;
let server;
let tempRoot;

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = {
            profile: { handle: 'base64-test-user' },
            directories,
        };
        next();
    });
    app.use('/api/files', filesRouter);

    await new Promise(resolve => {
        server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-base64-writes-'));
    directories = {
        root: tempRoot,
        files: path.join(tempRoot, 'files'),
        characters: path.join(tempRoot, 'characters'),
    };
    fs.mkdirSync(directories.files, { recursive: true });
    writeFileAtomicSync.mockClear();
    saveSpriteFiles.mockClear();
});

afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

afterAll(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe('Base64 atomic writes', () => {
    test('decodes Data Bank uploads before writing', async () => {
        jest.spyOn(console, 'info').mockImplementation(() => {});
        const content = '<memory>\n- hello\n</memory>';

        const response = await fetch(`${baseUrl}/api/files/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'memory.txt',
                data: Buffer.from(content).toString('base64'),
            }),
        });

        expect(response.status).toBe(200);
        expect(writeFileAtomicSync).toHaveBeenCalledTimes(1);
        const [filePath, data] = writeFileAtomicSync.mock.calls[0];
        expect(filePath).toBe(path.join(directories.files, 'memory.txt'));
        expect(Buffer.isBuffer(data)).toBe(true);
        expect(data.toString()).toBe(content);
        expect(writeFileAtomicSync.mock.calls[0]).toHaveLength(2);
    });

    test('decodes RisuAI sprites before passing them to the protected writer', () => {
        jest.spyOn(console, 'info').mockImplementation(() => {});
        const pngHeader = Buffer.from('89504e470d0a1a0a', 'hex');
        const data = {
            data: {
                name: 'Alice',
                extensions: {
                    risuai: {
                        additionalAssets: [['happy', pngHeader.toString('base64')]],
                    },
                },
            },
        };

        importRisuSprites(directories, data);

        expect(saveSpriteFiles).toHaveBeenCalledTimes(1);
        const [target, name, sprites, options] = saveSpriteFiles.mock.calls[0];
        expect(target).toBe(directories);
        expect(name).toBe('Alice');
        expect(sprites).toHaveLength(1);
        expect(sprites[0].filename).toBe('happy.png');
        expect(Buffer.isBuffer(sprites[0].bytes)).toBe(true);
        expect(sprites[0].bytes.equals(pngHeader)).toBe(true);
        expect(options).toEqual({ overwrite: false });
        expect(writeFileAtomicSync).not.toHaveBeenCalled();
    });
});
