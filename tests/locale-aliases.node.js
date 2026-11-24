import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.join(import.meta.dirname, '..');
const cataloguePath = path.join(root, 'public', 'locales', 'neconyan', 'en.json');
const aliasesPath = path.join(root, 'public', 'locales', 'neconyan', 'en-aliases.json');

test('the alias catalogue holds only English strings that differ from their key', () => {
    const catalogue = JSON.parse(fs.readFileSync(cataloguePath, 'utf8'));
    const aliases = JSON.parse(fs.readFileSync(aliasesPath, 'utf8'));

    assert.ok(Object.keys(aliases).length > 0);
    for (const [key, value] of Object.entries(aliases)) {
        assert.notEqual(key, value);
        assert.equal(value, catalogue[key]);
    }
    assert.ok(fs.statSync(aliasesPath).size * 20 < fs.statSync(cataloguePath).size);
});

test('the locale loader asks for the alias catalogue', () => {
    const source = fs.readFileSync(path.join(root, 'public', 'scripts', 'i18n.js'), 'utf8');
    assert.ok(source.includes('readSupplement(\'en-aliases\')'));
    assert.ok(!source.includes('readSupplement(\'en\')'));
});
