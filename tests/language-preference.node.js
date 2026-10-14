/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { BROWSER_LANGUAGE, LANGUAGE_CHOICE_KEY, initialLanguageChoice, isNewLanguageInstallation, readLanguageChoice, saveLanguagePreference, effectiveLanguagePreference } from '../public/scripts/page-locale.js';

const codes = ['de-de', 'it-it', 'pt-pt', 'zh-cn', 'zh-tw'];
const german = ['de', 'en-US', 'en'];

test('existing and ambiguous users retain the pre-C8 effective language', () => {
    for (const languages of [german, ['de-AT'], ['nb', 'de-DE'], ['en-US', 'de']]) {
        const result = initialLanguageChoice(null, languages, codes);
        assert.equal(result.locale, 'en');
        assert.equal(result.prompt, result.suggested !== 'en');
    }
    for (const code of codes) {
        const result = initialLanguageChoice(null, [code, 'en'], codes);
        assert.equal(result.locale, code);
        assert.equal(result.prompt, false);
    }
});

test('only positively identified new settings follow broader browser matching automatically', () => {
    const defaults = JSON.parse(fs.readFileSync(new URL('../default/content/settings.json', import.meta.url)));
    assert.equal(isNewLanguageInstallation({ settings: JSON.stringify(defaults) }), true);
    for (const settings of [{}, { firstRun: true }, { firstRun: false }, { accountStorage: { 'NeconyanTutorialStatus.v1': 'skipped' } }]) {
        assert.equal(isNewLanguageInstallation({ settings: JSON.stringify(settings) }), false);
    }
    assert.equal(isNewLanguageInstallation({ settings: '{bad' }), false);
    const result = initialLanguageChoice(null, german, codes, { newInstallation: true });
    assert.equal(result.locale, 'de-de');
    assert.equal(result.prompt, false);
    assert.equal(result.record.mode, 'browser');
});

test('saved English, other languages and explicit browser mode always win without a prompt', () => {
    for (const [stored, expected] of [['en', 'en'], ['it-it', 'it-it'], [BROWSER_LANGUAGE, 'de-de'], ['obsolete', 'en']]) {
        const result = initialLanguageChoice(stored, german, codes);
        assert.equal(result.locale, expected);
        assert.equal(result.prompt, false);
    }
});

test('legacy retention and dismissal survive reloads and later browser changes', () => {
    const pending = initialLanguageChoice(null, german, codes).record;
    assert.equal(initialLanguageChoice(null, ['it'], codes, { record: pending }).locale, 'en');
    assert.equal(initialLanguageChoice(null, ['it'], codes, { record: pending }).prompt, true);
    const dismissed = { mode: 'fixed', locale: 'en', handled: true };
    const result = initialLanguageChoice(null, ['it'], codes, { record: dismissed, newInstallation: true });
    assert.equal(result.locale, 'en');
    assert.equal(result.prompt, false);
    const translated = initialLanguageChoice(null, ['de-DE'], codes).record;
    assert.equal(initialLanguageChoice(null, ['en-US'], codes, { record: translated }).locale, 'de-de');
});

test('new automatic profiles and explicit browser choices follow later browser changes', () => {
    const record = initialLanguageChoice(null, german, codes, { newInstallation: true }).record;
    assert.equal(initialLanguageChoice(null, ['it'], codes, { record }).locale, 'it-it');
    assert.equal(initialLanguageChoice(BROWSER_LANGUAGE, ['en-US', 'de'], codes).locale, 'en');
    assert.equal(initialLanguageChoice(BROWSER_LANGUAGE, ['zh-Hant-CN'], codes).locale, 'zh-tw');
});

function withStorage(storage, fn) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    try { fn(); } finally {
        if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
        else delete globalThis.localStorage;
    }
}

test('sign-in and app share explicit preference and acknowledgement persistence', () => {
    const values = new Map();
    withStorage({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, () => {
        saveLanguagePreference('');
        assert.equal(values.get('language'), BROWSER_LANGUAGE);
        assert.equal(readLanguageChoice().handled, true);
        saveLanguagePreference('en');
        assert.equal(effectiveLanguagePreference(), 'en');
        assert.equal(JSON.parse(values.get(LANGUAGE_CHOICE_KEY)).locale, 'en');
    });
});

test('acknowledgement still preserves dismissal when the language-key write fails', () => {
    const values = new Map();
    withStorage({ getItem: key => values.get(key) ?? null, setItem: (key, value) => {
        if (key === 'language') throw new Error('blocked');
        values.set(key, value);
    } }, () => {
        assert.doesNotThrow(() => saveLanguagePreference('en'));
        assert.equal(effectiveLanguagePreference(), 'en');
        assert.equal(initialLanguageChoice(null, german, codes, { record: readLanguageChoice() }).prompt, false);
    });
});

test('blocked storage and malformed acknowledgements never block language selection', () => {
    withStorage({ getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } }, () => {
        assert.equal(readLanguageChoice(), null);
        assert.equal(effectiveLanguagePreference(), null);
        assert.doesNotThrow(() => saveLanguagePreference('it-it'));
    });
    for (const value of ['{bad', '{}', 'null', '{"mode":"fixed","locale":"en"}']) {
        withStorage({ getItem: () => value }, () => assert.equal(readLanguageChoice(), null));
    }
});
