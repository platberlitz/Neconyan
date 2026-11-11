import { t } from '../i18n.js';
import { h } from '../notebooks/dom.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../popup.js';
import { getCurrentUserHandle } from '../user.js';
import * as api from './api.js';

export const MAX_QUICK_PROMPTS = 24;
export const MAX_QUICK_PROMPT_LABEL = 40;

/** Rows left completely blank are dropped; a half-filled row is an error the user must fix. */
export function collectQuickPrompts(rows) {
    const prompts = [];
    for (const row of rows) {
        const label = row.label.replace(/\s+/g, ' ').trim();
        if (!label && !row.text.trim()) continue;
        if (!label || !row.text.trim()) throw new Error(t`Each quick prompt needs a name and the text it fills in.`);
        prompts.push({ label, text: row.text });
    }
    return prompts;
}

function rowButton(title, icon, onClick, disabled = false) {
    return h('button', { type: 'button', class: 'menu_button scratchpad-button scratchpad-quick-row-button', title, 'aria-label': title, disabled, onclick: onClick },
        h('i', { class: `fa-solid ${icon}`, 'aria-hidden': 'true' }));
}

let editorOpen = false;

/** Opens the editor for the account's own quick prompts. Resolves with the saved list, or null when nothing was saved. */
export async function editQuickPrompts() {
    if (editorOpen) return null;
    editorOpen = true;
    const owner = getCurrentUserHandle();
    const checkAccount = () => {
        if (getCurrentUserHandle() !== owner) throw new Error(t`The account changed. Reopen the editor.`);
    };
    try {
        const { quickPrompts } = await api.readQuickPrompts();
        checkAccount();
        const rows = quickPrompts.prompts.map(prompt => ({ ...prompt }));
        const list = h('div', { class: 'scratchpad-quick-rows' });
        const errorText = h('p', { role: 'alert', hidden: true });
        const empty = h('p', { class: 'scratchpad-review-hint', text: t`You have no quick prompts of your own yet.` });
        let serial = 0;
        const add = h('button', { type: 'button', class: 'menu_button scratchpad-button scratchpad-quick-add', onclick: () => {
            rows.push({ label: '', text: '' });
            draw();
            list.lastElementChild?.querySelector('input')?.focus();
        } }, h('i', { class: 'fa-solid fa-plus', 'aria-hidden': 'true' }), h('span', { text: t`Add a prompt` }));
        const move = (index, step) => {
            const [row] = rows.splice(index, 1);
            rows.splice(index + step, 0, row);
            draw();
            // Keep the keyboard on the row that moved; at either end, its remaining arrow takes the focus.
            const [up, down] = list.children[index + step].querySelectorAll('.scratchpad-quick-row-button');
            const [first, second] = step < 0 ? [up, down] : [down, up];
            (first.disabled ? second : first).focus();
        };
        function draw() {
            list.replaceChildren(...rows.map((row, index) => {
                const id = `scratchpad-quick-prompt-${serial += 1}`;
                const number = index + 1;
                return h('div', { class: 'scratchpad-quick-row', role: 'group', 'aria-label': t`Quick prompt ${number}` },
                    h('div', { class: 'scratchpad-field' },
                        h('label', { for: `${id}-label`, text: t`Name on the button` }),
                        h('input', { id: `${id}-label`, type: 'text', class: 'text_pole', maxlength: String(MAX_QUICK_PROMPT_LABEL), value: row.label, 'data-i18n-ignore': '',
                            oninput: event => { row.label = event.currentTarget.value; } })),
                    h('div', { class: 'scratchpad-field' },
                        h('label', { for: `${id}-text`, text: t`Text it fills in` }),
                        h('textarea', { id: `${id}-text`, class: 'text_pole', rows: '3', value: row.text, 'data-i18n-ignore': '',
                            oninput: event => { row.text = event.currentTarget.value; } })),
                    h('div', { class: 'scratchpad-quick-row-actions' },
                        rowButton(t`Move up`, 'fa-arrow-up', () => move(index, -1), index === 0),
                        rowButton(t`Move down`, 'fa-arrow-down', () => move(index, 1), index === rows.length - 1),
                        rowButton(t`Delete prompt`, 'fa-trash-can', () => {
                            rows.splice(index, 1);
                            draw();
                            (list.children[Math.min(index, rows.length - 1)]?.querySelector('input') ?? add).focus();
                        })));
            }));
            empty.hidden = rows.length > 0;
            add.disabled = rows.length >= MAX_QUICK_PROMPTS;
        }
        draw();
        const content = h('div', { class: 'scratchpad-review scratchpad-section scratchpad-quick-editor' },
            h('h3', { text: t`Your quick prompts` }),
            h('p', { class: 'scratchpad-review-hint', text: t`Saved for your account and shown in every Scratchpad, before the built-in prompts. Pressing one fills the message box; nothing is sent until you press Send.` }),
            empty, list, add, errorText);
        let saving = false;
        let saved = null;
        await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', {
            wide: true, okButton: t`Save quick prompts`, cancelButton: t`Cancel`,
            onClosing: async popup => {
                if (saving) return false;
                if (popup.result !== POPUP_RESULT.AFFIRMATIVE) return true;
                saving = true;
                errorText.hidden = true;
                try {
                    checkAccount();
                    saved = (await api.updateQuickPrompts(collectQuickPrompts(rows), quickPrompts.revision)).quickPrompts;
                    return true;
                } catch (error) {
                    errorText.textContent = error.message || t`Your quick prompts could not be saved.`;
                    errorText.hidden = false;
                    return false;
                } finally {
                    saving = false;
                }
            },
        });
        return saved;
    } finally {
        editorOpen = false;
    }
}
