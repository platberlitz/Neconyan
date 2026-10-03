import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { buildEntry } from '../src/notebooks/note-index.js';
import { buildNoteGraph, GRAPH_LIMITS } from '../src/notebooks/graph.js';

const entry = (number, path, text) => buildEntry(`n_${number.toString(16).padStart(16, '0')}`, path, text, `hash-${number}`);
const graph = (entries, options = {}) => buildNoteGraph(entries, { canRead: () => true, ...options });

test('graph visibility is checked before names, ambiguity, edges and totals', () => {
    const source = entry(1, 'Source.md', '[[Target]] ![[Hidden]] [[Missing]]');
    const allowed = entry(2, 'Allowed/Target.md', 'Allowed content');
    const duplicate = entry(3, 'Private/Target.md', 'Private duplicate');
    const hidden = entry(4, 'Hidden.md', 'SECRET CONTENT');
    const canRead = note => note.id === source.id || note.id === allowed.id;
    const visible = graph([source, allowed, duplicate, hidden], { canRead });
    assert.deepEqual(visible, graph([source, allowed], { canRead }));
    assert.equal(visible.total, 2);
    assert.deepEqual(visible.edges, [{ source: source.id, target: allowed.id, references: 1, embedded: false }]);
    for (const value of [duplicate.id, hidden.id, 'Private', 'SECRET CONTENT']) assert.equal(JSON.stringify(visible).includes(value), false);
    assert.throws(() => buildNoteGraph([source]), /visibility/);
    assert.deepEqual(graph([source, hidden], { canRead: () => false }), graph([], { canRead: () => false }));
});

test('folder and hierarchical tag filters do not invent new link resolution', () => {
    const first = entry(1, 'World/First.md', '---\ntags: [world/city]\n---\n[[World/Second]] ![[World/Second#Details]] [[Other/Second]]');
    const second = entry(2, 'World/Second.md', '---\ntags: [world/city]\n---\n[[First]]');
    const duplicate = entry(3, 'Other/Second.md', '---\ntags: [private]\n---\n[[World/First]]');
    const root = entry(4, 'Root.md', '---\ntags: [world]\n---\n[[Second]]');
    const result = graph([first, second, duplicate, root], { folder: 'world', tag: '#WORLD' });
    assert.equal(result.total, 2);
    assert.deepEqual(result.nodes.map(note => note.id), [first.id, second.id]);
    assert.deepEqual(result.edges, [{ source: first.id, target: second.id, references: 3, embedded: true }]);
    const allWorldTags = graph([first, second, duplicate, root], { tag: 'world' });
    assert.equal(allWorldTags.edges.some(edge => edge.source === root.id || edge.target === root.id), false);
    assert.deepEqual(graph([first, second, root], { folder: '' }).nodes.map(note => note.id), [root.id]);
    assert.equal(graph([first, second], { folder: 'World', tag: 'absent' }).total, 0);
});

test('graph nodes and edges are bounded and attachments, external and self links are excluded', () => {
    const entries = Array.from({ length: 400 }, (_, number) => entry(number + 1, `Note ${number.toString().padStart(3, '0')}.md`,
        Array.from({ length: 50 }, (_, target) => `[[Note ${target.toString().padStart(3, '0')}]]`).join(' ') + ' [image](file.png) [web](https://example.invalid) [[#Heading]]'));
    const result = graph(entries, { limit: 100000 });
    assert.equal(result.total, 400);
    assert.equal(result.nodes.length, GRAPH_LIMITS.nodes);
    assert.equal(result.edges.length, GRAPH_LIMITS.edges);
    assert.deepEqual(result.truncated, { nodes: true, edges: true });
    const ids = new Set(result.nodes.map(note => note.id));
    assert.ok(result.edges.every(edge => ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= GRAPH_LIMITS.totalBytes);
    assert.equal(graph(entries, { limit: 2 }).nodes.length, 2);
    assert.deepEqual(graph([]).nodes, []);
});

test('graph metadata and work stay bounded on a real 3000-note index', () => {
    const entries = Array.from({ length: 3000 }, (_, number) => entry(number + 1, `Folder/Note ${number.toString().padStart(4, '0')}.md`,
        `---\ntags: [fixture, world/city]\n---\n# Note ${number}\n[[Note ${((number + 1) % 3000).toString().padStart(4, '0')}]]`));
    const start = performance.now();
    const result = graph(entries);
    const duration = performance.now() - start;
    assert.equal(result.nodes.length, 300);
    assert.equal(result.total, 3000);
    assert.equal(result.edges.length, 299);
    assert.equal(result.truncated.nodes, true);
    assert.ok(duration < 5000, `graph took ${duration}ms`);
    console.log(JSON.stringify({ graphNotes: entries.length, shown: result.nodes.length, edges: result.edges.length, milliseconds: duration }));
    const huge = entries.slice(0, 300).map(note => ({ ...note, title: '猫'.repeat(200), folder: '猫'.repeat(240), path: '猫'.repeat(240), tags: Array(8).fill('猫'.repeat(80)) }));
    assert.ok(Buffer.byteLength(JSON.stringify(graph(huge))) <= GRAPH_LIMITS.totalBytes);
});
