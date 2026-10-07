/* global window, document */
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

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
        textareaPlaceholder: 'Recent',
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
