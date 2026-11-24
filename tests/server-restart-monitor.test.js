import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from '@jest/globals';

import { getServerBootId } from '../src/server-boot-marker.js';
import { describeServedCodeChange, hasServedCodeChanged, hasServerReturnedAfterRestart, isPlaceholderPackageVersion } from '../public/scripts/server-restart-monitor.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

describe('server restart monitor', () => {
    test('recognizes restart completion from a changed server boot marker', () => {
        expect(hasServerReturnedAfterRestart({ serverBootId: 'next' }, { previousServerBootId: 'previous' })).toBe(true);
        expect(hasServerReturnedAfterRestart({ serverBootId: 'same' }, { previousServerBootId: 'same' })).toBe(false);
    });

    test('keeps existing revision, version, and offline fallback checks', () => {
        expect(hasServerReturnedAfterRestart({ gitRevision: 'abc' }, { expectedRevision: 'abc' })).toBe(true);
        expect(hasServerReturnedAfterRestart({ pkgVersion: '1.2.3' }, { expectedVersion: '1.2.3' })).toBe(true);
        expect(hasServerReturnedAfterRestart({}, { sawOffline: true })).toBe(true);
        expect(hasServerReturnedAfterRestart({ gitRevision: 'old', pkgVersion: '1.2.2' }, {
            expectedRevision: 'new',
            expectedVersion: '1.2.3',
        })).toBe(false);
    });

    test('notices that an open page runs code from before a server update', () => {
        const loaded = { gitRevision: 'c0c45f10', pkgVersion: '1.3.6', serverBootId: 'first' };
        expect(hasServedCodeChanged(loaded, { ...loaded, gitRevision: '722b034a' })).toBe(true);
        expect(hasServedCodeChanged(loaded, { ...loaded, pkgVersion: '1.3.7' })).toBe(true);
        // A plain restart of the same code keeps the page.
        expect(hasServedCodeChanged(loaded, { ...loaded, serverBootId: 'second' })).toBe(false);
        // A missing value never forces a reload.
        expect(hasServedCodeChanged(loaded, {})).toBe(false);
        expect(hasServedCodeChanged(null, loaded)).toBe(false);
        expect(hasServedCodeChanged({ gitRevision: '' }, { gitRevision: 'abc' })).toBe(false);
    });

    test('a longer or shorter abbreviation of the same commit is not an update', () => {
        const loaded = { gitRevision: 'c0c45f1', pkgVersion: '1.3.6' };
        expect(hasServedCodeChanged(loaded, { ...loaded, gitRevision: 'c0c45f10' })).toBe(false);
        expect(hasServedCodeChanged({ ...loaded, gitRevision: 'c0c45f10a2' }, loaded)).toBe(false);
        expect(hasServedCodeChanged(loaded, { ...loaded, gitRevision: 'C0C45F10' })).toBe(false);
        expect(hasServedCodeChanged(loaded, { ...loaded, gitRevision: 'c0c45f10a2b3c4d5e6f708192a3b4c5d6e7f8091' })).toBe(false);
        // A different commit that happens to share a start is still a different commit.
        expect(hasServedCodeChanged(loaded, { ...loaded, gitRevision: 'c0c45e10' })).toBe(true);
        // Values shorter than seven characters, or not hex, are only equal when identical.
        expect(hasServedCodeChanged({ gitRevision: 'c0c4' }, { gitRevision: 'c0c45f10' })).toBe(true);
        expect(hasServedCodeChanged({ gitRevision: 'c0c45f1' }, { gitRevision: 'c0c45f1z' })).toBe(true);
        expect(hasServedCodeChanged({ gitRevision: 'main-build' }, { gitRevision: 'main-build-2' })).toBe(true);
        expect(hasServedCodeChanged({ gitRevision: 'abc' }, { gitRevision: 'abc' })).toBe(false);
    });

    test('an unreadable package version on either side is not an update', () => {
        const loaded = { gitRevision: 'c0c45f10', pkgVersion: '1.3.6' };
        expect(hasServedCodeChanged(loaded, { ...loaded, pkgVersion: 'UNKNOWN' })).toBe(false);
        expect(hasServedCodeChanged({ ...loaded, pkgVersion: 'UNKNOWN' }, loaded)).toBe(false);
        expect(hasServedCodeChanged({ ...loaded, pkgVersion: 'unknown' }, { ...loaded, pkgVersion: '1.3.7' })).toBe(false);
        // The commit still decides when the version cannot.
        expect(hasServedCodeChanged(loaded, { gitRevision: '722b034a', pkgVersion: 'UNKNOWN' })).toBe(true);
        expect(hasServedCodeChanged(loaded, { ...loaded, pkgVersion: '1.3.7' })).toBe(true);
    });

    test('placeholder package versions are recognised', () => {
        expect(isPlaceholderPackageVersion('UNKNOWN')).toBe(true);
        expect(isPlaceholderPackageVersion(' unknown ')).toBe(true);
        expect(isPlaceholderPackageVersion('0.0.0')).toBe(true);
        expect(isPlaceholderPackageVersion('1.3.6')).toBe(false);
        expect(isPlaceholderPackageVersion('')).toBe(false);
        expect(isPlaceholderPackageVersion(undefined)).toBe(false);
    });

    test('describes the change behind a served-code reload for the crash diagnostics', () => {
        const loaded = { gitRevision: 'c0c45f10', pkgVersion: '1.3.6' };
        expect(describeServedCodeChange(loaded, { ...loaded, gitRevision: '722b034a' })).toEqual({ from: 'c0c45f10', to: '722b034a' });
        expect(describeServedCodeChange(loaded, { ...loaded, pkgVersion: '1.3.7' })).toEqual({ from: '1.3.6', to: '1.3.7' });
        expect(describeServedCodeChange(loaded, { ...loaded, gitRevision: 'c0c45f10a2' })).toEqual({});
        expect(describeServedCodeChange(null, null)).toEqual({});
    });

    test('every reload that Neconyan starts for an update leaves a note with its reason first', () => {
        const scriptSource = fs.readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8');
        const tabsSource = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'neconyan-tabs.js'), 'utf8');
        const note = reason => new RegExp(`noteReload\\?\\.\\(\\{ reason: '${reason}'[^\\n]*\\n(?:[^\\n]*\\n)?\\s*(?:return )?(?:window\\.)?location\\.reload\\(`);

        expect(scriptSource).toMatch(note('served-code-changed'));
        expect(scriptSource).toMatch(note('update-toast'));
        expect(scriptSource).toMatch(note('settings-conflict'));
        expect(scriptSource).toMatch(/noteReload\?\.\(\{ reason: 'cache-cleared-after-update'[^\n]*\n\s*window\.setTimeout\(\(\) => window\.location\.reload\(true\)/);
        expect(tabsSource).toMatch(note('server-restarted'));
        expect(tabsSource.match(/noteReload\?\.\(\{ reason: 'import-finished' \}\);\n\s*location\.reload\(\)/g)).toHaveLength(3);
    });

    test('a placeholder version never clears the cache and reloads', () => {
        const scriptSource = fs.readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8');
        expect(scriptSource).toMatch(/isPlaceholderPackageVersion\(previousVersion\) \|\| isPlaceholderPackageVersion\(currentVersion\)\) \{\s*return false;/);
        expect(scriptSource).toContain('maybeAutoClearCacheOnVersionChange(isVersionChanged, settings.currentVersion)');
    });

    test('a returning tab checks the served code and only reloads itself when nothing is in progress', () => {
        const scriptSource = fs.readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8');

        expect(scriptSource).toContain('loadedServerVersion = data;');
        expect(scriptSource).toContain('document.addEventListener(\'visibilitychange\', checkServedCodeIsCurrent);');
        expect(scriptSource).toContain('window.addEventListener(\'pageshow\', checkServedCodeIsCurrent);');
        expect(scriptSource).toContain('fetch(\'/version\', { cache: \'no-store\' })');
        expect(scriptSource).toMatch(/function canReloadForServedCode\(\) \{[\s\S]*?!isGenerating\(\)[\s\S]*?this_edit_mes_id === undefined[\s\S]*?hasPendingChatSave\(\)[\s\S]*?#send_textarea/);
    });

    test('exposes a stable non-empty boot marker for the current process', () => {
        const bootId = getServerBootId();

        expect(bootId).toEqual(expect.any(String));
        expect(bootId.length).toBeGreaterThan(8);
        expect(getServerBootId()).toBe(bootId);
    });

    test('wires the boot marker through version and restart responses', () => {
        const serverMainSource = fs.readFileSync(path.join(repoRoot, 'src', 'server-main.js'), 'utf8');
        const serverAdminSource = fs.readFileSync(path.join(repoRoot, 'src', 'endpoints', 'server-admin.js'), 'utf8');
        const tabsSource = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'neconyan-tabs.js'), 'utf8');

        expect(serverMainSource).toContain('serverBootId: getServerBootId()');
        expect(serverAdminSource).toContain('serverBootId: getServerBootId()');
        expect(tabsSource).toContain('waitForServerReturn(\'\', { previousServerBootId: result?.serverBootId })');
    });
});
