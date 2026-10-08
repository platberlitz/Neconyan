import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';
import { withRoleplayAccount, roleplayLease, saveRoleplayAccount } from '../src/roleplay-store.js';
import { ensureDefaultNotebookLocked, createNoteLocked } from '../src/notebooks/store.js';
import { searchAccount } from '../src/account-search.js';

function setup(t, owner = 'search-owner') {
    const f = fixture(t, false, owner);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    const run = callback => withRoleplayAccount(f.scope, f.scope, callback);
    const notebook = run(lease => ensureDefaultNotebookLocked(lease));
    run(lease => createNoteLocked(lease, { operationId: 'search:seed', notebookId: notebook.id, title: 'Moonlight notebook', text: 'A sapphire dragon.' }));
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Moonlight.json'), JSON.stringify({ entries: {
        0: { comment: 'Moonlight legend', key: ['sapphire'], content: 'The dragon sleeps.' },
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({ power_user: {
        personas: { 'user.png': 'Moonlight traveller' }, persona_descriptions: { 'user.png': { description: 'A sapphire traveller.' } },
    }, extension_settings: { neconyan_conversation: { characters: { 'persona:user.png:Nova.png': { branches: {
        main: { name: 'Moonlight conversation', messages: [{ mes: 'A sapphire hello.' }], createdAt: 123 },
    } } } } } }));
    return f;
}

test('search covers saved libraries and all chat text with the same fuzzy rules', async t => {
    const f = setup(t);
    const results = await searchAccount(f.scope, 'moonligt');
    assert.deepEqual(new Set(results.results.map(result => result.kind)), new Set(['persona', 'chat', 'lorebook', 'lore', 'note']));
    assert.deepEqual(results.unavailable, []);
    const character = await searchAccount(f.scope, 'nova');
    assert.ok(character.results.some(result => result.kind === 'character' && result.target.avatar === 'Nova.png'));
    const swipe = await searchAccount(f.scope, 'other');
    assert.ok(swipe.results.some(result => result.target.locator?.chat === 'Source'));
    assert.ok((await searchAccount(f.scope, 'saphire')).results.some(result => result.kind === 'note'));
});

test('search never reads another account or follows symlinks, and reports unreadable content', async t => {
    const first = setup(t, 'one');
    const second = setup(t, 'two');
    fs.writeFileSync(path.join(second.scope.directories.worlds, 'Private.json'), JSON.stringify({ entries: { 0: { content: 'unfindablesecret' } } }));
    fs.symlinkSync(path.join(second.scope.directories.worlds, 'Private.json'), path.join(first.scope.directories.worlds, 'Link.json'));
    assert.equal((await searchAccount(first.scope, 'unfindablesecret')).total, 0);
    fs.writeFileSync(path.join(first.scope.directories.worlds, 'Broken.json'), '{');
    assert.ok((await searchAccount(first.scope, 'moonlight')).unavailable.includes('Lorebooks'));
});

test('pagination reaches all matches and a new search reflects deletions and edits', async t => {
    const f = setup(t);
    const filename = path.join(f.scope.directories.worlds, 'Many.json');
    fs.writeFileSync(filename, JSON.stringify({ entries: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [i, { comment: `Pagination ${i}`, content: 'pagination' }])) }));
    const ids = new Set();
    let offset = 0;
    do {
        const page = await searchAccount(f.scope, 'pagination', { offset });
        for (const result of page.results) { assert.ok(!ids.has(result.id)); ids.add(result.id); }
        offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(ids.size, 65);
    fs.unlinkSync(filename);
    assert.equal((await searchAccount(f.scope, 'pagination')).total, 0);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(searchAccount(f.scope, 'moonlight', { signal: controller.signal }), { name: 'AbortError' });
});

test('an account reset during a search invalidates the entire response', async t => {
    const f = setup(t);
    const pending = searchAccount(f.scope, 'nova');
    withRoleplayAccount(f.scope, f.scope, lease => {
        roleplayLease(lease).state.dataEpoch++;
        saveRoleplayAccount(lease);
    });
    await assert.rejects(pending, { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
});

test('saved chat targets preserve identity, story mode and group ownership', async t => {
    const solo = setup(t);
    const source = solo.source();
    const records = fs.readFileSync(solo.filename, 'utf8').split('\n').map(line => JSON.parse(line));
    records[0].chat_metadata.story_mode = { enabled: true };
    fs.writeFileSync(solo.filename, records.map(row => JSON.stringify(row)).join('\n'));
    const result = (await searchAccount(solo.scope, 'other')).results.find(item => item.kind === 'chat');
    assert.equal(result.target.mode, 'story');
    assert.equal(result.target.sourceId, source.instanceId);
    assert.deepEqual(result.target.locator, solo.locator);
    const group = fixture(t, true, 'group-search');
    const grouped = (await searchAccount(group.scope, 'other')).results.find(item => item.kind === 'chat');
    assert.deepEqual(grouped.target.locator, group.locator);
    assert.equal(grouped.target.groupId, 'group');
    fs.writeFileSync(path.join(group.scope.directories.groups, 'ambiguous.json'), JSON.stringify({ id: 'other', chats: ['Source'] }));
    const ambiguous = await searchAccount(group.scope, 'other');
    assert.ok(ambiguous.results.find(item => item.kind === 'chat').target.orphan);
    assert.ok(ambiguous.unavailable.includes('Ambiguous group chats'));
});
