import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

describe('Neconyan generated UI artwork', () => {
    test('ships the two transparent sleeping animals with matching provenance', () => {
        const provenance = readJson('public/img/neconyan/artwork-provenance.json');
        for (const name of ['sleeping-calico-left', 'sleeping-tiger-right'].flatMap(name => [name, `${name}-twitch`])) {
            const file = `public/img/neconyan/${name}.webp`;
            const item = provenance.outputs.find(item => item.path === file);
            const bytes = fs.readFileSync(path.join(root, file));
            expect(item.size).toEqual([384, 308]);
            expect(createHash('sha256').update(bytes).digest('hex')).toBe(item.sha256);
            expect(bytes.toString('ascii', 8, 16)).toBe('WEBPVP8L');
            const header = bytes.readUInt32LE(21);
            expect((header & 0x3fff) + 1).toBe(384);
            expect(((header >>> 14) & 0x3fff) + 1).toBe(308);
            expect((header >>> 28) & 1).toBe(1); // Lossless WebP alpha flag.
        }
    });
    test('ships nine distinct Sunburst assistant head icons covering every gender', () => {
        const provenance = readJson('public/img/neconyan/assistant-icons/artwork-provenance.json');
        expect(provenance.model).toBe('gpt-image-2.5-sunburst');
        expect(provenance.icons.map(item => item.id)).toEqual(['miso', 'taro', 'nori'].flatMap(id => ['male', 'female', 'neutral'].map(gender => `${id}-${gender}`)));
        expect(new Set(provenance.icons.map(item => item.finalSha256)).size).toBe(9);
        for (const item of provenance.icons) {
            const bytes = fs.readFileSync(path.join(root, item.finalFile));
            expect(bytes.readUInt32BE(16)).toBe(192);
            expect(bytes.readUInt32BE(20)).toBe(192);
            expect(bytes[25]).toBe(6); // PNG RGBA colour type.
            expect(createHash('sha256').update(bytes).digest('hex')).toBe(item.finalSha256);
        }
    });
    test('ships 52 distinct Sunburst backgrounds at the browser dimensions', () => {
        const provenance = readJson('default/content/backgrounds/artwork-provenance.json');
        const index = readJson('default/content/index.json');
        expect(provenance.backgrounds).toHaveLength(52);
        expect(new Set(provenance.backgrounds.map(item => item.id)).size).toBe(52);
        expect(new Set(provenance.backgrounds.map(item => item.finalSha256)).size).toBe(52);
        for (const item of provenance.backgrounds) {
            expect(item.width).toBe(1536);
            expect(item.height).toBe(1024);
            expect(fs.existsSync(path.join(root, item.finalFile))).toBe(true);
            expect(createHash('sha256').update(fs.readFileSync(path.join(root, item.finalFile))).digest('hex')).toBe(item.finalSha256);
            expect(index).toContainEqual({ filename: item.finalFile.replace('default/content/', ''), type: 'background' });
        }
    });

    test('ships all eight tour scenes in three distinct gender variants', () => {
        const provenance = readJson('public/img/neconyan/tour/artwork-provenance.json');
        expect(provenance.tour).toHaveLength(24);
        expect(new Set(provenance.tour.map(item => item.finalSha256)).size).toBe(24);
        const scenes = [...new Set(provenance.tour.map(item => item.scene))];
        expect(scenes).toHaveLength(8);
        for (const scene of scenes) {
            expect(provenance.tour.filter(item => item.scene === scene).map(item => item.gender)).toEqual(['male', 'female', 'neutral']);
        }
        expect(new Set(provenance.tour.map(item => item.speaker))).toEqual(new Set(['Miso', 'Taro', 'Nori']));
        for (const item of provenance.tour) {
            expect(item.finalFile).toMatch(/^public\/img\/neconyan\/tour\/tour-\d{2}-.+\.webp$/);
            expect(fs.existsSync(path.join(root, item.finalFile))).toBe(true);
            expect(createHash('sha256').update(fs.readFileSync(path.join(root, item.finalFile))).digest('hex')).toBe(item.finalSha256);
        }
    });
});
