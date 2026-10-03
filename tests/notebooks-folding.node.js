import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headingSections, splitNoteFrontmatter, topLevelSections } from '../public/scripts/notebooks/folding.js';
import { EditorState } from '@codemirror/state';
import { codeFolding } from '@codemirror/language';
import { history, undo, undoDepth } from '@codemirror/commands';
import { editorHeadings, foldedHeadingKeys, headingFoldTransaction, revealFoldedSelectionTransaction } from '../public/notes-editor.js';

test('a byte-order marker without properties does not hide the first heading', () => {
    const text = '\uFEFF# First\r\nBody\r\n';
    const [heading] = headingSections(text);
    assert.equal(heading.text, 'First');
    assert.equal(heading.offset, 0);
    assert.equal(text.slice(heading.from), '\r\nBody\r\n');
    assert.equal(heading.to, text.length);
});

test('folding skips properties with the same whitespace-delimited markers accepted by the store', () => {
    const source = '--- \t\r\n# Not a heading\r\n... \t\r\n# Real\r\nBody\r\n';
    assert.deepEqual(headingSections(source).map(heading => heading.text), ['Real']);
});

test('empty properties and ordinary separators keep their exact source boundaries', () => {
    const source = '\uFEFF--- \t\r\n--- \t\r\n# Actual\r\nBody';
    const split = splitNoteFrontmatter(source);
    assert.equal(split.hasFrontmatter, true);
    assert.equal(split.frontmatter, '');
    assert.equal(split.body, '# Actual\r\nBody');
    assert.equal(source.slice(split.bodyStart), split.body);
    const ordinary = 'Introductory paragraph\n\n---\n# Heading\n';
    assert.equal(splitNoteFrontmatter(ordinary).body, ordinary);
});

test('heading folds exclude properties and fenced code, and stop at the next peer heading', () => {
    const source = '---\ntitle: Notes\n# Not a heading\n---\n# One\nBody\n## Child\nChild body\n```md\n# Not either\n```\n### Deep\nDeep body\n# Two\nLast body\n';
    const headings = headingSections(source);
    assert.deepEqual(headings.map(item => [item.level, item.text]), [[1, 'One'], [2, 'Child'], [3, 'Deep'], [1, 'Two']]);
    assert.equal(headings[0].end, source.indexOf('# Two'));
    assert.equal(source.slice(headings[0].from, headings[0].to).includes('Deep body'), true);
    assert.equal(source.slice(headings[0].to).startsWith('\n# Two'), true);
    assert.deepEqual(topLevelSections(headings).map(item => item.text), ['One', 'Two']);
});

test('heading positions preserve exact CRLF, BOM and UTF-16 offsets without changing source bytes', () => {
    const source = '\uFEFF---\r\ntitle: Cat\r\n---\r\n# Cat 🐈\r\nBody\r\n## Child\r\nChild body\r\n# End\r\nFinal';
    const before = Buffer.from(source);
    const headings = headingSections(source);
    assert.equal(headings[0].offset, source.indexOf('# Cat'));
    assert.equal(headings[0].from, source.indexOf('\r\nBody'));
    assert.equal(source.slice(headings[0].to).startsWith('\r\n# End'), true);
    assert.deepEqual(Buffer.from(source), before);
});

test('Setext headings and duplicate nested headings have distinct stable identities', () => {
    const source = 'Title\n=====\nBody\n## Same\nFirst\n## Same\nSecond\n# Next\n## Same\nThird';
    const headings = headingSections(source);
    assert.equal(headings[0].level, 1);
    assert.equal(source.slice(0, headings[0].from), 'Title\n=====');
    assert.equal(new Set(headings.map(item => item.key)).size, headings.length);
    const shifted = headingSections('Introductory paragraph\n\n' + source);
    assert.deepEqual(shifted.map(item => item.key), headings.map(item => item.key));
});

test('indented code, quoted headings and an unclosed code fence are not fold controls', () => {
    const source = '    # Code\n> # Quote\n# Real\nBody\n~~~~\n# Still code\n';
    assert.deepEqual(headingSections(source).map(item => item.text), ['Real']);
    assert.deepEqual(headingSections('# Empty\n# Empty too').map(item => item.to > item.from), [false, false]);
});

test('fold effects preserve the full document, backwards selection and undo history even around the caret', () => {
    const source = '# One\nBody with a caret\n## Child\nMore words\n# Two\nLast words';
    let state = EditorState.create({ doc: source, selection: { anchor: 20, head: 9 }, extensions: [history(), codeFolding()] });
    state = state.update({ changes: { from: state.doc.length, insert: '!' } }).state;
    const selection = state.selection.toJSON();
    const depth = undoDepth(state);
    const headings = editorHeadings(state);
    state = state.update(headingFoldTransaction(state, [headings[0].key])).state;
    assert.equal(state.doc.toString(), source + '!');
    assert.deepEqual(state.selection.toJSON(), selection);
    assert.equal(undoDepth(state), depth);
    assert.deepEqual(foldedHeadingKeys(state), [headings[0].key]);
    state = state.update(headingFoldTransaction(state, [])).state;
    assert.deepEqual(state.selection.toJSON(), selection);
    assert.equal(undoDepth(state), depth);
    assert.equal(undo({ state, dispatch: transaction => { state = transaction.state; } }), true);
    assert.equal(state.doc.toString(), source);
});

test('heading folds support both frontmatter endings and keep identities compact in long notes', () => {
    const source = '---\ntitle: Title\n...\n' + Array.from({ length: 4000 }, (_, index) => `## Heading ${index}\nParagraph ${index}\n`).join('');
    const headings = headingSections(source);
    assert.equal(headings.length, 4000);
    assert.equal(headings.every(heading => /^h_[a-f0-9]{16}$/.test(heading.key)), true);
    assert.equal(new Set(headings.map(heading => heading.key)).size, 4000);
});

test('preparing input reveals every containing fold without moving the caret, changing text or adding undo steps', () => {
    const source = '# One\nParent body\n## Child\nChild body\n# Two\nLast words';
    const caret = source.indexOf('Child body') + 4;
    let state = EditorState.create({ doc: source, selection: { anchor: caret }, extensions: [history(), codeFolding()] });
    state = state.update({ changes: { from: state.doc.length, insert: '!' } }).state;
    const headings = editorHeadings(state);
    state = state.update(headingFoldTransaction(state, headings.map(heading => heading.key))).state;
    assert.equal(foldedHeadingKeys(state).length, 3);
    const selection = state.selection.toJSON();
    const depth = undoDepth(state);
    state = state.update(revealFoldedSelectionTransaction(state)).state;
    assert.equal(state.doc.toString(), source + '!');
    assert.deepEqual(state.selection.toJSON(), selection);
    assert.equal(undoDepth(state), depth);
    assert.deepEqual(foldedHeadingKeys(state), [headings[2].key]);
    assert.equal(revealFoldedSelectionTransaction(state), null);
});
