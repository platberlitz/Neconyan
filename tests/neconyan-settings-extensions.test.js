import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(repoRoot, 'public', 'scripts', 'neconyan-settings-tabs.js'), 'utf8');
const shellSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'neconyan-tabs.js'), 'utf8');
const cssSource = readFileSync(path.join(repoRoot, 'public', 'css', 'neconyan.css'), 'utf8');

function getFunctionSource(name) {
    return source.match(new RegExp(`^    function ${name}\\([\\s\\S]*?^    }`, 'm'))?.[0] ?? '';
}

describe('Neconyan settings and extension controllers', () => {
    test('keeps only populated extension units and ignores non-settings script nodes', () => {
        class HTMLElement {
            constructor(tagName, text = '', children = []) {
                this.tagName = tagName;
                this.textContent = text;
                this.children = children;
                this.classList = { contains: () => false };
            }
        }

        const host = new HTMLElement('DIV', '', [
            new HTMLElement('DIV'),
            new HTMLElement('DIV', '', [new HTMLElement('LABEL')]),
            new HTMLElement('SCRIPT', 'late script'),
            new HTMLElement('STYLE', 'late style'),
            new HTMLElement('DIV', 'direct extension'),
        ]);
        host.children[0].classList = { contains: name => name === 'extension_container' };
        host.children[1].classList = { contains: name => name === 'extension_container' };

        const context = vm.createContext({ HTMLElement });
        vm.runInContext(`globalThis.getExtensionSettingsUnits = ${getFunctionSource('getExtensionSettingsUnits')}`, context);
        const units = context.getExtensionSettingsUnits(host);

        expect(units).toEqual([host.children[1], host.children[4]]);
    });

    test('uses exact existing extension ids and per-node session keys without mutating metadata', () => {
        const helperStart = source.indexOf('    const extensionUnitSessionKeys = new WeakMap();');
        const helperEnd = source.indexOf('    function getExtensionUnitSearchText', helperStart);
        const helperSource = source.slice(helperStart, helperEnd);
        const context = vm.createContext({});
        vm.runInContext(helperSource, context);

        const metadata = { 'data-extension-id': 'vendor.Alpha_v1' };
        const existing = { id: 'alpha_container', getAttribute: name => metadata[name] || null };
        expect(context.getExtensionUnitId(existing)).toBe('id:alpha_container');
        expect(metadata['data-extension-id']).toBe('vendor.Alpha_v1');
        const sibling = { id: 'alpha_extra', getAttribute: name => metadata[name] || null };
        expect(context.getExtensionUnitId(sibling)).not.toBe(context.getExtensionUnitId(existing));
        const anonymous = { id: '', getAttribute: name => metadata[name] || null };
        const otherAnonymous = { id: '', getAttribute: name => metadata[name] || null };
        expect(context.getExtensionUnitId(anonymous)).not.toBe(context.getExtensionUnitId(otherAnonymous));

        const sessionUnit = { id: '', getAttribute: () => null };
        expect(context.getExtensionUnitId(sessionUnit)).toBe(context.getExtensionUnitId(sessionUnit));
        expect(context.getExtensionUnitId({ id: '', getAttribute: () => null })).not.toBe(context.getExtensionUnitId(sessionUnit));
    });

    test('uses nested extension headers before field headings', () => {
        const title = { textContent: 'Character Expressions' };
        const header = { querySelector: () => title };
        const unit = {
            dataset: {}, id: 'expressions_container', getAttribute: () => null,
            querySelector: selector => selector.includes('inline-drawer-header') ? header
                : selector === '.extension_name' ? null : { textContent: 'Sprite set:' },
        };
        const context = vm.createContext({ titleCaseExtensionId: value => value });
        vm.runInContext(getFunctionSource('getExtensionUnitLabel'), context);
        expect(context.getExtensionUnitLabel(unit)).toBe('Character Expressions');
        unit.dataset.extensionName = 'Neconyan-Story-Mode';
        title.textContent = 'Story Mode';
        expect(context.getExtensionUnitLabel(unit)).toBe('Story Mode');
        expect(unit.dataset.extensionName).toBe('Neconyan-Story-Mode');
    });

    test('hides included built-ins while retaining same-named third-party groups and routing both targets', () => {
        const helperNames = [
            'normalizeExtensionLookup',
            'getExtensionUnitCandidates',
            'normalizeIncludedToolLookup',
            'getNeconyanNativeToolDefinitions',
            'getIncludedToolDefinition',
            'getVisibleExtensionGroups',
            'findExtensionGroupForLabel',
            'findExtensionGroupForTarget',
            'openIncludedToolSettings',
        ];
        const opened = [];
        const context = vm.createContext({
            normalizeSettingsSearchText: value => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase(),
            getExtensionUnitId: unit => unit.id,
            NeconyanNativeTools: {
                getDefinitions: () => [
                    { id: 'third-party/sillytavern-character-colors', label: 'Dialogue Colors' },
                    { id: 'third-party/Neconyan-Time-Machine', label: 'Card & Lorebook Time Machine' },
                ],
                openSettings: definition => opened.push(definition),
            },
        });
        context.globalThis = context;
        vm.runInContext(helperNames.map(getFunctionSource).join('\n'), context);

        const includedTarget = {};
        const includedUnit = {
            id: 'dialogue-colors-container',
            dataset: { extensionName: 'third-party/sillytavern-character-colors' },
            contains: target => target === includedTarget,
        };
        const thirdPartyUnit = {
            id: 'custom-dialogue-colors-container',
            dataset: { extensionName: 'third-party/custom-dialogue-colors' },
            contains: target => target === thirdPartyUnit,
        };
        const groups = [
            { scope: 'built-in', name: 'Dialogue Colors', searchText: 'dialogue colors settings', units: [includedUnit] },
            { scope: 'third-party', name: 'Dialogue Colors', searchText: 'dialogue colors custom', units: [thirdPartyUnit] },
            { scope: 'built-in', name: 'TTS', searchText: 'tts text to speech', units: [] },
            { scope: 'built-in', name: 'Time Machine', searchText: 'time machine', units: [{ id: 'sbctm-settings-drawer' }] },
        ];

        expect(context.getVisibleExtensionGroups(groups, 'built-in')).toEqual([groups[2]]);
        expect(context.getVisibleExtensionGroups(groups, 'third-party')).toEqual([groups[1]]);
        expect(groups[0].units).toEqual([includedUnit]);

        const focused = context.findExtensionGroupForLabel(groups, 'Dialogue Colors');
        expect(context.openIncludedToolSettings(focused)).toBe(true);
        const revealed = context.findExtensionGroupForTarget(groups, includedTarget);
        expect(context.openIncludedToolSettings(revealed)).toBe(true);
        expect(opened).toHaveLength(2);
        expect(opened.every(definition => definition.label === 'Dialogue Colors')).toBe(true);
        expect(context.getIncludedToolDefinition(groups[1])).toBeNull();
        expect(context.getIncludedToolDefinition(groups[3]).id).toBe('third-party/Neconyan-Time-Machine');
    });

    test('excludes generated ARIA panels from existing drawer persistence keys', () => {
        class HTMLElement {
            constructor(id, panel = false) {
                this.id = id;
                this.classList = { contains: name => panel && name === 'sb-shell-panel' };
            }
        }
        const method = shellSource.match(/^function getInlineDrawerContextSegment\([\s\S]*?^}/m)[0];
        const context = vm.createContext({ HTMLElement, sanitizeInlineDrawerStorageSegment: value => value });
        vm.runInContext(method, context);
        expect(context.getInlineDrawerContextSegment(new HTMLElement('sb-shell-panel-right-settings', true))).toBe('');
        expect(context.getInlineDrawerContextSegment(new HTMLElement('user-settings-block'))).toBe('id:user-settings-block');
    });

    test('gives grouped search results unique ids for keyboard selection', () => {
        class HTMLElement {
            constructor(_tag, options = {}) {
                this.children = [];
                this.className = options.className;
                this.id = options.attrs?.id;
                this.classList = { add() {}, remove() {} };
            }
            appendChild(child) { this.children.push(child); }
            replaceChildren() { this.children = []; }
            addEventListener() {}
            get childElementCount() { return this.children.length; }
            querySelectorAll() {
                return this.children.flatMap(child => [child, ...child.querySelectorAll()])
                    .filter(child => child.className === 'sb-search-result');
            }
            querySelector() { return this.querySelectorAll()[0]; }
        }
        const results = new HTMLElement();
        const matches = ['Font', 'Colour', 'Provider'].map((displayText, index) => ({
            shellLabel: 'Settings', tabLabel: ['Appearance', 'Appearance', 'Extensions'][index],
            sectionLabel: 'Controls', displayText,
        }));
        const context = vm.createContext({
            HTMLElement, getUniversalSearchState: () => ({ results, expanded: true }),
            collectGlobalSearchMatches: () => matches,
            createElement: (tag, options) => new HTMLElement(tag, options),
            normalizeText: value => value, setUniversalSearchActiveIndex() {},
        });
        vm.runInContext(shellSource.match(/^function renderUniversalSearchResults\([\s\S]*?^}/m)[0], context);
        context.renderUniversalSearchResults('test');
        expect(results.querySelectorAll().map(button => button.id)).toEqual([
            'sb-search-result-0', 'sb-search-result-1', 'sb-search-result-2',
        ]);
    });

    test('keeps generated navigators out of the global search index and provides mobile selectors', () => {
        expect(shellSource).toContain('[data-sb-search-index-ignore]');
        expect(source).toContain('className = \'sb-settings-category-select\';');
        expect(source).toContain('className = \'sb-extensions-select\';');
        expect(source).toContain('block.insertBefore(layout, firstHost);');
        expect(source).toContain('No third-party extensions installed. Use Install extension to add one.');
        expect(source).toContain('resetThirdParty: () => state.setScope(\'third-party\')');
        expect(source).toContain('state.setScope(\'built-in\')');
        expect(cssSource).toContain('grid-template-columns: minmax(180px, 200px) minmax(0, 1fr);');
        expect(cssSource).toContain('body.neconyan .sb-extensions-layout {\n    grid-template-columns: minmax(0, 1fr);\n}');
        expect(cssSource).toContain('body.neconyan .sb-extensions-layout [hidden]');
    });

    test('persists pinned extension keys and keeps pin controls beside reusable selection buttons', () => {
        const values = new Map();
        const context = vm.createContext({ accountStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) } });
        vm.runInContext(`const extensionPinsStorageKey = 'NeconyanPinnedExtensions.v1';\n${getFunctionSource('readPinnedExtensionKeys')}\n${getFunctionSource('writePinnedExtensionKeys')}`, context);
        context.writePinnedExtensionKeys(new Set(['built-in:alpha', 'third-party:beta']));
        expect([...context.readPinnedExtensionKeys()]).toEqual(['built-in:alpha', 'third-party:beta']);
        values.set('NeconyanPinnedExtensions.v1', '[null, 7, "", "  built-in:alpha  "]');
        expect([...context.readPinnedExtensionKeys()]).toEqual(['built-in:alpha']);
        values.set('NeconyanPinnedExtensions.v1', '{broken');
        expect([...context.readPinnedExtensionKeys()]).toEqual([]);
        expect(source).toContain('row.className = \'sb-extension-master-row\';');
        expect(source).toContain('pin.className = \'sb-extension-pin\';');
        // Both states are whole phrases for the translator, and the extension name is passed through unchanged.
        expect(source).toContain('import { t } from \'./i18n.js\';');
        expect(source).toContain('const label = pinned ? t`Unpin ${info.name}` : t`Pin ${info.name}`;');
        expect(source).toContain('pin.setAttribute(\'aria-label\', state.pinnedKeys.has(info.key) ? t`Unpin ${info.name}` : t`Pin ${info.name}`);');
        expect(source).toContain('state.selectedKey && selectedPinned ? t`Unpin selected extension` : t`Pin selected extension`');
        expect(source).toContain('state.mountedUnits');
        expect(cssSource).toContain('.sb-extension-master-row');
        expect(cssSource).toContain('.sb-extension-pin');
    });

    test('routes included tool settings to a dedicated shell page', () => {
        expect(shellSource).toContain('id: \'included-tool\'');
        expect(shellSource).toContain('function buildIncludedToolPanel()');
        expect(shellSource).toContain('openShell(\'right\', \'included-tool\')');
        expect(shellSource).toContain('restoreMountedUnits');
    });
});
