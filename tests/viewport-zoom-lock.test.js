import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');

describe('viewport zoom lock', () => {
    test('keeps iPhone Safari from zooming in when a text field gets focus', () => {
        const viewport = indexHtml.match(/<meta name="viewport" content="([^"]+)">/)?.[1] ?? '';
        const parts = viewport.split(',').map(part => part.trim());
        expect(parts).toEqual(expect.arrayContaining(['maximum-scale=1.0', 'user-scalable=no', 'interactive-widget=resizes-visual']));
    });
});
