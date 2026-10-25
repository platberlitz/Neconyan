import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/scripts/extensions/quick-image-gen/index.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/scripts/extensions/quick-image-gen/style.css', import.meta.url), 'utf8');

function slice(from, to) {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start);
    if (start < 0 || end < 0) throw new Error(`Could not find ${from}`);
    return source.slice(start, end);
}

function fakeElement(id) {
    const classes = new Set();
    return {
        id,
        hidden: false,
        value: '',
        onclick: null,
        attributes: {},
        focused: false,
        setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return this.attributes[name] ?? null; },
        focus() { this.focused = true; },
        classList: {
            toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
            contains(name) { return classes.has(name); },
        },
    };
}

function loadTabs(settings) {
    const ids = [
        'qig-tab-provider', 'qig-tab-prompting', 'qig-tab-context', 'qig-tab-automation', 'qig-tab-search',
        'qig-section-provider-content', 'qig-section-create-content', 'qig-section-context-content',
        'qig-section-automation-content', 'qig-settings-search-shell', 'qig-settings-search', 'qig-setup-panel',
    ];
    const elements = Object.fromEntries(ids.map(id => [id, fakeElement(id)]));
    const document = { getElementById: id => elements[id] || null };
    let saves = 0;
    const code = [
        slice('const QIG_DEFAULT_COLLAPSED_SECTIONS', 'let qigKeyboardShortcutsBound'),
        slice('function getCollapsedSections', 'function setCollapsedSection'),
        slice('const QIG_SETTINGS_TABS', 'function setupSettingsSearch'),
        'return { setupQigSettingsTabs, selectQigSettingsTab, getStoredQigSettingsTab };',
    ].join('\n');
    const api = new Function('document', 'getSettings', 'saveSettingsDebounced', code)(
        document,
        () => settings,
        () => { saves += 1; },
    );
    return { api, elements, saves: () => saves };
}

describe('Quick Image Gen settings tabs', () => {
    test('a fresh profile starts with every tab closed', () => {
        const { api, elements } = loadTabs({});
        api.setupQigSettingsTabs();
        for (const id of ['qig-tab-provider', 'qig-tab-prompting', 'qig-tab-context', 'qig-tab-automation', 'qig-tab-search']) {
            expect(elements[id].getAttribute('aria-expanded')).toBe('false');
        }
        expect(elements['qig-section-provider-content'].hidden).toBe(true);
        expect(elements['qig-setup-panel'].classList.contains('qig-settings-area--open')).toBe(false);
    });

    test('one tab opens at a time, pressing it again closes it, and the choice is saved', () => {
        const settings = {};
        const { elements, api, saves } = loadTabs(settings);
        api.setupQigSettingsTabs();

        elements['qig-tab-provider'].onclick();
        expect(elements['qig-tab-provider'].getAttribute('aria-expanded')).toBe('true');
        expect(elements['qig-section-provider-content'].hidden).toBe(false);
        expect(settings.collapsedSections).toMatchObject({ setupPanel: false, sectionProvider: false, sectionCreate: true });

        elements['qig-tab-context'].onclick();
        expect(elements['qig-section-provider-content'].hidden).toBe(true);
        expect(elements['qig-section-context-content'].hidden).toBe(false);
        expect(api.getStoredQigSettingsTab(settings)).toBe('sectionContext');

        elements['qig-tab-context'].onclick();
        expect(elements['qig-section-context-content'].hidden).toBe(true);
        expect(settings.collapsedSections.setupPanel).toBe(true);
        expect(api.getStoredQigSettingsTab(settings)).toBe(null);
        expect(saves()).toBe(3);
    });

    test('the search tab focuses the box and is never remembered', () => {
        const settings = { collapsedSections: { setupPanel: false, sectionProvider: false } };
        const { elements, api } = loadTabs(settings);
        api.setupQigSettingsTabs();
        expect(elements['qig-section-provider-content'].hidden).toBe(false);

        elements['qig-tab-search'].onclick();
        expect(elements['qig-settings-search-shell'].hidden).toBe(false);
        expect(elements['qig-section-provider-content'].hidden).toBe(true);
        expect(elements['qig-settings-search'].focused).toBe(true);
        expect(api.getStoredQigSettingsTab(settings)).toBe('sectionProvider');
    });

    test('the panel markup uses the tab row instead of nested section folds', () => {
        expect(source).toContain('class="qig-settings-tabs"');
        expect(source).not.toContain('id="qig-setup-toggle"');
        expect(source).not.toMatch(/id="qig-section-(provider|create|context|automation)-toggle"/);
        expect(source).toContain('id="qig-generate-btn" class="menu_button menu_button_primary qig-primary-action"');
        expect(css).not.toMatch(/\.qig-settings-tab[^{]*\{[^}]*#[0-9a-f]{3,8}\b/i);
    });
});
