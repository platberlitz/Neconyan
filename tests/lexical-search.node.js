import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { canSegmentWords, lexicalSearch, terms } from '../public/scripts/util/lexical-search.js';

const node = version => ({ versions: { node: version }, config: { variables: { icu_small: true } }, env: {}, execArgv: [] });

test('only a Node runtime with small ICU data and no full data avoids Intl.Segmenter', () => {
    assert.equal(canSegmentWords(undefined), true);
    assert.equal(canSegmentWords({ versions: { node: '24.13.0' }, config: { variables: { icu_small: false } } }), true);
    assert.equal(canSegmentWords(node('24.21.0')), false);
    assert.equal(canSegmentWords({ ...node('24.21.0'), execArgv: ['--icu-data-dir=/data/runtime/icu'] }), true);
    assert.equal(canSegmentWords({ ...node('24.21.0'), env: { NODE_ICU_DATA: '/data/runtime/icu' } }), true);
});

test('word splitting gives the same memory search terms with or without Intl.Segmenter', () => {
    const text = 'Makima\u2019s old story: Denji kept 2 promises, didn\'t he? \uFF21\uFF22';
    assert.deepEqual(terms(text), ['makima\u2019s', 'old', 'story', 'denji', 'kept', '2', 'promises', 'didn\'t', 'he', 'ab']);
    const script = `
        Object.defineProperty(globalThis, 'process', { configurable: true, value: {
            versions: process.versions, config: { variables: { icu_small: true } }, env: {}, execArgv: [] } });
        Intl.Segmenter = class { constructor() { throw new Error('Intl.Segmenter must not be used'); } };
        const { terms, lexicalSearch } = await import(${JSON.stringify(new URL('../public/scripts/util/lexical-search.js', import.meta.url).href)});
        console.log(JSON.stringify([terms(${JSON.stringify(text)}), lexicalSearch([{ text: 'Denji kept the promise', searchText: '' }], 'denji').length]));`;
    const [fallback, found] = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
    assert.deepEqual(fallback, terms(text));
    assert.equal(found, 1);
    assert.equal(lexicalSearch([{ text: 'Denji kept the promise', searchText: '' }], 'denji').length, 1);
});

test('terms and lexicalSearch fold Turkish İ and API under tr-TR while preserving kır/kir, всё/все, café/cafe, Thai, and Japanese', () => {
    const originalToLocaleLowerCase = String.prototype.toLocaleLowerCase;
    String.prototype.toLocaleLowerCase = function () {
        return originalToLocaleLowerCase.call(this, 'tr-TR');
    };
    try {
        assert.deepEqual(terms('İçe'), terms('içe'));
        assert.deepEqual(terms('API'), ['api']);
        assert.equal(lexicalSearch([{ text: 'İçe aktar ve API', searchText: '' }], 'içe').length, 1);
        assert.equal(lexicalSearch([{ text: 'İçe aktar ve API', searchText: '' }], 'api').length, 1);

        assert.notDeepEqual(terms('kır'), terms('kir'));
        assert.equal(lexicalSearch([{ text: 'kır evi', searchText: '' }], 'kir').length, 0);

        assert.notDeepEqual(terms('всё'), terms('все'));
        assert.equal(lexicalSearch([{ text: 'всё готово', searchText: '' }], 'все').length, 0);

        assert.notDeepEqual(terms('café'), terms('cafe'));
        assert.equal(lexicalSearch([{ text: 'café', searchText: '' }], 'cafe').length, 0);

        assert.notDeepEqual(terms('ที่'), terms('ที'));
        assert.equal(terms('がっこう').join(''), 'がっこう');
        assert.notDeepEqual(terms('がっこう'), terms('かっこう'));
        assert.equal(lexicalSearch([{ text: 'がっこう', searchText: '' }], 'かっこう').length, 0);
    } finally {
        String.prototype.toLocaleLowerCase = originalToLocaleLowerCase;
    }
});
