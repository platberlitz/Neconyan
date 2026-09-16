import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { DEFAULTS, DEFAULT_TONE, DEFAULT_IMAGE_INSTRUCTIONS, buildRefreshMessages } from '../public/scripts/extensions/third-party/Neconyan-Hopper/src/core.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (...parts) => JSON.parse(readFileSync(path.join(repoRoot, ...parts), 'utf8'));
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');
const powerUserSource = readSource('public', 'scripts', 'power-user.js');
const tabsSource = readSource('public', 'scripts', 'neconyan-tabs.js');
const scriptSource = readSource('public', 'script.js');
const getFunctionSource = name => powerUserSource.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0] ?? '';
const calicoTheme = readJson('default', 'content', 'themes', 'Neconyan Calico.json');
const calicoDarkTheme = readJson('default', 'content', 'themes', 'Neconyan Calico Dark.json');
const darkVTheme = readJson('default', 'content', 'themes', 'Dark V 1.0.json');
const oldCalicoTheme = {
    name: calicoTheme.name,
    blur_strength: 0,
    main_text_color: 'rgba(61, 44, 34, 1)',
    italics_text_color: 'rgba(115, 91, 77, 1)',
    underline_text_color: 'rgba(154, 69, 26, 1)',
    quote_text_color: 'rgba(172, 89, 44, 1)',
    blur_tint_color: 'rgba(247, 236, 219, 1)',
    chat_tint_color: 'rgba(252, 246, 236, 1)',
    user_mes_blur_tint_color: 'rgba(250, 201, 169, 1)',
    bot_mes_blur_tint_color: 'rgba(252, 246, 236, 1)',
    shadow_color: 'rgba(49, 36, 27, 1)',
    shadow_width: 0,
    border_color: 'rgba(209, 184, 156, 1)',
    custom_css: '',
};
const oldCalicoDarkTheme = {
    name: calicoDarkTheme.name,
    blur_strength: 0,
    main_text_color: 'rgba(234, 224, 209, 1)',
    italics_text_color: 'rgba(170, 155, 144, 1)',
    underline_text_color: 'rgba(240, 178, 130, 1)',
    quote_text_color: 'rgba(231, 152, 103, 1)',
    blur_tint_color: 'rgba(22, 18, 15, 1)',
    chat_tint_color: 'rgba(37, 31, 27, 1)',
    user_mes_blur_tint_color: 'rgba(53, 40, 33, 1)',
    bot_mes_blur_tint_color: 'rgba(37, 31, 27, 1)',
    shadow_color: 'rgba(9, 7, 6, 0.8)',
    shadow_width: 0,
    border_color: 'rgba(62, 54, 49, 1)',
    custom_css: '',
};
const themeColorKeys = [
    'main_text_color',
    'italics_text_color',
    'underline_text_color',
    'quote_text_color',
    'blur_tint_color',
    'chat_tint_color',
    'user_mes_blur_tint_color',
    'bot_mes_blur_tint_color',
    'shadow_color',
    'border_color',
];

function createPaletteRuntime(powerUserOverrides = {}, useDarkTheme = true) {
    const styleWrites = [];
    const themeSelectWrites = [];
    const accentRefresh = { colours: [], profiles: 0 };
    const powerUser = {
        theme: (useDarkTheme ? calicoDarkTheme : calicoTheme).name,
        ...Object.fromEntries(themeColorKeys.map(key => [key, (useDarkTheme ? calicoDarkTheme : calicoTheme)[key]])),
        blur_strength: (useDarkTheme ? calicoDarkTheme : calicoTheme).blur_strength,
        shadow_width: (useDarkTheme ? calicoDarkTheme : calicoTheme).shadow_width,
        custom_css: (useDarkTheme ? calicoDarkTheme : calicoTheme).custom_css,
        ...powerUserOverrides,
    };
    const context = vm.createContext({
        accessibleTheme: theme => theme,
        applyGoogleFont: () => undefined,
        power_user: powerUser,
        themes: [{ name: calicoTheme.name, main_text_color: 'user-edited value' }, calicoDarkTheme],
        NECONYAN_THEME_NAME: calicoTheme.name,
        NECONYAN_CALICO_THEME_FALLBACK: calicoTheme,
        NECONYAN_DARK_THEME_NAME: calicoDarkTheme.name,
        NECONYAN_CALICO_DARK_THEME_FALLBACK: calicoDarkTheme,
        NECONYAN_THEME_MIGRATION_KEY: 'neconyan_theme_migration_v3',
        DARK_V_THEME_NAME: darkVTheme.name,
        DARK_V_THEME_BASELINE: darkVTheme,
        NECONYAN_CALICO_THEME_V2_BASELINE: oldCalicoTheme,
        NECONYAN_CALICO_DARK_THEME_V2_BASELINE: oldCalicoDarkTheme,
        THEME_COLOR_PROPERTIES: themeColorKeys.map(key => ({ key, selector: null, type: null })),
        THEME_EFFECT_PROPERTIES: [],
        LEGACY_THEME_EFFECT_KEYS: ['blur_strength', 'shadow_width'],
        document: {
            documentElement: {
                dataset: {},
                style: { setProperty: (key, value) => styleWrites.push([key, value]) },
            },
            querySelector: () => null,
        },
        $: selector => ({
            attr: () => undefined,
            val(value) {
                if (arguments.length > 0) {
                    themeSelectWrites.push([selector, value]);
                }
            },
        }),
        applyAccentContrastPalette: () => undefined,
        applyLandingContrastPalette: () => undefined,
        applyThemeEffects: () => undefined,
        applyBlurStrength: () => undefined,
        applyShadowWidth: () => undefined,
        applyCustomCSS: () => undefined,
        syncCustomAccentPickersFromState: () => accentRefresh.colours.push([powerUser.quote_text_color, powerUser.underline_text_color]),
        renderAccentProfiles: () => { accentRefresh.profiles++; },
        saveSettingsDebounced: () => undefined,
        console: { log: () => undefined, debug: () => undefined },
    });
    vm.runInContext([
        getFunctionSource('themeValuesEqual'),
        getFunctionSource('getLegacyThemeValueKeys'),
        getFunctionSource('themeValuesMatch'),
        getFunctionSource('applyNeconyanThemeValues'),
        getFunctionSource('migrateNeconyanTheme'),
        getFunctionSource('normalizeNeconyanThemeDefinitions'),
        getFunctionSource('syncNeconyanPaletteAttribute'),
        getFunctionSource('applyThemeColor'),
        getFunctionSource('applyTheme'),
        getFunctionSource('resetToNeconyanCalicoTheme'),
        getFunctionSource('applyAccentColors'),
    ].join('\n'), context);
    return { context, styleWrites, themeSelectWrites, accentRefresh };
}

describe('Neconyan Calico defaults', () => {
    test('registers the bundled theme and selects it for new accounts', () => {
        const contentIndex = readJson('default', 'content', 'index.json');
        const themeEntry = contentIndex.find(entry => entry.filename === 'themes/Neconyan Calico.json');
        const theme = readJson('default', 'content', 'themes', 'Neconyan Calico.json');
        const settings = readJson('default', 'content', 'settings.json');

        const darkThemeEntry = contentIndex.find(entry => entry.filename === 'themes/Neconyan Calico Dark.json');
        const darkTheme = readJson('default', 'content', 'themes', 'Neconyan Calico Dark.json');

        expect(themeEntry).toEqual({ filename: 'themes/Neconyan Calico.json', type: 'theme' });
        expect(darkThemeEntry).toEqual({ filename: 'themes/Neconyan Calico Dark.json', type: 'theme' });
        expect(theme.name).toBe('Neconyan Calico');
        expect(theme.main_text_color).toBe('rgba(48, 51, 49, 1)');
        expect(theme.blur_tint_color).toBe('rgba(246, 242, 232, 1)');
        expect(theme.chat_tint_color).toBe('rgba(255, 250, 240, 1)');
        expect(theme.user_mes_blur_tint_color).toBe('rgba(247, 226, 195, 1)');
        expect(theme.bot_mes_blur_tint_color).toBe('rgba(255, 250, 240, 1)');
        expect(theme.shadow_width).toBe(0);
        expect(darkTheme.name).toBe('Neconyan Calico Dark');
        expect(settings.power_user.theme).toBe('Neconyan Calico Dark');
        expect(settings.power_user.main_text_color).toBe(darkTheme.main_text_color);
        expect(settings.power_user.blur_tint_color).toBe(darkTheme.blur_tint_color);
        expect(settings.power_user.chat_width).toBe(80);
        expect(theme.chat_width).toBe(80);
        expect(darkTheme.chat_width).toBe(80);
    });

    test('uses the immutable stock Dark V1.0 baseline for one-time migration', () => {
        const source = readSource('public', 'scripts', 'power-user.js');

        expect(source).toContain('const NECONYAN_THEME_MIGRATION_KEY = \'neconyan_theme_migration_v3\';');
        expect(source).toContain('const NECONYAN_DARK_THEME_NAME = \'Neconyan Calico Dark\';');
        expect(source).toContain('const DARK_V_THEME_BASELINE = Object.freeze({');
        expect(source).toContain('themeValuesMatch(DARK_V_THEME_BASELINE, savedPowerUserSettings)');
        expect(source).toContain('themeValuesMatch(NECONYAN_CALICO_DARK_THEME_V2_BASELINE, savedPowerUserSettings)');
        expect(source).toContain('themeValuesMatch(NECONYAN_CALICO_THEME_V2_BASELINE, savedPowerUserSettings)');
        expect(source).toContain('savedPowerUserSettings[NECONYAN_THEME_MIGRATION_KEY] = targetTheme ? \'migrated\' : \'inspected\';');
        expect(source).toContain('document.documentElement.dataset.neconyanPalette = isCalico ? \'calico\' : \'custom\';');
    });

    test('migrates exact stock themes to the dark Calico fallback', () => {
        const runtime = createPaletteRuntime({
            theme: darkVTheme.name,
            ...darkVTheme,
        });
        const saved = { power_user: { ...darkVTheme, theme: darkVTheme.name } };

        runtime.context.migrateNeconyanTheme(saved);

        expect(saved.power_user.theme).toBe(calicoDarkTheme.name);
        expect(saved.power_user.main_text_color).toBe(calicoDarkTheme.main_text_color);
        expect(saved.power_user["neconyan_theme_migration_v3"]).toBe('migrated');
    });

    test('migrates old stock Calico themes while preserving their light or dark choice', () => {
        const darkRuntime = createPaletteRuntime({ theme: oldCalicoDarkTheme.name, ...oldCalicoDarkTheme });
        const darkSaved = { power_user: { ...oldCalicoDarkTheme, theme: oldCalicoDarkTheme.name, neconyan_theme_migration_v2: 'migrated' } };
        darkRuntime.context.migrateNeconyanTheme(darkSaved);
        expect(darkSaved.power_user.theme).toBe(calicoDarkTheme.name);
        expect(darkSaved.power_user.blur_tint_color).toBe(calicoDarkTheme.blur_tint_color);
        expect(darkSaved.power_user.neconyan_theme_migration_v3).toBe('migrated');

        const lightRuntime = createPaletteRuntime({ theme: oldCalicoTheme.name, ...oldCalicoTheme }, false);
        const lightSaved = { power_user: { ...oldCalicoTheme, theme: oldCalicoTheme.name } };
        lightRuntime.context.migrateNeconyanTheme(lightSaved);
        expect(lightSaved.power_user.theme).toBe(calicoTheme.name);
        expect(lightSaved.power_user.blur_tint_color).toBe(calicoTheme.blur_tint_color);
        expect(lightSaved.power_user.neconyan_theme_migration_v3).toBe('migrated');
    });

    test('does not repeat migration and normalizes only exact stale stock definitions', () => {
        const runtime = createPaletteRuntime();
        const alreadyMigrated = { power_user: { ...oldCalicoDarkTheme, neconyan_theme_migration_v3: 'migrated' } };
        expect(runtime.context.migrateNeconyanTheme(alreadyMigrated)).toBe(false);
        expect(alreadyMigrated.power_user.blur_tint_color).toBe(oldCalicoDarkTheme.blur_tint_color);

        const normalized = runtime.context.normalizeNeconyanThemeDefinitions([
            { ...oldCalicoTheme, id: 'old-light' },
            { ...oldCalicoDarkTheme, id: 'old-dark' },
            { ...oldCalicoTheme, quote_text_color: 'rgba(1, 2, 3, 1)', id: 'edited' },
        ]);
        expect(normalized[0].blur_tint_color).toBe(calicoTheme.blur_tint_color);
        expect(normalized[1].blur_tint_color).toBe(calicoDarkTheme.blur_tint_color);
        expect(normalized[2].quote_text_color).toBe('rgba(1, 2, 3, 1)');
    });

    test('leaves edited same-name themes untouched during migration', () => {
        const runtime = createPaletteRuntime({
            theme: calicoTheme.name,
            ...calicoTheme,
            quote_text_color: 'rgba(3, 4, 5, 1)',
        }, false);
        const saved = {
            power_user: {
                ...calicoTheme,
                theme: calicoTheme.name,
                quote_text_color: 'rgba(3, 4, 5, 1)',
            },
        };

        runtime.context.migrateNeconyanTheme(saved);

        expect(saved.power_user.theme).toBe(calicoTheme.name);
        expect(saved.power_user.quote_text_color).toBe('rgba(3, 4, 5, 1)');
        expect(saved.power_user["neconyan_theme_migration_v3"]).toBe('inspected');
    });

    test('resets an edited same-name Calico theme through the immutable dark fallback', () => {
        const runtime = createPaletteRuntime({
            theme: 'Some other theme',
            main_text_color: 'rgba(1, 2, 3, 1)',
            quote_text_color: 'rgba(4, 5, 6, 1)',
        });

        runtime.context.resetToNeconyanCalicoTheme();

        expect(runtime.context.power_user.theme).toBe('Neconyan Calico Dark');
        expect(runtime.context.power_user.main_text_color).toBe(calicoDarkTheme.main_text_color);
        expect(runtime.context.power_user.quote_text_color).toBe(calicoDarkTheme.quote_text_color);
        expect(runtime.themeSelectWrites).toContainEqual(['#themes', 'Neconyan Calico Dark']);
        expect(runtime.accentRefresh.colours).toContainEqual([calicoDarkTheme.quote_text_color, calicoDarkTheme.underline_text_color]);
        expect(runtime.accentRefresh.profiles).toBeGreaterThan(0);
    });

    test('keeps Calico identity in sync across accent edits and a reload-equivalent state', () => {
        // An accent pick keeps the Calico dressing (paw prints, gradients) and only flags the accent as custom.
        const accentRuntime = createPaletteRuntime();
        accentRuntime.context.applyAccentColors('rgba(4, 5, 6, 1)', 'rgba(7, 8, 9, 1)');
        expect(accentRuntime.context.document.documentElement.dataset.neconyanPalette).toBe('calico');
        expect(accentRuntime.context.document.documentElement.dataset.neconyanAccent).toBe('custom');

        const directRuntime = createPaletteRuntime({ quote_text_color: 'rgba(4, 5, 6, 1)' });
        directRuntime.context.applyThemeColor('quote');
        expect(directRuntime.context.document.documentElement.dataset.neconyanPalette).toBe('calico');
        expect(directRuntime.context.document.documentElement.dataset.neconyanAccent).toBe('custom');
        directRuntime.context.power_user.quote_text_color = calicoDarkTheme.quote_text_color;
        directRuntime.context.applyThemeColor('quote');
        expect(directRuntime.context.document.documentElement.dataset.neconyanPalette).toBe('calico');
        expect(directRuntime.context.document.documentElement.dataset.neconyanAccent).toBe('theme');

        // Any other colour edit still leaves Calico entirely.
        const surfaceRuntime = createPaletteRuntime({ blur_tint_color: 'rgba(4, 5, 6, 1)' });
        surfaceRuntime.context.syncNeconyanPaletteAttribute();
        expect(surfaceRuntime.context.document.documentElement.dataset.neconyanPalette).toBe('custom');
        expect(surfaceRuntime.context.document.documentElement.dataset.neconyanAccent).toBe('custom');

        const reloadRuntime = createPaletteRuntime(JSON.parse(JSON.stringify(directRuntime.context.power_user)));
        reloadRuntime.context.syncNeconyanPaletteAttribute();
        expect(reloadRuntime.context.document.documentElement.dataset.neconyanPalette).toBe('calico');
        expect(reloadRuntime.context.document.documentElement.dataset.neconyanCalicoTone).toBe('dark');

        const lightRuntime = createPaletteRuntime({}, false);
        lightRuntime.context.syncNeconyanPaletteAttribute();
        expect(lightRuntime.context.document.documentElement.dataset.neconyanPalette).toBe('calico');
        expect(lightRuntime.context.document.documentElement.dataset.neconyanCalicoTone).toBe('light');
        expect(lightRuntime.context.document.documentElement.dataset.neconyanAccent).toBe('theme');
    });

    test('marks manually edited Calico colours and CSS as custom', () => {
        const source = readSource('public', 'scripts', 'power-user.js');

        expect(source).toContain('function markNeconyanPaletteCustom()');
        expect(source).toContain('$(\'#customCSS\').on(\'input\', () => {');
        expect(source).toContain('markNeconyanPaletteCustom();');
        expect(source).toContain('function resetToNeconyanCalicoTheme()');
        expect(source).toContain('applyTheme(NECONYAN_DARK_THEME_NAME, { theme: NECONYAN_CALICO_DARK_THEME_FALLBACK });');
    });

    test('keeps the tutorial free of the retired Advanced step', () => {
        const source = readSource('public', 'scripts', 'welcome-screen.js');

        expect(source).not.toContain("type: 'show-advanced'");
        expect(source).not.toContain('Show Advanced');
        expect(source).not.toContain('setAdvancedMode');
    });

    test('keeps World Info search aliases plural and discoverable', () => {
        expect(tabsSource).toContain('tab.id === \'world-info\' ? \'lore lorebook lorebooks\' : \'\'');
    });

    test('keeps the persistent workspace rail on real shell routes', () => {
        const welcomeSource = readSource('public', 'scripts', 'welcome-screen.js');

        expect(welcomeSource).toContain("rail.id = 'neconyan-workspace-rail'");
        expect(welcomeSource).toContain('id="neconyan-sidebar-toggle"');
        expect(welcomeSource).toContain('data-neconyan-route');
        expect(welcomeSource).toContain('globalThis.NeconyanShell');
        expect(welcomeSource).toContain("fetch('/api/chats/recent'");
    });
});

describe('Meower prompt defaults', () => {
    test('uses Meower in shipped prompts and preserves custom prompt text', () => {
        const defaultSettings = structuredClone(DEFAULTS);
        defaultSettings.images.enabled = true;
        const defaults = buildRefreshMessages({ accounts: [], active: [], persona: null, session: null, posts: [], interactions: [], settings: defaultSettings, now: 0, localTime: '' });
        const system = defaults[0].content;
        expect(system).toContain('called Meower');
        expect(defaults.map(message => message.content).join('\n')).not.toContain('Hopper');
        expect(system).toContain(DEFAULT_TONE);
        expect(defaults[1].content).toContain(DEFAULT_IMAGE_INSTRUCTIONS);

        const settings = JSON.parse(JSON.stringify(DEFAULTS));
        settings.tone = 'Custom Hopper tone\nKeep {{user}} and quoted words.';
        settings.images = { ...settings.images, enabled: true, instructions: 'Custom Hopper image instructions' };
        const originalSettings = structuredClone(settings);
        const custom = buildRefreshMessages({ accounts: [], active: [], persona: null, session: null, posts: [], interactions: [], settings, now: 0, localTime: '' });
        expect(custom[0].content).toContain(settings.tone);
        expect(custom[1].content).toContain(settings.images.instructions);
        expect(settings).toEqual(originalSettings);
    });

    test('uses bundled M PLUS Rounded 1c for body text and Fredoka One for headings without changing saved Google font state', () => {
        const index = readSource('public', 'index.html');
        const login = readSource('public', 'login.html');
        const style = readSource('public', 'style.css');
        const neconyanCss = readSource('public', 'css', 'neconyan.css');
        const nunito = readSource('public', 'webfonts', 'Nunito', 'stylesheet.css');
        const fredoka = readSource('public', 'webfonts', 'FredokaOne', 'stylesheet.css');
        expect(index).toContain('webfonts/Nunito/stylesheet.css?v=20260913g');
        expect(index).toContain('webfonts/Nunito/Nunito[wght].woff2?v=20260913g');
        expect((index.match(/webfonts\/Nunito\/Nunito\[wght\]\.woff2/g) || [])).toHaveLength(1);
        expect(index).toContain('webfonts/FredokaOne/stylesheet.css?v=20260913g');
        expect(index).toContain('webfonts/FredokaOne/FredokaOne-Regular.ttf?v=20260913g');
        expect((index.match(/webfonts\/FredokaOne\/FredokaOne-Regular\.ttf/g) || [])).toHaveLength(1);
        expect(index).toContain('Default (Fredoka One + M PLUS Rounded 1c)');
        expect(index).toContain('<option value="Nunito">Nunito</option>');
        expect(index).toContain('<option value="Fredoka One">Fredoka One</option>');
        expect(login).toContain('webfonts/FredokaOne/stylesheet.css?v=20260913g');
        expect(style).toContain("--mainFontFamily: 'M PLUS Rounded 1c', 'Nunito', 'Figtree'");
        expect(neconyanCss).toContain("--mainFontFamily: 'M PLUS Rounded 1c', 'Nunito', 'Figtree'");
        expect(neconyanCss).toContain("--sb-font-display: 'Fredoka One', var(--mainFontFamily);");
        // The picked-font override must carry :has(body.neconyan) or the (0,2,1) default above outranks it.
        expect(neconyanCss).toContain(":root[style*='--mainFontFamily']:has(body.neconyan) { --sb-font-display: var(--mainFontFamily); }");
        expect(neconyanCss).toContain('body.neconyan:not(.sbterm) :is(h1, h2, h3, h4, h5, h6, .sb-topbar-brand, .neconyan-rail-brand) { font-family: var(--sb-font-display); }');
        expect(nunito).toContain("font-family: 'Nunito';");
        expect(nunito).toContain('font-weight: 200 1000;');
        expect(nunito).toContain('font-display: swap;');
        expect(nunito).toContain('Nunito[wght].woff2?v=20260913g');
        expect(nunito).toContain('Nunito-Italic[wght].woff2?v=20260913g');
        expect(index).toContain('webfonts/MPLUSRounded1c/MPLUSRounded1c-Latin-500.woff2?v=20260916b');
        expect((index.match(/webfonts\/MPLUSRounded1c\/MPLUSRounded1c-Latin-500\.woff2/g) || [])).toHaveLength(1);
        expect(neconyanCss).toContain("font-family: 'M PLUS Rounded 1c';");
        expect(neconyanCss).toContain("url('/webfonts/MPLUSRounded1c/MPLUSRounded1c-Latin-500.woff2?v=20260916b')");
        expect(neconyanCss).toContain("url('/webfonts/MPLUSRounded1c/MPLUSRounded1c-Latin-700.woff2?v=20260916b')");
        expect(neconyanCss).toContain('font-weight: 500;');
        expect(neconyanCss).toContain('font-weight: 700;');
        expect(powerUserSource).toContain("'Fredoka One': '/webfonts/FredokaOne/stylesheet.css?v=20260913g'");
        expect(powerUserSource).toContain("Nunito: '/webfonts/Nunito/stylesheet.css?v=20260913g'");
        expect(powerUserSource).toContain("Figtree: '/webfonts/Figtree/stylesheet.css?v=20260422b'");
        expect(powerUserSource).toContain("google_font: '',");
        expect(fredoka).toContain("font-family: 'Fredoka One';");
        expect(fredoka).toContain('font-style: normal;');
        expect(fredoka).toContain('font-weight: 400;');
        expect(fredoka).toContain('font-display: swap;');
        expect(fredoka).toContain("FredokaOne-Regular.ttf?v=20260913g");
        expect(fredoka).not.toContain('font-style: italic');
    });

    test('purges caches through both current and legacy service-worker protocols', () => {
        expect(scriptSource).toContain("controller.postMessage({ type: 'NN_CLEAR_CACHES' }");
        expect(scriptSource).toContain("controller.postMessage({ type: 'SB_CLEAR_CACHES' }");
        expect(scriptSource).toContain("event?.data?.type === 'NN_CLEAR_CACHES_DONE'");
        expect(scriptSource).toContain("event?.data?.type === 'SB_CLEAR_CACHES_DONE'");
    });

    test('new profiles default the message chrome toggles to on', () => {
        for (const key of ['timestamp_model_icon', 'timestamp_model_name', 'timestamp_reasoning_effort', 'mesIDDisplay_enabled', 'message_token_count_enabled']) {
            expect(powerUserSource).toMatch(new RegExp(`^\\s*${key}: true,$`, 'm'));
        }
    });
});
