import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { assembleLocaleData, isScopedKey, tableForKey } from '../public/scripts/locale-assembly.js';
import { localizeString } from '../public/scripts/ui-localization.js';

// Scoped keys ('scoped.' prefix) are for strings that only translate() and data-i18n may reach. The loader must keep
// them, and their English text, out of the dictionary the run-time localiser matches page text against.

const readJson = file => JSON.parse(readFileSync(new URL(`../public/locales/${file}`, import.meta.url), 'utf8'));
const LANGUAGES = ['pt-pt', 'it-it', 'de-de'];
const catalogue = readJson('neconyan/en.json');
const files = Object.fromEntries(LANGUAGES.map(language => [language, { base: readJson(`${language}.json`), supplement: readJson(`neconyan/${language}.json`), catalogue }]));

// A copy of the assembly getLocaleData() did before scoped keys existed. The new function must match it exactly.
function todaysAssembly({ base, supplement, catalogue: source }) {
    const combined = { ...base, ...supplement };
    for (const [key, english] of Object.entries(source)) {
        if (combined[key] && !Object.hasOwn(combined, english)) combined[english] = combined[key];
    }
    return combined;
}

// The same inputs without any scoped entry, so the old assembly and the new one are compared on what the old one knew. Real
// translated scoped keys (the image-choice ones) would otherwise be aliased by the old assembly and fail that comparison.
function stripScoped({ base, supplement, catalogue: source }) {
    const plain = table => Object.fromEntries(Object.entries(table).filter(([key]) => !isScopedKey(key)));
    return {
        base: plain(base),
        supplement: plain(supplement),
        catalogue: Object.fromEntries(Object.entries(source).filter(([key, english]) => !isScopedKey(key) && !isScopedKey(english))),
    };
}

// The scoped table the new assembly must produce, derived from the files without calling it: the scoped entries of the merged
// base and supplement, in the order of locale-assembly.js (base keys first with the supplement's value, then supplement-only keys).
const expectedScoped = ({ base, supplement }) => Object.fromEntries(Object.entries({ ...base, ...supplement }).filter(([key]) => isScopedKey(key)));

// Two synthetic entries: a template with two holes and a short label, each a scoped key with its own English text.
const SYNTHETIC_ENGLISH = { 'scoped.test.template': 'Message ${0}, image ${1}', 'scoped.test.short': 'Completed' };
const SYNTHETIC_VALUES = { 'scoped.test.template': 'Mensagem ${0}, imagem ${1}', 'scoped.test.short': 'Concluído' };
const withSynthetic = ({ base, supplement, catalogue: source }) => ({ base, supplement: { ...supplement, ...SYNTHETIC_VALUES }, catalogue: { ...source, ...SYNTHETIC_ENGLISH } });
const PROBES = ['Message 3, image 1', 'Message 3, alternative 2, image 1', 'Message too long for this model', 'Completed'];
const render = (dictionary, probes = PROBES) => Object.fromEntries(probes.map(text => [text, localizeString(text, dictionary)]));

test('every scoped key in a real dictionary is an image-choice key of the catalogue, and the catalogue holds only the image-choice ones', () => {
    assert.ok(Object.keys(catalogue).length > 10000);
    for (const language of LANGUAGES) {
        const { base, supplement } = files[language];
        for (const [name, table] of [['base', base], ['supplement', supplement]]) {
            for (const key of Object.keys(table).filter(isScopedKey)) {
                assert.match(key, /^scoped\.prompt_media\./, `${language} ${name} holds a scoped key outside the image choices`);
                assert.ok(Object.hasOwn(catalogue, key), `${language} ${name}: ${key} is not a key of the catalogue`);
            }
        }
    }
    // The catalogue carries the English of each scoped key. Only the image-choice work has added any.
    const catalogued = Object.keys(catalogue).filter(isScopedKey);
    assert.ok(catalogued.length > 0);
    for (const key of catalogued) assert.match(key, /^scoped\.prompt_media\./);
});

test('the assembled dictionary equals today\'s byte for byte for pt-pt, it-it and de-de, and the scoped table is the files\' scoped entries', () => {
    for (const language of LANGUAGES) {
        const { dictionary, scoped } = assembleLocaleData(files[language]);
        const reference = todaysAssembly(stripScoped(files[language]));
        assert.ok(Object.keys(reference).length > 20000, `${language} reference is too small to mean anything`);
        // Key order is part of the comparison: JSON text keeps it, and deepEqual would not.
        assert.equal(JSON.stringify(dictionary), JSON.stringify(reference), `${language} dictionary differs from today's`);
        const expected = expectedScoped(files[language]);
        assert.deepEqual(scoped, expected);
        assert.equal(JSON.stringify(scoped), JSON.stringify(expected), `${language} scoped table is in another order`);
        // The real catalogue's scoped keys, and the English they carry, stay out of the matching dictionary.
        for (const [key, english] of Object.entries(catalogue).filter(([key]) => isScopedKey(key))) {
            assert.ok(!Object.hasOwn(dictionary, key), `${language}: ${key} is in the dictionary`);
            assert.ok(!Object.hasOwn(reference, key), `${language}: ${key} is in today's dictionary`);
            if (!Object.hasOwn(reference, english)) assert.ok(!Object.hasOwn(dictionary, english), `${language}: the English of ${key} became a dictionary key`);
        }
    }
});

test('scoped entries land in the scoped table only, and neither the key nor its English alias reaches the dictionary', () => {
    for (const language of LANGUAGES) {
        const plain = assembleLocaleData(files[language]);
        const { dictionary, scoped } = assembleLocaleData(withSynthetic(files[language]));
        assert.deepEqual(scoped, { ...expectedScoped(files[language]), ...SYNTHETIC_VALUES });
        for (const [key, english] of Object.entries(SYNTHETIC_ENGLISH)) {
            assert.ok(!Object.hasOwn(dictionary, key), `${language}: ${key} is in the dictionary`);
            assert.ok(!Object.hasOwn(dictionary, english), `${language}: the English alias of ${key} is in the dictionary`);
        }
        // Everything else is untouched, in the same order.
        assert.equal(JSON.stringify(dictionary), JSON.stringify(plain.dictionary), `${language}: adding scoped entries changed the dictionary`);
    }
});

test('matching is unaffected: unrelated page text renders exactly as it does without the scoped entries', () => {
    for (const language of LANGUAGES) {
        const without = render(assembleLocaleData(files[language]).dictionary);
        const dictionary = assembleLocaleData(withSynthetic(files[language])).dictionary;
        assert.deepEqual(render(dictionary), without, `${language}: page text changed`);
        // None of the four is translated today, so the comparison above is not vacuous.
        for (const text of PROBES) assert.equal(without[text], text, `${language}: ${text} is already translated`);
    }
});

test('red-green: with the old assembly the synthetic entries are aliased and the same page text changes', () => {
    for (const language of LANGUAGES) {
        const without = render(todaysAssembly(stripScoped(files[language])));
        const aliased = render(todaysAssembly(withSynthetic(stripScoped(files[language]))));
        assert.equal(aliased['Message 3, image 1'], 'Mensagem 3, imagem 1', `${language}: the template alias was not made`);
        assert.equal(aliased['Message 3, alternative 2, image 1'], 'Mensagem 3, alternative 2, imagem 1', `${language}: the hole did not span the extra words`);
        assert.equal(aliased.Completed, 'Concluído', `${language}: the short alias was not made`);
        assert.notEqual(aliased['Message 3, image 1'], without['Message 3, image 1']);
        assert.notEqual(aliased.Completed, without.Completed);
        // A near miss that no template reaches stays the same, so the check is not changing everything.
        assert.equal(aliased['Message too long for this model'], without['Message too long for this model']);
    }
});

test('a scoped entry from the base dictionary also goes to the scoped table, and the supplement wins over the base', () => {
    const { dictionary, scoped } = assembleLocaleData({
        base: { 'scoped.a': 'base a', 'scoped.b': 'base b', Open: 'Abrir' },
        supplement: { 'scoped.a': 'supplement a', Close: 'Fechar' },
        catalogue: { 'scoped.a': 'Alpha', 'scoped.b': 'Beta', Open: 'Open', Close: 'Close' },
    });
    assert.deepEqual(scoped, { 'scoped.a': 'supplement a', 'scoped.b': 'base b' });
    assert.deepEqual(dictionary, { Open: 'Abrir', Close: 'Fechar' });
});

test('an unscoped symbolic key is still aliased under its English text, and an existing entry is not overridden', () => {
    const { dictionary } = assembleLocaleData({
        base: { Saved: 'Guardado' },
        supplement: { 'old.symbolic': 'Valor', 'old.taken': 'Outro' },
        catalogue: { 'old.symbolic': 'Plain English', 'old.taken': 'Saved', 'old.missing': 'Never translated' },
    });
    assert.equal(dictionary['Plain English'], 'Valor');
    assert.equal(dictionary.Saved, 'Guardado');
    assert.ok(!Object.hasOwn(dictionary, 'Never translated'));
});

test('a catalogue entry whose English text itself begins with the prefix leaves no scoped key in the dictionary', () => {
    const { dictionary, scoped } = assembleLocaleData({
        supplement: { 'old.symbolic': 'Valor' },
        catalogue: { 'old.symbolic': 'scoped.looks.reserved' },
    });
    assert.deepEqual(dictionary, { 'old.symbolic': 'Valor' });
    assert.deepEqual(scoped, {});
});

test('the function ignores missing files and leaves its inputs alone', () => {
    assert.deepEqual(assembleLocaleData({}), { dictionary: {}, scoped: {} });
    const base = { 'scoped.a': 'A', Open: 'Abrir' };
    const supplement = { 'scoped.b': 'B' };
    const source = { 'scoped.a': 'Alpha', Open: 'Open' };
    const copies = structuredClone({ base, supplement, source });
    assembleLocaleData({ base, supplement, catalogue: source });
    assert.deepEqual({ base, supplement, source }, copies);
});

test('isScopedKey accepts only strings that begin with the reserved prefix', () => {
    assert.ok(isScopedKey('scoped.prompt_media.RVW-35.1'));
    assert.ok(isScopedKey('scoped.'));
    for (const value of ['Scoped.x', ' scoped.x', 'a scoped.x', 'scoped', 'scope.x', '', null, undefined, 3, {}]) {
        assert.ok(!isScopedKey(value), `${JSON.stringify(value)} counted as scoped`);
    }
});

test('tableForKey sends a scoped key to the scoped table and every other key to the dictionary, whatever is missing', () => {
    const dictionary = { Open: 'Abrir' };
    const scoped = { 'scoped.x': 'Valor' };
    assert.equal(tableForKey('scoped.x', dictionary, scoped), scoped);
    assert.equal(tableForKey('Open', dictionary, scoped), dictionary);
    // A scoped key never reads the dictionary, and an ordinary key never reads the scoped table.
    assert.equal(tableForKey('scoped.x', dictionary, undefined), undefined);
    assert.equal(tableForKey('Open', undefined, scoped), undefined);
    assert.equal(tableForKey('scoped.x', undefined, undefined), undefined);
});
