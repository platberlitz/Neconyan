import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const backgroundsCss = readFileSync(new URL('../public/css/backgrounds.css', import.meta.url), 'utf8');

describe('background fitting on iPhone Safari', () => {
    test('fits against the viewport-sized layer without fixed background attachment', () => {
        const layer = backgroundsCss.match(/#bg1\s*\{([^}]+)\}/)[1];
        expect(layer).toContain('background-attachment: scroll;');
        expect(layer).toContain('width: 100%;');
        expect(layer).toContain('height: 100%;');
    });
});
