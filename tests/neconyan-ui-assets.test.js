import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

describe('Neconyan generated UI artwork', () => {
    test('ships three distinct Sunburst assistant head icons', () => {
        const provenance = readJson('public/img/neconyan/assistant-icons/artwork-provenance.json');
        expect(provenance.model).toBe('gpt-image-2.5-sunburst');
        expect(provenance.icons.map(item => item.id)).toEqual(['miso', 'taro', 'nori']);
        expect(new Set(provenance.icons.map(item => item.finalSha256)).size).toBe(3);
        for (const item of provenance.icons) {
            const bytes = fs.readFileSync(path.join(root, item.finalFile));
            expect(bytes.readUInt32BE(16)).toBe(192);
            expect(bytes.readUInt32BE(20)).toBe(192);
            expect(bytes[25]).toBe(6); // PNG RGBA colour type.
            expect(createHash('sha256').update(bytes).digest('hex')).toBe(item.finalSha256);
        }
    });
    test('ships exactly fifty distinct Sunburst backgrounds at the browser dimensions', () => {
        const provenance = readJson('default/content/backgrounds/artwork-provenance.json');
        const index = readJson('default/content/index.json');
        expect(provenance.backgrounds).toHaveLength(50);
        expect(new Set(provenance.backgrounds.map(item => item.id)).size).toBe(50);
        expect(new Set(provenance.backgrounds.map(item => item.finalSha256)).size).toBe(50);
        for (const item of provenance.backgrounds) {
            expect(item.width).toBe(1536);
            expect(item.height).toBe(1024);
            expect(fs.existsSync(path.join(root, item.finalFile))).toBe(true);
            expect(createHash('sha256').update(fs.readFileSync(path.join(root, item.finalFile))).digest('hex')).toBe(item.finalSha256);
            expect(index).toContainEqual({ filename: item.finalFile.replace('default/content/', ''), type: 'background' });
        }
    });

    test('ships eight local tour illustrations with DOM copy metadata', () => {
        const provenance = readJson('public/img/neconyan/tour/artwork-provenance.json');
        expect(provenance.tour).toHaveLength(8);
        expect(new Set(provenance.tour.map(item => item.speaker))).toEqual(new Set(['Miso', 'Taro', 'Nori']));
        for (const item of provenance.tour) {
            expect(item.finalFile).toMatch(/^public\/img\/neconyan\/tour\/tour-\d{2}-.+\.webp$/);
            expect(fs.existsSync(path.join(root, item.finalFile))).toBe(true);
            expect(createHash('sha256').update(fs.readFileSync(path.join(root, item.finalFile))).digest('hex')).toBe(item.finalSha256);
        }
    });
});
