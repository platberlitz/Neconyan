import { characters, getThumbnailUrl } from '../../script.js';
import { t } from '../i18n.js';
import { h } from '../notebooks/dom.js';
import { callGenericPopup, POPUP_TYPE } from '../popup.js';
import { getCurrentUserHandle } from '../user.js';
import * as api from './api.js';

const button = (text, onclick, options = {}) => h('button', { type: 'button', class: 'menu_button scratchpad-library-button', text, onclick, ...options });
const field = (label, input) => h('label', { class: 'scratchpad-field' }, h('span', { text: label }), input);

async function portraitFile(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 16 * 1024 * 1024) throw new Error(t`Choose a PNG, JPEG or WebP picture under 16 MB.`);
    const image = await createImageBitmap(file);
    try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 256;
        const side = Math.min(image.width, image.height);
        canvas.getContext('2d').drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 256, 256);
        return canvas.toDataURL('image/jpeg', 0.85);
    } finally { image.close(); }
}

/** One account-owned library, with the current session's portable copies as a fallback. */
export async function openAssistantLibrary({ assistants, portrait, selected, canChoose, choose, onSave }) {
    const owner = getCurrentUserHandle();
    const checkAccount = () => {
        if (getCurrentUserHandle() !== owner) throw new Error(t`The account changed. Reopen the editor.`);
    };
    let { library } = await api.readAssistants();
    checkAccount();
    onSave(library);
    let busy = false;
    const content = h('div', { class: 'scratchpad-review scratchpad-library' });
    const errorText = h('p', { role: 'alert', hidden: true });
    const run = async operation => {
        if (busy) return;
        busy = true;
        errorText.hidden = true;
        content.setAttribute('aria-busy', 'true');
        content.inert = true;
        try {
            checkAccount();
            await operation();
            checkAccount();
        } catch (error) {
            errorText.textContent = error.message || t`The assistant could not be saved.`;
            errorText.hidden = false;
        } finally {
            busy = false;
            content.inert = false;
            content.removeAttribute('aria-busy');
        }
    };
    const save = async (profile, card) => {
        const result = await api.saveAssistant(profile, library.revision, card);
        checkAccount();
        library = result.library;
        onSave(library);
        return result.assistant;
    };
    const heading = text => h('h3', { text });
    const show = (...children) => { errorText.hidden = true; content.replaceChildren(...children, errorText); };

    function editor(profile = {}) {
        let avatar = profile.avatar || '';
        const name = h('input', { class: 'text_pole', value: profile.name || '', maxlength: '80', 'aria-label': t`Assistant name` });
        const personality = h('textarea', { class: 'text_pole scratchpad-review-editor', rows: '7', value: profile.personality || '', 'aria-label': t`Personality`, placeholder: t`How do they speak, think and respond?` });
        const examples = h('textarea', { class: 'text_pole', rows: '4', value: profile.examples || '', 'aria-label': t`Example dialogue` });
        const picture = h('img', { class: 'scratchpad-library-portrait', src: avatar || portrait('custom'), alt: '', width: 80, height: 80 });
        const upload = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', 'aria-label': t`Assistant picture`, hidden: true });
        upload.addEventListener('change', () => void run(async () => {
            if (!upload.files?.[0]) return;
            avatar = await portraitFile(upload.files[0]);
            picture.src = avatar;
        }));
        const owned = library.assistants.some(item => item.id === profile.id);
        show(heading(profile.id ? t`Edit assistant` : t`Add a new assistant`),
            h('p', { class: 'scratchpad-review-hint', text: t`Saved for your account and available in every Scratchpad. Personality changes apply to future replies. Session prompt overrides still take priority.` }),
            h('div', { class: 'scratchpad-library-picture' }, picture, upload,
                h('div', {}, button(t`Choose picture`, () => { upload.value = ''; upload.click(); }), button(t`Remove picture`, () => { avatar = ''; picture.src = portrait('custom'); }))),
            field(t`Assistant name`, name), field(t`Personality`, personality),
            h('details', {}, h('summary', { text: t`Example dialogue (optional)` }), field(t`Example dialogue`, examples)),
            h('div', { class: 'scratchpad-library-actions' },
                button(t`Back to assistants`, () => { if (!busy) list(); }),
                button(t`Save assistant`, () => void run(async () => {
                    if (!name.value.trim() || !personality.value.trim()) throw new Error(t`Add a name and personality first.`);
                    const saved = await save({ ...profile, id: owned ? profile.id : undefined, name: name.value, personality: personality.value, examples: examples.value, avatar });
                    if (!selected().includes(saved.id) && canChoose(saved.id)) await choose(saved.id);
                    list();
                }), { class: 'menu_button menu_button_primary scratchpad-library-button' })));
        name.focus();
    }

    function cards() {
        const results = h('div', { class: 'scratchpad-library-list' });
        const search = h('input', { class: 'text_pole', type: 'search', placeholder: t`Search character cards`, 'aria-label': t`Search character cards` });
        const render = () => {
            const matches = characters.filter(card => card.avatar && card.name?.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
            results.replaceChildren(...matches.map(card => h('div', { class: 'scratchpad-library-row' },
                h('img', { src: getThumbnailUrl('avatar', card.avatar), alt: '', width: 48, height: 48, loading: 'lazy' }),
                h('strong', { text: card.name, 'data-i18n-ignore': '' }),
                button(t`Add`, () => void run(async () => {
                    const saved = await save(undefined, card.avatar);
                    if (canChoose(saved.id)) await choose(saved.id);
                    list();
                }), { 'aria-label': t`Add ${card.name} as an assistant` }))));
            if (!matches.length) results.append(h('p', { text: t`No character cards match. Import a card in Characters, or add a new assistant.` }));
        };
        search.addEventListener('input', render);
        show(heading(t`Use a character card`), h('p', { class: 'scratchpad-review-hint', text: t`Copy a card's picture, description, personality and example dialogue. You can edit the assistant afterwards. The original card stays as it is.` }),
            button(t`Back to assistants`, list), search, results);
        render();
        search.focus();
    }

    function list() {
        const results = h('div', { class: 'scratchpad-library-list' });
        const search = h('input', { class: 'text_pole', type: 'search', placeholder: t`Search assistants`, 'aria-label': t`Search assistants` });
        const render = () => {
            const matches = assistants().filter(item => item.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
            results.replaceChildren(...matches.map(item => h('div', { class: 'scratchpad-library-row' },
                h('img', { src: portrait(item.id), alt: '', width: 48, height: 48 }),
                h('div', { class: 'scratchpad-library-description' }, h('strong', { text: item.name, 'data-i18n-ignore': '' }),
                    h('small', { text: item.sourceCard ? t`From a character card` : item.personality ? t`Your assistant` : t`Included assistant` })),
                h('div', { class: 'scratchpad-library-actions' },
                    button(selected().includes(item.id) ? t`Selected` : t`Use`, () => void run(async () => { await choose(item.id); render(); }),
                        { 'aria-label': t`Use ${item.name}`, 'aria-pressed': String(selected().includes(item.id)), disabled: !canChoose(item.id) }),
                    item.personality ? button(t`Edit`, () => editor(item), { 'aria-label': t`Edit ${item.name}` }) : null))));
            if (!matches.length) results.append(h('p', { text: t`No assistants match that search.` }));
        };
        search.addEventListener('input', render);
        show(heading(t`Your assistants`), h('p', { class: 'scratchpad-review-hint', text: t`Choose who you talk to. A round table can include up to three assistants.` }),
            h('div', { class: 'scratchpad-library-actions' },
                button(t`Add a new assistant`, () => editor(), { class: 'menu_button menu_button_primary scratchpad-library-button' }),
                button(t`Use a character card`, cards)), search, results);
        render();
    }

    list();
    await callGenericPopup(content, POPUP_TYPE.TEXT, '', { wide: true, okButton: t`Done`, onClosing: () => !busy });
}
