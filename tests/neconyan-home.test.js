import { describe, expect, test } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Handlebars = require('handlebars');
const read = path => readFileSync(new URL('../public/' + path, import.meta.url), 'utf8');
const artwork = JSON.parse(readFileSync(new URL('../public/img/neconyan/artwork-provenance.json', import.meta.url), 'utf8'));
const artworkOutput = path => artwork.outputs.find(output => output.path === `public/${path}`);

describe('Neconyan Home', () => {
    test('adds one decorative whisker trace without replacing the action label', () => {
        const action = {
            html: '<span>Continue your chat</span>',
            querySelector() { return this.html.includes('neconyan-whiskers'); },
            insertAdjacentHTML(position, html) {
                expect(position).toBe('beforeend');
                this.html += html;
            },
        };
        const context = vm.createContext({
            window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
            document: { addEventListener() {} }, HTMLButtonElement: class {}, HTMLImageElement: class {},
        });
        vm.runInContext(read('scripts/neconyan-home.js').replace(/^export /gm, ''), context);
        const root = { querySelectorAll: () => [action], querySelector: () => null };
        context.initializeNeconyanHome(root);
        context.initializeNeconyanHome(root);
        expect(action.html.match(/class="neconyan-whiskers"/g)).toHaveLength(1);
        expect(action.html).toContain('img/neconyan/cat-head.webp');
        expect(action.html).toContain('neconyan-whisker-left');
        expect(action.html).not.toContain('<rect');
        expect(action.html).toContain('<span>Continue your chat</span>');
        expect(action.html).toContain('aria-hidden="true"');
    });

    test('renders a useful empty page and keeps chat text escaped', () => {
        const render = Handlebars.compile(read('scripts/templates/welcomePanelOnboarding.html'));
        const empty = render({ empty: true, welcomePanelMode: 'full' });
        expect(empty).toContain('Your chats will appear here.');
        expect(empty).toContain('img/neconyan/sleepy-chat.webp');
        expect(empty).toContain('img/neconyan/curious-search.webp');
        expect(empty).toContain('data-neconyan-cat-toggle');
        expect(empty).toContain('Pause cat animation');
        const populated = render({ chats: [{ char_name: '<img src=x onerror=alert(1)>', chat_name: 'My chat', mes: '<script>test</script>' }] });
        expect(populated).not.toContain('<img src=x');
        expect(populated).toContain('&lt;script&gt;test&lt;/script&gt;');
        expect(populated).toContain('aria-label="Rename chat"');
        const ids = [...populated.matchAll(/\bid="([^"\s]+)"/g)].map(match => match[1]);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('pauses and resumes the cat through its real click handler', () => {
        let click;
        class Element {}
        class HTMLImageElement extends Element {}
        class HTMLButtonElement extends Element {
            dataset = {};
            closest(selector) { return selector === '[data-neconyan-cat-toggle]' ? this : { querySelector: () => cat }; }
        }
        const cat = new HTMLImageElement();
        const button = new HTMLButtonElement();
        vm.runInNewContext(read('scripts/neconyan-home.js').replace(/^export /gm, ''), {
            window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
            document: { addEventListener: (name, handler) => { if (name === 'click') click = handler; } },
            Element, HTMLButtonElement, HTMLImageElement,
        });
        click({ target: button });
        expect(cat.src).toBe('img/neconyan-pixel-cat-rest.webp?v=20260913g');
        expect(button.textContent).toBe('Play cat animation');
        click({ target: button });
        expect(cat.src).toBe('img/neconyan-pixel-cat.webp?v=20260913g');
        expect(button.textContent).toBe('Pause cat animation');
    });

    test('ships the animated and resting raster sprites with recorded timing', () => {
        const moving = artworkOutput('img/neconyan-pixel-cat.webp');
        const running = artworkOutput('img/neconyan-pixel-cat-running.webp');
        const resting = artworkOutput('img/neconyan-pixel-cat-rest.webp');
        expect(existsSync(new URL('../public/img/neconyan-pixel-cat.webp', import.meta.url))).toBe(true);
        expect(existsSync(new URL('../public/img/neconyan-pixel-cat-running.webp', import.meta.url))).toBe(true);
        expect(existsSync(new URL('../public/img/neconyan-pixel-cat-rest.webp', import.meta.url))).toBe(true);
        expect(moving).toMatchObject({ size: [208, 192], frames: 29, loop_ms: 4500 });
        expect(running).toMatchObject({ size: [384, 192], frames: 4, loop_ms: 440 });
        expect(resting).toMatchObject({ size: [208, 192], frames: 1 });
        expect(read('css/login.css')).toContain('color-scheme: dark');
    });

    test('the app reduced-motion setting hides Play and cannot be bypassed by a click', () => {
        let click;
        let reduced = true;
        class Element {}
        class HTMLImageElement extends Element {}
        class HTMLButtonElement extends Element {
            dataset = {};
            closest(selector) { return selector === '[data-neconyan-cat-toggle]' ? this : { querySelector: () => cat }; }
        }
        const cat = new HTMLImageElement();
        const button = new HTMLButtonElement();
        const context = vm.createContext({
            window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
            document: {
                body: { classList: { contains: () => reduced } },
                addEventListener: (name, handler) => { if (name === 'click') click = handler; },
            },
            Element, HTMLButtonElement, HTMLImageElement,
        });
        vm.runInContext(read('scripts/neconyan-home.js').replace(/^export /gm, ''), context);
        const root = { querySelectorAll: () => [], querySelector: selector => selector.includes('toggle') ? button : cat };
        context.initializeNeconyanHome(root);
        expect(button.hidden).toBe(true);
        expect(cat.src).toContain('neconyan-pixel-cat-rest.webp');
        click({ target: button });
        expect(cat.src).toContain('neconyan-pixel-cat-rest.webp');
        reduced = false;
        context.initializeNeconyanHome(root);
        expect(button.hidden).toBe(false);
        expect(cat.src).toContain('neconyan-pixel-cat.webp');
    });

    test('Home waits for the app motion class when the OS preference changes', () => {
        let reduced = true;
        let osReduced = true;
        let changed;
        const frames = [];
        class HTMLButtonElement { dataset = {}; }
        class HTMLImageElement {}
        const button = new HTMLButtonElement();
        const cat = new HTMLImageElement();
        const root = { querySelectorAll: () => [], querySelector: selector => selector.includes('toggle') ? button : cat };
        const context = vm.createContext({
            window: {
                matchMedia: () => ({ get matches() { return osReduced; }, addEventListener: (_type, handler) => { changed = handler; } }),
                requestAnimationFrame: callback => frames.push(callback),
            },
            document: {
                body: { classList: { contains: () => reduced } },
                addEventListener() {}, querySelectorAll: selector => selector === '.neconyan-home' ? [root] : [],
            },
            HTMLButtonElement, HTMLImageElement,
        });
        vm.runInContext(read('scripts/neconyan-home.js').replace(/^export /gm, ''), context);
        context.initializeNeconyanHome(root);
        expect(cat.src).toContain('neconyan-pixel-cat-rest.webp');
        osReduced = false;
        changed();
        reduced = false;
        expect(frames).toHaveLength(1);
        frames.shift()();
        expect(cat.src).toContain('neconyan-pixel-cat.webp');
        expect(button.hidden).toBe(false);
    });

    test('OS reduced motion is effective without changing the saved app preference', () => {
        const image = {};
        let osReduced = false;
        let duration;
        const state = {};
        const control = {
            prop(name, value) { state[name] = value; return this; },
            closest() { return this; },
            attr(name, value) { state[name] = value; return this; },
            toggleClass(name, value) { state[name] = value; return this; },
        };
        const mediaQuery = { get matches() { return osReduced; } };
        const context = vm.createContext({
            power_user: { reduced_motion: false }, window: { matchMedia: () => mediaQuery },
            jQuery: { fx: {} }, $: () => control, ANIMATION_DURATION_DEFAULT: 125,
            setAnimationDuration: value => { duration = value; },
            document: { querySelectorAll: () => [image] }, t: parts => parts.join(''),
        });
        vm.runInContext(read('scripts/power-user.js').match(/^function switchReducedMotion\(\) {[\s\S]*?^}/m)[0], context);
        context.switchReducedMotion();
        expect(context.power_user.reduced_motion).toBe(false);
        expect(context.jQuery.fx.off).toBe(false);
        expect(duration).toBe(125);
        expect(state.checked).toBe(false);
        expect(state.disabled).toBe(false);
        expect(state['reduced-motion']).toBe(false);
        expect(image.src).toContain('neconyan-pixel-cat-running.webp');

        osReduced = true;
        context.switchReducedMotion();
        expect(context.power_user.reduced_motion).toBe(false);
        expect(context.jQuery.fx.off).toBe(true);
        expect(duration).toBe(0);
        expect(state.checked).toBe(true);
        expect(state.disabled).toBe(true);
        expect(state['reduced-motion']).toBe(true);
        expect(image.src).toContain('neconyan-pixel-cat-rest.webp');

        osReduced = false;
        context.switchReducedMotion();
        expect(context.power_user.reduced_motion).toBe(false);
        expect(context.jQuery.fx.off).toBe(false);
        expect(duration).toBe(125);
        expect(state.checked).toBe(false);
        expect(state.disabled).toBe(false);
        expect(state['reduced-motion']).toBe(false);
        expect(image.src).toContain('neconyan-pixel-cat-running.webp');

        context.power_user.reduced_motion = true;
        context.switchReducedMotion();
        expect(context.power_user.reduced_motion).toBe(true);
        expect(context.jQuery.fx.off).toBe(true);
        expect(image.src).toContain('neconyan-pixel-cat-rest.webp');
    });

    test('startup overlay setup failure leaves the early cat for the boot guard', async () => {
        const early = { hidden: false, isConnected: true };
        const cleanups = [];
        const errors = [];
        const context = vm.createContext({
            document: { getElementById: () => early, createElement: () => ({}) },
            loader: {
                createOverlay: () => ({ classList: { add() {} }, setAttribute() {}, prepend() {} }),
                ToastMode: { NONE: 'none' },
                show: () => { throw new Error('popup setup failed'); },
            },
            toastr: { error: message => errors.push(message) }, console: { error() {} }, t: parts => parts.join(''),
            cleanupActionLoaderArtifacts: options => { cleanups.push(options); if (options.removePreloader) early.isConnected = false; },
            requestAnimationFrame: callback => callback(),
            window: { setTimeout: callback => callback() },
        });
        vm.runInContext(read('script.js').match(/^async function firstLoadInit\(\) {[\s\S]*?^}/m)[0], context);
        await expect(context.firstLoadInit()).rejects.toThrow('popup setup failed');
        expect(early.hidden).toBe(false);
        expect(errors).toHaveLength(1);
        expect(early.isConnected).toBe(true);
        expect(cleanups).toHaveLength(0);
    });

    test('uses the running cat for the initial and popup loaders without startup text', () => {
        const html = read('index.html');
        const script = read('script.js');
        expect(html).toContain('id="preloader" role="status" aria-label="Neconyan is loading"');
        expect(html).toContain('<source media="(prefers-reduced-motion: reduce)" srcset="img/neconyan-pixel-cat-rest.webp?v=20260913g">');
        expect(html).toContain('neconyan-pixel-cat-running.webp?v=20260913g');
        expect(script).toContain('splashLogo.src = `${window.matchMedia?.');
        expect(script).toContain('neconyan-pixel-cat-running.webp');
        expect(script).toContain('neconyan-pixel-cat-rest.webp');
        expect(script).not.toContain('Initializing…');
        expect(script).not.toContain('splashLogo.dataset.sbFrontendIcon');
        expect(script).not.toContain('splashMessage');
    });

    test('keeps cat ears tucked behind cards while exposing their twitch state', () => {
        const calico = read('css/neconyan-calico.css');
        expect(calico).toContain('.neconyan-cat-panel, .neconyan-assistant-row, #right-nav-panel .sb-character-editor-identity)::before');
        expect(calico).toContain('pointer-events: auto');
        expect(calico).toContain('overflow: visible');
        expect(calico).toContain('background: url(\'../img/neconyan/ear-left.webp\')');
        expect(calico).toContain('background: url(\'../img/neconyan/ear-right.webp\')');
        expect(calico).toContain('transform: translateY(-100%) skewX(-7deg)');
        expect(calico).toContain('animation: neconyan-ear-twitch-left 320ms ease-in-out');
        expect(calico).toContain('animation: neconyan-ear-press-left 260ms ease-out');
        expect(calico).toContain('body.neconyan.reduced-motion');
        expect(calico).toContain('prefers-reduced-motion: reduce');
    });

    test('offers side-tour replay from every Home layout without an embedded tour', () => {
        const render = Handlebars.compile(read('scripts/templates/welcomePanelOnboarding.html'));
        for (const mode of ['full', 'compact', 'list']) {
            const html = render({ welcomePanelMode: mode, welcomePanelCompact: mode === 'compact', welcomePanelListOnly: mode === 'list', tutorialHidden: true });
            expect(html).toContain('data-action="replay-tutorial">Replay First paws tour</button>');
            expect(html).not.toContain('welcomeTourPanel');
            expect(html).not.toContain('welcomeAdvancedHome');
        }
    });

    test('new accounts start pending, unfinished tours resume and dismissals stay closed', () => {
        const defaults = JSON.parse(readFileSync(new URL('../default/content/settings.json', import.meta.url), 'utf8'));
        const values = new Map(Object.entries(defaults.accountStorage));
        let opens = 0;
        const context = vm.createContext({
            tutorialStatusKey: 'NeconyanTutorialStatus.v1', tutorialHiddenKey: 'NeconyanTutorialHidden.v1',
            getWelcomeUiPreference: key => values.get(key) ?? null,
            showTutorialCoachmark: () => { opens++; },
        });
        vm.runInContext(read('scripts/welcome-screen.js').match(/^function resumeTutorial\(\) {[\s\S]*?^}/m)[0], context);
        context.resumeTutorial();
        expect(opens).toBe(1);
        for (const status of ['', 'pending']) {
            values.set('NeconyanTutorialStatus.v1', status);
            context.resumeTutorial();
        }
        expect(opens).toBe(3);
        for (const status of ['completed', 'skipped', null]) {
            values.set('NeconyanTutorialStatus.v1', status);
            context.resumeTutorial();
        }
        values.set('NeconyanTutorialStatus.v1', 'pending');
        values.set('NeconyanTutorialHidden.v1', 'true');
        context.resumeTutorial();
        expect(opens).toBe(3);
    });
});

describe('assistant shortcuts without shipped characters', () => {
    const source = read('scripts/welcome-screen.js');
    const extract = name => source.match(new RegExp('^(?:export )?(?:async )?function ' + name + '\\([\\s\\S]*?^}', 'm'))[0].replace('export ', '');
    test('starts a temporary chat when no assistant was assigned', async () => {
        const calls = [];
        const context = vm.createContext({
            characters: [], assistantAvatarKey: 'assistant',
            accountStorage: { getItem: () => null },
            newAssistantChat: async options => calls.push(options),
        });
        vm.runInContext(extract('getPermanentAssistantAvatar') + '\n' + extract('openPermanentAssistantChat'), context);
        await context.openPermanentAssistantChat();
        expect(calls).toEqual([{ temporary: true }]);
    });
    test('keeps an explicitly assigned character usable', async () => {
        const calls = [];
        const context = vm.createContext({
            characters: [{ avatar: 'my-character.png' }], assistantAvatarKey: 'assistant',
            accountStorage: { getItem: () => 'my-character.png' },
            selectCharacterById: async id => calls.push(['select', id]),
            doNewChat: async options => calls.push(['new', options]),
        });
        vm.runInContext(extract('getPermanentAssistantAvatar') + '\n' + extract('openPermanentAssistantChat'), context);
        await context.openPermanentAssistantChat();
        expect(calls).toEqual([['select', 0], ['new', { deleteCurrentChat: false }]]);
    });
    test('shows the chrome only once the boot skeleton leaves #chat', () => {
        const bodyClasses = new Set(['neconyan', 'neconyan-home-booting']);
        const elements = new Map([['chat', { id: 'chat' }], ['neconyan-home-skeleton', { id: 'neconyan-home-skeleton' }]]);
        const observers = [];
        const context = vm.createContext({
            document: {
                body: { classList: { remove: name => bodyClasses.delete(name) } },
                getElementById: id => elements.get(id) ?? null,
            },
            MutationObserver: class {
                constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
                observe(target, options) { this.target = target; this.options = options; }
                disconnect() { this.disconnected = true; }
            },
        });
        vm.runInContext(extract('releaseChromeAfterBootSkeleton'), context);

        context.releaseChromeAfterBootSkeleton();
        expect(bodyClasses.has('neconyan-home-booting')).toBe(true);
        expect(observers).toHaveLength(1);
        expect(observers[0].target).toBe(elements.get('chat'));
        expect({ ...observers[0].options }).toEqual({ childList: true });

        observers[0].callback([]);
        expect(bodyClasses.has('neconyan-home-booting')).toBe(true);
        expect(observers[0].disconnected).toBe(false);

        elements.delete('neconyan-home-skeleton');
        observers[0].callback([]);
        expect(bodyClasses.has('neconyan-home-booting')).toBe(false);
        expect(observers[0].disconnected).toBe(true);

        bodyClasses.add('neconyan-home-booting');
        context.releaseChromeAfterBootSkeleton();
        expect(bodyClasses.has('neconyan-home-booting')).toBe(false);
        expect(observers).toHaveLength(1);
    });
    for (const activeChat of [false, true]) {
        test(`resumes the tour independently of an active chat: ${activeChat}`, async () => {
            const handlers = new Map();
            let homeOpened = false;
            let toolsSynced = false;
            let tourResumed = false;
            const context = vm.createContext({
                releaseChromeAfterBootSkeleton() {}, PinnedChatsManager: { init() {} }, ensureNeconyanRail() {},
                installChatNoteCapture() {},
                window: { addEventListener() {} }, concealWelcomeHome() {},
                eventSource: { on: (key, handler) => handlers.set(key, handler), makeFirst() {} },
                event_types: { APP_READY: 'ready' }, getCurrentChatId: () => activeChat ? 'existing' : undefined, chat: [],
                openWelcomeScreen: async () => { homeOpened = true; }, scheduleNeconyanRailRefresh() {},
                syncNeconyanAssistantTools: () => { toolsSynced = true; },
                resumeTutorial: () => { tourResumed = true; },
            });
            vm.runInContext(extract('initWelcomeScreen'), context);
            context.initWelcomeScreen();
            await handlers.get('ready')();
            expect(homeOpened).toBe(!activeChat);
            expect(toolsSynced).toBe(true);
            expect(tourResumed).toBe(true);
        });
    }

    test('tour destinations use the existing actions without depending on Home elements', async () => {
        const calls = [];
        const context = vm.createContext({
            openShellTab: route => calls.push(route), focusWelcomeControl() {},
            openNeconyanTemporaryChat: async () => calls.push('temporary'),
            openRoleplayWorkspaceFromWelcome: async () => calls.push('roleplay'),
            activateNeconyanModeFromWelcome: async mode => calls.push(mode),
            NeconyanShell: { openCharacters: () => calls.push('characters'), openGlobalSearch: () => calls.push('search') },
        });
        const source = read('scripts/welcome-screen.js');
        vm.runInContext(source.match(/const WELCOME_TUTORIAL_STEPS = Object.freeze\(\[[\s\S]*?\n\]\);/)[0] + '\n' + extract('handleWelcomeAction'), context);
        const actions = vm.runInContext('WELCOME_TUTORIAL_STEPS.flatMap(step => step.actions)', context);
        for (const action of actions) {
            await context.handleWelcomeAction({ dataset: { action: action.type, actionValue: action.value } });
        }
        expect(calls).toEqual(['left:api', 'characters', 'temporary', 'roleplay', 'conversation', 'meower', 'story', 'characters:world-info', 'left:agents', 'left:presets', 'right:extensions', 'right:settings', 'search', 'left:sampling']);
    });

    test('an unacknowledged assistant shortcut is restored durably before reporting failure', async () => {
        const values = new Map([['assistant', 'old.png'], ['neconyanAssistantVariant', 'miso-male']]);
        const saves = [];
        let durable;
        let selected = false;
        const extensionSettings = {};
        const context = vm.createContext({
            getCurrentUserHandle: () => 'one', getChatGeneration: () => 1, is_send_press: false, is_group_generating: false,
            assistantAvatarKey: 'assistant', assistantVariantKey: 'neconyanAssistantVariant',
            accountStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
            extension_settings: extensionSettings, characters: [{ avatar: 'new.png' }],
            flushCharacterSaveDebounced: async () => true, getCharacters: async () => {},
            saveSettings: async () => {
                saves.push(Object.fromEntries(values));
                if (saves.length === 1) return false;
                durable = Object.fromEntries(values);
                return true;
            },
            selectCharacterById: async () => { selected = true; return true; },
        });
        vm.runInContext(extract('assertAssistantOpeningCurrent') + '\n' + extract('activateInstalledAssistant'), context);
        await expect(context.activateInstalledAssistant('nori-male', { avatar: 'new.png', spriteFolder: 'new-sprites' }, { account: 'one', generation: 1 })).rejects.toThrow('shortcut could not be saved');
        expect(saves).toHaveLength(2);
        expect(durable).toEqual({ assistant: 'old.png', neconyanAssistantVariant: 'miso-male' });
        expect(extensionSettings.expressionOverrides).toEqual([]);
        expect(selected).toBe(false);
    });
});
