import { Popup, POPUP_TYPE } from '../../../../popup.js';
import { QUICK_REPLY_TEMPLATES } from '../quick-reply-templates.js';

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
            const result = await onAdd(template);
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
