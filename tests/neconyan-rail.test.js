import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');
const welcomeSource = readSource('public', 'scripts', 'welcome-screen.js');
const tabsSource = readSource('public', 'scripts', 'neconyan-tabs.js');
const neconyanCss = readSource('public', 'css', 'neconyan.css');
const neconyanCalicoCss = readSource('public', 'css', 'neconyan-calico.css');
const backgroundsCss = readSource('public', 'css', 'backgrounds.css');

function getWelcomeFunctionSource(name) {
    return welcomeSource.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0] ?? '';
}

function createWelcomeRuntime(overrides = {}) {
    const actions = [];
    const Textarea = class HTMLTextAreaElement {
        focus() { }
    };
    const textarea = new Textarea();
    textarea.focus = () => actions.push(['focus', textarea]);
    const context = vm.createContext({
        document: {
            getElementById: () => textarea,
        },
        HTMLTextAreaElement: Textarea,
        is_send_press: false,
        is_group_generating: false,
        t: strings => strings[0],
        toastr: { info: text => actions.push(['notice', text]) },
        isIOSWebKitPlatform: () => false,
        focusSendTextarea: (element) => actions.push(['focus', element]),
        newAssistantChat: async options => actions.push(['new-chat', options]),
        hideWelcomeHome: () => actions.push(['hide-home']),
        openWelcomeScreen: async options => actions.push(['open-home', options]),
        openRecentConversationChat: (...args) => { actions.push(['conversation', ...args]); return true; },
        openRecentGroupChat: (...args) => { actions.push(['group', ...args]); return true; },
        openRecentCharacterChat: (...args) => { actions.push(['character', ...args]); return true; },
        globalThis: {},
        ...overrides,
    });
    context.globalThis = context;
    vm.runInContext([
        getWelcomeFunctionSource('focusSendTextarea'),
        getWelcomeFunctionSource('openNeconyanTemporaryChat'),
        getWelcomeFunctionSource('openNeconyanRecentChat'),
        getWelcomeFunctionSource('activateNeconyanRailRoute'),
    ].join('\n'), context);
    return { context, actions, textarea };
}

describe('Neconyan workspace rail behavior', () => {
    test('Notebooks selection follows its open state, including beside-chat and direct opens', () => {
        const attributes = [new Map(), new Map(), new Map()];
        const buttons = ['notes', 'home', 'model'].map((route, index) => ({
            dataset: { neconyanRoute: route },
            setAttribute: (name, value) => attributes[index].set(name, value),
            removeAttribute: name => attributes[index].delete(name),
        }));
        let notesOpen = false;
        let modelOpen = false;
        const runtime = vm.createContext({
            document: { body: { classList: { contains: () => notesOpen } }, querySelectorAll: () => buttons },
            isCharacterPanelOpen: () => false,
            isShellOpen: side => side === 'left' && modelOpen,
            getShellState: () => ({ activeTabId: 'api' }),
            isLandingPageVisible: () => true,
            syncNeconyanModeControls() {},
        });
        vm.runInContext(tabsSource.match(/^function syncNeconyanRailSelection\([\s\S]*?^}/m)[0], runtime);
        const current = () => buttons.filter((_button, index) => attributes[index].has('aria-current')).map(button => button.dataset.neconyanRoute);
        runtime.syncNeconyanRailSelection();
        expect(current()).toEqual(['home']);
        notesOpen = true;
        runtime.syncNeconyanRailSelection();
        expect(current()).toEqual(['notes']);
        modelOpen = true;
        runtime.syncNeconyanRailSelection();
        expect(current()).toEqual(['notes']);
        notesOpen = false;
        runtime.syncNeconyanRailSelection();
        expect(current()).toEqual(['model']);
        // Notes visibility changes already run through the shared body observer.
        expect(tabsSource).toMatch(/observer\.observe\(document\.body, \{\s*attributes: true,\s*attributeFilter: \['class'\]/);
    });

    test('Scratchpad sits under Notebooks, opens from the rail and shows as selected while open', () => {
        expect(welcomeSource).toMatch(/\['notes', 'Notebooks', 'fa-note-sticky'\],\s*\['scratchpad', 'Scratchpad', 'fa-clipboard-list'\],/);
        expect(getWelcomeFunctionSource('activateNeconyanRailRoute'))
            .toMatch(/case 'scratchpad':[\s\S]*?import\('\.\/scratchpad\/index\.js'\)[\s\S]*?openScratchpad\(\)/);

        const attributes = [new Map(), new Map(), new Map()];
        const buttons = ['notes', 'scratchpad', 'home'].map((route, index) => ({
            dataset: { neconyanRoute: route },
            setAttribute: (name, value) => attributes[index].set(name, value),
            removeAttribute: name => attributes[index].delete(name),
        }));
        const open = new Set();
        const runtime = vm.createContext({
            document: { body: { classList: { contains: name => open.has(name) } }, querySelectorAll: () => buttons },
            isCharacterPanelOpen: () => false,
            isShellOpen: () => false,
            getShellState: () => ({}),
            isLandingPageVisible: () => true,
            syncNeconyanModeControls() {},
        });
        vm.runInContext(tabsSource.match(/^function syncNeconyanRailSelection\([\s\S]*?^}/m)[0], runtime);
        const current = () => buttons.filter((_button, index) => attributes[index].has('aria-current')).map(button => button.dataset.neconyanRoute);
        open.add('neconyan-scratchpad-open');
        runtime.syncNeconyanRailSelection();
        expect(current()).toEqual(['scratchpad']);
        open.delete('neconyan-scratchpad-open');
        runtime.syncNeconyanRailSelection();
        expect(current()).toEqual(['home']);
    });

    test('Fine-tuning waits for loaded controls and sends disabled tools to Manage extensions', async () => {
        class HTMLElement {}
        const element = new HTMLElement();
        const actions = [];
        let enabled = true;
        const runtime = vm.createContext({ HTMLElement, closeMobileNav: () => actions.push('close'),
            findExtension: () => ({ enabled }),
            waitForNeconyanNativeReady: async selector => { actions.push(selector); await Promise.resolve(); return element; },
            revealSearchMatch: (side, match) => actions.push([side, match.tabId, match.element]),
            openNeconyanNativeManage: () => actions.push('manage'),
        });
        vm.runInContext(tabsSource.match(/^async function openExtensionSettings\([\s\S]*?^}/m)[0], runtime);
        await runtime.openExtensionSettings('regex');
        await runtime.openExtensionSettings('expressions');
        expect(actions).toEqual(['close', '#open_regex_editor', ['right', 'extensions', element],
            'close', '#expression_api', ['right', 'extensions', element]]);
        actions.length = 0;
        enabled = false;
        await runtime.openExtensionSettings('expressions');
        expect(actions).toEqual(['close', 'manage']);
        expect(await runtime.openExtensionSettings('unknown')).toBe(false);
    });

    test('restores only known unique destinations and adds new ones between their neighbours or last', () => {
        const context = vm.createContext({});
        vm.runInContext(getWelcomeFunctionSource('normalizeNeconyanRailOrder'), context);
        const defaults = ['home', 'characters', 'model', 'agents'];
        expect(context.normalizeNeconyanRailOrder(['model', 'removed', 'model', 'home', 'story'], defaults))
            .toEqual(['model', 'home', 'characters', 'agents']);
        // An order saved before Scratchpad existed gains it just under Notes.
        const primary = ['home', 'characters', 'model', 'agents', 'mewmory', 'lorebooks', 'notes', 'scratchpad', 'extensions'];
        expect(context.normalizeNeconyanRailOrder(['notes', 'home', 'characters', 'model', 'agents', 'mewmory', 'lorebooks', 'extensions'], primary))
            .toEqual(['notes', 'scratchpad', 'home', 'characters', 'model', 'agents', 'mewmory', 'lorebooks', 'extensions']);
        for (const invalid of [null, undefined, 'model', {}, 123]) {
            expect(context.normalizeNeconyanRailOrder(invalid, defaults)).toEqual(defaults);
        }
    });

    test('turning reordering off preserves orders and reset preserves the enabled setting', () => {
        const state = { enabled: true, primary: ['model', 'home'], advanced: ['sampling', 'presets'], modes: ['story', 'roleplay'] };
        const saved = [];
        const context = vm.createContext({
            neconyanRailOrder: state,
            neconyanRailGroups: { primary: {}, advanced: {}, modes: {} },
            applyNeconyanRailOrder() {}, saveNeconyanRailOrder: () => saved.push(structuredClone(state)),
        });
        vm.runInContext([getWelcomeFunctionSource('setNeconyanRailReordering'), getWelcomeFunctionSource('resetNeconyanRailOrder')].join('\n'), context);
        context.setNeconyanRailReordering(false);
        expect(saved[0]).toEqual({ ...state, enabled: false });
        expect(state.primary).toEqual(['model', 'home']);
        context.resetNeconyanRailOrder();
        expect(state).toEqual({ enabled: false, primary: [], advanced: [], modes: [] });
        context.setNeconyanRailReordering(true);
        context.resetNeconyanRailOrder();
        expect(state.enabled).toBe(true);
    });

    test('closes the phone drawer after rail button taps even when the rail is built after the bindings', () => {
        const bindings = tabsSource.match(/^function ensureNeconyanRailDrawerBindings\(\) \{[\s\S]*?^}/m)?.[0] ?? '';
        expect(bindings).not.toContain('getElementById(\'neconyan-workspace-rail\')');
        const listeners = {};
        const closes = [];
        let drawerOpen = true;
        class Element {
            constructor(selectorMatches = [], buttonMatches = []) {
                this.selectorMatches = selectorMatches;
                this.buttonMatches = buttonMatches;
            }
            closest(selector) {
                return this.selectorMatches.includes(selector) ? this : null;
            }
            matches(selector) {
                return this.buttonMatches.some(match => selector.split(', ').includes(match));
            }
        }
        const context = vm.createContext({
            Element,
            HTMLElement: Element,
            document: { addEventListener: (type, listener) => { listeners[type] = listener; } },
            window: {
                setTimeout: callback => callback(),
                matchMedia: () => ({ addEventListener() {} }),
            },
            NN_MOBILE_MEDIA_QUERY: '(max-width: 768px)',
            neconyanRailDrawerBound: false,
            isNeconyanRailDrawerOpen: () => drawerOpen,
            setNeconyanRailDrawerOpen: open => closes.push(open),
        });
        vm.runInContext(`${bindings}; ensureNeconyanRailDrawerBindings();`, context);
        closes.length = 0;

        const railButton = new Element(['#neconyan-workspace-rail button']);
        listeners.click({ target: railButton });
        expect(closes).toEqual([false]);

        closes.length = 0;
        listeners.click({ target: new Element(['#neconyan-workspace-rail button'], ['#neconyan-sidebar-toggle']) });
        listeners.click({ target: new Element(['#neconyan-workspace-rail button'], ['[data-neconyan-refresh-recent]']) });
        listeners.click({ target: new Element(['#neconyan-workspace-rail button'], ['[data-neconyan-section-toggle]']) });
        listeners.click({ target: new Element() });
        drawerOpen = false;
        listeners.click({ target: railButton });
        expect(closes).toEqual([]);
    });

    test('places Modes below Fine-tuning and mounts order settings in both outlets', () => {
        const build = getWelcomeFunctionSource('ensureNeconyanRail');
        expect(build.indexOf('data-neconyan-primary-nav')).toBeLessThan(build.indexOf('data-neconyan-advanced-nav'));
        expect(build.indexOf('data-neconyan-advanced-nav')).toBeLessThan(build.indexOf('data-neconyan-finer-nav'));
        expect(build.indexOf('data-neconyan-finer-nav')).toBeLessThan(build.indexOf('data-neconyan-mode-nav'));
        expect(build).toContain('>Troubleshooting<');
        expect(build).not.toContain('Finer-tuning');
        expect(build).toContain('[\'server\', \'Server\', \'fa-server\']');
        expect(build).toContain('[\'console-logs\', \'Console Logs\', \'fa-terminal\']');
        expect(build.indexOf('\'console-logs\'')).toBeLessThan(build.indexOf('route: \'report-issue\''));
        expect(build).toContain('window.open(NECONYAN_ISSUES_URL, \'_blank\', \'noopener,noreferrer\')');
        expect(welcomeSource).toContain('const NECONYAN_ISSUES_URL = \'https://github.com/platberlitz/Neconyan/issues\';');
        expect(tabsSource).toContain('createRailOrderSettingsGroup(\'desktop\')');
        expect(tabsSource).toContain('createRailOrderSettingsGroup(\'mobile\')');
        expect(tabsSource).toContain('desktopBottomChatBarSettingsGroup,\n            desktopRailOrderSettingsGroup,');
        expect(tabsSource).toContain('mobileBottomChatBarSettingsGroup,\n            mobileRailOrderSettingsGroup,');
    });

    test('Quick Actions mounts below Fine-tuning and edits the current viewport shortcuts', () => {
        const build = getWelcomeFunctionSource('ensureNeconyanRail');
        expect(build.indexOf('data-neconyan-advanced-nav')).toBeLessThan(build.indexOf('data-neconyan-quick-actions'));
        expect(build.indexOf('data-neconyan-quick-actions')).toBeLessThan(build.indexOf('data-neconyan-finer-nav'));
        expect(build).toContain('initializeNeconyanRailSections(rail)');
        const routes = [];
        const context = vm.createContext({
            getActiveShellRailMode: () => 'mobile',
            document: { querySelector: selector => selector },
            revealSearchMatch: (...args) => routes.push(args),
        });
        vm.runInContext(tabsSource.match(/^function editNeconyanRailQuickActions\([\s\S]*?^}/m)[0], context);
        context.editNeconyanRailQuickActions();
        expect(routes).toEqual([['right', { tabId: 'settings', element: '#sb-mobile-settings-outlet .sb-mobile-quick-actions-group' }]]);
        context.getActiveShellRailMode = () => 'desktop';
        context.editNeconyanRailQuickActions();
        expect(routes[1][1].element).toBe('#sb-desktop-settings-outlet .sb-desktop-quick-actions-group');
    });

    test('Quick Actions refreshes the active saved list and keeps the existing activation route', () => {
        class Element {
            constructor(options = {}) { Object.assign(this, options); this.dataset = {}; this.children = []; }
            append(...children) { this.children.push(...children); }
            appendChild(child) { this.append(child); }
            replaceChildren() { this.children = []; }
            addEventListener(_type, callback) { this.click = callback; }
        }
        const list = new Element();
        const calls = [];
        const desktop = [{ type: 'custom', key: 'setting:one', label: '<saved setting>' }];
        const context = vm.createContext({
            HTMLElement: Element,
            document: { querySelector: () => list },
            getActiveShellRailMode: () => 'desktop',
            getQuickActionState: () => desktop,
            normalizeMobileQuickAction: item => item,
            createElement: (_tag, options) => new Element(options),
            NN_MOBILE_QUICK_ACTION_ICON_FALLBACK: 'fa-bolt',
            activateMobileNavAction: action => calls.push(action),
        });
        vm.runInContext(tabsSource.match(/^function refreshNeconyanRailQuickActions\([\s\S]*?^}/m)[0], context);
        context.refreshNeconyanRailQuickActions();
        const button = list.children[0];
        expect(button.children[1].text).toBe('<saved setting>');
        expect(button.children[0].className).toBe('fa-solid fa-bolt');
        button.click();
        expect(calls).toEqual(desktop);
        context.refreshNeconyanRailQuickActions();
        expect(list.children[0]).toBe(button);
        context.getActiveShellRailMode = () => 'mobile';
        context.getQuickActionState = () => [];
        context.refreshNeconyanRailQuickActions();
        expect(list.children[0].text).toContain('No Quick Actions');
        context.getQuickActionState = () => [{ type: 'tab', label: 'Mobile shortcut' }];
        context.refreshNeconyanRailQuickActions();
        expect(list.children[0].children[1].text).toBe('Mobile shortcut');
    });

    test('section toggles restore saved state, persist independently and keep recent actions outside', () => {
        const names = ['workspace', 'advanced', 'quickActions', 'finer', 'modes', 'recent'];
        const panels = names.map(name => {
            const label = { textContent: name, replaceWith(button) { this.button = button; } };
            const heading = {
                classes: new Set(), appended: [],
                classList: { add: className => heading.classes.add(className) },
                querySelector: () => label,
                querySelectorAll: () => (name === 'quickActions' ? ['edit'] : name === 'recent' ? ['archive', 'refresh'] : []),
                append(...nodes) { this.appended.push(...nodes); },
            };
            return { previousElementSibling: heading, label, heading };
        });
        const tools = { open: false, addEventListener(_type, callback) { this.toggle = callback; } };
        const saved = new Map([['sections', '{"advanced":true,"workspace":false,"tools":false}']]);
        const context = vm.createContext({
            NECONYAN_RAIL_SECTIONS_KEY: 'sections',
            accountStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
            document: { createElement: () => ({
                dataset: {}, attributes: {}, label: {}, children: [],
                append(...nodes) { this.children.push(...nodes); },
                setAttribute(key, value) { this.attributes[key] = value; },
                querySelector() { return this.label; },
                addEventListener(_type, callback) { this.click = callback; },
            }) },
        });
        vm.runInContext(getWelcomeFunctionSource('initializeNeconyanRailSections'), context);
        let index = 0;
        context.initializeNeconyanRailSections({ querySelector: () => panels[index++] || tools });
        expect(panels.map(panel => panel.hidden)).toEqual([false, true, false, false, false, false]);
        expect(tools.open).toBe(true);
        expect(panels.every(panel => panel.heading.classes.has('neconyan-rail-section-collapsible'))).toBe(true);
        const quickActionsGroup = panels[2].heading.appended[0];
        expect(quickActionsGroup.className).toBe('neconyan-rail-section-actions');
        expect(quickActionsGroup.children).toEqual(['edit']);
        expect(panels[5].heading.appended[0].children).toEqual(['archive', 'refresh']);
        expect(panels[0].heading.appended).toEqual([]);
        const css = readSource('public', 'css', 'neconyan.css');
        expect(css).toContain('body.neconyan .neconyan-rail-section-collapsible > * { grid-area: 1 / 1; }');
        expect(css).toMatch(/\.neconyan-rail-section-actions \{[^}]*justify-self: end;[^}]*margin-right: 22px;/);
        panels[0].label.button.click();
        expect(panels[0].hidden).toBe(true);
        expect(panels[0].label.button.attributes['aria-expanded']).toBe('false');
        expect(panels[0].label.button.attributes['aria-controls']).toBe(panels[0].id);
        expect(JSON.parse(saved.get('sections'))).toEqual({ advanced: true, workspace: true, tools: false });
        panels[0].label.button.click();
        expect(panels[0].hidden).toBe(false);
        tools.open = false;
        tools.toggle();
        expect(JSON.parse(saved.get('sections')).tools).toBe(true);
        saved.set('sections', 'invalid');
        index = 0;
        context.initializeNeconyanRailSections({ querySelector: () => panels[index++] || tools });
        expect(panels.every(panel => !panel.hidden)).toBe(true);
        expect(tools.open).toBe(false);
    });

    test('keeps the old avatar updater as the same callable function', () => {
        class Observer {}
        const context = {
            window: {}, MutationObserver: Observer,
            nnState: { chatAvatars: { observer: new Observer() } },
            updateChatAvatarVariables: () => {},
        };
        const initialize = tabsSource.match(/^function initChatAvatarVariables\([\s\S]*?^}/m)[0];
        vm.runInNewContext(`${initialize}\ninitChatAvatarVariables();`, context);
        expect(context.window.updateNeconyanChatAvatars).toBe(context.updateChatAvatarVariables);
    });

    test('keeps the native tool list flat, live, and individually expandable', () => {
        const definitions = tabsSource.match(/const NECONYAN_NATIVE_TOOL_DEFINITIONS = Object\.freeze\(\[[\s\S]*?\n\]\);/)[0];
        const labels = Array.from(definitions.matchAll(/label: '([^']+)'/g)).map(match => match[1]);
        expect(labels).toEqual([
            'Preset Tools', 'Chat Completion Tabs', 'Dialogue Colors', 'Termeownal UI', 'BotSearcher',
            'Prompt Tags', 'Regex Agent Themes', 'Macro Enhanced', 'World Info Lab', 'Prompting Lab',
            'Debugger', 'Chat Archive', 'CSS Snippets', 'Lorebook Distiller', 'Card & Lorebook Time Machine',
            'Deep Swipe', 'Story Mode', 'Meower', 'Pawthfinder', 'Quick Image Gen', 'Character Expressions', 'Regexes',
        ]);
        expect(welcomeSource).toContain('[\'extensions\', \'Extensions\', \'fa-cubes\']');
        expect(welcomeSource).toContain('class="neconyan-rail-advanced"');
        expect(welcomeSource).not.toContain('neconyan-rail-advanced sb-advanced-only');
        // Fine-tuning and Modes have matching heading gaps.
        expect(neconyanCss).toContain('body.neconyan .neconyan-rail-modes-label { margin-top: 14px; }');
        expect(neconyanCss).toContain('body.neconyan .neconyan-rail-advanced { margin-top: 14px; }');
        expect(welcomeSource).toContain('[\'presets\', \'Presets\', \'fa-sliders\']');
        expect(welcomeSource).toContain('[\'model\', \'Connections\', \'fa-plug\']');
        expect(welcomeSource).toContain('[\'pathfinder\', \'Pawthfinder\', \'fa-diamond-turn-right\']');
        expect(welcomeSource).toContain('[\'dialogue-colors\', \'Dialogue Colors\', \'fa-palette\']');
        expect(welcomeSource).toContain('[\'quick-image-gen\', \'Quick Image Gen\', \'fa-image\']');
        expect(welcomeSource).toContain('[\'background\', \'Background\', \'fa-panorama\']');
        expect(tabsSource).toContain('[\'right\', \'extensions\', \'Extensions\', \'fa-cubes\']');
        expect(tabsSource).toContain('[\'left\', \'api\', \'Connections\', \'fa-plug\']');
        expect(tabsSource).toContain('data-neconyan-native-tool-list');
        expect(tabsSource).toContain('id: \'sb-topbar-clock\'');
        expect(tabsSource).toContain('id: \'sb-topbar-edit-card\'');
        expect(tabsSource).toContain('syncTopbarEditCardButton');
        expect(tabsSource).toContain('event_types.EXTENSION_SETTINGS_LOADED');
        expect(tabsSource).toContain('event_types.EXTENSION_DISABLED');
        expect(tabsSource).toContain('\'aria-controls\': panelId');
    });

    test('allowlists mode requests and keeps mode state separate from Advanced state', () => {
        const modeIds = ['roleplay', 'conversation', 'meower', 'story'];
        const normalizeSource = tabsSource.match(/^function normalizeNeconyanMode\([\s\S]*?^}/m)[0];
        const context = vm.createContext({ NECONYAN_MODE_IDS: new Set(modeIds) });
        vm.runInContext(normalizeSource, context);
        expect(context.normalizeNeconyanMode('story-mode')).toBe('story');
        expect(context.normalizeNeconyanMode('conversation')).toBe('conversation');
        expect(context.normalizeNeconyanMode('advanced')).toBe('');
        expect(context.normalizeNeconyanMode('')).toBe('');
        expect(tabsSource).toContain('document.querySelectorAll(\'button[data-neconyan-chat-mode]\')');
        expect(tabsSource).not.toContain('\'data-neconyan-mode\': definition.id');
    });

    test('tutorial keeps its step on failed save, rejects duplicate clicks and allows retry', async () => {
        class Element {
            dataset = { tutorialExpanded: 'true', tutorialIndex: '3' };
            buttons = [{ disabled: false }, { disabled: true }];
            querySelectorAll() { return this.buttons; }
        }
        const panel = new Element();
        const preferences = new Map([['index', '3']]);
        let resolveSave;
        let saves = 0;
        const context = vm.createContext({
            HTMLElement: Element, document: { querySelectorAll: () => [] },
            tutorialStatusKey: 'status', tutorialIndexKey: 'index', console: { error() {} },
            getWelcomeUiPreference: key => preferences.get(key) ?? null,
            setWelcomeUiPreference: (key, value) => preferences.set(key, value),
            restoreWelcomeUiPreference: (key, value) => value === null ? preferences.delete(key) : preferences.set(key, value),
            setTutorialUiState: (target, index, expanded) => Object.assign(target.dataset, { tutorialIndex: String(index), tutorialExpanded: String(expanded) }),
            showTutorialCoachmark() {}, removeTutorialCoachmark() {},
            saveSettings: () => { saves++; return new Promise(resolve => { resolveSave = resolve; }); },
        });
        vm.runInContext(getWelcomeFunctionSource('dismissTutorial'), context);
        const failed = context.dismissTutorial(panel, 'skipped');
        expect(panel.dataset.tutorialExpanded).toBe('true');
        expect(panel.buttons.every(button => button.disabled)).toBe(true);
        expect(await context.dismissTutorial(panel, 'completed')).toBe(false);
        expect(saves).toBe(1);
        resolveSave(false);
        expect(await failed).toBe(false);
        expect(preferences.has('status')).toBe(false);
        expect(panel.dataset).toEqual({ tutorialExpanded: 'true', tutorialIndex: '3' });
        expect(panel.buttons.map(button => button.disabled)).toEqual([false, true]);
        const retry = context.dismissTutorial(panel, 'skipped');
        resolveSave(true);
        expect(await retry).toBe(true);
        expect(preferences.get('status')).toBe('skipped');
        expect(panel.dataset.tutorialExpanded).toBe('false');
    });

    test('another account does not inherit a skipped or hidden tutorial from device storage', () => {
        const context = vm.createContext({
            accountStorage: { getItem: () => null }, tutorialStatusKey: 'status', tutorialIndexKey: 'index', tutorialHiddenKey: 'hidden',
            localStorage: { getItem: () => 'skipped' },
        });
        vm.runInContext(getWelcomeFunctionSource('getWelcomeUiPreference'), context);
        expect(context.getWelcomeUiPreference('status')).toBeNull();
        expect(context.getWelcomeUiPreference('hidden')).toBeNull();
    });

    test('Story accepts chats without an avatar and aborts stale or busy transitions', async () => {
        const opened = [];
        let navigationOpen = true;
        let workspaceOpen = true;
        const context = vm.createContext({
            normalizeNeconyanMode: value => value, neconyanModeTask: null,
            chat: [{ mes: 'Temporary chat' }], getCurrentChatId: () => '',
            getNeconyanModeDefinition: () => ({ label: 'Story Mode' }), getActualNeconyanMode: () => 'roleplay',
            getNeconyanModeContext: () => ({}), isNeconyanModeContextCurrent: () => true,
            isNeconyanModeExtensionEnabled: () => true, getActiveNeconyanAvatar: () => '',
            hasActiveCharacterChat: () => true,
            promptForNeconyanCharacter: () => { throw new Error('An avatar is not required for a manuscript.'); },
            isNeconyanModeBusy: () => false, closeActiveNeconyanMode: async () => true,
            getNeconyanModeLifecycle: () => ({ setEnabled: async enabled => { opened.push(enabled); return true; } }),
            closeWorkspace() { workspaceOpen = false; }, closeMobileNav() { navigationOpen = false; }, queueNeconyanModeSync() {},
        });
        vm.runInContext(tabsSource.match(/^async function activateNeconyanMode\([\s\S]*?^}/m)[0], context);
        expect(await context.activateNeconyanMode('story')).toBe(true);
        expect(opened).toEqual([true]);
        context.isNeconyanModeBusy = () => false;
        let finish;
        context.getNeconyanModeLifecycle = () => ({ setEnabled: () => new Promise(resolve => { finish = resolve; }) });
        navigationOpen = workspaceOpen = true;
        const pending = context.activateNeconyanMode('story');
        await Promise.resolve();
        expect(navigationOpen).toBe(false);
        expect(workspaceOpen).toBe(false);
        // A drawer opened during a slow mode change belongs to the newer user action.
        navigationOpen = workspaceOpen = true;
        expect(await context.activateNeconyanMode('roleplay')).toBe(false);
        finish(true);
        expect(await pending).toBe(true);
        expect(navigationOpen).toBe(true);
        expect(workspaceOpen).toBe(true);
        context.chat = [];
        expect(await context.activateNeconyanMode('story')).toBe(false);
        context.getNeconyanModeLifecycle = () => ({ open: async () => true });
        expect(await context.activateNeconyanMode('meower')).toBe(true);
        context.chat = [{ mes: 'Temporary chat' }];
        context.isNeconyanModeContextCurrent = () => false;
        expect(await context.activateNeconyanMode('story')).toBe(false);
        context.isNeconyanModeContextCurrent = () => true;
        context.isNeconyanModeBusy = () => true;
        expect(await context.activateNeconyanMode('story')).toBe(false);
        expect(opened).toEqual([true]);
        context.isNeconyanModeBusy = () => false;
        context.hasActiveCharacterChat = () => false;
        context.getActualNeconyanMode = () => 'roleplay';
        context.promptForNeconyanCharacter = () => false;
        expect(await context.activateNeconyanMode('roleplay')).toBe(false);
    });

    test('uses the generated cloud as a pointerless ambient layer without taking over bg1', () => {
        expect(neconyanCalicoCss).toContain('kitty-clouds.webp?v=20260913g');
        expect(neconyanCalicoCss).toContain('pointer-events: none;');
        expect(backgroundsCss).toContain('#bg1');
        // The user's picked background paints above the default cloud art.
        expect(neconyanCalicoCss).toMatch(/body\.neconyan::before\s*\{[^}]*z-index: -2;/);
        expect(backgroundsCss).toMatch(/#bg1\s*\{[^}]*z-index: -1;/);
        // Phones keep the character name in the centre and drop the clock instead.
        expect(neconyanCss).not.toContain('body.neconyan #sb-topbar-title { display: none !important; }');
        expect(neconyanCss).toContain('body.neconyan #sb-topbar-clock { display: none; }');
    });

    test('keeps the current chat intact when a reply is running', async () => {
        const runtime = createWelcomeRuntime({ is_send_press: true });
        expect(await runtime.context.activateNeconyanRailRoute('new-chat')).toBe(false);
        expect(runtime.actions).toEqual([['notice', 'Stop the current reply before starting a new chat.']]);
    });
    test('New chat uses the temporary assistant flow before leaving Home', async () => {
        const runtime = createWelcomeRuntime();

        await runtime.context.activateNeconyanRailRoute('new-chat');

        expect(runtime.actions).toEqual([
            ['focus', runtime.textarea],
            ['new-chat', { temporary: true }],
            ['hide-home'],
            ['focus', runtime.textarea],
        ]);
    });

    test('Home delegates to the real shell Home route and waits for it', async () => {
        const actions = [];
        const runtime = createWelcomeRuntime({
            globalThis: {
                NeconyanShell: {
                    showHome: async () => actions.push('show-home'),
                },
            },
        });
        runtime.context.globalThis = runtime.context;
        runtime.context.NeconyanShell = { showHome: async () => actions.push('show-home') };

        await runtime.context.activateNeconyanRailRoute('home');

        expect(actions).toEqual(['show-home']);
    });

    test('Characters opens the library even after editing a card', () => {
        const routes = [];
        const runtime = createWelcomeRuntime();
        runtime.context.NeconyanShell = { openTab: (...route) => routes.push(route) };
        runtime.context.activateNeconyanRailRoute('characters');
        expect(routes).toEqual([['characters', 'characters']]);
    });

    test('Connections rail entry opens the Connections tab', () => {
        const routes = [];
        const runtime = createWelcomeRuntime();
        runtime.context.NeconyanShell = { openTab: (...route) => routes.push(route) };
        runtime.context.activateNeconyanRailRoute('model');
        expect(routes).toEqual([['left', 'api']]);
    });

    test('Agents opens its workbench directly', () => {
        const routes = [];
        const runtime = createWelcomeRuntime();
        runtime.context.NeconyanShell = { openTab: (...route) => routes.push(route) };
        runtime.context.activateNeconyanRailRoute('agents');
        expect(routes).toEqual([['left', 'agents']]);
    });

    test('Advanced rail destinations open their existing workspaces', () => {
        const routes = [];
        const runtime = createWelcomeRuntime();
        runtime.context.NeconyanShell = { openTab: (...route) => routes.push(route) };

        for (const route of ['presets', 'sampling', 'formatting', 'persona', 'background']) {
            runtime.context.activateNeconyanRailRoute(route);
        }

        expect(routes).toEqual([
            ['left', 'presets'],
            ['left', 'sampling'],
            ['left', 'advanced-formatting'],
            ['characters', 'persona'],
            ['right', 'background'],
        ]);
    });

    test('Fine-tuning additions open Pawthfinder, Dialogue Colors and Quick Image Gen', () => {
        const routes = [];
        const calls = [];
        const runtime = createWelcomeRuntime();
        runtime.context.NeconyanShell = { openTab: (...route) => routes.push(route) };
        runtime.context.NeconyanAgents = { openPathfinder: () => calls.push('pathfinder') };
        runtime.context.NeconyanExtensions = { focusUnit: label => calls.push(`focus:${label}`) };

        runtime.context.activateNeconyanRailRoute('pathfinder');
        runtime.context.activateNeconyanRailRoute('dialogue-colors');
        runtime.context.activateNeconyanRailRoute('quick-image-gen');

        expect(routes).toEqual([['right', 'extensions']]);
        expect(calls).toEqual(['pathfinder', 'focus:Dialogue Colors', 'focus:Quick Image Gen']);
    });

    test('recent roleplay and group entries strip the API .jsonl suffix', async () => {
        const runtime = createWelcomeRuntime();

        await runtime.context.openNeconyanRecentChat({ avatar: 'calico.png', chat_name: 'Window seat', file_name: 'Window seat.jsonl' });
        await runtime.context.openNeconyanRecentChat({ group: 'writers', is_group: true, chat_name: 'Workshop', file_name: 'Workshop.jsonl' });
        await runtime.context.openNeconyanRecentChat({ avatar: 'calico.png', group: 'writers', is_conversation: true, conversation_branch_id: 'branch-1', chat_name: 'Branch' });
        await runtime.context.openNeconyanRecentChat({ avatar: 'calico.png', file_name: 'Fallback.jsonl' });

        expect(runtime.actions).toEqual([
            ['character', 'calico.png', 'Window seat'],
            ['group', 'writers', 'Workshop'],
            ['conversation', 'calico.png', 'writers', 'branch-1'],
            ['character', 'calico.png', 'Fallback'],
        ]);
    });

    test('reveals a selected chat only after it has opened successfully', async () => {
        let finishOpen;
        let closed = 0;
        const runtime = createWelcomeRuntime({
            openRecentCharacterChat: () => new Promise(resolve => { finishOpen = resolve; }),
        });
        runtime.context.NeconyanShell = { closeWorkspace: () => { closed++; } };
        const pending = runtime.context.openNeconyanRecentChat({ avatar: 'calico.png', chat_name: 'Window seat' });
        expect(closed).toBe(0);
        finishOpen(true);
        await pending;
        expect(closed).toBe(1);
        runtime.context.openRecentCharacterChat = async () => false;
        await runtime.context.openNeconyanRecentChat({ avatar: 'missing.png' });
        expect(closed).toBe(1);
        runtime.context.openRecentCharacterChat = async () => { throw new Error('load failed'); };
        await expect(runtime.context.openNeconyanRecentChat({ avatar: 'calico.png' })).rejects.toThrow('load failed');
        expect(closed).toBe(1);
    });

    test('search asks an embedded settings view to reveal its target before scrolling', () => {
        const events = [];
        const Element = class {
            dispatchEvent(event) { events.push(event); }
        };
        const runtime = vm.createContext({
            HTMLElement: Element,
            CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
            document: { getElementById: () => null },
        });
        vm.runInContext(tabsSource.match(/^function revealSettingsCategoryFor\([\s\S]*?^}/m)[0], runtime);
        const target = new Element();
        runtime.revealSettingsCategoryFor(target);
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('sb:reveal-search-target');
        expect(events[0].bubbles).toBe(true);
        expect(events[0].detail.target).toBe(target);
    });

    test('failed temporary chat creation keeps Home visible', async () => {
        const runtime = createWelcomeRuntime({ newAssistantChat: async () => { throw new Error('save failed'); } });
        await expect(runtime.context.activateNeconyanRailRoute('new-chat')).rejects.toThrow('save failed');
        expect(runtime.actions.some(([action]) => action === 'hide-home')).toBe(false);
    });

    test('opening a Neconyan inspector replaces the previous panel without closing extension drawers', () => {
        const closed = [];
        const Element = class {
            constructor(id) { this.id = id; }
            classList = { toggle() {} };
        };
        const runtime = vm.createContext({
            HTMLElement: Element,
            document: { body: { classList: { contains: () => true } }, getElementById: id => new Element(id) },
            finishUiMotion() {},
            setUiVisibility: (_element, visible, apply) => apply(visible),
            closeShell: key => closed.push(key),
            displaceCharacterPanel: () => closed.push('characters'),
            syncDrawerIconState() {},
            queueMobileModalStateSync() {},
            queueTopbarPageStateSync() {},
        });
        vm.runInContext(tabsSource.match(/^function forceDrawerState\([\s\S]*?^}/m)[0], runtime);
        runtime.forceDrawerState(new Element('user-settings-block'), true);
        expect(closed).toEqual(['left', 'characters']);
        closed.length = 0;
        runtime.forceDrawerState(new Element('extension-panel'), true);
        expect(closed).toEqual([]);
        runtime.forceDrawerState(new Element('user-settings-block'), false);
        expect(closed).toEqual([]);
    });

    test('shell Home calls the landing page loader so an active chat cannot leave a blank surface', () => {
        const match = tabsSource.match(/showHome\(\) \{[\s\S]*?\n {8}\},/);
        expect(match).not.toBeNull();
        expect(match[0]).toContain('return returnToLandingPage();');
    });
});
