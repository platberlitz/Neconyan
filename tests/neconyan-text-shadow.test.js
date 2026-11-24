import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const read = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');

describe('universal text shadow', () => {
    test('is applied only while the shadow width is above zero', () => {
        const css = read('public/style.css');
        const universalRule = css.match(/\*\s*\{[^}]*box-sizing[^}]*\}/)?.[0] ?? '';

        expect(universalRule).toContain('box-sizing: border-box;');
        expect(universalRule).not.toContain('text-shadow');
        expect(css).toContain('body.neconyan-text-shadow *');
    });

    test('keeps the class in step with the shadow width setting', () => {
        const powerUser = read('public/scripts/power-user.js');

        expect(powerUser).toContain('document.body?.classList.toggle(\'neconyan-text-shadow\', Number(power_user.shadow_width) > 0)');
    });
});
