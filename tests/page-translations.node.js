import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import { load } from 'cheerio';

import { chooseRequestLocale, getPageTranslations, getSupportedLocales, parseAcceptLanguage, renderPageTemplate } from '../src/page-translations.js';
import { HTTPS_REQUIRED_MESSAGE } from '../src/error-pages.js';
import { templateKeys } from '../public/scripts/page-locale.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureLocales = path.join(root, 'tests', 'fixtures', 'page-locales');
const errorsFolder = path.join(root, 'default', 'content', 'errors');
const readPage = name => fs.readFileSync(path.join(errorsFolder, name), 'utf8');
const requestWith = acceptLanguage => ({ headers: acceptLanguage === undefined ? {} : { 'accept-language': acceptLanguage } });
const visibleText = html => load(html).root().text().replace(/\s+/g, ' ').trim();

function temporaryLocales(t) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-page-locales-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    fs.cpSync(fixtureLocales, folder, { recursive: true });
    return folder;
}

test('T1 parseAcceptLanguage reads quality, drops bad entries and keeps the order of equal ones', () => {
    assert.deepEqual(parseAcceptLanguage('de-DE,de;q=0.9,en;q=0.8'), ['de-DE', 'de', 'en']);
    assert.deepEqual(parseAcceptLanguage('en;q=0.5, de-DE, it;q=0.7'), ['de-DE', 'it', 'en']);
    assert.deepEqual(parseAcceptLanguage('de-DE;q=0, it-IT;q=0.5'), ['it-IT']);
    assert.deepEqual(parseAcceptLanguage('de;q=x, fr;q=2, it;q=0.1234, pt;q=1.0, *;q=0.3'), ['pt', '*']);
    assert.deepEqual(parseAcceptLanguage('<script>alert(1)</script>, "de-DE", de_DE, de-DE'), ['de-DE']);
    assert.deepEqual(parseAcceptLanguage(''), []);
    assert.deepEqual(parseAcceptLanguage(undefined), []);
    assert.deepEqual(parseAcceptLanguage(['de-DE']), []);
});

test('T1 chooseRequestLocale follows the server rows of the language table', () => {
    const real = { localesRoot: path.join(root, 'public', 'locales') };
    const cases = [
        ['de-DE,de;q=0.9,en;q=0.8', 'de-de'],
        ['fr-CH, fr-FR;q=0.9', 'fr-fr'],
        ['en-GB, de-DE;q=0.9', 'en'],
        ['de-DE;q=0, it-IT;q=0.5', 'it-it'],
        ['DE-de', 'de-de'],
        ['zh-TW', 'zh-tw'],
        ['zh-Hant-TW', 'zh-tw'],
        ['de', 'de-de'],
        ['pt-BR', 'pt-pt'],
        ['nb-NO', 'en'],
        ['*', 'en'],
        ['', 'en'],
        [undefined, 'en'],
        ['de-DE;q=x', 'en'],
        ['<script>', 'en'],
        ['"de-DE"', 'en'],
        ['ar-SA', 'ar-sa'],
    ];
    for (const [header, expected] of cases) {
        assert.equal(chooseRequestLocale(requestWith(header), real), expected, String(header));
    }
});

test('T1 only the first 1,000 characters and 32 entries of a header are read', () => {
    const real = { localesRoot: path.join(root, 'public', 'locales') };
    const tooManyEntries = [...Array.from({ length: 32 }, (_, index) => `x${index}`), 'de-DE'].join(',');
    assert.equal(chooseRequestLocale(requestWith(tooManyEntries), real), 'en');
    assert.equal(chooseRequestLocale(requestWith(`${Array.from({ length: 31 }, (_, index) => `x${index}`).join(',')},de-DE`), real), 'de-de');
    const tooLong = `${'x'.repeat(1100)},de-DE`;
    assert.equal(chooseRequestLocale(requestWith(tooLong), real), 'en');
    assert.equal(chooseRequestLocale(requestWith(`${'x'.repeat(5000)},de-DE`), real), 'en');
    assert.equal(chooseRequestLocale(requestWith(`de-DE,${'x'.repeat(5000)}`), real), 'de-de');
});

test('T1 an unreadable language list gives English and is not read again', t => {
    const warn = t.mock.method(console, 'warn', () => {});
    const missing = path.join(os.tmpdir(), 'neconyan-no-such-locales-folder');
    assert.deepEqual(getSupportedLocales({ localesRoot: missing }), []);
    assert.equal(chooseRequestLocale(requestWith('de-DE'), { localesRoot: missing }), 'en');
    assert.deepEqual(getSupportedLocales({ localesRoot: missing }), []);
    assert.equal(warn.mock.callCount(), 1);
});

test('T2 getPageTranslations merges the two files, keeps the requested keys only and refuses a value without its hole', async () => {
    const opts = { localesRoot: fixtureLocales };
    const hostKey = 'If you run this Neconyan, add the address you typed to open it (the hostname, such as a site name) to the allowed host list in ${0}, or turn host checking off there. The file is in the main Neconyan folder.';
    const translations = await getPageTranslations('de-de', ['Forbidden', 'Connection not secure', hostKey, 'Not in any file'], opts);
    assert.deepEqual([...translations.keys()].sort(), ['Connection not secure', 'Forbidden', hostKey, 'Not in any file'].sort());
    assert.equal(translations.get('Forbidden'), '«de» Verboten', 'the supplement wins over the base file');
    assert.equal(translations.get('Connection not secure'), '«de» Verbindung nicht sicher', 'a key only in the base file');
    assert.equal(translations.get(hostKey), null, 'the value lost its hole');
    assert.equal(translations.get('Not in any file'), null);
    const portuguese = await getPageTranslations('pt-pt', ['Forbidden', 'Connection not secure'], opts);
    assert.equal(portuguese.get('Forbidden'), '«pt» Proibido', 'a missing supplement file counts as empty');
    assert.equal(portuguese.get('Connection not secure'), null);
});

test('T2 English and an unsupported language read nothing', async t => {
    const readFile = t.mock.method(fs.promises, 'readFile');
    assert.equal((await getPageTranslations('en', ['Forbidden'], { localesRoot: fixtureLocales })).size, 0);
    assert.equal((await getPageTranslations('fr-fr', ['Forbidden'], { localesRoot: fixtureLocales })).size, 0);
    assert.equal((await getPageTranslations('../../etc', ['Forbidden'], { localesRoot: fixtureLocales })).size, 0);
    assert.equal(readFile.mock.callCount(), 0);
});

test('T2 a language is read once, and again only for keys not seen before', async t => {
    const folder = temporaryLocales(t);
    const readFile = t.mock.method(fs.promises, 'readFile');
    const first = await getPageTranslations('de-de', ['Forbidden'], { localesRoot: folder });
    assert.equal(first.get('Forbidden'), '«de» Verboten');
    const reads = readFile.mock.callCount();
    assert.equal(reads, 2);
    fs.writeFileSync(path.join(folder, 'neconyan', 'de-de.json'), JSON.stringify({ 'Forbidden': 'Changed on disk', 'Connection not secure': 'Changed too' }));
    const again = await getPageTranslations('de-de', ['Forbidden'], { localesRoot: folder });
    assert.equal(again.get('Forbidden'), '«de» Verboten', 'served from the cache');
    assert.equal(readFile.mock.callCount(), reads);
    const more = await getPageTranslations('de-de', ['Forbidden', 'Connection not secure'], { localesRoot: folder });
    assert.equal(more.get('Forbidden'), '«de» Verboten', 'a cached value is not read again');
    assert.equal(more.get('Connection not secure'), 'Changed too', 'a new key causes one more read');
    assert.equal(readFile.mock.callCount(), reads + 2);
    const concurrent = await Promise.all([
        getPageTranslations('pt-pt', ['Forbidden'], { localesRoot: folder }),
        getPageTranslations('pt-pt', ['Forbidden'], { localesRoot: folder }),
    ]);
    assert.equal(concurrent[0].get('Forbidden'), concurrent[1].get('Forbidden'));
    assert.equal(readFile.mock.callCount(), reads + 2 + 2, 'two requests at once share one read of a language');
});

test('T2 a file that cannot be parsed is logged once and tried again on the next request', async t => {
    const folder = temporaryLocales(t);
    const warn = t.mock.method(console, 'warn', () => {});
    fs.writeFileSync(path.join(folder, 'neconyan', 'de-de.json'), '{ not json');
    const broken = await getPageTranslations('de-de', ['Forbidden'], { localesRoot: folder });
    assert.equal(broken.get('Forbidden'), '«de» Verboten (base file)', 'the file that did load is still used');
    await getPageTranslations('de-de', ['Forbidden'], { localesRoot: folder });
    assert.equal(warn.mock.callCount(), 1, 'logged once per file');
    fs.writeFileSync(path.join(folder, 'neconyan', 'de-de.json'), JSON.stringify({ 'Forbidden': 'Repaired' }));
    const repaired = await getPageTranslations('de-de', ['Forbidden'], { localesRoot: folder });
    assert.equal(repaired.get('Forbidden'), 'Repaired', 'a failed read is not stored');
});

const GERMAN = { locale: 'de-de' };

async function renderGerman(name, context) {
    const source = readPage(name);
    const translations = await getPageTranslations('de-de', templateKeys(source), { localesRoot: fixtureLocales });
    return renderPageTemplate(source, { ...GERMAN, translations, context });
}

test('T3 the whitelist page renders in German with the address and the code element, in the order the translation needs', async () => {
    const direct = await renderGerman('forbidden-by-whitelist.html', { clientIp: '203.0.113.5', forwardedIp: '' });
    const $ = load(direct);
    assert.equal($('html').attr('lang'), 'de-de');
    assert.equal($('title').text(), '«de» Verboten');
    assert.equal($('h1').text(), '«de» Verboten');
    assert.match(direct, /«de» Bearbeiten Sie <code>config\.yaml<\/code> im Hauptordner/);
    assert.equal(direct.split('<code>config.yaml</code>').length, 2, 'the code element appears exactly once');
    assert.equal($('em').text(), '«de» Die Verbindung von 203.0.113.5 wurde blockiert.');

    const forwarded = await renderGerman('forbidden-by-whitelist.html', { clientIp: '203.0.113.5', forwardedIp: '198.51.100.7' });
    assert.equal(load(forwarded)('em').text(), '«de» Von 198.51.100.7 weitergeleitet: die Verbindung von 203.0.113.5 wurde blockiert.');
});

test('T3 an address from a header is only ever escaped', async () => {
    const hostile = '<img src=x onerror=1>';
    const html = await renderGerman('forbidden-by-whitelist.html', { clientIp: '203.0.113.5', forwardedIp: hostile });
    assert.equal(html.includes(hostile), false);
    assert.equal(load(html)('img').length, 0);
    assert.match(html, /&lt;img src&#x3D;x onerror&#x3D;1&gt;/);
    const english = renderPageTemplate(readPage('forbidden-by-whitelist.html'), { locale: 'en', translations: new Map(), context: { clientIp: hostile, forwardedIp: '' } });
    assert.equal(english.includes(hostile), false);
});

test('T3 the t helper fills holes with escaped text or a code element, and leaves a hole the call does not fill as written', () => {
    const source = '{{t "Keep ${0} and ${1}" "a"}}|{{t "Plain"}}|{{t "Code ${0}" (code "<b>")}}';
    const html = renderPageTemplate(source, { locale: 'de-de', translations: new Map([['Plain', '«de» Schlicht']]), context: {} });
    assert.equal(html, 'Keep a and ${1}|«de» Schlicht|Code <code>&lt;b&gt;</code>');
});

test('T3 in English the pages read as the pages of the previous release did', () => {
    const cases = [
        ['forbidden-by-whitelist.html', 'forbidden-by-whitelist.8a0722beee.html', { ipDetails: '203.0.113.5' }, { clientIp: '203.0.113.5', forwardedIp: '' }],
        ['forbidden-by-whitelist.html', 'forbidden-by-whitelist.8a0722beee.html', { ipDetails: '203.0.113.5 (forwarded from 198.51.100.7)' }, { clientIp: '203.0.113.5', forwardedIp: '198.51.100.7' }],
        ['host-not-allowed.html', 'host-not-allowed.06a5cedc65.html', {}, {}],
    ];
    for (const [current, previous, oldContext, newContext] of cases) {
        const before = Handlebars.compile(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'shipped-error-pages', previous), 'utf8'))(oldContext);
        const after = renderPageTemplate(readPage(current), { locale: 'en', translations: new Map(), context: newContext });
        assert.equal(visibleText(after), visibleText(before), current);
        assert.equal(load(after)('html').attr('lang'), 'en');
    }
});

test('T4 the HTTPS page renders in German and in English', async () => {
    const html = await renderGerman('https-required.html', {});
    const $ = load(html);
    assert.equal($('html').attr('lang'), 'de-de');
    assert.equal($('title').text(), '«de» Verbindung nicht sicher');
    assert.equal($('h1').text(), '«de» Verbindung nicht sicher');
    assert.equal(visibleText($('p').html()), '«de» Diese Verbindung ist nicht sicher. Bitte HTTPS in config.yaml einschalten, dann neu laden.');
    const english = load(renderPageTemplate(readPage('https-required.html'), { locale: 'en', translations: new Map(), context: {} }));
    assert.equal(english('html').attr('lang'), 'en');
    assert.equal(english('title').text(), 'Connection not secure');
    assert.equal(visibleText(english('p').html()), HTTPS_REQUIRED_MESSAGE);
});

test('T4 more than eight different templates all render correctly (the compiled-template cache evicts the oldest)', () => {
    const render = number => renderPageTemplate(`<p>{{t "Template ${number}"}}</p>`, { locale: 'en', translations: new Map(), context: {} });
    for (let number = 0; number < 20; number++) assert.equal(render(number), `<p>Template ${number}</p>`);
    assert.equal(render(0), '<p>Template 0</p>');
});
