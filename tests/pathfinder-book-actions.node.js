import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

// The protected fixture sets the actual server config path before Node imports.
void fixture;
const { roleplayHash } = await import('../src/roleplay-store.js');
const { applyPathfinderBookAction, searchPathfinderBook } = await import('../src/generation/pathfinder-book-actions.js');

const source = () => ({ entries: {
    1: { uid: 1, comment: 'Location: Hall', content: 'The hall is quiet.', key: ['hall'], extensions: { other: 'untouched' } },
    2: { uid: 2, comment: 'Character: Nova', content: 'Nova waits.', key: ['nova'] },
}, originalData: { entries: [
    { id: 21, comment: 'Location: Hall', content: 'The hall is quiet.', extensions: { imported: true } },
    { id: 22, comment: 'Character: Nova', content: 'Nova waits.', extensions: { imported: true } },
] }, originalDataUidMap: { 1: 0, 2: 1 }, extensions: { importedBook: true }, unusedVendorSetting: { preserve: true } });
const apply = (book, tool, args, callId = tool) => applyPathfinderBookAction(book,
    { bookName: 'Town', tool, args, callId, sourceHash: roleplayHash(book) });

test('remember, update, forget and merge preserve native and imported card fields', () => {
    const first = source();
    const remembered = apply(first, 'pathfinder_remember', { title: 'Place: Garden', content: 'Flowers by the gate.' });
    assert.equal(remembered.book.entries[0].uid, 0);
    assert.deepEqual(remembered.book.entries[0].key, ['place']);
    assert.equal(remembered.book.originalData.entries.length, 3);
    assert.equal(remembered.book.originalData.entries[2].comment, 'Place: Garden');
    assert.deepEqual(first, source());
    const duplicate = apply(remembered.book, 'pathfinder_remember', { title: 'Another place', content: 'Flowers by the gate.' }, 'dedup');
    assert.equal(duplicate.changed, true); // Duplicate detection is an explicit saved setting, not an assumed default.
    const updated = apply(remembered.book, 'pathfinder_update', { uid: '1', title: 'Location: New Hall', content: 'A quiet stone hall.' });
    assert.equal(updated.book.entries[1].extensions.other, 'untouched');
    assert.equal(updated.book.originalData.entries[0].id, 21);
    assert.equal(updated.book.originalData.entries[0].extensions.imported, true);
    assert.equal(updated.book.originalData.entries[0].content, 'A quiet stone hall.');
    const disabled = apply(updated.book, 'pathfinder_forget', { uid: 1, hard_delete: 'no' });
    assert.equal(disabled.book.entries[1].disable, true);
    assert.equal(disabled.book.originalData.entries[0].extensions.imported, true);
    assert.throws(() => apply(disabled.book, 'pathfinder_merge_split', { action: 'merge', uid1: 1, uid2: 2 }), { code: 'PATHFINDER_TOOL_INVALID' });
    const removed = apply(disabled.book, 'pathfinder_forget', { uid: 1, hard_delete: 'YES' });
    assert.equal(removed.book.entries[1], undefined);
    assert.equal(removed.book.originalData.entries.length, 2);
    assert.equal(removed.book.originalDataUidMap[2], 0);
    const merged = apply(source(), 'pathfinder_merge_split', { action: 'merge', uid1: 1, uid2: 2 });
    assert.equal(merged.book.entries[1].content, 'The hall is quiet.\n\n---\n\nNova waits.');
    assert.equal(merged.book.originalData.entries.length, 1);
    assert.equal(merged.book.originalData.entries[0].id, 21);
    assert.equal(merged.book.unusedVendorSetting.preserve, true);
});

test('waypoints use bound deterministic IDs, sync both layouts and refuse unsupported placement', () => {
    const book = source(), hash = roleplayHash(book);
    const root = searchPathfinderBook('Town', book, hash);
    assert.ok(root.children.some(node => node.name === 'Locations'));
    const created = apply(book, 'pathfinder_create_waypoint', { name: 'North Wing', parent_node_id: root.nodeId }, 'accepted-call');
    const layout = created.book.extensions.neconyan_pathfinder;
    assert.deepEqual(layout, created.book.originalData.extensions.neconyan_pathfinder);
    assert.ok(layout.tree.children.some(node => node.name === 'North Wing'));
    const current = searchPathfinderBook('Town', created.book, roleplayHash(created.book));
    const wing = current.children.find(node => node.name === 'North Wing');
    const moved = apply(created.book, 'pathfinder_reorganize', { uid: 1, target_node_id: wing.id });
    assert.ok(moved.book.entries[1].extensions.other === 'untouched');
    assert.equal(moved.book.entries[1].extensions.neconyan_pathfinder.nodeId, wing.id ? layout.tree.children.find(node => node.name === 'North Wing').id : '');
    assert.equal(moved.book.originalData.entries[0].extensions.neconyan_pathfinder.nodeId, moved.book.entries[1].extensions.neconyan_pathfinder.nodeId);
    const corrupted = source();
    corrupted.extensions.neconyan_pathfinder = { version: 2, custom: 'do-not-overwrite' };
    assert.throws(() => apply(corrupted, 'pathfinder_create_waypoint', { name: 'Unsafe' }), { code: 'PATHFINDER_TOOL_INVALID' });
});

test('summaries and splits keep fresh card IDs, selected content and saved waypoint evidence', () => {
    const book = source();
    const summary = apply(book, 'pathfinder_summarize', { title: 'Voyage', arc: 'Aster', significance: 'critical', content: 'The journey changed.' });
    const entry = summary.book.entries[0];
    assert.equal(entry.comment, '[Summary] Voyage: Aster');
    assert.equal(entry.content, 'Significance: critical\n\nThe journey changed.');
    assert.deepEqual(entry.key, ['summary', 'critical']);
    assert.ok(entry.extensions.neconyan_pathfinder.nodeId.startsWith('arc_'));
    const split = apply(source(), 'pathfinder_merge_split', { action: 'split', uid: 1, content1: 'First half.', content2: 'Second half.' });
    assert.equal(split.book.entries[1].content, 'First half.');
    assert.equal(split.book.entries[0].content, 'Second half.');
    assert.notEqual(split.book.originalData.entries[0].id, split.book.originalData.entries[2].id);
    assert.equal(split.book.originalData.entries[2].extensions.imported, true);
    assert.equal(split.book.entries[0].extensions.other, 'untouched');
});
