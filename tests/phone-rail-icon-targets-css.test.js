import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(repoRoot, 'public', file), 'utf8').replace(/\r\n/g, '\n');

// The body of the last rule whose selector is exactly this one.
function ruleBody(css, selector) {
    const start = css.lastIndexOf(`\n${selector} {`);
    return start < 0 ? '' : css.slice(start, css.indexOf('}', start));
}

describe('phone rail icon buttons', () => {
    test('the phone sheet gives the heading icon buttons a 44px target without making their heading taller', () => {
        const body = ruleBody(read('css/neconyan-mobile-shell.css'), 'html body.neconyan #neconyan-workspace-rail .neconyan-rail-icon-button');
        expect(body).toContain('width: 44px;');
        expect(body).toContain('min-height: 44px;');
        expect(body).toContain('margin-block: -8px;');
        expect(body).toContain('justify-content: center;');
        expect(body).not.toContain('!important');
    });

    test('the sheet that holds it is phone only, and the desktop size is unchanged', () => {
        expect(read('index.html')).toMatch(/<link [^>]*href="css\/neconyan-mobile-shell\.css\?v=[^"]+"[^>]*media="\(max-width: 768px\)"/);
        expect(ruleBody(read('css/neconyan.css'), 'body.neconyan #neconyan-workspace-rail .neconyan-rail-icon-button')).toContain('width: 28px;');
    });
});
