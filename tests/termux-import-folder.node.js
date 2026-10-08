import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { checkRecoveryPort, listRecoveryFolders, selectRecoveryFolder } from '../scripts/termux-import-folder.js';

const launcher = fileURLToPath(new URL('../scripts/start-termux-import.sh', import.meta.url));
const selector = fileURLToPath(new URL('../scripts/termux-import-folder.js', import.meta.url));
const hash = text => createHash('sha256').update(text).digest('hex');

test('an occupied port is refused before another server can be launched', async () => {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    try { await assert.rejects(checkRecoveryPort(port), /already using port/); }
    finally { await new Promise(resolve => server.close(resolve)); }
    await checkRecoveryPort(port);
});

function fixture(t) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'termux-folder-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const folder = name => {
        const root = path.join(home, `neconyan-import-${name}`);
        fs.mkdirSync(root);
        return root;
    };
    const record = (root, key, state = 'accepted') => {
        const directory = path.join(root, '_roleplay', hash('default-user'), 'operations');
        fs.mkdirSync(directory, { recursive: true });
        const filename = path.join(directory, hash(key) + '.json');
        fs.writeFileSync(filename, JSON.stringify({ version: 1, kind: 'account-import', key, state, createdAt: 42 }));
        return filename;
    };
    return { home, folder, record, pin: path.join(home, '.neconyan-import-folder') };
}

test('five recovery folders select the one with the saved import and never create a sixth', t => {
    const f = fixture(t);
    const roots = ['old', 'second', 'third', 'fourth', 'fifth'].map(f.folder);
    const filename = f.record(roots[0], 'accepted-before-sleep');
    const bytes = fs.readFileSync(filename);
    assert.equal(selectRecoveryFolder(f.home), roots[0]);
    assert.equal(fs.readFileSync(f.pin, 'utf8').trim(), roots[0]);
    f.record(roots[4], 'later-attempt', 'completed');
    for (let retry = 0; retry < 5; retry++) assert.equal(selectRecoveryFolder(f.home, { create: true }), roots[0]);
    assert.equal(listRecoveryFolders(f.home).length, 5);
    assert.deepEqual(fs.readFileSync(filename), bytes);
});

test('ambiguous saved imports stop without changing files, and an exact key selects their folder', t => {
    const f = fixture(t);
    const first = f.folder('first'), second = f.folder('second');
    f.record(first, 'first-key'); f.record(second, 'second-key', 'completed');
    assert.throws(() => selectRecoveryFolder(f.home), /Could not identify one recovery folder/);
    assert.equal(fs.existsSync(f.pin), false);
    assert.equal(selectRecoveryFolder(f.home, { key: 'second-key' }), second);
    assert.throws(() => selectRecoveryFolder(f.home, { key: 'first-key' }), /existing selection was kept/);
    assert.equal(fs.readFileSync(f.pin, 'utf8').trim(), second);
});

test('an unknown key cannot fall back to the only folder', t => {
    const f = fixture(t); f.record(f.folder('only'), 'saved-key');
    assert.throws(() => selectRecoveryFolder(f.home, { key: 'missing-key' }), /Could not identify/);
    assert.equal(fs.existsSync(f.pin), false);
});

test('a first launch requires explicit creation, and repeated setup reuses the same folder', t => {
    const f = fixture(t);
    assert.throws(() => selectRecoveryFolder(f.home), /Could not identify/);
    assert.deepEqual(fs.readdirSync(f.home), []);
    const first = selectRecoveryFolder(f.home, { create: true });
    assert.equal(first, path.join(f.home, 'neconyan-import-recovery'));
    assert.equal(selectRecoveryFolder(f.home, { create: true }), first);
    assert.equal(listRecoveryFolders(f.home).length, 1);
});

test('a sole existing folder with an unfinished upload is kept, while several empty folders are not guessed', t => {
    const f = fixture(t); const root = f.folder('first');
    assert.equal(selectRecoveryFolder(f.home), root);
    fs.unlinkSync(f.pin); f.folder('second');
    assert.throws(() => selectRecoveryFolder(f.home, { create: true }), /Could not identify/);
    assert.equal(listRecoveryFolders(f.home).length, 2);
});

test('a deleted pinned folder is never silently recreated or replaced', t => {
    const f = fixture(t); const root = f.folder('original');
    selectRecoveryFolder(f.home);
    fs.rmdirSync(root); f.record(f.folder('other'), 'other-key');
    assert.throws(() => selectRecoveryFolder(f.home, { create: true }), /missing or invalid/);
    assert.equal(fs.existsSync(root), false);
    assert.equal(fs.readFileSync(f.pin, 'utf8').trim(), root);
});

test('corrupt import metadata is preserved and cannot be mistaken for an empty installation', t => {
    const f = fixture(t); const root = f.folder('old');
    const filename = f.record(root, 'old'); fs.writeFileSync(filename, '{broken');
    assert.throws(() => selectRecoveryFolder(f.home, { create: true }), /Could not inspect saved work/);
    assert.equal(fs.readFileSync(filename, 'utf8'), '{broken');
    assert.equal(fs.existsSync(f.pin), false);
});

test('the folder choice refuses links and paths outside the recovery folders', { skip: process.platform === 'win32' }, t => {
    const f = fixture(t); const root = f.folder('real');
    fs.symlinkSync(root, path.join(f.home, 'neconyan-import-linked'));
    assert.throws(() => listRecoveryFolders(f.home), /not a normal directory/);
    fs.unlinkSync(path.join(f.home, 'neconyan-import-linked'));
    fs.writeFileSync(f.pin, path.dirname(f.home));
    assert.throws(() => selectRecoveryFolder(f.home), /missing or invalid/);
    fs.unlinkSync(f.pin);
    const target = path.join(f.home, 'target'); fs.writeFileSync(target, root);
    fs.symlinkSync(target, f.pin);
    assert.throws(() => selectRecoveryFolder(f.home));
    assert.equal(fs.readFileSync(target, 'utf8'), root);
});

test('invoking the selector through a path alias still runs its CLI', { skip: process.platform === 'win32' }, t => {
    const f = fixture(t); const alias = path.join(f.home, 'selector.mjs');
    fs.symlinkSync(selector, alias);
    assert.throws(() => execFileSync(process.execPath, [alias, '--invalid'], { encoding: 'utf8', stdio: 'pipe' }), error => {
        assert.equal(error.status, 1);
        assert.match(error.stderr, /Usage: node termux-import-folder/);
        return true;
    });
});

test('the launcher acquires the wake lock before starting and preserves the selected path on every run', { skip: process.platform === 'win32' }, t => {
    const f = fixture(t); const root = f.folder('selected');
    const bin = path.join(f.home, 'bin'); fs.mkdirSync(bin);
    const install = path.join(f.home, 'installation with spaces'); fs.mkdirSync(install);
    const order = path.join(f.home, 'order'); const args = path.join(f.home, 'args');
    fs.writeFileSync(path.join(bin, 'node'), '#!/usr/bin/env bash\nif [[ "$1" == *.local-runtime/termux-import/termux-import-folder.js ]]; then printf "%s\\n" "$NECO_TEST_DATA"; else printf "server\\n" >> "$NECO_TEST_ORDER"; printf "%s\\0" "$@" > "$NECO_TEST_ARGS"; fi\n', { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'termux-wake-lock'), '#!/usr/bin/env bash\nprintf "wake\\n" >> "$NECO_TEST_ORDER"\nexit "${NECO_TEST_WAKE_STATUS:-0}"\n', { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, NECONYAN_INSTALL_DIR: install,
        NECO_TEST_DATA: root, NECO_TEST_ORDER: order, NECO_TEST_ARGS: args };
    for (let retry = 0; retry < 2; retry++) execFileSync('bash', [launcher], { env });
    assert.equal(fs.readFileSync(order, 'utf8'), 'wake\nserver\nwake\nserver\n');
    assert.deepEqual(fs.readFileSync(args, 'utf8').split('\0').filter(Boolean), [
        '--import', './.local-runtime/termux-import/termux-file-stats.js', 'server.js', '--dataRoot', root, '--port', '5534',
    ]);
    assert.throws(() => execFileSync('bash', [launcher], { env: { ...env, NECO_TEST_WAKE_STATUS: '1' } }));
    assert.equal(fs.readFileSync(order, 'utf8'), 'wake\nserver\nwake\nserver\nwake\n');
    assert.throws(() => execFileSync('bash', [launcher], { env: { ...env, NECO_TEST_DATA: '' }, stdio: 'pipe' }));
    assert.equal(fs.readFileSync(order, 'utf8'), 'wake\nserver\nwake\nserver\nwake\n');
});
