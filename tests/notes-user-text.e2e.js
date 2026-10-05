/* global window, document */
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const root = new URL('../', import.meta.url);
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html' };
// Portuguese values as in public/locales, plus entries (marked) that no language has yet.
const dictionary = {
    'Close ${0}': 'Fechar ${0}', 'Open ${0}': 'Abrir ${0}', 'Use ${0}': 'Usar ${0}', '${0} copy': '${0} (cópia)', Home: 'Início', Done: 'Concluído',
    // Not in any dictionary yet: they show that Notes captions stay translatable.
    Untitled: 'Sem título', 'Fold section': 'Recolher seção', 'Embedded note unavailable.': 'Nota incorporada indisponível.', 'Close match:': 'Correspondência aproximada:',
};

// translate() and t() as public/scripts/i18n.js defines them, reading the test's dictionary where the app reads the loaded locale.
function translate(text, key = null) {
    return window.notesDictionary?.[key || text] || text;
}
function t(strings, ...values) {
    const key = strings.reduce((result, string, i) => result + string + (values[i] !== undefined ? `\${${i}}` : ''), '');
    return translate(key).replace(/\$\{(\d+)\}/g, (_match, index) => values[index]);
}

function functionSource(text, name) {
    return text.match(new RegExp(`(?:export )?(?:async )?function ${name}\\([^]*?\\n}`, 'm'))[0].replace(/^export /, '');
}

/** Serves the real Notes modules and localiser from the checkout. lib.js is replaced by the two libraries render.js needs, and i18n.js by its translate() and t(). */
async function openNotes(page) {
    await page.route('https://notes.test/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><script src="/node_modules/showdown/dist/showdown.min.js"></script><main id="notes"></main>' });
        if (path === '/public/lib.js') return route.fulfill({ contentType: 'text/javascript', body: 'import DOMPurify from \'/node_modules/dompurify/dist/purify.es.mjs\'; export { DOMPurify }; export const showdown = globalThis.showdown;' });
        if (path === '/public/scripts/i18n.js') return route.fulfill({ contentType: 'text/javascript', body: `export ${translate}\nexport ${t}\n` });
        // A file this change adds is missing when the test runs on older code; answer 404 so that code can be tested too.
        const body = await readFile(new URL(`.${path}`, root)).catch(() => null);
        return body === null ? route.fulfill({ status: 404 }) : route.fulfill({ contentType: types[path.slice(path.lastIndexOf('.'))] ?? 'text/plain', body });
    });
    await page.goto('https://notes.test/');
    await page.addScriptTag({ type: 'module', content: `
        import { localizeControls } from '/public/scripts/ui-localization.js';
        import { renderNoteInto, headingOutline } from '/public/scripts/notebooks/render.js';
        import { h, button, field, formatTime } from '/public/scripts/notebooks/dom.js';
        // user-text.js is new in this change; without it the functions under test are the older ones that do not use it.
        const userText = await import('/public/scripts/notebooks/user-text.js').catch(() => ({}));
        window.notesModules = { localizeControls, renderNoteInto, headingOutline, h, button, field, formatTime, ...userText };
        // As the observer in i18n.js does for every node the page adds.
        window.observeNotes = dictionary => new MutationObserver(mutations => mutations.forEach(mutation => mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) localizeControls(node, dictionary);
            else if (node.nodeType === Node.TEXT_NODE && node.parentElement) localizeControls(node.parentElement, dictionary);
        }))).observe(document, { childList: true, subtree: true });` });
    await page.waitForFunction(() => Boolean(window.notesModules));
    const app = await readFile(new URL('public/scripts/notebooks/notes-app.js', root), 'utf8');
    const panels = await readFile(new URL('public/scripts/notebooks/notes-panels.js', root), 'utf8');
    return {
        list: `${functionSource(app, 'noteButton')}\n${app.includes('function searchSnippet(') ? functionSource(app, 'searchSnippet') : 'const searchSnippet = () => null;'}\nreturn { noteButton, searchSnippet };`,
        links: ['section', 'notice', 'linksPanel'].map(name => functionSource(panels, name)).join('\n') + '\nreturn linksPanel;',
    };
}

/** Renders a note with the real reader, lets the observer localise it, then localises the whole page again as applyLocale does. */
async function renderNote(page, dictionary, text, embeds = []) {
    return page.evaluate(async ([dictionary, text, embeds]) => {
        const { localizeControls, renderNoteInto, h } = window.notesModules;
        window.notesDictionary = dictionary;
        if (!window.notesObserved) window.notesObserved = window.observeNotes(dictionary) ?? true;
        const reader = h('div', { class: 'notes-reader' });
        document.getElementById('notes').append(reader);
        renderNoteInto(reader, text, { notebookId: 'book', noteId: 'n_0000000000000001', notePath: 'Plan.md', attachmentUrl: () => '', onFold: () => {}, embeds });
        await new Promise(resolve => setTimeout(resolve, 0));
        localizeControls(document.getElementById('notes'), dictionary);
    }, [dictionary, text, embeds]);
}

test('Notes leaves note titles and note text alone and keeps its captions translatable', async ({ page }) => {
    const sources = await openNotes(page);
    await renderNote(page, dictionary, [
        '# Close the door', '', 'Open the door, then Use cases. My plan copy', '',
        '- [ ] Home', '- [x] Close the door', '', '[[Home]] and ![[Missing note]]', '',
        '<abbr title="Close the door">CTD</abbr> ![a cat](https://example.com/cat.png)',
    ].join('\n'));
    const result = await page.evaluate(async ([dictionary, listSource]) => {
        const { localizeControls, h, button, formatTime } = window.notesModules;
        const translate = text => dictionary[text] || text;
        const { noteButton, searchSnippet } = new Function('h', 'button', 'formatTime', 'translate', 'app', listSource)(h, button, formatTime, translate, { state: {} });
        const main = document.getElementById('notes');
        main.prepend(h('ul', {},
            noteButton({ id: 'a', title: 'Close the door', folder: '', updatedAt: 0 }, searchSnippet({ snippet: 'Home', exact: false })),
            noteButton({ id: 'b', title: '', folder: '', updatedAt: 0 }, searchSnippet({ snippet: 'Open the door', exact: true }))));
        await new Promise(resolve => setTimeout(resolve, 0));
        localizeControls(main, dictionary);
        const text = selector => [...main.querySelectorAll(selector)].map(element => element.textContent);
        return {
            titles: text('.notes-note-title'),
            snippets: text('.notes-snippet'),
            heading: text('.notes-reader h1'),
            paragraph: text('.notes-reader p:not(.notes-embed-title)'),
            items: text('.notes-reader li'),
            boxes: [...main.querySelectorAll('.notes-reader input')].map(box => box.getAttribute('aria-label')),
            wikilink: text('.notes-wikilink'),
            placeholder: text('.notes-embed-placeholder'),
            abbr: [...main.querySelectorAll('abbr')].map(element => [element.textContent, element.title]),
            fold: [...main.querySelectorAll('.notes-read-fold')].map(control => [control.textContent, control.getAttribute('aria-label')]),
            image: text('.notes-external-image'),
        };
    }, [dictionary, sources.list]);
    expect(result).toEqual({
        titles: ['Close the door', 'Sem título'],
        snippets: ['Correspondência aproximada: Home', 'Open the door'],
        heading: ['Close the door'],
        paragraph: ['Open the door, then Use cases. My plan copy', 'Home and Nota incorporada indisponível.', 'CTD Load external image: a cat'],
        items: ['  Home', '  Close the door'],
        boxes: ['Not done', 'Concluído'],
        wikilink: ['Home'],
        placeholder: ['Nota incorporada indisponível.'],
        abbr: [['CTD', 'Close the door']],
        fold: [['Recolher seção', 'Fold Close the door']],
        image: ['Load external image: a cat'],
    });
});

test('a close match keeps its prefix in English without a dictionary entry and translates it with one, leaving the excerpt as written', async ({ page }) => {
    const sources = await openNotes(page);
    const excerpt = 'Close the door, then Home ';
    const result = await page.evaluate(async ([listSource, excerpt]) => {
        const { localizeControls, h, button, formatTime } = window.notesModules;
        const main = document.getElementById('notes');
        const show = async dictionary => {
            window.notesDictionary = dictionary;
            const translate = text => dictionary[text] || text;
            const { noteButton, searchSnippet } = new Function('h', 'button', 'formatTime', 'translate', 'app', listSource)(h, button, formatTime, translate, { state: {} });
            const list = h('ul', {}, noteButton({ id: 'a', title: 'Plan', folder: '', updatedAt: 0 }, searchSnippet({ snippet: excerpt, exact: false })));
            main.replaceChildren(list);
            localizeControls(main, dictionary);
            localizeControls(main, dictionary);
            const snippet = main.querySelector('.notes-snippet');
            return { snippet: snippet.textContent, excerpt: snippet.lastChild.textContent };
        };
        // Portuguese with the Portuguese review commits has 'Close ${0}' but no 'Close match:'.
        const without = await show({ 'Close ${0}': 'Fechar ${0}', Home: 'Início' });
        const withEntry = await show({ 'Close ${0}': 'Fechar ${0}', Home: 'Início', 'Close match:': 'Correspondência aproximada:' });
        return { without, withEntry };
    }, [sources.list, excerpt]);
    expect(result).toEqual({
        without: { snippet: `Close match: ${excerpt}`, excerpt },
        withEntry: { snippet: `Correspondência aproximada: ${excerpt}`, excerpt },
    });
});

test('a reader control inside an element whose title the note wrote keeps its translation', async ({ page }) => {
    await openNotes(page);
    // The Codex review's input and test dictionary, beside an ordinary Markdown task item.
    const codex = { Home: 'Inicio', Done: 'Concluido', 'Close ${0}': 'Fechar ${0}' };
    await renderNote(page, codex, '<ul><li title="Home">[x] Home</li></ul>');
    await renderNote(page, codex, '- [x] Home');
    const result = await page.evaluate(() => [...document.querySelectorAll('.notes-reader li')].map(item => ({
        title: item.getAttribute('title'), text: item.textContent.trim(), box: item.querySelector('input')?.getAttribute('aria-label'),
    })));
    expect(result).toEqual([{ title: 'Home', text: 'Home', box: 'Concluido' }, { title: null, text: 'Home', box: 'Concluido' }]);
});

test('note HTML that borrows a reader control class is still the note\'s own text', async ({ page }) => {
    await openNotes(page);
    // The Codex review's input and test dictionary, plus a real external image and two entries no language has yet.
    await renderNote(page, { Home: 'Inicio', Done: 'Concluido', 'Close ${0}': 'Fechar ${0}', 'Load external image': 'Carregar imagem externa',
        'Loading this image contacts another website.': 'Carregar esta imagem contacta outro site.' },
    '<p class="notes-external-image">Close the door</p>\n\n![](https://example.com/cat.png)');
    const result = await page.evaluate(() => ({
        authored: document.querySelector('p.notes-external-image').textContent,
        control: [...document.querySelectorAll('button.notes-external-image')].map(control => [control.textContent, control.title]),
    }));
    expect(result).toEqual({ authored: 'Close the door', control: [['Carregar imagem externa', 'Carregar esta imagem contacta outro site.']] });
});

test('an interface sentence holding the user\'s words is translated whole, in its own word order, and the words stay as written', async ({ page }) => {
    const sources = await openNotes(page);
    const result = await page.evaluate(async linksSource => {
        const { h, button, headingOutline, userPhrase } = window.notesModules;
        // Hypothetical entries in which the user's words move: no language has these keys yet.
        const dictionary = { Home: 'Início', '${0}: no note with this name yet.': 'Ainda não há nota chamada ${0}.',
            '${0}: more than one note matches.': 'Mais de uma nota corresponde a ${0}.' };
        window.notesDictionary = dictionary;
        window.observeNotes(dictionary);
        const linksPanel = new Function('h', 'button', 'headingOutline', 'userPhrase', 'jumpTo', linksSource)(h, button, headingOutline, userPhrase, () => {});
        const app = { state: { notebookId: 'book', note: { id: 'n_0000000000000001', folder: '' } }, elements: { textarea: { value: '' } }, failed: () => false,
            request: async () => ({ outgoing: [{ status: 'missing', label: 'Home' }, { status: 'ambiguous', label: 'Close the door' }], backlinks: [] }) };
        const main = document.getElementById('notes');
        main.append(...await linksPanel(app));
        await new Promise(resolve => setTimeout(resolve, 0));
        window.notesModules.localizeControls(main, dictionary);
        return [...main.querySelectorAll('li')].map(item => item.firstChild.textContent.trim());
    }, sources.links);
    expect(result).toEqual(['Ainda não há nota chamada Home.', 'Mais de uma nota corresponde a Close the door.']);
});

test('the reader keeps a heading named like an interface word in its fold label, before and after folding', async ({ page }) => {
    await openNotes(page);
    // 'Home' as in pt-pt.json; the fold wording is hypothetical, no language has it yet.
    await renderNote(page, { Home: 'Início', 'Close ${0}': 'Fechar ${0}', 'Fold ${0}': 'Recolher ${0}', 'Show ${0}': 'Mostrar ${0}',
        'Fold section': 'Recolher secção', 'Show section': 'Mostrar secção' }, '# Home\n\nSome text.\n\n# Close the door\n\nMore text.');
    const result = await page.evaluate(async () => {
        const read = () => [...document.querySelectorAll('.notes-read-fold')].map(control => [control.textContent, control.getAttribute('aria-label')]);
        const settle = async () => {
            await new Promise(resolve => setTimeout(resolve, 0));
            window.notesModules.localizeControls(document.getElementById('notes'), window.notesDictionary);
        };
        const first = read();
        document.querySelector('.notes-read-fold').click();
        await settle();
        const folded = read();
        document.querySelector('.notes-read-fold').click();
        await settle();
        return { first, folded, unfolded: read(), heading: document.querySelector('.notes-reader h1').textContent };
    });
    expect(result).toEqual({
        first: [['Recolher secção', 'Recolher Home'], ['Recolher secção', 'Recolher Close the door']],
        folded: [['Mostrar secção', 'Mostrar Home'], ['Recolher secção', 'Recolher Close the door']],
        unfolded: [['Recolher secção', 'Recolher Home'], ['Recolher secção', 'Recolher Close the door']],
        heading: 'Home',
    });
});

test('an embedded note inside an element the note gave a title keeps its controls translated and its words as written', async ({ page }) => {
    await openNotes(page);
    const text = '<div title="Home">![[Home]]</div>\n\n![[Home]]';
    const embed = start => ({ start, end: start + 9, status: 'rendered', noteId: 'n_0000000000000002', path: 'Home.md', title: 'Home', text: 'Close the door', fragment: '' });
    // 'Home' and 'Close ${0}' as in pt-pt.json; complete translations of the embed's own wording, which no language has yet.
    await renderNote(page, { Home: 'Início', 'Close ${0}': 'Fechar ${0}', 'Open ${0}': 'Abrir ${0}', 'Open note': 'Abrir nota',
        'Fold embed': 'Recolher incorporação', 'Show embed': 'Mostrar incorporação' }, text, [embed(text.indexOf('![[')), embed(text.lastIndexOf('![['))]);
    const result = await page.evaluate(async () => {
        const read = () => [...document.querySelectorAll('.notes-reader .notes-embed')].map(card => ({
            inside: Boolean(card.closest('[title]')),
            title: card.querySelector('.notes-embed-title').textContent,
            buttons: [...card.querySelectorAll('.notes-embed-header button')].map(control => control.textContent),
            body: card.querySelector('.notes-embed-body').textContent.trim(),
        }));
        const first = read();
        for (const control of document.querySelectorAll('.notes-embed-header button:last-child')) control.click();
        await new Promise(resolve => setTimeout(resolve, 0));
        window.notesModules.localizeControls(document.getElementById('notes'), window.notesDictionary);
        return { first, folded: read(), divTitle: document.querySelector('.notes-reader div[title]').getAttribute('title') };
    });
    const card = (inside, fold) => ({ inside, title: 'Home', buttons: ['Abrir nota', fold], body: 'Close the door' });
    expect(result).toEqual({
        first: [card(true, 'Recolher incorporação'), card(false, 'Recolher incorporação')],
        folded: [card(true, 'Mostrar incorporação'), card(false, 'Mostrar incorporação')],
        divTitle: 'Home',
    });
});
