import { parse } from '@adobe/css-tools';
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
    let keyframeDepth = 0;
    for (const char of stripped) {
        if (char === '{') {
            const text = buffer.trim();
            if (keyframeDepth > 0) {
                keyframeDepth += 1;
            } else if (/^@(?:-\w+-)?keyframes\b/i.test(text)) {
                keyframeDepth = 1;
            } else if (text && !text.startsWith('@')) {
                // At-rules such as @media wrap ordinary rules; only the selectors themselves count.
                selectors.push(text);
            }
            buffer = '';
        } else if (char === '}') {
            if (keyframeDepth > 0) keyframeDepth -= 1;
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

const backedLibraryStyles = new Set(['windows-aero', 'macos-minimal', 'hypr-glow']);
const animatedStyles = new Set(['starlight-conservatory', 'sunken-reef']);
const importantPattern = /!\s*important\b/gi;

function auditMotionDeclarations(stripped, id) {
    if (animatedStyles.has(id)) {
        const missing = [];
        if (!/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/.test(stripped)) missing.push('prefers-reduced-motion');
        if (!stripped.includes('body.neconyan.reduced-motion')) missing.push('body.neconyan.reduced-motion');
        return missing;
    }
    return stripped.match(/\b(transition|animation)\s*:/g) ?? [];
}
const normaliseInnerSpaces = text => text.trim().replace(/\s+/g, ' ').replace(/([([])\s+/g, '$1').replace(/\s+([)\]])/g, '$1');
const normaliseSelector = text => normaliseInnerSpaces(text).replace(/\s*([>+~,=])\s*/g, '$1');
const normaliseValue = text => normaliseInnerSpaces(text).replace(/\s*,\s*/g, ',').replace(/\s*!\s*important\b/gi, '!important');
const normaliseMedia = text => normaliseInnerSpaces(text).replace(/\s*:\s*/g, ':');

function auditImportantDeclarations(source, id) {
    const ast = parse(source, { source: `${id}.css` });
    const important = [];
    const errors = [];
    function visit(nodes, ancestors = []) {
        for (const node of nodes) {
            for (const declaration of node.declarations ?? []) {
                if (declaration.type === 'declaration' && /!\s*important\b/i.test(declaration.value)) {
                    important.push({ node, declaration, ancestors });
                }
            }
            if (Array.isArray(node.rules)) visit(node.rules, [...ancestors, node]);
            if (Array.isArray(node.keyframes)) visit(node.keyframes, [...ancestors, node]);
        }
    }
    visit(ast.stylesheet.rules);
    const rawCount = [...stripCssBlockComments(source).matchAll(importantPattern)].length;
    if (rawCount !== important.length) errors.push('source and parsed important counts differ');
    const expectedCount = backedLibraryStyles.has(id) ? 1 : 0;
    if (important.length !== expectedCount) errors.push('unexpected important count');
    if (expectedCount === 1 && important.length === 1) {
        const { node, declaration, ancestors } = important[0];
        const expectedSelector = `:root[data-sb-theme='${id}'] body.neconyan:not(.sbterm) #right-nav-panel.openDrawer:is([data-menu-type='characters'], [data-menu-type='world-info'])`;
        const expectedValue = 'linear-gradient(var(--neco-rail), var(--neco-rail)), var(--neco-surface) !important';
        if (ancestors.length !== 1 || ancestors[0].type !== 'media'
            || normaliseMedia(ancestors[0].media) !== '(min-width:769px)') errors.push('wrong media ancestry');
        if (node.type !== 'rule' || node.selectors.length !== 1
            || normaliseSelector(node.selectors[0]) !== normaliseSelector(expectedSelector)) errors.push('wrong selector');
        if (node.declarations.filter(item => item.type === 'declaration').length !== 1
            || declaration.property !== 'background' || normaliseValue(declaration.value) !== normaliseValue(expectedValue)) errors.push('wrong declaration');
    }
    return errors;
}

const themeIds = readThemeIds();
const runtimeIds = themeIds.filter(id => id !== 'calico');

describe('shell style runtime stylesheets', () => {
    test('Windows page layouts and caption ink stay in their owning styles and roots', () => {
        for (const id of ['windows-xp', 'windows-98', 'windows-aero']) {
            const source = readSource('public', 'css', 'shell-styles', `${id}.css`);
            const desktop = source.slice(source.indexOf('/* Character-family captions'));
            expect(desktop).toContain('@media (min-width: 769px)');
            expect(desktop).not.toContain('#user-settings-block.openDrawer');
            expect(desktop).toContain('#right-nav-panel.neconyan-character-workspace.openDrawer > .sb-character-shell-nav-wrapper');
            expect(desktop).toContain('#rightNavHolder > #right-nav-panel.neconyan-character-workspace.openDrawer > .sb-character-shell-header.neconyan-cat-panel');
            expect(desktop).toContain('padding: 16px 116px 16px 18px');
            expect(desktop).not.toMatch(/!important|\b(?:transition|animation)\s*:/);
        }
        const core = readSource('public', 'css', 'neconyan.css');
        expect(core).toContain('--neco-workspace-nav-width: 208px;');
        expect(core).toContain('grid-template-columns: var(--neco-workspace-nav-width) minmax(0, 1fr);');
        expect(core).toMatch(/body\.neconyan \.sb-shell-root\.openDrawer \.sb-shell-nav-wrapper\s*\{[^}]*height: 100%;/);
        expect(core).toMatch(/body\.neconyan \.sb-shell-root\.openDrawer \.sb-shell-nav\s*\{[^}]*flex-direction: column;[^}]*height: 100%;/);
        for (const id of ['windows-xp', 'windows-98']) {
            const source = readSource('public', 'css', 'shell-styles', `${id}.css`);
            expect(source).toContain(':is(#left-nav-panel, #user-settings-block).openDrawer .sb-shell-header {');
            expect(source).not.toContain(':is(#left-nav-panel, #user-settings-block, #right-nav-panel).openDrawer .sb-shell-header {');
        }
        const classic = readSource('public', 'css', 'shell-styles', 'windows-98.css');
        expect(classic).toContain('--sb-settings-tab-ink: var(--w98-title-ink)');
        expect(classic).toContain('#right-nav-panel.openDrawer > .sb-character-shell-header :is(.sb-shell-subtitle');
        expect(readSource('public', 'css', 'neconyan-calico.css')).toContain('color: var(--sb-settings-tab-ink, var(--neco-ink)) !important');
        for (const id of runtimeIds.filter(id => id !== 'windows-98')) {
            expect(readSource('public', 'css', 'shell-styles', `${id}.css`)).not.toContain('--sb-settings-tab-ink:');
        }
    });

    test('every provider Connect action uses the shared accent-aware primary button', () => {
        for (const id of ['api_button', 'api_button_novel', 'api_button_textgenerationwebui', 'api_button_openai']) {
            const tag = indexHtml.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))?.[0];
            expect(tag).toMatch(/class="[^"]*\bmenu_button_primary\b/);
        }
        const core = readSource('public', 'css', 'neconyan.css');
        expect(core).not.toMatch(/\.neconyan-connect-actions\s*>\s*\.api_button[^{}]*\{[^}]*background:/);
    });

    test('tour accent actions use the primary-button contract in every shell style', () => {
        const tours = readSource('public', 'scripts', 'neconyan-tool-tour.js');
        expect(tours).toContain('\'menu_button menu_button_primary neconyan-tool-tour-next\', t`Show me around`');
        expect(tours).toContain('\'menu_button menu_button_primary neconyan-tool-tour-next\', t`Next`');
        const loreTours = readSource('public', 'scripts', 'neconyan-lorebook-tour.js');
        expect(loreTours).toContain('\'menu_button menu_button_primary neconyan-lorebook-tour-next\', t`Show me around`');
        expect(loreTours).toContain('\'menu_button menu_button_primary neconyan-lorebook-tour-next\', t`Next`');
        for (const id of runtimeIds.filter(id => id !== 'kittyless')) {
            const source = readSource('public', 'css', 'shell-styles', `${id}.css`);
            expect(source).toContain('.menu_button_primary, .popup-button-ok');
        }
    });

    test('Windows Aero never adds a shadow or glow to text', () => {
        const source = stripCssBlockComments(readSource('public', 'css', 'shell-styles', 'windows-aero.css'));
        const shadows = [...source.matchAll(/text-shadow:\s*([^;]+);/g)].map(match => match[1]);
        expect(shadows).toHaveLength(4);
        expect(shadows.every(shadow => shadow === 'none')).toBe(true);
        expect(source).not.toContain('--aero-glow');
    });

    test('Slate Flat fills hovered composer action buttons on phones, not just their label', () => {
        const mobileShell = readSource('public', 'css', 'neconyan-mobile-shell.css');
        expect(mobileShell).toContain('body.neconyan #send_form :is(#gg-action-button-container button, .stih--buttons button,');
        const slate = stripCssBlockComments(readSource('public', 'css', 'shell-styles', 'slate-flat.css'));
        const rule = slate.match(/:root\[data-sb-theme='slate-flat'\] body\.neconyan:not\(\.sbterm\) #send_form :is\(#gg-action-button-container, \.stih--buttons\) \.menu_button:not\(\.disabled\):not\(\[disabled\]\):hover \{([^}]*)\}/);
        expect(rule).not.toBeNull();
        expect(rule[1]).toContain('background: var(--neco-ginger);');
        expect(rule[1]).toContain('color: var(--neco-on-accent);');
    });

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
        const protectedDecorations = ['.neconyan-whiskers', '.neconyan-cat-panel::before'];
        test(`${id} only styles its own shell and layers over Calico`, () => {
            const source = readSource('public', 'css', 'shell-styles', `${id}.css`);
            const stripped = stripCssBlockComments(source);

            const prefix = `:root[data-sb-theme='${id}']`;
            const selectors = collectSelectors(source);
            expect(selectors.length).toBeGreaterThan(10);
            const unscoped = selectors.flatMap(splitSelectorList).filter(part => !part.startsWith(prefix));
            expect(unscoped).toEqual([]);

            // The palette, fonts and message tints stay, and every style leaves the cat
            // decorations alone. Hiding them belongs to css/neconyan-kittyless.css.
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

            // Only the three reviewed desktop library backings may use !important.
            expect(auditImportantDeclarations(source, id)).toEqual([]);
            expect(auditMotionDeclarations(stripped, id)).toEqual([]);
            expect(stripped).not.toMatch(/(^|[^:])\/\//m);

            for (const [, asset] of stripped.matchAll(/url\('\.\.\/\.\.\/([^'?]+)(?:\?[^']*)?'\)/g)) {
                expect(existsSync(path.join(repoRoot, 'public', asset))).toBe(true);
            }
        });
    }

    test('the Starlight Conservatory night sky stays lazy and unmounts with its style', () => {
        expect(tabsSource).toContain('import(\'./neconyan-starlight-conservatory.js\')');
        expect(tabsSource).toMatch(/function syncStarlightConservatoryStage\(themeId\) \{/);
        expect(tabsSource).toMatch(/if \(themeId !== 'starlight-conservatory'\) \{\s*starlightConservatoryModule\?\.unmountStarlightConservatory\(\);/);
        expect(tabsSource).toMatch(/if \(!module \|\| nnState\.theme !== 'starlight-conservatory'\) return;/);
        // The canvas stage is a dynamic import, never a blocking startup script.
        expect(indexHtml).not.toContain('neconyan-starlight-conservatory.js');

        const source = readSource('public', 'css', 'shell-styles', 'starlight-conservatory.css');
        expect(source).toContain('#sb-starlight-conservatory-sky {');
        expect(source).toContain('#sb-starlight-conservatory-overlay {');
        expect(source).toContain('#sb-starlight-conservatory-trail {');
        expect(source).toContain('display: contents;');
    });

    test('the Sunken Reef ocean stage stays lazy and unmounts with its style', () => {
        expect(tabsSource).toContain('import(\'./neconyan-sunken-reef.js\')');
        expect(tabsSource).toMatch(/function syncSunkenReefStage\(themeId\) \{/);
        expect(tabsSource).toMatch(/if \(themeId !== 'sunken-reef'\) \{\s*sunkenReefModule\?\.unmountSunkenReef\(\);/);
        expect(tabsSource).toMatch(/if \(!module \|\| nnState\.theme !== 'sunken-reef'\) return;/);
        expect(indexHtml).not.toContain('neconyan-sunken-reef.js');

        const source = readSource('public', 'css', 'shell-styles', 'sunken-reef.css');
        expect(source).toContain('#sb-sunken-reef-backdrop {');
        expect(source).toContain('#sb-sunken-reef-creatures {');
        expect(source).toContain('#sb-sunken-reef-wake {');
        expect(source).toContain('display: contents;');
        // Creatures sit above the reef backdrop (-1) but below #sheld (30), so chat text
        // stays readable. The pointer wake keeps its own layer above the interface.
        expect(source).toMatch(/#sb-sunken-reef-creatures \{\s*z-index: 0;/);
        expect(source).toMatch(/#sb-sunken-reef-wake \{\s*z-index: calc\(var\(--sb-z-critical, 10000\) - 1\);/);
        const reefScript = readSource('public', 'scripts', 'neconyan-sunken-reef.js');
        expect(reefScript).toContain('\'z-index:0\'');
        expect(reefScript).toContain('\'z-index:calc(var(--sb-z-critical, 10000) - 1)\'');
    });

    test('the backing exception rejects additional or widened important declarations', () => {
        const id = 'windows-aero';
        const selector = `:root[data-sb-theme='${id}'] body.neconyan:not(.sbterm) #right-nav-panel.openDrawer:is([data-menu-type='characters'], [data-menu-type='world-info'])`;
        const declaration = 'background: linear-gradient(var(--neco-rail), var(--neco-rail)), var(--neco-surface) !important;';
        const rule = `${selector} { ${declaration} }`;
        const valid = `@media (min-width: 769px) { ${rule} }`;
        expect(auditImportantDeclarations(valid, id)).toEqual([]);
        expect(auditImportantDeclarations(valid.replace('!important', '! IMPORTANT'), id)).toEqual([]);
        for (const invalid of [
            `${valid} ${selector} { color: red !important; }`,
            rule,
            valid.replace(':is([data-menu-type=\'characters\'], [data-menu-type=\'world-info\'])', ''),
            valid.replace('background:', 'color:'),
            valid.replace('var(--neco-surface)', 'transparent'),
            valid.replace('not(.sbterm) #right-nav-panel', 'not(.sbterm)#right-nav-panel'),
            valid.replace(':root[data-sb-theme=', ':root [data-sb-theme='),
            valid.replace('var(--neco-rail)', 'var (--neco-rail)'),
            valid.replace('769px', '769 px'),
            `@media (min-width: 769px) { ${rule} ${rule} }`,
            '',
            `@supports (display: grid) { ${valid} }`,
        ]) expect(auditImportantDeclarations(invalid, id)).not.toEqual([]);
        expect(auditImportantDeclarations(valid, 'windows-xp')).not.toEqual([]);
        expect(auditImportantDeclarations('/* !important */', 'windows-xp')).toEqual([]);
    });

    test('every style, Calico included, follows the chosen accent colour', () => {
        const signatureHues = { kittyless: '--kittyless-primary:', 'windows-aero': '--aero-hue:', 'windows-xp': '--xp-hue:', 'windows-98': '--w98-title:', 'cozy-warm': '--cozy-amber:', 'hypr-glow': '--hypr-b:', 'slate-flat': '--slate-cool:', 'clean-minimal': '--clean-line-strong:', 'starlight-conservatory': '--starlight-brass:', 'sunken-reef': '--reef-coral:' };
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
        // Calico Light keeps a light rail, so a picked accent is not lightened there.
        expect(calico).not.toMatch(/\[data-neconyan-calico-tone='light'\][^{]*#neconyan-workspace-rail[^{]*\{[^}]*--neco-(?:rail|ink|ginger):/);
        expect(calico).toMatch(/body\.neconyan ::selection \{[^}]*var\(--neco-ginger\)/);
    });

    test('every runtime style uses the second accent in its own decoration', () => {
        for (const id of runtimeIds) {
            expect(readSource('public', 'css', 'shell-styles', `${id}.css`)).toContain('var(--neco-accent-secondary)');
        }
    });
});

describe('Hide cats works with every shell style', () => {
    const catSheet = readSource('public', 'css', 'neconyan-kittyless.css');
    const stripped = stripCssBlockComments(catSheet);

    test('the cat removal sheet only applies while cats are hidden', () => {
        const selectors = collectSelectors(catSheet).flatMap(splitSelectorList);
        expect(selectors.length).toBeGreaterThan(10);
        expect(selectors.filter(part => !part.startsWith(':root[data-sb-kittyless=\'true\']'))).toEqual([]);
        expect(stripped).not.toMatch(/!important/);
        expect(stripped).not.toMatch(/\b(transition|animation)\s*:/);
        expect(stripped).not.toMatch(/(^|[^:])\/\//m);
        for (const [, asset] of stripped.matchAll(/url\('\.\.\/([^'?]+)(?:\?[^']*)?'\)/g)) {
            expect(existsSync(path.join(repoRoot, 'public', asset))).toBe(true);
        }
    });

    test('it hides the cats, and swaps only Calico\'s wallpaper for the railway', () => {
        for (const piece of ['.neconyan-whiskers', '.neconyan-home-cat', '.neconyan-message-sleeper', '.neconyan-startup-cat', '.neconyan-cat-panel, .neconyan-assistant-row', '#options::before']) {
            expect(stripped).toContain(piece);
        }
        const iconMap = readSource('public', 'css', 'neconyan-icons-map.css');
        expect(iconMap).toMatch(/:root\[data-sb-kittyless='true'\][\s\S]*?--neco-svg-cat:\s*url\('[^']*\/sprite\.svg\?v=[a-f0-9]+#cat-plain'\)/);
        expect(iconMap).toMatch(/:root\[data-sb-kittyless='true'\][\s\S]*?--neco-svg-paw:\s*url\('[^']*\/sprite\.svg\?v=[a-f0-9]+#paw-plain'\)/);
        expect(stripped).toContain(':root[data-sb-kittyless=\'true\']:is(:not([data-sb-theme]), [data-sb-theme=\'calico\'], [data-sb-theme=\'kittyless\']) body.neconyan::before');
        expect(stripped).toContain('shell-kittyless.webp');
        expect(readSource('public', 'css', 'shell-styles', 'kittyless.css')).not.toContain('shell-kittyless.webp');
    });

    test('the head script and the shell script load it for the Kittyless style or the switch', () => {
        const version = readShellScriptVersion();
        const headScript = readHeadScript();
        expect(headScript).toContain('if (shellStyle === \'kittyless\' || localStorage.getItem(\'sb-kittyless\') === \'true\')');
        expect(headScript).toContain(`'css/neconyan-kittyless.css?v=${version}'`);
        expect(headScript).toContain('document.documentElement.setAttribute(\'data-sb-kittyless\', \'true\')');

        expect(tabsSource).toContain('kittyless: \'sb-kittyless\',');
        expect(tabsSource).toContain('const NN_KITTYLESS_STYLESHEET_HREF = `css/neconyan-kittyless.css?v=${NN_SHELL_STYLE_STYLESHEET_VERSION}`;');
        expect(tabsSource).toMatch(/function setShellTheme\([\s\S]*?syncShellStyleStylesheet\(nextTheme\);\s*syncStarlightConservatoryStage\(nextTheme\);\s*syncSunkenReefStage\(nextTheme\);\s*syncKittylessStylesheet\(\);/);
        expect(tabsSource).toMatch(/function isKittylessActive\(\) \{\s*return nnState\.theme === 'kittyless' \|\| nnState\.kittyless;/);
        expect(tabsSource).toMatch(/function setKittylessEnabled\([\s\S]*?safeSetItem\(NN_STORAGE_KEYS\.kittyless/);
    });

    test('Shell Style has a Hide cats switch that the Kittyless style locks on', () => {
        expect(tabsSource).toContain('id: \'sb-kittyless-enabled-input\'');
        expect(tabsSource).toContain('label: \'Hide cats (Kittyless)\'');
        expect(tabsSource).toContain('The Kittyless style always hides the cats.');
        expect(stripped).toContain('.sb-kittyless-setting.is-disabled #sb-kittyless-enabled-input:checked');
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
        const running = 'img[src*=\'img/neconyan-pixel-cat-running.webp\'] { content: url(\'../../img/neconyan/win98/';
        const moving = 'img[src*=\'img/neconyan-pixel-cat.webp\'] { content: url(\'../../img/neconyan/win98/';
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
