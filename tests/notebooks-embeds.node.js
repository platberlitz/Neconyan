/* global globalThis */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEntry } from '../src/notebooks/note-index.js';
import { buildNoteEmbeds, EMBED_LIMITS, resolveEmbedRegion } from '../src/notebooks/embeds.js';

let counter = 0;
function entry(path, text) {
    return buildEntry(`n_${(++counter).toString(16).padStart(16, '0')}`, path, text, 'revision');
}
const preview = (entries, source, extra = {}) => buildNoteEmbeds(entries, { sourceId: source.id, canRead: () => true, ...extra });

test('whole notes, nested headings, Setext headings and paragraph/list blocks render exact saved regions', () => {
    const target = entry('Folder/Target.md', '---\r\ntitle: Target\r\n---\r\n# One\r\nFirst.\r\n## Child\r\nChild body.\r\n\r\nParagraph first\r\nsecond line. ^block\r\n\r\n- list one\r\n- list two\r\n\r\n^list\r\n\r\n# Two\r\nLast.\r\n');
    const source = entry('Home.md', '![[Target]]\n![[Target#One/Child]]\n![[Target#^block]]\n![[Target#^list]]');
    const nodes = preview([source, target], source).embeds;
    assert.equal(nodes.length, 4);
    assert.ok(nodes.every(node => node.status === 'rendered' && node.noteId === target.id));
    assert.equal(nodes[0].text, target.text.slice(target.text.indexOf('# One')));
    assert.equal(nodes[1].text, target.text.slice(target.text.indexOf('## Child'), target.text.indexOf('# Two')));
    assert.equal(nodes[2].text, 'Paragraph first\r\nsecond line.');
    assert.match(nodes[3].text, /^- list one\r\n- list two/);
    assert.doesNotMatch(nodes[3].text, /\^list/);
    assert.equal(resolveEmbedRegion('Setext\n====\nBody.\n\nNext\n----\nOther.', 'Setext').text, 'Setext\n====\nBody.\n\nNext\n----\nOther.');
    assert.equal(resolveEmbedRegion('# Heading ^head\nHeading body.\n# Next\nNo.', '^head').text, '# Heading\nHeading body.\n');
});

test('hidden notes and nonexistent notes have the same generic projection without title, id, count or text', () => {
    const source = entry('Home.md', '![[Private]]\n![[Missing]]\n![[Target]]');
    const hidden = entry('Private.md', 'Secret hidden body.');
    const hiddenDuplicate = entry('Private/Target.md', 'Secret duplicate.');
    const visible = entry('Allowed/Target.md', 'Visible body.');
    const result = preview([source, hidden, hiddenDuplicate, visible], source, { canRead: note => note === source || note === visible });
    const stripPosition = ({ start, end, ...node }) => node;
    assert.deepEqual(stripPosition(result.embeds[0]), stripPosition(result.embeds[1]));
    assert.equal(result.embeds[2].noteId, visible.id, 'a hidden duplicate never creates ambiguity');
    assert.doesNotMatch(JSON.stringify(result), /Secret|Private\.md|Private\/Target/);
    const unavailable = buildNoteEmbeds([source, hidden], { sourceId: source.id, canRead: () => false });
    assert.deepEqual(unavailable, buildNoteEmbeds([], { sourceId: source.id, canRead: () => false }));
    assert.throws(() => buildNoteEmbeds([source], { sourceId: source.id }), TypeError);
});

test('missing and ambiguous headings or block ids do not fall back to a whole note', () => {
    for (const fragment of ['Absent', '^absent', 'Repeated', '^same']) {
        assert.equal(resolveEmbedRegion('# Repeated\nBody ^same\n# Repeated\nBody ^same', fragment), null);
    }
    assert.equal(resolveEmbedRegion('```md\n# Hidden\nText ^secret\n```\n<!--\n# Also hidden\nText ^secret\n-->\n# Real\nBody.', 'Hidden'), null);
    assert.equal(resolveEmbedRegion('```md\nText ^secret\n```', '^secret'), null);
});

test('heading selectors preserve BOM boundaries and literal slashes without guessing between duplicate regions', () => {
    const source = '\uFEFF# First ^first\r\nFirst body.\r\n# Last\r\nLast body.';
    assert.equal(resolveEmbedRegion(source, 'First')?.text, '# First ^first\r\nFirst body.\r\n');
    assert.equal(resolveEmbedRegion(source, '^first')?.text, '# First\r\nFirst body.\r\n');
    assert.equal(resolveEmbedRegion('# A/B\nLiteral slash body.\n# Next\nOther.', 'A/B')?.text, '# A/B\nLiteral slash body.\n');
    assert.equal(resolveEmbedRegion('# A B\nCase-insensitive slug body.', 'A-B')?.text, '# A B\nCase-insensitive slug body.');
    assert.equal(resolveEmbedRegion('# A/B\nLiteral.\n# A\n## B\nNested.', 'A/B'), null);
});

test('cycles, nested regions and depth limits never recurse without a bound', () => {
    const a = entry('A.md', '# One\n![[B]]');
    const b = entry('B.md', '![[A#One]]');
    const result = preview([a, b], a);
    assert.equal(result.embeds[0].embeds[0].embeds[0].status, 'limited');
    assert.equal(result.limited, true);
    const chain = Array.from({ length: 10 }, (_, index) => entry(`Link${index}.md`, `![[Link${index + 1}]]`));
    const deep = preview(chain, chain[0]);
    let node = deep.embeds[0];
    let depth = 1;
    while (node.embeds?.length) { node = node.embeds[0]; depth++; }
    assert.equal(node.status, 'limited');
    assert.equal(depth, EMBED_LIMITS.depth + 1);
});

test('embed count, per-note UTF-8 bytes and the complete JSON response are bounded', () => {
    const target = entry('Target.md', '🙂'.repeat(EMBED_LIMITS.noteBytes / 4 + 1));
    const source = entry('Home.md', Array(200).fill('![[Target]]').join('\n'));
    const result = preview([source, target], source);
    assert.equal(result.embeds.length, EMBED_LIMITS.count);
    assert.equal(result.limited, true);
    assert.ok(result.embeds.every(node => node.status === 'limited'));
    const medium = entry('Medium.md', 'x'.repeat(60 * 1024));
    const many = preview([source, medium], source, { text: Array(100).fill('![[Medium]]').join('\n') });
    assert.ok(Buffer.byteLength(JSON.stringify(many)) <= EMBED_LIMITS.totalBytes);
    assert.ok(many.embeds.some(node => node.status === 'limited'));
});

test('preview does not execute or expand code, escaped references or property values', () => {
    const target = entry('Target.md', '<script>globalThis.secret = true</script>\nSaved target.');
    const text = '---\nproperty: "![[Target]]"\n---\n`![[Target]]`\n\\![[Target]]\n```\n![[Target]]\n```\n![[Target]]';
    const source = entry('Home.md', text);
    const result = preview([source, target], source);
    assert.equal(result.embeds.length, 1);
    assert.equal(result.embeds[0].text, target.text, 'HTML remains data for the browser sanitiser');
    assert.equal(source.text, text);
    assert.equal(globalThis.secret, undefined);
});

test('relative links resolve from each embedded note, and an unsaved root never rewrites target bytes', () => {
    const source = entry('Home.md', 'Saved root.');
    const parent = entry('Folder/Parent.md', '![[./Child]]');
    const child = entry('Folder/Child.md', 'Saved child.');
    const wrong = entry('Elsewhere/Child.md', 'Wrong child.');
    const result = preview([source, parent, child, wrong], source, { text: 'Unsaved root.\n![[Folder/Parent]]' });
    assert.equal(result.embeds[0].embeds[0].noteId, child.id);
    assert.equal(result.embeds[0].embeds[0].text, child.text);
    assert.equal(source.text, 'Saved root.');
});
