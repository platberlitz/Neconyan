/* eslint playwright/expect-expect: off -- These checks use node:assert, not Playwright assertions. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';
import { lexicalSearch } from '../public/scripts/util/lexical-search.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { hash, newState, syncSources } = await import('../src/mewmory/core.js');
const { defaultConfig, roleVersion } = await import('../src/mewmory/models.js');
const { hybridCandidates, mergeVectorIndex, rankedCandidates, searchDocuments, searchableVectorDimension, updateIndex } = await import('../src/mewmory/search.js');
const { mutateState, readState, readStateShared, statePath, writeJson } = await import('../src/mewmory/store.js');

const locator = { avatar: 'Mara.png', chat: 'vector-reader', group: false };
const options = { minSimilarity: 0.2, semanticWeight: 0.62 };
const topSize = 10;

function compactEntry(textHash, values) {
    const bytes = new ArrayBuffer(values.length * 4);
    const view = new DataView(bytes);
    values.forEach((value, i) => view.setFloat32(i * 4, Math.fround(value), true));
    return { textHash, vectorF32LE: Buffer.from(bytes).toString('base64') };
}

function document(id, text) {
    return { id, kind: 'event', text, searchText: text, refs: [] };
}

function embeddingConfig() {
    const config = defaultConfig();
    Object.assign(config.roles.embedding, { enabled: true, model: 'fixture', allowedData: ['chat'] });
    return config;
}

function referenceSimilarity(query, values) {
    const dot = query.reduce((sum, component, index) => sum + component * values[index], 0);
    return dot / (Math.hypot(...query) * Math.hypot(...values));
}

// These ranking documents are distinct events so there is no per-source de-duplication.
function oracleRanking(documents, text, query, values, settings) {
    const mode = settings.mode === 'semantic' && !query ? 'keyword' : settings.mode;
    const ranked = new Map();
    if (mode !== 'semantic') {
        lexicalSearch(documents, text, documents.length).forEach(({ document, score }, index) => {
            ranked.set(document.id, { id: document.id, score: (mode === 'hybrid' && query ? 1 - settings.semanticWeight : 1) / (61 + index),
                keywordScore: score, similarity: null });
        });
    }
    if (query && mode !== 'keyword') {
        documents.map(doc => ({ id: doc.id, similarity: referenceSimilarity(query, values[doc.id]) }))
            .filter(result => result.similarity > settings.minSimilarity)
            .sort((a, b) => b.similarity - a.similarity)
            .forEach(({ id, similarity }, index) => {
                const current = ranked.get(id) ?? { id, score: 0, keywordScore: null };
                const weight = mode === 'hybrid' ? settings.semanticWeight : 1;
                ranked.set(id, { ...current, score: current.score + weight / (61 + index), similarity });
            });
    }
    return [...ranked.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, topSize);
}

function actualRanking(documents, text, query, entries, settings) {
    return rankedCandidates(documents, text, query, entries, topSize, settings)
        .map(({ document: { id }, score, keywordScore, similarity }) => ({ id, score, keywordScore, similarity }));
}

const ids = ranked => ranked.map(row => row.id);
function verifyRanking(actual, expected) {
    assert.deepEqual(ids(actual), ids(expected));
    for (const [index, row] of actual.entries()) {
        const reference = expected[index];
        assert.equal(row.score, reference.score);
        assert.equal(row.keywordScore, reference.keywordScore);
        if (reference.similarity === null) assert.equal(row.similarity, null);
        else assert.ok(Math.abs(row.similarity - reference.similarity) < 1e-14);
    }
}

function emitRanking(t, set, map, query, mode, original, actual, expected) {
    const originalIds = ids(original), actualIds = ids(actual);
    const changes = [...new Set([...originalIds, ...actualIds])].map(id => {
        const from = originalIds.indexOf(id), to = actualIds.indexOf(id);
        const left = original[from], right = actual[to];
        return { id, previousRank: from < 0 ? null : from + 1, rank: to < 0 ? null : to + 1,
            previousScore: left?.score ?? null, score: right?.score ?? null,
            scoreDelta: left && right ? right.score - left.score : null,
            previousSimilarity: left?.similarity ?? null, similarity: right?.similarity ?? null,
            similarityDelta: left?.similarity != null && right?.similarity != null ? right.similarity - left.similarity : null };
    });
    t.diagnostic('mewmory-vector-ranking ' + JSON.stringify({
        set, map, query, mode, originalTop10: originalIds, actualTop10: actualIds, oracleTop10: ids(expected),
        top1Agreement: originalIds[0] === actualIds[0],
        intersectionAt10: originalIds.filter(id => actualIds.includes(id)).length, changes,
    }));
}

test('256 documents and 32 deterministic queries retain separated rankings through compact and mixed maps', t => {
    let seed = 0x41c6ce57;
    const component = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 2147483648 - 1;
    };
    const vector = () => Array.from({ length: 12 }, component);
    const words = ['ferry', 'repair', 'harbour', 'lantern', 'library', 'market', 'garden', 'railway'];
    const documents = Array.from({ length: 256 }, (_, i) =>
        document('event:' + String(i).padStart(3, '0'), words[i % 8] + ' ' + words[Math.floor(i / 8) % 8] + ' memory ' + i));
    const values = Object.fromEntries(documents.map(doc => [doc.id, vector()]));
    const queries = Array.from({ length: 32 }, vector);
    const allNumeric = Object.fromEntries(documents.map(doc => [doc.id, { textHash: hash(doc.searchText), vector: values[doc.id] }]));
    const allCompact = Object.fromEntries(documents.map(doc => [doc.id, compactEntry(hash(doc.searchText), values[doc.id])]));
    const published = { version: 'fixture', vectors: allCompact };
    const staged = { version: 'older', vectors: allNumeric, build: { version: 'fixture', vectors: allCompact } };
    const mixed = { version: 'fixture', vectors: Object.fromEntries(documents.map(({ id }, i) => [id, i % 2 ? allNumeric[id] : allCompact[id]])) };
    const scenarios = [['published', published], ['staged', staged.build], ['mixed', mixed]];

    // Orthogonality is unnecessary, but the corpus includes distinct directions rather than scalar multiples.
    for (const [i, { id }] of documents.entries()) for (const other of documents.slice(i + 1)) {
        assert.ok(Math.abs(referenceSimilarity(values[id], values[other.id])) < 0.99999);
    }

    const expectedByMap = new Map(scenarios.map(([name, index]) => [name, Object.fromEntries(documents.map(({ id }) =>
        [id, Object.hasOwn(index.vectors[id], 'vectorF32LE') ? values[id].map(Math.fround) : values[id]]))]));
    for (const [queryNumber, query] of queries.entries()) {
        const text = words[queryNumber % 8] + ' ' + words[(queryNumber + 3) % 8];
        for (const mode of ['semantic', 'hybrid', 'keyword']) {
            const settings = { ...options, mode };
            const original = actualRanking(documents, text, query, allNumeric, settings);
            verifyRanking(original, oracleRanking(documents, text, query, values, settings));
            assert.equal(original.length, topSize);
            for (const [map, index] of scenarios) {
                const expected = oracleRanking(documents, text, query, expectedByMap.get(map), settings);
                const actual = actualRanking(documents, text, query, index.vectors, settings);
                verifyRanking(actual, expected);
                assert.deepEqual(ids(actual), ids(original), 'Separated ranks shifted at query ' + queryNumber + ' on ' + map);
                emitRanking(t, 'separated', map, queryNumber, mode, original, actual, expected);
            }
        }
    }
});

test('near ties and strict similarity thresholds use rounded documents and unchanged provider queries', t => {
    const documents = [document('event:a', 'ferry'), document('event:z', 'harbour')];
    const settings = { ...options, mode: 'semantic', minSimilarity: 0 };
    const scenarios = [
        { name: 'provider-double', query: [1 + 2 ** -25, 1], values: [[0, 1], [1, 0]], winner: 'event:z' },
        { name: 'document-rounding', query: [1, 0], values: [[1, 1 + 2 ** -25], [1 + 2 ** -25, 1]], winner: 'event:a' },
    ];
    for (const { name, query, values, winner } of scenarios) {
        const exact = Object.fromEntries(documents.map((doc, i) => [doc.id, values[i]]));
        const rounded = Object.fromEntries(documents.map((doc, i) => [doc.id, values[i].map(Math.fround)]));
        const legacy = Object.fromEntries(documents.map((doc, i) => [doc.id, { textHash: hash(doc.searchText), vector: values[i] }]));
        const compact = Object.fromEntries(documents.map((doc, i) => [doc.id, compactEntry(hash(doc.searchText), values[i])]));
        const original = actualRanking(documents, 'ferry', query, legacy, settings);
        const expected = oracleRanking(documents, 'ferry', query, rounded, settings);
        const actual = actualRanking(documents, 'ferry', query, compact, settings);
        verifyRanking(original, oracleRanking(documents, 'ferry', query, exact, settings));
        verifyRanking(actual, expected);
        assert.equal(actual[0].id, winner);
        if (name === 'provider-double') {
            assert.notEqual(winner, oracleRanking(documents, 'ferry', query.map(Math.fround), rounded, settings)[0].id);
        } else {
            assert.notEqual(original[0].id, winner);
            const middle = (original[0].similarity + actual[0].similarity) / 2;
            assert.ok(original[0].similarity > middle && middle > actual[0].similarity);
            const threshold = { ...settings, minSimilarity: middle };
            assert.deepEqual(ids(actualRanking(documents, 'ferry', query, legacy, threshold)), ['event:z']);
            assert.deepEqual(actualRanking(documents, 'ferry', query, compact, threshold), []);
            assert.deepEqual(actualRanking(documents, 'ferry', query, compact,
                { ...settings, minSimilarity: actual[0].similarity }), []);
            emitRanking(t, 'threshold', 'published', name, 'semantic',
                actualRanking(documents, 'ferry', query, legacy, threshold), [], []);
        }
        emitRanking(t, 'near-tie', 'published', name, 'semantic', original, actual, expected);
    }
    const keyword = hybridCandidates(documents, 'ferry', undefined, {}, topSize, { ...settings, mode: 'semantic' });
    assert.deepEqual(keyword.map(row => row.id), ['event:a']);
});

function archiveWithSources() {
    const state = newState(locator);
    syncSources(state, ['The ferry arrived', 'The pier needed repair', 'The lantern flickered', 'The market opened']
        .map((mes, i) => ({ name: 'Mara', is_user: false, mes, send_date: i + 1 })));
    return state;
}

test('re-index preserves compact and legacy matches in both maps and still writes provider arrays', async () => {
    for (const staged of [false, true]) {
        const state = archiveWithSources();
        const config = embeddingConfig();
        const version = roleVersion(config, 'embedding');
        const [first, second, third, fourth] = searchDocuments(state, Infinity, config);
        const compact = { ...compactEntry(hash(first.searchText), [0.123456789, 1]), origin: { kept: true } };
        const legacy = { textHash: hash(second.searchText), vector: [0.123456789, 0.8] };
        const index = { version, pending: true, vectors: { [first.id]: compact, [second.id]: legacy,
            [third.id]: { ...compactEntry(hash(third.searchText), [1, 2]), vectorF32LE: 'bad' },
            [fourth.id]: compactEntry(hash('old text'), [1, 2]) } };
        state.index = staged ? { version: 'older', vectors: {}, pending: true, build: index } : index;
        assert.equal(searchableVectorDimension([first, second], index, config), 2);
        assert.equal(searchableVectorDimension([first], { ...index, version: 'older' }, config), undefined);
        const calls = [];
        const nextVector = [0.4388888888888, 0.7];
        const result = await updateIndex(state, {}, config, { limit: 1, embedFn: (_dirs, _config, texts) => {
            calls.push(...texts);
            return { vectors: [nextVector], usage: { requests: 1 } };
        } });
        assert.deepEqual(calls, [third.searchText]);
        assert.equal(result.remaining, 1);
        const saved = staged ? state.index.build.vectors : state.index.vectors;
        assert.strictEqual(saved[first.id], compact);
        assert.strictEqual(saved[second.id], legacy);
        assert.deepEqual(result.paid[third.id], { textHash: hash(third.searchText), vector: nextVector });
        assert.strictEqual(saved[third.id], result.paid[third.id]);
        assert.equal(saved[fourth.id], undefined);
    }
});

test('merge chooses compatible entries from published and staged maps and skips stale, wrong-width and disallowed entries', () => {
    const state = archiveWithSources();
    const config = embeddingConfig();
    const version = roleVersion(config, 'embedding');
    const [first, second, third, fourth] = searchDocuments(state, Infinity, config);
    const compact = compactEntry(hash(first.searchText), [1, 0.2]);
    const legacy = { textHash: hash(second.searchText), vector: [0.75, 0.25] };
    const updatedFirst = compactEntry(hash(first.searchText), [0.25, 0.75]);
    const actual = mergeVectorIndex(state, config, [
        { version, vectors: { [first.id]: compact } },
        { version: 'old', vectors: {}, build: { version, vectors: {
            [first.id]: updatedFirst, [second.id]: legacy, [third.id]: compactEntry(hash(third.searchText), [1]),
            [fourth.id]: compactEntry(hash('changed source'), [0.5, 0.25]), 'nonexistent': legacy,
        } } },
    ]);
    assert.deepEqual(actual, { version, remaining: 2, vectors: { [first.id]: updatedFirst, [second.id]: legacy } });
    assert.strictEqual(actual.vectors[first.id], updatedFirst);
    assert.strictEqual(actual.vectors[second.id], legacy);
    const disallowed = embeddingConfig();
    disallowed.roles.embedding.allowedData = [];
    assert.deepEqual(mergeVectorIndex(state, disallowed, [{ version, vectors: { [first.id]: compact } }]).vectors, {});
});

test('the store continues to read and persist mixed entries opaquely in the reader stage', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mewmory-vector-reader-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directories = { root };
    const archive = statePath(directories, locator);
    const state = newState(locator);
    const compact = { ...compactEntry('fixture', [0.2, 0.3]), metadata: { v: 1 } };
    const legacy = { textHash: 'legacy', vector: [1.00000001, 2] };
    state.index.vectors = { compact, legacy };
    state.index.build = { version: 'fixture', vectors: { legacy } };
    writeJson(archive, state);
    const before = readStateShared(directories, locator);
    const cloned = readState(directories, locator);
    cloned.index.vectors.compact.metadata.v = 2;
    assert.deepEqual(before.index.vectors.compact, compact);
    assert.deepEqual(before.index.vectors.legacy, legacy);
    mutateState(directories, locator, current => { current.reviewedAt = 51; });
    const saved = JSON.parse(fs.readFileSync(archive, 'utf8'));
    assert.equal(saved.reviewedAt, 51);
    assert.deepEqual(saved.index, state.index);
});
