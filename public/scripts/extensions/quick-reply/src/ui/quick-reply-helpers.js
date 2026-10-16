import { Popup, POPUP_RESULT, POPUP_TYPE } from '../../../../popup.js';
import {
    DEFAULT_CUSTOM_SET_NAME,
    QUICK_REPLY_MODES,
    QUICK_REPLY_TEMPLATES,
} from '../quick-reply-templates.js';

/** Words the user can drop into the text; they are filled in when the button is pressed. */
export const QUICK_REPLY_INSERT_CHIPS = [
    { macro: '{{input}}', label: 'What I typed' },
    { macro: '{{char}}', label: 'Character name' },
    { macro: '{{user}}', label: 'My name' },
];

/**
 * @param {string} tag
 * @param {{ className?: string, text?: string, attrs?: Record<string, string> }} [options]
 * @returns {HTMLElement}
 */
function el(tag, { className = '', text = '', attrs = {} } = {}) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    for (const [name, value] of Object.entries(attrs)) {
        node.setAttribute(name, value);
    }
    return node;
}

/**
 * Inserts text at the cursor of a text field and keeps typing position after it.
 * @param {HTMLTextAreaElement|HTMLInputElement} field
 * @param {string} text
 */
function insertAtCursor(field, text) {
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? field.value.length;
    field.value = `${field.value.slice(0, start)}${text}${field.value.slice(end)}`;
    const caret = start + text.length;
    field.focus();
    field.setSelectionRange(caret, caret);
    field.dispatchEvent(new Event('input', { bubbles: true }));
}

let builderCount = 0;

/**
 * Builds the form used to make a single quick reply.
 * @param {object} options
 * @param {string[]} options.setNames Existing set names, in display order.
 * @param {string} [options.defaultSetName] Set picked when the form opens.
 * @param {string} [options.newSetName] Set offered as a new one when it does not exist yet.
 * @returns {{ root: HTMLElement, read: () => { label: string, mode: string, text: string, setName: string } }}
 */
export function createQuickReplyBuilderDom({ setNames = [], defaultSetName = DEFAULT_CUSTOM_SET_NAME, newSetName = DEFAULT_CUSTOM_SET_NAME } = {}) {
    const uid = `qr--builder-${++builderCount}`;
    const root = el('div', { className: 'qr--builder' });

    root.append(el('h3', { className: 'qr--builder-title', text: 'Make a quick reply' }));
    root.append(el('p', { className: 'qr--builder-intro', text: 'A quick reply is a button above the message box. Give it a label, choose what it does, then tap it whenever you need it.' }));

    const labelField = el('div', { className: 'qr--builder-field' });
    labelField.append(el('label', { text: 'Button label', attrs: { for: `${uid}-label` } }));
    const labelInput = /** @type {HTMLInputElement} */ (el('input', {
        className: 'text_pole qr--builder-label',
        attrs: { id: `${uid}-label`, type: 'text', maxlength: '60', placeholder: 'For example: Continue', autocomplete: 'off' },
    }));
    labelField.append(labelInput);
    root.append(labelField);

    const modeFieldset = el('fieldset', { className: 'qr--builder-modes' });
    modeFieldset.append(el('legend', { text: 'What should it do?' }));
    for (const [index, mode] of QUICK_REPLY_MODES.entries()) {
        const option = el('label', { className: 'qr--builder-mode' });
        const radio = /** @type {HTMLInputElement} */ (el('input', {
            attrs: { type: 'radio', name: `${uid}-mode`, value: mode.id },
        }));
        radio.checked = index === 0;
        const copy = el('span', { className: 'qr--builder-modeCopy' });
        copy.append(el('span', { className: 'qr--builder-modeLabel', text: mode.label }));
        copy.append(el('small', { className: 'qr--builder-modeHint', text: mode.hint }));
        option.append(radio, copy);
        modeFieldset.append(option);
    }
    root.append(modeFieldset);

    const textField = el('div', { className: 'qr--builder-field' });
    const textLabel = el('label', { text: 'Text', attrs: { for: `${uid}-text` } });
    const textInput = /** @type {HTMLTextAreaElement} */ (el('textarea', {
        className: 'text_pole qr--builder-text',
        attrs: { id: `${uid}-text`, rows: '3' },
    }));
    const chips = el('div', { className: 'qr--builder-chips', attrs: { role: 'group', 'aria-label': 'Insert a word that is filled in later' } });
    chips.append(el('span', { className: 'qr--builder-chipsLabel', text: 'Insert:' }));
    for (const chip of QUICK_REPLY_INSERT_CHIPS) {
        const button = el('button', {
            className: 'menu_button qr--builder-chip',
            text: chip.label,
            attrs: { type: 'button', title: `Insert ${chip.macro}`, 'data-macro': chip.macro },
        });
        button.addEventListener('click', () => insertAtCursor(textInput, chip.macro));
        chips.append(button);
    }
    textField.append(textLabel, textInput, chips);
    root.append(textField);

    const setField = el('div', { className: 'qr--builder-field' });
    setField.append(el('label', { text: 'Add it to', attrs: { for: `${uid}-set` } }));
    const setSelect = /** @type {HTMLSelectElement} */ (el('select', { className: 'text_pole qr--builder-set', attrs: { id: `${uid}-set` } }));
    const names = [...setNames];
    const hasNewSet = names.some(name => name.toLowerCase() === newSetName.toLowerCase());
    if (!hasNewSet) {
        const option = /** @type {HTMLOptionElement} */ (el('option', { text: `${newSetName} (new set)` }));
        option.value = newSetName;
        setSelect.append(option);
    }
    for (const name of names) {
        const option = /** @type {HTMLOptionElement} */ (el('option', { text: name, attrs: { translate: 'no' } }));
        option.value = name;
        setSelect.append(option);
    }
    const wanted = [...setSelect.options].find(option => option.value.toLowerCase() === String(defaultSetName ?? '').toLowerCase());
    setSelect.value = wanted ? wanted.value : newSetName;
    setField.append(setSelect);
    root.append(setField);

    const preview = el('div', { className: 'qr--builder-preview', attrs: { 'aria-hidden': 'true' } });
    preview.append(el('span', { className: 'qr--builder-previewLabel', text: 'Preview' }));
    const previewButton = el('span', { className: 'qr--builder-previewButton' });
    preview.append(previewButton);
    root.append(preview);

    const getMode = () => /** @type {HTMLInputElement|null} */ (modeFieldset.querySelector('input:checked'))?.value ?? 'send';
    const sync = () => {
        const mode = QUICK_REPLY_MODES.find(item => item.id === getMode()) ?? QUICK_REPLY_MODES[0];
        textLabel.textContent = mode.id === 'command' ? 'Command' : mode.id === 'direct' ? 'Note for the AI' : mode.id === 'ask' ? 'Question' : 'Text';
        textInput.placeholder = mode.placeholder;
        chips.hidden = mode.id === 'command';
        for (const option of modeFieldset.querySelectorAll('.qr--builder-mode')) {
            option.classList.toggle('qr--isSelected', /** @type {HTMLInputElement} */ (option.querySelector('input')).checked);
        }
        previewButton.textContent = labelInput.value.trim() || 'Your button';
        previewButton.classList.toggle('qr--isPlaceholder', !labelInput.value.trim());
    };
    modeFieldset.addEventListener('change', sync);
    labelInput.addEventListener('input', sync);
    sync();

    return {
        root,
        read: () => ({
            label: labelInput.value.trim(),
            mode: getMode(),
            text: textInput.value.trim(),
            setName: setSelect.value,
        }),
    };
}

/**
 * Opens the builder and hands the finished reply to onSubmit.
 * The pop-up stays open while onSubmit returns false, so the user can fix the problem.
 * @param {object} options
 * @param {string[]} options.setNames
 * @param {string} [options.defaultSetName]
 * @param {string} [options.newSetName]
 * @param {(data: { label: string, mode: string, text: string, setName: string }) => Promise<boolean|void>|boolean|void} options.onSubmit
 * @returns {Promise<boolean>} Whether a reply was added.
 */
export async function showQuickReplyBuilder({ setNames, defaultSetName, newSetName, onSubmit }) {
    const builder = createQuickReplyBuilderDom({ setNames, defaultSetName, newSetName });
    let added = false;
    const popup = new Popup(builder.root, POPUP_TYPE.CONFIRM, null, {
        okButton: 'Add button',
        cancelButton: 'Cancel',
        allowVerticalScrolling: true,
        leftAlign: true,
        onClosing: async (current) => {
            if (current.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            const data = builder.read();
            if (!data.label) {
                toastr.warning('Give the button a label first.');
                /** @type {HTMLInputElement|null} */ (builder.root.querySelector('.qr--builder-label'))?.focus();
                return false;
            }
            if (!data.text) {
                toastr.warning('Add the text the button should use.');
                /** @type {HTMLTextAreaElement|null} */ (builder.root.querySelector('.qr--builder-text'))?.focus();
                return false;
            }
            added = (await onSubmit(data)) !== false;
            return added;
        },
    });
    await popup.show();
    return added;
}

/**
 * Builds the list of ready-made sets.
 * @param {object} options
 * @param {(template: import('../quick-reply-templates.js').QuickReplyTemplate) => Promise<boolean|void>|boolean|void} options.onAdd
 * @returns {HTMLElement}
 */
export function createQuickReplyTemplatePickerDom({ onAdd }) {
    const root = el('div', { className: 'qr--templates' });
    root.append(el('h3', { className: 'qr--templates-title', text: 'Ready-made buttons' }));
    root.append(el('p', { className: 'qr--templates-intro', text: 'Each set adds a row of buttons above the message box in every chat. You can rename, change or remove them later.' }));

    const list = el('div', { className: 'qr--templates-list' });
    for (const template of QUICK_REPLY_TEMPLATES) {
        const card = el('section', { className: 'qr--template', attrs: { 'data-template': template.id } });

        const head = el('div', { className: 'qr--template-head' });
        head.append(el('i', { className: `fa-solid ${template.icon} qr--template-icon`, attrs: { 'aria-hidden': 'true' } }));
        const copy = el('div', { className: 'qr--template-copy' });
        copy.append(el('h4', { className: 'qr--template-name', text: template.name }));
        copy.append(el('p', { className: 'qr--template-description', text: template.description }));
        head.append(copy);

        const addButton = el('button', {
            className: 'menu_button menu_button_primary qr--template-add',
            attrs: { type: 'button', 'aria-label': `Add the ${template.name} set` },
        });
        addButton.append(el('i', { className: 'fa-solid fa-plus', attrs: { 'aria-hidden': 'true' } }), el('span', { text: 'Add set' }));
        addButton.addEventListener('click', async () => {
            if (addButton.hasAttribute('disabled')) return;
            addButton.setAttribute('disabled', '');
            let result;
            try {
                result = await onAdd(template);
            } catch (error) {
                console.error('[Quick Reply] Could not add a ready-made set', error);
                toastr.error(`Could not add '${template.name}'. Try again.`);
                result = false;
            }
            if (result === false) {
                addButton.removeAttribute('disabled');
                return;
            }
            addButton.replaceChildren(el('i', { className: 'fa-solid fa-check', attrs: { 'aria-hidden': 'true' } }), el('span', { text: 'Added' }));
            card.classList.add('qr--isAdded');
        });
        head.append(addButton);
        card.append(head);

        const replies = el('ul', { className: 'qr--template-replies', attrs: { 'aria-label': `Buttons in ${template.name}` } });
        for (const reply of template.replies) {
            const item = el('li', { className: 'qr--template-reply', attrs: { title: reply.title } });
            item.append(el('i', { className: `fa-solid ${reply.icon}`, attrs: { 'aria-hidden': 'true' } }), el('span', { text: reply.label }));
            item.append(el('span', { className: 'qr--template-replyHint', text: reply.title }));
            replies.append(item);
        }
        card.append(replies);
        list.append(card);
    }
    root.append(list);
    return root;
}

/**
 * Opens the list of ready-made sets.
 * @param {object} options
 * @param {(template: import('../quick-reply-templates.js').QuickReplyTemplate) => Promise<boolean|void>|boolean|void} options.onAdd
 * @returns {Promise<void>}
 */
export async function showQuickReplyTemplatePicker({ onAdd }) {
    const popup = new Popup(createQuickReplyTemplatePickerDom({ onAdd }), POPUP_TYPE.TEXT, null, {
        okButton: 'Done',
        wide: true,
        allowVerticalScrolling: true,
        leftAlign: true,
    });
    await popup.show();
}
