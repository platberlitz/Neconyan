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

    test('the page stylesheet uses tokens and guards motion', () => {
        const cssUrl = new URL('../public/css/neconyan-tool-pages.css', import.meta.url);
        expect(existsSync(cssUrl)).toBe(true);
        const css = readFileSync(cssUrl, 'utf8');
        expect(css).toContain('@media (prefers-reduced-motion: reduce)');
        expect(css).toContain('[data-tool-page=\'pathfinder\'] .pf--settings');
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

describe('Character Expressions opens as a page led by Miso', () => {
    const shell = read('../public/scripts/neconyan-tabs.js');
    const rail = read('../public/scripts/welcome-screen.js');
    const css = read('../public/css/neconyan-tool-pages.css');
    const settings = read('../public/scripts/extensions/expressions/settings.html');

    test('Miso leads a tour that skips steps for hidden classifier options', () => {
        const page = getToolPage('expressions');
        expect(page.assistant).toBe('miso');
        expect(page.name).toBe('Character Expressions');
        expect(page.emptyWhen).toContain('#open_chat_expressions');
        const all = getToolTourSteps('expressions', { isShown: () => true }).map(step => step.id);
        expect(all).toEqual(['welcome', 'classifier', 'agent', 'prompt', 'translate', 'choices', 'sprites', 'done']);
        const visible = getToolTourSteps('expressions', { isShown: () => false }).map(step => step.id);
        expect(visible).not.toContain('agent');
        expect(visible).not.toContain('prompt');
    });

    test('the rail item and the included tools list both open the page', () => {
        expect(shell).toContain('{ id: \'expressions\', label: \'Character Expressions\', icon: \'fa-masks-theater\', actions: [\'settings\'] }');
        expect(shell).toMatch(/NECONYAN_TOOL_PAGE_ROUTES = Object\.freeze\(\{[^}]*expressions: 'expressions'/);
        expect(rail).toMatch(/case 'expressions':\s*case 'regex':\s*if \(shell\?\.openIncludedTool\?\.\(route\)\) break;/);
    });

    test('settings are grouped into three titled sections and the page hides the drawer title', () => {
        for (const section of ['classifier', 'behaviour', 'sprites']) {
            expect(settings).toContain(`expression_section expression_section_${section}`);
        }
        expect(css).toContain('[data-tool-page=\'expressions\'] .expression_settings > .inline-drawer > .inline-drawer-header');
        expect(css).toContain('[data-tool-page=\'expressions\'] #image_list');
    });
});

describe('Regexes opens as a page led by Taro', () => {
    const shell = read('../public/scripts/neconyan-tabs.js');
    const css = read('../public/css/neconyan-tool-pages.css');
    const dropdown = read('../public/scripts/extensions/regex/dropdown.html');
    const manifest = JSON.parse(read('../public/scripts/extensions/regex/manifest.json'));

    test('Taro walks the toolbar, the editor helpers and every script list', () => {
        const page = getToolPage('regex');
        expect(page.assistant).toBe('taro');
        expect(page.name).toBe('Regexes');
        const steps = getToolTourSteps('regex', { isShown: () => true });
        expect(steps.map(step => step.id)).toEqual(['welcome', 'new', 'editor', 'filter', 'bulk', 'presets', 'global', 'preset', 'scoped', 'done']);
        expect(steps.find(step => step.id === 'editor').body).toContain('Start from a recipe');
    });

    test('the rail item and the included tools list both open the page under one name', () => {
        expect(shell).toContain('{ id: \'regex\', label: \'Regexes\', icon: \'fa-code\', actions: [\'settings\'] }');
        expect(shell).toMatch(/NECONYAN_TOOL_PAGE_ROUTES = Object\.freeze\(\{[^}]*regex: 'regex'/);
        expect(manifest.display_name).toBe('Regexes');
    });

    test('the page has a script search box and shows each list as a card', () => {
        expect(dropdown).toContain('id="regex_script_filter"');
        expect(dropdown).toContain('regex_toolbar');
        expect(css).toContain('[data-tool-page=\'regex\'] .regex_settings > .inline-drawer > .inline-drawer-header');
        expect(css).toContain('#global_scripts_block');
    });
});

describe('settings pages open as Neconyan pages with an assistant tour', () => {
    const shell = read('../public/scripts/neconyan-tabs.js');
    const rail = read('../public/scripts/welcome-screen.js');
    const css = read('../public/css/neconyan-tool-pages.css');
    const pages = {
        connections: 'nori',
        presets: 'nori',
        sampling: 'nori',
        formatting: 'taro',
        mewmory: 'taro',
        persona: 'miso',
        'dialogue-colors': 'miso',
        background: 'miso',
        server: 'taro',
        'console-logs': 'taro',
    };

    test('every page has an intro, an invite and a tour that starts and ends on the page chrome', () => {
        for (const [key, assistant] of Object.entries(pages)) {
            const page = getToolPage(key);
            expect(page.assistant).toBe(assistant);
            expect(page.kicker).toBeTruthy();
            expect(page.description).toBeTruthy();
            expect(page.invite).toBeTruthy();
            const steps = getToolTourSteps(key, { isShown: () => true });
            expect(steps[0].targets).toContain('.neconyan-tool-page-intro');
            expect(steps.at(-1).targets).toContain('.neconyan-tool-tour-button');
            expect(steps.length).toBeGreaterThan(3);
        }
    });

    test('the shell maps each settings tab to its page and mounts it whenever a tab opens', () => {
        for (const [tab, key] of [['left:api', 'connections'], ['left:presets', 'presets'], ['left:sampling', 'sampling'], ['left:advanced-formatting', 'formatting'], ['left:mewmory', 'mewmory'], ['right:background', 'background'], ['right:server', 'server'], ['right:console-logs', 'console-logs']]) {
            expect(shell).toContain(`'${tab}': '${key}'`);
        }
        expect(shell).toMatch(/activeTab\.onActivate\?\.\(\);\s*syncNeconyanNativeShellPage\(shellKey, tabId\);/);
        expect(shell).toContain('mountNeconyanNativePage(\'persona\', document.getElementById(\'sb_character_persona_panel\'))');
        for (const tab of ['left:api', 'left:presets', 'left:sampling', 'left:mewmory', 'right:background', 'right:server', 'right:console-logs']) {
            expect(shell).toMatch(new RegExp(`'${tab}': \\[\\s*\\{ href: 'css/neconyan-tool-pages\\.css`));
        }
    });

    test('the Dialogue Colors extension id resolves to its page and the rail item lights up', () => {
        expect(getToolPageKey('third-party/sillytavern-character-colors')).toBe('dialogue-colors');
        expect(shell).toMatch(/NECONYAN_TOOL_PAGE_ROUTES = Object\.freeze\(\{[^}]*'sillytavern-character-colors': 'dialogue-colors'/);
        expect(rail).toContain('shell?.openIncludedTool?.(\'sillytavern-character-colors\')');
        expect(css).toContain('[data-tool-page=\'dialogue-colors\'] #dc-panel-toggle');
    });

    test('the persona tour switches the phone Browse and Edit tabs instead of skipping steps', () => {
        const steps = getToolTourSteps('persona', { isShown: () => true });
        expect(steps.find(step => step.id === 'list').tab).toBe('#persona_workspace_tab_browse');
        expect(steps.find(step => step.id === 'description').tab).toBe('#persona_workspace_tab_edit');
    });

    test('Mewmory changes its first step when no Roleplay chat is open', () => {
        expect(getToolPage('mewmory').emptyWhen).toContain('data-mewmory-no-chat');
        expect(read('../public/scripts/mewmory/ui.js')).toContain('dataset.mewmoryNoChat');
        const [scope] = getToolTourSteps('mewmory', { isShown: () => true, empty: true }).filter(step => step.id === 'scope');
        const { emptyBody } = getToolPage('mewmory').steps.find(step => step.id === 'scope');
        expect(emptyBody).toBeTruthy();
        expect(scope.body).toBe(emptyBody);
    });

    test('Mewmory walks through Settings even without a saved chat or visible settings pane', () => {
        const steps = getToolTourSteps('mewmory', { isShown: () => false, empty: true });
        for (const id of ['settings', 'roles', 'connection', 'privacy', 'limits', 'embeddings', 'updates', 'budgets', 'save']) {
            const step = steps.find(item => item.id === id);
            expect(step?.tab).toBe('#mewmory-tab-settings');
            expect(step.body.length).toBeGreaterThan(150);
        }
        expect(steps.find(step => step.id === 'connection').open).toBe('#mewmory-role-extractor');
        expect(steps.find(step => step.id === 'embeddings').open).toBe('#mewmory-role-embedding');
        expect(steps.find(step => step.id === 'save').body).toContain('does not press Save');
        const source = read('../public/scripts/neconyan-tool-tour.js');
        expect(source).toContain('new MutationObserver(refreshTourTarget)');
        expect(source).toContain('\'mewmory-tab-settings\': \'settings\'');
        expect(source).toContain('!event.isTrusted');
    });

    test('native and included tools mount the blurb below the title and keep invitations in the page', () => {
        expect(shell).toContain('header.append(closeButton, eyebrow, title, headerIntro, subtitle, shellDescription)');
        expect(shell).toContain('mountToolPage(key, heading, host, headerHeading)');
        expect(shell).toContain('mountToolPage(mounted ? tool.id : \'\', heading, host, shell?.headerIntro)');
        expect(shell).toContain('if (headerHeading && headerHeading.dataset.toolPage !== key) return');
        expect(read('../public/css/neconyan.css')).toContain('.sb-shell-header:has(.neconyan-page-intro-header) > :is(.sb-shell-subtitle, .sb-shell-description) { display: none; }');
        expect(css).toContain('#left-nav-panel[data-neconyan-native-page=\'connections\'] .neconyan-model-provider-stack');
    });

    test('Nori explains presets without pressing save, import or delete and skips unavailable controls', () => {
        const steps = getToolTourSteps('presets');
        expect(steps.map(step => step.id)).toEqual(['welcome', 'choose', 'save', 'copy', 'files', 'linking', 'parameters', 'prompts', 'done']);
        expect(getToolTourSteps('presets', { isShown: () => false }).map(step => step.id)).toEqual(['welcome', 'choose', 'done']);
        expect(steps.find(step => step.id === 'choose').targets).toEqual(expect.arrayContaining(['#settings_preset_openai', '#settings_preset_textgenerationwebui', '#settings_preset_novel', '#settings_preset']));
        expect(steps.find(step => step.id === 'prompts').tab).toBe('#openai-tab-btn-prompts');
        expect(steps.find(step => step.id === 'parameters').tab).toBe('#openai-tab-btn-parameters');
        expect(steps.every(step => !step.open)).toBe(true);
        expect(steps[0].body).toContain('won\'t change, save or delete');
        expect(steps.find(step => step.id === 'copy').body).toContain('keep the original preset unchanged');
        expect(steps.find(step => step.id === 'linking').body).toContain('Leave it off');
    });
});
