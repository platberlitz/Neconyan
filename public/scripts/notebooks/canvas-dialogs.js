import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../popup.js';
import { button, field, h } from './dom.js';
import { newOperationId } from './api.js';
import { changeCanvasDocument } from './canvas-format.js';

export async function canvasTextPrompt(message, initial = '', label = 'Create canvas') {
    const result = await callGenericPopup(h('div', { class: 'notes-dialog' }, h('p', { text: message })), POPUP_TYPE.INPUT, initial, { okButton: label });
    return typeof result === 'string' && result.trim() ? result.trim() : null;
}

/** The editor applies only known fields; opaque JSON fields remain on the original node. */
export async function editCanvasNode(document, node, isCurrent, onApply) {
    const inputs = new Map();
    const content = h('div', { class: 'notes-dialog notes-canvas-dialog' }, h('h3', { text: 'Edit card' }),
        h('p', { class: 'notes-hint', text: 'Changes stay in this canvas draft until you choose Save canvas. Note contents and AI access are not changed.' }));
    const error = h('p', { class: 'notes-notice', role: 'alert' });
    const add = (name, label, value, { multiline = false, optional = false, number = false } = {}) => {
        const input = h(multiline ? 'textarea' : 'input', { ...(multiline ? { rows: 5 } : { type: number ? 'number' : 'text' }),
            value: value ?? '', ...(number ? { step: 1, min: name === 'width' || name === 'height' ? 0 : -1000000, max: 1000000 } : {}),
            'data-canvas-field': name });
        inputs.set(name, { input, optional, number });
        content.append(field(label, input));
    };
    if (node.type === 'text') add('text', 'Card text (Markdown)', node.text, { multiline: true });
    else if (node.type === 'file') {
        add('file', 'Note or file path', node.file);
        add('subpath', 'Heading or block (starts with #)', node.subpath, { optional: true });
    } else if (node.type === 'link') add('url', 'Web address', node.url);
    else if (node.type === 'group') add('label', 'Group label', node.label, { optional: true });
    else content.append(h('p', { class: 'notes-hint', text: 'This card type is kept as data. You can change its position and size here.' }));
    for (const [name, label] of [['x', 'X position'], ['y', 'Y position'], ['width', 'Width'], ['height', 'Height']]) add(name, label, node[name], { number: true });
    add('color', 'Colour (1 to 6, or a six-digit hex colour)', node.color, { optional: true });
    content.append(error);
    return callGenericPopup(content, POPUP_TYPE.CONFIRM, '', { wide: true, okButton: 'Apply to draft', cancelButton: 'Not now',
        onClosing: popup => {
            if (popup.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            if (!isCurrent()) { error.textContent = 'This canvas is no longer open. Close this window before editing another canvas.'; return false; }
            try {
                const set = {};
                for (const [name, control] of inputs) {
                    const value = control.input.value;
                    if (control.number && (!value.trim() || !Number.isInteger(Number(value)))) throw new Error('Positions and sizes need whole numbers.');
                    Object.defineProperty(set, name, { enumerable: true, value: control.number ? Number(value) : control.optional && !value ? undefined : value });
                }
                onApply(changeCanvasDocument(document, [{ type: 'update-node', id: node.id, set }]));
                return true;
            } catch (failure) { error.textContent = failure.message; return false; }
        } });
}

export async function chooseCanvasNote(app, notebookId, isCurrent) {
    const content = h('div', { class: 'notes-dialog notes-canvas-dialog' }, h('h3', { text: 'Add note card' }),
        h('p', { class: 'notes-hint', text: 'The card refers to the saved note. It does not share the note with the assistant or publish it to lore.' }));
    const search = h('input', { type: 'search', placeholder: 'Title, path or words in the note' });
    const list = h('div', { class: 'notes-canvas-note-choices' });
    const error = h('p', { class: 'notes-notice', role: 'alert' });
    content.append(field('Find a note', search), list, error);
    let selected = null;
    let version = 0;
    let timer;
    let closed = false;
    const refresh = async () => {
        const ticket = ++version;
        const result = await app.request('/search', { notebookId, query: search.value, limit: 20 });
        if (closed || ticket !== version || !isCurrent()) return;
        list.replaceChildren();
        if (result?.status !== 'success') { error.textContent = 'Notes could not be loaded. Change the search to try again.'; return; }
        for (const note of result.results ?? []) list.append(button(`${note.title} (${note.path})`, () => {
            if (!isCurrent() || closed || ticket !== version) return;
            selected = note;
            for (const item of list.children) item.setAttribute('aria-pressed', 'false');
            list.querySelector(`[data-canvas-note="${note.id}"]`)?.setAttribute('aria-pressed', 'true');
        }, { className: 'notes-canvas-note-choice' }));
        [...list.children].forEach((item, index) => item.setAttribute('data-canvas-note', result.results[index].id));
        if (!(result.results?.length)) error.textContent = 'No matching notes. Try another title or path.';
        else error.textContent = '';
    };
    search.addEventListener('input', () => { selected = null; clearTimeout(timer); timer = setTimeout(() => void refresh(), 250); });
    void refresh();
    const result = await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', { wide: true, okButton: 'Add card', cancelButton: 'Not now',
        onClosing: popup => {
            if (popup.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            if (!isCurrent() || !selected) { error.textContent = 'Choose a saved note before adding the card.'; return false; }
            return true;
        } });
    closed = true;
    version++;
    clearTimeout(timer);
    return result === POPUP_RESULT.AFFIRMATIVE && isCurrent() ? selected : null;
}

export async function editCanvasEdge(document, edge, isCurrent, onApply) {
    const content = h('div', { class: 'notes-dialog notes-canvas-dialog' }, h('h3', { text: edge ? 'Edit connection' : 'Add connection' }));
    const selects = new Map();
    const addSelect = (name, label, options, current) => {
        const select = h('select', { value: current });
        for (const [value, text] of options) select.append(h('option', { value, text, selected: value === current }));
        selects.set(name, select);
        content.append(field(label, select));
    };
    const cards = (document.nodes ?? []).map((node, index) => [node.id, `Card ${index + 1} (${node.type})`]);
    addSelect('fromNode', 'From card', cards, edge?.fromNode ?? cards[0]?.[0]);
    addSelect('toNode', 'To card', cards, edge?.toNode ?? cards[1]?.[0] ?? cards[0]?.[0]);
    for (const name of ['fromSide', 'toSide']) addSelect(name, name === 'fromSide' ? 'From side' : 'To side',
        ['top', 'right', 'bottom', 'left'].map(value => [value, value]), edge?.[name] ?? (name === 'fromSide' ? 'right' : 'left'));
    for (const name of ['fromEnd', 'toEnd']) addSelect(name, name === 'fromEnd' ? 'From end' : 'To end', [['none', 'No arrow'], ['arrow', 'Arrow']], edge?.[name] ?? (name === 'fromEnd' ? 'none' : 'arrow'));
    const label = h('input', { type: 'text', value: edge?.label ?? '' });
    const color = h('input', { type: 'text', value: edge?.color ?? '' });
    const error = h('p', { class: 'notes-notice', role: 'alert' });
    content.append(field('Connection label', label), field('Connection colour (optional)', color), error);
    return callGenericPopup(content, POPUP_TYPE.CONFIRM, '', { wide: true, okButton: 'Apply to draft', cancelButton: 'Not now',
        onClosing: popup => {
            if (popup.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            if (!isCurrent()) { error.textContent = 'This canvas is no longer open.'; return false; }
            try {
                const set = Object.fromEntries([...selects].map(([name, input]) => [name, input.value]));
                set.label = label.value || undefined;
                set.color = color.value || undefined;
                const change = edge ? { type: 'update-edge', id: edge.id, set } : { type: 'add-edge', edge: {
                    ...Object.fromEntries(Object.entries(set).filter(([, value]) => value !== undefined)), id: newOperationId('edge') } };
                onApply(changeCanvasDocument(document, [change]));
                return true;
            } catch (failure) { error.textContent = failure.message; return false; }
        } });
}
