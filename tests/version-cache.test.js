import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, test } from '@jest/globals';

import { getVersion } from '../src/util.js';

const temporaryDirectories = [];
const gitEnvironment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
};

function makeTemporaryDirectory(prefix = 'neconyan-version-') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

function runGit(directory, ...args) {
    return execFileSync('git', args, {
        cwd: directory,
        encoding: 'utf8',
        env: gitEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function writePackageVersion(directory, version) {
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'version-test', version }));
}

function commitFile(directory, fileName, contents, message) {
    fs.writeFileSync(path.join(directory, fileName), contents);
    runGit(directory, 'add', fileName);
    runGit(directory, 'commit', '-m', message);
}

function createRepository({ withRemote = false } = {}) {
    const base = makeTemporaryDirectory();
    const root = path.join(base, 'repo');
    fs.mkdirSync(root);
    writePackageVersion(root, '1.2.3');

    runGit(root, 'init', '-b', 'main');
    runGit(root, 'config', 'user.name', 'Version Test');
    runGit(root, 'config', 'user.email', 'version-test@example.com');
    fs.writeFileSync(path.join(root, 'file.txt'), 'one\n');
    runGit(root, 'add', '.');
    runGit(root, 'commit', '-m', 'initial');

    let remote = null;
    if (withRemote) {
        remote = path.join(base, 'remote.git');
        runGit(base, 'init', '--bare', '--initial-branch=main', remote);
        runGit(root, 'remote', 'add', 'origin', remote);
        runGit(root, 'push', '-u', 'origin', 'main');
    }

    return { base, root, remote };
}

function pushRemoteCommit(repository, contents, message) {
    const clone = fs.mkdtempSync(path.join(repository.base, 'clone-'));
    execFileSync('git', ['clone', repository.remote, clone], {
        encoding: 'utf8',
        env: gitEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    runGit(clone, 'config', 'user.name', 'Version Test');
    runGit(clone, 'config', 'user.email', 'version-test@example.com');
    commitFile(clone, 'file.txt', contents, message);
    runGit(clone, 'push');
}

afterEach(() => {
    while (temporaryDirectories.length) {
        fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
    }
});

describe('getVersion checkout cache', () => {
    test('caches a stable checkout and notices branch switches at the same commit', async () => {
        const { root } = createRepository();
        const revision = runGit(root, 'rev-parse', '--short', 'HEAD');
        const commitDate = runGit(root, 'show', '-s', '--format=%ci', 'HEAD');

        const first = await getVersion(root);
        expect(first).toEqual({
            agent: 'Neconyan:1.2.3',
            pkgVersion: '1.2.3',
            gitRevision: revision,
            gitBranch: 'main',
            commitDate,
            isLatest: true,
        });

        const cached = await getVersion(root);
        expect(cached).toEqual(first);
        expect(cached).not.toBe(first);

        runGit(root, 'checkout', '-b', 'same-sha-a');
        await expect(getVersion(root)).resolves.toMatchObject({
            gitRevision: revision,
            gitBranch: 'same-sha-a',
        });

        runGit(root, 'checkout', '-b', 'same-sha-b');
        await expect(getVersion(root)).resolves.toMatchObject({
            gitRevision: revision,
            gitBranch: 'same-sha-b',
        });

        runGit(root, 'checkout', '--detach', 'HEAD');
        await expect(getVersion(root)).resolves.toMatchObject({
            gitRevision: revision,
            gitBranch: 'HEAD',
        });
    });

    test('resolves nested branch refs and keeps working after refs are packed', async () => {
        const { root } = createRepository();

        runGit(root, 'checkout', '-b', 'feature/deep/topic');
        await expect(getVersion(root)).resolves.toMatchObject({ gitBranch: 'feature/deep/topic' });

        runGit(root, 'pack-refs', '--all', '--prune');
        expect(fs.existsSync(path.join(root, '.git', 'refs', 'heads', 'feature', 'deep', 'topic'))).toBe(false);

        await expect(getVersion(root)).resolves.toMatchObject({ gitBranch: 'feature/deep/topic' });

        commitFile(root, 'file.txt', 'two\n', 'second');
        runGit(root, 'pack-refs', '--all', '--prune');
        await expect(getVersion(root)).resolves.toMatchObject({
            gitBranch: 'feature/deep/topic',
            gitRevision: runGit(root, 'rev-parse', '--short', 'HEAD'),
        });
    });

    test('follows a symbolic HEAD ref through a nested branch alias', async () => {
        const { root } = createRepository();
        runGit(root, 'branch', 'other');
        runGit(root, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/main');
        runGit(root, 'symbolic-ref', 'HEAD', 'refs/heads/alias');

        await expect(getVersion(root)).resolves.toMatchObject({ gitBranch: 'main' });

        runGit(root, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/other');
        await expect(getVersion(root)).resolves.toMatchObject({ gitBranch: 'other' });
    });

    test('updates isLatest when the upstream tracking ref moves, loose or packed', async () => {
        const repository = createRepository({ withRemote: true });
        const { root } = repository;

        await expect(getVersion(root)).resolves.toMatchObject({ gitBranch: 'main', isLatest: true });

        pushRemoteCommit(repository, 'two\n', 'remote second');
        runGit(root, 'fetch');
        await expect(getVersion(root)).resolves.toMatchObject({ gitBranch: 'main', isLatest: false });

        runGit(root, 'merge', '--ff-only', 'origin/main');
        await expect(getVersion(root)).resolves.toMatchObject({ gitBranch: 'main', isLatest: true });

        runGit(root, 'pack-refs', '--all', '--prune');
        await expect(getVersion(root)).resolves.toMatchObject({ gitBranch: 'main', isLatest: true });

        pushRemoteCommit(repository, 'three\n', 'remote third');
        runGit(root, 'fetch');
        await expect(getVersion(root)).resolves.toMatchObject({ gitBranch: 'main', isLatest: false });
    });

    test('reads a linked worktree through its .git file and commondir', async () => {
        const { base, root } = createRepository();
        const worktree = path.join(base, 'worktree');
        runGit(root, 'worktree', 'add', '-b', 'worktree-a', worktree);

        expect(fs.statSync(path.join(worktree, '.git')).isFile()).toBe(true);
        await expect(getVersion(worktree)).resolves.toMatchObject({ gitBranch: 'worktree-a' });
        await expect(getVersion(root)).resolves.toMatchObject({ gitBranch: 'main' });

        runGit(worktree, 'checkout', '-b', 'worktree-b');
        await expect(getVersion(worktree)).resolves.toMatchObject({ gitBranch: 'worktree-b' });
        await expect(getVersion(root)).resolves.toMatchObject({ gitBranch: 'main' });
    });

    test('tracks uncommitted package version changes without dropping Git details', async () => {
        const { root } = createRepository();

        await expect(getVersion(root)).resolves.toMatchObject({ pkgVersion: '1.2.3', gitBranch: 'main' });

        writePackageVersion(root, '2.0.0');
        await expect(getVersion(root)).resolves.toMatchObject({
            agent: 'Neconyan:2.0.0',
            pkgVersion: '2.0.0',
            gitBranch: 'main',
        });
    });

    test('falls back without Git and rereads package version changes', async () => {
        const root = makeTemporaryDirectory();
        writePackageVersion(root, '3.4.5');

        await expect(getVersion(root)).resolves.toEqual({
            agent: 'Neconyan:3.4.5',
            pkgVersion: '3.4.5',
            gitRevision: null,
            gitBranch: null,
            commitDate: null,
            isLatest: true,
        });

        writePackageVersion(root, '3.4.6');
        await expect(getVersion(root)).resolves.toMatchObject({ pkgVersion: '3.4.6', gitRevision: null });
    });

    test('does not cache a failed Git read and retries once the checkout is readable again', async () => {
        const { root } = createRepository();
        const head = path.join(root, '.git', 'HEAD');
        const backup = `${head}.backup`;
        fs.renameSync(head, backup);

        try {
            await expect(getVersion(root)).resolves.toEqual({
                agent: 'Neconyan:1.2.3',
                pkgVersion: '1.2.3',
                gitRevision: null,
                gitBranch: null,
                commitDate: null,
                isLatest: true,
            });
        } finally {
            fs.renameSync(backup, head);
        }

        await expect(getVersion(root)).resolves.toMatchObject({
            pkgVersion: '1.2.3',
            gitRevision: runGit(root, 'rev-parse', '--short', 'HEAD'),
            gitBranch: 'main',
        });
    });

    test('coalesces concurrent cold reads into consistent results', async () => {
        const { root } = createRepository({ withRemote: true });

        const results = await Promise.all(Array.from({ length: 24 }, () => getVersion(root)));

        expect(new Set(results.map(result => JSON.stringify(result))).size).toBe(1);
        expect(results[0]).toMatchObject({ pkgVersion: '1.2.3', gitBranch: 'main', isLatest: true });
        for (const result of results.slice(1)) {
            expect(result).not.toBe(results[0]);
        }
    });
});
