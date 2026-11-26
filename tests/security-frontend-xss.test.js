import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../public');
const readSource = (relativePath) => fs.readFileSync(path.join(publicDir, relativePath), 'utf8');

// SECTION A: confirmation popups, toasts and macro autocomplete escaping
import vm from 'node:vm';

const sliceBetween = (source, startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    if (start === -1 || end === -1) {
        throw new Error(`Could not find ${startMarker} … ${endMarker}`);
    }
    return source.slice(start, end);
};

const importsEscapeHtmlFromUtils = (source) => /import\s*\{[^}]*\bescapeHtml\b[^}]*\}\s*from\s*'\.\/utils\.js';/.test(source);

const loadThemeScanner = () => {
    const source = sliceBetween(readSource('scripts/power-user.js'), 'function decodeCssEscapesForScan', '/**\n * Imports a theme from a file.');
    const context = vm.createContext({});
    vm.runInContext(`${source}\nthis.scanner = { cssLoadsRemoteResources, themeImportLoadsRemoteCss, decodeCssEscapesForScan };`, context);
    return context.scanner;
};

class FakeNode {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.textContent = '';
    }

    append(...nodes) {
        this.children.push(...nodes);
    }

    set innerHTML(_value) {
        throw new Error('innerHTML must not be used for typed macro text');
    }

    get text() {
        return this.children.map(child => typeof child === 'string' ? child : child.textContent).join('');
    }
}

const loadMacroExampleHelpers = () => {
    const source = sliceBetween(readSource('scripts/autocomplete/EnhancedMacroAutoCompleteOption.js'), 'function createCodeElement', 'export class EnhancedMacroAutoCompleteOption');
    const context = vm.createContext({ document: { createElement: tag => new FakeNode(tag) } });
    vm.runInContext(`${source}\nthis.helpers = { createCodeElement, appendUsageExample };`, context);
    return context.helpers;
};

describe('frontend XSS hardening: popups and macro autocomplete', () => {
    test('persona popups and the auto-select toast escape persona names', () => {
        const source = readSource('scripts/personas.js');
        expect(source).toContain('t`Delete Scenario Note "${escapeHtml(appendix.name)}" from this persona?`');
        expect(source).toContain('t`Delete Persona` + `: ${escapeHtml(name)}`');
        expect(source).toContain('t`Are you sure you want to remove the default persona?`, escapeHtml(power_user.personas[avatarId])');
        expect(source).toContain('set \\"${escapeHtml(power_user.personas[avatarId])}\\" as the default persona?');
        expect(source).toContain('t`Auto-selected persona based on ${escapeHtml(connectType)} connection.<br />Your messages will now be sent as ${escapeHtml(power_user.personas[chatPersona])}.`');
        expect(source).toContain('t`Are you sure you want to duplicate this persona?`, escapeHtml(personaName)');
        expect(source).toContain('const safeName = escapeHtml(name1);');
        expect(source).toContain('const safeFilter = escapeHtml(nameFilter);');
        expect(source).not.toMatch(/attributed to \$\{name1\}/);
        expect(source).not.toMatch(/with name "\$\{nameFilter\}"/);
    });

    test('secret, note profile, snapshot, folder prompt and speaker popups escape names', () => {
        const secrets = readSource('scripts/secrets.js');
        expect(importsEscapeHtmlFromUtils(secrets)).toBe(true);
        expect(secrets).toContain('t`Delete Secret: ${escapeHtml(secret?.label)}`');

        const authorsNote = readSource('scripts/authors-note.js');
        // authors-note.js escapes inline: tests/authors-note-input.test.js runs it without utils.js.
        expect(authorsNote).toMatch(/const safeName = String\(current\.profile\.name \?\? ''\)\s*\.replace\(\/&\/g, '&amp;'\)/);
        expect(authorsNote).toContain('.replace(/</g, \'&lt;\')');
        expect(authorsNote).toContain('.replace(/"/g, \'&quot;\')');
        expect(authorsNote).toContain('t`Delete the note "${safeName}"? This cannot be undone.`');
        expect(authorsNote).toContain('t`Delete the profile "${safeName}"? This cannot be undone.`');
        expect(authorsNote).not.toContain('"${current.profile.name}"');

        const user = readSource('scripts/user.js');
        expect(importsEscapeHtmlFromUtils(user)).toBe(true);
        expect(user).toContain('`Are you sure you want to restore the settings from "${escapeHtml(name)}"?`');

        const folders = readSource('scripts/neconyan-character-folders.js');
        expect(importsEscapeHtmlFromUtils(folders)).toBe(true);
        expect(folders).toContain('Popup.show.confirm(t`Delete this prompt?`, escapeHtml(chosen.name))');

        const speakerMenu = readSource('scripts/group-chat-speaker-menu.js');
        expect(importsEscapeHtmlFromUtils(speakerMenu)).toBe(true);
        expect(speakerMenu).toContain('callGenericPopup(t`${escapeHtml(name)} will no longer remember anything said in this chat so far.');
    });

    test('lorebook popups escape names and lorebook options are built as text', () => {
        const source = readSource('scripts/world-info.js');
        expect(source).toContain('Popup.show.confirm(`Delete the World/Lorebook: "${escapeHtml(name)}"?`');
        expect(source).toContain('t`Are you sure you want to import \'${escapeHtml(persistedBookName)}\'?`');
        expect(source).toContain('$(\'#world_info\').append(new Option(item, String(i), isSelected, isSelected));');
        expect(source).toContain('$(\'#world_editor_select\').append(new Option(item, String(i)));');
        expect(source).not.toMatch(/<option value='\$\{i\}'[^`]*>\$\{item\}<\/option>/);
    });

    test('accent profile popups escape names without a new import line in power-user.js', () => {
        const source = readSource('scripts/power-user.js');
        expect(source).toContain('`Replace the "${escapeHtml(newProfile.name)}" accent profile?`');
        expect(source).toContain('`Delete the "${escapeHtml(profile.name)}" accent profile?`');
        const utilsImports = source.match(/^import .* from '\.\/utils\.js';$/gm) ?? [];
        expect(utilsImports).toHaveLength(1);
        expect(utilsImports[0]).toMatch(/\bescapeHtml\b/);
    });

    test('theme import scanner finds hidden @import rules', () => {
        const { cssLoadsRemoteResources, decodeCssEscapesForScan } = loadThemeScanner();
        expect(decodeCssEscapesForScan('@\\69mport')).toBe('@import');
        expect(decodeCssEscapesForScan('@\\000069 mport')).toBe('@import');
        expect(decodeCssEscapesForScan('\\\\69')).toBe('\\69');
        for (const css of [
            '@import url(theme.css);',
            '@IMPORT "x.css";',
            '@\\69mport "x.css";',
            '@\\49 MPORT "x.css";',
            '@/**/import "x.css";',
            '@im\\port "x.css";',
            'a{content:"/*"} @import "x.css"; /* "*/',
        ]) {
            expect([css, cssLoadsRemoteResources(css)]).toEqual([css, true]);
        }
    });

    test('theme import scanner finds external url() references', () => {
        const { cssLoadsRemoteResources } = loadThemeScanner();
        for (const css of [
            'body { background: url(https://example.com/a.png); }',
            'body { background: url(http://example.com/a.png); }',
            'body { background: URL( "HTTPS://example.com/a.png" ); }',
            'body { background: url(  \'//example.com/a.png\'); }',
            'body { background: url(//example.com/a.png); }',
            'body { background: url(\\68ttps://example.com/a.png); }',
            'body { background: u\\72l(https://example.com/a.png); }',
            'body { background: url(https:\\/\\/example.com/a.png); }',
            'body { background: url(/**/https://example.com/a.png); }',
            'body { background-image: image-set("https://example.com/a.png" 1x); }',
        ]) {
            expect([css, cssLoadsRemoteResources(css)]).toEqual([css, true]);
        }
        for (const css of [
            '',
            ':root { --SmartThemeBodyColor: rgba(220, 220, 210, 1); }',
            'body { background: url(/img/cat.png); }',
            'body { background: url("img/cat.png"); }',
            'body { background: url(data:image/png;base64,AAAA); }',
            '.mes { font-family: "Noto Sans", sans-serif; }',
            '/* a theme for cats */ .mes_text { color: var(--neco-ink); }',
        ]) {
            expect([css, cssLoadsRemoteResources(css)]).toEqual([css, false]);
        }
    });

    test('theme import warns for custom CSS and for style entries (CTSI) the theme carries', () => {
        const { themeImportLoadsRemoteCss } = loadThemeScanner();
        expect(themeImportLoadsRemoteCss({ name: 'Plain', custom_css: '.mes { color: red; }' })).toBe(false);
        expect(themeImportLoadsRemoteCss({ name: 'Plain' })).toBe(false);
        expect(themeImportLoadsRemoteCss({ name: 'Bad', custom_css: '@\\69mport "x.css";' })).toBe(true);
        expect(themeImportLoadsRemoteCss({ name: 'Bad', CTSI: { entries: { mainFont: 'Figtree', bg: 'url(https://example.com/a.png)' } } })).toBe(true);
        expect(themeImportLoadsRemoteCss({ name: 'Bad', extension_settings: { CTSI: { entries: { bg: 'url( "//example.com/a.png")' } } } })).toBe(true);
        expect(themeImportLoadsRemoteCss({ name: 'Fine', CTSI: { entries: { mainFont: 'Figtree', size: 3 } } })).toBe(false);

        const importTheme = sliceBetween(readSource('scripts/power-user.js'), 'async function importTheme', 'function saveTheme');
        expect(importTheme).toContain('if (themeImportLoadsRemoteCss(parsed)) {');
        expect(importTheme).not.toContain('parsed.custom_css.includes(\'@import\')');
    });

    test('macro autocomplete shows typed names as text, never as HTML', () => {
        const { createCodeElement, appendUsageExample } = loadMacroExampleHelpers();
        const hostile = '<img src=x onerror=alert(1)>';
        const code = createCodeElement(`{{${hostile}}}`);
        expect(code.tagName).toBe('code');
        expect(code.textContent).toBe(`{{${hostile}}}`);

        const li = new FakeNode('li');
        appendUsageExample(li, `{{$${hostile} = value}} - Set value`);
        expect(li.children[0].tagName).toBe('code');
        expect(li.children[0].textContent).toBe(`{{$${hostile} = value}}`);
        expect(li.children[1]).toBe(' - Set value');

        const normal = new FakeNode('li');
        appendUsageExample(normal, '{{$score < 10}} - Less than (numeric)');
        expect(normal.text).toBe('{{$score < 10}} - Less than (numeric)');

        const source = readSource('scripts/autocomplete/EnhancedMacroAutoCompleteOption.js');
        for (const field of ['this.#varName', 'this.#currentValue', 'this.#macroName', 'this.#context.scopedMacroName', 'scopedMacroName', 'ex.split(\' - \')']) {
            const unsafe = source.split('\n').filter(line => line.includes('innerHTML') && line.includes(field));
            expect([field, unsafe]).toEqual([field, []]);
        }
        expect(source).toContain('header.append(\'Close \', createCodeElement(`{{${this.#macroName}}}`));');
        expect(source).toContain('currentNote.append(label, \' \', createCodeElement(this.#currentValue));');
        expect(source).toContain('warningText.append(\'The name \', createCodeElement(this.#varName), \' cannot be used with variable shorthand syntax.\');');
    });
});
// END SECTION A

// SECTION B: provider model lists, prompt manager and misc sinks
const { default: sectionBVm } = await import('node:vm');

const B_PAYLOAD = '"><img src=x onerror=alert(1)>';

/** Cuts a top-level function (ending with `}` in column 0) out of browser source. */
function bSliceFunction(source, name) {
    const match = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm').exec(source);
    if (!match) throw new Error(`Function ${name} not found`);
    const end = source.indexOf('\n}\n', match.index);
    return source.slice(match.index, end + 2).replace(/^export /, '');
}

/** Cuts a single-line top-level const out of browser source. */
function bSliceConst(source, name) {
    const match = new RegExp(`^const ${name} = .*;$`, 'm').exec(source);
    if (!match) throw new Error(`Const ${name} not found`);
    return match[0];
}

/** Runs sliced code in a fresh context and returns the named bindings. */
function bRun(code, names, globals = {}) {
    const context = sectionBVm.createContext({ ...globals });
    const exported = sectionBVm.runInContext(`${code}\n;({ ${names.join(', ')} })`, context);
    return { context, ...exported };
}

class BText {
    constructor(text) {
        this.text = String(text);
    }
}

class BNode {
    constructor(tag) {
        this.tag = tag;
        this.attrs = {};
        this.children = [];
        this.visible = null;
    }
}

const bEscape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function bSerialize(node) {
    if (node instanceof BText) return bEscape(node.text);
    if (typeof node?.raw === 'string') return node.raw;
    const attrs = Object.entries(node.attrs).map(([key, value]) => ` ${key}="${bEscape(value)}"`).join('');
    return `<${node.tag}${attrs}>${node.children.map(bSerialize).join('')}</${node.tag}>`;
}

const bTextOf = node => node instanceof BText ? node.text : (node.children ?? []).map(bTextOf).join('');

/**
 * A jQuery stand-in with no HTML parser: element creation must be a bare `<tag>`,
 * and every other piece of markup handed to it is recorded in `rawHtml`.
 */
function createBFakeJQuery() {
    const rawHtml = [];
    const registry = {};
    class Wrapper {
        constructor(node) {
            this.node = node;
            this[0] = node;
            this.length = 1;
        }
        attr(key, value) {
            if (value === undefined) return this.node.attrs[key];
            this.node.attrs[key] = String(value);
            return this;
        }
        text(value) {
            if (value === undefined) return bTextOf(this.node);
            this.node.children = [new BText(value)];
            return this;
        }
        html(markup) {
            rawHtml.push(String(markup));
            this.node.children = [{ raw: String(markup) }];
            return this;
        }
        append(...items) {
            for (const item of items) {
                if (item instanceof Wrapper) this.node.children.push(item.node);
                else if (item instanceof BText || item instanceof BNode) this.node.children.push(item);
                else if (Array.isArray(item)) this.append(...item);
                else if (/[<&]/.test(String(item))) {
                    rawHtml.push(String(item));
                    this.node.children.push({ raw: String(item) });
                } else this.node.children.push(new BText(item));
            }
            return this;
        }
        show() {
            this.node.visible = true;
            return this;
        }
        hide() {
            this.node.visible = false;
            return this;
        }
    }
    const $ = (arg, props) => {
        if (arg instanceof Wrapper) return arg;
        if (typeof arg === 'string' && arg.startsWith('#')) {
            registry[arg] ??= new BNode('div');
            return new Wrapper(registry[arg]);
        }
        const tag = /^<([a-z0-9]+)>$/i.exec(String(arg).trim())?.[1];
        if (!tag) {
            rawHtml.push(String(arg));
            return new Wrapper(Object.assign(new BNode('raw'), { raw: String(arg) }));
        }
        const wrapper = new Wrapper(new BNode(tag));
        for (const [key, value] of Object.entries(props ?? {})) {
            if (key === 'text') wrapper.text(value);
            else wrapper.attr(key, value);
        }
        return wrapper;
    };
    const document = { createTextNode: text => new BText(text) };
    return { $, document, rawHtml, registry, serialize: wrapper => bSerialize(wrapper.node) };
}

const bTag = (strings, ...values) => String.raw({ raw: strings }, ...values);

describe('frontend XSS hardening: provider models and misc sinks', () => {
    const openaiSource = readSource('scripts/openai.js');
    const textgenSource = readSource('scripts/textgen-models.js');
    const utilsSource = readSource('scripts/utils.js');

    const expectInert = (fake, rendered) => {
        expect(fake.rawHtml.join('\n')).not.toContain('<img');
        expect(rendered).not.toContain('<img');
        expect(rendered).toContain('&lt;img src=x onerror=alert(1)&gt;');
    };

    test.each([
        ['getOpenRouterModelTemplate', { id: B_PAYLOAD, name: B_PAYLOAD, context_length: 4096, pricing: { prompt: '0.000001' } }, '4096 ctx'],
        ['getElectronHubModelTemplate', { id: B_PAYLOAD, name: B_PAYLOAD, tokens: 8192, pricing: { input: B_PAYLOAD, output: 2 }, metadata: { vision: true } }, '8192 ctx'],
        ['getChutesModelTemplate', { id: B_PAYLOAD, context_length: 2048, pricing: { input: B_PAYLOAD, output: 1 }, supported_features: ['reasoning'] }, '2048 ctx'],
        ['getAimlapiModelTemplate', { id: `${B_PAYLOAD}/model`, info: { name: B_PAYLOAD } }, B_PAYLOAD],
    ])('openai.js %s renders provider fields as text', (name, model, visibleText) => {
        const fake = createBFakeJQuery();
        const { [name]: template } = bRun(bSliceFunction(openaiSource, name), [name], {
            $: fake.$,
            document: fake.document,
            model_list: [model],
        });
        const row = template({ id: model.id, text: 'fallback', element: { value: model.id } });
        const rendered = fake.serialize(row);
        expectInert(fake, rendered);
        expect(row.attr('title')).toBe(model.id);
        expect(row.text()).toContain(visibleText);
        expect(template({ id: '', text: 'fallback', element: { value: 'missing' } })).toBe('fallback');
    });

    test('openai.js keeps capability icons as static markup-free nodes', () => {
        const fake = createBFakeJQuery();
        const { getElectronHubModelTemplate } = bRun(bSliceFunction(openaiSource, 'getElectronHubModelTemplate'), ['getElectronHubModelTemplate'], {
            $: fake.$,
            document: fake.document,
            model_list: [{ id: 'm', name: 'Model', tokens: 1, pricing: { input: 1, output: 2 }, metadata: { vision: true, reasoning: true }, premium_model: true }],
        });
        const rendered = fake.serialize(getElectronHubModelTemplate({ id: 'm', element: { value: 'm' } }));
        expect(rendered).toBe('<div class="flex-container alignItemsBaseline" title="m"><strong>Model</strong> | 1 ctx | <small>$1/$2 in/out Mtoken</small> | '
            + '<i class="fa-solid fa-eye fa-sm" title="This model supports vision"></i><i class="fa-solid fa-brain fa-sm" title="This model supports reasoning"></i>'
            + '<i class="fa-solid fa-crown fa-sm" title="This model requires a subscription"></i></div>');
    });

    test.each([
        ['getMancerModelTemplate', 'mancerModels', { id: 'x', name: B_PAYLOAD, limits: { context: 100, completion: 10 }, pricing: { prompt: 1, completion: 1 } }, 'Credits per request (max): 100'],
        ['getTogetherModelTemplate', 'togetherModels', { id: B_PAYLOAD, description: B_PAYLOAD, context_length: 32 }, '32 tokens'],
        ['getOpenRouterModelTemplate', 'openRouterModels', { id: B_PAYLOAD, name: B_PAYLOAD, context_length: 64, pricing: { prompt: 0 } }, 'Free'],
    ])('textgen-models.js %s renders provider fields as text', (name, listName, model, visibleText) => {
        const fake = createBFakeJQuery();
        const { [name]: template } = bRun(bSliceFunction(textgenSource, name), [name], {
            $: fake.$,
            document: fake.document,
            [listName]: [model],
        });
        const row = template({ id: model.id, text: 'fallback', element: { value: model.id } });
        expectInert(fake, fake.serialize(row));
        expect(row.text()).toContain(visibleText);
    });

    test('textgen-models.js no longer needs DOMPurify for model rows', () => {
        expect(textgenSource).not.toMatch(/DOMPurify/);
    });

    test.each(['appendOpenRouterOptions', 'appendAimlapiOptions'])('openai.js %s sets optgroup labels as attributes', (name) => {
        const fake = createBFakeJQuery();
        const { [name]: append } = bRun(bSliceFunction(openaiSource, name), [name], {
            $: fake.$,
            t: bTag,
            openrouter_website_model: 'OR_Website',
        });
        const models = new Map([[B_PAYLOAD, [{ id: 'vendor/model', name: 'Model' }]]]);
        append(models, true);
        const select = fake.registry[name === 'appendAimlapiOptions' ? '#model_aimlapi_select' : '#model_openrouter_select'];
        const optgroup = select.children.find(child => child.tag === 'optgroup');
        expect(fake.rawHtml).toEqual([]);
        expect(optgroup.attrs.label).toBe(B_PAYLOAD);
        expect(bTextOf(optgroup)).toBe('Model');
    });

    test('openai.js Vertex AI status puts the message in as text and keeps the icons', () => {
        const fake = createBFakeJQuery();
        const { updateVertexAIServiceAccountStatus } = bRun(bSliceFunction(openaiSource, 'updateVertexAIServiceAccountStatus'), ['updateVertexAIServiceAccountStatus'], {
            $: fake.$,
            t: bTag,
            secret_state: {},
            SECRET_KEYS: { VERTEXAI_SERVICE_ACCOUNT: 'api_key_vertexai_service_account' },
        });
        updateVertexAIServiceAccountStatus(true, `Project: ${B_PAYLOAD}`);
        const info = fake.registry['#vertexai_service_account_info'];
        expect(fake.rawHtml.join('\n')).not.toContain('<img');
        expect(fake.rawHtml[0]).toContain('fa-check-circle');
        expect(bTextOf(info)).toBe(`Project: ${B_PAYLOAD}`);
        expect(fake.registry['#vertexai_service_account_status'].visible).toBe(true);

        updateVertexAIServiceAccountStatus(false, B_PAYLOAD);
        expect(fake.rawHtml[1]).toContain('fa-exclamation-triangle');
        expect(fake.rawHtml.join('\n')).not.toContain('<img');
    });

    test('openai.js escapes the endpoint profile name in the delete confirmation', () => {
        expect(openaiSource).toContain('t`Delete endpoint profile \'${safePresetName}\'? The URL and model stay in the fields.`');
        const line = openaiSource.split('\n').find(text => text.includes('const safePresetName = '));
        const expression = line.trim().replace(/^const safePresetName = /, '').replace(/;$/, '');
        const escape = sectionBVm.runInNewContext(`(presetName) => ${expression}`);
        expect(escape(B_PAYLOAD)).toBe('&#34;&#62;&#60;img src=x onerror=alert(1)&#62;');
        expect(escape('It\'s & mine')).toBe('It&#39;s &#38; mine');
        expect(escape('My profile')).toBe('My profile');
    });

    test('new-tab links carry rel="noopener noreferrer"', () => {
        for (const file of ['scripts/textgen-models.js', 'scripts/tool-calling.js']) {
            const links = readSource(file).match(/<a [^>]*target="_blank"[^>]*>/g) ?? [];
            expect(links.length).toBeGreaterThan(0);
            for (const link of links) {
                expect(link).toContain('rel="noopener noreferrer"');
            }
        }
    });

    describe('utils.js path helpers', () => {
        // Sliced on their own, as world-info-save and story-mode-persistence do, so they must stay self-contained.
        const load = () => bRun([
            bSliceFunction(utilsSource, 'setValueByPath'),
            bSliceFunction(utilsSource, 'deleteValueByPath'),
        ].join('\n'), ['setValueByPath', 'deleteValueByPath']);

        test('setValueByPath still writes nested paths', () => {
            const { setValueByPath } = load();
            const target = {};
            setValueByPath(target, 'a.b.c', 1);
            expect(target).toEqual({ a: { b: { c: 1 } } });
        });

        test.each(['__proto__.polluted', 'a.__proto__.polluted', 'constructor.prototype.polluted', 'a.constructor', 'prototype'])('setValueByPath ignores %s', (unsafePath) => {
            const { setValueByPath, context } = load();
            const target = sectionBVm.runInContext('({ a: {} })', context);
            setValueByPath(target, unsafePath, 'yes');
            expect(sectionBVm.runInContext('({}).polluted', context)).toBeUndefined();
            expect(Object.prototype).not.toHaveProperty('polluted');
            expect(target).toEqual({ a: {} });
        });

        test('deleteValueByPath ignores prototype segments and inherited properties', () => {
            const { deleteValueByPath, context } = load();
            sectionBVm.runInContext('Object.prototype.keepMe = 1; Object.prototype.nested = { value: 1 };', context);
            const target = sectionBVm.runInContext('({ a: { b: 1 } })', context);
            deleteValueByPath(target, '__proto__.keepMe');
            deleteValueByPath(target, 'constructor.prototype.keepMe');
            deleteValueByPath(target, 'nested.value');
            expect(sectionBVm.runInContext('({}).keepMe', context)).toBe(1);
            expect(sectionBVm.runInContext('({}).nested.value', context)).toBe(1);
            deleteValueByPath(target, 'a.b');
            expect(target).toEqual({ a: {} });
        });
    });

    test('utils.js escapeHtml escapes both quote kinds for attribute values', () => {
        const { escapeHtml } = bRun(bSliceFunction(utilsSource, 'escapeHtml'), ['escapeHtml']);
        expect(escapeHtml('a"b\'c<d>&')).toBe('a&quot;b&#39;c&lt;d&gt;&amp;');
    });

    test('utils.js checkOverwriteExistingData escapes the existing name in the popup and toasts', async () => {
        const calls = [];
        let confirmResult = false;
        const { checkOverwriteExistingData } = bRun([
            bSliceFunction(utilsSource, 'escapeHtml'),
            bSliceFunction(utilsSource, 'checkOverwriteExistingData'),
        ].join('\n'), ['checkOverwriteExistingData'], {
            Popup: { show: { confirm: async (title, body) => { calls.push(['confirm', title, body]); return confirmResult; } } },
            toastr: {
                warning: (...args) => calls.push(['warning', ...args]),
                info: (...args) => calls.push(['info', ...args]),
            },
            equalsIgnoreCaseAndAccents: (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),
        });

        expect(await checkOverwriteExistingData('World Info', [B_PAYLOAD], B_PAYLOAD, { interactive: true })).toBe(false);
        confirmResult = true;
        expect(await checkOverwriteExistingData('World Info', [B_PAYLOAD], B_PAYLOAD, { interactive: true })).toBe(true);
        expect(await checkOverwriteExistingData('World Info', ['other'], B_PAYLOAD)).toBe(true);

        const markup = calls.flatMap(call => call.slice(1, 3)).join('\n');
        expect(markup).not.toContain('<img');
        expect(markup).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
        expect(calls[0][2]).toContain('<p>A world info with the same name already exists:<br />');
        expect(calls.find(call => call[0] === 'info')[1]).toBe('Overwriting Existing World Info:<br />&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    });

    test('PromptManager.js escapes inspect drawer fields and quick edit markup', () => {
        const source = readSource('scripts/PromptManager.js');
        expect(source).toContain('<span>Name: ${escapeHtml(title)}, Role: ${escapeHtml(role)}, Tokens: ${escapeHtml(tokens)}</span>');
        expect(source).toContain('<div class="justifyLeft">${escapeHtml(title)}</div>');
        expect(source).toContain('<textarea id="${escapeHtml(textareaIdentifier)}" class="text_pole textarea_compact" rows="6" placeholder="">${escapeHtml(prompt.content)}</textarea>');
    });

    test('extensions.js escapes every data-name attribute it writes into markup', () => {
        const lines = readSource('scripts/extensions.js').split('\n')
            .filter(line => line.includes('data-name="${') && !line.includes('[data-name="${'));
        expect(lines.length).toBeGreaterThanOrEqual(10);
        for (const line of lines) {
            expect(line).not.toMatch(/data-name="\$\{(?!escapeHtml\()/);
        }
    });

    describe('backgrounds.js CSS helpers', () => {
        const source = readSource('scripts/backgrounds.js');
        const load = (globals = {}) => bRun([
            bSliceFunction(source, 'cssUrlValue'),
            bSliceFunction(source, 'cssSelectorValue'),
        ].join('\n'), ['cssUrlValue', 'cssSelectorValue'], globals);

        test('cssUrlValue keeps normal URLs and cannot be broken out of', () => {
            const { cssUrlValue } = load();
            expect(cssUrlValue('/thumbnail?type=bg&file=a%20b.png')).toBe('url("/thumbnail?type=bg&file=a%20b.png")');
            expect(cssUrlValue('x"); background: url(evil\\\n')).toBe('url("x\\"); background: url(evil\\\\\\a ")');
            expect(cssUrlValue('it\'s')).toBe('url("it\'s")');
        });

        test('cssSelectorValue uses CSS.escape when present and escapes quotes without it', () => {
            expect(load({ CSS: { escape: value => `ESC(${value})` } }).cssSelectorValue('a"b')).toBe('ESC(a"b)');
            const fallback = load().cssSelectorValue('a"] .x, b\'\\');
            expect(fallback).toBe('a\\22 \\5d  .x, b\\27 \\5c ');
            expect(fallback).not.toMatch(/["'\]]/);
        });

        test('folder cover and thumbnail call sites use the helpers', () => {
            expect(source).toContain('.bg_folder_tile[data-folder-id="${cssSelectorValue(folder.id)}"] .bg_folder_tile_cover');
            expect(source).toContain('.css(\'background-image\', cssUrlValue(coverUrl));');
            expect(source).toContain('return cssUrlValue(thumbnailUrl);');
            expect(source).not.toContain('url(\'${coverUrl}\')');
        });
    });

    test('variables.js only reports own variables as existing', () => {
        const source = readSource('scripts/variables.js');
        const globals = { chat_metadata: { variables: { mood: 'happy', empty: '' } }, extension_settings: { variables: { global: { count: 0 } } } };
        const { existsLocalVariable, existsGlobalVariable, context } = bRun([
            bSliceFunction(source, 'existsLocalVariable'),
            bSliceFunction(source, 'existsGlobalVariable'),
        ].join('\n'), ['existsLocalVariable', 'existsGlobalVariable'], globals);

        expect(existsLocalVariable('mood')).toBe(true);
        expect(existsLocalVariable('empty')).toBe(true);
        expect(existsGlobalVariable('count')).toBe(true);
        for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'missing']) {
            expect(existsLocalVariable(name)).toBe(false);
            expect(existsGlobalVariable(name)).toBe(false);
        }
        sectionBVm.runInContext('chat_metadata.variables = undefined; extension_settings.variables.global = null;', context);
        expect(existsLocalVariable('mood')).toBe(false);
        expect(existsGlobalVariable('count')).toBe(false);
    });

    describe('tags.js colour validation', () => {
        const source = readSource('scripts/tags.js');
        const loadTags = () => bRun([
            bSliceConst(source, 'SAFE_TAG_HEX_COLOR'),
            bSliceConst(source, 'SAFE_TAG_FUNCTION_COLOR'),
            bSliceConst(source, 'SAFE_TAG_NAMED_COLOR'),
            bSliceFunction(source, 'safeTagColor'),
            bSliceFunction(source, 'sanitizeTagColors'),
        ].join('\n'), ['safeTagColor', 'sanitizeTagColors']);

        test.each([
            '#abc', '#abcd', '#a1b2c3', '#A1B2C3D4', 'rgba(255, 0, 0, 0.5)', 'rgb(1 2 3 / 50%)',
            'hsl(120deg, 50%, 50%)', 'hsla(120, 50%, 50%, .3)', 'transparent', 'RebeccaPurple',
        ])('accepts %s', (color) => {
            expect(loadTags().safeTagColor(color)).toBe(color);
        });

        test.each([
            'red; background-image: url(x)', 'url(https://evil.example/x.png)', '"red"', 'red\\', 'rgba(0,0,0,0); color: red',
            'rgb(var(--x))', 'expression(alert(1))', '#abcde', '#ggg', 'light-blue', 'rgba(1,2,3)"', 42, null, undefined, { toString: () => 'red' },
        ])('rejects %p', (color) => {
            expect(loadTags().safeTagColor(color)).toBe('');
        });

        test('sanitizeTagColors clears unsafe restored colours and keeps safe ones', () => {
            const { sanitizeTagColors } = loadTags();
            const restored = [
                { id: '1', name: 'Safe', color: 'rgba(0, 0, 0, 0.5)', color2: '#fff' },
                { id: '2', name: 'Bad', color: 'red;background:url(x)', color2: '"><img src=x>' },
                { id: '3', name: 'Plain' },
                null,
            ];
            sanitizeTagColors(restored);
            expect(restored[0]).toEqual({ id: '1', name: 'Safe', color: 'rgba(0, 0, 0, 0.5)', color2: '#fff' });
            expect(restored[1]).toEqual({ id: '2', name: 'Bad', color: '', color2: '' });
            expect(restored[2]).toEqual({ id: '3', name: 'Plain' });
        });

        test('every tag colour sink and the backup restore go through the check', () => {
            expect(source).toContain('\'background-color\': safeTagColor(tag.color), \'color\': safeTagColor(tag.color2)');
            expect(source).toContain('tagElement.css(\'background-color\', safeTagColor(tag.color));');
            expect(source).toContain('tagElement.css(\'color\', safeTagColor(tag.color2));');
            expect(source).toContain('.tag_view_name\').css(\'background-color\', safeTagColor(tag.color));');
            expect(source).toContain('.tag_view_name\').css(\'color\', safeTagColor(tag.color2));');
            expect(source).toContain('color: safeTagColor(tag.color) || \'rgba(0, 0, 0, 0.5)\',');
            expect(source).toContain('color: safeTagColor(tag.color2) || power_user.main_text_color,');
            expect(source).toMatch(/restoreTagsFromBackup\(\{[\s\S]*?\}\);\n\s+sanitizeTagColors\(tags\);/);
            expect(source).not.toMatch(/\.css\(\s*'(?:background-color|color)',\s*tag\.color2?\s*\)/);
        });
    });
});
// END SECTION B
