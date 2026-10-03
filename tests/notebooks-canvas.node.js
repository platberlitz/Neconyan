import assert from 'node:assert/strict';
import test from 'node:test';
import { CANVAS_LIMITS, canvasFilePath, changeCanvasDocument, parseCanvasDocument, serializeCanvasDocument, validateCanvasDocument } from '../public/scripts/notebooks/canvas-format.js';
import { CANVAS_PREVIEW_BYTES, projectCanvas } from '../src/notebooks/canvas-projection.js';
import { buildEntry } from '../src/notebooks/note-index.js';
import { sha256 } from '../src/notebooks/paths.js';

const node = (id, type = 'text', extra = {}) => ({ id, type, x: 0, y: 0, width: 320, height: 180, ...(type === 'text' ? { text: 'A text card.' } : {}), ...extra });
const note = (id, path, text) => buildEntry(`n_${id.toString(16).padStart(16, '0')}`, path, text, sha256(text));

test('saved and downloaded JSON stays readable at the exact byte limit and retains existing formatting when it fits', () => {
    const overhead = Buffer.byteLength(JSON.stringify({ future: '' }));
    const exact = { future: 'x'.repeat(CANVAS_LIMITS.bytes - overhead) };
    const text = serializeCanvasDocument(exact);
    assert.equal(Buffer.byteLength(text), CANVAS_LIMITS.bytes);
    assert.deepEqual(parseCanvasDocument(text), exact);
    const document = { future: { keep: true }, nodes: [] };
    const formatted = serializeCanvasDocument(document, '\uFEFF{\r\n    "nodes": []\r\n}\r\n');
    assert.ok(formatted.startsWith('\uFEFF{\r\n    "future"'));
    assert.deepEqual(parseCanvasDocument(formatted), document);
});

test('JSON Canvas 1.0 fields and unknown data survive normal card and connection edits', () => {
    const original = parseCanvasDocument(JSON.stringify({ plugin: { nested: [true, 'kept'], custom: { constructor: 'data' } }, nodes: [
        node('group', 'group', { label: 'Plans', background: 'assets/background.png', backgroundStyle: 'ratio', width: 800, height: 500, vendor: { keep: true } }),
        node('text', 'text', { text: '# Read-only Markdown\n<script>Never run.</script>', color: '#aBcDeF', extra: ['one', 2] }),
        node('note', 'file', { file: 'Notes/Source.md', subpath: '#Heading', color: '1', customData: { retained: 3 } }),
        node('url', 'link', { url: 'https://example.invalid/', color: '6' }),
        node('future', 'future-plugin-card', { opaque: { stays: 'unchanged' } }),
    ], edges: [{ id: 'edge', fromNode: 'text', toNode: 'note', fromSide: 'bottom', toSide: 'top', fromEnd: 'arrow', toEnd: 'none',
        label: 'Connection', color: '2', extension: { value: 'kept' } }] }));
    const before = structuredClone(original);
    const changed = changeCanvasDocument(original, [{ type: 'update-node', id: 'text', set: { x: -120, text: 'Updated text.' } },
        { type: 'update-edge', id: 'edge', set: { label: 'Updated connection' } }]);
    assert.deepEqual(original, before);
    assert.deepEqual(changed.plugin, before.plugin);
    assert.deepEqual(changed.nodes[0], before.nodes[0]);
    assert.deepEqual(changed.nodes[1].extra, ['one', 2]);
    assert.deepEqual(changed.nodes[4], before.nodes[4]);
    assert.deepEqual(changed.edges[0].extension, before.edges[0].extension);
    assert.deepEqual(parseCanvasDocument(JSON.stringify(changed)), changed);
    const removed = changeCanvasDocument(changed, [{ type: 'remove-node', id: 'note' }]);
    assert.equal(removed.nodes.length, 4);
    assert.deepEqual(removed.edges, []);
    assert.deepEqual(removed.plugin, before.plugin);
});

test('optional arrays and future fields stay portable rather than being rewritten by reading', () => {
    const minimal = parseCanvasDocument('\uFEFF{"extra":{"__proto__":{"kept":true}}}');
    assert.equal(Object.hasOwn(minimal.extra, '__proto__'), true);
    assert.equal(Object.getPrototypeOf(minimal.extra), Object.prototype);
    assert.equal(Object.hasOwn(minimal, 'nodes'), false);
    const changed = changeCanvasDocument(minimal, [{ type: 'add-node', node: node('new') }]);
    assert.equal(Object.hasOwn(changed, 'edges'), false);
    assert.deepEqual(changed.extra, minimal.extra);
});

test('canvas validation bounds geometry, depth, arrays and unsafe JSON without dropping source data', () => {
    for (const document of [{ nodes: [node('same'), node('same')] }, { nodes: [node('fraction', 'text', { x: 0.5 })] },
        { nodes: [node('size', 'text', { width: -1 })] }, { nodes: [node('colour', 'text', { color: 'url(javascript:bad)' })] },
        { nodes: [node('file', 'file', { file: 'Source.md', subpath: 'No prefix' })] },
        { edges: [{ id: 'bad', fromNode: 'a', toNode: 'b', toEnd: 'execute' }] }, { extra: Number.POSITIVE_INFINITY }]) {
        assert.throws(() => validateCanvasDocument(document), error => error.code === 'CANVAS_INVALID');
    }
    assert.throws(() => parseCanvasDocument('{"extra":9007199254740993}'), /changing its value/);
    assert.throws(() => parseCanvasDocument('x'.repeat(CANVAS_LIMITS.bytes + 1)), error => error.status === 413);
    assert.throws(() => validateCanvasDocument({ nodes: Array.from({ length: 501 }, (_, index) => node(String(index))) }), error => error.status === 413);
    let nested = {};
    for (let index = 0; index < 70; index++) nested = { next: nested };
    assert.throws(() => validateCanvasDocument(nested), error => error.status === 413);
    assert.throws(() => changeCanvasDocument({ nodes: [node('a')] }, [{ type: 'update-node', id: 'a', set: { opaque: 'overwrite' } }]), /could not be applied/);
});

test('file paths stay inside a notebook and support portable root and relative references', () => {
    assert.equal(canvasFilePath('Notes/Source.md', 'Boards/Plan.canvas'), 'Notes/Source.md');
    assert.equal(canvasFilePath('../Notes/Source.md', 'Boards/Plan.canvas'), 'Notes/Source.md');
    assert.equal(canvasFilePath('./Source.md', 'Boards/Plan.canvas'), 'Boards/Source.md');
    for (const path of ['/etc/passwd', '../../other/Secret.md', 'C:\\Secret.md', 'file:///etc/passwd', '.obsidian/settings.json']) {
        assert.equal(canvasFilePath(path, 'Boards/Plan.canvas'), null);
    }
});

test('note cards filter permissions before resolution, excerpts and headings, without granting linked access', () => {
    const publicNote = note(1, 'Notes/Public.md', '---\ntitle: Public note\n---\n# Heading\nAllowed excerpt.\n![[Secret]]\n');
    const privateNote = note(2, 'Notes/Secret.md', '# Secret\nNEVER DISCLOSE THIS BODY.\n');
    const document = { nodes: [node('visible', 'file', { file: 'Notes/Public.md', subpath: '#Heading' }),
        node('hidden', 'file', { file: 'Notes/Secret.md' }), node('missing', 'file', { file: 'Notes/Missing.md' }),
        node('bad-heading', 'file', { file: 'Notes/Public.md', subpath: '#Missing' })] };
    const projection = projectCanvas(document, [publicNote, privateNote], { canRead: entry => entry.id === publicNote.id });
    assert.equal(projection.nodes[0].noteId, publicNote.id);
    assert.match(projection.nodes[0].excerpt, /Allowed excerpt/);
    assert.match(projection.nodes[0].excerpt, /!\[\[Secret\]\]/);
    assert.deepEqual({ ...projection.nodes[1], id: 'same' }, { ...projection.nodes[2], id: 'same' });
    assert.equal(projection.nodes[3].status, 'unavailable');
    assert.doesNotMatch(JSON.stringify(projection), /NEVER DISCLOSE|Notes\/Secret|n_0000000000000002/);
    assert.throws(() => projectCanvas(document, [publicNote]), TypeError);
    assert.deepEqual(projectCanvas(document, [publicNote], { canRead: entry => entry.id === publicNote.id }), projection);
});

test('canvas data never executes links, HTML, group backgrounds or unsupported cards', () => {
    const document = { nodes: [node('text', 'text', { text: '<script>active()</script>' }),
        node('link', 'link', { url: 'javascript:active()' }), node('group', 'group', { label: '<img onerror="active()">', background: 'https://example.invalid/image.png' }),
        node('future', 'plugin', { command: 'active()' })], edges: [{ id: 'edge', fromNode: 'text', toNode: 'link' }] };
    const projection = projectCanvas(document, [], { canRead: () => false });
    assert.equal(projection.nodes[0].excerpt, '<script>active()</script>');
    assert.equal(projection.nodes[1].status, 'unavailable');
    assert.equal(Object.hasOwn(projection.nodes[1], 'url'), false);
    assert.equal(Object.hasOwn(projection.nodes[2], 'background'), false);
    assert.equal(Object.hasOwn(projection.nodes[3], 'command'), false);
    assert.equal(projection.edges[0].fromEnd, 'none');
    assert.equal(projection.edges[0].toEnd, 'arrow');
});

test('edited documents and complete preview metadata obey their byte limits', () => {
    assert.throws(() => validateCanvasDocument({ extra: '🐱'.repeat(600000) }), error => error.status === 413);
    assert.throws(() => changeCanvasDocument({ nodes: [node('text')] }, [{ type: 'update-node', id: 'text', set: { text: '🐱'.repeat(600000) } }]), error => error.status === 413);
    const nodes = Array.from({ length: 500 }, (_, index) => node(`card-${String(index).padStart(3, '0')}-${'x'.repeat(110)}`));
    const edges = Array.from({ length: 2000 }, (_, index) => ({ id: `edge-${index}-${'x'.repeat(100)}`, fromNode: nodes[index % 500].id,
        toNode: nodes[(index + 1) % 500].id, label: '🐱'.repeat(70) }));
    const document = validateCanvasDocument({ nodes, edges });
    assert.ok(Buffer.byteLength(JSON.stringify(document)) < CANVAS_LIMITS.bytes);
    const before = structuredClone(document);
    const preview = projectCanvas(document, [], { canRead: () => false });
    assert.ok(Buffer.byteLength(JSON.stringify(preview)) <= CANVAS_PREVIEW_BYTES);
    assert.ok(preview.limited.edges);
    assert.deepEqual(document, before);
});
