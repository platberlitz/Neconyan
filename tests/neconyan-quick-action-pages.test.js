import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as railModel from '../public/scripts/mobile-shell-lifecycle/index.js';
import { createSearchMatcher } from '../public/scripts/util/fuzzy-search.js';

const source = readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8');
const functionSource = name => source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'))[0];

function harness() {
    const context = vm.createContext({
        nnMobileShellLifecycle: { railModel: {
            resolveQuickActionRoute: railModel.resolveMobileShellQuickActionRoute,
            normalizeQuickAction: railModel.normalizeMobileShellQuickAction,
            getQuickActionKey: railModel.getMobileShellQuickActionKey,
        } },
        normalizeText: value => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase(),
        getShellConfig: key => key === 'left' ? { title: 'Fine-tuning', baseTab: { id: 'sampling', label: 'Sampling' } } : null,
        getNeconyanNativeTools: () => [{ id: 'css-snippets', label: 'CSS Snippets', description: 'Edit CSS snippets.' }],
        NECONYAN_MODE_DEFINITIONS: [{ id: 'conversation', label: 'Conversation' }],
        activateNeconyanRailTool: jest.fn(),
        activateNeconyanMode: jest.fn(),
        NeconyanWelcome: { activateRoute: jest.fn() },
        document: { querySelector: () => null },
        HTMLElement: class {},
        CSS: { escape: value => value },
        window: { open: jest.fn() },
        createSearchMatcher,
        nnState: { shells: { left: { tabs: new Map([['sampling', { id: 'sampling' }]]) } } },
        getTabSearchEntries: () => Array.from({ length: 20 }, (_, i) => ({
            displayText: `Catelier setting ${i}`, searchText: `catelier setting ${i}`, tabId: 'sampling', dedupeKey: `setting::${i}`,
        })),
        getCharacterPanel: () => null,
        NN_ADVANCED_SEARCH_ROUTES: new Set(),
        NN_UNIVERSAL_SEARCH_PAGE_LIMIT: 3,
        NN_UNIVERSAL_SEARCH_RESULT_LIMIT: 12,
        NN_MOBILE_QUICK_ACTION_ICON_FALLBACK: 'fa-bolt',
        NN_MOBILE_QUICK_ACTION_LIMIT: 12,
        openShell: jest.fn(),
        openCharacterPanelTab: jest.fn(),
        getShellState: () => null,
        revealSearchMatch: jest.fn((shellKey, match) => match.action?.()),
    });
    vm.runInContext([
        source.match(/^const NN_SEARCH_PAGES = Object\.freeze\(\[[\s\S]*?^\]\.map\(page => Object\.freeze\(page\)\)\);/m)[0],
        source.match(/^const NN_CHARACTER_PANEL_TABS = Object\.freeze\(\[[\s\S]*?^\]\);/m)[0],
        ...['getCharacterPanelTabConfig', 'getSearchPageEntries', 'getQuickActionPageEntry', 'getMobileQuickActionTabConfig', 'getMobileQuickActionContext',
            'normalizeMobileQuickAction', 'normalizeMobileQuickActionList', 'getMobileQuickActionKey',
            'createMobileQuickActionFromMatch', 'getMobileQuickActionSearchSources', 'getMobileQuickActionSearchMatches', 'findMobileQuickActionMatch',
            'activateMobileQuickAction', 'getCharacterPanelSearchEntries', 'migrateLegacyMobileQuickAction', 'parseMobileQuickActionStorage'].map(functionSource),
    ].join('\n'), context);
    return context;
}

describe('Quick Actions shares the searchable page catalogue', () => {
    test('every page, included tool, mode and Handbook survives saving and opens its original destination', () => {
        const context = harness();
        for (const entry of context.getSearchPageEntries()) {
            const action = context.createMobileQuickActionFromMatch({ ...entry, shellKey: 'pages' });
            expect(action).not.toBeNull();
            expect(action.tabId).toBe(entry.dedupeKey);
            const [restored] = context.parseMobileQuickActionStorage(JSON.stringify([action]));
            expect(restored).toEqual(action);
            expect(context.findMobileQuickActionMatch(restored).dedupeKey).toBe(entry.dedupeKey);
            context.activateMobileQuickAction(restored);
        }
        expect(context.activateNeconyanRailTool).toHaveBeenCalledWith('css-snippets');
        expect(context.activateNeconyanMode).toHaveBeenCalledWith('conversation');
        expect(context.NeconyanWelcome.activateRoute).toHaveBeenCalledWith('settings');
        expect(context.window.open).toHaveBeenCalledWith('https://platberlitz.github.io/neconyan-docs/', '_blank', 'noopener,noreferrer');
        expect(context.openShell).not.toHaveBeenCalled();
    });

    test('Catelier is not crowded out by setting matches, and duplicate pins are removed', () => {
        const context = harness();
        const matches = context.getMobileQuickActionSearchMatches('Catelier');
        expect(matches).toHaveLength(12);
        expect(matches[0].dedupeKey).toBe('characters::creator');
        const action = context.createMobileQuickActionFromMatch(matches[0]);
        expect(context.getMobileQuickActionTabConfig('characters', 'creator').icon).toBe('fa-pen-nib');
        expect(context.normalizeMobileQuickActionList([action, action])).toHaveLength(1);
        expect(context.getMobileQuickActionSearchMatches('c')).toEqual([]);
    });

    test('rejects unknown or mismatched page keys and preserves existing setting pins and custom icons', () => {
        const context = harness();
        expect(context.normalizeMobileQuickAction({ shellKey: 'pages', tabId: 'https://example.com', dedupeKey: 'https://example.com', label: 'Unknown' })).toBeNull();
        expect(context.normalizeMobileQuickAction({ shellKey: 'pages', tabId: 'page::home', dedupeKey: 'page::settings', label: 'Mismatch' })).toBeNull();
        const setting = { type: 'custom', shellKey: 'left', tabId: 'sampling', dedupeKey: 'sampling::temperature', displayText: 'Temperature', label: 'Temperature', icon: 'fa-cat', sectionLabel: 'Sampling' };
        expect(context.parseMobileQuickActionStorage(JSON.stringify([setting]))[0]).toEqual(setting);
        const entry = context.getSearchPageEntries().find(page => page.displayText === 'CSS Snippets');
        const action = context.createMobileQuickActionFromMatch({ ...entry, shellKey: 'pages' });
        expect(context.normalizeMobileQuickAction({ ...action, icon: 'fa-cat' }).icon).toBe('fa-cat');
    });

    test('every Characters drawer page including Catelier survives saving and opens its tab', () => {
        const context = harness();
        for (const entry of context.getCharacterPanelSearchEntries()) {
            const action = context.createMobileQuickActionFromMatch({ ...entry, shellKey: 'characters' });
            const [restored] = context.parseMobileQuickActionStorage(JSON.stringify([action]));
            expect(restored).toEqual(action);
            context.activateMobileQuickAction(restored);
            expect(context.openCharacterPanelTab).toHaveBeenLastCalledWith(entry.tabId);
        }
        expect(context.openCharacterPanelTab).toHaveBeenCalledWith('creator');
    });
});
