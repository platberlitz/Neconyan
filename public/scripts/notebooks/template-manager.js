import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../popup.js';
import { button, clear, field, h } from './dom.js';
import { NOTE_TEMPLATES, normaliseTemplates, TEMPLATE_LIMITS } from './templates.js';
import { saveTemplates, savedTemplates } from './template-settings.js';

export async function manageTemplates(app) {
    const account = app.state.account;
    let items;
    try { items = savedTemplates().filter(item => item.id !== 'blank'); } catch (error) { app.toast('error', error.message); return false; }
    let selected = items[0]?.id ?? 'blank';
    const select = h('select', { class: 'notes-input notes-template-select', 'aria-label': 'Saved template' });
    const label = h('input', { class: 'text_pole notes-input', maxlength: '80', 'aria-label': 'Template name' });
    const title = h('input', { class: 'text_pole notes-input', maxlength: '160', 'aria-label': 'Suggested note name' });
    const text = h('textarea', { class: 'text_pole notes-input notes-template-text', rows: '12', 'aria-label': 'Template contents' });
    const error = h('p', { class: 'notes-notice', role: 'alert', hidden: true });
    function capture() {
        const item = items.find(item => item.id === selected);
        if (item) Object.assign(item, { label: label.value, title: title.value, text: text.value });
    }
    function render() {
        clear(select);
        for (const item of [NOTE_TEMPLATES[0], ...items]) select.append(h('option', { value: item.id, text: item.label || '(unnamed template)', 'data-i18n-ignore': '' }));
        select.value = selected;
        const item = items.find(item => item.id === selected) ?? NOTE_TEMPLATES[0];
        label.value = item.label;
        title.value = item.title;
        text.value = item.text;
        for (const control of [label, title, text, remove]) control.disabled = selected === 'blank';
        add.disabled = items.length >= TEMPLATE_LIMITS.count;
    }
    select.addEventListener('change', () => { capture(); selected = select.value; render(); });
    const add = button('Add template', () => {
        capture();
        if (items.length >= TEMPLATE_LIMITS.count) return;
        const item = { id: `custom_${crypto.randomUUID().replace(/-/g, '')}`, label: 'New template', title: '', text: '' };
        items.push(item); selected = item.id; render(); label.focus(); label.select();
    }, { icon: 'fa-plus' });
    const remove = button('Remove template', () => {
        items = items.filter(item => item.id !== selected);
        selected = items[0]?.id ?? 'blank'; render();
    }, { icon: 'fa-trash-can', className: 'notes-danger' });
    const restore = button('Restore default templates', async () => {
        const answer = await callGenericPopup(h('p', { text: 'Replace this template list with the supplied defaults? Notes already created from templates are kept.' }), POPUP_TYPE.CONFIRM, '', { okButton: 'Restore defaults', cancelButton: 'Keep my templates' });
        if (answer !== POPUP_RESULT.AFFIRMATIVE || app.state.account !== account) return;
        items = NOTE_TEMPLATES.filter(item => item.id !== 'blank').map(item => ({ ...item }));
        selected = items[0].id; render();
    });
    render();
    const result = await callGenericPopup(h('div', { class: 'notes-dialog notes-template-manager' },
        h('h3', { text: 'Templates' }), h('p', { text: 'Edit the starting text for new notes. Existing notes are never changed. Blank note stays available. Templates are saved for this account.' }),
        field('Saved template', select), h('div', { class: 'notes-nav-actions' }, add, remove, restore),
        h('div', { class: 'notes-template-fields' }, field('Template name', label), field('Suggested note name', title)),
        field('Contents (Markdown)', text), error), POPUP_TYPE.CONFIRM, '', {
        wide: true, large: true, okButton: 'Save templates', cancelButton: 'Cancel',
        onClosing: popup => {
            if (popup.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            try {
                capture();
                normaliseTemplates(items);
                saveTemplates(items, account);
                return true;
            } catch (failure) { error.hidden = false; error.textContent = failure.message; return false; }
        },
    });
    if (result === POPUP_RESULT.AFFIRMATIVE) { app.toast('success', 'Templates saved.'); return true; }
    return false;
}
