import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

function readProjectFile(relativePath) {
    return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function findUnbalancedCalcExpressions(source) {
    const unbalanced = [];
    const regex = /calc\(/g;
    let match;
    while ((match = regex.exec(source)) !== null) {
        let depth = 0;
        let idx = match.index + 4;
        let closed = false;
        let quote = '';
        let inExpr = 0;
        while (idx < source.length) {
            const ch = source[idx];
            if (ch === '\n' || ch === '\r') break;
            if (ch === '$' && source[idx + 1] === '{') {
                inExpr += 1;
                idx += 2;
                continue;
            }
            if (inExpr > 0) {
                if (ch === '{') inExpr += 1;
                else if (ch === '}') inExpr -= 1;
                idx += 1;
                continue;
            }
            if (!quote && (ch === '`' || ch === '\'' || ch === '"')) {
                break;
            }
            if (ch === '(') {
                depth += 1;
            } else if (ch === ')') {
                depth -= 1;
                if (depth === 0) {
                    closed = true;
                    break;
                }
            }
            idx += 1;
        }
        if (!closed) {
            const line = source.slice(0, match.index).split('\n').length;
            const snippet = source.slice(match.index, Math.min(source.length, match.index + 80));
            unbalanced.push({ line, snippet });
        }
    }
    return unbalanced;
}

describe('Neconyan Slash Commands UI contracts', () => {
    const indexHtml = readProjectFile('public/index.html');
    const swJs = readProjectFile('public/sw.js');
    const tabsJs = readProjectFile('public/scripts/neconyan-tabs.js');
    const mewmoryUiJs = readProjectFile('public/scripts/mewmory/ui.js');
    const themeCss = readProjectFile('public/css/neconyan-theme.css');
    const slashCss = readProjectFile('public/css/neconyan-slash-commands.css');
    const kittylessCss = readProjectFile('public/css/neconyan-kittyless.css');
    const compactCss = readProjectFile('public/css/neconyan-compact-mode.css');
    const win98Css = readProjectFile('public/css/shell-styles/windows-98.css');
    const winXpCss = readProjectFile('public/css/shell-styles/windows-xp.css');
    const autoCompleteJs = readProjectFile('public/scripts/autocomplete/AutoComplete.js');
    const slashCommandJs = readProjectFile('public/scripts/slash-commands/SlashCommand.js');
    const browserJs = readProjectFile('public/scripts/slash-commands/SlashCommandBrowser.js');
    const scriptJs = readProjectFile('public/script.js');
    const enLocale = JSON.parse(readProjectFile('public/locales/neconyan/en.json'));

    test('loads neconyan-slash-commands.css deferred and aligns every cache version', () => {
        const versionMatch = swJs.match(/NN_SW_CACHE_VERSION\s*=\s*'neconyan-cache-v([^']+)'/);
        expect(versionMatch).not.toBeNull();
        const cacheVersion = versionMatch[1];

        expect(indexHtml).toContain(
            `<link href="css/neconyan-slash-commands.css?v=${cacheVersion}" rel="preload" as="style" data-sb-deferred-style data-sb-media="all">`,
        );
        expect(tabsJs).toContain(`NN_SHELL_STYLE_STYLESHEET_VERSION = '${cacheVersion}'`);
        expect(tabsJs).toContain(`css/world-info.css?v=${cacheVersion}`);
        expect(mewmoryUiJs).toContain(`css/mewmory.css?v=${cacheVersion}`);
        expect(indexHtml).toContain(`css/shell-styles/' + shellStyle + '.css?v=${cacheVersion}`);
        expect(indexHtml).toContain(`css/neconyan-kittyless.css?v=${cacheVersion}`);
        expect(indexHtml).not.toContain('20261126-ai-folder-sort');
    });

    test('scopes Neconyan slash command styling away from Termeownal and strips Calico paws in Kittyless', () => {
        const slashCssNoComments = slashCss.replace(/\/\*[\s\S]*?\*\//g, '');
        expect(slashCssNoComments).toContain('body.neconyan:not(.sbterm)');
        expect(slashCssNoComments).toContain('body.neconyan.reduced-motion:not(.sbterm)');
        expect(slashCssNoComments).toContain('@media (prefers-reduced-motion: reduce)');
        expect(slashCss).not.toMatch(/^\s*\/\//m);
        expect(slashCssNoComments).not.toContain('/favicon.ico');
        expect(slashCssNoComments).not.toContain('#F89406');
        expect(slashCssNoComments).not.toContain('#51A351');

        expect(slashCss).toContain('body.neconyan:not(.sbterm)[data-stscript-style=\'dark\']');
        expect(slashCss).toContain('body.neconyan:not(.sbterm)[data-stscript-style=\'light\']');

        expect(kittylessCss).toContain('.autoComplete-wrap');
        expect(kittylessCss).toContain('.autoComplete-detailsWrap');
        expect(kittylessCss).toContain('.slashCommandBrowser');

        expect(win98Css).toContain('.autoComplete-wrap');
        expect(win98Css).toContain('.slashCommandBrowser');
        expect(winXpCss).toContain('.autoComplete-wrap');
        expect(winXpCss).toContain('.slashCommandBrowser');

        expect(compactCss).toContain('.autoComplete-wrap');
        expect(compactCss).toContain('.slashCommandBrowser');
    });

    test('fixes every calc() expression in AutoComplete.js and wires header & non-blurring details controls', () => {
        expect(findUnbalancedCalcExpressions(autoCompleteJs)).toEqual([]);

        expect(autoCompleteJs).toContain('this.headerDom.classList.add(\'nn-ac-header\')');
        expect(autoCompleteJs).toContain('this.domWrap.append(this.headerDom);');
        expect(autoCompleteJs).toContain('this.domWrap.append(this.dom);');
        expect(autoCompleteJs.indexOf('this.domWrap.append(this.headerDom);')).toBeLessThan(
            autoCompleteJs.indexOf('this.domWrap.append(this.dom);'),
        );

        expect(autoCompleteJs).toContain('nn-ac-details-toggle');
        expect(autoCompleteJs).toContain('\'aria-label\', \'Toggle command details\'');
        expect(autoCompleteJs).toContain('\'aria-pressed\'');
        expect(autoCompleteJs).toContain('nn-ac-details-close');
        expect(autoCompleteJs).toContain('\'aria-label\', \'Close details\'');
        expect(autoCompleteJs).toContain('bindNonBlurringAction');
        expect(autoCompleteJs).toContain('evt.preventDefault()');
        expect(autoCompleteJs).toContain('window.visualViewport');
        expect(autoCompleteJs).toContain('getItemRect(item)');
        expect(autoCompleteJs).toContain('switchToDetails');

        expect(scriptJs).toContain('\'.autoComplete-wrap\'');
        expect(scriptJs).toContain('\'.autoComplete-detailsWrap\'');
    });

    test('renders Catline source badges without raw favicon hacks in SlashCommand.js', () => {
        expect(slashCommandJs).toContain('fa-star-of-life');
        expect(slashCommandJs).toContain('fa-cubes');
        expect(slashCommandJs).toContain('fa-puzzle-piece');
        expect(slashCommandJs).toContain('nn-source-label');
    });

    test('wires filter pills, live match count, narrow back/close control, and 120ms debounce in SlashCommandBrowser.js', () => {
        expect(browserJs).toContain('nn-scb-header');
        expect(browserJs).toContain('nn-scb-count');
        expect(browserJs).toContain('nn-scb-filter-btn');
        expect(browserJs).toContain('aria-pressed');
        expect(browserJs).toContain('id: \'all\', label: t`All`');
        expect(browserJs).toContain('id: \'core\', label: t`Core`');
        expect(browserJs).toContain('id: \'extensions\', label: t`Extensions`');
        expect(browserJs).toContain('nn-scb-details-back');
        expect(browserJs).toContain('nn-scb-details-close');
        expect(browserJs).toContain('Back to commands');
        expect(browserJs).toContain('lbl.classList.add(\'searchLabel\')');
        expect(browserJs).toContain('inp.classList.add(\'searchInput\')');
        expect(browserJs).toContain('filterTimer = setTimeout(filterCommands, 120)');
    });

    test('uses an accent-aware composer progress tint instead of hardcoded blue', () => {
        expect(themeCss).not.toContain('rgb(146, 190, 252)');
        expect(themeCss).toMatch(
            /#form_sheld\.isExecutingCommandsFromChatInput\s+#send_textarea\s*\{\s*--progColor:\s*color-mix\(in srgb,\s*var\(--neco-ginger\)\s*28%,\s*transparent\);/s,
        );
    });

    test('includes the new Slash Commands UI captions in public/locales/neconyan/en.json', () => {
        for (const key of [
            'Autocomplete controls',
            'Toggle command details',
            'Command details',
            'Close details',
            'Back to commands',
            '1 match',
            '${0} matches',
            '1 command',
            '${0} commands',
            'Filter commands by source',
            'No commands match this filter.',
            'Select a command',
        ]) {
            expect(enLocale[key]).toBe(key);
        }
    });
});
