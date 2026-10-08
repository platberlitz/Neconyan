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

// A drawer as the real page presents it in a translated interface: the id the extension writes
// into its markup, no data-extension-name, and a `matches` that compares the selector.
function createDrawerUnit(id, { matchesThrows = false } = {}) {
    return {
        id,
        dataset: {},
        getAttribute: () => null,
        matches: selector => {
            if (matchesThrows) {
                throw new SyntaxError(`'${selector}' is not a valid selector`);
            }
            return selector === `#${id}`;
        },
    };
}

function createExtensionGroup(scope, name, ...units) {
    return { scope, name, searchText: name.toLowerCase(), units };
}

// A missing function becomes empty source, so naming one that only exists after the change does
// not stop the old code from loading.
function createToolLookupContext(helperNames, definitions) {
    const context = vm.createContext({
        normalizeSettingsSearchText: value => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase(),
        getExtensionUnitId: unit => unit.id,
        NeconyanNativeTools: { getDefinitions: () => definitions },
    });
    context.globalThis = context;
    vm.runInContext(helperNames.map(getFunctionSource).join('\n'), context);
    return context;
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
            'unitMatchesSelector',
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

    // Jest stops a test at its first failed assertion, so each defect assertion has a test of its own:
    // one run on the old code then shows every one of them.
    describe('treats a translated drawer with a declared selector as an included tool', () => {
        const dialogueColors = { id: 'third-party/sillytavern-character-colors', label: 'Dialogue Colors', unit: '#dc-ext' };
        const timeMachine = { id: 'third-party/Neconyan-Time-Machine', label: 'Card & Lorebook Time Machine', unit: '#sbctm-settings-drawer' };
        // Only functions that exist before and after the change, plus the guard the change adds.
        const context = createToolLookupContext([
            'normalizeExtensionLookup',
            'getExtensionUnitCandidates',
            'normalizeIncludedToolLookup',
            'getNeconyanNativeToolDefinitions',
            'unitMatchesSelector',
            'getIncludedToolDefinition',
            'getVisibleExtensionGroups',
        ], [dialogueColors, timeMachine]);

        // The headings are translated, so neither the label nor the id can be read from them.
        const portugueseColours = createExtensionGroup('built-in', 'Cores de diálogo', createDrawerUnit('dc-ext'));
        const germanTimeMachine = createExtensionGroup('built-in', 'Zeitmaschine', createDrawerUnit('sbctm-settings-drawer'));
        const portugueseQuickReply = createExtensionGroup('built-in', 'Resposta rápida', createDrawerUnit('qr_container'));

        // Defect: the old code compares the translated heading and returns null.
        test('finds Dialogue Colors by its drawer under a Portuguese heading', () => {
            expect(context.getIncludedToolDefinition(portugueseColours)?.label).toBe('Dialogue Colors');
        });

        // Defect: as above, through the old identity test, which also reads the heading.
        test('finds Time Machine by its drawer under a German heading', () => {
            expect(context.getIncludedToolDefinition(germanTimeMachine)?.label).toBe('Card & Lorebook Time Machine');
        });

        // Defect: the old code keeps all three in the Built-in list.
        test('leaves only the other drawers in the Built-in list', () => {
            const groups = [portugueseColours, germanTimeMachine, portugueseQuickReply];
            expect(context.getVisibleExtensionGroups(groups, 'built-in').map(info => info.name)).toEqual(['Resposta rápida']);
        });

        // Preservation: a third-party group never becomes an included tool through a selector.
        test('gives a third-party group no definition', () => {
            const thirdPartyColours = createExtensionGroup('third-party', 'Cores de diálogo', createDrawerUnit('dc-ext'));
            expect(context.getIncludedToolDefinition(thirdPartyColours)).toBeNull();
        });

        // Preservation: a selector that throws falls back to the heading and never throws itself. The throwing
        // drawer is alone in its group, because beside `dc-ext` the lookup would be a defect assertion.
        test('falls back to the heading when the selector throws, without throwing', () => {
            const englishWithBadSelector = createExtensionGroup('built-in', 'Dialogue Colors', createDrawerUnit('broken-drawer', { matchesThrows: true }));
            const germanWithBadSelector = createExtensionGroup('built-in', 'Dialogfarben', createDrawerUnit('broken-drawer', { matchesThrows: true }));
            let englishResult;
            let germanResult;
            expect(() => { englishResult = context.getIncludedToolDefinition(englishWithBadSelector); }).not.toThrow();
            expect(() => { germanResult = context.getIncludedToolDefinition(germanWithBadSelector); }).not.toThrow();
            expect(englishResult?.label).toBe('Dialogue Colors');
            expect(germanResult).toBeNull();
        });
    });

    test('finds the tool page group by its declared drawer, among built-in groups only', () => {
        const colourId = 'third-party/sillytavern-character-colors';
        const machineId = 'third-party/Neconyan-Time-Machine';
        // All of these are new-helper assertions: `findIncludedToolGroup` exists only after the change.
        const context = createToolLookupContext([
            'normalizeExtensionLookup',
            'getExtensionUnitCandidates',
            'normalizeIncludedToolLookup',
            'unitMatchesSelector',
            'findIncludedToolGroup',
        ], []);
        const find = (...args) => context.findIncludedToolGroup(...args);

        const portugueseColours = createExtensionGroup('built-in', 'Cores de diálogo', createDrawerUnit('dc-ext'));
        const germanTimeMachine = createExtensionGroup('built-in', 'Zeitmaschine', createDrawerUnit('sbctm-settings-drawer'));
        const portugueseQuickReply = createExtensionGroup('built-in', 'Resposta rápida', createDrawerUnit('qr_container'));
        const groups = [portugueseQuickReply, portugueseColours, germanTimeMachine];
        expect(find(groups, 'Dialogue Colors', colourId, '#dc-ext')).toBe(portugueseColours);
        expect(find(groups, 'Card & Lorebook Time Machine', machineId, '#sbctm-settings-drawer')).toBe(germanTimeMachine);

        // Scope: a third-party group listed first whose drawer also matches does not take precedence.
        const thirdPartyLookalike = createExtensionGroup('third-party', 'Cores personalizadas', createDrawerUnit('dc-ext'));
        expect(find([thirdPartyLookalike, portugueseColours], 'Dialogue Colors', colourId, '#dc-ext')).toBe(portugueseColours);

        // Fallback unchanged: with only a third-party group matching the selector, the old search decides.
        const thirdPartyNamedLikeTool = createExtensionGroup('third-party', 'Dialogue Colors', createDrawerUnit('dc-ext'));
        expect(find([thirdPartyNamedLikeTool], 'Dialogue Colors', colourId, '#dc-ext')).toBe(thirdPartyNamedLikeTool);
        expect(find([thirdPartyLookalike], 'Dialogue Colors', colourId, '#dc-ext')).toBeNull();
        // Fallback unchanged: without a selector, or with one that matches nothing, the heading still finds the group.
        const englishColours = createExtensionGroup('built-in', 'Dialogue Colors', createDrawerUnit('dc-ext'));
        expect(find([englishColours], 'Dialogue Colors', colourId)).toBe(englishColours);
        expect(find([englishColours], 'Dialogue Colors', colourId, '#matches-nothing')).toBe(englishColours);

        // Grouping: the whole group comes back, so a late drawer with the same heading still joins the page.
        const declaredUnit = createDrawerUnit('dc-ext');
        const lateUnit = createDrawerUnit('neconyan-tool-late-probe');
        const withLateDrawer = createExtensionGroup('built-in', 'Cores de diálogo', declaredUnit, lateUnit);
        const found = find([withLateDrawer], 'Dialogue Colors', colourId, '#dc-ext');
        expect(found).toBe(withLateDrawer);
        expect(found.units).toEqual([declaredUnit, lateUnit]);

        // A drawer whose `matches` throws does not throw out of the lookup.
        const englishWithBadSelector = createExtensionGroup('built-in', 'Dialogue Colors', createDrawerUnit('broken-drawer', { matchesThrows: true }));
        const germanWithBadSelector = createExtensionGroup('built-in', 'Dialogfarben', createDrawerUnit('broken-drawer', { matchesThrows: true }));
        expect(() => find([englishWithBadSelector], 'Dialogue Colors', colourId, '#dc-ext')).not.toThrow();
        expect(find([englishWithBadSelector], 'Dialogue Colors', colourId, '#dc-ext')).toBe(englishWithBadSelector);
        expect(find([germanWithBadSelector], 'Dialogue Colors', colourId, '#dc-ext')).toBeNull();
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
                this.dataset = {};
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
        vm.runInContext(shellSource.match(/^function renderSearchMatches\([\s\S]*?^}/m)[0], context);
        context.renderSearchMatches('test', matches, { loadMore() {} });
        expect(results.querySelectorAll().map(button => button.id)).toEqual([
            'sb-search-result-0', 'sb-search-result-1', 'sb-search-result-2', 'sb-search-result-3',
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

    // Separate tests, so the old code's run shows both defect assertions.
    describe('declares the settings drawer of every included tool that has a settings page', () => {
        const definitionsSource = shellSource.match(/const NECONYAN_NATIVE_TOOL_DEFINITIONS = Object\.freeze\(\[[\s\S]*?\n\]\);/)[0];
        const definitions = [...vm.runInNewContext(`${definitionsSource}\nNECONYAN_NATIVE_TOOL_DEFINITIONS;`)];
        const withSettingsPage = definitions.filter(definition => definition.actions.includes('settings') && definition.unitOnly !== true);
        const others = definitions.filter(definition => !withSettingsPage.includes(definition));

        // Preservation: eighteen tools go through the lookup, and four never do.
        test('has eighteen tools that go through the lookup and four that do not, and the four declare no drawer', () => {
            expect(withSettingsPage).toHaveLength(18);
            expect(others.map(definition => definition.label)).toEqual(['Chat Archive', 'CSS Snippets', 'Lorebook Distiller', 'Pawthfinder']);
            expect(others.filter(definition => definition.unit !== undefined)).toEqual([]);
        });

        // Defect: none of the eighteen declares a drawer yet, so this list is not empty before the change.
        test('gives each of the eighteen a non-empty selector', () => {
            const withoutUnit = withSettingsPage
                .filter(definition => typeof definition.unit !== 'string' || definition.unit.trim() === '')
                .map(definition => definition.label);
            expect(withoutUnit).toEqual([]);
        });

        // Defect: the tool page does not pass the declared drawer to the lookup yet.
        test('passes the declared drawer when the tool page mounts its settings', () => {
            expect(shellSource).toContain('mountUnit?.(tool.label, content, tool.id, tool.unit)');
        });
    });
});
