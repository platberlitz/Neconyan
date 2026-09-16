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
        expect(context.window.updateSillyBunnyChatAvatars).toBe(context.window.updateNeconyanChatAvatars);
    });

    test('keeps the native tool list flat, live, and individually expandable', () => {
        const definitions = tabsSource.match(/const NECONYAN_NATIVE_TOOL_DEFINITIONS = Object\.freeze\(\[[\s\S]*?\n\]\);/)[0];
        const labels = Array.from(definitions.matchAll(/label: '([^']+)'/g)).map(match => match[1]);
        expect(labels).toEqual([
            'Preset Tools', 'Chat Completion Tabs', 'Dialogue Colors', 'Termeownal UI', 'BotSearcher',
            'Prompt Tags', 'Regex Agent Themes', 'Macro Enhanced', 'World Info Lab', 'Prompting Lab',
            'Debugger', 'Chat Archive', 'Lorebook Distiller', 'Card & Lorebook Time Machine',
            'Deep Swipe', 'Story Mode', 'Meower',         'Pawthfinder',
        ]);
        expect(welcomeSource).toContain('[\'extensions\', \'Extensions\', \'fa-cubes\']');
        expect(welcomeSource).toContain('class="neconyan-rail-advanced"');
        expect(welcomeSource).not.toContain('neconyan-rail-advanced sb-advanced-only');
        // The Advanced group opens with the same gap as the Modes label above it.
        expect(neconyanCss).toContain('body.neconyan .neconyan-rail-modes-label { margin-top: 14px; }');
        expect(neconyanCss).toContain('body.neconyan .neconyan-rail-advanced { margin-top: 14px; }');
        expect(welcomeSource).toContain('[\'presets\', \'Presets\', \'fa-sliders\']');
        expect(welcomeSource).toContain('[\'background\', \'Background\', \'fa-panorama\']');
        expect(tabsSource).toContain('[\'right\', \'extensions\', \'Extensions\', \'fa-cubes\']');
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

    test('another account does not inherit a skipped tutorial from device storage', () => {
        const context = vm.createContext({
            accountStorage: { getItem: () => null }, tutorialStatusKey: 'status', tutorialIndexKey: 'index',
            localStorage: { getItem: () => 'skipped' },
        });
        vm.runInContext(getWelcomeFunctionSource('getWelcomeUiPreference'), context);
        expect(context.getWelcomeUiPreference('status')).toBeNull();
    });

    test('Story accepts chats without an avatar and aborts stale or busy transitions', async () => {
        const opened = [];
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
            closeWorkspace() {}, closeMobileNav() {}, queueNeconyanModeSync() {},
        });
        vm.runInContext(tabsSource.match(/^async function activateNeconyanMode\([\s\S]*?^}/m)[0], context);
        expect(await context.activateNeconyanMode('story')).toBe(true);
        expect(opened).toEqual([true]);
        context.isNeconyanModeBusy = () => false;
        let finish;
        context.getNeconyanModeLifecycle = () => ({ setEnabled: () => new Promise(resolve => { finish = resolve; }) });
        const pending = context.activateNeconyanMode('story');
        await Promise.resolve();
        expect(await context.activateNeconyanMode('roleplay')).toBe(false);
        finish(true);
        expect(await pending).toBe(true);
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

    test('Model opens Connections through the main rail', () => {
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
            document: { body: { classList: { contains: () => true } } },
            closeShell: key => closed.push(key),
            closeCharacterPanel: () => closed.push('characters'),
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
