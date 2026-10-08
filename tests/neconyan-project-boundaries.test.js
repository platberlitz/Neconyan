/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import envPaths from 'env-paths';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_NAME } from '../src/runtime.js';
import { CommandLineParser } from '../src/command-line.js';
import { getLatestZipReleaseStatus, stageZipReleaseUpdate } from '../src/server-admin-zip-update.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
const electronPackageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src', 'electron', 'package.json'), 'utf8'));
const electronPackageLock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src', 'electron', 'package-lock.json'), 'utf8'));
const tabsSource = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'neconyan-tabs.js'), 'utf8');

describe('Neconyan project boundaries', () => {
    test('uses independent 1.0 package metadata and executable naming', () => {
        expect(packageJson).toMatchObject({
            name: 'neconyan',
            version: '1.2.2',
            bin: { neconyan: './src/server-global.js' },
        });
        expect(packageJson.repository).toBeUndefined();
        expect(Object.keys(packageJson.bin)).toEqual(['neconyan']);

        expect(packageLock).toMatchObject({ name: 'neconyan', version: '1.2.2' });
        expect(packageLock.packages['']).toMatchObject({
            name: 'neconyan',
            version: '1.2.2',
            bin: { neconyan: 'src/server-global.js' },
        });
        expect(Object.keys(packageLock.packages[''].bin)).toEqual(['neconyan']);

        expect(electronPackageJson).toMatchObject({
            name: 'neconyan-electron',
            version: '1.0.0',
            description: 'Electron server for Neconyan',
        });
        expect(electronPackageLock).toMatchObject({
            name: 'neconyan-electron',
            version: '1.0.0',
            packages: {
                '': { name: 'neconyan-electron', version: '1.0.0' },
            },
        });
    });

    test('uses Neconyan-specific global config and data paths', () => {
        const defaults = new CommandLineParser().getDefaultConfig(true);
        const expectedDataRoot = envPaths(APP_NAME, { suffix: '' }).data;

        expect(defaults.configPath).toBe(path.join(expectedDataRoot, 'config.yaml'));
        expect(defaults.dataRoot).toBe(path.join(expectedDataRoot, 'data'));
    });

    test('ships 4433 as the default server port', () => {
        expect(new CommandLineParser().getDefaultConfig(true).port).toBe(4433);

        const defaultConfig = fs.readFileSync(path.join(repoRoot, 'default', 'config.yaml'), 'utf8');
        expect(defaultConfig).toMatch(/^port: 4433$/m);
    });

    test('labels clean local Git projects without an upstream neutrally', () => {
        expect(tabsSource).toContain('if (!repository?.trackingBranch)');
        expect(tabsSource).toContain('pillLabel = \'Local project\';');
        expect(tabsSource).toContain('pillTone = \'neutral\';');
    });
});

describe('Neconyan ZIP update boundary', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    test('reports unsupported status without making a network request', async () => {
        const fetchMock = jest.fn();
        globalThis.fetch = fetchMock;

        await expect(getLatestZipReleaseStatus('1.0.0')).resolves.toMatchObject({
            supported: false,
            checked: false,
            canUpdate: false,
            currentVersion: '1.0.0',
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('refuses staging before making a network request', async () => {
        const fetchMock = jest.fn();
        globalThis.fetch = fetchMock;

        await expect(stageZipReleaseUpdate({ latestVersion: '2.0.0', assetUrl: 'https://example.test/release.zip' }))
            .rejects.toThrow('Neconyan ZIP updates are unavailable');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
