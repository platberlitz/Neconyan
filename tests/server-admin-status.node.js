/* eslint playwright/expect-expect: off -- Node assertions check real Git worktree and index preservation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import simpleGit from 'simple-git';
import { createRemoteRefresh, getStatusDisplayBranch, isGitRepository, NON_GIT_REPOSITORY_MESSAGE } from '../src/server-admin-git.js';

test('checking repository status preserves staged versions and unstaged lockfile edits', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-status-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const git = simpleGit(directory);
    await git.init();
    await git.addConfig('user.name', 'Release fixture');
    await git.addConfig('user.email', 'fixture@example.invalid');
    for (const filename of ['package.json', 'package-lock.json', 'bun.lock']) {
        fs.writeFileSync(path.join(directory, filename), '{"version":"1.0.0"}\n');
    }
    await git.add('.');
    await git.commit('Initial fixture');
    await git.addRemote('origin', directory);
    await git.fetch();
    const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
    await git.raw(['branch', '--set-upstream-to', `origin/${branch}`]);
    fs.writeFileSync(path.join(directory, 'package.json'), '{"version":"1.0.1"}\n');
    await git.add('package.json');
    fs.writeFileSync(path.join(directory, 'package-lock.json'), '{"version":"1.0.1"}\n');
    fs.unlinkSync(path.join(directory, 'bun.lock'));
    const staged = await git.diff(['--cached']);
    const unstaged = await git.diff();
    const source = fs.readFileSync(new URL('../src/endpoints/server-admin.js', import.meta.url), 'utf8');
    const declaration = source.match(/^async function getRepositoryStatus\([\s\S]*?^}/m)?.[0];
    assert(declaration);
    const context = vm.createContext({
        commandExistsSync: () => true, simpleGit, serverDirectory: directory, GIT_OPTIONS: {},
        isGitRepository, NON_GIT_REPOSITORY_MESSAGE, getStatusDisplayBranch,
        toTrimmedString: value => String(value).trim(), getConfigValue: () => false,
        refreshRepositoryRemote: createRemoteRefresh(),
    });
    vm.runInContext(declaration, context);
    for (let attempt = 0; attempt < 2; attempt++) {
        const status = await context.getRepositoryStatus();
        assert.equal(status.hasLocalChanges, true);
        assert.equal(status.changedFilesCount, 3);
        assert.equal(status.canUpdate, false);
        assert.equal(await git.diff(['--cached']), staged);
        assert.equal(await git.diff(), unstaged);
    }
});
