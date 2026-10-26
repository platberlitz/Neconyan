/* eslint playwright/expect-expect: off -- Node assertions check real Git worktree and index preservation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import simpleGit from 'simple-git';
import { createRemoteRefresh, getStatusDisplayBranch, isGitRepository, NON_GIT_REPOSITORY_MESSAGE } from '../src/server-admin-git.js';

// Execute the production status and update handlers against disposable repositories.
// Installation and restart are replaced so the test cannot affect the running server.
async function updateFixture(t, configuredAutoStash = false) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-autostash-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const upstream = path.join(directory, 'upstream');
    const checkout = path.join(directory, 'checkout');
    fs.mkdirSync(upstream);
    const producer = simpleGit(upstream);
    await producer.init();
    await producer.addConfig('user.name', 'Update fixture');
    await producer.addConfig('user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(upstream, 'local.txt'), 'original\n');
    fs.writeFileSync(path.join(upstream, 'release.txt'), 'old release\n');
    await producer.add('.');
    await producer.commit('Initial fixture');
    await simpleGit().clone(upstream, checkout);
    const git = simpleGit(checkout);
    await git.addConfig('user.name', 'Update fixture');
    await git.addConfig('user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(upstream, 'release.txt'), 'new release\n');
    await producer.add('.');
    await producer.commit('Upstream update');
    fs.writeFileSync(path.join(checkout, 'local.txt'), 'my local changes\n');
    fs.writeFileSync(path.join(checkout, 'untracked.txt'), 'my new file\n');
    const source = fs.readFileSync(new URL('../src/endpoints/server-admin.js', import.meta.url), 'utf8');
    let update;
    let restarted = false;
    const context = vm.createContext({
        fs, path, console: { info() {}, warn() {}, error() {} },
        commandExistsSync: () => true, simpleGit, serverDirectory: checkout, GIT_OPTIONS: {},
        isGitRepository, NON_GIT_REPOSITORY_MESSAGE, getStatusDisplayBranch,
        toTrimmedString: value => String(value).trim(), getConfigValue: () => configuredAutoStash,
        refreshRepositoryRemote: createRemoteRefresh(), getInstallCommand: () => null,
        getVersion: async () => ({}), scheduleRestart: () => { restarted = true; },
        requireAdminMiddleware() {}, router: { post: (_url, _admin, handler) => { update = handler; } },
    });
    for (const name of ['getRepositoryStatus', 'restoreAutoStash']) {
        const declaration = source.match(new RegExp(`^async function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0];
        assert(declaration);
        vm.runInContext(declaration, context);
    }
    const route = source.match(/^router.post\('\/update',[\s\S]*?^}\);/m)?.[0];
    assert(route);
    vm.runInContext(route, context);
    return {
        git, context, checkout, producer,
        async update(body) {
            const response = { code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
            await update({ body }, response);
            return { ...response, restarted };
        },
    };
}

test('auto-stash overrides the configured default and restores tracked and new files after updating', async t => {
    const fixture = await updateFixture(t);
    const blocked = await fixture.context.getRepositoryStatus({ refresh: true });
    assert.equal(blocked.canUpdate, false);
    const ready = await fixture.context.getRepositoryStatus({ autoStash: true });
    assert.equal(ready.canUpdate, true);
    assert.equal(ready.autoStash, true);
    assert.equal((await fixture.git.stashList()).total, 0);

    const result = await fixture.update({ autoStash: true });
    assert.equal(result.code, 202);
    assert.equal(result.restarted, true);
    assert.equal(result.body.stashed, true);
    assert.equal(result.body.stashPopWarning, null);
    assert.equal(result.body.repository.autoStash, true);
    assert.equal(fs.readFileSync(path.join(fixture.checkout, 'release.txt'), 'utf8'), 'new release\n');
    assert.equal(fs.readFileSync(path.join(fixture.checkout, 'local.txt'), 'utf8'), 'my local changes\n');
    assert.equal(fs.readFileSync(path.join(fixture.checkout, 'untracked.txt'), 'utf8'), 'my new file\n');
    assert.equal((await fixture.git.stashList()).total, 0);
});

test('turning auto-stash off overrides a true default and blocks updates without changing files', async t => {
    const fixture = await updateFixture(t, true);
    assert.equal((await fixture.context.getRepositoryStatus({ refresh: true })).canUpdate, true);
    assert.equal((await fixture.context.getRepositoryStatus({ autoStash: false })).canUpdate, false);
    const before = await fixture.git.status();
    const result = await fixture.update({ autoStash: false });
    assert.equal(result.code, 409);
    assert.equal(result.restarted, false);
    assert.deepEqual((await fixture.git.status()).files, before.files);
    assert.equal(fs.readFileSync(path.join(fixture.checkout, 'release.txt'), 'utf8'), 'old release\n');
    assert.equal((await fixture.git.stashList()).total, 0);
});

test('omitted or non-boolean overrides use the configured default', async t => {
    const blocked = await updateFixture(t);
    for (const body of [{}, { autoStash: 'true' }]) assert.equal((await blocked.update(body)).code, 409);
    const allowed = await updateFixture(t, true);
    assert.equal((await allowed.update({})).code, 202);
});

test('all changed files are reported without the old twelve-file cutoff', async t => {
    const fixture = await updateFixture(t);
    for (let index = 0; index < 15; index++) fs.writeFileSync(path.join(fixture.checkout, `extra-${index}.txt`), 'local\n');
    const status = await fixture.context.getRepositoryStatus();
    assert.equal(status.changedFilesCount, 17);
    assert.equal(status.changedFiles.length, 17);
    assert(status.changedFiles.some(file => file.path === 'untracked.txt'));
});

test('auto-stash never permits a diverged branch update', async t => {
    const fixture = await updateFixture(t);
    await fixture.git.add('local.txt');
    await fixture.git.commit('Local commit');
    const status = await fixture.context.getRepositoryStatus({ refresh: true, autoStash: true });
    assert.equal(status.canUpdate, false);
    assert.equal(status.ahead, 1);
    assert.equal(status.behind, 1);
    const result = await fixture.update({ autoStash: true });
    assert.equal(result.code, 409);
    assert.equal(result.restarted, false);
    assert.equal(fs.readFileSync(path.join(fixture.checkout, 'untracked.txt'), 'utf8'), 'my new file\n');
});

test('installation failure does not pop an older stash after restoring this update', async t => {
    const fixture = await updateFixture(t);
    await fixture.git.stash(['push', '-u', '-m', 'User stash']);
    fs.writeFileSync(path.join(fixture.checkout, 'current.txt'), 'current work\n');
    const previous = await fixture.git.stashList();
    fixture.context.getInstallCommand = () => ({ command: 'npm', args: ['ci'] });
    fixture.context.runCommand = async () => { throw new Error('Fixture installation failure'); };
    const result = await fixture.update({ autoStash: true });
    assert.equal(result.code, 500);
    assert.equal(result.restarted, false);
    assert.equal(result.body.error, 'Fixture installation failure');
    assert.deepEqual((await fixture.git.stashList()).all, previous.all);
    assert.equal(fs.readFileSync(path.join(fixture.checkout, 'current.txt'), 'utf8'), 'current work\n');
    assert.equal(fs.readFileSync(path.join(fixture.checkout, 'local.txt'), 'utf8'), 'original\n');
    assert.equal(fs.existsSync(path.join(fixture.checkout, 'untracked.txt')), false);
});

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
