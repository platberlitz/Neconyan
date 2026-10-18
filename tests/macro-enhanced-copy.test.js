import { describe, expect, test } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../public/scripts/extensions/third-party/MacroEnhanced', import.meta.url));

function filesUnder(directory, extension) {
    const found = [];
    for (const entry of readdirSync(directory)) {
        const full = path.join(directory, entry);
        if (statSync(full).isDirectory()) {
            found.push(...filesUnder(full, extension));
        } else if (full.endsWith(extension)) {
            found.push(full);
        }
    }
    return found;
}

const ABBREVIATIONS = /(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|St|no|approx|cf)$/i;

function stringLiterals(line) {
    const values = [];
    const pattern = /'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`/g;
    for (const match of line.matchAll(pattern)) {
        values.push(match[1] ?? match[2] ?? match[3] ?? '');
    }
    return values;
}

describe('Macro Enhanced user-facing copy and CSS hygiene', () => {
    test('no em or en dashes, American flavour, or damaged sentence starts', () => {
        const problems = [];
        for (const file of filesUnder(ROOT, '.js')) {
            const relative = path.relative(ROOT, file);
            const lines = readFileSync(file, 'utf8').split(/\r?\n/);
            lines.forEach((line, index) => {
                const trimmed = line.trim();
                if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
                    return;
                }
                if (/[\u2013\u2014]/.test(line)) {
                    problems.push(`${relative}:${index + 1}: em or en dash`);
                }
                if (/\bflavor\b/i.test(line)) {
                    problems.push(`${relative}:${index + 1}: American spelling`);
                }
                for (const value of stringLiterals(line)) {
                    for (const match of value.matchAll(/(^|[^A-Za-z])\.\s+[a-z][a-z']*/g)) {
                        const before = value.slice(Math.max(0, match.index - 6), match.index + 1);
                        if (ABBREVIATIONS.test(before)) {
                            continue;
                        }
                        problems.push(`${relative}:${index + 1}: lower-case sentence after a full stop in "${value}"`);
                    }
                }
            });
        }
        expect(problems).toEqual([]);
    });

    test('the stylesheet uses theme colours, no hex, no // comments and no dimmed text', () => {
        const css = readFileSync(path.join(ROOT, 'style.css'), 'utf8');
        expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
        expect(css).not.toMatch(/(^|[^:])\/\//m);
        expect(css).not.toMatch(/\bopacity\s*:/);
        expect(css).not.toMatch(/font-size\s*:[^;]*\bvw\b/);
    });

    test('no source file carries a raw NUL byte', () => {
        for (const file of filesUnder(ROOT, '.js')) {
            expect(readFileSync(file, 'utf8').includes('\u0000')).toBe(false);
        }
    });
});
