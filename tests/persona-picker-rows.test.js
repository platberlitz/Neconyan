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
        const row = getRuleBody('.sb-persona-picker-row');
        expect(row).toMatch(/flex-shrink:\s*0/);
    });
});

describe('reasoning effort picker rows', () => {
    const menusCss = readFileSync(path.join(__dirname, '../public/css/neconyan-menus.css'), 'utf8');
    const ruleBody = (selector) => {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return menusCss.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    };
    const row = '#sb-reasoning-effort-picker .sb-persona-option';

    test('rows get the flat persona look instead of the generic button look', () => {
        const body = ruleBody(row);
        expect(body).toMatch(/appearance:\s*none/);
        expect(body).toMatch(/border:\s*0/);
        expect(body).toMatch(/background:\s*transparent/);
        expect(body).toMatch(/text-align:\s*left/);
        expect(body).toMatch(/border-radius:\s*8px/);
        expect(body).toMatch(/--neconyan-control-radius:\s*8px/);
        expect(body).toMatch(/color:\s*var\(--neco-ink\)/);
    });

    test('focus ring and selected row use the accent tokens, never a hex colour', () => {
        expect(ruleBody(`${row}:focus-visible`)).toMatch(/outline:\s*2px solid var\(--neco-ginger\)/);
        const active = ruleBody(`${row}.is-active`);
        expect(active).toMatch(/color-mix\(in srgb, var\(--neco-ginger\) 18%, var\(--neco-surface\)\)/);
        expect(menusCss.match(/#sb-reasoning-effort-picker[^{]*\{[^}]*#[0-9a-f]{3,8}\b/gi)).toBeNull();
    });

    test('phone rows keep a 44px tap target', () => {
        expect(menusCss).toMatch(/@media \(max-width: 520px\) \{\s*#sb-reasoning-effort-picker \.sb-persona-option \{ min-height: 44px; \}/);
    });

    test('the picker leaves room for all eight efforts on a phone', () => {
        const picker = tabsCss.match(/\n#sb-reasoning-effort-picker\s*\{\s*min-width:[^}]*\}/)?.[0] ?? '';
        expect(picker).toMatch(/max-height:\s*min\(400px,/);
    });
});
