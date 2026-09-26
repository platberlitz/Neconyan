import { describe, test, expect, afterAll } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const startShSource = readFileSync(path.join(repoRoot, 'start.sh'), 'utf8');

function extractShellFunction(source, name) {
    const lines = source.split('\n');
    const start = lines.findIndex(line => line.startsWith(`${name}() {`));
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((line, index) => index > start && line === '}');
    expect(end).toBeGreaterThan(start);
    return lines.slice(start, end + 1).join('\n');
}

const harnessDir = mkdtempSync(path.join(tmpdir(), 'nn-start-install-'));
const harnessPath = path.join(harnessDir, 'harness.sh');
const fakeBunPath = path.join(harnessDir, 'bun');
const callLogPath = path.join(harnessDir, 'calls.log');
const freshLockPath = path.join(harnessDir, 'lock-fresh');

// Mimics Bun 1.3: with a stale bun.lock, both --frozen-lockfile and
// --production refuse to install until the lockfile has been refreshed.
writeFileSync(fakeBunPath, [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$*" >> '${callLogPath}'`,
    'case " $* " in',
    `    *" --lockfile-only "*) touch '${freshLockPath}'; exit 0 ;;`,
    'esac',
    `if [[ -e '${freshLockPath}' ]]; then exit 0; fi`,
    'case " $* " in',
    '    *" --frozen-lockfile "*|*" --production "*) echo "error: lockfile had changes, but lockfile is frozen" >&2; exit 1 ;;',
    'esac',
    'exit 0',
    '',
].join('\n'), { mode: 0o755 });

writeFileSync(harnessPath, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    extractShellFunction(startShSource, 'run_package_install'),
    'runtime_kind=bun',
    'PACKAGE_MANAGER_CMD="$TEST_FAKE_BUN"',
    'install_args=("$@")',
    'run_package_install',
    '',
].join('\n\n'));

afterAll(() => {
    rmSync(harnessDir, { recursive: true, force: true });
});

function hasUsableBash() {
    try {
        return execFileSync('bash', ['-c', 'echo ok'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'ok';
    } catch {
        return false;
    }
}

const describeShell = hasUsableBash() ? describe : describe.skip;

function runInstall(args) {
    rmSync(callLogPath, { force: true });
    rmSync(freshLockPath, { force: true });
    execFileSync('bash', [harnessPath, ...args], {
        env: { ...process.env, TEST_FAKE_BUN: fakeBunPath },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return existsSync(callLogPath) ? readFileSync(callLogPath, 'utf8').trim().split('\n') : [];
}

describeShell('start.sh run_package_install with a stale bun.lock', () => {
    test('refreshes the lockfile before retrying a production install', () => {
        expect(runInstall(['install', '--frozen-lockfile', '--no-progress', '--no-summary', '--production'])).toEqual([
            'install --frozen-lockfile --no-progress --no-summary --production',
            'install --lockfile-only --no-progress --no-summary',
            'install --no-progress --no-summary --production',
        ]);
    });

    test('retries a development install without a separate lockfile refresh', () => {
        expect(runInstall(['install', '--frozen-lockfile', '--no-progress', '--no-summary'])).toEqual([
            'install --frozen-lockfile --no-progress --no-summary',
            'install --no-progress --no-summary',
        ]);
    });
});
