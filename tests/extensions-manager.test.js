import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    countPendingExtensionChanges,
    getExtensionManagerDescription,
    getExtensionManagerGroup,
    getExtensionManagerKey,
    matchesExtensionManagerFilter,
    normaliseExtensionSearchText,
    syncExtensionToggleState,
} from '../public/scripts/extensions-manager.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const read = file => fs.readFileSync(path.join(repoRoot, file), 'utf8');

function createClassList(initial = []) {
    const classes = new Set(initial);
    return {
        contains: name => classes.has(name),
        toggle: (name, force) => {
            const next = force === undefined ? !classes.has(name) : Boolean(force);
            if (next) classes.add(name); else classes.delete(name);
            return next;
        },
    };
}

function createToggleFixture(checked) {
    const nameWrapper = { classList: createClassList([checked ? 'extension_enabled' : 'extension_disabled']) };
    const stateLabel = { textContent: checked ? 'On' : 'Off' };
    const row = { dataset: { enabled: String(checked) }, querySelector: () => nameWrapper };
    const label = { querySelector: () => stateLabel };
    const input = {
        checked,
        classList: createClassList([checked ? 'toggle_disable' : 'toggle_enable']),
        closest: selector => (selector === '.extension_block' ? row : selector === '.extension_toggle' ? label : null),
    };
    return { input, row, nameWrapper, stateLabel };
}

describe('extensions manager helpers', () => {
    test('groups extensions into Neconyan tools, built-in features and installed by you', () => {
        expect(getExtensionManagerGroup('native')).toBe('neconyan');
        expect(getExtensionManagerGroup('local')).toBe('installed');
        expect(getExtensionManagerGroup('global')).toBe('installed');
        expect(getExtensionManagerGroup('core')).toBe('builtin');
        expect(getExtensionManagerGroup('system')).toBe('builtin');
        expect(getExtensionManagerGroup('bundled')).toBe('builtin');
    });

    test('keys extensions by folder name', () => {
        expect(getExtensionManagerKey('third-party/Neconyan-Deep-Swipe')).toBe('neconyan-deep-swipe');
        expect(getExtensionManagerKey('vectors')).toBe('vectors');
        expect(getExtensionManagerKey('')).toBe('');
    });

    test('prefers the manifest description and falls back to a plain built-in line', () => {
        expect(getExtensionManagerDescription('vectors', { description: '  Own words  ' })).toBe('Own words');
        for (const name of ['vectors', 'attachments', 'quick-reply', 'input-history', 'third-party/Neconyan-Deep-Swipe']) {
            const description = getExtensionManagerDescription(name, {});
            expect(description.length).toBeGreaterThan(10);
            expect(description).not.toMatch(/\u2014/);
        }
        expect(getExtensionManagerDescription('third-party/someone-else', {})).toBe('');
    });

    test('search ignores case and accents and needs every word', () => {
        expect(normaliseExtensionSearchText('  Café   TOOLS ')).toBe('cafe tools');
        const row = { searchText: 'Data Bank (Chat Attachments) Lets you attach files', enabled: true };
        expect(matchesExtensionManagerFilter(row, { query: 'data files' })).toBe(true);
        expect(matchesExtensionManagerFilter(row, { query: 'data swipe' })).toBe(false);
        expect(matchesExtensionManagerFilter(row, { query: '' })).toBe(true);
    });

    test('the On and Off filters follow the row state', () => {
        const on = { searchText: 'Meower', enabled: true };
        const off = { searchText: 'Meower', enabled: false };
        expect(matchesExtensionManagerFilter(on, { state: 'on' })).toBe(true);
        expect(matchesExtensionManagerFilter(off, { state: 'on' })).toBe(false);
        expect(matchesExtensionManagerFilter(off, { state: 'off' })).toBe(true);
        expect(matchesExtensionManagerFilter(on, { state: 'off' })).toBe(false);
        expect(matchesExtensionManagerFilter(off, { state: 'all' })).toBe(true);
    });

    test('counts only switches that moved away from their starting state', () => {
        expect(countPendingExtensionChanges([
            { initial: true, checked: true },
            { initial: true, checked: false },
            { initial: false, checked: true },
            { initial: false, checked: false },
        ])).toBe(2);
        expect(countPendingExtensionChanges([])).toBe(0);
    });

    test('syncing a switch flips the legacy classes, row state and visible label every time', () => {
        const { input, row, nameWrapper, stateLabel } = createToggleFixture(true);
        const labels = { on: 'On', off: 'Off' };

        input.checked = false;
        syncExtensionToggleState(input, labels);
        expect(input.classList.contains('toggle_enable')).toBe(true);
        expect(input.classList.contains('toggle_disable')).toBe(false);
        expect(row.dataset.enabled).toBe('false');
        expect(nameWrapper.classList.contains('extension_disabled')).toBe(true);
        expect(stateLabel.textContent).toBe('Off');

        input.checked = true;
        syncExtensionToggleState(input, labels);
        expect(input.classList.contains('toggle_disable')).toBe(true);
        expect(input.classList.contains('toggle_enable')).toBe(false);
        expect(row.dataset.enabled).toBe('true');
        expect(nameWrapper.classList.contains('extension_enabled')).toBe(true);
        expect(stateLabel.textContent).toBe('On');
    });
});

describe('extensions manager wiring', () => {
    const extensionsSource = read('public/scripts/extensions.js');

    test('switches are handled by one change listener that reads the checked state', () => {
        expect(extensionsSource).toMatch(/\.on\('change', '\.extensions_info \.extension_block \.extension_toggle input:not\(\.extension_missing\)', onExtensionToggleChange\)/);
        expect(extensionsSource).not.toMatch(/\.extension_block \.toggle_disable', onDisableExtensionClick/);
        expect(extensionsSource).not.toMatch(/\.extension_block \.toggle_enable', onEnableExtensionClick/);
        expect(extensionsSource).toMatch(/function onExtensionToggleChange\(\)[\s\S]*?this\.checked/);
    });

    test('the window loads its own stylesheet, in step with the Extensions page', () => {
        const match = extensionsSource.match(/EXTENSIONS_PANEL_STYLESHEET = '([^']+)'/);
        expect(match).not.toBeNull();
        expect(extensionsSource).toMatch(/async function showExtensionsDetails\(\)\s*\{[\s\S]{0,1200}loadStylesheetAsync\(EXTENSIONS_PANEL_STYLESHEET/);
        expect(read('public/scripts/neconyan-tabs.js')).toContain(`href: '${match[1]}'`);
    });

    test('the switch keeps a reduced-motion guard', () => {
        const css = read('public/css/extensions-panel.css');
        expect(css).toMatch(/\.nn-ext-manager \.extension_toggle input[^{]*\{[^}]*transition:/);
        expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.nn-ext-manager[\s\S]*?transition: none/);
    });

    test('selected states follow the secondary accent', () => {
        const css = read('public/css/extensions-panel.css');
        expect(css).toMatch(/\.nn-ext-manager \{[^}]*--nn-ext-select: var\(--neco-accent-secondary,/);
        expect(css).toMatch(/\.nn-ext-filter\[aria-pressed="true"\] \{[^}]*var\(--nn-ext-select\)/);
        expect(css).toMatch(/\.extension_toggle input\[type="checkbox"\]:checked \{[^}]*background: var\(--nn-ext-select\)/);
        expect(css).toMatch(/\.extension_block\[data-enabled="true"\] \{[^}]*var\(--nn-ext-select\)/);
    });
});
