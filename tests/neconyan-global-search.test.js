import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shellSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'neconyan-tabs.js'), 'utf8');
const welcomeSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'welcome-screen.js'), 'utf8');

function getTopLevel(pattern) {
    const match = shellSource.match(pattern);
    if (!match) {
        throw new Error(`Missing ${pattern}`);
    }
    return match[0];
}

function getFunctionSource(name) {
    return getTopLevel(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'));
}

function createSearchContext() {
    const context = vm.createContext({
        escapeRegex: value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        normalizeText: value => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase(),
    });
    vm.runInContext([
        getTopLevel(/^const NN_SEARCH_PAGES = Object\.freeze\(\[[\s\S]*?^\]\.map\(page => Object\.freeze\(page\)\)\);/m),
        getFunctionSource('getSearchWordStartPattern'),
        getFunctionSource('hasSearchWordStarts'),
        getFunctionSource('scoreSearchEntry'),
        'globalThis.NN_SEARCH_PAGES = NN_SEARCH_PAGES;',
    ].join('\n'), context);
    return context;
}

function score(context, entry, query) {
    const patterns = query.split(' ').map(term => context.getSearchWordStartPattern(term));
    return context.scoreSearchEntry(entry, query, patterns);
}

describe('global search finds pages and the setting you asked for', () => {
    test('lists every rail page with a description and keywords', () => {
        const { NN_SEARCH_PAGES } = createSearchContext();
        const routes = NN_SEARCH_PAGES.map(page => page.route);

        expect(new Set(routes).size).toBe(routes.length);
        for (const route of ['model', 'sampling', 'formatting', 'mewmory', 'persona', 'dialogue-colors', 'background', 'server', 'console-logs', 'regex', 'expressions']) {
            expect(routes).toContain(route);
        }
        for (const page of NN_SEARCH_PAGES) {
            expect(page.label).toBeTruthy();
            expect(page.description).toMatch(/\.$/);
            expect(Array.isArray(page.keywords)).toBe(true);
            expect(welcomeSource).toContain(`'${page.route}'`);
        }
        expect(welcomeSource).toContain('activateRoute: activateNeconyanRailRoute,');
    });

    test('words must start a word, so temp finds Temperature but not Attempts', () => {
        const context = createSearchContext();
        const patterns = [context.getSearchWordStartPattern('temp')];

        expect(context.hasSearchWordStarts('temperature', patterns)).toBe(true);
        expect(context.hasSearchWordStarts('dynamic temperature', patterns)).toBe(true);
        expect(context.hasSearchWordStarts('retry attempts', patterns)).toBe(false);
        expect(context.hasSearchWordStarts('hide cats (kittyless)', [context.getSearchWordStartPattern('kittyless')])).toBe(true);
    });

    test('ranks the item name above its section and pages above settings that share the start of the name', () => {
        const context = createSearchContext();
        const exact = score(context, { displayText: 'Temperature', sectionLabel: 'Sampling' }, 'temperature');
        const starts = score(context, { displayText: 'Temperature Last', sectionLabel: 'Sampling' }, 'temperature');
        const inside = score(context, { displayText: 'Dynamic Temperature', sectionLabel: 'Sampling' }, 'temperature');
        const sectionOnly = score(context, { displayText: 'Add', sectionLabel: 'Regex Presets' }, 'regex');
        const page = score(context, { displayText: 'Regexes', sectionLabel: '', kind: 'page', keywords: ['regex'] }, 'regex');
        const setting = score(context, { displayText: 'Regex Presets', sectionLabel: 'Regex Presets' }, 'regex');

        expect(exact.score).toBeGreaterThan(starts.score);
        expect(starts.score).toBeGreaterThan(inside.score);
        expect(inside.score).toBeGreaterThan(sectionOnly.score);
        expect(sectionOnly.sectionOnly).toBe(true);
        expect(page.score).toBeGreaterThan(setting.score);
    });

    test('a page found by an exact keyword beats one that only starts a keyword', () => {
        const context = createSearchContext();
        const connections = score(context, { displayText: 'Connections', sectionLabel: '', kind: 'page', keywords: ['model', 'api key'] }, 'model');
        const newChat = score(context, { displayText: 'New chat', sectionLabel: '', kind: 'page', keywords: ['temporary chat'] }, 'temp');

        expect(connections.score).toBeGreaterThan(70);
        expect(newChat.score).toBeLessThan(50);
    });

    test('collects pages first, folds section matches and skips fields for other providers', () => {
        const collectSource = getFunctionSource('collectGlobalSearchMatches');

        expect(collectSource).toContain('isSearchElementSwitchedOff(entry.element)');
        expect(collectSource).toContain('entry.element.matches(NN_SEARCH_SECTION_HEADING_SELECTOR)');
        expect(collectSource).toContain('dedupeKey: `${entry.tabId}::section::${sectionText}`');
        expect(collectSource).toContain('collectMatches(text => hasSearchWordStarts(text, wordPatterns))');
        expect(collectSource).toContain('const namedPages = ordered.filter(match => match.kind === \'page\' && match.score >= 80);');
        expect(getFunctionSource('isSearchElementSwitchedOff')).toContain('current.style.display === \'none\'');
        expect(shellSource).toContain('const NN_SEARCH_READABLE_TARGET_SELECTOR = `${NN_SEARCH_TARGET_SELECTOR}, input[type="range"][aria-label]`;');
    });

    test('the global index reads clean labels and includes the Shell Style card', () => {
        const indexSource = getFunctionSource('createSearchIndex');

        expect(indexSource).toContain('readable ? NN_SEARCH_READABLE_TARGET_SELECTOR : NN_SEARCH_TARGET_SELECTOR');
        expect(indexSource).toMatch(/includeThemeCard \|\| readable\s*\? '[^']*\.sb-mobile-quick-actions-group/);
        expect(getFunctionSource('collectGlobalSearchMatches')).toContain('createSearchIndex(tabState, { readable: true })');
        expect(getFunctionSource('getSearchElementText')).toContain('option, optgroup, select, script, style, template, svg');
    });

    test('results say what they open and whole-tab results skip scrolling', () => {
        const renderSource = getFunctionSource('renderUniversalSearchResults');
        const revealSource = getFunctionSource('revealSearchMatch');

        expect(renderSource).toContain('match.groupLabel ||');
        expect(renderSource).toContain('\'Open page\'');
        expect(renderSource).toContain('\'Open section\'');
        expect(renderSource).toContain('`in ${match.sectionLabel}`');
        expect(revealSource).toMatch(/openShell\(shellKey, match\.tabId\);\s*\/\/[^\n]*\n\s*if \(!\(match\.element instanceof HTMLElement\)\) \{\s*return;/);
    });
});
