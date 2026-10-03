import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = new URL('../public/locales/', import.meta.url);
const readJson = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));

test('every language can place the count in the lorebook import summary', () => {
    const languages = readJson('lang.json').map(locale => locale.lang).filter(lang => lang !== 'en');
    const problems = [];
    for (const lang of languages) {
        const supplement = readJson(`neconyan/${lang}.json`);
        for (const key of ['${0} imported', '${0} overwrote existing', '${0} skipped']) {
            const value = supplement[key];
            // Exactly one count, and a word of its own: an untranslated value would show English.
            if (typeof value !== 'string' || value === key || value.split('${0}').length !== 2 || !value.replace('${0}', '').trim()) problems.push(`${lang}: ${key}`);
        }
    }
    assert.deepEqual(problems, []);
});
