import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

let getToolPage;
let getToolPageKey;
let getToolTourSteps;
let parseToolTourCopy;

beforeAll(async () => {
    await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
        t: (strings, ...values) => Array.isArray(strings) && !strings.raw
            ? strings[0]
            : strings.reduce((joined, part, index) => joined + part + (index < values.length ? values[index] : ''), ''),
    }));
    await jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({ accountStorage: { getItem: jest.fn(), setItem: jest.fn() } }));
    await jest.unstable_mockModule('../public/scripts/neconyan-assistant-art.js', () => ({ getAssistantIconSrc: name => `${name}.png` }));
    ({ getToolPage, getToolPageKey, getToolTourSteps, parseToolTourCopy } = await import('../public/scripts/neconyan-tool-tour.js'));
});

describe('full-page tools', () => {
    test('Pawthfinder has a page led by Taro', () => {
        const page = getToolPage('pathfinder');
        expect(page.key).toBe('pathfinder');
        expect(page.assistant).toBe('taro');
        expect(page.name).toBe('Pawthfinder');
        expect(getToolPageKey('PATHFINDER')).toBe('pathfinder');
        expect(getToolPage('not-a-page')).toBeNull();
    });

    test('the Pawthfinder tour walks the page in order and skips hidden pipeline settings', () => {
        const all = getToolTourSteps('pathfinder', { isShown: () => true }).map(step => step.id);
        expect(all[0]).toBe('welcome');
        expect(all.at(-1)).toBe('done');
        expect(all).toEqual(expect.arrayContaining(['status', 'switch', 'lorebooks', 'mode', 'pipeline', 'summaries', 'tools', 'diagnostics']));
        const withoutPipeline = getToolTourSteps('pathfinder', { isShown: () => false }).map(step => step.id);
        expect(withoutPipeline).not.toContain('pipeline');
        expect(withoutPipeline).toContain('mode');
    });

    test('an empty lorebook library changes the lorebook step', () => {
        const [lorebooks] = getToolTourSteps('pathfinder', { isShown: () => true, empty: true }).filter(step => step.id === 'lorebooks');
        expect(lorebooks.body).toContain('You have no lorebooks yet');
    });

    test('tour copy keeps paragraphs and bold runs', () => {
        expect(parseToolTourCopy('One **two**.\nThree')).toEqual([
            [{ text: 'One ', bold: false }, { text: 'two', bold: true }, { text: '.', bold: false }],
            [{ text: 'Three', bold: false }],
        ]);
    });
});

describe('Pawthfinder opens as a page instead of a popup', () => {
    const shell = read('../public/scripts/neconyan-tabs.js');
    const agents = read('../public/scripts/extensions/in-chat-agents/index.js');

    test('the shell exposes openIncludedTool and lights the matching rail item', () => {
        expect(shell).toContain('openIncludedTool: openNeconyanIncludedToolPage');
        expect(shell).toMatch(/NECONYAN_TOOL_PAGE_ROUTES = Object\.freeze\(\{\s*pathfinder: 'pathfinder'/);
        expect(shell).toContain('\'included-tool\': getIncludedToolRailRoute()');
    });

    test('the page sheet loads with the Included tool tab', () => {
        expect(shell).toMatch(/'right:included-tool': \[\s*\{ href: 'css\/neconyan-tool-pages\.css\?v=[^']+', id: 'deferred-tool-pages-css' \},\s*\]/);
        expect(shell).toContain('import(\'./neconyan-tool-tour.js\')');
    });

    test('every Pawthfinder entry point routes through the shell page', () => {
        const editor = agents.slice(agents.indexOf('async function openPathfinderEditor'));
        expect(editor.indexOf('NeconyanShell?.openIncludedTool?.(\'pathfinder\')')).toBeGreaterThan(-1);
        expect(editor.indexOf('NeconyanShell?.openIncludedTool?.(\'pathfinder\')')).toBeLessThan(editor.indexOf('new Popup('));
    });

    test('the tour card is never treated as a click-away target', () => {
        expect(read('../public/script.js')).toContain('\'#neconyan-tool-tour\'');
    });

    test('the page stylesheet uses tokens, guards motion and hides the generic blurb on phones', () => {
        const cssUrl = new URL('../public/css/neconyan-tool-pages.css', import.meta.url);
        expect(existsSync(cssUrl)).toBe(true);
        const css = readFileSync(cssUrl, 'utf8');
        expect(css).toContain('@media (prefers-reduced-motion: reduce)');
        expect(css).toContain('[data-tool-page=\'pathfinder\'] .pf--settings');
        expect(css).toContain('#user-settings-block.openDrawer[data-tool-page]:not([data-tool-page=\'\']) .sb-shell-header .sb-shell-description');
        expect(css).not.toMatch(/!important/);
    });
});

describe('Quick Image Gen opens as a page led by Nori', () => {
    const shell = read('../public/scripts/neconyan-tabs.js');
    const rail = read('../public/scripts/welcome-screen.js');
    const css = read('../public/css/neconyan-tool-pages.css');

    test('Nori leads a tour that opens each settings section before showing it', () => {
        const page = getToolPage('quick-image-gen');
        expect(page.assistant).toBe('nori');
        expect(page.name).toBe('Quick Image Gen');
        const steps = getToolTourSteps('quick-image-gen', { isShown: () => true });
        expect(steps.map(step => step.id)).toEqual(expect.arrayContaining(['actions', 'status', 'prompt', 'source', 'more', 'provider', 'automation', 'done']));
        expect(steps.find(step => step.id === 'provider').open).toEqual(expect.arrayContaining(['#qig-setup-toggle', '#qig-section-provider-toggle']));
    });

    test('the rail item and the included tools list both open the page', () => {
        expect(shell).toContain('{ id: \'quick-image-gen\', label: \'Quick Image Gen\', icon: \'fa-image\', actions: [\'settings\'] }');
        expect(shell).toMatch(/NECONYAN_TOOL_PAGE_ROUTES = Object\.freeze\(\{[^}]*'quick-image-gen': 'quick-image-gen'/);
        expect(rail).toContain('shell?.openIncludedTool?.(\'quick-image-gen\')');
    });

    test('the page drops the duplicate drawer title and uses Neconyan colours', () => {
        expect(css).toContain('[data-tool-page=\'quick-image-gen\'] #qig-settings > .inline-drawer > .inline-drawer-header');
        expect(css).toContain('--qig-accent: var(--neco-ginger);');
    });
});
