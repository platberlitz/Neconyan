/* global globalThis */
import { afterAll, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const saveSettingsDebounced = jest.fn();
await jest.unstable_mockModule('../public/script.js', () => ({ saveSettingsDebounced }));

const deviceStorage = new Map();
globalThis.localStorage = {
    get length() { return deviceStorage.size; },
    key: index => [...deviceStorage.keys()][index] ?? null,
    getItem: key => deviceStorage.get(key) ?? null,
    setItem: (key, value) => deviceStorage.set(key, String(value)),
    removeItem: key => deviceStorage.delete(key),
};

const { accountStorage } = await import('../public/scripts/util/AccountStorage.js');
const simpleMode = await import('../public/scripts/neconyan-simple-mode.js');
const {
    SIMPLE_MODE_CLASS, SIMPLE_MODE_EVENT, SIMPLE_MODE_HIDDEN_CHAT_BAR_UNITS, SIMPLE_MODE_HIDDEN_MESSAGE_ACTIONS, SIMPLE_MODE_HIDDEN_PAGE_TABS,
    SIMPLE_MODE_HIDDEN_PAGE_TARGETS, SIMPLE_MODE_HIDDEN_SELECTORS, SIMPLE_MODE_KEPT_ROUTES, SIMPLE_MODE_KEY, SIMPLE_MODE_RAIL_LABELS,
    SIMPLE_MODE_REPEATED_QUICK_ACTIONS,
    applySimpleMode, buildSimpleModeCss, getSimpleModePreference, isSimpleModeEnabled, setSimpleModeEnabled,
} = simpleMode;

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function createFakeDocument() {
    const classes = new Set();
    const nodes = new Map();
    return {
        documentElement: { classList: { toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)), contains: name => classes.has(name) } },
        head: { append: node => nodes.set(node.id, node) },
        getElementById: id => nodes.get(id) ?? null,
        createElement: () => ({ id: '', textContent: '' }),
        nodes,
    };
}

afterAll(() => {
    delete globalThis.localStorage;
    delete globalThis.document;
    delete globalThis.dispatchEvent;
});

describe('Simple Mode preference', () => {
    test('before settings load, the copy on this device decides, and anything unknown counts as off', () => {
        expect(accountStorage.isReady).toBe(false);
        expect(getSimpleModePreference()).toBe('off');
        deviceStorage.set(SIMPLE_MODE_KEY, 'on');
        expect(isSimpleModeEnabled()).toBe(true);
        deviceStorage.set(SIMPLE_MODE_KEY, 'maybe');
        expect(getSimpleModePreference()).toBe('off');
        deviceStorage.delete(SIMPLE_MODE_KEY);
    });

    test('the account choice wins once loaded; asking is not the same as on', () => {
        deviceStorage.set(SIMPLE_MODE_KEY, 'on');
        accountStorage.init({ __migrated: '2', [SIMPLE_MODE_KEY]: 'ask' });
        expect(getSimpleModePreference()).toBe('ask');
        expect(isSimpleModeEnabled()).toBe(false);
    });

    test('turning it on and off saves to the account, mirrors the device copy, flags the page and announces changes once', () => {
        const fakeDocument = createFakeDocument();
        globalThis.document = fakeDocument;
        const events = [];
        globalThis.dispatchEvent = event => events.push(event);

        expect(applySimpleMode()).toBe(false);
        expect(fakeDocument.nodes.get('neconyan-simple-mode-style').textContent).toBe(buildSimpleModeCss());
        expect(deviceStorage.get(SIMPLE_MODE_KEY)).toBe('ask');

        setSimpleModeEnabled(true);
        expect(accountStorage.getItem(SIMPLE_MODE_KEY)).toBe('on');
        expect(deviceStorage.get(SIMPLE_MODE_KEY)).toBe('on');
        expect(fakeDocument.documentElement.classList.contains(SIMPLE_MODE_CLASS)).toBe(true);
        expect(saveSettingsDebounced).toHaveBeenCalled();
        setSimpleModeEnabled(true);
        expect(events.map(event => [event.type, event.detail.enabled])).toEqual([[SIMPLE_MODE_EVENT, true]]);

        setSimpleModeEnabled(false);
        expect(accountStorage.getItem(SIMPLE_MODE_KEY)).toBe('off');
        expect(fakeDocument.documentElement.classList.contains(SIMPLE_MODE_CLASS)).toBe(false);
        expect(events.map(event => event.detail.enabled)).toEqual([true, false]);
        expect(fakeDocument.nodes.size).toBe(1);
    });
});

describe('Simple Mode styles and wiring', () => {
    test('hides power tools only while the page is flagged, and shows the way back only in Simple Mode', () => {
        const css = buildSimpleModeCss();
        expect(css).toContain(`html.${SIMPLE_MODE_CLASS} :is(`);
        for (const selector of SIMPLE_MODE_HIDDEN_SELECTORS) expect(css).toContain(selector);
        expect(css).toContain(`html:not(.${SIMPLE_MODE_CLASS}) .neconyan-rail-simple-exit { display: none !important; }`);
        expect(css).toContain(`html.${SIMPLE_MODE_CLASS} #neconyan-workspace-rail .neconyan-rail-advanced > [data-neconyan-rail-group][hidden]:not([data-neconyan-quick-actions]) { display: block !important; }`);
        expect(css).toContain('#neconyan-tour-coachmark.neconyan-tour-asking :is([data-tour-coach-back], [data-tour-coach-next]) { display: none !important; }');
        expect(css).not.toMatch(/transition|animation/);
        const kept = [
            '"home"', '"characters"', '"model"', '"lorebooks"', '"agents"', '"notes"', '"scratchpad"',
            'data-sb-tab="settings"', '#send_but', '#options_button', '#sb-shortcut-left', '#option_scratchpad', '.sb-bottom-chat-scratchpad',
        ];
        for (const item of kept) {
            expect({ item, hidden: SIMPLE_MODE_HIDDEN_SELECTORS.join(' ').includes(item) }).toEqual({ item, hidden: false });
        }
    });

    test('keeps Presets, Persona, the character search and Workspace pages wherever they sit, and hides the other sidebar pages', () => {
        expect([...SIMPLE_MODE_KEPT_ROUTES]).toEqual(['presets', 'persona', 'botsearcher']);
        expect({ ...SIMPLE_MODE_RAIL_LABELS }).toEqual({ botsearcher: 'Find characters' });
        expect(SIMPLE_MODE_HIDDEN_SELECTORS).toContain('#neconyan-workspace-rail .neconyan-rail-advanced > .neconyan-rail-section-heading:not(#neconyan-rail-quick-actions-title)');
        expect(SIMPLE_MODE_HIDDEN_SELECTORS).not.toContain('#neconyan-workspace-rail .neconyan-rail-advanced > [data-neconyan-quick-actions]');
        expect(SIMPLE_MODE_HIDDEN_SELECTORS).toContain('#neconyan-workspace-rail .neconyan-rail-button[data-neconyan-rail-home]:not([data-neconyan-rail-home="primary"], [data-neconyan-rail-home="modes"], [data-neconyan-route="presets"], [data-neconyan-route="persona"], [data-neconyan-route="botsearcher"])');
        expect(SIMPLE_MODE_HIDDEN_SELECTORS).toContain('#neconyan-workspace-rail .neconyan-rail-button[data-neconyan-rail-home="primary"][data-neconyan-route="mewmory"]');
        expect(SIMPLE_MODE_HIDDEN_SELECTORS.join(' ')).not.toContain('[data-neconyan-primary-nav]');
        const welcome = read('public/scripts/welcome-screen.js');
        expect(welcome).toContain('<section class="neconyan-rail-advanced neconyan-rail-fine-tuning" aria-labelledby="neconyan-rail-advanced-title">');
        expect(welcome).toMatch(/<div data-neconyan-finer-nav><\/div>\s*<\/section>\s*<div class="neconyan-rail-simple-exit" data-neconyan-simple-exit><\/div>/);
        expect(welcome).toContain('const next = simple ? translate(simpleLabel) : button.dataset.neconyanRailFullLabel;');
        expect(welcome).toContain('new MutationObserver(syncNeconyanRailSimpleLabels).observe(document.documentElement, { attributes: true, attributeFilter: [\'class\'] });');
        expect(welcome).toMatch(/const SIMPLE_TUTORIAL_STEPS = Object\.freeze\(\[\s*WELCOME_TUTORIAL_STEPS\[0\],\s*WELCOME_TUTORIAL_STEPS\[1\],\s*WELCOME_TUTORIAL_STEPS\[3\],\s*WELCOME_TUTORIAL_STEPS\[4\],\s*WELCOME_TUTORIAL_STEPS\[6\],/);
    });

    test('the Connections page is the same form, shortened to provider, key, model, Connect and Test', () => {
        const workspaces = read('public/scripts/neconyan-native-workspaces.js');
        expect(workspaces).toContain('const SIMPLE_CONNECTION_PROVIDERS = Object.freeze([\'openrouter\', \'openai\', \'claude\', \'makersuite\', \'deepseek\', \'custom\']);');
        expect(workspaces).toContain('value === \'custom\' ? t`Proxy or other` : \'\'');
        // A provider saved earlier is never dropped from the list, and other reply formats keep the full page.
        expect(workspaces).toContain('option.hidden = short && !SIMPLE_CONNECTION_PROVIDERS.includes(option.value) && option.value !== provider.value;');
        expect(workspaces).toContain('&& api.querySelector(\'#main_api\')?.value === \'openai\';');
        expect(workspaces).toContain('api.classList.toggle(\'neconyan-connections-short\', short);');
        expect(workspaces).toContain('if (short && signIn.previousElementSibling !== keyRow) keyRow.after(signIn);');
        expect(workspaces).toMatch(/organizeConnectionActions\(api\);\s*syncSimpleConnections\(api\);\s*watchSimpleConnections\(\);/);

        const css = read('public/css/neconyan-first-run.css').replace(/\/\*[\s\S]*?\*\//g, '');
        const hidden = css.match(/([^{}]*)\{\s*display: none !important;\s*\}/)[1];
        for (const selector of ['.neconyan-model-saved', '#main-API-selector-block', '#prompt_post_processing_form', '.neconyan-provider-help',
            '.neconyan-provider-model > [data-neconyan-simple-extra]', '.neconyan-connection-tools > summary']) {
            expect(hidden).toContain(`#rm_api_block.neconyan-connections-short ${selector}`);
        }
        // Nothing is hidden unless the short page is on, so the full interface is untouched.
        for (const line of hidden.split(',')) expect(line).toContain('.neconyan-connections-short');

        const openai = read('public/scripts/openai.js');
        expect(openai).toContain('toastr.warning(t`Paste your API key into the key box first, then press Connect.`);');
        expect(openai).toContain('showResult(t`Test passed: the model replied.`, \'success\');');
        expect(openai).toContain('showResult(t`Test failed: no reply came back. Check the key and the model, then try again.`, \'error\');');
    });

    test('pages, menu items and chat bar extras a newcomer does not need are tucked away, and nothing strands them', () => {
        expect(SIMPLE_MODE_HIDDEN_PAGE_TABS).toEqual(['sampling', 'advanced-formatting', 'mewmory']);
        expect(SIMPLE_MODE_HIDDEN_PAGE_TARGETS).toEqual(['left:sampling', 'left:advanced-formatting', 'left:mewmory', 'left:extensions']);
        expect(SIMPLE_MODE_REPEATED_QUICK_ACTIONS).toEqual(['left:presets', 'left:api', 'left:agents', 'characters:world-info']);
        expect(SIMPLE_MODE_HIDDEN_CHAT_BAR_UNITS).toEqual(['scroll', 'files', 'rename', 'hideBar']);
        // Memory Shard hides messages, so the way to show one again has to stay.
        expect(SIMPLE_MODE_HIDDEN_MESSAGE_ACTIONS).not.toContain('mes_hide');
        expect(SIMPLE_MODE_HIDDEN_MESSAGE_ACTIONS).not.toContain('mes_unhide');
        for (const kept of ['mes_translate', 'mes_narrate', 'mes_create_branch', 'mes_screenshot', 'mes_save_note', 'mes_fix_trackers', 'mes_rerun_agents']) {
            expect(SIMPLE_MODE_HIDDEN_MESSAGE_ACTIONS).not.toContain(kept);
        }

        const index = read('public/index.html');
        for (const action of SIMPLE_MODE_HIDDEN_MESSAGE_ACTIONS.filter(name => name.startsWith('mes_'))) expect(index).toContain(`mes_button ${action} `);
        expect(read('public/scripts/extensions/quick-image-gen/index.js')).toContain('qig-message-generate');
        expect(index).toContain('data-i18n="[title]Show media as a list"');
        expect(index).toContain('data-i18n="[title]Show media as a gallery"');
        expect(index).not.toContain('Toggle media display style');

        for (const selector of [
            '.sb-shell-tab[data-sb-tab="sampling"]', '.sb-shell-tab[data-sb-tab="advanced-formatting"]', '.sb-shell-tab[data-sb-tab="mewmory"]',
            '#sb_character_tab_groups', '#sb_character_tab_creator', '#sbca_drawer_button',
            '#chat .mes_embed', '#chat .mes_create_bookmark', '#chat .qig-message-generate',
            '[data-sb-bottom-unit="files"]', '[data-sb-bottom-unit="rename"]', '[data-sb-bottom-unit="hideBar"]', '[data-sb-bottom-unit="scroll"]',
            '#neconyan-workspace-rail [data-neconyan-quick-target="tab::characters::world-info"]',
            '#neconyan-workspace-rail [data-neconyan-quick-target="tab::left::sampling"]',
            '[data-sb-shortcut-target="left:mewmory"]',
            '#result_info_text', '#rm_ch_create_block .extension_token_counter', '#sb_character_open_creator', '#sb_character_editor_tab_metadata',
        ]) expect(SIMPLE_MODE_HIDDEN_SELECTORS).toContain(selector);
        // Agents, the summary panel and shortcuts people add themselves stay.
        const joined = SIMPLE_MODE_HIDDEN_SELECTORS.join('\n');
        for (const kept of ['ica--tracker-panel', 'left:agents"]', 'action:search', 'characters::creator', 'sb-shortcut-left']) expect(joined).not.toContain(kept);

        const css = buildSimpleModeCss();
        expect(css).toContain('[data-neconyan-quick-actions]:not(:has(> button:not(');
        expect(css).toContain('> [data-neconyan-quick-actions-tucked] { display: block !important; }');

        const tabs = read('public/scripts/neconyan-tabs.js');
        expect(tabs).toContain('button.dataset.neconyanQuickTarget = getMobileQuickActionKey(action);');
        expect(tabs).toContain('node.dataset.sbBottomUnit = unit.id;');
        expect(tabs).toContain('button.dataset.sbShortcutTarget = target;');
        expect(tabs).toContain('data-neconyan-quick-actions-tucked');
        expect(tabs).toContain('Pin your favourite pages here with the pen.');
        expect(tabs).toMatch(/else if \(shellKey === 'left' && isSimpleModeEnabled\(\) && SIMPLE_MODE_HIDDEN_PAGE_TABS\.includes\(shellState\.activeTabId\)\) \{\n\s+\/\/[^\n]+\n\s+setActiveTab\(shellKey, 'api'\);/);
        expect(tabs).toContain('const lastTab = isSimpleModeEnabled() && [\'creator\', \'groups\'].includes(rememberedTab) ? \'characters\' : rememberedTab;');
        expect(tabs).toContain('getComputedStyle(tab).display !== \'none\'');
        expect(tabs.match(/isTabDisplayed/g)).toHaveLength(4);
    });

    test('every hidden id still exists, so a rename cannot silently bring a power tool back', () => {
        const sources = [
            'public/index.html', 'public/scripts/neconyan-tabs.js', 'public/scripts/welcome-screen.js',
            'public/scripts/extensions/quick-image-gen/index.js', 'public/scripts/extensions/guided-generations/index.js',
            'public/scripts/extensions/neconyan-chats-archive/index.js',
        ].map(path => { try { return read(path); } catch { return ''; } }).join('\n');
        const ids = SIMPLE_MODE_HIDDEN_SELECTORS.join(' ').match(/#[\w-]+/g).map(id => id.slice(1));
        for (const id of new Set(ids)) expect({ id, found: sources.includes(id) }).toEqual({ id, found: true });
    });

    test('new profiles are asked, existing profiles keep every feature', () => {
        const defaults = JSON.parse(read('default/content/settings.json'));
        expect(defaults.accountStorage[SIMPLE_MODE_KEY]).toBe('ask');
    });

    test('Settings → Appearance carries the switch and the rail carries the way back', () => {
        const tabs = read('public/scripts/neconyan-tabs.js');
        expect(tabs).toContain('id: \'sb-simple-mode-drawer\'');
        expect(tabs).toContain('onChange: input => setSimpleModeEnabled(input.checked)');
        expect(tabs).toContain('const themeSettingsDrawers = [simpleModeSettingsGroup,');
        expect(tabs).toContain('window.addEventListener(SIMPLE_MODE_EVENT, updateThemePickerUi);');
        const welcome = read('public/scripts/welcome-screen.js');
        expect(welcome).toContain('data-neconyan-simple-exit');
        expect(welcome).toContain('label: \'Show all features\'');
        expect(welcome).toContain('showTutorialCoachmark({ askSimpleMode: getSimpleModePreference() === \'ask\', askAssistants: meetAssistants });');
    });

    test('memory looks after itself: new accounts start with Memory Shard on and Simple Mode shows one Memory button', () => {
        const defaults = JSON.parse(read('default/content/settings.json'));
        expect(defaults.accountStorage['NeconyanMemoryShardSeed.v1']).toBe('on');

        const agents = read('public/scripts/extensions/in-chat-agents/index.js');
        expect(agents).toContain('const MEMORY_SHARD_SEED_KEY = \'NeconyanMemoryShardSeed.v1\';');
        expect(agents).toMatch(/await ensureDefaultBundledAgents\(\);\s+await seedMemoryShardForNewAccount\(\);/);
        expect(agents).toContain('if (accountStorage.getItem(MEMORY_SHARD_SEED_KEY) !== \'on\') return;');
        // An account that already made its own Memory Shard keeps the state it chose.
        expect(agents).toContain('if (!had) await saveAgentEnabledState([agent.id], true);');
        expect(agents).toContain('neconyanAgents.memoryShard = {');

        const welcome = read('public/scripts/welcome-screen.js');
        expect(welcome).toContain('simpleMemory.dataset.neconyanSimpleMemory = \'true\';');
        // The button shares the container that is hidden outside Simple Mode.
        expect(welcome).toContain('rail.querySelector(\'[data-neconyan-simple-exit]\')?.append(simpleMemory, simpleExit);');
        expect(welcome).toContain('When a chat gets long, the LLM writes down what happened so your character does not forget.');
        expect(welcome).toContain('globalThis.NeconyanShell?.openTab?.(\'left\', \'mewmory\')');

        const runner = read('public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        expect(runner).toContain('{ keepInMewmory: true }');
    });
});
