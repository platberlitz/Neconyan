import { getOneCharacter, getRequestHeaders, printCharactersDebounced } from '../script.js';
import { getExtensionCapability } from './neconyan-conversation/extension-capabilities.js';
import { normaliseCharacterDraft } from './neconyan-character-draft.js';

/** Save an already reviewed draft through the existing character creation route. */
export async function saveCharacterDraft(input, guard, enqueue = task => task()) {
    const { character: fields, characterNote, alternateGreetings, avatarPrompt } = normaliseCharacterDraft(input);
    const name = fields.name;
    guard.assert();
    let image = null;
    if (avatarPrompt) {
        const qig = getExtensionCapability('quick-image-gen');
        if (!qig?.generateImage) throw new Error('Enable Quick Image Gen and configure an image provider first.');
        const entry = await qig.generateImage(avatarPrompt, '', { character: { ...fields, data: fields }, characterName: name, signal: guard.signal });
        guard.assert();
        if (!entry?.url) throw new Error('Quick Image Gen returned no avatar.');
        const url = new URL(entry.url, location.href);
        if (!['data:', 'blob:'].includes(url.protocol) && url.origin !== location.origin) throw new Error('Quick Image Gen must return a local image.');
        const response = await fetch(url.href, { signal: guard.signal });
        if (!response.ok) throw new Error('The generated avatar could not be loaded.');
        image = await response.blob();
        if (!/^image\/(png|jpeg|webp)$/.test(image.type) || image.size > 20 * 1024 * 1024) throw new Error('The generated avatar must be a PNG, JPEG or WebP under 20 MiB.');
    }
    return enqueue(async () => {
        guard.assert();
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.set(key === 'name' ? 'ch_name' : key, value);
        if (characterNote) {
            form.set('depth_prompt_prompt', characterNote);
            form.set('depth_prompt_depth', '4');
            form.set('depth_prompt_role', 'system');
        }
        for (const greeting of alternateGreetings) form.append('alternate_greetings', greeting);
        if (image) form.set('avatar', image, 'avatar.' + image.type.split('/')[1]);
        const headers = new Headers(getRequestHeaders());
        headers.delete('Content-Type');
        // The server allocates a fresh filename, even when another card has the same name.
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        const avatar = await response.text();
        if (!response.ok) throw new Error('Character creation failed: ' + response.status);
        let refreshFailed = !guard.isCurrent();
        if (!refreshFailed) {
            try {
                refreshFailed = await getOneCharacter(avatar, { isCurrent: guard.isCurrent, allowInsert: true }) === false;
                printCharactersDebounced();
            } catch { refreshFailed = true; }
        }
        return { status: 'success', committed: true, avatar, name, generatedAvatar: Boolean(image), refreshFailed };
    });
}
