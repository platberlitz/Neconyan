import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';

import { mergePageDictionary, pickLocale, templateKeys, translationFor } from '../public/scripts/page-locale.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const readJson = file => JSON.parse(read(file));
const languages = readJson('public/locales/lang.json');
const codes = languages.map(language => language.lang);
const pageKeys = readJson('tests/fixtures/page-text-keys.json');

// The 33 messages the sign-in page can show besides its captions (section 2.6 of the C5 plan, rows 22 to 54).
const LOGIN_MESSAGES = [
    'Could not load your accounts. Refresh to try again.',
    'Could not load the sign-in page. Refresh to try again.',
    'An error occurred',
    'Could not reach the server. Refresh to try again.',
    'That name or password did not match.',
    'Could not start the passkey sign-in.',
    'No passkey was chosen.',
    'We could not check that passkey. Try again.',
    'Sign-in was cancelled or timed out.',
    'The passkey could not be checked. Try again.',
    'Could not reach the server. Reload the page to try again.',
    'Type your username first.',
    'Type your password first.',
    'Some details are missing. Fill in every field and try again.',
    'That name or password is not correct.',
    'This account is turned off. Ask an admin to turn it back on.',
    'Too many attempts. Try again later or recover your password.',
    'That user could not be found.',
    'Too many attempts. Try again later or contact your admin.',
    'That code is not correct.',
    'Sign in from this server address.',
    'Too many attempts. Wait a minute and try again.',
    'Sign-in is unavailable right now.',
    'Sign-in failed unexpectedly.',
    'Could not work out this server address. Reload the page and try again.',
    'No passkey is enrolled on this server yet.',
    'Too many sign-in requests are waiting. Try again in a minute.',
    'Passkeys are unavailable right now.',
    'That sign-in request expired. Start again.',
    'That passkey is not enrolled on this server.',
    'The passkey could not be verified.',
    'You are signed out. Sign in to continue.',
    'Invalid CSRF token. Please refresh the page and try again.',
];

test('P1 pickLocale follows the browser and server rows of the language table', () => {
    // Single tags and lists by the shared rule; the stored rule and the full table are in tests/language-choice.node.js.
    assert.equal(pickLocale(['de-DE'], codes), 'de-de');
    assert.equal(pickLocale(['it-it'], codes), 'it-it');
    assert.equal(pickLocale(['en'], codes), 'en');
    assert.equal(pickLocale(['xx-yy'], codes), 'en');
    assert.equal(pickLocale(['de'], codes), 'de-de');
    assert.equal(pickLocale(['pt-BR'], codes), 'pt-pt');
    assert.equal(pickLocale(['en-GB'], codes), 'en');
    assert.equal(pickLocale(['*'], codes), 'en');
    assert.equal(pickLocale([''], codes), 'en');
    assert.equal(pickLocale([], codes), 'en');
    // Server rows: the whole parsed list, first match wins.
    assert.equal(pickLocale(['de-DE', 'de', 'en'], codes), 'de-de');
    assert.equal(pickLocale(['fr-CH', 'fr-FR'], codes), 'fr-fr');
    assert.equal(pickLocale(['en-GB', 'de-DE'], codes), 'en');
    assert.equal(pickLocale(['it-IT'], codes), 'it-it');
    assert.equal(pickLocale(['DE-de'], codes), 'de-de');
    assert.equal(pickLocale(['zh-TW'], codes), 'zh-tw');
    assert.equal(pickLocale(['zh-Hant-TW'], codes), 'zh-tw');
    assert.equal(pickLocale(['*', 'it-IT'], codes), 'it-it');
    assert.equal(pickLocale(['xx', 'pt-PT'], codes), 'pt-pt');
});

/** A top-level function as written in the file, as tests/label-name-captions.e2e.js cuts them. */
function declaration(text, name) {
    const match = text.match(new RegExp(`^(?:export )?(?:async )?(?:function|class) ${name}\\b[^]*?\\n}$`, 'm'));
    assert.ok(match, `${name} could not be cut out of public/scripts/i18n.js`);
    return match[0].replace(/^export /, '');
}

test('P2 the pages see the same translations as the app for every page key and message', async () => {
    const source = read('public/scripts/i18n.js');
    const files = new Map();
    const parsed = file => {
        if (!files.has(file)) files.set(file, fs.existsSync(path.join(root, file)) ? readJson(file) : null);
        return files.get(file);
    };
    const fetchStub = async url => {
        const data = parsed(path.posix.join('public', String(url).replace(/^\.\//, '')));
        return { ok: data !== null, json: async () => data };
    };
    const quiet = { log() {}, warn() {} };
    const factory = new Function('langs', 'fetch', 'console', `${declaration(source, 'findLang')}\n${declaration(source, 'getLocaleData')}\nreturn getLocaleData;`);
    const getLocaleData = factory(languages, fetchStub, quiet);
    const keys = [...new Set([...Object.values(pageKeys).flat(), ...LOGIN_MESSAGES])];
    assert.equal(keys.length, 73);
    for (const { lang } of languages) {
        const appDictionary = await getLocaleData(lang);
        const pageDictionary = mergePageDictionary(parsed(`public/locales/${lang}.json`), parsed(`public/locales/neconyan/${lang}.json`));
        for (const key of keys) {
            assert.equal(translationFor(pageDictionary, key), translationFor(appDictionary, key), `${lang}: ${key}`);
        }
    }
});

test('P3 translationFor accepts only a usable value with the key\'s holes', () => {
    const dictionary = {
        'Plain': 'Schlicht',
        'Blank': '   ',
        'Empty': '',
        'Same': 'Same',
        'Number': 7,
        'Two ${0} and ${1}': 'Zwei ${1} und ${0}',
        'Lost ${0} and ${1}': 'Verloren ${0}',
        'Doubled ${0}': 'Doppelt ${0} ${0}',
        'Extra ${0}': 'Zusatz ${0} ${1}',
        'No holes': 'Ohne ${0}',
        'Holes ${0}': 'Anders ${1}',
    };
    assert.equal(translationFor(dictionary, 'Plain'), 'Schlicht');
    assert.equal(translationFor(dictionary, 'Missing'), null);
    assert.equal(translationFor(dictionary, 'Blank'), null);
    assert.equal(translationFor(dictionary, 'Empty'), null);
    assert.equal(translationFor(dictionary, 'Same'), null);
    assert.equal(translationFor(dictionary, 'Number'), null);
    assert.equal(translationFor(dictionary, 'Two ${0} and ${1}'), 'Zwei ${1} und ${0}');
    assert.equal(translationFor(dictionary, 'Lost ${0} and ${1}'), null);
    assert.equal(translationFor(dictionary, 'Doubled ${0}'), null);
    assert.equal(translationFor(dictionary, 'Extra ${0}'), null);
    assert.equal(translationFor(dictionary, 'No holes'), null);
    assert.equal(translationFor(dictionary, 'Holes ${0}'), null);
    // Inherited names are not translations.
    assert.equal(translationFor({}, 'toString'), null);
    assert.equal(translationFor({}, 'constructor'), null);
    assert.equal(translationFor(null, 'Plain'), null);
    assert.equal(translationFor(dictionary, undefined), null);
});

test('P3b mergePageDictionary lets the supplement win and ignores a file that is not an object', () => {
    assert.deepEqual(mergePageDictionary({ a: '1', b: '2' }, { b: '3' }), { a: '1', b: '3' });
    assert.deepEqual(mergePageDictionary(['x'], null), {});
    assert.deepEqual(mergePageDictionary({ a: '1' }, 'text'), { a: '1' });
});

test('P4 templateKeys finds the keys of the three server templates', () => {
    for (const file of ['forbidden-by-whitelist', 'host-not-allowed', 'https-required']) {
        const page = `default/content/errors/${file}.html`;
        assert.deepEqual(templateKeys(read(page)), pageKeys[page], page);
    }
    assert.deepEqual(templateKeys('{{t "A"}} {{ t "B" x}} {{t "A"}} {{other "C"}}'), ['A', 'B']);
});

const collapse = text => text.replace(/\s+/g, ' ').trim();

/** The keys a client page marks, with the checks of the app's data-i18n convention. */
function markedKeys(file) {
    const $ = load(read(file));
    const found = [];
    $('[data-i18n]').each((_index, element) => {
        const specs = $(element).attr('data-i18n').split(';');
        assert.equal(specs.length, 1, `${file}: a data-i18n value with a semicolon would be split into several keys: ${specs[0]}`);
        const match = specs[0].match(/^\[([^\]]+)\](.+)$/s);
        if (match) {
            assert.ok(['alt', 'title', 'aria-label'].includes(match[1]), `${file}: ${match[1]} is not an attribute the loader writes`);
            assert.equal($(element).attr(match[1]), match[2], `${file}: attribute ${match[1]}`);
            found.push(match[2]);
        } else {
            assert.equal(collapse($(element).text()), specs[0], `${file}: text of ${element.name}`);
            found.push(specs[0]);
        }
    });
    $('[data-i18n-compose]').each((_index, element) => {
        const key = $(element).attr('data-i18n-compose');
        const clone = $(element).clone();
        const children = clone.children().toArray();
        children.forEach((child, index) => $(child).replaceWith('${' + index + '}'));
        assert.equal(collapse(clone.text()), key, `${file}: composed text`);
        assert.equal(children.length, (key.match(/\$\{\d+\}/g) ?? []).length, `${file}: holes of ${key}`);
        found.push(key);
    });
    return found;
}

test('P5 the marked texts of the client pages are the keys of the fixture, and the keys of the fixture are 40', () => {
    for (const file of ['public/login.html', 'default/content/errors/invalid-csrf.html', 'default/content/errors/url-not-found.html']) {
        assert.deepEqual([...new Set(markedKeys(file))].sort(), [...pageKeys[file]].sort(), file);
    }
    for (const file of ['forbidden-by-whitelist', 'host-not-allowed', 'https-required']) {
        const page = `default/content/errors/${file}.html`;
        assert.deepEqual([...templateKeys(read(page))].sort(), [...pageKeys[page]].sort(), page);
    }
    assert.deepEqual(Object.keys(pageKeys), [
        'public/login.html',
        'default/content/errors/invalid-csrf.html',
        'default/content/errors/url-not-found.html',
        'default/content/errors/forbidden-by-whitelist.html',
        'default/content/errors/host-not-allowed.html',
        'default/content/errors/https-required.html',
    ]);
    assert.equal(Object.values(pageKeys).flat().length, 41);
    assert.equal(new Set(Object.values(pageKeys).flat()).size, 40);
    for (const keys of Object.values(pageKeys)) assert.equal(new Set(keys).size, keys.length);
});

// The attributes of every input as the page shipped them before C5: password managers key on these.
const LOGIN_INPUTS = {
    workspaceUsername: { id: 'workspaceUsername', name: 'username', type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', maxlength: '320', required: '' },
    workspacePassword: { id: 'workspacePassword', name: 'password', type: 'password', autocomplete: 'current-password', maxlength: '4096', required: '' },
    rememberDevice: { id: 'rememberDevice', type: 'checkbox' },
    userHandle: { id: 'userHandle', type: 'text', autocomplete: 'username' },
    userPassword: { id: 'userPassword', type: 'password', autocomplete: 'current-password' },
    recoveryCode: { id: 'recoveryCode', type: 'text', autocomplete: 'one-time-code' },
    newPassword: { id: 'newPassword', type: 'password', autocomplete: 'new-password' },
};

test('P6 the sign-in markup never lets the loader touch a field', () => {
    const $ = load(read('public/login.html'));
    const controls = 'input,select,textarea';
    const withAncestorsOfControls = [];
    $('[data-i18n],[data-i18n-compose]').each((_index, element) => {
        const id = $(element).attr('id') ?? element.name;
        const specs = $(element).attr('data-i18n-compose') !== undefined ? ['compose'] : $(element).attr('data-i18n').split(';');
        const attributeOnly = specs.every(spec => /^\[[^\]]+\]/.test(spec));
        assert.ok(!$(element).is(`${controls},option`), `${id} is a field`);
        if (!attributeOnly) {
            assert.equal($(element).children().length, 0, `${id}: a text key on an element with children`);
            assert.equal($(element).find(controls).length, 0, `${id}: a text key on an ancestor of a field`);
            assert.ok(!($(element).is('label') && $(element).find(controls).length), `${id}: a label that contains a field`);
        }
        if ($(element).find(controls).length) {
            assert.ok(attributeOnly, `${id}: an ancestor of a field must carry attribute keys only`);
            withAncestorsOfControls.push(id);
        }
    });
    // The passkey section holds a button only; the two sections that hold fields carry their aria-label key and nothing else.
    assert.deepEqual(withAncestorsOfControls.sort(), ['userSelectBlock', 'workspaceLoginBlock']);
    assert.deepEqual(['workspaceLoginBlock', 'passkeyLoginBlock', 'userSelectBlock'].map(id => $(`#${id}`).attr('data-i18n')),
        ['[aria-label]Workspace sign-in', '[aria-label]Passkey sign-in', '[aria-label]Account sign-in']);
    assert.equal($('head style').length, 0, 'no inline style in the head');
    assert.equal($('head script').length, 0, 'no inline script in the head');
    const inputs = {};
    $('input').each((_index, element) => { inputs[element.attribs.id] = { ...element.attribs }; });
    assert.deepEqual(inputs, LOGIN_INPUTS);
});
