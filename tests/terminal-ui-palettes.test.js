import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(repoRoot, 'public', 'scripts', 'extensions', 'third-party', 'Neconyan-Terminal-UI');
const indexSource = fs.readFileSync(path.join(extensionRoot, 'index.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(extensionRoot, 'style.css'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
const hostSource = fs.readFileSync(path.join(repoRoot, 'public', 'css', 'neconyan.css'), 'utf8');

const paletteList = indexSource.slice(indexSource.indexOf('const PALETTES = ['), indexSource.indexOf('];', indexSource.indexOf('const PALETTES = [')));
const paletteIds = [...paletteList.matchAll(/\['([a-z0-9-]+)', '/g)].map(match => match[1]);
const TOKENS = ['bg', 'bg-alt', 'fg', 'fg-dim', 'accent', 'accent2', 'ok', 'warn', 'err', 'border', 'glow'];
const NEW_PALETTES = ['catppuccin-mocha', 'tokyo-night', 'rose-pine', 'monokai', 'commodore-64', 'tuxedo-cat', 'solarized-light', 'sakura-latte'];
const LIGHT_PALETTES = ['gameboy-dmg', 'chrome-98', 'paper-tape', 'biometric-lab', 'newsprint', 'solarized-light', 'sakura-latte'];

function paletteTokens(id) {
    const match = styleSource.match(new RegExp(`body\\.sbterm\\[data-sbterm-palette='${id}'\\] \\{([^}]*)\\}`));
    if (!match) return null;
    return Object.fromEntries([...match[1].matchAll(/--sbterm-([a-z0-9-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
        .map(value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(first, second) {
    const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
}

describe('Termeownal UI palettes', () => {
    test('lists 45 choices, including the eight added palettes, and the manifest says so', () => {
        expect(paletteIds).toHaveLength(45);
        expect(new Set(paletteIds).size).toBe(paletteIds.length);
        expect(paletteIds).toEqual(expect.arrayContaining(NEW_PALETTES));
        expect(paletteIds.at(-1)).toBe('inherit');
        expect(manifest.description).toContain(`${paletteIds.length} palettes`);
    });

    test('every palette defines the full token set', () => {
        for (const id of paletteIds.filter(id => id !== 'phosphor-green' && id !== 'inherit')) {
            const tokens = paletteTokens(id);
            expect({ id, missing: tokens ? TOKENS.filter(token => !(token in tokens)) : TOKENS }).toEqual({ id, missing: [] });
        }
    });

    test('added palettes keep readable text and visible borders on both surfaces', () => {
        for (const id of NEW_PALETTES) {
            const tokens = paletteTokens(id);
            for (const token of ['fg', 'fg-dim', 'accent', 'accent2', 'ok', 'warn', 'err']) {
                const ratio = Math.min(contrast(tokens[token], tokens.bg), contrast(tokens[token], tokens['bg-alt']));
                expect({ id, token, readable: ratio >= 4.5 }).toEqual({ id, token, readable: true });
            }
            expect({ id, onAccent: contrast(tokens.bg, tokens.accent) >= 4.5 }).toEqual({ id, onAccent: true });
            expect({ id, border: contrast(tokens.border, tokens.bg) >= 3 }).toEqual({ id, border: true });
        }
    });

    test('light palettes switch the colour scheme and avatar tint together', () => {
        const lightList = LIGHT_PALETTES.map(id => `[data-sbterm-palette='${id}']`).join(', ');
        expect(styleSource).toContain(`html:root body.neconyan.sbterm:is(${lightList}),`);
        expect(styleSource).toContain(`body.sbterm.sbterm-avatar-tinted:is(${lightList}) {`);
    });
});

describe('Termeownal UI round controls', () => {
    test('the flat reset leaves checkboxes and radios round', () => {
        const exclusion = ':not([class*=\'avatar\' i], [id*=\'avatar\' i], input[type=\'checkbox\'], input[type=\'radio\'])';
        for (const suffix of [',', '::before,', '::after {']) {
            expect(styleSource).toContain(`html body.sbterm *${exclusion}${suffix}`);
        }
    });

    test('bundled extension settings do not stretch checkboxes and radios to button height', () => {
        expect(hostSource).toContain('.sbdistiller-root) :is(button, input:not([type=\'checkbox\'], [type=\'radio\']), textarea, select, summary) {');
    });
});
