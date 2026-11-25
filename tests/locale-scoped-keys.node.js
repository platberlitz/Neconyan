import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { assembleLocaleData, isScopedKey, tableForKey } from '../public/scripts/locale-assembly.js';
import { localizeString } from '../public/scripts/ui-localization.js';

// Scoped keys ('scoped.' prefix) are for strings that only translate() and data-i18n may reach. The loader must keep
// them, and their English text, out of the dictionary the run-time localiser matches page text against.

const readJson = file => JSON.parse(readFileSync(new URL(`../public/locales/${file}`, import.meta.url), 'utf8'));
const LANGUAGES = ['pt-pt', 'it-it', 'de-de'];
const NANO_REASONING_SCOPED_KEY = 'scoped.nanogpt.reasoning.unavailable';
const SCRATCHPAD_HISTORY_SCOPED_KEY = 'scoped.scratchpad.HIS-01';
const STORY_MODE_WORD_COUNT_KEYS = ['scoped.story_mode.word_count_one', 'scoped.story_mode.word_count_many'];
const HOPPER_TIMELINE_KEYS = ['scoped.hopper.timeline_default', 'scoped.hopper.timeline_numbered'];
const EXTRA_SCOPED_KEYS = [
    NANO_REASONING_SCOPED_KEY,
    SCRATCHPAD_HISTORY_SCOPED_KEY,
    'scoped.connections.openai_follow',
    'scoped.hopper.follow',
    'scoped.horde.enter_anonymous',
    'scoped.key.enter',
    'scoped.action.change',
    ...STORY_MODE_WORD_COUNT_KEYS,
    ...HOPPER_TIMELINE_KEYS,
];
const ALL_LOCALES = readJson('lang.json').filter(entry => entry.lang !== 'en').map(entry => entry.lang);
const catalogue = readJson('neconyan/en.json');
const files = Object.fromEntries(LANGUAGES.map(language => [language, { base: readJson(`${language}.json`), supplement: readJson(`neconyan/${language}.json`), catalogue }]));
const allFiles = Object.fromEntries(ALL_LOCALES.map(language => [language, { base: readJson(`${language}.json`), supplement: readJson(`neconyan/${language}.json`), catalogue }]));

// A copy of the assembly getLocaleData() did before scoped keys existed. The new function must match it exactly.
function todaysAssembly({ base, supplement, catalogue: source }) {
    const combined = { ...base, ...supplement };
    for (const [key, english] of Object.entries(source)) {
        if (combined[key] && !Object.hasOwn(combined, english)) combined[english] = combined[key];
    }
    return combined;
}

// The same inputs without any scoped entry, so the old assembly and the new one are compared on what the old one knew. Real
// translated scoped keys (the image-choice ones) would otherwise be aliased by the old assembly and fail that comparison.
function stripScoped({ base, supplement, catalogue: source }) {
    const plain = table => Object.fromEntries(Object.entries(table).filter(([key]) => !isScopedKey(key)));
    return {
        base: plain(base),
        supplement: plain(supplement),
        catalogue: Object.fromEntries(Object.entries(source).filter(([key, english]) => !isScopedKey(key) && !isScopedKey(english))),
    };
}

// The scoped table the new assembly must produce, derived from the files without calling it: the scoped entries of the merged
// base and supplement, in the order of locale-assembly.js (base keys first with the supplement's value, then supplement-only keys).
const expectedScoped = ({ base, supplement }) => Object.fromEntries(Object.entries({ ...base, ...supplement }).filter(([key]) => isScopedKey(key)));

// Two synthetic entries: a template with two holes and a short label, each a scoped key with its own English text.
const SYNTHETIC_ENGLISH = { 'scoped.test.template': 'Message ${0}, image ${1}', 'scoped.test.short': 'Completed' };
const SYNTHETIC_VALUES = { 'scoped.test.template': 'Mensagem ${0}, imagem ${1}', 'scoped.test.short': 'Concluído' };
const withSynthetic = ({ base, supplement, catalogue: source }) => ({ base, supplement: { ...supplement, ...SYNTHETIC_VALUES }, catalogue: { ...source, ...SYNTHETIC_ENGLISH } });
const PROBES = ['Message 3, image 1', 'Message 3, alternative 2, image 1', 'Message too long for this model', 'Completed'];
const render = (dictionary, probes = PROBES) => Object.fromEntries(probes.map(text => [text, localizeString(text, dictionary)]));

test('every real scoped key is a catalogued image choice or an explicit collision-isolated label', () => {
    assert.ok(Object.keys(catalogue).length > 10000);
    for (const language of ALL_LOCALES) {
        const { base, supplement } = allFiles[language];
        for (const [name, table] of [['base', base], ['supplement', supplement]]) {
            for (const key of Object.keys(table).filter(isScopedKey)) {
                assert.ok(key.startsWith('scoped.prompt_media.') || EXTRA_SCOPED_KEYS.includes(key), `${language} ${name} holds an uncatalogued scoped namespace: ${key}`);
                assert.ok(Object.hasOwn(catalogue, key), `${language} ${name}: ${key} is not a key of the catalogue`);
            }
        }
    }
    // The catalogue carries 51 image-choice entries plus the explicit non-image scoped keys.
    const catalogued = Object.keys(catalogue).filter(isScopedKey);
    assert.equal(catalogued.filter(key => key.startsWith('scoped.prompt_media.')).length, 51);
    assert.deepEqual(catalogued.filter(key => !key.startsWith('scoped.prompt_media.')), EXTRA_SCOPED_KEYS);
    assert.equal(catalogue[NANO_REASONING_SCOPED_KEY], '${0} (unavailable)');
    assert.equal(catalogue[SCRATCHPAD_HISTORY_SCOPED_KEY], 'Change history');
    assert.equal(catalogue['scoped.connections.openai_follow'], 'Follow');
    assert.equal(catalogue['scoped.hopper.follow'], 'Follow');
    assert.equal(catalogue['scoped.horde.enter_anonymous'], 'Enter');
    assert.equal(catalogue['scoped.key.enter'], 'Enter');
    assert.equal(catalogue['scoped.action.change'], 'Change');
    assert.equal(catalogue['scoped.story_mode.word_count_one'], '${0} word');
    assert.equal(catalogue['scoped.story_mode.word_count_many'], '${0} words');
    assert.equal(catalogue['scoped.hopper.timeline_default'], 'Timeline');
    assert.equal(catalogue['scoped.hopper.timeline_numbered'], 'Timeline ${0}');
});

test('the assembled dictionary equals today\'s byte for byte for pt-pt, it-it and de-de, and the scoped table is the files\' scoped entries', () => {
    for (const language of LANGUAGES) {
        const { dictionary, scoped } = assembleLocaleData(files[language]);
        const reference = todaysAssembly(stripScoped(files[language]));
        assert.ok(Object.keys(reference).length > 20000, `${language} reference is too small to mean anything`);
        // Key order is part of the comparison: JSON text keeps it, and deepEqual would not.
        assert.equal(JSON.stringify(dictionary), JSON.stringify(reference), `${language} dictionary differs from today's`);
        const expected = expectedScoped(files[language]);
        assert.deepEqual(scoped, expected);
        assert.equal(JSON.stringify(scoped), JSON.stringify(expected), `${language} scoped table is in another order`);
        // The real catalogue's scoped keys, and the English they carry, stay out of the matching dictionary.
        for (const [key, english] of Object.entries(catalogue).filter(([key]) => isScopedKey(key))) {
            assert.ok(!Object.hasOwn(dictionary, key), `${language}: ${key} is in the dictionary`);
            assert.ok(!Object.hasOwn(reference, key), `${language}: ${key} is in today's dictionary`);
            if (!Object.hasOwn(reference, english)) assert.ok(!Object.hasOwn(dictionary, english), `${language}: the English of ${key} became a dictionary key`);
        }
    }
});

test('scoped entries land in the scoped table only, and neither the key nor its English alias reaches the dictionary', () => {
    for (const language of LANGUAGES) {
        const plain = assembleLocaleData(files[language]);
        const { dictionary, scoped } = assembleLocaleData(withSynthetic(files[language]));
        assert.deepEqual(scoped, { ...expectedScoped(files[language]), ...SYNTHETIC_VALUES });
        for (const [key, english] of Object.entries(SYNTHETIC_ENGLISH)) {
            assert.ok(!Object.hasOwn(dictionary, key), `${language}: ${key} is in the dictionary`);
            assert.ok(!Object.hasOwn(dictionary, english), `${language}: the English alias of ${key} is in the dictionary`);
        }
        // Everything else is untouched, in the same order.
        assert.equal(JSON.stringify(dictionary), JSON.stringify(plain.dictionary), `${language}: adding scoped entries changed the dictionary`);
    }
});

test('matching is unaffected: unrelated page text renders exactly as it does without the scoped entries', () => {
    for (const language of LANGUAGES) {
        const without = render(assembleLocaleData(files[language]).dictionary);
        const dictionary = assembleLocaleData(withSynthetic(files[language])).dictionary;
        assert.deepEqual(render(dictionary), without, `${language}: page text changed`);
        // None of the four is translated today, so the comparison above is not vacuous.
        for (const text of PROBES) assert.equal(without[text], text, `${language}: ${text} is already translated`);
    }
});

test('red-green: with the old assembly the synthetic entries are aliased and the same page text changes', () => {
    for (const language of LANGUAGES) {
        const without = render(todaysAssembly(stripScoped(files[language])));
        const aliased = render(todaysAssembly(withSynthetic(stripScoped(files[language]))));
        assert.equal(aliased['Message 3, image 1'], 'Mensagem 3, imagem 1', `${language}: the template alias was not made`);
        assert.equal(aliased['Message 3, alternative 2, image 1'], 'Mensagem 3, alternative 2, imagem 1', `${language}: the hole did not span the extra words`);
        assert.equal(aliased.Completed, 'Concluído', `${language}: the short alias was not made`);
        assert.notEqual(aliased['Message 3, image 1'], without['Message 3, image 1']);
        assert.notEqual(aliased.Completed, without.Completed);
        // A near miss that no template reaches stays the same, so the check is not changing everything.
        assert.equal(aliased['Message too long for this model'], without['Message too long for this model']);
    }
});

test('a scoped entry from the base dictionary also goes to the scoped table, and the supplement wins over the base', () => {
    const { dictionary, scoped } = assembleLocaleData({
        base: { 'scoped.a': 'base a', 'scoped.b': 'base b', Open: 'Abrir' },
        supplement: { 'scoped.a': 'supplement a', Close: 'Fechar' },
        catalogue: { 'scoped.a': 'Alpha', 'scoped.b': 'Beta', Open: 'Open', Close: 'Close' },
    });
    assert.deepEqual(scoped, { 'scoped.a': 'supplement a', 'scoped.b': 'base b' });
    assert.deepEqual(dictionary, { Open: 'Abrir', Close: 'Fechar' });
});

test('an unscoped symbolic key is still aliased under its English text, and an existing entry is not overridden', () => {
    const { dictionary } = assembleLocaleData({
        base: { Saved: 'Guardado' },
        supplement: { 'old.symbolic': 'Valor', 'old.taken': 'Outro' },
        catalogue: { 'old.symbolic': 'Plain English', 'old.taken': 'Saved', 'old.missing': 'Never translated' },
    });
    assert.equal(dictionary['Plain English'], 'Valor');
    assert.equal(dictionary.Saved, 'Guardado');
    assert.ok(!Object.hasOwn(dictionary, 'Never translated'));
});

test('a catalogue entry whose English text itself begins with the prefix leaves no scoped key in the dictionary', () => {
    const { dictionary, scoped } = assembleLocaleData({
        supplement: { 'old.symbolic': 'Valor' },
        catalogue: { 'old.symbolic': 'scoped.looks.reserved' },
    });
    assert.deepEqual(dictionary, { 'old.symbolic': 'Valor' });
    assert.deepEqual(scoped, {});
});

test('the function ignores missing files and leaves its inputs alone', () => {
    assert.deepEqual(assembleLocaleData({}), { dictionary: {}, scoped: {} });
    const base = { 'scoped.a': 'A', Open: 'Abrir' };
    const supplement = { 'scoped.b': 'B' };
    const source = { 'scoped.a': 'Alpha', Open: 'Open' };
    const copies = structuredClone({ base, supplement, source });
    assembleLocaleData({ base, supplement, catalogue: source });
    assert.deepEqual({ base, supplement, source }, copies);
});

test('isScopedKey accepts only strings that begin with the reserved prefix', () => {
    assert.ok(isScopedKey('scoped.prompt_media.RVW-35.1'));
    assert.ok(isScopedKey('scoped.'));
    for (const value of ['Scoped.x', ' scoped.x', 'a scoped.x', 'scoped', 'scope.x', '', null, undefined, 3, {}]) {
        assert.ok(!isScopedKey(value), `${JSON.stringify(value)} counted as scoped`);
    }
});

test('tableForKey sends a scoped key to the scoped table and every other key to the dictionary, whatever is missing', () => {
    const dictionary = { Open: 'Abrir' };
    const scoped = { 'scoped.x': 'Valor' };
    assert.equal(tableForKey('scoped.x', dictionary, scoped), scoped);
    assert.equal(tableForKey('Open', dictionary, scoped), dictionary);
    // A scoped key never reads the dictionary, and an ordinary key never reads the scoped table.
    assert.equal(tableForKey('scoped.x', dictionary, undefined), undefined);
    assert.equal(tableForKey('Open', undefined, scoped), undefined);
    assert.equal(tableForKey('scoped.x', undefined, undefined), undefined);
});

test('Story Mode word-count and Hopper timeline scoped keys stay isolated across all 17 supplements', () => {
    const supplementFiles = readdirSync(new URL('../public/locales/neconyan/', import.meta.url))
        .filter(name => name.endsWith('.json') && !['en.json', 'en-aliases.json'].includes(name))
        .sort();
    assert.equal(supplementFiles.length, 17);
    const aliases = readJson('neconyan/en-aliases.json');
    for (const key of [...STORY_MODE_WORD_COUNT_KEYS, ...HOPPER_TIMELINE_KEYS]) {
        assert.equal(aliases[key], catalogue[key], `missing alias for ${key}`);
    }
    for (const file of supplementFiles) {
        const lang = file.replace(/\.json$/, '');
        const { dictionary, scoped } = assembleLocaleData({
            base: readJson(file),
            supplement: readJson(`neconyan/${file}`),
            catalogue,
        });
        for (const key of [...STORY_MODE_WORD_COUNT_KEYS, ...HOPPER_TIMELINE_KEYS]) {
            assert.equal(typeof scoped[key], 'string', `${lang}: missing scoped.${key}`);
            assert.ok(scoped[key].length > 0, `${lang}: empty ${key}`);
            assert.ok(!Object.hasOwn(dictionary, key), `${lang}: ${key} leaked into dictionary`);
        }
        for (const rawTemplate of ['${0} word', '${0} words', 'Timeline ${0}']) {
            assert.ok(!Object.hasOwn(dictionary, rawTemplate), `${lang}: ${rawTemplate} leaked into dictionary`);
        }
        assert.equal(localizeString('Famous last words', dictionary), 'Famous last words', `${lang}: Famous last words collided`);
    }
});

test('all 17 non-English locales isolate Follow, Enter, Change, Contrastive_search_txt and align hotkeys', () => {
    assert.equal(ALL_LOCALES.length, 17);
    const badHopperFollow = new Set(['OpenAI API 키를 얻으려면', '按照', '遵循', 'Следуйте', 'Дотримуйтесь', 'اتبع']);
    const expectedFollow = { 'ar-sa': 'متابعة', 'zh-cn': '关注', 'zh-tw': '追蹤', 'ko-kr': '팔로우', 'ru-ru': 'Подписаться', 'uk-ua': 'Підписатися' };
    const expectedKeyEnter = { 'fr-fr': 'Entrée', 'it-it': 'Invio' };
    const expectedCtrlEnter = { 'de-de': 'Strg+Enter', 'fr-fr': 'Ctrl+Entrée', 'it-it': 'Ctrl+Invio' };
    const expectedChangeNoun = { 'nl-nl': 'Wijziging', 'de-de': 'Änderung', 'is-is': 'Breyting', 'uk-ua': 'Зміна', 'tr-tr': 'Değişiklik' };
    const expectedActionChange = { 'nl-nl': 'Wijzigen', 'de-de': 'Ändern', 'is-is': 'Breyta', 'uk-ua': 'Змінити', 'tr-tr': 'Değiştir', 'it-it': 'Cambia', 'fr-fr': 'Modifier', 'zh-cn': '更改' };

    for (const language of ALL_LOCALES) {
        const { dictionary, scoped } = assembleLocaleData(allFiles[language]);

        // Follow isolation (L10N-43)
        assert.ok(scoped['scoped.hopper.follow'], `${language}: missing scoped.hopper.follow`);
        assert.ok(scoped['scoped.connections.openai_follow'], `${language}: missing scoped.connections.openai_follow`);
        assert.ok(!badHopperFollow.has(scoped['scoped.hopper.follow']), `${language}: scoped.hopper.follow leaked ${scoped['scoped.hopper.follow']}`);
        assert.ok(!Object.hasOwn(dictionary, 'scoped.hopper.follow'), `${language}: scoped.hopper.follow in dictionary`);
        assert.ok(!Object.hasOwn(dictionary, 'scoped.connections.openai_follow'), `${language}: scoped.connections.openai_follow in dictionary`);
        if (expectedFollow[language]) {
            assert.equal(scoped['scoped.hopper.follow'], expectedFollow[language], `${language}: scoped.hopper.follow`);
            assert.equal(dictionary.Follow, expectedFollow[language], `${language}: dictionary.Follow`);
        }

        // Enter isolation (L10N-43)
        assert.equal(scoped['scoped.key.enter'], expectedKeyEnter[language] || 'Enter', `${language}: scoped.key.enter`);
        assert.equal(typeof scoped['scoped.horde.enter_anonymous'], 'string', `${language}: scoped.horde.enter_anonymous type`);
        if (language === 'tr-tr') {
            assert.equal(scoped['scoped.horde.enter_anonymous'], '');
        } else {
            assert.ok(scoped['scoped.horde.enter_anonymous'].length > 0, `${language}: empty scoped.horde.enter_anonymous`);
        }

        // Hotkeys alignment & help_hotkeys_19_1 / _20 split (L10N-45)
        for (const key of ['help_hotkeys_7', 'help_hotkeys_8', 'help_hotkeys_9', 'help_hotkeys_10_1', 'help_hotkeys_11', 'help_hotkeys_19_1', 'help_hotkeys_20']) {
            assert.ok(dictionary[key], `${language}: missing ${key}`);
        }
        assert.equal(dictionary.help_hotkeys_9, expectedKeyEnter[language] || 'Enter', `${language}: help_hotkeys_9`);
        assert.equal(dictionary.help_hotkeys_11, expectedCtrlEnter[language] || 'Ctrl+Enter', `${language}: help_hotkeys_11`);
        assert.notEqual(dictionary.help_hotkeys_10_1, dictionary.help_hotkeys_11, `${language}: help_hotkeys_10_1 collided with Ctrl+Enter`);
        assert.notEqual(dictionary.help_hotkeys_19_1, dictionary.help_hotkeys_20, `${language}: help_hotkeys_19_1 equals help_hotkeys_20`);
        assert.notEqual(dictionary.help_hotkeys_20, dictionary.help_hotkeys_21, `${language}: help_hotkeys_20 shifted into _21`);

        // Contrastive_search_txt tooltip (L10N-44)
        assert.ok(dictionary.Contrastive_search_txt, `${language}: empty Contrastive_search_txt`);
        assert.notEqual(dictionary.Contrastive_search_txt, 'Contrastive_search_txt', `${language}: raw Contrastive_search_txt`);

        // Change verb vs noun isolation (L10N-55)
        assert.ok(scoped['scoped.action.change'], `${language}: missing scoped.action.change`);
        assert.ok(dictionary.Change, `${language}: missing dictionary.Change`);
        if (expectedChangeNoun[language]) assert.equal(dictionary.Change, expectedChangeNoun[language], `${language}: dictionary.Change`);
        if (expectedActionChange[language]) assert.equal(scoped['scoped.action.change'], expectedActionChange[language], `${language}: scoped.action.change`);
    }

    // Spot-check the 4 shifted hotkey supplements (ko-kr, th-th, is-is, uk-ua) and zh-cn _20
    const assembled = Object.fromEntries(ALL_LOCALES.map(language => [language, assembleLocaleData(allFiles[language]).dictionary]));
    assert.equal(assembled['ko-kr'].help_hotkeys_7, '오른쪽');
    assert.match(assembled['ko-kr'].help_hotkeys_8, /^오른쪽으로 스와이프/);
    assert.equal(assembled['zh-cn'].help_hotkeys_19_1, '滚动聊天到底部');
    assert.equal(assembled['zh-cn'].help_hotkeys_20, 'Markdown 快捷键');
    assert.equal(assembled['th-th'].help_hotkeys_7, 'ขวา');
    assert.equal(assembled['th-th'].help_hotkeys_19_1, 'เลื่อนแชทไปด้านล่าง');
    assert.equal(assembled['th-th'].help_hotkeys_20, 'ปุ่มลัด Markdown');
    assert.equal(assembled['is-is'].help_hotkeys_7, 'Hægri');
    assert.equal(assembled['is-is'].help_hotkeys_19_1, 'Skruna neðst í spjallið');
    assert.equal(assembled['is-is'].help_hotkeys_20, 'Markdown flýtileiðir');
    assert.notEqual(assembled['is-is']['Prompt Itemization'], assembled['is-is']['Show Raw Prompt']);
    assert.equal(assembled['uk-ua'].help_hotkeys_7, 'Праворуч');
    assert.equal(assembled['uk-ua'].help_hotkeys_19_1, 'Прокрутити чат донизу');
    assert.equal(assembled['uk-ua'].help_hotkeys_20, 'Гарячі клавіші Markdown');
    assert.notEqual(assembled['uk-ua']['Prompt Itemization'], assembled['uk-ua']['Show Raw Prompt']);
});
