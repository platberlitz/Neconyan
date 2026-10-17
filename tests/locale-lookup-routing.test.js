/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

// The real public/scripts/i18n.js, run in Node with its imports mocked and the few browser objects it touches replaced
// by small stand-ins. These tests cover how the two tables are loaded and read: a 'scoped.' key is looked up in the
// scoped table only, every other key in the matching dictionary, and each table alone is enough to count as loaded.
// The assembly itself is covered by tests/locale-scoped-keys.node.js. The in-app check happens in stage 4.

const PORTUGUESE = [{ lang: 'pt-pt', display: 'Português' }];
const FILES = {
    'pt-pt.json': { Open: 'Abrir', Close: 'Fechar' },
    'neconyan/en.json': { 'old.symbolic': 'Plain English', 'scoped.x.short': 'Completed', 'scoped.x.template': 'Message ${0}, image ${1}' },
    'neconyan/pt-pt.json': {
        'old.symbolic': 'Inglês simples',
        'scoped.x.short': 'Concluído',
        'scoped.x.template': 'Mensagem ${0}, imagem ${1}',
        'scoped.x.title': 'Título',
        'scoped.x.empty': '',
    },
};
const SCOPED_ONLY = { 'pt-pt.json': {}, 'neconyan/pt-pt.json': { 'scoped.x.short': 'Concluído', 'scoped.x.title': 'Título' } };
const DICTIONARY_ONLY = { 'pt-pt.json': { Open: 'Abrir' }, 'neconyan/pt-pt.json': {} };

class FakeElement {
    constructor(attributes = {}, text = '') {
        this.nodeType = 1;
        this.attributes = { ...attributes };
        this.textContent = text;
    }
    getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
    setAttribute(name, value) { this.attributes[name] = value; }
    querySelectorAll() { return []; }
}

class FakeDocument {
    constructor() { this.documentElement = {}; }
    querySelectorAll() { return []; }
}

const element = (key, text = '', attributes = {}) => new FakeElement({ 'data-i18n': key, ...attributes }, text);

// Just enough of jQuery for applyLocale() and getMissingTranslations(): the page's data-i18n elements are `page.elements`.
function createJquery(page) {
    const wrap = items => ({
        each(callback) {
            items.forEach((item, index) => callback.call(item, index, item));
            return this;
        },
        find: selector => wrap(selector === '[data-i18n]' ? page.elements : []),
        get: index => items[index],
        on: jest.fn(),
        data: name => items[0].getAttribute(`data-${name}`),
        attr: name => items[0].getAttribute(name),
        text: () => items[0].textContent,
    });
    return target => wrap(typeof target === 'string' ? [] : [target]);
}

function installPage({ tracking = false } = {}) {
    const page = { document: new FakeDocument(), elements: [], observers: [] };
    globalThis.Document = FakeDocument;
    globalThis.Element = FakeElement;
    globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
    globalThis.document = page.document;
    globalThis.MutationObserver = class {
        constructor(callback) { page.observers.push(callback); }
        observe() {}
    };
    globalThis.$ = createJquery(page);
    globalThis.toastr = { success: jest.fn(), info: jest.fn(), warning: jest.fn() };
    globalThis.localStorage = { getItem: key => (tracking && key === 'trackDynamicTranslate' ? 'true' : null), setItem: jest.fn() };
    return page;
}

function installFetch({ languages, files, failing }) {
    const ok = data => ({ ok: true, json: async () => data });
    globalThis.fetch = jest.fn(async url => {
        const name = String(url).replace(/^\.?\/?locales\//, '');
        if (failing.includes(name)) throw new TypeError('Failed to fetch');
        if (name === 'lang.json') return ok(languages);
        return Object.hasOwn(files, name) ? ok(files[name]) : { ok: false, json: async () => ({}) };
    });
}

function registerMocks(locale) {
    const mocks = {
        localizeControls: jest.fn(),
        localizeString: jest.fn((text, dictionary) => dictionary[text] ?? text),
        registerDebugFunction: jest.fn(),
        updateSecretDisplay: jest.fn(),
    };
    jest.unstable_mockModule('../public/scripts/page-locale.js', () => ({
        BROWSER_LANGUAGE: 'browser',
        addLanguageOptions: jest.fn(),
        browserLanguages: jest.fn(() => []),
        initialLanguageChoice: jest.fn(() => ({ locale, suggested: locale, prompt: false, record: null })),
        isNewLanguageInstallation: jest.fn(() => false),
        readLanguageChoice: jest.fn(() => null),
        saveLanguagePreference: jest.fn(),
        storedLanguage: jest.fn(() => null),
        writeLanguageChoice: jest.fn(),
    }));
    jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ registerDebugFunction: mocks.registerDebugFunction }));
    jest.unstable_mockModule('../public/scripts/secrets.js', () => ({ updateSecretDisplay: mocks.updateSecretDisplay }));
    jest.unstable_mockModule('../public/scripts/ui-localization.js', () => ({ localizeControls: mocks.localizeControls, localizeString: mocks.localizeString }));
    return mocks;
}

// Imports a fresh i18n.js. It does not call initLocales(), so a test can look things up before loading.
async function importI18n({ locale = 'pt-pt', languages = PORTUGUESE, files = FILES, failing = [], tracking = false } = {}) {
    const page = installPage({ tracking });
    installFetch({ languages, files, failing });
    const mocks = registerMocks(locale);
    const i18n = await import('../public/scripts/i18n.js');
    return { i18n, page, mocks };
}

async function loadI18n(options) {
    const loaded = await importI18n(options);
    await loaded.i18n.initLocales({});
    return loaded;
}

describe('scoped key lookups', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'table').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
        for (const name of ['Document', 'Element', 'Node', 'document', 'MutationObserver', '$', 'toastr', 'localStorage', 'fetch']) delete globalThis[name];
    });

    describe('translate', () => {
        test('a scoped key reads the scoped table, and a plain key reads the matching dictionary', async () => {
            const { i18n } = await loadI18n();

            expect(i18n.getCurrentLocale()).toBe('pt-pt');
            expect(i18n.translate('Open')).toBe('Abrir');
            expect(i18n.translate('Completed', 'scoped.x.short')).toBe('Concluído');
            expect(i18n.translate('Message ${0}, image ${1}', 'scoped.x.template')).toBe('Mensagem ${0}, imagem ${1}');
            expect(i18n.translate('scoped.x.short')).toBe('Concluído');
            // The English caption of a scoped key finds nothing: it is not an alias of the key.
            expect(i18n.translate('Completed')).toBe('Completed');
            expect(i18n.translate('Message ${0}, image ${1}')).toBe('Message ${0}, image ${1}');
            // A symbolic key from the catalogue is still aliased under its English text.
            expect(i18n.translate('Plain English')).toBe('Inglês simples');
        });

        test('a scoped key with no entry returns the English text', async () => {
            const { i18n } = await loadI18n();

            expect(i18n.translate('Nothing here', 'scoped.x.unknown')).toBe('Nothing here');
            expect(i18n.translate('Unknown')).toBe('Unknown');
            // An empty value counts as no translation, as it does for every other key.
            expect(i18n.translate('Empty', 'scoped.x.empty')).toBe('Empty');
        });

        test('the t tag keeps reading the matching dictionary only', async () => {
            const { i18n } = await loadI18n({ files: { ...FILES, 'pt-pt.json': { 'Open ${0}': 'Abrir ${0}' } } });

            const name = 'chat';
            expect(i18n.t`Open ${name}`).toBe('Abrir chat');
        });

        test('a lookup made before loading returns the English text', async () => {
            const { i18n } = await importI18n();

            expect(i18n.translate('Completed', 'scoped.x.short')).toBe('Completed');
            expect(i18n.translate('Open')).toBe('Open');
            expect(i18n.getCurrentLocale()).toBe('en');
        });

        test('data in the scoped table alone is enough: scoped keys translate and plain keys stay English', async () => {
            const { i18n } = await loadI18n({ files: SCOPED_ONLY });

            expect(i18n.getCurrentLocale()).toBe('pt-pt');
            expect(globalThis.document.documentElement.lang).toBe('pt-pt');
            expect(i18n.translate('Completed', 'scoped.x.short')).toBe('Concluído');
            expect(i18n.translate('Open')).toBe('Open');
        });

        test('data in the matching dictionary alone is enough: plain keys translate and scoped keys stay English', async () => {
            const { i18n } = await loadI18n({ files: DICTIONARY_ONLY });

            expect(i18n.getCurrentLocale()).toBe('pt-pt');
            expect(i18n.translate('Open')).toBe('Abrir');
            expect(i18n.translate('Completed', 'scoped.x.short')).toBe('Completed');
        });

        test('with no data in either table the interface falls back to English', async () => {
            const { i18n } = await loadI18n({ files: {} });

            expect(i18n.getCurrentLocale()).toBe('en');
            expect(globalThis.document.documentElement.lang).toBe('en');
            expect(i18n.translate('Completed', 'scoped.x.short')).toBe('Completed');
        });

        test.each([
            ['the dictionary', 'pt-pt.json'],
            ['the catalogue', 'neconyan/en.json'],
            ['the supplement', 'neconyan/pt-pt.json'],
        ])('a failed fetch of %s clears both tables and shows English everywhere, scoped lookups included', async (_name, failing) => {
            const { i18n, mocks, page } = await loadI18n({ failing: [failing] });

            expect(i18n.getCurrentLocale()).toBe('en');
            expect(globalThis.document.documentElement.lang).toBe('en');
            expect(console.warn).toHaveBeenCalledWith('Dictionary unavailable; using English.', expect.any(TypeError));
            for (const [english, key] of [['Completed', 'scoped.x.short'], ['Open', 'Open'], ['Title', 'scoped.x.title']]) {
                expect(i18n.translate(english, key)).toBe(english);
            }
            // The page is left as the markup wrote it: nothing is applied, and the observer stays quiet.
            const caption = element('scoped.x.short', 'Completed');
            page.elements.push(caption);
            i18n.applyLocale();
            page.observers[0]([{ addedNodes: [caption], attributeName: null, target: caption }]);
            expect(caption.textContent).toBe('Completed');
            expect(mocks.localizeControls).not.toHaveBeenCalled();
            // Both tables exist but are empty, so data added later is accepted into either one.
            i18n.addLocaleData('en', { 'scoped.x.late': 'Tarde', Late: 'Tarde também' });
            expect(i18n.translate('Late', 'scoped.x.late')).toBe('Tarde');
            expect(i18n.translate('Late')).toBe('Tarde também');
        });

        test('the English interface returns the English text for every scoped key', async () => {
            const { i18n } = await loadI18n({ locale: 'en' });

            expect(i18n.getCurrentLocale()).toBe('en');
            expect(globalThis.fetch.mock.calls.map(([url]) => String(url))).toEqual(['/locales/lang.json']);
            expect(i18n.translate('Completed', 'scoped.x.short')).toBe('Completed');
            expect(i18n.translate('Open')).toBe('Open');
        });

        test('an English dictionary that is loaded ignores a scoped entry it should not hold', async () => {
            const english = { lang: 'en', display: 'English' };
            const { i18n } = await loadI18n({
                locale: 'en', languages: [english, ...PORTUGUESE], files: { 'en.json': { Open: 'Opened', 'scoped.x.short': 'Stray' } },
            });

            expect(i18n.getCurrentLocale()).toBe('en');
            expect(i18n.translate('Open')).toBe('Opened');
            expect(i18n.translate('Completed', 'scoped.x.short')).toBe('Completed');
            expect(globalThis.fetch.mock.calls.map(([url]) => String(url))).toEqual(['/locales/lang.json', './locales/en.json']);
        });
    });

    describe('data-i18n elements', () => {
        test('a scoped key sets text or an attribute from the scoped table, in any position of a multi-key list', async () => {
            const { i18n, page } = await loadI18n();
            const text = element('scoped.x.short', 'Completed');
            const attribute = element('[title]scoped.x.title', 'Body', { title: 'Title' });
            const both = element('[title]Open;scoped.x.short', 'Completed', { title: 'Open' });
            const empty = element('scoped.x.empty', 'Kept English?');
            page.elements.push(text, attribute, both, empty);
            i18n.applyLocale();

            expect(text.textContent).toBe('Concluído');
            expect(attribute.getAttribute('title')).toBe('Título');
            expect(attribute.textContent).toBe('Body');
            expect(both.getAttribute('title')).toBe('Abrir');
            expect(both.textContent).toBe('Concluído');
            // An empty value is applied, as it is for a plain key.
            expect(empty.textContent).toBe('');
        });

        test('a plain key still reads the matching dictionary, and the English text of a scoped key matches nothing', async () => {
            const { i18n, page } = await loadI18n();
            const plain = element('Open', 'Open');
            const alias = element('Plain English', 'Plain English');
            const english = element('Completed', 'Completed');
            const unknown = element('scoped.x.unknown', 'Left as written');
            page.elements.push(plain, alias, english, unknown);
            i18n.applyLocale();

            expect(plain.textContent).toBe('Abrir');
            expect(alias.textContent).toBe('Inglês simples');
            expect(english.textContent).toBe('Completed');
            expect(unknown.textContent).toBe('Left as written');
        });

        test('with data only in the scoped table the page is still applied, and the localiser gets an empty dictionary', async () => {
            const { i18n, mocks, page } = await loadI18n({ files: SCOPED_ONLY });
            const text = element('scoped.x.short', 'Completed');
            const plain = element('Open', 'Open');
            page.elements.push(text, plain);
            i18n.applyLocale();

            expect(text.textContent).toBe('Concluído');
            expect(plain.textContent).toBe('Open');
            expect(mocks.localizeControls).toHaveBeenLastCalledWith(page.document, {});
        });

        test('with data only in the matching dictionary a scoped key keeps its markup text', async () => {
            const { i18n, page } = await loadI18n({ files: DICTIONARY_ONLY });
            const text = element('scoped.x.short', 'Completed');
            const plain = element('Open', 'Open');
            page.elements.push(text, plain);
            i18n.applyLocale();

            expect(text.textContent).toBe('Completed');
            expect(plain.textContent).toBe('Abrir');
        });

        test('the observer translates added and changed elements from either table once either has data', async () => {
            const { page } = await loadI18n({ files: SCOPED_ONLY });
            const added = element('scoped.x.short', 'Completed');
            const changed = element('[title]scoped.x.title', '', { title: 'Title' });
            page.observers[0]([
                { addedNodes: [added], attributeName: null, target: added },
                { addedNodes: [], attributeName: 'data-i18n', target: changed },
            ]);

            expect(added.textContent).toBe('Concluído');
            expect(changed.getAttribute('title')).toBe('Título');
        });
    });

    describe('what the run-time localiser reads', () => {
        test('the localiser and localizeMessage get the matching dictionary, with no scoped key and no scoped alias in it', async () => {
            const { i18n, mocks, page } = await loadI18n();
            const [root, dictionary] = mocks.localizeControls.mock.calls[0];

            expect(root).toBe(page.document);
            expect(Object.keys(dictionary).sort()).toEqual(['Close', 'Open', 'Plain English', 'old.symbolic']);
            expect(i18n.localizeMessage('Completed')).toBe('Completed');
            expect(i18n.localizeMessage('Open')).toBe('Abrir');
            expect(mocks.localizeString.mock.calls.every(([, used]) => used === dictionary)).toBe(true);
        });

        test('localizeMessage returns the text as written before loading', async () => {
            const { i18n } = await importI18n();

            expect(i18n.localizeMessage('Open')).toBe('Open');
            expect(i18n.localizeMessage(undefined)).toBe('');
        });
    });

    describe('addLocaleData', () => {
        test('a scoped key goes to the scoped table and a plain key to the dictionary, and nothing is overridden', async () => {
            const { i18n, mocks } = await loadI18n();
            i18n.addLocaleData('pt-pt', {
                'scoped.x.new': 'Novo', 'scoped.x.short': 'Override?', Extra: 'Extra pt', Open: 'Override?',
            });

            expect(i18n.translate('New', 'scoped.x.new')).toBe('Novo');
            expect(i18n.translate('Extra')).toBe('Extra pt');
            expect(i18n.translate('Completed', 'scoped.x.short')).toBe('Concluído');
            expect(i18n.translate('Open')).toBe('Abrir');
            // The scoped addition is not reachable through the matching dictionary.
            i18n.applyLocale();
            const dictionary = mocks.localizeControls.mock.calls.at(-1)[1];
            expect(Object.hasOwn(dictionary, 'scoped.x.new')).toBe(false);
            expect(Object.hasOwn(dictionary, 'New')).toBe(false);
            expect(Object.hasOwn(dictionary, 'Extra')).toBe(true);
        });

        test('data for another language, or added before loading, is ignored', async () => {
            const before = await importI18n();
            before.i18n.addLocaleData('pt-pt', { 'scoped.x.new': 'Novo' });
            expect(console.warn).toHaveBeenCalledWith('Localization data not loaded yet. Additional data will not be added.');
            expect(before.i18n.translate('New', 'scoped.x.new')).toBe('New');

            jest.resetModules();
            const { i18n } = await loadI18n();
            i18n.addLocaleData('de-de', { 'scoped.x.new': 'Neu' });
            expect(i18n.translate('New', 'scoped.x.new')).toBe('New');
        });

        test('a scoped entry added to an English interface counts as data, so the observer starts working', async () => {
            const { i18n, page } = await loadI18n({ files: {} });
            const before = element('scoped.x.short', 'Completed');
            page.observers[0]([{ addedNodes: [before], attributeName: null, target: before }]);
            expect(before.textContent).toBe('Completed');

            i18n.addLocaleData('en', { 'scoped.x.short': 'Done' });
            const after = element('scoped.x.short', 'Completed');
            page.observers[0]([{ addedNodes: [after], attributeName: null, target: after }]);
            expect(after.textContent).toBe('Done');
            expect(i18n.translate('Completed', 'scoped.x.short')).toBe('Done');
        });
    });

    describe('missing translation tracking and the debug report', () => {
        const registeredReport = mocks => mocks.registerDebugFunction.mock.calls.find(([id]) => id === 'getMissingTranslations')[3];
        const reportedKeys = () => console.table.mock.calls.at(-1)[0].map(row => row.key);

        test('translate tracks a missing key in whichever table applies, and not a scoped key that is present', async () => {
            const { i18n, mocks } = await loadI18n({ tracking: true });
            i18n.translate('Completed', 'scoped.x.short');
            i18n.translate('Open');
            i18n.translate('Nothing here', 'scoped.x.unknown');
            i18n.translate('Unknown plain');
            await registeredReport(mocks)();

            expect([...reportedKeys()].sort()).toEqual(['Unknown plain', 'scoped.x.unknown']);
        });

        test('the debug report uses the same lookup, so a present scoped key is not reported missing', async () => {
            const { mocks, page } = await loadI18n({ tracking: true });
            page.elements.push(
                element('scoped.x.short', 'Completed'),
                element('[title]scoped.x.title', '', { title: 'Title' }),
                element('scoped.x.unknown', 'Unknown'),
                element('Open', 'Open'),
                element('Absent plain', 'Absent plain'),
                element('[title]scoped.x.absent', '', { title: 'Absent title' }),
            );
            await registeredReport(mocks)();

            expect(console.table.mock.calls.at(-1)[0]).toEqual([
                { key: 'Absent plain', language: 'pt-pt', value: 'Absent plain' },
                { key: '[title]scoped.x.absent', language: 'pt-pt', value: 'Absent title' },
                { key: 'scoped.x.unknown', language: 'pt-pt', value: 'Unknown' },
            ].sort((a, b) => a.language.localeCompare(b.language) || a.key.localeCompare(b.key)));
            expect(globalThis.toastr.success).toHaveBeenCalledTimes(1);
        });

        test('tracking is off for an English interface, so scoped lookups track nothing', async () => {
            const { i18n, mocks } = await loadI18n({ locale: 'en', tracking: true, files: {} });
            i18n.translate('Nothing here', 'scoped.x.unknown');
            await registeredReport(mocks)();

            expect(reportedKeys()).not.toContain('scoped.x.unknown');
        });
    });
});
