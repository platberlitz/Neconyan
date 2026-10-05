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
    const table = await readFile(new URL('public/scripts/notebooks/property-table.js', root), 'utf8');
    const canvas = await readFile(new URL('public/scripts/notebooks/canvas.js', root), 'utf8');
    return {
        // userToast is new in this change; on older code a toast is shown as it was, through toastr directly.
        toast: `${app.includes('function userToast(') ? functionSource(app, 'userToast') : 'const userToast = (kind, message) => globalThis.toastr[kind](message);'}\nreturn userToast;`,
        list: `${functionSource(app, 'noteButton')}\n${app.includes('function searchSnippet(') ? functionSource(app, 'searchSnippet') : 'const searchSnippet = () => null;'}\nreturn { noteButton, searchSnippet };`,
        links: ['section', 'notice', 'linksPanel'].map(name => functionSource(panels, name)).join('\n') + '\nreturn linksPanel;',
        entries: `${functionSource(panels, 'pickEntry')}\nreturn pickEntry;`,
        property: `${functionSource(await readFile(new URL('public/scripts/notebooks/notes-dialogs.js', root), 'utf8'), 'editPropertyCell')}\nreturn editPropertyCell;`,
        review: `${functionSource(await readFile(new URL('public/scripts/notebooks/notes-dialogs.js', root), 'utf8'), 'reviewProposal')}\nreturn reviewProposal;`,
        tool: `${functionSource(await readFile(new URL('public/scripts/neconyan-assistant-tools.js', root), 'utf8'), 'noteTool')}\nreturn noteTool;`,
        job: `${functionSource(await readFile(new URL('public/scripts/neconyan-assistant-job-review.js', root), 'utf8'), 'review')}\nreturn review;`,
        table: ['propertyTableScopeCurrent', 'bindPropertyTableTouchScroll', 'createPropertyTableView']
            .map(name => functionSource(table, name)).join('\n') + '\nreturn createPropertyTableView;',
        lore: ['notice', 'publishFlow', 'bindingRow', 'contextItem', 'usedItem', 'contextPreview'].map(name => functionSource(panels, name)).join('\n')
            + '\nreturn { publishFlow, bindingRow, contextPreview };',
        canvas: ['canvasBounds', 'canvasEdgePoint', 'svgElement', 'canvasColor', 'canvasDiagram'].map(name => functionSource(canvas, name)).join('\n') + '\nreturn canvasDiagram;',
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

test('Notes leaves the names it shows alone: folders, notebook buttons and property names', async ({ page }) => {
    const sources = await openNotes(page);
    const result = await page.evaluate(async ([dictionary, listSource]) => {
        const { h, button, field, formatTime } = window.notesModules;
        const { noteButton } = new Function('h', 'button', 'formatTime', 'translate', 'app', listSource)(h, button, formatTime, text => text, { state: {} });
        window.observeNotes(dictionary);
        const main = document.getElementById('notes');
        main.append(
            h('ul', {}, noteButton({ id: 'a', title: 'Plan', folder: 'Home', favourite: true, updatedAt: 0 }), noteButton({ id: 'b', title: 'Plan', folder: '', updatedAt: 0 })),
            button('Close the door (2)', () => {}, { userText: true, title: 'Close the door (2 notes)' }),
            button('Home', () => {}),
            field('Home', h('input'), '', { userLabel: true }),
            field('Home', h('input')));
        await new Promise(resolve => setTimeout(resolve, 0));
        const meta = [...main.querySelectorAll('.notes-note-meta')].map(element => element.textContent);
        return {
            folders: meta.map(value => value.split(' · ')[0]),
            favourite: meta[0].includes(' · Favourite · '),
            buttons: [...main.querySelectorAll(':scope > button')].map(control => [control.textContent, control.title]),
            labels: [...main.querySelectorAll('label')].map(label => label.textContent),
        };
    }, [{ ...dictionary, 'Top level': 'Nível superior' }, sources.list]);
    expect(result).toEqual({
        folders: ['Home', 'Nível superior'],
        favourite: true,
        buttons: [['Close the door (2)', 'Close the door (2 notes)'], ['Início', '']],
        labels: ['Home', 'Início'],
    });
});

test('the Codex review\'s mixed captions translate their wording and keep a name that is also an interface word', async ({ page }) => {
    const sources = await openNotes(page);
    const result = await page.evaluate(async sources => {
        const { h, button, field, headingOutline, userPhrase, localizeControls } = window.notesModules;
        const { parsePropertyValue, propertyInput } = await import('/public/scripts/notebooks/property-values.js');
        // Hypothetical entries for the three instructions (German word order for one of them); 'Home' and 'Close ${0}' as in pt-pt.json.
        const dictionary = { Home: 'Início', 'Close ${0}': 'Fechar ${0}', 'Edit ${0}': '${0} bearbeiten',
            'Choose an entry in ${0}.': 'Escolha uma entrada em ${0}.', 'Web link: ${0}': 'Ligação web: ${0}' };
        window.notesDictionary = dictionary;
        window.observeNotes(dictionary);
        const main = document.getElementById('notes');
        const shown = [];
        const show = content => { shown.push(content); main.append(content); return new Promise(() => {}); };
        const clear = element => element.replaceChildren();
        const editPropertyCell = new Function('h', 'button', 'field', 'clear', 'propertyInput', 'parsePropertyValue', 'fieldId', 'dialog', 'userPhrase', sources.property)(
            h, button, field, clear, propertyInput, parsePropertyValue, name => `notes-${name}`, show, userPhrase);
        void editPropertyCell({}, { title: 'Plan' }, 'Home', { editable: true, kind: 'text', value: 'x', display: 'x' });
        const pickEntry = new Function('h', 'button', 'callGenericPopup', 'POPUP_TYPE', 'userPhrase', sources.entries)(h, button, show, { TEXT: 1 }, userPhrase);
        void pickEntry({ request: async () => ({ entries: [] }), failed: () => false }, 'Home');
        const linksPanel = new Function('h', 'button', 'headingOutline', 'userPhrase', 'jumpTo', sources.links)(h, button, headingOutline, userPhrase, () => {});
        main.append(...await linksPanel({ state: { notebookId: 'book', note: { id: 'n_0000000000000001', folder: '' } }, elements: { textarea: { value: '' } },
            failed: () => false, request: async () => ({ outgoing: [{ status: 'external', label: 'Home', target: 'Home' }], backlinks: [] }) }));
        await new Promise(resolve => setTimeout(resolve, 0));
        localizeControls(main, dictionary);
        return [main.querySelector('.notes-property-dialog h3').textContent, shown[1].querySelector('p').textContent,
            [...main.querySelectorAll('li')].at(-1).textContent];
    }, sources);
    expect(result).toEqual(['Home bearbeiten', 'Escolha uma entrada em Home.', 'Ligação web: Home']);
});

test('a property cell with no value translates Not set and its instruction and keeps the names, before and after an edit', async ({ page }) => {
    const sources = await openNotes(page);
    const result = await page.evaluate(async source => {
        const { h, button, field, localizeControls } = window.notesModules;
        const { clear, setButtonPressed } = await import('/public/scripts/notebooks/dom.js');
        const { parsePropertyValue } = await import('/public/scripts/notebooks/property-values.js');
        const { t, translate } = await import('/public/scripts/i18n.js');
        // 'Home' and 'Not set' as in pt-pt.json; the instruction entry is hypothetical, with the names in another order.
        const dictionary = { Home: 'Início', 'Not set': 'Não definido', 'Close ${0}': 'Fechar ${0}', 'Edit ${0} for ${1}': 'Editar ${0} de ${1}' };
        window.notesDictionary = dictionary;
        window.observeNotes(dictionary);
        const row = cell => ({ id: 'n_0000000000000001', title: 'Home', path: 'Home.md', revision: 'r', cells: { Home: cell } });
        const replies = [{ kind: 'missing', editable: true, display: 'Not set' }, { kind: 'text', value: 'Close the door', editable: true, display: 'Close the door' }]
            .map(cell => ({ status: 'success', rows: [row(cell)], columns: ['Home'], availableColumns: ['Home'], offset: 0, total: 1, nextOffset: null, limited: {} }));
        let edited;
        const app = { state: { workspaceView: 'table', account: 'owner', notebookId: 'book', workspaceVersion: 1, notebookSelectionVersion: 1, noteRequestVersion: 1 },
            request: async () => replies[Math.min(edited ? 1 : 0, 1)], openNote: () => {}, toast: () => {}, closeNotebookView: () => {},
            refreshTree: async () => {}, dialogs: { editPropertyCell: async () => { edited = true; return true; } } };
        const container = h('section');
        document.getElementById('notes').append(container);
        const createPropertyTableView = new Function('h', 'button', 'field', 'clear', 'setButtonPressed', 'parsePropertyValue', 't', 'translate', source)(
            h, button, field, clear, setButtonPressed, parsePropertyValue, t, translate);
        const settle = async () => {
            for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setTimeout(resolve, 0));
            localizeControls(document.getElementById('notes'), dictionary);
        };
        const read = () => {
            const cell = container.querySelector('td[data-property-key="Home"] > *');
            return { heading: [...container.querySelectorAll('thead th')].map(cell => cell.textContent), note: container.querySelector('.notes-table-note').textContent,
                cell: cell.textContent, label: cell.getAttribute('aria-label') };
        };
        await createPropertyTableView(app, container).open();
        await settle();
        const first = read();
        container.querySelector('td[data-property-key="Home"] > button').click();
        await settle();
        return { first, updated: read() };
    }, sources.table);
    expect(result).toEqual({
        first: { heading: ['Note', 'Home'], note: 'Home', cell: 'Não definido', label: 'Editar Home de Home' },
        updated: { heading: ['Note', 'Home'], note: 'Home', cell: 'Close the door', label: 'Editar Home de Home' },
    });
});

test('a canvas card the user labelled translates its label through Select card and keeps the name', async ({ page }) => {
    const sources = await openNotes(page);
    const result = await page.evaluate(async source => {
        const { localizeControls } = window.notesModules;
        const { t } = await import('/public/scripts/i18n.js');
        // 'Home' as in pt-pt.json; the 'Select card: ${0}' and 'Text card' entries are hypothetical.
        const dictionary = { Home: 'Início', 'Select card: ${0}': 'Selecionar cartão: ${0}', 'Text card': 'Cartão de texto' };
        window.notesDictionary = dictionary;
        window.observeNotes(dictionary);
        const canvasDiagram = new Function('t', source)(t);
        const card = (id, label, user, x) => ({ id, type: user ? 'file' : 'text', x, y: 0, width: 200, height: 80, label, user });
        document.getElementById('notes').append(canvasDiagram([card('a', 'Home', true, 0), card('b', 'Text card', false, 300)], [], { viewportWidth: 800 }));
        await new Promise(resolve => setTimeout(resolve, 0));
        localizeControls(document.getElementById('notes'), dictionary);
        return [...document.querySelectorAll('[data-canvas-node]')].map(group => [group.getAttribute('aria-label'), group.querySelector('text').textContent,
            group.querySelector(':scope > title').textContent]);
    }, sources.canvas);
    expect(result).toEqual([['Selecionar cartão: Home', 'Home', 'Home'], ['Selecionar cartão: Cartão de texto', 'Cartão de texto', 'Cartão de texto']]);
});

test('Whole note translates only for a whole-note selection; a heading the user named Whole note stays as written', async ({ page }) => {
    const sources = await openNotes(page);
    const result = await page.evaluate(async source => {
        const { h, button, localizeControls, userPhrase, regionLabel, proposalLabel } = window.notesModules;
        const { formatTime } = await import('/public/scripts/notebooks/dom.js');
        // A hypothetical 'Whole note' entry (no language has one), and 'Home' as in pt-pt.json.
        const dictionary = { 'Whole note': 'Nota inteira', Home: 'Início', 'Close ${0}': 'Fechar ${0}' };
        window.notesDictionary = dictionary;
        window.observeNotes(dictionary);
        const main = document.getElementById('notes');
        const shown = [];
        const show = content => { shown.push(content); main.append(content); return new Promise(() => {}); };
        const { publishFlow, bindingRow, contextPreview } = new Function('h', 'button', 'formatTime', 'userPhrase', 'regionLabel', 'proposalLabel', 'dialog',
            'callGenericPopup', 'POPUP_TYPE', 'LORE_STATUS', 'newOperationId', 'refreshWorldInfo', 'renderDetails', source)(h, button, formatTime, userPhrase,
            regionLabel, proposalLabel, show, show, { TEXT: 1 }, {}, () => 'operation', async () => {}, () => {});
        // As src/notebooks/lore.js sends them: the same label for a whole-note selection and for a heading named 'Whole note'.
        const whole = { kind: 'note' };
        const heading = { kind: 'heading', path: ['Whole note'] };
        const preview = selector => ({ selector, selectorLabel: 'Whole note', noteTitle: 'Plan', book: 'Book', entryTitle: 'Entry', createsEntry: true, after: 'Text', enabled: true });
        const app = selector => ({ state: { notebookId: 'book', note: { id: 'n_0000000000000001', revision: 'r', title: 'Plan' } }, flushSave: async () => true,
            failed: () => false, request: async () => ({ preview: preview(selector) }), toast: () => {}, compareTexts: () => {} });
        // Publish preview ('From: …'), notes-panels.js publishFlow.
        for (const selector of [whole, heading]) void publishFlow(app(selector), { selector, book: 'Book', uid: null, title: 'Entry' });
        // Binding title and, from its 'Copy lore into note' button, the replace confirmation, notes-panels.js bindingRow.
        const rows = [whole, heading].map(selector => bindingRow(app(selector), { id: 'b', status: 'lore_changed', selector, selectorLabel: 'Whole note',
            book: 'Book', uid: 1, entryTitle: 'Entry', policy: 'manual' }));
        main.append(...rows);
        for (const row of rows) [...row.querySelectorAll('button')].find(control => control.textContent === 'Copy lore into note').click();
        // Context preview, notes-panels.js contextPreview: the server sends heading paths, and lore-bound regions, as text.
        void contextPreview({ failed: value => !value, request: async route => (route === '/context/preview'
            ? { usedTokens: 1, budgetTokens: 2, items: [{ title: 'Plan', section: 'Whole note', mode: 'reference', tokens: 3 }], excludedBound: [{ title: 'Plan', regions: ['Whole note'] }] }
            : null) }, { chat: 'chat' });
        for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setTimeout(resolve, 0));
        // A later pass, as applyLocale makes over the whole page.
        localizeControls(main, dictionary);
        const text = element => element.textContent.trim();
        return {
            // Each dialog is recognised by its content, as they open in whatever order their requests settle.
            from: shown.filter(content => content.matches('.notes-publish-preview')).map(content => text(content.querySelector('h3 + p'))).sort(),
            titles: rows.map(row => text(row.querySelector('.notes-binding-title'))),
            replace: shown.filter(content => content.matches('p')).map(content => text(content).slice(0, 22)).sort(),
            context: [...shown.find(content => content.querySelector('li')).querySelectorAll('li, .notes-hint')].map(text),
        };
    }, sources.lore);
    expect(result).toEqual({
        from: ['From: Plan, Nota inteira', 'From: Plan, Whole note'].sort(),
        titles: ['Nota inteira → Book: Entry', 'Whole note → Book: Entry'],
        replace: ['Replace "Nota inteira"', 'Replace "Whole note" i'].sort(),
        context: ['Plan (Whole note): reference, about 3 tokens', 'Sent through the lorebook instead: Plan (Whole note).'],
    });
});

test('a Notes toast carrying a name translates its message whole and shows the name exactly, through the observer and a later pass', async ({ page }) => {
    const sources = await openNotes(page);
    await page.addScriptTag({ url: '/public/lib/jquery-3.5.1.min.js' });
    await page.addScriptTag({ url: '/public/lib/toastr.min.js' });
    const book = 'Home';
    const entry = '"<b>Close</b> the door" & \'it\'';
    const result = await page.evaluate(async ([source, book, entry]) => {
        const { localizeControls } = window.notesModules;
        const { t } = await import('/public/scripts/i18n.js');
        // As script.js sets it for the whole app.
        window.toastr.options = { ...window.toastr.options, escapeHtml: true, timeOut: 0, extendedTimeOut: 0 };
        const userToast = new Function(source)();
        const notesApp = await fetch('/public/scripts/notebooks/notes-app.js').then(response => response.text());
        const show = async dictionary => {
            window.notesDictionary = dictionary;
            // The site in notes-panels.js publishFlow, as it is written: t`` on new code, a plain template before.
            userToast('success', notesApp.includes('function userToast(') ? t`Published to ${book}: ${entry}` : `Published to ${book}: ${entry}`);
            await new Promise(resolve => setTimeout(resolve, 0));
            localizeControls(document.body, dictionary);
            const toast = document.querySelector('#toast-container .toast:first-child');
            return { message: toast.querySelector('.toast-message').textContent, html: toast.querySelector('.toast-message b') !== null,
                messageMarked: toast.querySelector('.toast-message').hasAttribute('data-i18n-ignore'),
                toastMarked: toast.hasAttribute('data-i18n-ignore'), kind: toast.className };
        };
        // pt-pt as shipped: 'Home' is 'Início' and has 'Close ${0}'; no language has the toast's own key yet.
        const shipped = { Home: 'Início', 'Close ${0}': 'Fechar ${0}' };
        window.observeNotes(shipped);
        const missing = await show(shipped);
        const supplied = await show({ ...shipped, 'Published to ${0}: ${1}': 'Publicado em ${0}: ${1}' });
        return { missing, supplied };
    }, [sources.toast, book, entry]);
    expect(result).toEqual({
        missing: { message: `Published to Home: ${entry}`, html: false, messageMarked: true, toastMarked: false, kind: 'toast toast-success' },
        supplied: { message: `Publicado em Home: ${entry}`, html: false, messageMarked: true, toastMarked: false, kind: 'toast toast-success' },
    });
});

test('the assistant\'s proposal review, from Notes and from both chat routes, translates its wording and keeps the note title and sections as written', async ({ page }) => {
    const sources = await openNotes(page);
    const result = await page.evaluate(async sources => {
        const { localizeControls } = window.notesModules;
        // 'Home' as in pt-pt.json; the other entries are hypothetical.
        const dictionary = { Home: 'Início', 'Allow this change? ${0}': 'Permitir esta alteração? ${0}', 'Create note: ${0}': 'Criar nota: ${0}',
            'Sections: ${0}': 'Secções: ${0}', 'Whole note': 'Nota inteira' };
        window.notesDictionary = dictionary;
        window.observeNotes(dictionary);
        const { buildAssistantReview, buildNoteProposalReview } = await import('/public/scripts/neconyan-assistant-review.js');
        const { formatDiff } = await import('/public/scripts/notebooks/line-diff.js');
        // A section named 'Home' alone is what the run-time localiser's 'Sections: ${0}' pattern would turn into 'Início'.
        const summary = { operation: 'create', label: 'Create note: Home', noteTitle: 'Home', changedRegions: ['Home'] };
        const notesSummary = { ...summary, changedRegions: ['Whole note', 'Home'] };
        const main = document.getElementById('notes');
        const shown = {};
        // The popup is replaced: it shows each route's review in the page and never answers.
        const popup = route => content => { shown[route] = content; main.append(content); return new Promise(() => {}); };
        // Notes: the real reviewProposal from notes-dialogs.js.
        const reviewProposal = new Function('buildNoteProposalReview', 'formatDiff', 'callGenericPopup', 'POPUP_TYPE', sources.review)(
            buildNoteProposalReview, formatDiff, popup('notes'), { CONFIRM: 2 });
        void reviewProposal({ request: async () => ({ state: 'waiting', summary: notesSummary, before: '', after: 'Home' }), failed: () => false }, 'p1');
        // Chat, assistant tools: the real noteTool from neconyan-assistant-tools.js.
        const noteTool = new Function('postNotebook', 'shortHash', 'formatDiff', 'callGenericPopup', 'POPUP_TYPE', 'POPUP_RESULT', 'buildNoteProposalReview', sources.tool)(
            async route => (route === '/assistant/tool' ? { status: 'needs_approval', proposalId: 'p2', summary } : { status: 'success', summary, before: '', after: 'Home' }),
            text => text, formatDiff, popup('tools'), { CONFIRM: 2 }, { AFFIRMATIVE: 1 }, buildNoteProposalReview);
        void noteTool('create')({}, { invocation: {}, callId: 'call', assert: () => {} });
        // Chat, background jobs: the real review from neconyan-assistant-job-review.js.
        const reviewJob = new Function('getCurrentUserHandle', 'getJobApproval', 'decideJobApproval', 'callGenericPopup', 'POPUP_RESULT', 'POPUP_TYPE',
            'buildNoteProposalReview', 'buildAssistantReview', sources.job)(() => 'owner',
            async () => ({ decision: null, proposal: { kind: 'neconyan-note-proposal', summary, diff: '+ Home' } }),
            async () => {}, popup('jobs'), { AFFIRMATIVE: 1 }, { CONFIRM: 2 }, buildNoteProposalReview, buildAssistantReview);
        void reviewJob({ id: 'job', result: { approval: { id: 'approval' } } }, 'owner');
        for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setTimeout(resolve, 0));
        // A later pass, as applyLocale makes over the whole page.
        localizeControls(main, dictionary);
        const lines = route => [...shown[route].querySelectorAll('p')].map(line => line.textContent).filter(line => /Home/.test(line));
        return { notes: lines('notes'), tools: lines('tools'), jobs: lines('jobs') };
    }, sources);
    const chat = ['Permitir esta alteração? Criar nota: Home', 'Secções: Home'];
    // The sections arrive as text, so 'Whole note' is shown as written even with an entry: it may be a heading the user named so.
    expect(result).toEqual({ notes: ['Permitir esta alteração? Criar nota: Home', 'Secções: Whole note, Home'], tools: chat, jobs: chat });
});
