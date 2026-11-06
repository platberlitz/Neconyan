import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import realGit, { CheckRepoActions } from 'simple-git';

let root;
let extension;
let remote;
let fetchFailure;
let checkFailure;
let beforeFetch;
let fetches;

jest.unstable_mockModule('simple-git', () => ({
    CheckRepoActions,
    default: options => {
        const git = realGit(options);
        const raw = git.raw.bind(git);
        const check = git.checkIsRepo.bind(git);
        const addRemote = git.addRemote.bind(git);
        git.addRemote = name => addRemote(name, remote);
        git.checkIsRepo = (...args) => checkFailure ? Promise.reject(checkFailure) : check(...args);
        git.raw = async args => {
            if (args[0] === 'fetch') {
                fetches++;
                await beforeFetch?.();
                if (fetchFailure) throw fetchFailure;
            }
            return raw(args);
        };
        return git;
    },
}));
jest.unstable_mockModule('../src/util.js', () => ({
    getConfigValue: (_, fallback) => fallback,
    isValidUrl: () => true,
}));
const { ensureExtensionRepo } = await import('../src/endpoints/extensions.js');

beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-bootstrap-test-'));
    remote = path.join(root, 'remote');
    extension = path.join(root, 'installed');
    fs.mkdirSync(remote);
    fs.mkdirSync(extension);
    const git = realGit(remote);
    await git.init(['-b', 'main']);
    await git.addConfig('user.name', 'Fixture');
    await git.addConfig('user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(remote, 'index.js'), 'upstream');
    fs.writeFileSync(path.join(remote, 'upstream-only.txt'), 'not installed');
    await git.add('.');
    await git.commit('initial');
    fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({ homepage: 'https://example.invalid/extension' }));
    fs.writeFileSync(path.join(extension, 'index.js'), 'local adjustments');
    fs.writeFileSync(path.join(extension, 'local.txt'), 'keep me');
    fetchFailure = checkFailure = beforeFetch = undefined;
    fetches = 0;
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
});

function expectInstalledFiles() {
    expect(fs.readFileSync(path.join(extension, 'index.js'), 'utf8')).toBe('local adjustments');
    expect(fs.readFileSync(path.join(extension, 'local.txt'), 'utf8')).toBe('keep me');
    expect(fs.existsSync(path.join(extension, 'upstream-only.txt'))).toBe(false);
}

test('prepares Git separately and preserves installed files through concurrent checks', async () => {
    beforeFetch = () => {
        expectInstalledFiles();
        expect(fs.existsSync(path.join(extension, '.git'))).toBe(false);
    };
    expect(await Promise.all([ensureExtensionRepo(extension, true), ensureExtensionRepo(extension, true)])).toEqual([true, true]);
    expect(fetches).toBe(1);
    expectInstalledFiles();
    const git = realGit(extension);
    expect((await git.status()).isClean()).toBe(true);
    expect((await git.branch()).current).toBe('main');
    expect(await git.raw(['show', 'HEAD:index.js'])).toBe('local adjustments');
    expect(await ensureExtensionRepo(extension, true)).toBe(true);
    expect(fetches).toBe(1);
    expect(fs.readdirSync(root).sort()).toEqual(['installed', 'remote']);
});

test('failed fetching leaves the extension untouched and permits a later retry', async () => {
    fetchFailure = new Error('network unavailable');
    await expect(ensureExtensionRepo(extension, true)).rejects.toBe(fetchFailure);
    expectInstalledFiles();
    expect(fs.existsSync(path.join(extension, '.git'))).toBe(false);
    expect(fs.readdirSync(root).sort()).toEqual(['installed', 'remote']);
    fetchFailure = undefined;
    await expect(ensureExtensionRepo(extension, true)).resolves.toBe(true);
});

test('cleanup permission errors do not replace the fetch error or touch installed files', async () => {
    fetchFailure = new Error('original fetch error');
    const remove = fs.rmSync.bind(fs);
    jest.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
        if (path.basename(target).startsWith('.neconyan-ext-')) {
            throw Object.assign(new Error('locked temporary metadata'), { code: 'EACCES' });
        }
        return remove(target, options);
    });
    await expect(ensureExtensionRepo(extension, true)).rejects.toBe(fetchFailure);
    expectInstalledFiles();
    expect(fs.existsSync(path.join(extension, '.git'))).toBe(false);
    expect(console.warn).toHaveBeenCalled();
});

test.each(['unrecognised', 'inaccessible'])('preserves %s existing Git metadata', async kind => {
    fs.mkdirSync(path.join(extension, '.git'));
    const marker = path.join(extension, '.git', 'config');
    fs.writeFileSync(marker, 'existing metadata');
    if (kind === 'inaccessible') checkFailure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    await expect(ensureExtensionRepo(extension, true)).rejects.toThrow();
    expect(fs.readFileSync(marker, 'utf8')).toBe('existing metadata');
    expect(fetches).toBe(0);
    expectInstalledFiles();
});

test('does not replace metadata created while a fetch was running', async () => {
    beforeFetch = () => {
        fs.mkdirSync(path.join(extension, '.git'));
        fs.writeFileSync(path.join(extension, '.git', 'keep'), 'another process');
    };
    await expect(ensureExtensionRepo(extension, true)).rejects.toThrow('changed while preparing');
    expect(fs.readFileSync(path.join(extension, '.git', 'keep'), 'utf8')).toBe('another process');
    expectInstalledFiles();
});

test('does not bootstrap a local extension or one without a repository homepage', async () => {
    await expect(ensureExtensionRepo(extension, false)).resolves.toBe(false);
    fs.writeFileSync(path.join(extension, 'manifest.json'), '{}');
    await expect(ensureExtensionRepo(extension, true)).resolves.toBe(false);
    expect(fetches).toBe(0);
});
