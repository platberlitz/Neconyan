import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalWorkingDirectory = process.cwd();
process.chdir(repoRoot);
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));

const {
    assignImagesToFolder,
    createFolder,
    getAverageBitmapColor,
    getOrGenerateMetadataBatch,
    readMetadataIndex,
    waitForDominantColors,
} = await import('../src/endpoints/image-metadata.js');

const nativeFetch = global.fetch;

// Node's fetch cannot load the file: WASM URLs used by the Jimp codecs in Jest.
async function fetchWithFileSupport(input, init) {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    if (url.protocol === 'file:') {
        const body = await fs.promises.readFile(fileURLToPath(url));
        return new Response(body, { headers: { 'Content-Type': 'application/wasm' } });
    }
    return nativeFetch(input, init);
}

// A real 8x8 PNG of white and light grey squares.
const PNG_FIXTURE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=', 'base64');
const HEX_COLOR = /^#[0-9a-f]{6}$/;

describe('background gallery metadata without waiting for dominant colours', () => {
    let root;
    const relativePath = path.join('backgrounds', 'scene.png');

    beforeAll(() => {
        global.fetch = fetchWithFileSupport;
    });

    afterAll(() => {
        global.fetch = nativeFetch;
        process.chdir(originalWorkingDirectory);
    });

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'neconyan-image-metadata-'));
        await fs.promises.mkdir(path.join(root, 'backgrounds'));
        await fs.promises.writeFile(path.join(root, relativePath), PNG_FIXTURE);
    });

    afterEach(async () => {
        await waitForDominantColors(root);
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    test('returns what the gallery needs at once and fills the colour in afterwards', async () => {
        const { results, generatedCount } = await getOrGenerateMetadataBatch(root, [relativePath], 'bg', { deferColor: true });

        expect(generatedCount).toBe(1);
        expect(results[relativePath]).toMatchObject({ aspectRatio: 1, isAnimated: false, folderIds: [] });
        expect(results[relativePath].addedTimestamp).toEqual(expect.any(Number));
        expect(results[relativePath].dominantColor).toBeUndefined();

        await waitForDominantColors(root);

        const index = await readMetadataIndex(root);
        expect(index.images['backgrounds/scene.png'].dominantColor).toMatch(HEX_COLOR);
        expect(index.images['backgrounds/scene.png'].dominantColor).not.toBe('#808080');

        const again = await getOrGenerateMetadataBatch(root, [relativePath], 'bg', { deferColor: true });
        expect(again.generatedCount).toBe(0);
        expect(again.results[relativePath].dominantColor).toMatch(HEX_COLOR);
    });

    test('keeps a folder change made while the colour was being worked out', async () => {
        await getOrGenerateMetadataBatch(root, [relativePath], 'bg', { deferColor: true });

        // Started together, so each change has to wait for the one before it instead of overwriting it.
        const [night, rain] = await Promise.all([createFolder(root, 'Night'), createFolder(root, 'Rain')]);
        await Promise.all([
            assignImagesToFolder(root, night.id, ['backgrounds/scene.png']),
            assignImagesToFolder(root, rain.id, ['backgrounds/scene.png']),
            waitForDominantColors(root),
        ]);

        const settled = await readMetadataIndex(root);
        expect(settled.folders.map(folder => folder.name)).toEqual(['Night', 'Rain']);
        expect(settled.images['backgrounds/scene.png'].folderIds).toEqual([night.id, rain.id]);
        expect(settled.images['backgrounds/scene.png'].dominantColor).toMatch(HEX_COLOR);
    });

    test('still works the colour out before answering when it is not deferred', async () => {
        await getOrGenerateMetadataBatch(root, [relativePath], 'bg', { deferColor: true });
        const { results } = await getOrGenerateMetadataBatch(root, [relativePath], 'bg');

        expect(results[relativePath].dominantColor).toMatch(HEX_COLOR);
    });

    test('skips files that are missing', async () => {
        const { results, generatedCount } = await getOrGenerateMetadataBatch(root, [path.join('backgrounds', 'gone.png'), relativePath], 'bg', { deferColor: true });

        expect(generatedCount).toBe(1);
        expect(Object.keys(results)).toEqual([relativePath]);
    });

    test('averages a bitmap without resizing it', () => {
        const data = Buffer.from([255, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255, 0, 0, 255, 255]);

        expect(getAverageBitmapColor({ width: 2, height: 2, data })).toBe('#800080');
        expect(getAverageBitmapColor({ width: 0, height: 0, data: Buffer.alloc(0) })).toBe('#808080');
    });
});
