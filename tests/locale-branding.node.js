import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = new URL('../public/locales/', import.meta.url);
const readJson = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));

test('translations only name SillyTavern where the English source does', () => {
    const english = readJson('neconyan/en.json');
    const languages = readJson('lang.json').map(locale => locale.lang).filter(lang => lang !== 'en');
    const brand = /silly\s*tavern|酒馆|酒館|タバーン|таверн/i;
    const offenders = [];
    for (const lang of languages) {
        const entries = { ...readJson(`${lang}.json`), ...readJson(`neconyan/${lang}.json`) };
        for (const [key, value] of Object.entries(entries)) {
            if (typeof value !== 'string' || !brand.test(value)) continue;
            const source = `${key} ${english[key] ?? ''}`;
            if (/silly\s*tavern|character tavern/i.test(source)) continue;
            offenders.push(`${lang}: ${key}`);
        }
    }
    assert.deepEqual(offenders, []);
});
