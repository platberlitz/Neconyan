import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(path.join(repoRoot, 'public', 'css', 'neconyan-tabs.css'), 'utf8').replace(/\r\n/g, '\n');

// The body of the last rule whose selector is exactly this one.
function ruleBody(selector) {
    const start = css.lastIndexOf(`\n${selector} {`);
    return start < 0 ? '' : css.slice(start, css.indexOf('}', start));
}

describe('Lorebook settings bar', () => {
    test('the closed bar is a solid surface with the body ink on it, from tokens only', () => {
        const body = ruleBody('.neconyan-lorebook-secondary-settings > summary');
        expect(body).toContain('background: var(--neco-surface);');
        expect(body).toContain('color: var(--neco-ink);');
        expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    });

    test('opening it only squares the lower corners, so the fill carries over', () => {
        const body = ruleBody('.neconyan-lorebook-secondary-settings[open] > summary');
        expect(body).toContain('border-radius');
        expect(body).not.toContain('background');
    });
});
