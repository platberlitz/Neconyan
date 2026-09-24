import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function extractFunction(source, name) {
    let start = source.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Could not find ${name}`);
    if (source.slice(start - 6, start) === 'async ') start -= 6;

    const signatureEnd = source.indexOf(') {', start);
    const bodyStart = source.indexOf('{', signatureEnd);
    let depth = 0;
    let opened = false;
    for (let index = bodyStart; index < source.length; index++) {
        if (source[index] === '{') {
            opened = true;
            depth++;
        } else if (source[index] === '}' && opened && --depth === 0) {
            return source.slice(start, index + 1);
        }
    }

    throw new Error(`Could not finish ${name}`);
}

const worldInfoSource = readFileSync(new URL('../public/scripts/world-info.js', import.meta.url), 'utf8');
const personaSource = readFileSync(new URL('../public/scripts/personas.js', import.meta.url), 'utf8');
const scriptSource = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');

describe('Lorebook control actions', () => {
    test('clearing selection disables old entry tools and clears the count', async () => {
        let summaryCleared = false;
        const control = {
            handlers: ['previous book'], disabled: false,
            prop(_, value) { this.disabled = value; return this; },
            off() { this.handlers = []; return this; },
            html() { return this; },
        };
        const context = vm.createContext({
            $: () => control, navigation_option: { none: 0 }, desktopSelectedWorldInfoUid: null,
            getWorldInfoDesktopEditorElements: () => ({ workspace: {}, host: control }),
            isWorldInfoDesktopSplitLayout: () => false, syncWorldInfoDesktopEditorPopout() {},
            clearEntryList() {}, clearWorldInfoDesktopEditor() {}, updateWorldInfoWorkspaceState() {}, setWorldInfoDesktopEditorPopout() {},
            updateWorldInfoResultsSummary: () => { summaryCleared = true; },
            createEntryFolderUI: () => null,
        });
        vm.runInContext(extractFunction(worldInfoSource, 'displayWorldEntries'), context);
        await context.displayWorldEntries(null, null);
        expect(control.handlers).toEqual([]);
        expect(control.disabled).toBe(true);
        expect(summaryCleared).toBe(true);
    });

    test('Expand and Collapse work when their label or icon is clicked', async () => {
        class HTMLElement {
            constructor(id) { this.id = id; }
            closest(selector) { return selector === this.id ? {} : null; }
        }
        const start = scriptSource.lastIndexOf('document.addEventListener(\'click\', function (e) {', scriptSource.indexOf('e.target.closest(\'#OpenAllWIEntries\')'));
        const end = scriptSource.indexOf('\n    });', start);
        const expression = scriptSource.slice(start, end + 6).replace('document.addEventListener(\'click\', ', '');
        const calls = [];
        const drawers = [{ id: 1 }, { id: 2 }];
        const handler = vm.runInNewContext(`(${expression})`, {
            HTMLElement, document: { querySelectorAll: () => drawers }, delay: async () => {},
            toggleDrawer: (drawer, open) => calls.push([drawer.id, open]),
        });
        handler({ target: new HTMLElement('#OpenAllWIEntries') });
        await Promise.resolve();
        handler({ target: new HTMLElement('#CloseAllWIEntries') });
        expect(calls).toEqual([[1, true], [2, true], [1, false], [2, false]]);
    });

    test('enabling a legacy probability saves its default and original-data mirror together', async () => {
        let onInput;
        let checked = false;
        let shownValue;
        const toggle = {
            data: () => 7,
            on: (_, callback) => { onInput = callback; },
            prop: (_, value) => value === undefined ? checked : (checked = value),
        };
        const data = { entries: { 7: { uid: 7, probability: null, useProbability: false } } };
        const mirrors = {};
        let saved;
        const context = vm.createContext({
            $: value => value,
            setWIOriginalDataValue: (_, uid, path, value) => { mirrors[path] = value; },
            saveWorldInfo: async (_, value) => { saved = { data: structuredClone(value), mirrors: { ...mirrors } }; },
        });
        vm.runInContext(extractFunction(worldInfoSource, 'handleProbabilityToggleHelper'), context);
        context.handleProbabilityToggleHelper({
            probabilityToggle: toggle, data, entry: data.entries[7], name: 'Legacy',
            probabilityInput: { val: value => { shownValue = value; } },
            probabilityContainer: { length: 1, show() {}, hide() {} },
        });
        checked = true;
        await onInput.call(toggle);
        expect(shownValue).toBe(100);
        expect(saved.data.entries[7]).toMatchObject({ probability: 100, useProbability: true });
        expect(saved.mirrors).toEqual({ 'extensions.useProbability': true, 'extensions.probability': 100 });
    });
});

describe('Persona lorebook links', () => {
    test('deleting the active linked book refreshes the controls and missing links cannot be opened', async () => {
        const controls = new Map();
        const control = selector => {
            if (!controls.has(selector)) {
                controls.set(selector, {
                    label: '', disabled: false,
                    text(value) { this.label = value; return this; },
                    prop(_, value) { this.disabled = value; return this; },
                    attr() { return this; }, trigger() { return this; }, toggleClass() { return this; }, val: () => '',
                });
            }
            return controls.get(selector);
        };
        const context = vm.createContext({
            $: control, world_names: ['Notes'], user_avatar: 'active.png',
            power_user: { personas: { 'active.png': 'Active', 'other.png': 'Other' }, persona_description_lorebook: 'Notes', persona_descriptions: { 'active.png': { lorebook: 'Notes' }, 'other.png': { lorebook: 'Notes' } } },
            t: (parts, ...values) => parts.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
            getRequestHeaders: () => ({}), fetch: async () => ({ ok: true }),
            blockWorldInfoSaves: () => () => {}, settleWorldInfoSave: async () => {}, invalidateWorldInfoCache() {},
            worldInfoCommittedEntryInstances: new Map(), worldInfoEditor: null, selected_world_info: [], saveSettingsDebounced() {},
            updateNeconyanLorebookFolders: async () => {},
            eventSource: { emit: async () => {} }, event_types: { WORLDINFO_DELETED: 'deleted' },
        });
        context.updateWorldInfoList = async () => { context.world_names.length = 0; };
        context.getOrCreatePersonaDescriptor = () => context.power_user.persona_descriptions[context.user_avatar];
        vm.runInContext(extractFunction(personaSource, 'updatePersonaLorebookActions'), context);
        context.setPersonaDescription = () => context.updatePersonaLorebookActions();
        vm.runInContext(extractFunction(worldInfoSource, 'deleteWorldInfo'), context);
        context.world_names = undefined;
        context.updatePersonaLorebookActions();
        expect(control('#persona_lore_status').label).toBe('Loading lorebooks...');
        expect(control('#persona_lore_open_button').disabled).toBe(true);
        expect(control('#persona_lore_choose_button').disabled).toBe(true);
        context.world_names = ['Notes'];
        context.updatePersonaLorebookActions();
        expect(control('#persona_lore_open_button').disabled).toBe(false);
        expect(control('#persona_lore_choose_button').disabled).toBe(false);
        await context.deleteWorldInfo('Notes');
        expect(control('#persona_lore_status').label).toBe('None');
        expect(control('#persona_lore_open_button').disabled).toBe(true);
        context.user_avatar = 'other.png';
        context.updatePersonaLorebookActions();
        expect(control('#persona_lore_status').label).toBe('Missing: Notes');
        expect(control('#persona_lore_open_button').disabled).toBe(true);
    });
});

describe('Lorebook workspace state', () => {
    const stateSource = extractFunction(worldInfoSource, 'getWorldInfoWorkspaceState');
    const context = vm.createContext({});
    vm.runInContext(stateSource, context);

    test('returns a distinct state for each empty or filtered workspace', () => {
        expect(context.getWorldInfoWorkspaceState({ libraryCount: 0 }).kind).toBe('library-empty');
        expect(context.getWorldInfoWorkspaceState({ libraryCount: 2 }).kind).toBe('no-selection');
        expect(context.getWorldInfoWorkspaceState({ libraryCount: 2, selectedName: 'Notes', totalEntries: 0 }).kind).toBe('book-empty');
        expect(context.getWorldInfoWorkspaceState({ libraryCount: 2, selectedName: 'Notes', totalEntries: 2, filteredEntries: 0 }).kind).toBe('filtered-empty');
        expect(context.getWorldInfoWorkspaceState({ libraryCount: 2, selectedName: 'Notes', totalEntries: 2, filteredEntries: 1 }).kind).toBe('entries');
    });
});

describe('Embedded Persona panel visibility', () => {
    test('recognises the managed panel and keeps the old drawer fallback', () => {
        class HTMLElement {}
        const embedded = new HTMLElement();
        embedded.hidden = false;
        embedded.getClientRects = () => [{}];
        const legacy = new HTMLElement();
        legacy.classList = { contains: () => false };
        legacy.getClientRects = () => [{}];
        const context = vm.createContext({
            HTMLElement,
            document: {
                querySelector: selector => selector.includes('#right-nav-panel') ? embedded : null,
                getElementById: () => legacy,
            },
        });
        vm.runInContext(extractFunction(personaSource, 'isPersonaPanelOpen'), context);
        expect(context.isPersonaPanelOpen()).toBe(true);

        embedded.hidden = true;
        expect(context.isPersonaPanelOpen()).toBe(false);

        context.document.querySelector = () => null;
        legacy.classList = { contains: className => className === 'openDrawer' };
        expect(context.isPersonaPanelOpen()).toBe(true);
    });
});
