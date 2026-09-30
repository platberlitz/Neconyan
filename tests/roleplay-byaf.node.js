import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';
import { ByafParser } from '../src/byaf.js';
import { publishByafChat } from '../src/endpoints/characters.js';
import { readRoleplayChat } from '../src/generation/roleplay-source.js';
import { readRoleplayAccount, roleplayPathKey } from '../src/roleplay-store.js';
import { bootstrapRoleplayAccount } from '../src/roleplay-lifecycle.js';
import { roleplayNativeHost } from '../src/endpoints/chats.js';

test('BYAF histories without a creation timestamp retain their messages', () => {
    const rows = ByafParser.getChatFromScenario({ firstMessages: [{ text: 'Greeting' }], messages: [
        { type: 'ai', outputs: [{ text: 'Reply', activeTimestamp: 100 }] },
    ] }, 'User', 'Nova', []).split('\n').map(row => JSON.parse(row));
    assert.equal(rows[1].mes, 'Greeting');
    assert.ok(Number.isFinite(Date.parse(rows[1].send_date)));
    assert.equal(rows[2].mes, 'Reply');
});

test('BYAF scenarios create recorded chats and refuse occupied names', t => {
    const f = fixture(t);
    const request = { user: { profile: { handle: 'fixture' }, directories: f.scope.directories } };
    const chat = ByafParser.getChatFromScenario({ title: 'BYAF', firstMessages: [{ text: 'Hello' }], messages: [] }, 'User', 'Nova', []);
    const result = publishByafChat(request, 'Nova', 'BYAF.jsonl', chat);
    const locator = { group: false, avatar: 'Nova.png', chat: 'BYAF' };
    const saved = readRoleplayChat(f.scope, locator);
    assert.equal(result.mode, 'create');
    assert.equal(saved.records[1].mes, 'Hello');
    assert.equal(saved.records[0].chat_metadata.neconyan_roleplay.instanceId, saved.instanceId);
    const state = readRoleplayAccount(f.scope);
    assert.equal(state.paths[roleplayPathKey(state, 'chat', locator)].instanceId, saved.instanceId);
    assert.equal(Object.keys(state.submissions).length, 0);
    assert.throws(() => publishByafChat(request, 'Nova', 'BYAF.jsonl', chat), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.equal(fs.existsSync(path.join(f.scope.directories.chats, 'Nova', 'BYAF.jsonl')), true);
});

test('an interrupted BYAF scenario creation finishes under its recorded vacancy', t => {
    const f = fixture(t, false, 'byaf-interrupted');
    const request = { user: { profile: { handle: 'byaf-interrupted' }, directories: f.scope.directories } };
    const chat = ByafParser.getChatFromScenario({ messages: [], firstMessages: [{ text: 'Keep me' }] }, 'User', 'Nova', []);
    const target = path.join(f.scope.directories.chats, 'Nova', 'Interrupted.jsonl');
    const originalOpen = fs.openSync;
    let interrupted = false;
    fs.openSync = function (filename, ...args) {
        if (!interrupted && filename === target && args[0] === 'wx') {
            interrupted = true;
            throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        }
        return originalOpen.call(fs, filename, ...args);
    };
    try {
        assert.throws(() => publishByafChat(request, 'Nova', 'Interrupted.jsonl', chat), error => error.roleplayWritePending);
    } finally {
        fs.openSync = originalOpen;
    }
    assert.equal(interrupted, true);
    assert.equal(fs.existsSync(target), false);
    assert.equal(readRoleplayAccount(f.scope).pending?.kind, 'chat-write');
    bootstrapRoleplayAccount(f.scope, roleplayNativeHost);
    assert.equal(readRoleplayChat(f.scope, { group: false, chat: 'Interrupted', avatar: 'Nova.png' }).records[1].mes, 'Keep me');
    assert.equal(readRoleplayAccount(f.scope).pending, null);
});

test('BYAF scenarios use the canonical folder for a character name containing .png', t => {
    const f = fixture(t, false, 'byaf-embedded-avatar');
    const request = { user: { profile: { handle: 'byaf-embedded-avatar' }, directories: f.scope.directories } };
    const chat = ByafParser.getChatFromScenario({ messages: [], firstMessages: [{ text: 'Embedded' }] }, 'User', 'Nova', []);
    publishByafChat(request, 'Nova.png.variant', 'Embedded.jsonl', chat);
    assert.equal(readRoleplayChat(f.scope, { group: false, avatar: 'Nova.png.variant.png', chat: 'Embedded' }).records[1].mes, 'Embedded');
    assert.equal(fs.existsSync(path.join(f.scope.directories.chats, 'Nova.png.variant', 'Embedded.jsonl')), false);
});
