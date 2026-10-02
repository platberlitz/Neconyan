import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

describe('Neconyan accent color profiles', () => {
    const indexSource = readSource('public', 'index.html');
    const powerUserSource = readSource('public', 'scripts', 'power-user.js');
    const themeCssSource = readSource('public', 'css', 'neconyan-theme.css');
    const seedBlock = powerUserSource.match(/const NECONYAN_ACCENT_PROFILE_SEEDS = Object\.freeze\(\[([\s\S]*?)\]\);/)?.[1] ?? '';

    test('ships a generous seeded profile set by default', () => {
        const seedNames = [...seedBlock.matchAll(/name: '([^']+)'/g)].map(match => match[1]);

        expect(powerUserSource).toContain('const NN_ACCENT_PROFILE_SEED_VERSION = 3;');
        expect(powerUserSource).toContain('sb_accent_profiles: NECONYAN_ACCENT_PROFILE_SEEDS.map(profile => ({ ...profile }))');
        expect(powerUserSource).toContain('sb_accent_profiles_seed_version: NN_ACCENT_PROFILE_SEED_VERSION');
        expect(powerUserSource).toContain('function normalizeAccentProfiles()');
        expect(seedNames).toHaveLength(38);
        expect(seedNames).toEqual(expect.arrayContaining([
            'Warm Signal',
            'Story Moss',
            'Rose Glow',
            'Tidepool',
            'Graphite Glow',
            'Aurora Veil',
            'Solar Flare',
            'Neptune',
            'Midnight Ink',
            'Black Cherry',
            'Aubergine',
            'Deep Ocean',
            'Pine Shadow',
            'Espresso',
            'Storm Slate',
            'Oxblood',
        ]));
    });

    test('adds dark profiles once during migration without replacing personal colours', () => {
        const constants = powerUserSource.slice(powerUserSource.indexOf('const NN_ACCENT_PROFILE_SEED_VERSION'), powerUserSource.indexOf('const THEME_COLOR_PROPERTIES'));
        const functions = powerUserSource.slice(powerUserSource.indexOf('function getSeedAccentProfiles()'), powerUserSource.indexOf('function getAccentProfile(index)'));
        const personal = { name: 'My colours', quote_text_color: 'rgba(12, 34, 56, 1)', underline_text_color: 'rgba(65, 43, 21, 1)' };
        const editedSeed = { ...personal, name: 'Warm Signal' };
        const state = { sb_accent_profiles: [personal, editedSeed], sb_accent_profiles_seed_version: 2 };
        const normalize = runInNewContext(`${constants}\n${functions}\nnormalizeAccentProfiles`, { power_user: state });
        expect(normalize()).toBe(true);
        expect(state.sb_accent_profiles_seed_version).toBe(3);
        expect(state.sb_accent_profiles).toHaveLength(39);
        expect(state.sb_accent_profiles.slice(0, 2)).toEqual([personal, editedSeed]);
        expect(state.sb_accent_profiles.some(profile => profile.name === 'Midnight Ink')).toBe(true);
        expect(normalize()).toBe(false);
        expect(state.sb_accent_profiles).toHaveLength(39);
    });

    test('persists profiles in power_user and migrates seeds during settings load', () => {
        expect(powerUserSource).toContain('Object.hasOwn(settings.power_user, \'sb_accent_profiles_seed_version\')');
        expect(powerUserSource).toContain('power_user.sb_accent_profiles_seed_version = 0;');
        expect(powerUserSource).toContain('if (normalizeAccentProfiles()) {\n        saveSettingsDebounced();\n    }');
        expect(powerUserSource).toContain('power_user.sb_accent_profiles = normalizedProfiles;');
    });

    test('applies exactly the primary and secondary accent colors', () => {
        expect(powerUserSource).toContain('function applyAccentColors(quoteColor, underlineColor)');
        expect(powerUserSource).toContain('power_user.quote_text_color = quoteColor;');
        expect(powerUserSource).toContain('power_user.underline_text_color = underlineColor;');
        expect(powerUserSource).toContain('applyThemeColor(\'quote\');');
        expect(powerUserSource).toContain('applyThemeColor(\'underline\');');
        expect(powerUserSource).toContain('applyAccentColors(profile.quote_text_color, profile.underline_text_color);');
        expect(powerUserSource).toContain('syncCustomAccentPickersFromState();');
    });

    test('wires the appearance UI and responsive profile controls', () => {
        expect(indexSource).toContain('id="sb-accent-profile-save"');
        expect(indexSource).toContain('id="sb-accent-profiles-panel"');
        expect(indexSource).toContain('id="sb-accent-profiles-list"');
        expect(indexSource).toContain('id="sb-accent-profiles-empty"');
        expect(indexSource).toContain('class="sb-accent-profiles-content"');
        expect(indexSource).toContain('data-i18n="Saved accent pairs"');
        expect(indexSource).not.toContain('sb-accent-profiles-toggle');
        expect(indexSource).toContain('css/neconyan-theme.css?v=');
        expect(powerUserSource).not.toContain('NN_ACCENT_PROFILES_DRAWER_KEY');
        expect(powerUserSource).not.toContain('bindNnAccentProfilesDrawerPersistence');
        expect(powerUserSource).toContain('$(document).on(\'click\', \'#sb-accent-profile-save\'');
        expect(powerUserSource).toContain('$(document).on(\'click\', \'.sb-accent-profile-apply\'');
        expect(powerUserSource).toContain('$(document).on(\'click\', \'.sb-accent-profile-delete\'');
        expect(themeCssSource).toContain('.sb-accent-profiles-panel');
        expect(themeCssSource).not.toContain('.sb-accent-profiles-toggle');
        expect(themeCssSource).toContain('.sb-accent-profiles-content');
        expect(themeCssSource).toContain('grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));');
        expect(themeCssSource).toContain('@media screen and (max-width: 768px)');
        expect(themeCssSource).toContain('.sb-accent-profiles-list {\n        grid-template-columns: 1fr;\n    }');
    });

    test('picks the accent ink against the pure accent and feeds it to the Neconyan tokens', () => {
        const neconyanCssSource = readSource('public', 'css', 'neconyan.css');
        const calicoCssSource = readSource('public', 'css', 'neconyan-calico.css');

        expect(powerUserSource).toContain('const accentInk = getContrastAwareInk([quoteChannels]);');
        expect(powerUserSource).toContain('document.documentElement.style.setProperty(\'--neco-accent-ink\', accentInk);');
        expect(neconyanCssSource).toContain('--neco-on-accent: var(--neco-accent-ink, var(--neco-canvas));');
        expect(neconyanCssSource).toContain('--neco-action-gradient: var(--neco-accent-gradient);');
        expect(calicoCssSource).toContain(':root[data-neconyan-palette=\'calico\'][data-neconyan-accent=\'custom\'] body.neconyan {');
    });

    test('uses the secondary colour for paired gradients and persistent shell highlights', () => {
        const css = readSource('public', 'css', 'neconyan.css');
        const calico = readSource('public', 'css', 'neconyan-calico.css');
        expect(css).toContain(':root[data-neconyan-accent=\'custom\'] body.neconyan { --neco-accent-secondary: var(--SmartThemeUnderlineColor); }');
        expect(css.match(/--neco-accent-gradient: ([^;]+);/)[1]).toContain('var(--neco-accent-secondary)');
        expect(calico).toContain('box-shadow: inset 3px 0 0 var(--neco-accent-secondary);');
        expect(calico).toContain('--neco-ginger-hover: color-mix(in oklch, var(--SmartThemeUnderlineColor) 40%, #fff);');
    });

    test('gives custom secondary accents selected navigation surfaces without changing primary actions', () => {
        const css = readSource('public', 'css', 'neconyan.css');
        expect(css).toContain('--sb-shell-tab-active-bg: color-mix(in srgb, var(--neco-accent-secondary) 16%, var(--neco-surface));');
        expect(css).toContain('--sb-state-active-border: color-mix(in srgb, var(--neco-accent-secondary) 60%, var(--neco-border));');
        expect(css).toContain('--sb-state-active-bg: color-mix(in srgb, var(--neco-accent-secondary) 16%, var(--neco-rail));');
        expect(css).toContain(':root[data-neconyan-accent=\'custom\']:not([data-sb-theme=\'windows-98\']) body.neconyan:not(.sbterm) :is(');
        expect(css).toContain('.sb-conversation-settings-nav button[aria-current=\'page\']');
        expect(css).toContain('--sb-on-solid-accent: var(--neco-on-accent);');
    });
});
