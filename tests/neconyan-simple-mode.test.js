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
    SIMPLE_MODE_CLASS, SIMPLE_MODE_EVENT, SIMPLE_MODE_HIDDEN_SELECTORS, SIMPLE_MODE_KEY,
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
        expect(css).toContain(`html.${SIMPLE_MODE_CLASS} body.neconyan #sb-topbar-inner #sb-shortcut-left { display: none !important; }`);
        expect(css).toContain('#neconyan-tour-coachmark.neconyan-tour-asking :is([data-tour-coach-back], [data-tour-coach-next]) { display: none !important; }');
        expect(css).not.toMatch(/transition|animation/);
        for (const kept of ['"home"', '"characters"', '"model"', 'data-sb-tab="settings"', '#send_but', '#options_button']) {
            expect(SIMPLE_MODE_HIDDEN_SELECTORS.join(' ')).not.toContain(kept);
        }
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
        expect(welcome).toContain('showTutorialCoachmark({ askSimpleMode: getSimpleModePreference() === \'ask\' });');
    });
});
