import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';

const read = path => readFileSync(new URL(`../public/scripts/${path}`, import.meta.url), 'utf8');

describe('streamed observer work', () => {
    test('the accessibility observer tests one union selector before walking every rule', () => {
        const source = read('a11y.js');
        expect(source).toContain('const anyA11ySelector = Object.keys(a11yRules).join(\', \');');
        expect(source).toContain('if (!element.matches(anyA11ySelector) && !element.querySelector(anyA11ySelector)) {');
    });

    test('the keyboard observer skips empty descendants', () => {
        const source = read('keyboard.js');
        expect(source).toContain('if (descendants && node.firstElementChild) initializeInteractables(node);');
        expect(source).toContain('if (descendants && node.firstElementChild) initializeScrollResetBehaviors(node);');
    });

    test('message sleepers ignore style writes that only move the phone viewport variables', () => {
        const source = read('neconyan-message-sleepers.js');
        expect(source).toContain('function withoutShellStyle(style) {');
        expect(source).toContain('.replace(/--sb-(?:shell|ios)-[^:;]+:\\s*[^;]*;?/g, \'\')');
        expect(source).toContain('if (record.attributeName === \'style\' && withoutShellStyle(record.oldValue) === withoutShellStyle(current)) return false;');
        expect(source).toContain('if (record.attributeName === \'class\' && record.oldValue === current) return false;');
        expect(source).toContain('attributeOldValue: true');
    });
});
