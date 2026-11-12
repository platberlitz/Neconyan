import { describe, expect, test } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(repoRoot, file), 'utf8').replace(/\r\n/g, '\n');

const functionBody = (source, signature) => {
    const start = source.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\n}\n', start);
    return source.slice(start, end);
};

const cssFiles = (dir) => readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'lib' || entry.name === 'node_modules' ? [] : cssFiles(relative);
    return entry.name.endsWith('.css') ? [relative] : [];
});

describe('typing into a search box never waits for a page-wide restyle', () => {
    test('no stylesheet watches :placeholder-shown from inside :has()', () => {
        // The first key in any empty box flips :placeholder-shown, and a :has() rule watching it
        // made Chrome restyle the whole page before the key appeared.
        const offenders = cssFiles('public').filter((file) => {
            const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
            return /:has\([^{]*:placeholder-shown/.test(css);
        });
        expect(offenders).toEqual([]);
    });

    test('the Claude prefill warning is toggled from script instead', () => {
        const openaiJs = read('public/scripts/openai.js');
        const body = functionBody(openaiJs, 'function updateClaudePrefillWarning()');
        expect(body).toContain('\'nn-prefill-warning-visible\'');
        expect(body).toContain('getElementById(\'openai_function_calling\')');
        expect(openaiJs.match(/updateClaudePrefillWarning\(\);/g)?.length).toBeGreaterThanOrEqual(4);
        expect(read('public/css/toggle-dependent.css')).toContain('#claude_function_prefill_warning.nn-prefill-warning-visible');
    });
});

describe('search boxes stay the same element while results redraw', () => {
    test('Regex Agent Themes keeps one theme search box', () => {
        const ui = read('public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/ui.js');
        const input = functionBody(ui, 'function browseSearchInput()');
        expect(input).toContain('if (!browseSearch)');
        expect(input).toContain('BROWSE_SEARCH_DELAY_MS');
        const render = functionBody(ui, 'function renderBrowse(settings)');
        expect(render).not.toContain('content.textContent = \'\'');
        expect(render).toContain('browseSearch');
    });

    test('Scratchpad keeps one session search box', () => {
        const scratchpad = read('public/scripts/scratchpad/index.js');
        expect(functionBody(scratchpad, 'function sessionSearchInput()')).toContain('sessionSearch ??=');
        expect(functionBody(scratchpad, 'function renderSessions()')).toContain('sessionSearchInput()');
    });

    test('the notes app builds its search box once', () => {
        const notes = read('public/scripts/notebooks/notes-app.js');
        expect(notes).toContain('elements.searchRow = keyed(\'search\'');
        expect(functionBody(notes, 'function renderNav()')).not.toContain('class: \'text_pole notes-search-input\'');
    });

    test('Character Colors filters its gradient gallery without rebuilding it', () => {
        const ui = read('public/scripts/extensions/third-party/sillytavern-character-colors/src/ui.js');
        expect(functionBody(ui, 'function filterGradientGalleryList(host)')).toContain('\'displayNone\'');
        expect(ui).toContain('updateCharList({ keepGallery: true })');
    });

    test('companion quick controls keep their search box across tracker redraws', () => {
        const quick = read('public/scripts/extensions/in-chat-agents/companion/companion-quick-controls.js');
        expect(quick).toMatch(/data-quick-search[^>]*data-role="quick-search"|data-role="quick-search"[^>]*data-quick-search/);
    });
});

describe('filters hide rows with a class, not the hidden attribute', () => {
    // Chrome restyles a whole dialog or panel for every hidden or inline display change,
    // because :has() rules elsewhere watch [hidden] and [style].
    const sources = {
        'Companion links': 'public/scripts/extensions/in-chat-agents/quick-settings.js',
        'UI theme picker': 'public/scripts/neconyan-ui-theme-picker.js',
        Backgrounds: 'public/scripts/backgrounds.js',
        'Companion panel': 'public/scripts/extensions/in-chat-agents/companion/companion-panel.js',
        'Conversation pickers': 'public/scripts/neconyan-conversation/pickers.js',
        'Scratchpad cards': 'public/scripts/scratchpad/assistants.js',
    };

    test.each(Object.entries(sources))('%s', (_, file) => {
        expect(read(file)).toContain('\'displayNone\'');
    });

    test('the Companion links search no longer writes row.hidden', () => {
        expect(read('public/scripts/extensions/in-chat-agents/quick-settings.js')).not.toContain('row.hidden');
    });

    test('Backgrounds no longer reads each tile with jQuery toggle()', () => {
        const body = functionBody(read('public/scripts/backgrounds.js'), 'function onBackgroundFilterInput(');
        expect(body).not.toMatch(/\.toggle\(/);
        expect(body).toContain('setFilterTileVisible(');
    });
});

describe('heavy searches wait for a pause in typing', () => {
    test('Settings search is debounced on both of its listeners', () => {
        expect(read('public/scripts/setting-search.js')).toContain('debounce(searchSettings, debounce_timeout.quick)');
        expect(read('public/scripts/neconyan-settings-tabs.js')).toContain('SETTINGS_SEARCH_DELAY_MS');
    });

    test('Quick Actions search reads its sources once per visit', () => {
        const tabsJs = read('public/scripts/neconyan-tabs.js');
        expect(tabsJs).toContain('function getMobileQuickActionSearchSources()');
        expect(tabsJs).toContain('searchSources ??= getMobileQuickActionSearchSources()');
        expect(tabsJs).toContain('NN_QUICK_ACTION_SEARCH_DELAY_MS');
    });

    test('Featherless binds its search through jQuery so reloads drop old listeners', () => {
        const textgenModels = read('public/scripts/textgen-models.js');
        expect(textgenModels).toContain('$(searchBar).off(\'input\').on(\'input\', debounce(');
        expect(textgenModels).not.toContain('searchBar.addEventListener(\'input\'');
    });

    test.each([
        ['Quick Image Gen settings', 'public/scripts/extensions/quick-image-gen/index.js', 'SETTINGS_SEARCH_DELAY_MS'],
        ['CSS Snippets', 'public/scripts/extensions/css-snippets/src/ui.js', 'SEARCH_DELAY_MS'],
        ['bottom bar chat picker', 'public/scripts/chat-picker.js', 'SEARCH_DELAY_MS'],
        ['slash command browser', 'public/scripts/slash-commands/SlashCommandBrowser.js', 'filterTimer = setTimeout(filterCommands'],
        ['UI theme picker', 'public/scripts/neconyan-ui-theme-picker.js', 'SEARCH_FILTER_DELAY_MS'],
        ['Preset Tools', 'public/scripts/extensions/third-party/Neconyan-Preset-Tools/content.js', 'searchTimer = window.setTimeout(schedulePromptRefresh'],
    ])('%s', (_, file, marker) => {
        expect(read(file)).toContain(marker);
    });
});
