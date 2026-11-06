import { describe, expect, test } from '@jest/globals';
import envPaths from 'env-paths';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_NAME } from '../src/runtime.js';
import { CommandLineParser } from '../src/command-line.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
const electronPackageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src', 'electron', 'package.json'), 'utf8'));
const electronPackageLock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src', 'electron', 'package-lock.json'), 'utf8'));
const tabsSource = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'neconyan-tabs.js'), 'utf8');
const iosProjectSource = fs.readFileSync(path.join(repoRoot, 'ios', 'project.yml'), 'utf8');
const iosPayloadBuilderSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-ios-payload.js'), 'utf8');

describe('Neconyan project boundaries', () => {
    test('uses independent 1.0 package metadata and executable naming', () => {
        expect(packageJson).toMatchObject({
            name: 'neconyan',
            version: '1.5.1',
            bin: { neconyan: './src/server-global.js' },
        });
        expect(packageJson.repository).toBeUndefined();
        expect(Object.keys(packageJson.bin)).toEqual(['neconyan']);

        expect(packageLock).toMatchObject({ name: 'neconyan', version: '1.5.1' });
        expect(packageLock.packages['']).toMatchObject({
            name: 'neconyan',
            version: '1.5.1',
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

        expect(iosProjectSource).not.toMatch(/^\s*MARKETING_VERSION:/m);
        expect(iosProjectSource).not.toMatch(/^\s*CURRENT_PROJECT_VERSION:/m);
        expect(iosProjectSource).toMatch(/configFiles:\s+Debug: generated\/version\.xcconfig\s+Release: generated\/version\.xcconfig/);
        expect(iosPayloadBuilderSource).toContain('ios/generated/version.xcconfig');
        expect(iosPayloadBuilderSource).toContain('MARKETING_VERSION = ${provenance.version}');
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
