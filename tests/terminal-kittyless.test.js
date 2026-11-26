import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const tabsSource = read('../public/scripts/neconyan-tabs.js');
const indexSource = read('../public/scripts/extensions/third-party/Neconyan-Terminal-UI/index.js');
const styleSource = read('../public/scripts/extensions/third-party/Neconyan-Terminal-UI/style.css');

const start = tabsSource.indexOf('function isKittylessActive()');
const end = tabsSource.indexOf('// Tour buttons are created by several lazy modules');
const slice = tabsSource.slice(start, end);

function createHarness({ theme = 'calico', kittyless = false, attribute = false } = {}) {
    const links = [];
    const dataset = attribute ? { sbKittyless: 'true' } : {};
    const context = {
        nnState: { theme, kittyless, kittylessOverride: null },
        document: {
            documentElement: { dataset },
            querySelectorAll: () => [],
            querySelector: () => null,
            createElement: () => ({ dataset: {} }),
            head: { append: link => links.push(link) },
        },
        Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
        NN_KITTYLESS_STYLESHEET_HREF: 'css/neconyan-kittyless.css?v=test',
        NN_STORAGE_KEYS: { kittyless: 'sb-kittyless' },
        safeSetItem: () => {},
        normalizeStoredBoolean: (value, fallback) => (typeof value === 'boolean' ? value : fallback),
        updateThemePickerUi: () => {},
        globalThis: null,
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(slice, context);
    return context;
}

describe('Termeownal UI Hide cats override in the host', () => {
    const themes = ['calico', 'kittyless'];
    test.each(themes.flatMap(theme => [false, true].flatMap(app => [null, true, false].map(override => [theme, app, override]))))(
        'theme %s, app-wide %s, override %s',
        (theme, app, override) => {
            const context = createHarness({ theme, kittyless: app });
            context.nnState.kittylessOverride = override;
            const chosen = theme === 'kittyless' || app;
            expect(context.isKittylessChosen()).toBe(chosen);
            expect(context.isKittylessActive()).toBe(override === null ? chosen : override);
        });

    test('setKittylessOverride writes the attribute only through the host sync', () => {
        const context = createHarness({ theme: 'kittyless', attribute: true });
        context.setKittylessOverride(true);
        expect(context.document.documentElement.dataset.sbKittyless).toBe('true');
        context.setKittylessOverride(false);
        expect(context.nnState.kittylessOverride).toBe(false);
        expect(context.document.documentElement.dataset.sbKittyless).toBeUndefined();
        context.setKittylessOverride(null);
        expect(context.document.documentElement.dataset.sbKittyless).toBe('true');
    });

    test('a value that is not a boolean resets the override to null', () => {
        const context = createHarness();
        context.setKittylessOverride(true);
        expect(context.nnState.kittylessOverride).toBe(true);
        context.setKittylessOverride('x');
        expect(context.nnState.kittylessOverride).toBeNull();
    });

    test('the shell exposes both functions at module level', () => {
        const context = createHarness();
        expect(typeof context.NeconyanShell.setKittylessOverride).toBe('function');
        expect(typeof context.NeconyanShell.isKittylessChosen).toBe('function');
    });
});

describe('Termeownal UI Hide cats source', () => {
    test('settings, art, commands and apply', () => {
        expect(indexSource).toContain('bottomBarVisible: null, kittyless: null };');
        expect(indexSource).toContain('<path d="M12 3h8v2h2v8h-2v2h-8v-2h-2V5h2Z"/>');
        expect(indexSource).toContain('<path d="M10 17h12v2h2v2h2v5H6v-5h2v-2h2Z"/>');
        expect(indexSource).toContain('class="sbterm-person" viewBox="0 0 32 28"');
        expect(indexSource).not.toContain('Follows Settings');
        expect(indexSource).toContain('mascot.innerHTML = CAT_ART + PERSON_ART');
        expect(indexSource).toContain('[\'kittyless on\', \'Hide the cats in Termeownal UI\'],');
        expect(indexSource).toContain('[\'kittyless off\', \'Show the cats in Termeownal UI\'],');
        expect(indexSource).toMatch(/document\.body\.classList\.toggle\('sbterm-bottom-bar-hidden'[^\n]*\n\s*syncHostKittyless\(enabled, settings\);/);
        expect(indexSource).toContain('checkboxRow(\'sbterm-kittyless\', \'Hide cats (Kittyless)\'');
    });

    test('the extension never writes data-sb-kittyless itself', () => {
        expect(indexSource).not.toMatch(/dataset\.sbKittyless\s*=(?!=)|delete\s+[\w.]*dataset\.sbKittyless|(?:set|remove)Attribute\(\s*['"]data-sb-kittyless['"]/);
        expect(indexSource).toContain('document.documentElement.dataset.sbKittyless === \'true\'');
    });

    test('the Agents button swaps its kitty for the person while cats are hidden', () => {
        expect(styleSource).toContain('body.sbterm .sbterm-person path { fill: var(--sbterm-fg); }');
        expect(styleSource).toContain(':root[data-sb-kittyless=\'true\'] body.sbterm .sbterm-mascot-button .sbterm-kitty { display: none; }');
        expect(styleSource).toContain(':root[data-sb-kittyless=\'true\'] body.sbterm .sbterm-mascot-button .sbterm-person { display: block; }');
    });
});

const termStart = indexSource.indexOf('// The app-wide Hide cats choice');
const termEnd = indexSource.indexOf('function save()');
const termSlice = indexSource.slice(termStart, termEnd);

function createTermHarness({ chosen, shell = true, attribute = false } = {}) {
    const calls = { overrides: [], patches: [] };
    const context = {
        document: { documentElement: { dataset: attribute ? { sbKittyless: 'true' } : {} } },
        updateSettings: patch => {
            calls.patches.push(patch);
            return patch;
        },
        globalThis: null,
    };
    context.globalThis = context;
    if (shell) {
        context.NeconyanShell = {
            isKittylessChosen: () => chosen,
            setKittylessOverride: value => calls.overrides.push(value),
        };
    }
    vm.createContext(context);
    vm.runInContext(termSlice, context);
    return { context, calls };
}

describe('Termeownal UI Hide cats choice handed to the host', () => {
    test('the slice was found', () => {
        expect(termStart).toBeGreaterThan(-1);
        expect(termEnd).toBeGreaterThan(termStart);
    });

    test('syncHostKittyless hands the host a boolean only while on and chosen', () => {
        const { context, calls } = createTermHarness({ chosen: false });
        context.syncHostKittyless(true, { kittyless: true });
        context.syncHostKittyless(true, { kittyless: false });
        context.syncHostKittyless(true, { kittyless: null });
        context.syncHostKittyless(false, { kittyless: true });
        context.syncHostKittyless(false, {});
        expect(calls.overrides).toEqual([true, false, null, null, null]);
    });

    test('syncHostKittyless does nothing without the host', () => {
        const { context } = createTermHarness({ shell: false });
        expect(() => context.syncHostKittyless(true, { kittyless: true })).not.toThrow();
    });

    test('setKittyless stores null when the choice matches the app-wide one', () => {
        const { context, calls } = createTermHarness({ chosen: false });
        context.setKittyless(false);
        context.setKittyless(true);
        expect(calls.patches).toEqual([{ kittyless: null }, { kittyless: true }]);
        const on = createTermHarness({ chosen: true });
        on.context.setKittyless(true);
        on.context.setKittyless(false);
        expect(on.calls.patches).toEqual([{ kittyless: null }, { kittyless: false }]);
    });

    test('setKittyless stores the raw value while the host is absent', () => {
        const { context, calls } = createTermHarness({ shell: false });
        context.setKittyless(false);
        context.setKittyless(true);
        expect(calls.patches).toEqual([{ kittyless: false }, { kittyless: true }]);
    });

    test('shownKittyless prefers the stored boolean, then the app-wide value, then the attribute', () => {
        const { context } = createTermHarness({ chosen: true });
        expect(context.shownKittyless({ kittyless: false })).toBe(false);
        expect(context.shownKittyless({ kittyless: true })).toBe(true);
        expect(context.shownKittyless({ kittyless: null })).toBe(true);
        const off = createTermHarness({ chosen: false, attribute: true });
        expect(off.context.shownKittyless({ kittyless: null })).toBe(false);
        const bare = createTermHarness({ shell: false, attribute: true });
        expect(bare.context.shownKittyless({ kittyless: null })).toBe(true);
        const none = createTermHarness({ shell: false });
        expect(none.context.shownKittyless({ kittyless: null })).toBe(false);
    });
});

describe('Termeownal UI Hide cats source pins', () => {
    test('turning Termeownal off hands the host no override', () => {
        expect(indexSource).toContain('function deactivate() {\n    active = false;\n    syncHostKittyless(false, {});');
    });

    test('the Appearance caption names Termeownal only while it owns the choice', () => {
        expect(tabsSource).toContain('caption.textContent = termeownalOwnsCats\n                ? \'Termeownal UI is using its own Hide cats choice.');
    });

    test('the person is hidden by default and shown only while cats are hidden', () => {
        expect(styleSource).toContain('body.sbterm .sbterm-person {\n    display: none;');
    });
});
