import { t } from '../i18n.js';
import { notesRequest, newOperationId } from '../notebooks/api.js';
import { h, clear } from '../notebooks/dom.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../popup.js';

export async function noteTool(tool, args = {}) {
    const response = await notesRequest('/assistant/tool', { tool, args, callId: newOperationId('scratchpad-read') });
    if (response.status && response.status !== 'success') throw new Error(response.message || t`Notes could not be read.`);
    return response;
}

/** The picker only lists notes already shared with assistants. Private sharing starts in Notes. */
export async function chooseNote({ isCurrent }) {
    const { notebooks } = await noteTool('notebooks');
    if (!isCurrent()) return null;
    const select = h('select', { class: 'text_pole', 'aria-label': t`Notebook to search` },
        h('option', { value: '', text: t`All shared notebooks` }),
        notebooks.map(book => h('option', { value: book.notebookId, text: book.name, 'data-i18n-ignore': '' })));
    const search = h('input', { class: 'text_pole', type: 'search', maxlength: '400', placeholder: t`Search shared notes`, 'aria-label': t`Search shared notes` });
    const results = h('div', { class: 'scratchpad-note-results', role: 'group', 'aria-label': t`Shared notes` });
    let chosen = null;
    let ticket = 0;
    let timer = 0;
    const refresh = async () => {
        const current = ++ticket;
        try {
            const found = await noteTool('search-notes', { query: search.value, ...(select.value ? { notebookId: select.value } : {}) });
            if (current !== ticket || !isCurrent()) return;
            clear(results);
            if (!found.results.length) results.append(h('p', { text: t`No shared notes match. Share a private note from Notes, or allow assistant access under AI access.` }));
            for (const note of found.results) results.append(h('button', { type: 'button', class: 'menu_button scratchpad-note-result', 'aria-pressed': 'false',
                onclick: event => {
                    chosen = { notebookId: note.notebookId, noteId: note.noteId };
                    for (const button of results.querySelectorAll('button')) button.setAttribute('aria-pressed', 'false');
                    event.currentTarget.setAttribute('aria-pressed', 'true');
                } }, h('strong', { text: note.title, 'data-i18n-ignore': '' }), h('small', { text: note.path, 'data-i18n-ignore': '' }), h('span', { text: note.snippet, 'data-i18n-ignore': '' })));
        } catch (error) {
            if (current === ticket) results.replaceChildren(h('p', { text: error.message }));
        }
    };
    search.addEventListener('input', () => { clearTimeout(timer); chosen = null; ticket++; timer = setTimeout(() => void refresh(), 200); });
    select.addEventListener('change', () => { chosen = null; void refresh(); });
    const content = h('div', { class: 'scratchpad-review' }, h('h3', { text: t`Add a saved note` }),
        h('p', { text: t`Scratchpad reads only the notes you add. Linked notes and attachments stay out.` }), select, search, results);
    void refresh();
    const result = await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', { wide: true, large: true, okButton: t`Choose note`, cancelButton: t`Cancel`,
        onClosing: popup => popup.result !== POPUP_RESULT.AFFIRMATIVE || Boolean(chosen && isCurrent()) });
    ticket++;
    clearTimeout(timer);
    if (result !== POPUP_RESULT.AFFIRMATIVE || !chosen || !isCurrent()) return null;
    const note = await noteTool('read-note', chosen);
    if (!isCurrent()) return null;
    const sections = h('select', { class: 'text_pole', 'aria-label': t`Note or section to share` },
        h('option', { value: '', text: t`Whole note` }), (note.sections ?? []).map(section => h('option', { value: section.id, text: section.heading, 'data-i18n-ignore': '' })));
    const excerpt = h('pre', { class: 'scratchpad-preview-text', text: note.text });
    const detail = h('div', { class: 'scratchpad-review' }, h('h3', { text: note.title, 'data-i18n-ignore': '' }), sections,
        h('p', { text: t`Each shared page contains up to 24,000 characters. You can move between pages under Context.` }), excerpt);
    let selectedTicket = 0;
    let previewRead = Promise.resolve();
    let previewReady = true;
    sections.addEventListener('change', () => {
        const current = ++selectedTicket;
        previewReady = false;
        excerpt.textContent = t`Reading the selected section…`;
        previewRead = (async () => {
            try {
                const part = await noteTool('read-note', { ...chosen, ...(sections.value ? { sectionId: sections.value } : {}) });
                if (current === selectedTicket && isCurrent()) {
                    excerpt.textContent = part.text;
                    previewReady = true;
                }
            } catch (error) { if (current === selectedTicket) excerpt.textContent = error.message; }
        })();
    });
    const confirm = await callGenericPopup(detail, POPUP_TYPE.CONFIRM, '', { wide: true, large: true, okButton: t`Share with Scratchpad`, cancelButton: t`Cancel`,
        onClosing: async popup => {
            if (popup.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            let current;
            do { current = selectedTicket; await previewRead; } while (current !== selectedTicket);
            return previewReady && isCurrent();
        } });
    selectedTicket++;
    return confirm === POPUP_RESULT.AFFIRMATIVE && isCurrent() ? { ...chosen, ...(sections.value ? { sectionId: sections.value } : {}) } : null;
}

export function sessionNoteText(session, cleanReply) {
    return session.messages.filter(message => message.role === 'user' || message.state === 'done').flatMap(message => {
        const text = message.role === 'assistant' ? cleanReply(message.text) : message.text;
        if (!text.trim()) return [];
        const name = message.role === 'user' ? 'You' : (message.assistant || session.assistant);
        return [`## ${name}\n\n${text}`];
    }).join('\n\n');
}
