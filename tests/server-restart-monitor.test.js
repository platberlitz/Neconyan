import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from '@jest/globals';

import { getServerBootId } from '../src/server-boot-marker.js';
import { hasServedCodeChanged, hasServerReturnedAfterRestart } from '../public/scripts/server-restart-monitor.js';

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
