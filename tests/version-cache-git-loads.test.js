import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const temporaryDirectories = [];
let activeHarness = null;

function deferred() {
    let resolve;
    const promise = new Promise(done => {
        resolve = done;
    });
    return { promise, resolve };
}

function createClient(harness, state) {
    const command = async (name, args) => {
        harness.commands.push([name, ...args]);
        if (harness.loads <= harness.failLoads) {
            throw new Error('Simulated Git failure');
        }
        if (harness.gate?.label === name) {
            harness.gate.reached.resolve();
            await harness.gate.promise;
        }
    };

    return {
        async raw(args) {
            await command(args[0] === 'config' ? 'config' : 'log', args);
            if (args[0] === 'config') {
                return state.configList;
            }
            const signature = state.showSignature && !args.includes('--no-show-signature') ? 'gpg: Good signature\n' : '';
            return `${signature}${state.short}\n${state.full}\n${state.date}\n`;
        },
        async revparse(args) {
            await command('revparse', args);
            if (args[0] === '--abbrev-ref') {
                return state.branch;
            }
            if (args[0] === '--symbolic-full-name') {
                if (!state.upstreamRef) {
                    throw new Error('No upstream');
                }
                return state.upstreamRef;
            }
            if (args[0] === state.upstreamRef) {
                return state.upstreamHash;
            }
            throw new Error(`Unexpected revparse: ${args.join(' ')}`);
        },
    };
}

const simpleGitMock = jest.fn(() => {
    if (!activeHarness) {
        throw new Error('No active version test harness');
    }
    activeHarness.loads++;
    return createClient(activeHarness, { ...activeHarness.state });
});

jest.unstable_mockModule('simple-git', () => ({ default: simpleGitMock, simpleGit: simpleGitMock }));

const { getVersion } = await import('../src/util.js');

function write(pathName, contents) {
    fs.mkdirSync(path.dirname(pathName), { recursive: true });
    fs.writeFileSync(pathName, contents);
}

function createHarness({ withUpstream = true } = {}) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-version-loads-'));
    temporaryDirectories.push(base);
    const root = path.join(base, 'repo');
    const gitDir = path.join(root, '.git');
    const full = 'a'.repeat(40);
    const configPath = path.join(gitDir, 'config');
    const configText = withUpstream
        ? '[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n'
        : '';

    write(path.join(root, 'package.json'), JSON.stringify({ name: 'loads-test', version: '1.2.3' }));
    write(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    write(path.join(gitDir, 'refs', 'heads', 'main'), `${full}\n`);
    write(configPath, configText);
    if (withUpstream) {
        write(path.join(gitDir, 'refs', 'remotes', 'origin', 'main'), `${full}\n`);
    }

    const harness = {
        root,
        gitDir,
        configPath,
        loads: 0,
        failLoads: 0,
        gate: null,
        commands: [],
        state: {
            short: 'aaaaaaa',
            full,
            date: '2026-10-25 10:00:00 +0000',
            branch: 'main',
            upstreamRef: withUpstream ? 'refs/remotes/origin/main' : null,
            upstreamHash: withUpstream ? full : null,
            configList: withUpstream
                ? `file:${configPath}\tbranch.main.remote=origin\nfile:${configPath}\tbranch.main.merge=refs/heads/main`
                : '',
        },
    };
    activeHarness = harness;
    return harness;
}

beforeEach(() => {
    activeHarness = null;
    simpleGitMock.mockClear();
});

afterEach(() => {
    while (temporaryDirectories.length) {
        fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
    }
});

describe('getVersion Git loading', () => {
    test('serves warm reads without starting Git', async () => {
        const harness = createHarness();
        const first = await getVersion(harness.root);
        const loads = harness.loads;
        const commands = harness.commands.length;

        expect(first).toMatchObject({ gitBranch: 'main', gitRevision: 'aaaaaaa', isLatest: true });
        await expect(getVersion(harness.root)).resolves.toEqual(first);

        expect(harness.loads).toBe(loads);
        expect(harness.commands.length).toBe(commands);
    });

    test('keeps the package-only fallback when package.json is unavailable', async () => {
        const harness = createHarness();
        fs.rmSync(path.join(harness.root, 'package.json'));

        await expect(getVersion(harness.root)).resolves.toEqual({
            agent: 'Neconyan:UNKNOWN',
            pkgVersion: 'UNKNOWN',
            gitRevision: null,
            gitBranch: null,
            commitDate: null,
            isLatest: true,
        });
        expect(harness.loads).toBe(0);
    });

    test('coalesces 24 concurrent cold reads into one Git load', async () => {
        const harness = createHarness();
        const results = await Promise.all(Array.from({ length: 24 }, () => getVersion(harness.root)));

        expect(harness.loads).toBe(1);
        expect(new Set(results.map(result => JSON.stringify(result))).size).toBe(1);
    });

    test('starts one new Git load when HEAD changes', async () => {
        const harness = createHarness();
        await getVersion(harness.root);
        const loads = harness.loads;

        write(path.join(harness.gitDir, 'refs', 'heads', 'other'), `${harness.state.full}\n`);
        write(path.join(harness.gitDir, 'HEAD'), 'ref: refs/heads/other\n');
        harness.state.branch = 'other';

        await expect(getVersion(harness.root)).resolves.toMatchObject({ gitBranch: 'other' });
        expect(harness.loads).toBe(loads + 1);
    });

    test('retries failed loads instead of caching the fallback', async () => {
        const harness = createHarness();
        harness.failLoads = 1;

        await expect(getVersion(harness.root)).resolves.toMatchObject({ gitRevision: null, gitBranch: null });
        await expect(getVersion(harness.root)).resolves.toMatchObject({ gitRevision: 'aaaaaaa', gitBranch: 'main' });

        expect(harness.loads).toBe(2);
    });

    test('does not cache a result when HEAD changes during a cold load', async () => {
        const harness = createHarness();
        const gate = deferred();
        harness.gate = { label: 'log', reached: deferred(), promise: gate.promise };
        const firstLoad = getVersion(harness.root);
        await harness.gate.reached.promise;

        write(path.join(harness.gitDir, 'refs', 'heads', 'other'), `${harness.state.full}\n`);
        write(path.join(harness.gitDir, 'HEAD'), 'ref: refs/heads/other\n');
        harness.state.branch = 'other';
        gate.resolve();

        await expect(firstLoad).resolves.toMatchObject({ gitBranch: 'main' });
        const loads = harness.loads;
        await expect(getVersion(harness.root)).resolves.toMatchObject({ gitBranch: 'other' });
        expect(harness.loads).toBe(loads + 1);
    });

    test('does not let an older async load replace a newer cached result', async () => {
        const harness = createHarness();
        const release = deferred();
        harness.gate = { label: 'log', reached: deferred(), promise: release.promise };
        const olderLoad = getVersion(harness.root);
        await harness.gate.reached.promise;
        harness.gate = null;

        write(path.join(harness.gitDir, 'refs', 'heads', 'other'), `${harness.state.full}\n`);
        write(path.join(harness.gitDir, 'HEAD'), 'ref: refs/heads/other\n');
        harness.state.branch = 'other';

        await expect(getVersion(harness.root)).resolves.toMatchObject({ gitBranch: 'other' });
        const loads = harness.loads;
        release.resolve();
        await expect(olderLoad).resolves.toMatchObject({ gitBranch: 'main' });

        await expect(getVersion(harness.root)).resolves.toMatchObject({ gitBranch: 'other' });
        expect(harness.loads).toBe(loads);
    });

    test('does not cache when reftable tables.list changes', async () => {
        const harness = createHarness();
        const tables = path.join(harness.gitDir, 'reftable', 'tables.list');
        write(tables, 'table-1\n');
        await getVersion(harness.root);
        const loads = harness.loads;

        write(tables, 'table-1\ntable-2\n');
        await getVersion(harness.root);

        expect(harness.loads).toBe(loads + 1);
    });

    test('does not cache when branch settings or include directives are external', async () => {
        const harness = createHarness();
        const external = path.join(path.dirname(harness.root), 'global-config');
        write(external, '[branch "main"]\n\tremote = origin\n');
        harness.state.configList = `file:${external}\tbranch.main.remote=origin`;

        await getVersion(harness.root);
        await getVersion(harness.root);
        expect(harness.loads).toBe(2);

        harness.state.configList = `file:${harness.configPath}\tinclude.path=${external}`;
        await getVersion(harness.root);
        await getVersion(harness.root);
        expect(harness.loads).toBe(4);

        harness.state.configList = `file:${harness.configPath}\tincludeif.gitdir:/tmp/.path=${external}`;
        await getVersion(harness.root);
        await getVersion(harness.root);
        expect(harness.loads).toBe(6);
    });

    test('invalidates a linked worktree when its own reftable stack changes', async () => {
        const harness = createHarness({ withUpstream: false });
        const commonDir = path.join(path.dirname(harness.root), 'common');
        const tables = path.join(harness.gitDir, 'reftable', 'tables.list');
        write(path.join(commonDir, 'config'), '');
        write(path.join(harness.gitDir, 'commondir'), commonDir);
        write(path.join(harness.gitDir, 'HEAD'), 'ref: refs/heads/.invalid\n');
        write(tables, 'worktree-1\n');

        await getVersion(harness.root);
        await getVersion(harness.root);
        expect(harness.loads).toBe(1);

        write(tables, 'worktree-2\n');
        harness.state.branch = 'other';
        await expect(getVersion(harness.root)).resolves.toMatchObject({ gitBranch: 'other' });
        expect(harness.loads).toBe(2);
    });

    test('does not parse signature display text as the revision', async () => {
        const harness = createHarness();
        harness.state.showSignature = true;
        await expect(getVersion(harness.root)).resolves.toMatchObject({
            gitRevision: harness.state.short,
            commitDate: harness.state.date,
        });
    });

    test('does not cache while Git environment overrides are present', async () => {
        const harness = createHarness();
        process.env.GIT_CONFIG_COUNT = '1';
        try {
            await getVersion(harness.root);
            await getVersion(harness.root);
        } finally {
            delete process.env.GIT_CONFIG_COUNT;
        }

        expect(harness.loads).toBe(2);
    });
});
