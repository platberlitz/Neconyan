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
    SIMPLE_MODE_CLASS, SIMPLE_MODE_EVENT, SIMPLE_MODE_HIDDEN_SELECTORS, SIMPLE_MODE_KEPT_ROUTES, SIMPLE_MODE_KEY, SIMPLE_MODE_RAIL_LABELS,
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

    test('every hidden id still exists, so a rename cannot silently bring a power tool back', () => {
        const sources = [
            'public/index.html', 'public/scripts/neconyan-tabs.js', 'public/scripts/welcome-screen.js',
            'public/scripts/extensions/quick-image-gen/index.js', 'public/scripts/extensions/guided-generations/index.js',
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
