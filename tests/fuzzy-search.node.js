import assert from 'node:assert/strict';
import test from 'node:test';
import { createSearchMatcher, foldSearchText, normaliseSearchText, searchSnippet } from '../public/scripts/util/fuzzy-search.js';

test('search tolerates insertions, omissions, transpositions and accents', () => {
    for (const [query, text] of [['notebok', 'Notebooks'], ['tempertaure', 'Temperature'], ['characterrs', 'Characters'],
        ['cafE', 'Café'], ['lorebok moon', 'Moon Lorebook'], ['scratch-pad', 'Scratchpad']]) {
        assert.ok(createSearchMatcher(query)(text), `${query}: ${text}`);
    }
    assert.equal(createSearchMatcher('cat dragon')('Cat notebook'), 0);
    assert.equal(createSearchMatcher('api')('Ape'), 0);
    assert.equal(createSearchMatcher('!!!')('anything'), 0);
});

test('literal names and word starts rank before approximate and infix matches', () => {
    const match = createSearchMatcher('notebook');
    assert.ok(match('Notebook') > match('Notebooks'));
    assert.ok(match('Notebooks') > match('Notebok'));
    const temp = createSearchMatcher('temp');
    assert.ok(temp('Temperature') > temp('Attempts'));
});

test('long multiword results show content near the matched words', () => {
    const snippet = searchSnippet('Unrelated. '.repeat(60) + 'Moonlight dragon returns.', 'moonlight dragon');
    assert.match(snippet, /Moonlight dragon/);
    assert.ok(snippet.length <= 182);
});

test('foldSearchText and normaliseSearchText fold Turkish İ/ı and English terms while preserving Japanese and Thai marks', () => {
    assert.equal(foldSearchText('İçe aktar'), 'ice aktar');
    assert.equal(foldSearchText('içe aktar'), 'ice aktar');
    assert.equal(foldSearchText('API'), 'api');
    assert.equal(foldSearchText('Işık'), 'isik');
    assert.equal(foldSearchText('ışık'), 'isik');
    assert.equal(foldSearchText('Quick Image Gen'), foldSearchText('quıck ımage gen'));
    assert.equal(foldSearchText('UI'), foldSearchText('uı'));

    assert.ok(createSearchMatcher('içe')('İçe aktar') > 0);
    assert.ok(createSearchMatcher('ice')('İçe aktar') > 0);
    assert.ok(createSearchMatcher('api')('API anahtarı') > 0);
    assert.ok(createSearchMatcher('ışık')('Işık') > 0);
    assert.ok(createSearchMatcher('isik')('Işık') > 0);
    assert.ok(createSearchMatcher('quıck ımage gen')('Quick Image Gen') > 0);

    // Japanese dakuten/handakuten stay intact
    assert.equal(foldSearchText('がっこう'), 'がっこう');
    assert.notEqual(foldSearchText('がっこう'), foldSearchText('かっこう'));

    // Thai tone and vowel marks stay intact in folding, normalising, and snippets
    assert.equal(foldSearchText('การตั้งค่า'), 'การตั้งค่า');
    assert.equal(normaliseSearchText('การตั้งค่า'), 'การตั้งค่า');
    assert.notEqual(foldSearchText('ที่'), foldSearchText('ที'));
    assert.equal(new Set([foldSearchText('ที'), foldSearchText('ทิ'), foldSearchText('ทุ')]).size, 3);

    const thaiText = 'ข้อความ '.repeat(40) + 'การตั้งค่า ระบบ';
    const thaiSnippet = searchSnippet(thaiText, 'การตั้งค่า');
    assert.match(thaiSnippet, /การตั้งค่า/);
    assert.match(thaiSnippet, /ข้อความ/);
});
