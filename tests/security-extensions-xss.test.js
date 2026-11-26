import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { jest } from '@jest/globals';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionsDir = path.resolve(here, '../public/scripts/extensions');
const readSource = (relativePath) => fs.readFileSync(path.join(extensionsDir, relativePath), 'utf8');

const PAYLOAD = '<img src=x onerror=alert(1)>';
const SCRIPT_PAYLOAD = '"><script>alert(1)</script>\'';

/**
 * A tiny DOM that keeps a tree of elements and text nodes. It has no HTML parser, so any
 * markup that reaches `innerHTML` is recorded in `htmlAssignments` instead of being parsed.
 */
const htmlAssignments = [];

class FakeText {
    constructor(text) {
        this.nodeType = 3;
        this.textContent = String(text);
    }
}

class FakeElement {
    constructor(tagName) {
        this.nodeType = 1;
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.attributes = {};
        this.style = {};
        this.className = '';
        this.id = '';
        this.value = '';
        this.listeners = {};
    }

    get textContent() {
        return this.children.map(child => child.textContent).join('');
    }

    set textContent(value) {
        this.children = [new FakeText(value)];
    }

    set innerText(value) {
        this.textContent = value;
    }

    set innerHTML(value) {
        htmlAssignments.push(String(value));
        this.children = [];
    }

    get innerHTML() {
        return '';
    }

    append(...nodes) {
        for (const node of nodes) {
            this.children.push(typeof node === 'string' ? new FakeText(node) : node);
        }
    }

    appendChild(node) {
        this.append(node);
        return node;
    }

    replaceChildren(...nodes) {
        this.children = [];
        this.append(...nodes);
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }

    walk(visit) {
        visit(this);
        for (const child of this.children) {
            if (child instanceof FakeElement) {
                child.walk(visit);
            }
        }
    }

    elements() {
        const found = [];
        this.walk(element => found.push(element));
        return found;
    }
}

class FakeOption extends FakeElement {
    constructor(text = '', value = text) {
        super('option');
        this.textContent = text;
        this.value = String(value);
    }
}

const fakeDocument = {
    createElement: (tag) => new FakeElement(tag),
};

/**
 * Extracts source text between two markers (start inclusive, end exclusive).
 * @param {string} source
 * @param {string} startMarker
 * @param {string} endMarker
 * @returns {string}
 */
function slice(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf(endMarker, start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
}

beforeEach(() => {
    htmlAssignments.length = 0;
});

describe('TTS VoiceMapEntry.addUI', () => {
    const indexSource = readSource('tts/index.js');
    const sanitizeIdSource = slice(indexSource, 'export function sanitizeId(input) {', 'function parseVoiceMap').replace('export function', 'function');
    const classSource = slice(indexSource, 'class VoiceMapEntry {', '/**\n * Init voiceMapEntries');

    function createVoiceMapEntryClass() {
        const block = new FakeElement('div');
        const wrap = (nodes) => ({
            nodes,
            append(node) { nodes.forEach(target => target.append(node)); return this; },
            on(event, handler) { nodes.forEach(node => { node.listeners[event] = handler; }); return this; },
            val(value) { nodes.forEach(node => { node.value = value; }); return this; },
            find() { return { val: () => nodes[0].value }; },
        });
        const $ = (target) => (typeof target === 'string' ? wrap([block]) : wrap([target]));
        const updateVoiceMap = jest.fn();
        const context = vm.createContext({
            document: fakeDocument,
            Option: FakeOption,
            encodeURIComponent,
            $,
            updateVoiceMap,
            DEFAULT_VOICE_MARKER: '[Default Voice]',
            DISABLED_VOICE_MARKER: 'disabled',
        });
        const VoiceMapEntry = vm.runInContext(`(function () { ${sanitizeIdSource}\n${classSource}\nreturn { VoiceMapEntry, sanitizeId }; })()`, context);
        return { ...VoiceMapEntry, block, updateVoiceMap };
    }

    test('source no longer interpolates the character name into HTML', () => {
        expect(classSource).not.toMatch(/\$\{this\.name\}/);
        expect(classSource).not.toMatch(/\.append\(template\)/);
    });

    test.each([PAYLOAD, SCRIPT_PAYLOAD])('renders hostile name %s as literal text with no injected elements', (hostileName) => {
        const { VoiceMapEntry, sanitizeId, block } = createVoiceMapEntryClass();
        const entry = new VoiceMapEntry(hostileName, '[Default Voice]');
        entry.addUI([{ name: 'Voice A' }, { name: PAYLOAD }]);

        expect(htmlAssignments).toEqual([]);

        const elements = block.elements();
        const tags = elements.map(element => element.tagName);
        expect(tags.filter(tag => tag === 'IMG' || tag === 'SCRIPT')).toEqual([]);
        expect(tags.sort()).toEqual(['DIV', 'DIV', 'OPTION', 'OPTION', 'OPTION', 'OPTION', 'SELECT', 'SPAN'].sort());

        const label = elements.find(element => element.tagName === 'SPAN');
        expect(label.textContent).toBe(hostileName);
        expect(label.id).toBe(`tts_voicemap_char_${sanitizeId(hostileName)}`);
        expect(label.id).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/);

        const select = elements.find(element => element.tagName === 'SELECT');
        expect(select.id).toBe(`tts_voicemap_char_${sanitizeId(hostileName)}_voice`);
        expect(select.id).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
        expect(entry.name).toBe(hostileName);
    });

    test('keeps IDs, markers, option values and the raw name key for normal names', () => {
        const { VoiceMapEntry, block, updateVoiceMap } = createVoiceMapEntryClass();
        const entry = new VoiceMapEntry('Alice Smith', 'Voice A');
        entry.addUI([{ name: 'Voice A' }, { name: 'Voice B' }]);

        const elements = block.elements();
        const label = elements.find(element => element.tagName === 'SPAN');
        const select = elements.find(element => element.tagName === 'SELECT');
        expect(label.id).toBe('tts_voicemap_char_Alice%20Smith'.replace(/[^a-zA-Z0-9_-]/g, ''));
        expect(label.textContent).toBe('Alice Smith');
        expect(select.children.map(option => option.value)).toEqual(['[Default Voice]', 'disabled', 'Voice A', 'Voice B']);
        expect(select.children.map(option => option.textContent)).toEqual(['[Default Voice]', 'disabled', 'Voice A', 'Voice B']);
        expect(select.value).toBe('Voice A');
        expect(entry.selectElement.nodes[0]).toBe(select);

        select.value = 'Voice B';
        select.listeners.change({});
        expect(entry.voiceId).toBe('Voice B');
        expect(updateVoiceMap).toHaveBeenCalledTimes(1);
        expect(entry.name).toBe('Alice Smith');
    });

    test('the default entry only offers the disabled marker', () => {
        const { VoiceMapEntry, block } = createVoiceMapEntryClass();
        new VoiceMapEntry('[Default Voice]').addUI([]);
        const select = block.elements().find(element => element.tagName === 'SELECT');
        expect(select.children.map(option => option.value)).toEqual(['disabled']);
    });
});

describe('Quick Reply editor parse error display', () => {
    const source = readSource('quick-reply/src/QuickReply.js');
    const catchBody = slice(source, 'if (ex instanceof SlashCommandParserError) {', '\n        }\n        if (noSyntax) {');

    class SlashCommandParserError extends Error {
        constructor(message, line, column, hint) {
            super(message);
            this.line = line;
            this.column = column;
            this.hint = hint;
        }
    }

    function render(ex) {
        const target = new FakeElement('div');
        const context = vm.createContext({ document: fakeDocument, SlashCommandParserError, ex, editorHolder: { editorExecuteErrors: target } });
        vm.runInContext(`(function () { ${catchBody.replace(/this\./g, 'editorHolder.')} })()`, context);
        return target;
    }

    test('source never writes the error into innerHTML', () => {
        expect(catchBody).not.toMatch(/innerHTML/);
    });

    test('parser error message and hint render as literal text', () => {
        const errors = render(new SlashCommandParserError(PAYLOAD, 3, 7, `/echo ${SCRIPT_PAYLOAD}`));

        expect(htmlAssignments).toEqual([]);
        expect(errors.elements().filter(element => ['IMG', 'SCRIPT'].includes(element.tagName))).toEqual([]);
        const [message, position, hint] = errors.children;
        expect(message.tagName).toBe('DIV');
        expect(message.textContent).toBe(PAYLOAD);
        expect(position.textContent).toBe('Line: 3 Column: 7');
        expect(hint.tagName).toBe('PRE');
        expect(hint.style.textAlign).toBe('left');
        expect(hint.textContent).toBe(`/echo ${SCRIPT_PAYLOAD}`);
    });

    test('generic errors render as literal text and keep valid messages', () => {
        for (const text of [PAYLOAD, 'Plain failure']) {
            const errors = render(new Error(text));
            expect(htmlAssignments).toEqual([]);
            expect(errors.children).toHaveLength(1);
            expect(errors.children[0].textContent).toBe(text);
            expect(errors.elements().map(element => element.tagName)).toEqual(['DIV', 'DIV']);
        }
    });
});

describe('TTS provider option labels', () => {
    const escapeHtmlSource = slice(readSource('../utils.js'), 'export function escapeHtml(str) {', '\n}\n') + '\n}';
    const escapeHtml = vm.runInNewContext(`(${escapeHtmlSource.replace('export function escapeHtml', 'function escapeHtml')})`);

    test('AllTalk escapes voice ids and names in generated option markup', async () => {
        jest.resetModules();
        jest.unstable_mockModule('../public/scripts/utils.js', () => ({ debounce: (fn) => fn, escapeHtml }));
        jest.unstable_mockModule('../public/scripts/extensions/tts/index.js', () => ({ saveTtsProviderSettings: jest.fn() }));
        const { AllTalkTtsProvider } = await import('../public/scripts/extensions/tts/alltalk.js');

        global.document = fakeDocument;
        const provider = new AllTalkTtsProvider();
        delete global.document;
        provider.voices = [
            { name: PAYLOAD, voice_id: 'x\' onmouseover=\'alert(1)' },
            { name: 'Normal Voice', voice_id: 'normal.wav' },
        ];
        provider.rvcVoices = [
            { name: SCRIPT_PAYLOAD, voice_id: 'r\' autofocus onfocus=\'alert(1)' },
            { name: 'RVC One', voice_id: 'rvc_one' },
        ];
        const html = provider.settingsHtml;

        expect(html).not.toContain(PAYLOAD);
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('value=\'x\' onmouseover');
        expect(html).not.toContain('value=\'r\' autofocus');
        expect(html).toContain('<option value=\'x&#39; onmouseover=&#39;alert(1)\'>&lt;img src=x onerror=alert(1)&gt;</option>');
        expect(html).toContain('<option value=\'normal.wav\'>Normal Voice</option>');
        expect(html).toContain('<option value=\'rvc_one\'>RVC One</option>');
        expect(html.match(/<option value='r&#39; autofocus onfocus=&#39;alert\(1\)'>/g)).toHaveLength(2);
    });

    test('Novel builds custom voice options without parsing HTML', async () => {
        jest.resetModules();
        jest.unstable_mockModule('../public/script.js', () => ({ getRequestHeaders: jest.fn() }));
        jest.unstable_mockModule('../public/scripts/popup.js', () => ({ POPUP_TYPE: {}, callGenericPopup: jest.fn() }));
        jest.unstable_mockModule('../public/scripts/utils.js', () => ({ splitRecursive: jest.fn() }));
        jest.unstable_mockModule('../public/scripts/extensions/tts/index.js', () => ({
            getPreviewString: jest.fn(),
            saveTtsProviderSettings: jest.fn(),
            initVoiceMap: jest.fn(),
        }));
        const { NovelTtsProvider } = await import('../public/scripts/extensions/tts/novel.js');

        const select = new FakeElement('select');
        select.empty = () => { select.children = []; return select; };
        global.document = fakeDocument;
        global.$ = () => select;
        global.Option = FakeOption;
        try {
            const provider = new NovelTtsProvider();
            provider.settings = { customVoices: [PAYLOAD, 'Normal Voice'] };
            provider.populateCustomVoices();
        } finally {
            delete global.document;
            delete global.$;
            delete global.Option;
        }

        expect(htmlAssignments).toEqual([]);
        expect(select.children.map(option => option.tagName)).toEqual(['OPTION', 'OPTION']);
        expect(select.children.map(option => option.value)).toEqual([PAYLOAD, 'Normal Voice']);
        expect(select.children.map(option => option.textContent)).toEqual([PAYLOAD, 'Normal Voice']);
        expect(select.elements().filter(element => element.tagName === 'IMG')).toEqual([]);
    });

    test('other TTS providers only interpolate fixed constants into option markup', () => {
        const dynamic = /<option[^>\n]*>[^<\n]*\$\{(?:voice|character|char|name|model|profile|item|entry)\b/;
        const ttsDir = path.join(extensionsDir, 'tts');
        for (const file of fs.readdirSync(ttsDir).filter(name => name.endsWith('.js'))) {
            expect({ file, unsafe: dynamic.test(fs.readFileSync(path.join(ttsDir, file), 'utf8')) }).toEqual({ file, unsafe: false });
        }
    });
});
