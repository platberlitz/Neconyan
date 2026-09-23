import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';
import { readRoleplayEntity } from '../src/generation/roleplay-source.js';
import { write as writeCard } from '../src/character-card-parser.js';
import { assertUntrackedRoleplayFiles, readRoleplayAccount, withRoleplayAccount } from '../src/roleplay-store.js';
import { bootstrapRoleplayAccount, commitRoleplayLifecycleLocked, commitSingleChatImport, reconcilePendingChatWrite } from '../src/roleplay-lifecycle.js';
import { convertImportedChatFile, roleplayNativeHost } from '../src/endpoints/chats.js';

test('a third-state edit after an interrupted card write is retained', t => {
    const f = fixture(t, false, 'torn-third-state');
    const filename = path.join(f.scope.directories.characters, 'Nova.png');
    readRoleplayEntity(f.scope, 'character', 'Nova.png');
    const bytes = writeCard(png, JSON.stringify({ name: 'Nova', description: 'Recorded' }));
    const original = fs.renameSync;
    fs.renameSync = function (source, destination) {
        if (destination === filename && source.endsWith('.tmp')) throw Object.assign(new Error('interrupted publication'), { code: 'EIO' });
        return original.apply(fs, arguments);
    };
    try {
        assert.throws(() => withRoleplayAccount(f.scope, null, lease => commitRoleplayLifecycleLocked(lease, {
            operationKey: 'edit', action: 'character-update', intent: { avatar: 'Nova.png' },
            steps: [{ op: 'update', kind: 'character', locator: { avatar: 'Nova.png' }, bytes }],
        })), { code: 'EIO' });
    } finally { fs.renameSync = original; }
    const third = Buffer.from(fs.readFileSync(filename));
    third[third.length - 1] ^= 1;
    fs.writeFileSync(filename, third);
    assert.throws(() => bootstrapRoleplayAccount(f.scope, roleplayNativeHost), { code: 'ROLEPLAY_SOURCE_CHANGED' });
    assert.deepEqual(fs.readFileSync(filename), third);
});

test('a publication interrupted after rename replays only the recorded physical file', t => {
    const f = fixture(t, false, 'published-card');
    const filename = path.join(f.scope.directories.characters, 'Nova.png');
    readRoleplayEntity(f.scope, 'character', 'Nova.png');
    const bytes = writeCard(png, JSON.stringify({ name: 'Nova', description: 'Published' }));
    const original = fs.renameSync;
    fs.renameSync = function (source, destination) {
        original.apply(fs, arguments);
        if (destination === filename && source.endsWith('.tmp')) throw Object.assign(new Error('lost publication acknowledgement'), { code: 'EIO' });
    };
    try {
        assert.throws(() => withRoleplayAccount(f.scope, null, lease => commitRoleplayLifecycleLocked(lease, {
            operationKey: 'edit', action: 'character-update', intent: { avatar: 'Nova.png' },
            steps: [{ op: 'update', kind: 'character', locator: { avatar: 'Nova.png' }, bytes }],
        })), { code: 'EIO' });
    } finally { fs.renameSync = original; }
    bootstrapRoleplayAccount(f.scope, roleplayNativeHost);
    assert.deepEqual(fs.readFileSync(filename), bytes);
});

test('a group import resumes its link after recording the new file before publication', t => {
    const f = fixture(t, true, 'staged-group-import');
    const group = readRoleplayEntity(f.scope, 'group', 'group');
    const filename = path.join(f.scope.directories.groups, 'group.json');
    const request = { operationKey: 'import', bytes: Buffer.from(f.records.map(JSON.stringify).join('\n')),
        originalName: 'Story.jsonl', format: 'jsonl', userName: 'User', characterName: 'Nova',
        target: { group: true, groupId: 'group', source: { instanceId: group.instanceId, revision: group.revision, rawHash: group.rawHash } } };
    const original = fs.renameSync;
    fs.renameSync = function (source, destination) {
        if (destination === filename && source.endsWith('.tmp')) throw Object.assign(new Error('interrupted group link'), { code: 'EIO' });
        return original.apply(fs, arguments);
    };
    try {
        assert.throws(() => commitSingleChatImport(f.scope, request, roleplayNativeHost, convertImportedChatFile),
            error => error.code === 'EIO' && error.roleplayWritePending);
    } finally { fs.renameSync = original; }
    assert.ok(readRoleplayAccount(f.scope).pending?.group.appliedPhysical);
    const result = reconcilePendingChatWrite(f.scope, roleplayNativeHost);
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')).chats.slice(-1), result.names);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
});

test('an unrecognised hard link to a protected file cannot pass the ordinary-file guard', t => {
    const f = fixture(t, false, 'odd-alias');
    readRoleplayEntity(f.scope, 'character', 'Nova.png');
    const alias = path.join(f.scope.directories.characters, 'odd?name.png');
    fs.linkSync(path.join(f.scope.directories.characters, 'Nova.png'), alias);
    assert.throws(() => withRoleplayAccount(f.scope, null, lease => assertUntrackedRoleplayFiles(lease, [alias])),
        { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('an unrecognised symbolic link to a protected file cannot pass the ordinary-file guard', t => {
    const f = fixture(t, false, 'odd-symlink');
    readRoleplayEntity(f.scope, 'character', 'Nova.png');
    const alias = path.join(f.scope.directories.characters, 'odd?name.png');
    fs.symlinkSync('Nova.png', alias);
    assert.throws(() => withRoleplayAccount(f.scope, null, lease => assertUntrackedRoleplayFiles(lease, [alias])),
        { code: 'ROLEPLAY_SOURCE_CHANGED' });
});
