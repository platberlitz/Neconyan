import assert from 'node:assert/strict';
import test from 'node:test';
import { createSearchMatcher, searchSnippet } from '../public/scripts/util/fuzzy-search.js';

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
