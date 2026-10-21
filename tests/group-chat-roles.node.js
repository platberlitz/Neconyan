import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { read } from '../src/character-card-parser.js';
import { getGroupMemberRole, buildNarratorReminder } from '../public/scripts/group-chat-roles.js';

test('any member can be a narrator and explicit group roles override the bundled card', () => {
    const character = { avatar: 'kit', data: { extensions: { neconyan_group_role: 'narrator' } } };
    assert.equal(getGroupMemberRole({}, character), 'narrator');
    assert.equal(getGroupMemberRole({ member_roles: { kit: 'character' } }, character), 'character');
    assert.equal(getGroupMemberRole({ member_roles: { kit: 'narrator' } }, { avatar: 'kit' }), 'narrator');
    assert.equal(getGroupMemberRole({}, { avatar: 'mira' }), 'character');
    assert.match(buildNarratorReminder('Alex'), /Never decide Alex's words, thoughts or actions/);
});

test('the bundled Narrator card is indexed and its shipped PNG matches the editable card', () => {
    const root = new URL('../default/content/', import.meta.url);
    const card = JSON.parse(readFileSync(new URL('characters/Narrator.json', root)));
    const shipped = JSON.parse(read(readFileSync(new URL('characters/Narrator.png', root))));
    const index = JSON.parse(readFileSync(new URL('index.json', root)));
    assert.ok(index.some(item => item.filename === 'characters/Narrator.png' && item.type === 'character'));
    for (const key of Object.keys(card.data)) assert.deepEqual(shipped.data[key], card.data[key]);
    assert.equal(getGroupMemberRole({}, { ...shipped, avatar: 'Narrator.png' }), 'narrator');
});
