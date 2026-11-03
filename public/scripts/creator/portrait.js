import { getExtensionCapability } from '../neconyan-conversation/extension-capabilities.js';
import { element, button, textField } from './fields.js';
import { creatorPortraitPrompt } from './portrait-prompt.js';

export async function creatorPortraitBytes(blob, square = false) {
    if (!/^image\/(png|jpeg|webp)$/.test(blob.type) || blob.size > 20 * 1024 * 1024) throw new Error('Choose a PNG, JPEG or WebP smaller than 20 MiB.');
    const bitmap = await createImageBitmap(blob);
    try {
        const side = Math.min(bitmap.width, bitmap.height);
        const width = square ? side : bitmap.width;
        const height = square ? side : bitmap.height;
        const scale = Math.min(1, 1024 / Math.max(width, height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        canvas.getContext('2d').drawImage(bitmap, square ? (bitmap.width - side) / 2 : 0, square ? (bitmap.height - side) / 2 : 0, width, height, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/png');
        if (dataUrl.length > 2 * 1024 * 1024) throw new Error('This portrait is too large for draft recovery. Choose a smaller image.');
        return dataUrl;
    } finally { bitmap.close(); }
}

export function renderPortrait(workspace, main) {
    const draft = workspace.session.draft;
    main.append(element('h3', '', 'Choose their portrait'), element('p', 'creator-muted', 'Keep up to four candidates. The selected PNG is saved exactly once with your character; saving never generates another image. Portrait changes are separate from text Undo.'));
    const add = async (blob, label) => {
        const dataUrl = await creatorPortraitBytes(blob);
        workspace.session.assertOwner();
        if (workspace.session.draft.id !== draft.id) throw new Error('Return to the original draft to add this portrait.');
        if (workspace.session.draft.media.length >= 4) throw new Error('Remove a candidate before adding another portrait.');
        workspace.edit(next => {
            const id = crypto.randomUUID();
            next.media.push({ id, label, dataUrl });
            next.selectedMedia = id;
        }, true, { record: false });
    };
    const uploadWrap = element('label', 'menu_button creator-file-btn');
    uploadWrap.append(element('span', '', 'Upload portrait file'));
    const upload = element('input');
    upload.type = 'file'; upload.accept = 'image/png,image/jpeg,image/webp';
    upload.setAttribute('aria-label', 'Upload portrait');
    upload.addEventListener('change', () => { if (upload.files[0]) void workspace.run(() => add(upload.files[0], upload.files[0].name)); });
    uploadWrap.append(upload);
    main.append(textField('Portrait prompt', creatorPortraitPrompt(draft), value => workspace.edit(next => { next.portraitPrompt = value; }), { rows: 6, hint: 'Starts from the card’s description, personality, setting and Character’s Note. Quick Image Gen receives this prompt and name and may also apply saved image settings or reference pictures for a matching library character. Private draft notes and the Dossier stay out.' }));
    main.append(button('Refresh prompt from card', () => workspace.edit(next => { delete next.portraitPrompt; }, true), false, 'creator-chip-btn'));
    const cancel = button('Cancel image generation', () => controller?.abort());
    let controller;
    cancel.hidden = true;
    const actionBar = element('div', 'creator-actions');
    actionBar.append(button('Generate portrait candidate', () => workspace.run(async () => {
        if (controller) throw new Error('An image request is already running.');
        const source = workspace.session.draft;
        const prompt = creatorPortraitPrompt(source).trim();
        if (!prompt) throw new Error('Describe the portrait first.');
        if (source.media.length >= 4) throw new Error('Remove a candidate before generating another portrait.');
        const qig = getExtensionCapability('quick-image-gen');
        if (!qig?.generateImage) throw new Error('Enable Quick Image Gen and configure an image provider first.');
        controller = new AbortController(); cancel.hidden = false;
        try {
            const name = source.card.data.name;
            const image = await qig.generateImage(prompt, '', { character: { name, data: { name } }, characterName: name, signal: controller.signal });
            if (controller.signal.aborted) return;
            if (!image?.url) throw new Error('No image was returned. Your text draft is still saved.');
            const url = new URL(image.url, location.href);
            if (!['data:', 'blob:'].includes(url.protocol) && url.origin !== location.origin) throw new Error('The image provider must return a local image.');
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) throw new Error('The generated portrait could not be loaded.');
            await add(await response.blob(), 'Generated portrait');
        } finally { controller = null; cancel.hidden = true; }
    }), true), uploadWrap, cancel);
    main.append(actionBar);
    const gallery = element('div', 'creator-portraits');
    for (const media of draft.media) {
        const card = element('section', 'creator-portrait');
        const image = element('img'); image.src = media.dataUrl; image.alt = media.label || 'Portrait candidate';
        const select = button(draft.selectedMedia === media.id ? 'Selected portrait' : 'Use portrait', () => workspace.edit(next => { next.selectedMedia = media.id; }, true, { record: false }), draft.selectedMedia === media.id, 'creator-chip-btn');
        select.setAttribute('aria-pressed', String(draft.selectedMedia === media.id));
        const controls = element('div', 'creator-actions');
        controls.append(select, button('Crop square', () => workspace.run(async () => {
            const blob = await (await fetch(media.dataUrl)).blob();
            const dataUrl = await creatorPortraitBytes(blob, true);
            workspace.session.assertOwner();
            if (workspace.session.draft.id !== draft.id || !workspace.session.draft.media.some(item => item.id === media.id)) throw new Error('This portrait changed. Reopen it before cropping.');
            workspace.edit(next => { next.media.find(item => item.id === media.id).dataUrl = dataUrl; }, true, { record: false });
        }), false, 'creator-chip-btn'), button('Remove candidate', () => workspace.edit(next => {
            next.media = next.media.filter(item => item.id !== media.id);
            if (next.selectedMedia === media.id) next.selectedMedia = null;
        }, true, { record: false }), false, 'creator-chip-btn creator-danger-outline'));
        card.append(image, controls);
        gallery.append(card);
    }
    main.append(gallery);
}
