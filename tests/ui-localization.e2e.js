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
