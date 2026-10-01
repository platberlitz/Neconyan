import { describe, expect, test } from '@jest/globals';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

const tabsSource = readSource('public', 'scripts', 'neconyan-tabs.js');
const indexHtml = readSource('public', 'index.html');
const shellStylesDir = path.join(repoRoot, 'public', 'css', 'shell-styles');

// Shell styles other than Calico ship as runtime stylesheets in public/css/shell-styles.
// They load after the core sheets, so they stay outside the blocking CSS budget, and they
// layer over the Calico palette instead of replacing it. This suite pins the contract that
// keeps that wiring honest: one sheet per style, the same version string in the early head
// script and the shell script, and rules that only apply while their style is selected.
function readThemeIds() {
    const match = tabsSource.match(/const NN_THEMES = Object\.freeze\(\[([\s\S]*?)\]\);/);
    expect(match).not.toBeNull();
    return [...match[1].matchAll(/id:\s*'([^']+)'/g)].map(m => m[1]);
}

function readShellScriptVersion() {
    const match = tabsSource.match(/const NN_SHELL_STYLE_STYLESHEET_VERSION = '([^']+)';/);
    expect(match).not.toBeNull();
    return match[1];
}

function readHeadScript() {
    const match = indexHtml.match(/<script>\s*\(function \(\) \{\s*try \{\s*var shellStyle = localStorage\.getItem\('sb-theme'\);([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    return match[0];
}

function stripCssBlockComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '));
}

function collectSelectors(source) {
    const selectors = [];
    const stripped = stripCssBlockComments(source);
    let buffer = '';
    for (const char of stripped) {
        if (char === '{') {
            const text = buffer.trim();
            // At-rules such as @media wrap ordinary rules; only the selectors themselves count.
            if (text && !text.startsWith('@')) selectors.push(text);
            buffer = '';
        } else if (char === '}') {
            buffer = '';
        } else {
            buffer += char;
        }
    }
    return selectors;
}

// Split a selector list on commas that sit outside :is()/:not() parentheses.
function splitSelectorList(group) {
    const parts = [];
    let depth = 0;
    let buffer = '';
    for (const char of group) {
        if (char === '(') depth += 1;
        if (char === ')') depth -= 1;
        if (char === ',' && depth === 0) {
            parts.push(buffer.trim());
            buffer = '';
        } else {
            buffer += char;
        }
    }
    if (buffer.trim()) parts.push(buffer.trim());
    return parts;
}

const themeIds = readThemeIds();
const runtimeIds = themeIds.filter(id => id !== 'calico');

describe('shell style runtime stylesheets', () => {
    test('every shell style other than Calico ships a sheet, and nothing else does', () => {
        const shipped = readdirSync(shellStylesDir).filter(name => name.endsWith('.css')).map(name => name.replace(/\.css$/, '')).sort();
        expect(shipped).toEqual([...runtimeIds].sort());
        expect(themeIds).toContain('calico');
    });

    test('the early head script knows the same style ids and version as the shell script', () => {
        const headScript = readHeadScript();
        const listMatch = headScript.match(/\[([^\]]+)\]\.indexOf\(shellStyle\)/);
        expect(listMatch).not.toBeNull();
        const headIds = [...listMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]).sort();
        expect(headIds).toEqual([...runtimeIds].sort());

        const version = readShellScriptVersion();
        expect(headScript).toContain(`'css/shell-styles/' + shellStyle + '.css?v=${version}'`);
        expect(headScript).toContain('link.setAttribute(\'data-sb-shell-style\', shellStyle)');
        expect(headScript).toContain('document.documentElement.setAttribute(\'data-sb-theme\', shellStyle)');
    });

    test('the shell script injects and removes the runtime link when the style changes', () => {
        expect(tabsSource).toMatch(/function syncShellStyleStylesheet\(themeId\)/);
        expect(tabsSource).toMatch(/function setShellTheme\([\s\S]*?syncShellStyleStylesheet\(nextTheme\)/);
        expect(tabsSource).toContain('return `css/shell-styles/${themeId}.css?v=${NN_SHELL_STYLE_STYLESHEET_VERSION}`');
    });

    for (const id of runtimeIds) {
        const protectedDecorations = id === 'kittyless' ? [] : ['.neconyan-whiskers', '.neconyan-cat-panel::before'];
        test(`${id} only styles its own shell and layers over Calico`, () => {
            const source = readSource('public', 'css', 'shell-styles', `${id}.css`);
            const stripped = stripCssBlockComments(source);

            const prefix = `:root[data-sb-theme='${id}']`;
            const selectors = collectSelectors(source);
            expect(selectors.length).toBeGreaterThan(10);
            const unscoped = selectors.flatMap(splitSelectorList).filter(part => !part.startsWith(prefix));
            expect(unscoped).toEqual([]);

            // The palette, fonts and message tints stay. Kittyless alone intentionally hides
            // the cat decorations. Other styles must still leave them untouched.
            // Muted text may be re-derived from the user's own ink when a style forces its own
            // panel colour (Windows 98 silver or dark grey); that adds no new palette colour.
            // Windows 98 may also swap the user's ink for the lifted copy the theme code works
            // out from that same ink when it would vanish on the grey faces.
            const withoutExclusions = stripped.replaceAll(':not(.neconyan-whiskers)', '')
                .replace(/--neco-muted: color-mix\(in srgb, var\(--neco-ink\) \d+%, var\(--w98-face\)\);/g, '')
                .replace(/--(?:neco-ink|SmartThemeBodyColor): var\(--neco-ink-on-face, #[0-9a-f]{3,6}\);/g, '');
            const forbiddenTokens = ['--neco-canvas:', '--neco-ink:', '--neco-muted:', '--neco-ginger:', '--neco-user:', '--mainFontFamily:', '--sb-font-display:', '--SmartThemeBotMesBlurTintColor', '--SmartThemeUserMesBlurTintColor',
                ...protectedDecorations];
            for (const forbidden of forbiddenTokens) {
                expect(withoutExclusions).not.toContain(forbidden);
            }

            // Runtime sheets sit outside the !important budget, so they must not lean on it,
            // and any motion would need a reduced-motion guard the sheets do not carry.
            expect(stripped).not.toMatch(/!important/);
            expect(stripped).not.toMatch(/\b(transition|animation)\s*:/);
            expect(stripped).not.toMatch(/(^|[^:])\/\//m);

            for (const [, asset] of stripped.matchAll(/url\('\.\.\/\.\.\/([^'?]+)(?:\?[^']*)?'\)/g)) {
                expect(existsSync(path.join(repoRoot, 'public', asset))).toBe(true);
            }
        });
    }

    test('every style, Calico included, follows the chosen accent colour', () => {
        const signatureHues = { kittyless: '--kittyless-primary:', 'windows-aero': '--aero-hue:', 'windows-98': '--w98-title:', 'cozy-warm': '--cozy-amber:', 'hypr-glow': '--hypr-b:', 'slate-flat': '--slate-cool:', 'clean-minimal': '--clean-line-strong:' };
        for (const [id, hueVar] of Object.entries(signatureHues)) {
            const source = stripCssBlockComments(readSource('public', 'css', 'shell-styles', `${id}.css`));
            const customBlock = source.match(new RegExp(`:root\\[data-sb-theme='${id}'\\]\\[data-neconyan-accent='custom'\\] body\\.neconyan:not\\(\\.sbterm\\) \\{([^}]*)\\}`));
            expect(customBlock).not.toBeNull();
            expect(customBlock[1]).toContain(hueVar);
            expect(customBlock[1]).toContain(id === 'hypr-glow' ? 'var(--neco-accent-secondary)' : 'var(--neco-ginger)');
        }
        expect(readSource('public', 'css', 'shell-styles', 'macos-minimal.css')).toMatch(/> i:not\(\.neconyan-whiskers\) \{\s*color: var\(--neco-ginger\);/);

        const calico = stripCssBlockComments(readSource('public', 'css', 'neconyan-calico.css'));
        expect(calico).toContain('--neco-pink: color-mix(in oklch, var(--SmartThemeQuoteColor) 55%, #efb0bd);');
        expect(calico).toMatch(/\[data-neconyan-calico-tone='light'\]\[data-neconyan-accent='custom'\] body\.neconyan :is\(#neconyan-workspace-rail, #sb-mobile-nav-content\) \{[^}]*--neco-ginger: color-mix\(in oklch, var\(--SmartThemeQuoteColor\)/);
        expect(calico).toMatch(/body\.neconyan ::selection \{[^}]*var\(--neco-ginger\)/);
    });

    test('every runtime style uses the second accent in its own decoration', () => {
        for (const id of runtimeIds) {
            expect(readSource('public', 'css', 'shell-styles', `${id}.css`)).toContain('var(--neco-accent-secondary)');
        }
    });
});

describe('Windows 98 hourglass cats', () => {
    const win98 = (...parts) => path.join(repoRoot, 'public', 'img', 'neconyan', 'win98', ...parts);
    const webpFrames = file => {
        const bytes = readFileSync(win98(file));
        expect(bytes.toString('latin1', 0, 4)).toBe('RIFF');
        expect(bytes.toString('latin1', 8, 12)).toBe('WEBP');
        let frames = 0;
        for (let offset = 12; offset + 8 <= bytes.length;) {
            const size = bytes.readUInt32LE(offset + 4);
            if (bytes.toString('latin1', offset, offset + 4) === 'ANMF') frames++;
            offset += 8 + size + (size % 2);
        }
        return frames;
    };

    test('the moving cats spin their hourglass and the still ones do not', () => {
        expect(webpFrames('startup-cat.webp')).toBeGreaterThanOrEqual(6);
        expect(webpFrames('home-cat.webp')).toBeGreaterThanOrEqual(6);
        expect(webpFrames('startup-cat-still.webp')).toBe(0);
        expect(webpFrames('startup-cat-rest.webp')).toBe(0);
    });

    test('reduced motion swaps the spinning cats for still copies', () => {
        const css = stripCssBlockComments(readSource('public', 'css', 'shell-styles', 'windows-98.css'));
        const running = "img[src*='img/neconyan-pixel-cat-running.webp'] { content: url('../../img/neconyan/win98/";
        const moving = "img[src*='img/neconyan-pixel-cat.webp'] { content: url('../../img/neconyan/win98/";
        expect(css).toContain(`body.neconyan ${running}startup-cat.webp`);
        expect(css).toContain(`body.neconyan ${moving}home-cat.webp`);
        const media = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/);
        expect(media).not.toBeNull();
        expect(media[1]).toContain(`${running}startup-cat-still.webp`);
        expect(media[1]).toContain(`${moving}startup-cat-rest.webp`);
        expect(css).toContain(`body.neconyan.reduced-motion ${running}startup-cat-still.webp`);
        expect(css).toContain(`body.neconyan.reduced-motion ${moving}startup-cat-rest.webp`);
    });
});
