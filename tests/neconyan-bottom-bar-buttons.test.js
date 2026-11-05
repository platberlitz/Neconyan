import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    BOTTOM_CHAT_BAR_ACTIONS_ORDER,
    BOTTOM_CHAT_BAR_BUTTON_LABELS,
    BOTTOM_CHAT_BAR_LAYOUT_STORAGE_KEY,
    BOTTOM_CHAT_BAR_MAIN_ORDER,
    normalizeBottomChatBarLayout,
    parseBottomChatBarLayout,
    readBottomChatBarLayout,
    serializeBottomChatBarLayout,
    writeBottomChatBarLayout,
} from '../public/scripts/neconyan-bottom-bar-layout.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');
const tabsSource = readSource('public', 'scripts', 'neconyan-tabs.js');

function getTabsFunctionSource(name) {
    return tabsSource.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0] ?? '';
}

function createStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem: key => (values.has(key) ? values.get(key) : null),
        setItem: (key, value) => { values.set(key, value); },
        removeItem: key => { values.delete(key); },
        values,
    };
}

describe('bottom chat bar layout model', () => {
    test('normalizes empty input to the default order with nothing hidden', () => {
        const layout = normalizeBottomChatBarLayout(null);
        expect(layout).toEqual({
            order: { main: [...BOTTOM_CHAT_BAR_MAIN_ORDER], actions: [...BOTTOM_CHAT_BAR_ACTIONS_ORDER] },
            hidden: [],
        });
    });

    test('labels every control in both zones', () => {
        expect([...BOTTOM_CHAT_BAR_MAIN_ORDER, ...BOTTOM_CHAT_BAR_ACTIONS_ORDER].every(id => typeof BOTTOM_CHAT_BAR_BUTTON_LABELS[id] === 'string')).toBe(true);
        expect(Object.keys(BOTTOM_CHAT_BAR_BUTTON_LABELS).sort()).toEqual([...BOTTOM_CHAT_BAR_MAIN_ORDER, ...BOTTOM_CHAT_BAR_ACTIONS_ORDER].sort());
    });

    test('drops unknown ids, duplicates and cross-zone entries, then appends missing controls in default order', () => {
        const layout = normalizeBottomChatBarLayout({
            order: {
                main: ['deleteChat', 'persona', 'persona', 'ghost', 'chats'],
                actions: ['persona', 'deleteChat', 'regenerate'],
            },
            hidden: ['ghost', 'massDelete', 'massDelete', 'regenerate'],
        });

        expect(layout.order.main).toEqual(['persona', 'chats', 'reasoning', 'search', 'scroll', 'collapse']);
        expect(layout.order.actions).toEqual(['deleteChat', 'regenerate', 'scratchpad', 'purrks', 'files', 'newChat', 'massDelete', 'autoName', 'rename', 'searchToggle', 'hideBar']);
        expect(layout.hidden).toEqual(['massDelete', 'regenerate']);
    });

    test('ignores malformed entries and parses broken JSON back to defaults', () => {
        expect(parseBottomChatBarLayout('not json at all')).toEqual(normalizeBottomChatBarLayout(null));
        expect(parseBottomChatBarLayout('{"order":{"main":[42,null]}}').order.main).toEqual([...BOTTOM_CHAT_BAR_MAIN_ORDER]);
    });

    test('round-trips through serialize and read', () => {
        const storage = createStorage();
        writeBottomChatBarLayout(storage, { order: { main: ['search', ...BOTTOM_CHAT_BAR_MAIN_ORDER.filter(id => id !== 'search')] }, hidden: ['reasoning'] });
        expect(storage.values.get(BOTTOM_CHAT_BAR_LAYOUT_STORAGE_KEY)).toBe(serializeBottomChatBarLayout({
            order: { main: ['search', ...BOTTOM_CHAT_BAR_MAIN_ORDER.filter(id => id !== 'search')] },
            hidden: ['reasoning'],
        }));

        const read = readBottomChatBarLayout(storage);
        expect(read.order.main[0]).toBe('search');
        expect(read.hidden).toEqual(['reasoning']);
    });

    test('a broken or missing store falls back to defaults', () => {
        expect(readBottomChatBarLayout(null)).toEqual(normalizeBottomChatBarLayout(null));
        expect(readBottomChatBarLayout({ getItem: () => { throw new Error('blocked'); } })).toEqual(normalizeBottomChatBarLayout(null));
    });
});

describe('bottom chat bar layout wiring in neconyan-tabs.js', () => {
    test('the layout module is imported and the storage key is registered self-contained', () => {
        expect(tabsSource).toContain('from \'./neconyan-bottom-bar-layout.js\'');
        // Slicing suites (topbar-label-persistence) evaluate the NN_STORAGE_KEYS
        // block in a bare VM, so it must not reference imports; the literal has
        // to match the module's exported key.
        expect(tabsSource).toContain(`bottomChatBarButtons: '${BOTTOM_CHAT_BAR_LAYOUT_STORAGE_KEY}',`);
        const keysBlock = tabsSource.match(/const NN_STORAGE_KEYS = Object\.freeze\(\{[\s\S]*?\n\}\);/)[0];
        const keys = new Function(`${keysBlock}; return NN_STORAGE_KEYS;`)();
        expect(keys.bottomChatBarButtons).toBe(BOTTOM_CHAT_BAR_LAYOUT_STORAGE_KEY);
    });

    test('every unit matches a control in the layout model zones', () => {
        const unitMatches = [...tabsSource.matchAll(/id: '([a-zA-Z]+)',\s*zone: '(main|actions)'/g)].map(([, id, zone]) => `${zone}:${id}`);
        expect(unitMatches.sort()).toEqual([
            ...BOTTOM_CHAT_BAR_MAIN_ORDER.map(id => `main:${id}`),
            ...BOTTOM_CHAT_BAR_ACTIONS_ORDER.map(id => `actions:${id}`),
        ].sort());
    });

    test('building the bar applies the stored layout', () => {
        const buildSource = getTabsFunctionSource('buildBottomChatBar');
        expect(buildSource).toContain('applyBottomChatBarButtonLayout();');
        expect(buildSource).toContain('scratchpadButton: scratchpadBtn');
        expect(buildSource).toContain('newChatButton: newBtn');
        expect(buildSource).toContain('renameButton: renameBtn');
        expect(buildSource).toContain('deleteButton: deleteBtn');
    });

    test('the settings group is created for both viewports and mounted in both outlets and fallback lists', () => {
        expect(tabsSource).toContain('createBottomChatBarButtonSettingsGroup(\'desktop\')');
        expect(tabsSource).toContain('createBottomChatBarButtonSettingsGroup(\'mobile\')');
        expect(tabsSource.split('desktopBottomChatBarButtonSettingsGroup,').length - 1).toBe(2);
        expect(tabsSource.split('mobileBottomChatBarButtonSettingsGroup,').length - 1).toBe(2);
    });

    test('hiding every action hides the actions row and its collapse toggle together', () => {
        const applySource = getTabsFunctionSource('applyBottomChatBarButtonLayout');
        expect(applySource).toContain('state.secondaryRow.classList.toggle(\'displayNone\', !hasVisibleActions)');
        expect(applySource).toContain('state.collapseToggleButton.classList.toggle(\'displayNone\', !hasVisibleActions)');
    });
});
