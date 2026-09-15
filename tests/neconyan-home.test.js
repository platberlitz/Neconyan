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

    test('hides the First paws tour durably and offers it back from Home layout', () => {
        const render = Handlebars.compile(read('scripts/templates/welcomePanelOnboarding.html'));
        const visible = render({ welcomePanelMode: 'full', tutorialExpanded: true });
        expect(visible).toContain('data-action="hide-tutorial"');
        expect(visible).toMatch(/class="welcomeAdvancedHome[^"]*"[^>]*\sopen(?:\s|>)/);
        expect(visible).not.toMatch(/class="welcomeAdvancedHome[^"]*"[^>]*\shidden/);
        expect(visible).toContain('data-action="reopen-tutorial" hidden');

        const hidden = render({ welcomePanelMode: 'full', tutorialHidden: true });
        expect(hidden).toMatch(/class="welcomeAdvancedHome[^"]*"[^>]*\shidden(?:\s|>)/);
        expect(hidden).not.toContain('data-action="reopen-tutorial" hidden');

        const source = read('scripts/welcome-screen.js');
        expect(source).toContain("const tutorialHiddenKey = 'NeconyanTutorialHidden.v1';");
        expect(source).toContain("tutorialHidden: getWelcomeUiPreference(tutorialHiddenKey) === 'true',");
        expect(source).toContain('function setTutorialHidden(welcomePanel, hidden)');
        expect(source).toContain("setWelcomeUiPreference(tutorialHiddenKey, shouldHide ? 'true' : '');");
        expect(source).toContain("case 'hide-tutorial':");
        expect(source).toContain("case 'reopen-tutorial':");
        // The Home layout entry appears only while the tour is hidden.
        expect(source).toContain("panel?.querySelector('[data-action=\"reopen-tutorial\"]')?.toggleAttribute('hidden', !shouldHide);");
        expect(read('css/neconyan.css')).toContain('body.neconyan .welcomeAdvancedHome[hidden] { display: none !important; }');
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
    test('starts Home without creating or importing a character', async () => {
        const handlers = new Map();
        let homeOpened = false;
        let toolsSynced = false;
        const context = vm.createContext({
            PinnedChatsManager: { init() {} }, ensureNeconyanRail() {},
            window: { addEventListener() {} }, concealWelcomeHome() {},
            eventSource: { on: (key, handler) => handlers.set(key, handler), makeFirst() {} },
            event_types: { APP_READY: 'ready' }, getCurrentChatId: () => undefined, chat: [],
            openWelcomeScreen: async () => { homeOpened = true; }, scheduleNeconyanRailRefresh() {},
            syncNeconyanAssistantTools: () => { toolsSynced = true; },
        });
        vm.runInContext(extract('initWelcomeScreen'), context);
        context.initWelcomeScreen();
        await handlers.get('ready')();
        expect(homeOpened).toBe(true);
        expect(toolsSynced).toBe(true);
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
