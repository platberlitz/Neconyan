import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('report translation coverage without mistaking English fallbacks for translations', () => {
    const root = new URL('../public/locales/', import.meta.url);
    const files = readdirSync(root).filter(file => file.endsWith('.json') && !['en.json', 'lang.json'].includes(file));
    const locales = files.map(filename => [filename, JSON.parse(readFileSync(new URL(filename, root), 'utf8'))]);
    // English is implicit in the source, so en.json is intentionally empty.
    const keys = [...new Set(locales.flatMap(([, data]) => Object.keys(data).filter(key => typeof data[key] === 'string')))];
    assert.ok(keys.length > 0);
    for (const [filename, translated] of locales) {
        const missing = keys.filter(key => !translated[key]);
        const unchanged = keys.filter(key => translated[key] === key);
        console.log(`${filename}: ${missing.length} missing, ${unchanged.length} unchanged from English, ${keys.length} known keys`);
    }
});
