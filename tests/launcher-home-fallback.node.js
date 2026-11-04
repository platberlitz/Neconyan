import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

// A scratch project containing only the launcher and its prerequisite script.
// The runtime is faked, so the launcher must walk its whole start-up path and
// hand server.js to the selected runtime without ever installing packages.
function makeProject() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-launcher-'));
    fs.mkdirSync(path.join(directory, 'scripts'));
    fs.copyFileSync(path.join(root, 'start.sh'), path.join(directory, 'start.sh'));
    fs.copyFileSync(path.join(root, 'scripts/install-prerequisites.sh'), path.join(directory, 'scripts/install-prerequisites.sh'));
    return directory;
}

function makeBin(name, logFile, codeForServer) {
    return [
        '#!/usr/bin/env bash',
        `printf '%s\\n' "$@" >> '${logFile}'`,
        'for argument in "$@"; do',
        `  if [[ "$argument" == server.js ]]; then exit ${codeForServer}; fi`,
        'done',
        'exit 0',
    ].join('\n');
}

test('the launcher starts with HOME and BUN_INSTALL unset and selects Node on Termux', () => {
    const directory = makeProject();
    const log = path.join(directory, 'invocations.log');
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'node'), makeBin('node', log, 42), { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'npm'), makeBin('npm', log, 0), { mode: 0o755 });
    try {
        const result = spawnSync('bash', ['start.sh', '--skip-self-update'], {
            cwd: directory,
            encoding: 'utf8',
            timeout: 60000,
            env: {
                PATH: `${bin}:/usr/bin:/bin`,
                TERMUX_VERSION: '0.118',
                NECONYAN_AUTO_UPDATE: '0',
                TMPDIR: path.join(directory, 'tmp'),
            },
        });
        assert.equal(result.status, 42, `launcher failed: ${result.stderr}`);
        const invocations = fs.readFileSync(log, 'utf8');
        assert.match(invocations, /server\.js/, 'the selected runtime must be handed server.js');
        assert.doesNotMatch(result.stderr, /unbound variable/);
        assert.doesNotMatch(result.stderr, /HOME|BUN_INSTALL/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the launcher runs the Bun path end to end when Bun is selected and not on Termux', () => {
    const directory = makeProject();
    const log = path.join(directory, 'invocations.log');
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'bun'), makeBin('bun', log, 42), { mode: 0o755 });
    try {
        const result = spawnSync('bash', ['start.sh', '--skip-self-update'], {
            cwd: directory,
            encoding: 'utf8',
            timeout: 60000,
            env: {
                PATH: `${bin}:/usr/bin:/bin`,
                HOME: directory,
                NECONYAN_USE_BUN: '1',
                NECONYAN_AUTO_UPDATE: '0',
                TMPDIR: path.join(directory, 'tmp'),
            },
        });
        assert.equal(result.status, 42, `launcher failed: ${result.stderr}`);
        const invocations = fs.readFileSync(log, 'utf8');
        assert.match(invocations, /server\.js/, 'Bun must be handed server.js');
        assert.doesNotMatch(result.stderr, /unbound variable/);
        assert.doesNotMatch(result.stderr, /Installing Bun/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('launcher helper functions survive unset HOME and BUN_INSTALL under set -u', t => {
    // CI installs Node outside /usr/bin, and a developer may have Bun there.
    // Resolve Bash first, then give the helpers only the runtimes this test owns.
    const bash = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' });
    assert.equal(bash.status, 0, bash.stderr);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-bun-home-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const bin = path.join(directory, 'runtime-bin');
    fs.mkdirSync(bin);
    const run = (env = {}) => spawnSync(bash.stdout.trim(), ['-c', script], {
        encoding: 'utf8', env: { PATH: bin, ...env },
    });
    const source = fs.readFileSync(path.join(root, 'start.sh'), 'utf8');
    const end = source.indexOf('\nself_update_requested=0');
    assert.ok(end > 0, 'could not find the helper section end marker');
    // Drop the SCRIPT_DIR preamble; it only matters for the executed launcher,
    // and these function-level checks do not call is_termux_shared_storage_repo.
    const begin = source.indexOf('export NECONYAN_USE_NODE=');
    assert.ok(begin > 0 && begin < end, 'could not find the helper section start marker');
    const helpers = source.slice(begin, end);
    const script = [
        'set -euo pipefail',
        helpers,
        'if is_termux; then echo TERMUX; else echo DESKTOP; fi',
        'bun_path="$(resolve_runtime_command bun || true)"; echo "BUN=${bun_path}"',
        'if resolve_runtime_command node >/dev/null 2>&1; then echo NODEFOUND; else echo NODENOTFOUND; fi',
    ].join('\n');
    const absent = run();
    assert.equal(absent.status, 0, absent.stderr);
    assert.equal(absent.stdout, 'DESKTOP\nBUN=\nNODENOTFOUND\n');

    fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const unset = run();
    assert.equal(unset.status, 0, `helpers failed with HOME and BUN_INSTALL unset: ${unset.stderr}`);
    assert.equal(unset.stdout, 'DESKTOP\nBUN=\nNODEFOUND\n');
    assert.doesNotMatch(unset.stderr, /unbound variable/);

    // The Termux HOME fallback matches src/runtime.js detection.
    const home = run({ HOME: '/data/data/com.termux/files/home' });
    assert.equal(home.status, 0, home.stderr);
    assert.equal(home.stdout, 'TERMUX\nBUN=\nNODEFOUND\n');

    // A normal desktop home and a bun that lives only in BUN_INSTALL keep working.
    fs.mkdirSync(path.join(directory, 'bin'));
    fs.writeFileSync(path.join(directory, 'bin', 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const found = run({ HOME: '/home/someone', BUN_INSTALL: directory });
    assert.equal(found.status, 0, found.stderr);
    assert.equal(found.stdout, `DESKTOP\nBUN=${path.join(directory, 'bin/bun')}\nNODEFOUND\n`);
});

test('install-prerequisites.sh survives unset HOME without installing anything', () => {
    const directory = makeProject();
    try {
        const plain = spawnSync('bash', ['scripts/install-prerequisites.sh', '--skip-bun'], {
            cwd: directory, encoding: 'utf8', timeout: 60000, env: { PATH: '/usr/bin:/bin' },
        });
        assert.equal(plain.status, 0, `plain run failed: ${plain.stderr}`);
        assert.doesNotMatch(plain.stderr, /unbound variable/);
        const termux = spawnSync('bash', ['scripts/install-prerequisites.sh', '--skip-bun'], {
            cwd: directory, encoding: 'utf8', timeout: 60000, env: { PATH: '/usr/bin:/bin', TERMUX_VERSION: '0.118', TMPDIR: path.join(directory, 'tmp') },
        });
        assert.equal(termux.status, 0, `termux run failed: ${termux.stderr}`);
        assert.doesNotMatch(termux.stderr, /unbound variable/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
