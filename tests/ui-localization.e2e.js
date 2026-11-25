/* global window, document, globalThis, localStorage */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { assembleLocaleData } from '../public/scripts/locale-assembly.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('interface text is localised everywhere except user-authored content', async ({ page }) => {
    const source = await readFile(new URL('../public/scripts/ui-localization.js', import.meta.url), 'utf8');
    await page.setContent(`
        <main id="root" title="Home">
            <h2>Recent chats</h2>
            <p>No recent chats</p>
            <span><strong>Connections</strong></span>
            <button aria-label="Home">Recent</button>
            <input placeholder="Recent">
            <p data-i18n="[title]Home">Recent</p>
            <p data-i18n="Home">Recent</p>
            <div id="chat"><div class="mes"><div class="ch_name">Recent</div><div class="mes_text"><p>Recent</p></div></div></div>
            <span class="characterName">Recent</span>
            <span id="persona_selected_name">Recent</span>
            <textarea placeholder="Recent">Recent</textarea>
            <pre>Recent</pre>
        </main>`);
    await page.addScriptTag({ type: 'module', content: `${source}\nwindow.localizeControls = localizeControls;` });
    await page.waitForFunction(() => typeof window.localizeControls === 'function');
    const result = await page.evaluate(() => {
        const dictionary = { 'Recent chats': 'Letzte Chats', 'No recent chats': 'Keine Chats', Connections: 'Verbindungen', Recent: 'Neu', Home: 'Start' };
        window.localizeControls(document.getElementById('root'), dictionary);
        const text = selector => [...document.querySelectorAll(selector)].map(element => element.textContent.trim());
        return {
            heading: text('h2'),
            paragraphs: text('main > p'),
            strong: text('strong'),
            button: [document.querySelector('button').textContent, document.querySelector('button').getAttribute('aria-label')],
            rootTitle: document.getElementById('root').title,
            input: document.querySelector('input').placeholder,
            untouched: text('.ch_name, .mes_text p, .characterName, #persona_selected_name, textarea, pre'),
            textareaPlaceholder: document.querySelector('textarea').placeholder,
        };
    });
    expect(result).toEqual({
        heading: ['Letzte Chats'],
        paragraphs: ['Keine Chats', 'Neu', 'Recent'],
        strong: ['Verbindungen'],
        button: ['Neu', 'Start'],
        rootTitle: 'Start',
        input: 'Neu',
        untouched: ['Recent', 'Recent', 'Recent', 'Recent', 'Recent', 'Recent'],
        textareaPlaceholder: 'Neu',
    });
});

test('regex script names, chat names and group member names stay as the user wrote them', async ({ page }) => {
    const source = await readFile(new URL('../public/scripts/ui-localization.js', import.meta.url), 'utf8');
    await page.setContent(`
        <main id="root">
            <div class="regex_script_name" title="Close the door">Close the door</div>
            <span class="chat_name">Home</span>
            <label><input type="checkbox"><span class="sb-conversation-group-member-name">Open Sesame</span></label>
            <p>Home</p>
        </main>`);
    await page.addScriptTag({ type: 'module', content: `${source}\nwindow.localizeControls = localizeControls;` });
    await page.waitForFunction(() => typeof window.localizeControls === 'function');
    const result = await page.evaluate(() => {
        window.localizeControls(document.getElementById('root'), { 'Close ${0}': 'Fechar ${0}', 'Open ${0}': 'Abrir ${0}', Home: 'Início' });
        const script = document.querySelector('.regex_script_name');
        return [script.textContent, script.title, ...['.chat_name', '.sb-conversation-group-member-name', 'p'].map(selector => document.querySelector(selector).textContent)];
    });
    expect(result).toEqual(['Close the door', 'Close the door', 'Home', 'Open Sesame', 'Início']);
});

test('captions filled in before the locale loaded still match their template keys', async ({ page }) => {
    const source = await readFile(new URL('../public/scripts/ui-localization.js', import.meta.url), 'utf8');
    await page.setContent(`
        <main id="root">
            <button id="quick" title="Quick access: Agents" aria-label="Quick access: Agents">Agents</button>
            <p id="step">Step 2 of 9</p>
            <p id="active">Roleplay is active</p>
            <p id="loose">Nori</p>
        </main>`);
    await page.addScriptTag({ type: 'module', content: `${source}\nwindow.localizeControls = localizeControls;` });
    await page.waitForFunction(() => typeof window.localizeControls === 'function');
    const result = await page.evaluate(() => {
        const dictionary = {
            'Quick access: ${0}': 'Schnellzugriff: ${0}',
            'Step ${0} of ${1}': '${1} Schritte, Schritt ${0}',
            '${0} is active': '${0} ist aktiv',
            '${0} ${1}': 'ignored',
        };
        window.localizeControls(document.getElementById('root'), dictionary);
        const quick = document.getElementById('quick');
        return [quick.title, quick.getAttribute('aria-label'), ...['step', 'active', 'loose'].map(id => document.getElementById(id).textContent)];
    });
    expect(result).toEqual(['Schnellzugriff: Agents', 'Schnellzugriff: Agents', '9 Schritte, Schritt 2', 'Roleplay ist aktiv', 'Nori']);
});

test('text that is already a translation is not translated again by a ${n} key', async ({ page }) => {
    const source = await readFile(new URL('../public/scripts/ui-localization.js', import.meta.url), 'utf8');
    await page.setContent(`
        <main id="root">
            <p id="placed" title=" Use o tokenizador AI21 ">  Use o tokenizador AI21  </p>
            <p id="twice">Use AI21 Tokenizer</p>
            <p id="english">Use Claude</p>
        </main>`);
    await page.addScriptTag({ type: 'module', content: `${source}\nwindow.localizeControls = localizeControls;` });
    await page.waitForFunction(() => typeof window.localizeControls === 'function');
    const result = await page.evaluate(() => {
        // Portuguese values that begin with the English word 'Use' beside the 'Use ${0}' key, as in pt-pt.json.
        const dictionary = { 'Use ${0}': 'Usar ${0}', 'Use AI21 Tokenizer': 'Use o tokenizador AI21' };
        const root = document.getElementById('root');
        const read = () => ['placed', 'twice', 'english'].map(id => document.getElementById(id)).map(element => [element.textContent, element.title]);
        window.localizeControls(root, dictionary);
        const first = read();
        // A template localised as a string and then again when the page inserts it, as renderTemplateAsync and the observer do.
        window.localizeControls(root, dictionary);
        return { first, second: read() };
    });
    const expected = [['  Use o tokenizador AI21  ', ' Use o tokenizador AI21 '], ['Use o tokenizador AI21', ''], ['Usar Claude', '']];
    expect(result).toEqual({ first: expected, second: expected });
});

test('drawer toggles are labelled with the phrase the app supplies, before and after a toggle', async ({ page }) => {
    const source = await readFile(new URL('../public/scripts/a11y.js', import.meta.url), 'utf8');
    await page.setContent(`
        <div class="inline-drawer" id="drawer">
            <div class="inline-drawer-toggle inline-drawer-header"><b>Einstellungen</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
            <div class="inline-drawer-content">Text</div>
        </div>`);
    await page.addScriptTag({ type: 'module', content: `${source}\nwindow.drawerLabels = { initAccessibility, setToggleLabelFormatter };` });
    await page.waitForFunction(() => typeof window.drawerLabels?.setToggleLabelFormatter === 'function');
    const result = await page.evaluate(() => {
        const drawer = document.getElementById('drawer');
        const icon = drawer.querySelector('.inline-drawer-icon');
        const toggled = () => {
            drawer.dispatchEvent(new CustomEvent('inline-drawer-toggle', { bubbles: true }));
            return [icon.getAttribute('aria-label'), icon.getAttribute('aria-expanded')];
        };
        // Without a formatter (the login page, or English) the label is the English phrase.
        window.drawerLabels.initAccessibility();
        const english = [icon.getAttribute('aria-label'), icon.getAttribute('aria-expanded')];
        // script.js passes t`Collapse ${label}` and t`Expand ${label}`; German puts the verb last.
        window.drawerLabels.setToggleLabelFormatter((expanded, label) => expanded ? `${label} einklappen` : `${label} ausklappen`);
        const collapsed = toggled();
        icon.classList.replace('down', 'up');
        return { english, collapsed, expanded: toggled() };
    });
    expect(result).toEqual({
        english: ['Expand Einstellungen', 'false'],
        collapsed: ['Einstellungen ausklappen', 'false'],
        expanded: ['Einstellungen einklappen', 'true'],
    });
});

test('an exact entry wins over a ${0} pattern that would otherwise catch the caption', async ({ page }) => {
    const source = await readFile(new URL('../public/scripts/ui-localization.js', import.meta.url), 'utf8');
    const readJson = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
    const dictionaries = {};
    for (const lang of ['de-de', 'it-it']) dictionaries[lang] = { ...await readJson(`../public/locales/${lang}.json`), ...await readJson(`../public/locales/neconyan/${lang}.json`) };
    // Each caption matches the ${0} pattern beside it; the exact entry is what the page must show.
    const pairs = [
        ['de-de', 'Expand ${0}', 'Expand sidebar'],
        ['de-de', 'Expand ${0}', 'Expand the selection with more detail'],
        ['de-de', 'Collapse ${0}', 'Collapse extra blank lines'],
        ['it-it', 'Expand ${0}', 'Expand sidebar'],
        ['it-it', 'Expand ${0}', 'Expand the selection with more detail'],
        ['it-it', 'Collapse ${0}', 'Collapse extra blank lines'],
        ['de-de', 'Pin ${0}', 'Pin for this scene'],
        ['de-de', 'Pin ${0}', 'Pin message'],
        ['it-it', 'Pin ${0}', 'Pin for this scene'],
        ['it-it', 'Pin ${0}', 'Pin message'],
        ['it-it', 'Unpin ${0}', 'Unpin message'],
        ['de-de', 'Unpin ${0}', 'Unpin message'],
        ['de-de', 'Close ${0}', 'Close Home and return to the current mode'],
        ['de-de', 'Close ${0}', 'Close reasoning'],
        ['de-de', 'Close ${0}', 'Close source'],
        ['it-it', 'Close ${0}', 'Close Home and return to the current mode'],
        ['it-it', 'Close ${0}', 'Close reasoning'],
        ['it-it', 'Close ${0}', 'Close source'],
    ];
    for (const [lang, pattern, caption] of pairs) {
        expect(dictionaries[lang][pattern], `${lang} ${pattern}`).toMatch(/\$\{0\}/);
        expect(dictionaries[lang][caption], `${lang} ${caption}`).toBeTruthy();
        expect(new RegExp(`^${pattern.replace('${0}', '(.+)')}$`).test(caption), `${lang} ${caption} matches ${pattern}`).toBe(true);
    }
    await page.setContent(`<main>${pairs.map(([, , caption], index) => `<p id="caption-${index}" title="${caption}">${caption}</p>`).join('')}</main>`);
    await page.addScriptTag({ type: 'module', content: `${source}\nwindow.localizeControls = localizeControls;` });
    await page.waitForFunction(() => typeof window.localizeControls === 'function');
    const shown = await page.evaluate(([dictionaries, pairs]) => pairs.map(([lang], index) => {
        const element = document.getElementById(`caption-${index}`);
        window.localizeControls(element, dictionaries[lang]);
        return [element.textContent, element.title];
    }), [dictionaries, pairs]);
    expect(shown).toEqual(pairs.map(([lang, , caption]) => [dictionaries[lang][caption], dictionaries[lang][caption]]));
});

test('preset selectors marked as data keep their option names, however the options arrive', async ({ page }) => {
    // This calls localizeControls() the way i18n.js does (whole document at load, then each added option
    // through the MutationObserver). It does not load i18n.js itself; the real observer is covered by a browser check.
    const source = await readFile(new URL('../public/scripts/ui-localization.js', import.meta.url), 'utf8');
    await page.setContent(`
        <main id="root">
            <div id="home">
                <select id="marked" data-preset-manager-for="context" data-i18n-ignore aria-label="Chat Completion Preset">
                    <option value="Default">Default</option>
                    <option value="Neutral">Neutral</option>
                </select>
            </div>
            <div id="elsewhere"></div>
            <select id="control"><option>Default</option><option>Neutral</option></select>
        </main>`);
    await page.addScriptTag({ type: 'module', content: `${source}\nwindow.localizeControls = localizeControls;` });
    await page.waitForFunction(() => typeof window.localizeControls === 'function');
    const result = await page.evaluate(() => {
        const dictionary = { Default: 'Padrão', Neutral: 'Neutro', 'Chat Completion Preset': 'Predefinição' };
        const marked = document.getElementById('marked');
        const texts = select => [...select.options].map(option => option.text);
        const shown = {};

        // 1. Whole-document pass at load; the unmarked control proves the dictionary is live.
        window.localizeControls(document, dictionary);
        shown.atLoad = texts(marked);
        shown.control = texts(document.getElementById('control'));

        // 2. An option appended later and passed as the root, as the observer does.
        const appended = document.createElement('option');
        appended.value = 'Default';
        appended.textContent = 'Default';
        marked.append(appended);
        window.localizeControls(appended, dictionary);
        shown.appended = appended.text;

        // 3. An option whose text is set after it was appended.
        const late = document.createElement('option');
        marked.append(late);
        late.textContent = 'Neutral';
        window.localizeControls(late, dictionary);
        shown.late = late.text;

        // 4. The marked select moved to another parent and localised again.
        document.getElementById('elsewhere').append(marked);
        window.localizeControls(document.getElementById('elsewhere'), dictionary);
        window.localizeControls(marked, dictionary);
        shown.moved = texts(marked);

        // 5. The select's own aria-label is not touched by this path.
        shown.ariaLabel = marked.getAttribute('aria-label');
        return shown;
    });
    expect(result).toEqual({
        atLoad: ['Default', 'Neutral'],
        control: ['Padrão', 'Neutro'],
        appended: 'Default',
        late: 'Neutral',
        moved: ['Default', 'Neutral', 'Default', 'Neutral'],
        ariaLabel: 'Chat Completion Preset',
    });
});

// Names and other text a person wrote must show as written, while the interface's own captions on the same surfaces keep translating.
// 'Defect' assertions fail on code before the user-text change and pass after it; 'preservation' assertions pass on both.
async function mergedDictionary(lang) {
    const readJson = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
    return { ...await readJson(`../public/locales/${lang}.json`), ...await readJson(`../public/locales/neconyan/${lang}.json`) };
}

async function openLocaliser(page, markup) {
    const source = await readFile(new URL('../public/scripts/ui-localization.js', import.meta.url), 'utf8');
    await page.setContent(`<main id="root">${markup}</main>`);
    await page.addScriptTag({ type: 'module', content: `${source}\nwindow.localizeControls = localizeControls;` });
    await page.waitForFunction(() => typeof window.localizeControls === 'function');
}

test('the top bar title, panel heading, Quick Reply label and sprite folder show a value that equals a key as written (pt-pt)', async ({ page }) => {
    const dictionary = await mergedDictionary('pt-pt');
    // The values are keys of the real dictionary, as the names people give things can be.
    for (const key of ['Thoughts', 'Summary', 'Continue', 'Solo']) expect(dictionary[key], key).toBeTruthy();
    await openLocaliser(page, `
        <div id="sb-topbar-title" title="Thoughts">Thoughts</div>
        <div id="rm_button_selected_ch"><h2>Summary</h2></div>
        <div><span class="qr--button-label">Continue</span></div>
        <div><span id="sprite-label">Sprite set:</span> <span id="image_list_header_name">Solo</span></div>
        <p id="control">Thoughts</p>`);
    const result = await page.evaluate(dictionary => {
        window.localizeControls(document.getElementById('root'), dictionary);
        const text = selector => document.querySelector(selector).textContent;
        return {
            topbar: [text('#sb-topbar-title'), document.getElementById('sb-topbar-title').title],
            heading: text('#rm_button_selected_ch h2'),
            qrLabel: text('.qr--button-label'),
            spriteName: text('#image_list_header_name'),
            spriteLabel: text('#sprite-label'),
            control: text('#control'),
        };
    }, dictionary);
    // Defect assertions: the four value elements.
    expect.soft({ topbar: result.topbar, heading: result.heading, qrLabel: result.qrLabel, spriteName: result.spriteName }, 'defect: values as written').toEqual({
        topbar: ['Thoughts', 'Thoughts'], heading: 'Summary', qrLabel: 'Continue', spriteName: 'Solo',
    });
    // Preservation assertions: the built-in caption beside a value, and an ordinary element, still translate.
    expect({ spriteLabel: result.spriteLabel, control: result.control }, 'preservation: captions still translate').toEqual({
        spriteLabel: 'Conjunto de sprites:', control: 'Pensamentos',
    });
});

test('a translate="no" slot keeps a value, and translates the fallback after the attribute is removed, each time it is rewritten (pt-pt)', async ({ page }) => {
    const dictionary = await mergedDictionary('pt-pt');
    await openLocaliser(page, '<span id="slot" class="sb-conversation-pal-kind"></span><button id="recent" title="Summary" aria-label="Summary" translate="no"><span>Summary</span><small>Chat</small></button>');
    const result = await page.evaluate(dictionary => {
        const slot = document.getElementById('slot');
        // As the render code does: a value sets the attribute, the built-in fallback removes it.
        const write = (text, isValue) => {
            slot.textContent = text;
            if (isValue) slot.setAttribute('translate', 'no');
            else slot.removeAttribute('translate');
            window.localizeControls(document.getElementById('root'), dictionary);
            return slot.textContent;
        };
        const shown = [write('Solo', true), write('Solo', false), write('Solo', true), write('Solo', false)];
        const recent = document.getElementById('recent');
        window.localizeControls(document.getElementById('root'), dictionary);
        return { shown, recent: [recent.title, recent.getAttribute('aria-label'), recent.querySelector('span').textContent, recent.querySelector('small').textContent] };
    }, dictionary);
    // Preservation assertions (the localiser already honours translate="no"; the render code is what must write it, see user-text-render.e2e.js).
    expect(result.shown).toEqual(['Solo', 'Individual', 'Solo', 'Individual']);
    expect(result.recent).toEqual(['Summary', 'Summary', 'Summary', 'Chat']);
});

test('a protected element keeps the captions the code translated, and English ones inside it stay English, so the code must translate them (pt-pt)', async ({ page }) => {
    const dictionary = await mergedDictionary('pt-pt');
    await openLocaliser(page, `
        <span id="stack" translate="no" title="Alice, Bob">
            <span id="translated" title="Personagem" aria-label="Mostrar imagem completa de Alice"></span>
            <span id="english" title="Character" aria-label="Show full picture for Bob"></span>
        </span>
        <select id="sets"><option translate="no">Default</option><option id="placeholder">-- Select QR Set --</option></select>`);
    const result = await page.evaluate(dictionary => {
        window.localizeControls(document.getElementById('root'), dictionary);
        const late = document.createElement('option');
        late.setAttribute('translate', 'no');
        late.textContent = 'Summary';
        document.getElementById('sets').append(late);
        // As the observer in i18n.js passes each added node.
        window.localizeControls(late, dictionary);
        const read = id => [document.getElementById(id).title, document.getElementById(id).getAttribute('aria-label')];
        return { translated: read('translated'), english: read('english'), options: [...document.getElementById('sets').options].map(option => option.text) };
    }, dictionary);
    // Preservation assertions.
    expect(result.translated).toEqual(['Personagem', 'Mostrar imagem completa de Alice']);
    expect(result.english).toEqual(['Character', 'Show full picture for Bob']);
    expect(result.options).toEqual(['Default', '-- Selecione um conjunto de QR --', 'Summary']);
});

async function openWithLocalizeString(page, markup) {
    const source = await readFile(new URL('../public/scripts/ui-localization.js', import.meta.url), 'utf8');
    await page.setContent(`<main id="root">${markup}</main>`);
    await page.addScriptTag({ type: 'module', content: `${source}\nwindow.localizeControls = localizeControls; window.localizeString = localizeString;` });
    await page.waitForFunction(() => typeof window.localizeControls === 'function' && typeof window.localizeString === 'function');
}

test('the lookup option for whole messages changed nothing on screen: a hole that is a key is still translated by the localiser, and kept by localizeString', async ({ page }) => {
    await openWithLocalizeString(page, '<p id="open">Open Home</p>');
    const result = await page.evaluate(() => {
        const dictionary = { 'Open ${0}': 'Abrir ${0}', Home: 'Início' };
        const message = window.localizeString('Open Home', dictionary);
        window.localizeControls(document.getElementById('root'), dictionary);
        return { onScreen: document.getElementById('open').textContent, message };
    });
    expect(result).toEqual({ onScreen: 'Abrir Início', message: 'Abrir Home' });
});

// Characterisation: this passes on the code before the change too (the localiser already finds the six sentences through
// their own keys when the keys exist). It pins what the extension updater toasts rely on.
test('the six extension updater refusals are translated whole by the localiser, folder name as written', async ({ page }) => {
    const verbs = ['installed', 'updated', 'managed', 'switched', 'moved', 'deleted'];
    await openWithLocalizeString(page, verbs.map(verb => `<p id="${verb}">ChatCompletionTabs comes with Neconyan, so it cannot be ${verb} from the extension updater.</p>`).join(''));
    const result = await page.evaluate(verbs => {
        const values = { installed: 'instalada', updated: 'atualizada', managed: 'gerenciada', switched: 'trocada', moved: 'movida', deleted: 'excluída' };
        const dictionary = {};
        for (const verb of [...verbs].reverse()) {
            dictionary[`\${0} comes with Neconyan, so it cannot be ${verb} from the extension updater.`] = `\${0} vem com o Neconyan e não pode ser ${values[verb]} pelo atualizador.`;
        }
        window.localizeControls(document.getElementById('root'), dictionary);
        return verbs.map(verb => document.getElementById(verb).textContent);
    }, verbs);
    expect(result).toEqual([
        'ChatCompletionTabs vem com o Neconyan e não pode ser instalada pelo atualizador.',
        'ChatCompletionTabs vem com o Neconyan e não pode ser atualizada pelo atualizador.',
        'ChatCompletionTabs vem com o Neconyan e não pode ser gerenciada pelo atualizador.',
        'ChatCompletionTabs vem com o Neconyan e não pode ser trocada pelo atualizador.',
        'ChatCompletionTabs vem com o Neconyan e não pode ser movida pelo atualizador.',
        'ChatCompletionTabs vem com o Neconyan e não pode ser excluída pelo atualizador.',
    ]);
});

// M71: one proof per userText entry the change adds (rule F). Each element only ever shows a name a person chose. The name equals a pt-pt
// key, so it must stay as written, while an unmarked control beside it, of the same tag, still translates. Each fails on the code before the
// change, where the entry is missing.
for (const [selector, attribute, where] of [
    ['#an_chara_name', 'id="an_chara_name"', 'Author\'s Note character name (authors-note.js)'],
    ['#extension_floating_chara_editing', 'id="extension_floating_chara_editing"', 'Author\'s Note note being edited (authors-note.js renderNoteSlot)'],
    ['.an-note-name', 'class="an-note-name"', 'Author\'s Note character note list (authors-note.js renderCharaNoteList)'],
    ['.group_select_block_list', 'class="group_select_block_list"', 'group card member names (group-chats.js)'],
    ['.select_chat_block_filename', 'class="select_chat_block_filename"', 'Manage chats file names (index.html template)'],
    ['.sb-chat-file-title', 'class="sb-chat-file-title"', 'chat file rows (neconyan-tabs.js createChatFileButton)'],
    ['.scratchpad-source', 'class="scratchpad-source"', 'Scratchpad source chat (scratchpad/index.js)'],
    ['.sbca-filename', 'class="sbca-filename"', 'Chats archive file names'],
    ['.sbca-owner', 'class="sbca-owner"', 'Chats archive owner names'],
    ['.sbca-owner-choice-name', 'class="sbca-owner-choice-name"', 'Chats archive owner choices'],
    ['.neconyan-lorebook-book-name', 'class="neconyan-lorebook-book-name"', 'lorebook library card names (neconyan-native-workspaces.js)'],
]) {
    test(`userText ${selector}: a name that equals a key stays as written, and an unmarked control beside it translates (pt-pt)`, async ({ page }) => {
        const dictionary = await mergedDictionary('pt-pt');
        for (const key of ['Default', 'Summary']) expect(dictionary[key], key).toBeTruthy();
        await openLocaliser(page, `<div><span ${attribute} title="Summary">Default</span><span id="control" title="Summary">Default</span></div>`);
        const result = await page.evaluate(([query, dictionary]) => {
            window.localizeControls(document.getElementById('root'), dictionary);
            const marked = document.querySelector(query);
            const control = document.getElementById('control');
            return { marked: [marked.textContent, marked.title], control: [control.textContent, control.title] };
        }, [selector, dictionary]);
        expect.soft(result.marked, `defect: ${where} keeps the name as written`).toEqual(['Default', 'Summary']);
        expect(result.control, 'preservation: an unmarked control translates').toEqual([dictionary.Default, dictionary.Summary]);
    });
}

test('textarea attributes are localised unless marked ignored or inside protected user text', async ({ page }) => {
    await openLocaliser(page, `
        <textarea id="plain" placeholder="Recent" title="Home" aria-label="Connections">Recent</textarea>
        <textarea id="direct" placeholder="Recent" title="Home" aria-label="Connections">Recent</textarea>
        <textarea id="ignore-attr" data-i18n-ignore placeholder="Recent" title="Home" aria-label="Connections">Recent</textarea>
        <textarea id="translate-no" translate="no" placeholder="Recent" title="Home" aria-label="Connections">Recent</textarea>
        <textarea id="notranslate" class="notranslate" placeholder="Recent" title="Home" aria-label="Connections">Recent</textarea>
        <div data-i18n-ignore>
            <textarea id="ancestor-ignore" placeholder="Recent" title="Home" aria-label="Connections">Recent</textarea>
        </div>
        <pre id="pre" title="Home">Recent</pre>`);
    const result = await page.evaluate(() => {
        const dictionary = { Recent: 'Neu', Home: 'Start', Connections: 'Verbindungen' };
        const readAttrs = id => {
            const el = document.getElementById(id);
            return {
                placeholder: el.getAttribute('placeholder'),
                title: el.getAttribute('title'),
                ariaLabel: el.getAttribute('aria-label'),
                text: el.textContent,
            };
        };

        // Direct-root pass on both an unmarked textarea and protected textareas before walking #root.
        window.localizeControls(document.getElementById('direct'), dictionary);
        for (const id of ['ignore-attr', 'translate-no', 'notranslate', 'ancestor-ignore', 'pre']) {
            window.localizeControls(document.getElementById(id), dictionary);
        }
        const directOnly = {
            direct: readAttrs('direct'),
            ignoreAttr: readAttrs('ignore-attr'),
            translateNo: readAttrs('translate-no'),
            notranslate: readAttrs('notranslate'),
            ancestorIgnore: readAttrs('ancestor-ignore'),
            pre: readAttrs('pre'),
        };

        // TreeWalker pass from #root.
        window.localizeControls(document.getElementById('root'), dictionary);
        return {
            directOnly,
            walked: {
                plain: readAttrs('plain'),
                ignoreAttr: readAttrs('ignore-attr'),
                translateNo: readAttrs('translate-no'),
                notranslate: readAttrs('notranslate'),
                ancestorIgnore: readAttrs('ancestor-ignore'),
                pre: readAttrs('pre'),
            },
        };
    });

    const translated = { placeholder: 'Neu', title: 'Start', ariaLabel: 'Verbindungen', text: 'Recent' };
    const untouched = { placeholder: 'Recent', title: 'Home', ariaLabel: 'Connections', text: 'Recent' };
    const untouchedPre = { placeholder: null, title: 'Home', ariaLabel: null, text: 'Recent' };
    expect(result).toEqual({
        directOnly: {
            direct: translated,
            ignoreAttr: untouched,
            translateNo: untouched,
            notranslate: untouched,
            ancestorIgnore: untouched,
            pre: untouchedPre,
        },
        walked: {
            plain: translated,
            ignoreAttr: untouched,
            translateNo: untouched,
            notranslate: untouched,
            ancestorIgnore: untouched,
            pre: untouchedPre,
        },
    });
});

function sliceDeclaration(text, name) {
    const match = text.match(new RegExp(`^(?:export )?(?:async )?(?:function|class) ${name}\\b[^]*?\\n}$`, 'm'));
    if (match) return match[0].replace(/^export /, '');
    const constant = text.match(new RegExp(`^const ${name}\\b[^\\n]*;`, 'm'));
    return constant ? constant[0] : null;
}

async function assembledLocale(lang) {
    const readJson = async file => JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
    return assembleLocaleData({
        base: await readJson(`../public/locales/${lang}.json`),
        supplement: await readJson(`../public/locales/neconyan/${lang}.json`),
        catalogue: await readJson('../public/locales/neconyan/en.json'),
    });
}

async function openSlicedRenderer(page, fileMap, lang) {
    const sources = {};
    for (const [relativePath, names] of Object.entries(fileMap)) {
        const text = await readFile(new URL(relativePath, import.meta.url), 'utf8');
        for (const name of names) {
            const decl = sliceDeclaration(text, name);
            expect(decl, `declaration ${name} in ${relativePath}`).toBeTruthy();
            sources[name] = decl;
        }
    }
    const { dictionary, scoped } = await assembledLocale(lang);
    await page.setContent('<main id="root"></main>');
    await page.addScriptTag({ type: 'module', content: `${await readFile(new URL('../public/scripts/ui-localization.js', import.meta.url), 'utf8')}\nwindow.localizeControls = localizeControls;` });
    await page.waitForFunction(() => typeof window.localizeControls === 'function');
    await page.addScriptTag({ content: await readFile(new URL('../public/lib/jquery-3.5.1.min.js', import.meta.url), 'utf8') });
    await page.evaluate(([slicedSources, dict, scopedDict]) => {
        const target = {};
        const noop = () => undefined;
        const scope = new Proxy(target, {
            has: (object, key) => typeof key === 'string' && (key in object || !(key in globalThis)),
            get: (object, key) => {
                if (typeof key !== 'string' || key in object) return object[key];
                return noop;
            },
        });
        for (const [name, code] of Object.entries(slicedSources)) {
            if (code.startsWith('const ')) {
                scope[name] = new Function('scope', `with (scope) { ${code}\nreturn ${name}; }`)(scope);
            } else {
                scope[name] = new Function('scope', `with (scope) { return (${code}); }`)(scope);
            }
        }
        const translate = (text, key = null) => (key && key.startsWith('scoped.') ? scopedDict[key] : dict[key || text]) || text;
        const t = (strings, ...values) => translate(
            strings.reduce((result, part, i) => result + part + (values[i] !== undefined ? `\${${i}}` : ''), ''),
        ).replace(/\$\{(\d+)\}/g, (_match, index) => values[index]);
        scope.translate = translate;
        scope.t = t;
        window.renderHarness = { scope, dictionary: dict, scoped: scopedDict, t, translate };
    }, [sources, dictionary, scoped]);
    return dictionary;
}

test('Meower real renderers protect user and model content while keeping UI fallbacks and composer frames translatable (tr-tr)', async ({ page }) => {
    const trDict = await openSlicedRenderer(page, {
        '../public/scripts/extensions/third-party/Neconyan-Hopper/src/ui.js': [
            'el', 'icon', 'hostTag', 'button', 'bodyNode', 'pollNode', 'engagementNode',
            'replyNode', 'repostedReplyNode', 'postNode', 'quoteNode',
            'replyComposer', 'attachMentionPicker', 'timelineView',
            'profileView', 'notificationsView', 'whoToFollow',
        ],
    }, 'tr-tr');
    for (const key of ['Nice to meet you!', 'Summary', 'Image post', 'Post', 'you', 'Reply', 'Reply to @${0}', 'Reply as ${0}...', 'Reply as ${0}']) {
        expect(trDict[key], key).toBeTruthy();
    }

    const result = await page.evaluate(() => {
        const { scope, dictionary, t } = window.renderHarness;
        globalThis.SillyTavern = { getContext: () => ({ t }) };

        const persona = { key: 'persona:me', kind: 'persona', name: 'Summary', handle: 'default', bio: 'Nice to meet you!', location: 'Nice to meet you!' };
        const charAcc = { key: 'char:c1', kind: 'character', name: 'Summary', handle: 'default', bio: 'Nice to meet you!', location: 'Nice to meet you!' };
        const accountsByKey = new Map([[persona.key, persona], [charAcc.key, charAcc]]);

        const mainPost = {
            id: 'p1',
            authorKey: charAcc.key,
            authorSnapshot: charAcc,
            body: 'Nice to meet you!',
            createdAt: 1000,
            poll: { question: 'Nice to meet you!', options: [{ text: 'Nice to meet you!' }] },
        };
        const imgPost = { id: 'p2', authorKey: charAcc.key, body: '', image: { url: '/img/x.png' }, createdAt: 1001 };
        const emptyPost = { id: 'p3', authorKey: charAcc.key, body: '', createdAt: 1002 };
        const replyItem = { id: 'r1', postId: 'p1', type: 'reply', actorKey: charAcc.key, actorSnapshot: charAcc, content: 'Nice to meet you!', createdAt: 1003 };
        const repostReplyItem = { id: 'rr1', postId: 'p1', type: 'repost', parentInteractionId: 'r1', actorKey: charAcc.key, actorSnapshot: charAcc, content: 'Nice to meet you!', createdAt: 1004 };
        const quoteRepostItem = { id: 'q1', postId: 'p1', type: 'repost', actorKey: charAcc.key, actorSnapshot: charAcc, content: 'Nice to meet you!', createdAt: 1005 };

        let currentPersona = persona;
        const postsById = new Map([[mainPost.id, mainPost], [imgPost.id, imgPost], [emptyPost.id, emptyPost]]);
        const interactionsById = new Map([[replyItem.id, replyItem], [repostReplyItem.id, repostReplyItem], [quoteRepostItem.id, quoteRepostItem]]);
        const notifGroups = {
            likes: [
                { id: 'n1', kind: 'like', postId: 'p1', actorKey: charAcc.key, actorSnapshot: charAcc, content: 'Nice to meet you!', createdAt: 2000 },
                { id: 'n2', kind: 'like', postId: 'p2', actorKey: charAcc.key, actorSnapshot: charAcc, content: '', createdAt: 2001 },
                { id: 'n3', kind: 'like', postId: 'p3', actorKey: charAcc.key, actorSnapshot: charAcc, content: '', createdAt: 2002 },
            ],
            replies: [],
            posts: [],
        };

        Object.assign(scope, {
            KIND_CHARACTER: 'character',
            REPLY_MAX_CHARS: 500,
            FEED_LIMIT: 160,
            REPLY_LIMIT: 12,
            NOTIFICATION_LIMIT: 50,
            SEARCH_DEBOUNCE_MS: 150,
            NOTIFICATION_TABS: [['likes', 'Likes'], ['replies', 'Replies'], ['posts', 'Posts']],
            NOTIFICATION_VERB: { like: 'liked your post', reply: 'replied to you', post: 'posted' },
            NOTIFICATION_EMPTY: { likes: 'No likes', replies: 'No replies', posts: 'No posts' },
            dateFormat: { format: () => 'now' },
            accountsByHandle: new Map(),
            postsById,
            interactionsById,
            replyDrafts: new Map(),
            listLimits: new Map(),
            mentionPickerId: 0,
            searchOpen: false,
            mutationTask: null,
            pendingReplyFocus: null,
            api: { updateSession: (_id, patch) => ({ ...scope.state.session, ...patch }) },
            formatCount: n => String(n),
            plural: (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`,
            followingKeys: () => new Set(),
            isNewToMe: () => false,
            isReplyTarget: () => false,
            replyTargetKey: target => JSON.stringify([target.postId, target.parentInteractionId ?? null]),
            answerableOn: () => null,
            interactionsFor: () => [],
            myInteraction: () => null,
            replyStatsFor: () => ({ like: 0, repost: 0, reply: 0, mine: new Map(), items: [] }),
            accountFor: key => accountsByKey.get(key) ?? null,
            nameFor: (key, snap) => accountsByKey.get(key)?.name ?? snap?.name ?? 'Summary',
            handleFor: (key, snap) => accountsByKey.get(key)?.handle ?? snap?.handle ?? 'default',
            personaAccount: () => currentPersona,
            visibleTimelineEntries: () => ({ entries: [], total: 0 }),
            notificationTarget: item => ({ postId: item.postId, interactionId: item.interactionId ?? null }),
            notificationGroups: () => notifGroups,
            mentionQueryAt: value => (value.startsWith('@') ? { start: 0, query: value.slice(1) } : null),
            matchMentionAccounts: accounts => accounts,
            state: {
                tab: 'trending',
                notifTab: 'likes',
                notifSeenBefore: 0,
                timelineSeenBefore: 0,
                engagementFor: 'eng:like',
                profileKey: charAcc.key,
                replyingTo: null,
                busy: false,
                draftReady: true,
                timelineSearch: '',
                accounts: [persona, charAcc],
                session: { id: 's1', trends: [{ topic: 'Nice to meet you!', posts: 3 }], follows: {}, timelineSeenAt: 0, notificationsSeenAt: 0 },
                feed: { posts: [], interactions: [] },
            },
        });

        const root = document.getElementById('root');
        const mount = (id, node) => {
            const box = document.createElement('section');
            box.id = id;
            if (node) box.append(node);
            root.append(box);
            return box;
        };

        mount('post', scope.postNode(mainPost));
        mount('reply', scope.replyNode(replyItem));
        mount('reposted-reply', scope.repostedReplyNode({ post: mainPost, reply: replyItem, repost: repostReplyItem }));
        mount('quote', scope.quoteNode(mainPost, quoteRepostItem));
        mount('engagement', scope.engagementNode('eng', [{ type: 'like', actorKey: charAcc.key, actorSnapshot: charAcc, createdAt: 1000 }]));
        mount('timeline', scope.timelineView());
        mount('profile', scope.profileView());
        mount('notifications', scope.notificationsView());
        mount('who', scope.whoToFollow());

        const mentionBox = mount('mentions', null);
        const mentionField = document.createElement('textarea');
        mentionBox.append(mentionField);
        scope.attachMentionPicker(mentionField);
        mentionField.value = '@def';
        mentionField.dispatchEvent(new Event('input'));

        mount('composer-named', scope.replyComposer(mainPost));
        currentPersona = null;
        mount('composer-anon', scope.replyComposer(mainPost));

        window.localizeControls(root, dictionary);

        currentPersona = persona;
        const youReplyBox = document.createElement('section');
        youReplyBox.id = 'reply-you';
        youReplyBox.append(scope.replyNode({
            id: 'r-you',
            postId: 'p1',
            type: 'reply',
            actorKey: 'char:you',
            actorSnapshot: { kind: 'character', name: 'Summary', handle: 'you' },
            content: 'Nice to meet you!',
            createdAt: 1006,
        }));
        document.body.append(youReplyBox);
        window.localizeControls(youReplyBox, dictionary);
        const youReplyButton = youReplyBox.querySelector('[data-focus-key="reply:r-you"]');

        const texts = selector => [...root.querySelectorAll(selector)].map(node => node.textContent.trim());
        const namedComposer = root.querySelector('#composer-named textarea');
        const anonComposer = root.querySelector('#composer-anon textarea');
        return {
            bodies: {
                post: root.querySelector('#post .sbtw-body').textContent.trim(),
                reply: root.querySelector('#reply .sbtw-body').textContent.trim(),
                repostedReply: root.querySelector('#reposted-reply .sbtw-post-main > .sbtw-body').textContent.trim(),
                quote: root.querySelector('#quote .sbtw-post-main > .sbtw-body').textContent.trim(),
            },
            pollQuestion: root.querySelector('#post .sbtw-poll-question').textContent.trim(),
            pollText: root.querySelector('#post .sbtw-poll-text').textContent.trim(),
            trendTopic: root.querySelector('#timeline .sbtw-trend-topic').textContent.trim(),
            bio: root.querySelector('#profile .sbtw-bio').textContent.trim(),
            location: root.querySelector('#profile .sbtw-location span').textContent.trim(),
            names: texts('.sbtw-name'),
            handles: texts('.sbtw-handle'),
            notificationPreviews: texts('#notifications .sbtw-notification-preview'),
            namedComposer: [namedComposer.getAttribute('placeholder'), namedComposer.getAttribute('aria-label')],
            anonComposer: [anonComposer.getAttribute('placeholder'), anonComposer.getAttribute('aria-label')],
            youReplyButton: {
                ariaLabel: youReplyButton.getAttribute('aria-label'),
                title: youReplyButton.getAttribute('title'),
                text: youReplyButton.textContent.trim(),
                ignored: youReplyButton.hasAttribute('data-i18n-ignore'),
            },
        };
    });

    expect(result.bodies).toEqual({
        post: 'Nice to meet you!',
        reply: 'Nice to meet you!',
        repostedReply: 'Nice to meet you!',
        quote: 'Nice to meet you!',
    });
    expect(result.pollQuestion).toBe('Nice to meet you!');
    expect(result.pollText).toBe('Nice to meet you!');
    expect(result.trendTopic).toBe('Nice to meet you!');
    expect(result.bio).toBe('Nice to meet you!');
    expect(result.location).toBe('Nice to meet you!');
    expect(result.names.length).toBeGreaterThanOrEqual(9);
    expect(result.names.every(name => name === 'Summary')).toBe(true);
    expect(result.handles.length).toBeGreaterThanOrEqual(8);
    expect(result.handles.every(handle => handle === '@default')).toBe(true);
    expect(result.notificationPreviews).toEqual(['Nice to meet you!', 'Görselli gönderi', 'Gönder']);
    expect(result.namedComposer).toEqual(['Summary olarak yanıt verin...', 'Summary olarak yanıt verin']);
    expect(result.anonComposer).toEqual(['siz olarak yanıt verin...', 'siz olarak yanıt verin']);
    expect(result.youReplyButton).toEqual({
        ariaLabel: '@you hesabına yanıt ver',
        title: 'Yanıtla',
        text: 'Yanıtla',
        ignored: true,
    });
    expect(result.youReplyButton.ariaLabel).not.toContain('@siz');
});

test('Scratchpad real renderers protect user text, reasoning, streaming, change reasons and user names while keeping fallbacks translatable (tr-tr)', async ({ page }) => {
    const trDict = await openSlicedRenderer(page, {
        '../public/scripts/notebooks/dom.js': ['h', 'append'],
        '../public/scripts/scratchpad/index.js': ['renderMessage', 'renderChangeCard'],
    }, 'tr-tr');
    expect(trDict.You).toBeTruthy();
    expect(trDict.You).not.toBe('You');
    expect(trDict.Post).toBe('Gönder');

    const result = await page.evaluate(() => {
        const { scope, dictionary } = window.renderHarness;
        let currentUserName = 'Summary';
        Object.assign(scope, {
            app: {
                source: { kind: 'general', key: 'general' },
                editing: null,
                foldedThinking: new Set(),
                openMenus: new Set(),
                imageAvailability: null,
                imageJobs: new Map(),
                imageErrors: new Map(),
            },
            sourceUserName: () => currentUserName,
            busyChanges: new Set(),
            assistantInfo: () => ({ id: 'miso', name: 'Miso' }),
            assistantPortrait: () => '/img/miso.png',
            replyPreview: message => message._preview,
            stageLabel: () => 'Thinking',
            iconButton: label => scope.h('button', { text: label }),
            renderReply: (_session, message) => scope.h('div', { class: 'mes_text', text: message.text }),
            renderAttachments: () => [],
            renderReplySwipes: () => null,
            renderMessageActions: () => document.createElement('div'),
            describeChange: () => 'Update field',
        });

        const session = { id: 's1', assistant: 'miso', settings: {} };
        const root = document.getElementById('root');
        const userNamed = scope.renderMessage(session, { id: 'm1', role: 'user', text: 'Line 1' }, { latest: false, retry: false });
        currentUserName = '';
        const userFallback = scope.renderMessage(session, { id: 'm2', role: 'user', text: 'Line 1' }, { latest: false, retry: false });
        const pendingAssistant = scope.renderMessage(session, { id: 'm3', role: 'assistant', state: 'pending', _preview: { reasoning: 'Line 1', text: 'Line 1' } }, { latest: true, retry: false });
        const savedAssistant = scope.renderMessage(session, { id: 'm4', role: 'assistant', reasoning: 'Line 1', text: 'Line 1' }, { latest: true, retry: false });
        const validChange = scope.renderChangeCard(session, { id: 'm4', proposals: {} }, { index: 0, change: { type: 'field', reason: 'Line 1' } });
        const invalidChange = scope.renderChangeCard(session, { id: 'm4', proposals: {} }, { index: 1, change: null, error: 'Post' });

        root.append(userNamed, userFallback, pendingAssistant, savedAssistant, validChange, invalidChange);
        window.localizeControls(root, dictionary);

        return {
            namedAuthor: userNamed.querySelector('.scratchpad-author span').textContent,
            namedUserText: userNamed.querySelector('p.scratchpad-plain').textContent,
            fallbackAuthor: userFallback.querySelector('.scratchpad-author span').textContent,
            pendingReasoning: pendingAssistant.querySelector('.scratchpad-reasoning p.scratchpad-plain').textContent,
            pendingStream: pendingAssistant.querySelector('p.scratchpad-stream').textContent,
            savedReasoning: savedAssistant.querySelector('.scratchpad-reasoning p.scratchpad-plain').textContent,
            validChangeReason: validChange.querySelector('p.scratchpad-change-reason').textContent,
            invalidChangeError: invalidChange.querySelector('p.scratchpad-change-reason').textContent,
        };
    });

    expect(result).toEqual({
        namedAuthor: 'Summary',
        namedUserText: 'Line 1',
        fallbackAuthor: trDict.You,
        pendingReasoning: 'Line 1',
        pendingStream: 'Line 1',
        savedReasoning: 'Line 1',
        validChangeReason: 'Line 1',
        invalidChangeError: 'Gönder',
    });
});

test('TTS VoiceMapEntry keeps option values intact when German localises the disabled label (de-de)', async ({ page }) => {
    const deDict = await openSlicedRenderer(page, {
        '../public/scripts/extensions/tts/index.js': ['LOCALIZED_DISABLED_VOICE_LABELS', 'normalizeSavedVoiceId', 'VoiceMapEntry'],
    }, 'de-de');
    expect(deDict.disabled).toBe('deaktiviert');

    const result = await page.evaluate(() => {
        const { scope, dictionary } = window.renderHarness;
        let voiceMapUpdates = 0;
        Object.assign(scope, {
            DEFAULT_VOICE_MARKER: '[Default Voice]',
            DISABLED_VOICE_MARKER: 'disabled',
            sanitizeId: input => String(input).replace(/[^a-zA-Z0-9_-]/g, '_'),
            updateVoiceMap: () => { voiceMapUpdates += 1; },
        });

        const voices = [{ name: 'Voice A' }];
        const recoveredGerman = scope.normalizeSavedVoiceId('deaktiviert', voices);
        const recoveredAllLocales = ['معطّل', '已停用', 'uitgeschakeld', 'deaktiviert', 'óvirkt', 'disabilitato', '비활성화됨', 'deshabilitado', 'вимкнено', 'đã tắt']
            .map(label => scope.normalizeSavedVoiceId(label, voices));
        const realVoice = scope.normalizeSavedVoiceId('Voice A', voices);
        const realProviderNamedDeaktiviert = scope.normalizeSavedVoiceId('deaktiviert', [{ name: 'deaktiviert' }]);
        const markerValues = [
            scope.normalizeSavedVoiceId('disabled', voices),
            scope.normalizeSavedVoiceId('[Default Voice]', voices),
        ];

        document.getElementById('root').innerHTML = '<div id="tts_voicemap_block"></div>';
        const alice = new scope.VoiceMapEntry('Alice', recoveredGerman);
        const defaultEntry = new scope.VoiceMapEntry('[Default Voice]', 'disabled');
        alice.addUI(voices);
        defaultEntry.addUI(voices);

        window.localizeControls(document.getElementById('root'), dictionary);

        const aliceOptions = [...alice.selectElement[0].options].map(option => ({ value: option.value, text: option.textContent.trim() }));
        const defaultOptions = [...defaultEntry.selectElement[0].options].map(option => ({ value: option.value, text: option.textContent.trim() }));
        const aliceInitialVal = alice.selectElement.val();
        const defaultInitialVal = defaultEntry.selectElement.val();

        alice.selectElement.val('Voice A').trigger('change');
        alice.selectElement.val('disabled').trigger('change');
        defaultEntry.selectElement.trigger('change');

        return {
            recoveredGerman,
            recoveredAllLocales,
            realVoice,
            realProviderNamedDeaktiviert,
            markerValues,
            aliceOptions,
            defaultOptions,
            aliceInitialVal,
            defaultInitialVal,
            aliceVoiceIdAfterChange: alice.voiceId,
            defaultVoiceIdAfterChange: defaultEntry.voiceId,
            voiceMapUpdates,
        };
    });

    expect(result).toEqual({
        recoveredGerman: 'disabled',
        recoveredAllLocales: Array(10).fill('disabled'),
        realVoice: 'Voice A',
        realProviderNamedDeaktiviert: 'deaktiviert',
        markerValues: ['disabled', '[Default Voice]'],
        aliceOptions: [
            { value: '[Default Voice]', text: '[Default Voice]' },
            { value: 'disabled', text: 'deaktiviert' },
            { value: 'Voice A', text: 'Voice A' },
        ],
        defaultOptions: [
            { value: 'disabled', text: 'deaktiviert' },
            { value: 'Voice A', text: 'Voice A' },
        ],
        aliceInitialVal: 'disabled',
        defaultInitialVal: 'disabled',
        aliceVoiceIdAfterChange: 'disabled',
        defaultVoiceIdAfterChange: 'disabled',
        voiceMapUpdates: 3,
    });
});

async function openRoutedM104App(page, lang, { stubModules = {}, documents = {} } = {}) {
    const localeData = await assembledLocale(lang);
    const origin = 'http://m104.test';
    const publicDir = path.join(repoRoot, 'public');
    const contentType = p => p.endsWith('.html') ? 'text/html; charset=utf-8'
        : p.endsWith('.json') ? 'application/json; charset=utf-8'
            : 'text/javascript; charset=utf-8';
    const i18nStub = `
        import { localizeString } from '/scripts/ui-localization.js';
        const localeData = ${JSON.stringify(localeData)};
        export function translate(text, key = null) {
            const k = key || text;
            const table = k.startsWith('scoped.') ? localeData.scoped : localeData.dictionary;
            return table?.[k] || text;
        }
        export function t(strings, ...values) {
            const raw = strings.reduce((acc, s, i) => acc + s + (values[i] !== undefined ? '\${' + i + '}' : ''), '');
            return translate(raw).replace(/\\$\\{(\\d+)\\}/g, (_m, idx) => values[idx]);
        }
        export function localizeMessage(text) {
            return localizeString(text, localeData.dictionary);
        }
    `;
    await page.route(`${origin}/**`, async route => {
        const url = new URL(route.request().url());
        if (documents[url.pathname]) {
            return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: documents[url.pathname] });
        }
        if (url.pathname === '/scripts/i18n.js') {
            return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: i18nStub });
        }
        if (stubModules[url.pathname]) {
            return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: stubModules[url.pathname] });
        }
        if (url.pathname.startsWith('/scripts/') || url.pathname.startsWith('/locales/')) {
            const resolved = path.resolve(publicDir, '.' + decodeURIComponent(url.pathname));
            if (!resolved.startsWith(publicDir + path.sep)) return route.abort();
            return route.fulfill({ status: 200, contentType: contentType(resolved), path: resolved });
        }
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<main id="root"></main>' });
    });
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    return localeData;
}

test('L10N-48 & L10N-52: tool and lorebook tours translate macro paragraphs and dynamic speaker headings (tr-tr)', async ({ page }) => {
    const stubModules = {
        '/scripts/neconyan-assistant-art.js': 'export const getAssistantIconSrc = a => `/img/${a}.png`;',
        '/scripts/neconyan-page-intro.js': 'export function createPageIntro(key, kicker, description, launch) { const d = document.createElement("div"); d.className = "neconyan-tool-page-intro"; d.dataset.key = key; d.append(kicker, " ", description, launch); return d; }',
        '/scripts/neconyan-tour-invitations.js': 'export const TOOL_TOUR_INVITE_PREFIX = "tool_"; export const LOREBOOK_TOUR_INVITE_KEY = "lb"; export function addTourInvitationDismiss() {} export function dismissTourInvitation() {}',
    };
    await openRoutedM104App(page, 'tr-tr', { stubModules });
    const result = await page.evaluate(async () => {
        const toolTour = await import('/scripts/neconyan-tool-tour.js');
        const loreTour = await import('/scripts/neconyan-lorebook-tour.js');
        const root = document.getElementById('root');
        const heading = document.createElement('div');
        root.append(heading);
        toolTour.mountToolPage('connections', heading, root);
        const launch = heading.querySelector('.neconyan-tool-tour-button');
        const inviteStrong = heading.querySelector('.neconyan-tool-tour-invite strong');
        const connectionsMeta = {
            ariaLabel: launch.getAttribute('aria-label'),
            title: launch.getAttribute('title'),
            invite: inviteStrong.textContent,
        };
        toolTour.startToolTour('connections', root);
        const connectionsSpeaker = document.querySelector('.neconyan-tool-tour-speaker').textContent;
        toolTour.endToolTour({ restoreFocus: false });

        toolTour.startToolTour('macro-enhanced', root);
        const macroBody = [...document.querySelectorAll('.neconyan-tool-tour-body p')].map(p => p.textContent).join('\n');
        toolTour.endToolTour({ restoreFocus: false });

        const overridesStep = loreTour.getLorebookTourSteps({ hasBooks: true, hasEntries: true }).find(s => s.id === 'overrides');
        const loreTranslated = loreTour.translateLorebookTourCopy(overridesStep.body);
        return { connectionsMeta, connectionsSpeaker, macroBody, loreTranslated };
    });

    expect(result.connectionsMeta).toEqual({
        ariaLabel: 'Nori ile Bağlantılar turunu başlat',
        title: 'Bağlantılar boyunca rehberli bir gezinti',
        invite: 'Bağlantılar için yeni misiniz?',
    });
    expect(result.connectionsSpeaker).toBe('Nori ile Bağlantılar turu');
    expect(result.macroBody).toContain('Makro, {{char}} gibi çift süslü parantez içindeki kısa bir yönergedir.');
    expect(result.loreTranslated).toContain('**Outlet Adı**, **Outlet** konumu için çıkış adını belirler: bir isteme {{outlet::Name}} yazarsanız girdi orada görünür.');
});

test('L10N-51: Scratchpad BugReportError messages translate on render (tr-tr)', async ({ page }) => {
    const { dictionary } = await openRoutedM104App(page, 'tr-tr', {
        stubModules: { '/scripts/utils.js': 'export async function copyText() {}' },
    });
    const rendered = await page.evaluate(async dict => {
        const { splitBugReports } = await import('/scripts/scratchpad/bug-report.js');
        const { renderBugReportCard } = await import('/scripts/scratchpad/source-findings.js');
        const { localizeControls } = await import('/scripts/ui-localization.js');
        const reply = [
            '```neconyan-bug-report\n[]\n```',
            '```neconyan-bug-report\n{"summary":"x"}\n```',
            '```neconyan-bug-report\n{"title":"Broken"}\n```',
        ].join('\n');
        const root = document.getElementById('root');
        for (const part of splitBugReports(reply)) {
            if (part.type === 'bug-report') root.append(renderBugReportCard(part));
        }
        localizeControls(root, dict);
        return [...root.querySelectorAll('.scratchpad-muted[role="status"]')].map(node => node.textContent);
    }, dictionary);

    expect(rendered).toEqual([
        dictionary['This bug report draft is not a JSON object.'],
        dictionary['This bug report draft has no title.'],
        dictionary['This bug report draft does not say what went wrong.'],
    ]);
});

test('L10N-52: In-Chat Agents #ica--scope-description translates cleanly across scopes (tr-tr, ko-kr)', async ({ page }) => {
    for (const [lang, expectedAll, expectedGroup] of [
        ['tr-tr', 'Ajan anahtarları tüm sohbetler için geçerlidir. Bir ajanı son yanıtında çalıştırmak için bir sohbet açın.', 'Ajan anahtarları grup sohbetleri için geçerlidir.'],
        ['ko-kr', '에이전트 스위치는 모든 채팅에 적용돼요. 에이전트를 최근 답변에 실행하려면 채팅을 열어주세요.', '에이전트 스위치는 그룹 채팅에 적용돼요.'],
    ]) {
        await openSlicedRenderer(page, {
            '../public/scripts/extensions/in-chat-agents/index.js': ['updateAgentOverview'],
        }, lang);
        const result = await page.evaluate(() => {
            const { scope } = window.renderHarness;
            const root = document.getElementById('root');
            root.innerHTML = '<span id="ica--agent-count"></span><span id="ica--companion-count"></span><span id="ica--run-status"></span><span id="ica--scope-description"></span>';
            let settings = { enabled: true, separateRecentChats: false };
            let lastIdx = -1;
            let scopeLabel = 'Group chats';
            Object.assign(scope, {
                getCurrentChatId: () => 'chat1',
                isAgentEnabledForCurrentScope: () => false,
                isCompanionAgent: () => false,
                isAgentGenerationActive: () => false,
                areAgentsGloballyEnabled: () => true,
                getGlobalSettings: () => settings,
                getAgentChatScopeLabel: () => scopeLabel,
                getLastAssistantMessageIndex: () => lastIdx,
                isCurrentAgentWorkspace: () => true,
                lastManualRunFeedback: null,
                agentLibraryLoading: false,
                agentLibraryReady: true,
                updatePathfinderStatusLine() {},
            });
            scope.updateAgentOverview([]);
            const allNoReply = document.getElementById('ica--scope-description').textContent;
            settings = { enabled: true, separateRecentChats: true };
            lastIdx = 1;
            scope.updateAgentOverview([]);
            const groupWithReply = document.getElementById('ica--scope-description').textContent;
            return { allNoReply, groupWithReply };
        });
        expect(result.allNoReply).toBe(expectedAll);
        expect(result.groupWithReply).toBe(expectedGroup);
    }
});

test('L10N-52: Story Mode word count localises via scoped keys while keeping ordinary prose untouched (tr-tr, ko-kr)', async ({ page }) => {
    for (const [lang, singular, plural] of [
        ['tr-tr', '1\u00a0kelime', '2\u00a0kelime'],
        ['ko-kr', '1\u00a0단어', '2\u00a0단어'],
    ]) {
        const { dictionary } = await openRoutedM104App(page, lang, {
            stubModules: {
                '/scripts/extensions/third-party/Neconyan-Story-Mode/src/api.js': `
                    export const isBusy = () => false;
                    export const isEnabled = () => true;
                    export const canUndo = () => false;
                    export const canRedo = () => false;
                    export const manuscript = () => ({ words: globalThis.__storyWords ?? 0, text: '' });
                    export const ctx = () => ({});
                    export const toast = () => {};
                `,
            },
        });
        const result = await page.evaluate(async dict => {
            const { mountBar, refreshBar } = await import('/scripts/extensions/third-party/Neconyan-Story-Mode/src/ui.js');
            const { localizeControls } = await import('/scripts/ui-localization.js');
            const root = document.getElementById('root');
            root.innerHTML = '<div id="send_form"><div id="nonQRFormItems"></div></div><p id="prose">Famous last words</p>';
            const bar = mountBar();
            bar.hidden = false;

            globalThis.__storyWords = 1;
            refreshBar();
            localizeControls(root, dict);
            const one = document.getElementById('sbstory-words').textContent;

            globalThis.__storyWords = 2;
            refreshBar();
            localizeControls(root, dict);
            const two = document.getElementById('sbstory-words').textContent;

            return { one, two, prose: document.getElementById('prose').textContent };
        }, dictionary);

        expect(result.one).toBe(singular);
        expect(result.two).toBe(plural);
        expect(result.prose).toBe('Famous last words');
    }
});

test('L10N-52: Meower sessionBar translates generated default timelines while keeping user-named Timeline verbatim (tr-tr)', async ({ page }) => {
    await openSlicedRenderer(page, {
        '../public/scripts/extensions/third-party/Neconyan-Hopper/src/ui.js': ['el', 'icon', 'hostTag', 'translate', 'sessionDisplayName', 'button', 'sessionBar'],
    }, 'tr-tr');
    const options = await page.evaluate(() => {
        const { scope, dictionary, t, translate } = window.renderHarness;
        globalThis.SillyTavern = { getContext: () => ({ t, translate }) };
        Object.assign(scope, {
            searchOpen: false,
            state: { session: { id: 's0' }, timelineSearch: '' },
            api: {
                listPersonas: () => [],
                listSessions: () => [
                    { id: 's0', name: 'Timeline', defaultNameIndex: 0, personaId: 'missing' },
                    { id: 's2', name: 'Timeline 2', defaultNameIndex: 2, personaId: 'missing' },
                    { id: 'su0', name: 'Timeline', personaId: 'missing' },
                    { id: 'su2', name: 'Timeline 2', personaId: 'missing' },
                    { id: 'sd', name: 'Default', personaId: 'missing' },
                ],
            },
        });
        const root = document.getElementById('root');
        root.append(scope.sessionBar());
        window.localizeControls(root, dictionary);
        return [...root.querySelectorAll('.sbtw-session-select option')].map(o => o.textContent);
    });
    expect(options).toEqual([
        'Zaman çizelgesi · Atanmamış',
        'Zaman çizelgesi 2 · Atanmamış',
        'Timeline · Atanmamış',
        'Timeline 2 · Atanmamış',
        'Default · Atanmamış',
    ]);
});

test('L10N-52: Connection Manager <None> option translates while custom profile names stay protected (tr-tr)', async ({ page }) => {
    await openSlicedRenderer(page, {
        '../public/scripts/extensions/connection-manager/index.js': ['renderConnectionProfiles'],
    }, 'tr-tr');
    const result = await page.evaluate(() => {
        const { scope, dictionary } = window.renderHarness;
        const profile = { id: 'p1', name: 'Default', fav: false };
        Object.assign(scope, {
            extension_settings: { connectionManager: { selectedProfile: '', profiles: [profile] } },
            getSortedProfiles: () => [profile],
            getSortedFolders: () => [],
            compareProfiles: () => 0,
            updateProfileDetails() {},
        });
        const select = document.createElement('select');
        document.getElementById('root').append(select);
        scope.renderConnectionProfiles(select);
        window.localizeControls(select, dictionary);
        return [...select.options].map(o => ({ value: o.value, text: o.textContent, ignored: o.hasAttribute('data-i18n-ignore') }));
    });
    expect(result).toEqual([
        { value: '', text: '<Hiçbiri>', ignored: false },
        { value: 'p1', text: 'Default', ignored: true },
    ]);
});

test('L10N-53: shipped 404 page localises via page-locale.js (tr-tr)', async ({ page }) => {
    const notFoundHtml = await readFile(path.join(repoRoot, 'default/content/errors/url-not-found.html'), 'utf8');
    await page.addInitScript(() => localStorage.setItem('language', 'tr-tr'));
    await openRoutedM104App(page, 'tr-tr', {
        documents: { '/nonexistent-m104-route': notFoundHtml },
    });
    await page.goto('http://m104.test/nonexistent-m104-route', { waitUntil: 'domcontentloaded' });
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('tr-tr');
    expect(await page.title()).toBe('Bulunamadı');
    await expect(page.locator('h1')).toHaveText('Bulunamadı');
    await expect(page.locator('p')).toHaveText('Bu sayfa mevcut değil. Adreste yazım hatası olup olmadığını kontrol edin veya ana Neconyan sayfasına geri dönün.');
});

test('L10N-56: server crash notice and report reader localise unclean-previous-exit cause (tr-tr)', async ({ page }) => {
    const { dictionary } = await openRoutedM104App(page, 'tr-tr');
    const k23 = 'The previous process ended without running its exit handler. The operating system did not supply a cause; power loss, forced termination and native failures cannot be distinguished.';
    const result = await page.evaluate(async cause => {
        await import('/scripts/crash-diagnostics.js');
        const { createServerCrashObserver } = await import('/scripts/crash-diagnostics-context.js');
        const { localizeMessage } = await import('/scripts/i18n.js');
        const responseBody = JSON.stringify({
            schema: 1,
            runId: 'run-m104',
            latest: { id: 'rep-m104', at: '2026-11-24T12:00:00Z', errorPreview: cause },
        });
        const observer = createServerCrashObserver({
            isAdmin: () => true,
            getAccount: () => 'admin',
            getRequestHeaders: () => ({}),
            refreshCsrfToken: async () => {},
            localizeMessage,
            fetchFn: async () => ({ ok: true, status: 200, text: async () => responseBody }),
        });
        observer.start();
        await new Promise(resolve => setTimeout(resolve, 25));
        const noticeText = document.querySelector('#neconyan-crash-notice p')?.textContent || '';
        observer.stop();

        const { openCrashReportReader } = await import('/scripts/crash-report-reader.js');
        let readerSummary = '';
        openCrashReportReader({
            browserReports: { reports: [{ id: 'srv-1', runtime: 'server', at: '2026-11-24T12:00:00Z', kind: 'unclean-previous-exit', summary: 'Unexpected server stop', error: { message: cause } }] },
            selectedReportId: 'srv-1',
            localizeMessage,
            popup: content => {
                readerSummary = content.querySelector('[role="status"]')?.textContent || '';
                return { close() {} };
            },
        });
        return { noticeText, readerSummary };
    }, k23);

    expect(result.noticeText).toContain(dictionary[k23]);
    expect(result.readerSummary).toContain(dictionary[k23]);
});
