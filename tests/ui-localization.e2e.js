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
            untouched: text('.ch_name, .mes_text p, .characterName, textarea, pre'),
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
        untouched: ['Recent', 'Recent', 'Recent', 'Recent', 'Recent'],
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
