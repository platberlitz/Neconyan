import { parse } from '@adobe/css-tools';
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

const tabsSource = readSource('public', 'scripts', 'neconyan-tabs.js');
const previewModuleSource = readSource('public', 'scripts', 'neconyan-shell-style-preview.js');
const uiThemesCss = readSource('public', 'css', 'neconyan-ui-themes.css');

// Every Shell Style option shows an isolated miniature of its style, in the same spirit as the
// UI theme palette strip and the chat layout miniatures. This suite pins the wiring: one preview
// per theme id, one matching CSS rule per id, everything scoped to the shell style drawer, and
// no motion in the samples (they are static pictures, not live shells).
function readThemeIds() {
    const match = tabsSource.match(/const NN_THEMES = Object\.freeze\(\[([\s\S]*?)\]\);/);
    expect(match).not.toBeNull();
    return [...match[1].matchAll(/id:\s*'([^']+)'/g)].map(m => m[1]);
}

describe('shell style option previews', () => {
    test('the shell script builds a preview inside every theme option', () => {
        expect(tabsSource).toContain('import { createShellStylePreview } from \'./neconyan-shell-style-preview.js\';');
        const loop = tabsSource.match(/for \(const theme of NN_THEMES\) \{([\s\S]*?)\n {4}\}\n/);
        expect(loop).not.toBeNull();
        expect(loop[1]).toContain('createShellStylePreview(theme.id)');
        expect(loop[1]).toContain('button.append(preview, label)');
        expect(loop[1]).toContain('label.textContent = theme.label;');
    });

    test('the preview builder marks its sample as decorative and tags it with the theme id', () => {
        expect(previewModuleSource).toContain('preview.className = \'sb-shell-style-preview\';');
        expect(previewModuleSource).toContain('preview.dataset.sbShellPreview = themeId;');
        expect(previewModuleSource).toContain('preview.setAttribute(\'aria-hidden\', \'true\');');
        expect(previewModuleSource).toContain('\'sb-shell-preview-bar\'');
        expect(previewModuleSource).toContain('\'sb-shell-preview-body\'');
    });

    test('every theme id has preview CSS in the deferred themes sheet', () => {
        const themeIds = readThemeIds();
        expect(themeIds.length).toBeGreaterThan(0);
        // Kittyless is the base window by design (Calico without the ears); pin its per-id
        // absence so it cannot drift into growing its own chrome.
        const baseWindowStyles = new Set(['kittyless']);
        const styledIds = themeIds.filter(id => !baseWindowStyles.has(id));
        const baseIds = themeIds.filter(id => baseWindowStyles.has(id));
        for (const id of styledIds) {
            expect(uiThemesCss).toContain(`[data-sb-shell-preview='${id}']`);
        }
        for (const id of baseIds) {
            expect(uiThemesCss).not.toContain(`[data-sb-shell-preview='${id}']`);
        }
    });

    test('preview rules stay scoped to the shell style drawer', () => {
        const lines = uiThemesCss.split('\n');
        for (const [index, line] of lines.entries()) {
            if (!/sb-shell-(style-preview|preview-)/.test(line)) continue;
            const trimmed = line.trim();
            if (trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
            expect(lines[index]).toContain('#sb-shell-style-drawer');
        }
    });

    test('preview samples carry no motion declarations', () => {
        const sectionStart = uiThemesCss.indexOf('Shell style miniatures');
        expect(sectionStart).toBeGreaterThan(-1);
        const section = uiThemesCss.slice(sectionStart);
        expect(section).not.toMatch(/\b(transition|animation)\s*:/);
        expect(section).not.toMatch(/@keyframes/);
    });

    test('the themes sheet still parses as CSS', () => {
        const ast = parse(uiThemesCss, { source: 'neconyan-ui-themes.css' });
        expect(ast.stylesheet.rules.length).toBeGreaterThan(0);
    });
});
