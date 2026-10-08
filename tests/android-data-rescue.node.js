import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { retainUploadedArchive } = await import('../src/operations/input-files.js');
const { captureZipImport } = await import('../src/operations/account-import-sources.js');

const source = path.resolve('android/app/src/main/java/io/github/platberlitz/neconyan/DataRescue.java');
const hasJava = spawnSync('javac', ['-version']).status === 0 && spawnSync('java', ['-version']).status === 0;
const lock = `.neconyan-chat-${'a'.repeat(64)}.lock`;

function write(root, relative, content) {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
}

function rescue(t, includeKeys) {
    const f = fixture(t, false, 'rescue');
    const work = path.join(path.dirname(f.scope.directories.root), 'android-rescue');
    const classes = path.join(work, 'classes');
    const dataRoot = path.join(work, 'files/data');
    fs.mkdirSync(classes, { recursive: true });
    write(work, 'Rescue.java', `package io.github.platberlitz.neconyan;
public final class Rescue {
    public static void main(String[] args) throws Exception {
        DataRescue.Result result;
        try (java.io.OutputStream out = new java.io.FileOutputStream(args[1])) { result = DataRescue.write(new java.io.File(args[0]), out, Boolean.parseBoolean(args[2])); }
        System.out.println(result.files + " " + result.skipped);
    }
}
`);
    write(dataRoot, 'default-user/settings.json', '{"username":"Gold"}');
    write(dataRoot, 'default-user/secrets.json', '{"api_key_openai":"secret"}');
    write(dataRoot, 'default-user/backups/secrets_migration_1.json', '{}');
    write(dataRoot, 'default-user/backups/chat_Gold.jsonl', '{}');
    write(dataRoot, 'default-user/chats/Gold/GOLD.jsonl', '{"user_name":"You"}\n{"mes":"Kept"}\n');
    write(dataRoot, `default-user/chats/Gold/${lock}`, 'held');
    write(dataRoot, `default-user/chats/Gold/${lock}.owner`, '{}');
    write(dataRoot, 'default-user/jobs/jobs.json', '{"jobs":{}}');
    write(dataRoot, 'default-user/characters/Gold.png', 'card');
    write(dataRoot, '_storage/cache.json', '{}');
    execFileSync('javac', ['-d', classes, source, path.join(work, 'Rescue.java')]);
    const zip = path.join(work, 'rescue.zip');
    const output = execFileSync('java', ['-cp', classes, 'io.github.platberlitz.neconyan.Rescue', dataRoot, zip, String(includeKeys)], { encoding: 'utf8' });
    return { f, zip, output };
}

test('Android rescue backup imports as the default account without locks or job records', { skip: !hasJava && 'javac is not installed' }, async t => {
    const { f, zip, output } = rescue(t, false);
    assert.match(output, /^4 \[\]/);
    const retained = await retainUploadedArchive({ owner: 'rescue', directories: f.scope.directories }, f.scope, 'android-rescue', zip);
    const captured = await captureZipImport(retained);
    assert.equal(captured.sourceRoot, 'data/default-user');
    assert.deepEqual(captured.files.map(file => file.relative).sort(), [
        'backups/chat_Gold.jsonl',
        'characters/Gold.png',
        'chats/Gold/GOLD.jsonl',
        'settings.json',
    ]);
});

test('Android rescue backup includes saved keys only when asked', { skip: !hasJava && 'javac is not installed' }, async t => {
    const { f, zip } = rescue(t, true);
    const retained = await retainUploadedArchive({ owner: 'rescue', directories: f.scope.directories }, f.scope, 'android-rescue-keys', zip);
    const captured = await captureZipImport(retained);
    const files = captured.files.map(file => file.relative);
    assert.ok(files.includes('secrets.json'));
    assert.ok(files.includes('backups/secrets_migration_1.json'));
    assert.ok(!files.some(file => file.startsWith('jobs/') || file.includes('.lock')));
});
