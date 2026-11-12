import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tabsCss = readFileSync(path.join(__dirname, '../public/css/neconyan-tabs.css'), 'utf8');

function getRuleBody(selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = tabsCss.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
    return match ? match[1] : '';
}

describe('persona picker rows', () => {
    test('scrolling list is a flex column, so rows must opt out of shrinking', () => {
        const list = getRuleBody('.sb-persona-options');
        expect(list).toMatch(/display:\s*flex/);
        expect(list).toMatch(/flex-direction:\s*column/);
        expect(list).toMatch(/overflow-y:\s*auto/);
    });

    test('rows keep their full height when a title and Scenario Note chips stack up', () => {
        const row = getRuleBody('.sb-persona-option');
        expect(row).toMatch(/flex-shrink:\s*0/);
    });
});
