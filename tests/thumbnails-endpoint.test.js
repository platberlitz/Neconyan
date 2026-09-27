import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageSize } from 'image-size';
import { Jimp, JimpMime } from '../src/jimp.js';

import { setConfigFilePath } from '../src/util.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalWorkingDirectory = process.cwd();
process.chdir(repoRoot);
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));

const {
    findPortraitFile,
    generateThumbnail,
    getThumbnailMobileRuntimeSettings,
    getThumbnailRuntimeSettings,
    invalidateThumbnail,
    publicRouter,
    setThumbnailMobileRuntimeSettings,
    setThumbnailRuntimeSettings,
} = await import('../src/endpoints/thumbnails.js');
const {
    getThumbnailDimensions,
    getThumbnailMobileDimensions,
    setThumbnailDimensions,
    setThumbnailMobileDimensions,
} = await import('../src/endpoints/image-metadata.js');

const originalThumbnailSettings = getThumbnailRuntimeSettings();
const originalMobileThumbnailSettings = getThumbnailMobileRuntimeSettings();
const originalThumbnailDimensions = getThumbnailDimensions();
const originalMobileThumbnailDimensions = getThumbnailMobileDimensions();
const nativeFetch = global.fetch;
const describePosix = process.platform === 'win32' ? describe.skip : describe;

// Node's fetch cannot load the file: WASM URLs used by the Jimp codecs in Jest.
async function fetchWithFileSupport(input, init) {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    if (url.protocol === 'file:') {
        const body = await fs.promises.readFile(fileURLToPath(url));
        return new Response(body, { headers: { 'Content-Type': 'application/wasm' } });
    }
    return nativeFetch(input, init);
}

// A real 8x8 PNG. The cached-thumbnail branch of generateThumbnail measures the file with
// image-size, so those cases need parseable bytes rather than an arbitrary marker.
const PNG_FIXTURE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=', 'base64');
const THUMBNAIL_MARKER = PNG_FIXTURE;
const SECRET_MARKER = 'secret-outside-the-folder';

describe('thumbnail file name resolution', () => {
    let baseUrl;
    let directories;
    let server;
    let tempRoot;

    beforeAll(async () => {
        const app = express();
        app.use((request, _response, next) => {
            request.user = {
                profile: { handle: 'thumbnails-test-user' },
                directories,
            };
            next();
        });
        app.use('/thumbnail', publicRouter);

        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        global.fetch = fetchWithFileSupport;
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-thumbnails-'));
        directories = {
            root: tempRoot,
            avatars: path.join(tempRoot, 'User Avatars'),
            backgrounds: path.join(tempRoot, 'backgrounds'),
            characters: path.join(tempRoot, 'characters'),
            thumbnailsAvatar: path.join(tempRoot, 'thumbnails', 'avatar'),
            thumbnailsAvatarMobile: path.join(tempRoot, 'thumbnails', 'avatar', 'mobile'),
            thumbnailsBg: path.join(tempRoot, 'thumbnails', 'bg'),
            thumbnailsBgMobile: path.join(tempRoot, 'thumbnails', 'bg', 'mobile'),
            thumbnailsPersona: path.join(tempRoot, 'thumbnails', 'persona'),
        };
        for (const directory of Object.values(directories)) {
            fs.mkdirSync(directory, { recursive: true });
        }
        // Lives one level above the characters folder, so a successful traversal would expose it.
        fs.writeFileSync(path.join(tempRoot, 'secret.png'), SECRET_MARKER);
    });

    afterEach(() => {
        global.fetch = nativeFetch;
        setThumbnailRuntimeSettings(originalThumbnailSettings);
        setThumbnailMobileRuntimeSettings(originalMobileThumbnailSettings);
        setThumbnailDimensions(originalThumbnailDimensions);
        setThumbnailMobileDimensions(originalMobileThumbnailDimensions);
        jest.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    afterAll(async () => {
        if (server) {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
        process.chdir(originalWorkingDirectory);
    });

    function writeCharacter(name) {
        fs.writeFileSync(path.join(directories.characters, name), PNG_FIXTURE);
    }

    function writeBackground(name) {
        fs.writeFileSync(path.join(directories.backgrounds, name), PNG_FIXTURE);
    }

    /**
     * Writes a cached thumbnail whose timestamps are newer than the original, so the freshness
     * check in generateThumbnail treats it as up to date instead of regenerating it.
     * @param {string} name File name
     * @param {Buffer|string} contents File contents
     */
    function writeCachedThumbnail(name, contents = THUMBNAIL_MARKER) {
        const target = path.join(directories.thumbnailsAvatar, name);
        fs.writeFileSync(target, contents);
        const past = new Date(Date.now() - 60_000);
        fs.utimesSync(path.join(directories.characters, name), past, past);
    }

    async function requestThumbnail(query) {
        return await fetch(`${baseUrl}/thumbnail?${query}`);
    }

    test('serves the real thumbnail when the file name arrives percent-encoded twice', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        writeCharacter('Mara Rodriguez.png');
        writeCachedThumbnail('Mara Rodriguez.png');

        // Express decodes the query once, so the handler sees the literal "Mara%20Rodriguez.png".
        const response = await requestThumbnail('type=avatar&file=Mara%2520Rodriguez.png');

        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(THUMBNAIL_MARKER);
        expect(errorSpy).not.toHaveBeenCalled();
    });

    test.each(['desktop', 'mobile'])('validates %s cached contents when size and timestamps coincide', async preset => {
        const file = 'same-time.png';
        writeCharacter(file);
        const folder = preset === 'mobile' ? directories.thumbnailsAvatarMobile : directories.thumbnailsAvatar;
        const cachedPath = path.join(folder, file);
        const first = await new Jimp({ width: 3, height: 4, color: 0xff0000ff }).getBuffer(JimpMime.png);
        const second = await new Jimp({ width: 3, height: 4, color: 0x00ff00ff }).getBuffer(JimpMime.png);
        expect(first.length).toBe(second.length);
        expect(first).not.toEqual(second);
        const timestamp = new Date(Date.now() - 1000);
        const originalTime = new Date(timestamp.getTime() - 60000);
        fs.utimesSync(path.join(directories.characters, file), originalTime, originalTime);
        fs.writeFileSync(cachedPath, first);
        fs.utimesSync(cachedPath, timestamp, timestamp);
        const url = `${baseUrl}/thumbnail?type=avatar&file=${file}&preset=${preset}`;
        const initial = await fetch(url);
        expect(Buffer.from(await initial.arrayBuffer())).toEqual(first);
        fs.writeFileSync(cachedPath, second);
        fs.utimesSync(cachedPath, timestamp, timestamp);
        const changed = await fetch(url, { headers: { 'If-None-Match': initial.headers.get('etag'), 'Cache-Control': 'max-age=0' } });
        expect(changed.status).toBe(200);
        expect(Buffer.from(await changed.arrayBuffer())).toEqual(second);
        expect(changed.headers.get('etag')).not.toBe(initial.headers.get('etag'));
        const before = fs.statSync(cachedPath).ctimeMs;
        const unchanged = await fetch(url, { headers: { 'If-None-Match': changed.headers.get('etag'), 'Cache-Control': 'max-age=0' } });
        expect(unchanged.status).toBe(304);
        expect(fs.statSync(cachedPath).ctimeMs).toBe(before);
    });

    test.each([
        'desktop',
        'mobile',
    ])('refreshes an existing %s thumbnail after the original is replaced', async (preset) => {
        const file = 'Nori (Male).png';
        writeCharacter(file);
        setThumbnailRuntimeSettings({ enabled: true, format: 'png', quality: 100 });
        setThumbnailMobileRuntimeSettings({ enabled: true, format: 'png', quality: 100 });
        setThumbnailDimensions({ ...originalThumbnailDimensions, avatar: [6, 8] });
        setThumbnailMobileDimensions({ ...originalMobileThumbnailDimensions, avatar: [3, 4] });
        const url = `${baseUrl}/thumbnail?type=avatar&file=${encodeURIComponent(file)}&preset=${preset}`;
        const initial = await fetch(url);
        expect(initial.status).toBe(200);
        const oldBytes = Buffer.from(await initial.arrayBuffer());
        const replacement = new Jimp({ width: 8, height: 8, color: 0xff0000ff });
        const originalPath = path.join(directories.characters, file);
        fs.writeFileSync(originalPath, await replacement.getBuffer(JimpMime.png));
        const updated = new Date(Date.now() + 2000);
        fs.utimesSync(originalPath, updated, updated);

        const response = await fetch(url, { headers: { 'If-None-Match': initial.headers.get('etag'), 'Cache-Control': 'max-age=0' } });
        expect(response.status).toBe(200);
        const bytes = Buffer.from(await response.arrayBuffer());
        expect(bytes).not.toEqual(oldBytes);
        expect((await Jimp.read(bytes)).getPixelColor(0, 0)).toBe(0xff0000ff);

        // The regenerated image is reused on the next request.
        const folder = preset === 'mobile' ? directories.thumbnailsAvatarMobile : directories.thumbnailsAvatar;
        const cachedPath = path.join(folder, file);
        const cachedStat = fs.statSync(cachedPath);
        const past = new Date(cachedStat.ctimeMs - 1000);
        fs.utimesSync(originalPath, past, past);
        const unchanged = await fetch(url, { headers: { 'If-None-Match': response.headers.get('etag'), 'Cache-Control': 'max-age=0' } });
        expect(unchanged.status).toBe(304);
        expect(fs.statSync(cachedPath).ctimeMs).toBe(cachedStat.ctimeMs);
    });

    test.each([
        ['desktop', 'mobile'],
        ['mobile', 'desktop'],
    ])('keeps background variants independent when %s is requested before %s', async (firstPreset, secondPreset) => {
        const file = 'background.png';
        writeBackground(file);
        setThumbnailRuntimeSettings({ enabled: true, format: 'png', quality: 100 });
        setThumbnailMobileRuntimeSettings({ enabled: true, format: 'jpg', quality: 82 });
        setThumbnailDimensions({ ...originalThumbnailDimensions, bg: [6, 6] });
        setThumbnailMobileDimensions({ ...originalMobileThumbnailDimensions, bg: [4, 4] });

        const responses = {};
        for (const preset of [firstPreset, secondPreset]) {
            const presetQuery = preset === 'mobile' ? '&preset=mobile' : '';
            const response = await requestThumbnail(`type=bg&file=${file}${presetQuery}`);
            responses[preset] = {
                body: Buffer.from(await response.arrayBuffer()),
                contentType: response.headers.get('content-type'),
                status: response.status,
            };
        }

        const desktopPath = path.join(directories.thumbnailsBg, file);
        const mobilePath = path.join(directories.thumbnailsBgMobile, file);
        expect(desktopPath).not.toBe(mobilePath);
        expect(fs.readFileSync(desktopPath)).toEqual(responses.desktop.body);
        expect(fs.readFileSync(mobilePath)).toEqual(responses.mobile.body);

        expect(responses.desktop.status).toBe(200);
        expect(responses.desktop.contentType).toMatch(/^image\/png\b/);
        expect(responses.desktop.body.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        expect(imageSize(responses.desktop.body)).toMatchObject({ width: 6, height: 6, type: 'png' });

        expect(responses.mobile.status).toBe(200);
        expect(responses.mobile.contentType).toMatch(/^image\/jpeg\b/);
        expect(responses.mobile.body.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
        expect(imageSize(responses.mobile.body)).toMatchObject({ width: 4, height: 4, type: 'jpg' });

        invalidateThumbnail(directories, 'bg', file);
        expect(fs.existsSync(desktopPath)).toBe(false);
        expect(fs.existsSync(mobilePath)).toBe(false);
    });

    test('still serves correctly encoded names containing a space', async () => {
        writeCharacter('Mara Rodriguez.png');
        writeCachedThumbnail('Mara Rodriguez.png');

        const response = await requestThumbnail('type=avatar&file=Mara%20Rodriguez.png');

        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(THUMBNAIL_MARKER);
    });

    test('still serves plain names', async () => {
        writeCharacter('Alice.png');
        writeCachedThumbnail('Alice.png');

        const response = await requestThumbnail('type=avatar&file=Alice.png');

        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(THUMBNAIL_MARKER);
    });

    describePosix('POSIX file names', () => {
        test('serves and invalidates a thumbnail whose file name contains a pipe', async () => {
            const file = 'Alice | Test.png';
            writeCharacter(file);
            writeCachedThumbnail(file);

            const response = await requestThumbnail(`type=avatar&file=${encodeURIComponent(file)}`);

            expect(response.status).toBe(200);
            expect(Buffer.from(await response.arrayBuffer())).toEqual(THUMBNAIL_MARKER);

            invalidateThumbnail(directories, 'avatar', file);
            expect(fs.existsSync(path.join(directories.thumbnailsAvatar, file))).toBe(false);
        });
    });

    test('rejects a traversal hidden behind double percent-encoding', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});

        // Express decodes these to "%2E%2E%2Fsecret.png" and "..%2Fsecret.png", which survive
        // sanitize() untouched and therefore reach the decode fallback.
        for (const query of ['type=avatar&file=%252E%252E%252Fsecret.png', 'type=avatar&file=..%252Fsecret.png', 'type=avatar&file=%2500.png']) {
            const response = await requestThumbnail(query);
            expect(response.status).toBe(404);
            expect(await response.text()).not.toContain(SECRET_MARKER);
        }
    });

    test('keeps rejecting a traversal that survives the query decode', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const response = await requestThumbnail('type=avatar&file=../secret.png');

        expect(response.status).toBe(403);
    });

    test('does not fail when the name contains a malformed escape sequence', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const response = await requestThumbnail('type=avatar&file=missing%25.png');

        expect(response.status).toBe(404);
    });

    test('serves a name whose literal percent sign is not an escape sequence', async () => {
        writeCharacter('50% Off.png');
        writeCachedThumbnail('50% Off.png');

        const response = await requestThumbnail('type=avatar&file=50%25%20Off.png');

        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(THUMBNAIL_MARKER);
    });

    test('generateThumbnail resolves an over-encoded name to the file on disk', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        writeCharacter('Mara Rodriguez.png');
        writeCachedThumbnail('Mara Rodriguez.png', PNG_FIXTURE);

        const result = await generateThumbnail(directories, 'avatar', 'Mara%20Rodriguez.png');

        expect(result.path).toBe(path.join(directories.thumbnailsAvatar, 'Mara Rodriguez.png'));
        expect(errorSpy).not.toHaveBeenCalled();
    });

    test('generateThumbnail prefers a literal percent name over its decoded form', async () => {
        writeCharacter('100%25.png');
        writeCharacter('100%.png');
        writeCachedThumbnail('100%25.png', PNG_FIXTURE);
        writeCachedThumbnail('100%.png', PNG_FIXTURE);

        const result = await generateThumbnail(directories, 'avatar', '100%25.png');

        expect(result.path).toBe(path.join(directories.thumbnailsAvatar, '100%25.png'));
    });

    test('generateThumbnail leaves a bare percent name untouched', async () => {
        writeCharacter('50%.png');
        writeCachedThumbnail('50%.png', PNG_FIXTURE);

        const result = await generateThumbnail(directories, 'avatar', '50%.png');

        expect(result.path).toBe(path.join(directories.thumbnailsAvatar, '50%.png'));
    });

    test('generateThumbnail refuses to resolve outside the originals folder', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const result = await generateThumbnail(directories, 'avatar', '%2E%2E%2Fsecret.png');

        expect(result.path).toBeNull();
        expect(fs.readdirSync(directories.thumbnailsAvatar, { withFileTypes: true }).filter(entry => entry.isFile())).toEqual([]);
    });
});

describe('portrait lookup by written name', () => {
    const files = ['Miso (Female).png', 'ACTOR  Atlas Hughes.png', 'Alhaitham.png', 'Alhaitham1.png', 'Alex.png', 'Alex1.png', 'Alexander Smith.png', 'Akane  CEO.png', 'notes.txt', 'Seraphina'];

    test('prefers an exact file name', () => {
        expect(findPortraitFile(files, 'Alhaitham')).toBe('Alhaitham.png');
        expect(findPortraitFile(files, 'miso (female)')).toBe('Miso (Female).png');
    });

    test('maps a short name to the current character', () => {
        expect(findPortraitFile(files, 'Miso', 'Miso (Female)')).toBe('Miso (Female).png');
    });

    test('matches loosely without the current character', () => {
        expect(findPortraitFile(files, 'Miso')).toBe('Miso (Female).png');
        expect(findPortraitFile(files, 'Atlas Hughes')).toBe('ACTOR  Atlas Hughes.png');
        expect(findPortraitFile(files, 'Atlas')).toBe('ACTOR  Atlas Hughes.png');
    });

    test('refuses ambiguous or missing names', () => {
        expect(findPortraitFile(files, 'Smith Jones')).toBeNull();
        expect(findPortraitFile(files, 'Seraphina')).toBeNull();
        expect(findPortraitFile(files, 'notes')).toBeNull();
        expect(findPortraitFile(files, '  ')).toBeNull();
        expect(findPortraitFile(['Sam Lee.png', 'Sam Park.png'], 'Sam')).toBeNull();
    });

    test('redirects the endpoint to the avatar thumbnail', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portrait-'));
        fs.writeFileSync(path.join(root, 'Miso (Female).png'), PNG_FIXTURE);
        const app = express();
        app.use((request, _response, next) => {
            request.user = { profile: { handle: 'portrait-test' }, directories: { characters: root } };
            next();
        });
        app.use('/thumbnail', publicRouter);
        const server = await new Promise(resolve => {
            const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
        });
        try {
            const base = `http://127.0.0.1:${server.address().port}/thumbnail/portrait`;
            const found = await nativeFetch(`${base}?name=Miso&char=${encodeURIComponent('Miso (Female)')}`, { redirect: 'manual' });
            expect(found.status).toBe(302);
            expect(found.headers.get('location')).toBe('/thumbnail?type=avatar&file=Miso+%28Female%29.png');
            expect((await nativeFetch(`${base}?name=Nobody`, { redirect: 'manual' })).status).toBe(404);
            expect((await nativeFetch(base, { redirect: 'manual' })).status).toBe(400);
        } finally {
            await new Promise(resolve => server.close(resolve));
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
