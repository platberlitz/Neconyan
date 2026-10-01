import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(root, file), 'utf8');
const css = read('public/css/shell-styles/windows-98.css');
const powerUser = read('public/scripts/power-user.js');

describe('Windows 98 shell style stays readable with custom colours', () => {
    test('the theme code records whether the chosen text colour is light or dark', () => {
        expect(powerUser).toMatch(/dataset\.sbTextTone = getContrastAwareInk\(\[textChannels\]\) === 'rgb\(0, 0, 0\)' \? 'light' : 'dark'/);
    });

    test('accent colours get deep variants that keep white caption text readable', () => {
        expect(powerUser).toContain('export function getDeepAccentColor(channels, minimumContrast = 4.5)');
        expect(powerUser).toContain('setProperty(\'--neco-accent-deep\', getDeepAccentColor(quoteChannels, 4.5))');
        expect(powerUser).toContain('setProperty(\'--neco-accent-secondary-deep\', getDeepAccentColor(secondaryChannels, 4.5))');
    });

    test('silver faces only apply when the text is dark', () => {
        expect(css).toContain(':root[data-sb-theme=\'windows-98\'][data-sb-surface-tone=\'light\']:not([data-sb-text-tone=\'light\']) body.neconyan:not(.sbterm) {');
    });

    test('bright text on a light surface switches the faces to dark grey', () => {
        const rule = css.match(/\[data-sb-surface-tone='light'\]\[data-sb-text-tone='light'\] body\.neconyan:not\(\.sbterm\) \{([^}]*)\}/);
        expect(rule).not.toBeNull();
        expect(rule[1]).toContain('--w98-face: #3c3c3c;');
        expect(rule[1]).toContain('--neco-muted: color-mix(in srgb, var(--neco-ink) 78%, var(--w98-face));');
    });

    test('custom accent captions use the deep accent colours', () => {
        expect(css).toContain('--w98-title: var(--neco-accent-deep,');
        expect(css).toContain('--w98-title-end: var(--neco-accent-secondary-deep,');
    });

    test('every caption text line uses the caption ink', () => {
        expect(css).toMatch(/\.sb-shell-header :is\([^)]*\.sb-shell-description[^)]*\) \{\s*color: var\(--w98-title-ink\);/);
    });

    test('the phone drawer description beats the muted drawer rule', () => {
        expect(css).toMatch(/:is\(#left-nav-panel, #user-settings-block\)\.openDrawer \.sb-shell-header \.sb-shell-description \{\s*color: var\(--w98-title-ink\);/);
    });

    test('dark text on a dark surface is lifted to a readable copy of itself', () => {
        expect(powerUser).toContain('export function getLiftedInkColor(channels, backgroundChannels, minimumContrast = 4.5)');
        expect(powerUser).toContain('setProperty(\'--neco-ink-on-face\', getLiftedInkColor(textChannels, faceChannels, 7))');
        const rule = css.match(/\[data-sb-surface-tone='dark'\]\[data-sb-text-tone='dark'\] body\.neconyan:not\(\.sbterm\) \{([^}]*)\}/);
        expect(rule).not.toBeNull();
        expect(rule[1]).toContain('--neco-ink: var(--neco-ink-on-face, #f0f0f0);');
        expect(rule[1]).toContain('--neco-muted: color-mix(in srgb, var(--neco-ink) 78%, var(--w98-face));');
    });
});
