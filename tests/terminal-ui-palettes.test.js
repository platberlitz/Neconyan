import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(repoRoot, 'public', 'scripts', 'extensions', 'third-party', 'Neconyan-Terminal-UI');
const styleSource = fs.readFileSync(path.join(extensionRoot, 'style.css'), 'utf8');
const hostSource = fs.readFileSync(path.join(repoRoot, 'public', 'css', 'neconyan.css'), 'utf8');

describe('Termeownal UI round controls', () => {
    test('the flat reset leaves checkboxes and radios round', () => {
        const exclusion = ':not([class*=\'avatar\' i], [id*=\'avatar\' i], input[type=\'checkbox\'], input[type=\'radio\'])';
        for (const suffix of [',', '::before,', '::after {']) {
            expect(styleSource).toContain(`html body.sbterm *${exclusion}${suffix}`);
        }
    });

    test('bundled extension settings do not stretch checkboxes and radios to button height', () => {
        expect(hostSource).toContain('.sbdistiller-root) :is(button, input:not([type=\'checkbox\'], [type=\'radio\']), textarea, select, summary) {');
    });
});
