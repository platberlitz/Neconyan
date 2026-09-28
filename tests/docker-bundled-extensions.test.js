import { describe, test, expect, afterAll, beforeAll } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NECONYAN_NATIVE_EXTENSIONS } from '../src/neconyan-native-extensions.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dockerignoreSource = readFileSync(path.join(repoRoot, '.dockerignore'), 'utf8');
const dockerfileSource = readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
const entrypointSource = readFileSync(path.join(repoRoot, 'docker', 'docker-entrypoint.sh'), 'utf8');

const THIRD_PARTY = 'public/scripts/extensions/third-party';

const shippedThirdParty = NECONYAN_NATIVE_EXTENSIONS
    .filter(extension => !extension.runtimeDirectory)
    .map(extension => extension.directory)
    .sort();

const dockerignoreLines = dockerignoreSource.split(/\r?\n/).map(line => line.trim());
const allowListed = dockerignoreLines
    .filter(line => line.startsWith(`!/${THIRD_PARTY}/`))
    .map(line => line.slice(`!/${THIRD_PARTY}/`.length).replace(/\/+$/, ''))
    .sort();

function listSourceFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return listSourceFiles(fullPath);
        return entry.name.endsWith('.js') ? [fullPath] : [];
    });
}

function extractShellFunction(source, name) {
    const lines = source.split('\n');
    const start = lines.findIndex(line => line.startsWith(`${name}() {`));
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((line, index) => index > start && line === '}');
    expect(end).toBeGreaterThan(start);
    return lines.slice(start, end + 1).join('\n');
}

describe('Docker image ships the bundled third-party extensions (issue #1)', () => {
    test('.dockerignore excludes the folder contents but keeps every shipped extension', () => {
        expect(dockerignoreLines).not.toContain(`/${THIRD_PARTY}`);
        expect(dockerignoreLines).toContain(`/${THIRD_PARTY}/*`);
        expect(allowListed).toEqual(shippedThirdParty);
    });

    test('every allow-listed extension exists in the repository', () => {
        for (const name of allowListed) {
            expect(statSync(path.join(repoRoot, THIRD_PARTY, name)).isDirectory()).toBe(true);
        }
    });

    test('every extension the server imports directly is allow-listed', () => {
        const referenced = new Set();
        for (const file of [path.join(repoRoot, 'server.js'), ...listSourceFiles(path.join(repoRoot, 'src'))]) {
            for (const match of readFileSync(file, 'utf8').matchAll(/third-party\/([A-Za-z0-9_-]+)\//g)) {
                referenced.add(match[1]);
            }
        }
        expect(referenced.size).toBeGreaterThan(0);
        for (const name of referenced) {
            expect(allowListed).toContain(name);
        }
    });

    test('Dockerfile keeps a pristine copy after the source is copied in', () => {
        const copySource = dockerfileSource.indexOf('COPY --chown=bun:bun . ./');
        const stash = dockerfileSource.indexOf(`cp -a ${THIRD_PARTY}/. bundled-extensions/`);
        expect(copySource).toBeGreaterThanOrEqual(0);
        expect(stash).toBeGreaterThan(copySource);
    });

    test('entrypoint restores bundled extensions after picking the user and before starting', () => {
        const modeSelection = entrypointSource.indexOf('# Mode Selection');
        const syncCall = entrypointSource.indexOf('\nsync_bundled_extensions "$EXEC_PREFIX"');
        const startCall = entrypointSource.indexOf('\nstart_neconyan "$EXEC_PREFIX" "$@"');
        expect(modeSelection).toBeGreaterThanOrEqual(0);
        expect(syncCall).toBeGreaterThan(modeSelection);
        expect(startCall).toBeGreaterThan(syncCall);
    });
});

function hasUsableSh() {
    try {
        return execFileSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' }).trim() === 'ok';
    } catch {
        return false;
    }
}

const describeShell = hasUsableSh() ? describe : describe.skip;

describeShell('sync_bundled_extensions', () => {
    const workDir = mkdtempSync(path.join(tmpdir(), 'nn-docker-extensions-'));
    const harnessPath = path.join(workDir, 'harness.sh');

    beforeAll(() => {
        writeFileSync(harnessPath, [
            extractShellFunction(entrypointSource, 'sync_bundled_extensions'),
            'sync_bundled_extensions ""',
            '',
        ].join('\n\n'));
    });

    afterAll(() => {
        rmSync(workDir, { recursive: true, force: true });
    });

    test('fills an empty mount, refreshes stale copies and leaves admin extensions alone', () => {
        const appDir = path.join(workDir, 'app');
        const target = path.join(appDir, THIRD_PARTY);
        mkdirSync(path.join(appDir, 'bundled-extensions', 'Neconyan-Hopper', 'server'), { recursive: true });
        mkdirSync(path.join(appDir, 'bundled-extensions', 'Neconyan-Story-Mode'), { recursive: true });
        writeFileSync(path.join(appDir, 'bundled-extensions', 'Neconyan-Hopper', 'server', 'job-receipts.js'), 'fresh');
        writeFileSync(path.join(appDir, 'bundled-extensions', 'Neconyan-Story-Mode', 'index.js'), 'story');
        mkdirSync(path.join(target, 'Neconyan-Hopper'), { recursive: true });
        writeFileSync(path.join(target, 'Neconyan-Hopper', 'stale.js'), 'old');
        mkdirSync(path.join(target, 'Admin-Extension'), { recursive: true });
        writeFileSync(path.join(target, 'Admin-Extension', 'manifest.json'), '{}');

        execFileSync('sh', [harnessPath], { cwd: appDir, stdio: 'pipe' });

        expect(readFileSync(path.join(target, 'Neconyan-Hopper', 'server', 'job-receipts.js'), 'utf8')).toBe('fresh');
        expect(existsSync(path.join(target, 'Neconyan-Hopper', 'stale.js'))).toBe(false);
        expect(readFileSync(path.join(target, 'Neconyan-Story-Mode', 'index.js'), 'utf8')).toBe('story');
        expect(readFileSync(path.join(target, 'Admin-Extension', 'manifest.json'), 'utf8')).toBe('{}');
    });

    test('does nothing outside the image, where there is no pristine copy', () => {
        const appDir = path.join(workDir, 'no-image');
        mkdirSync(path.join(appDir, THIRD_PARTY), { recursive: true });

        execFileSync('sh', [harnessPath], { cwd: appDir, stdio: 'pipe' });

        expect(readdirSync(path.join(appDir, THIRD_PARTY))).toEqual([]);
    });
});
