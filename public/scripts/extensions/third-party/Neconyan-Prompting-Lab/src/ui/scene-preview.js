import { element, replace } from '../dom.js';
import { avatarThumbnail } from './character-picker.js';

/**
 * What a comparison is about to send, read as a conversation: who opens it,
 * what they say, and what you say back.
 *
 * Everything shown here is text the user or the card wrote, so it is rendered
 * with textContent and never as markup.
 */

/**
 * @param {HTMLElement} host
 * @param {{characterAvatar?: string, characterName?: string, personaKey?: string,
 *   personaName?: string, lines?: Array<{from: 'character'|'persona', text: string, note?: string}>}} scene
 */
export function renderScenePreview(host, {
    characterAvatar = '',
    characterName = '',
    personaKey = '',
    personaName = '',
    lines = [],
} = {}) {
    replace(host);
    const usable = lines.filter(line => String(line?.text ?? '').trim());
    if (!usable.length) {
        return;
    }

    host.append(element('p', { className: 'sbpl-field-label', text: 'How the scene starts' }));
    const list = element('div', { className: 'sbpl-preview-lines' });
    for (const line of usable) {
        const fromCharacter = line.from === 'character';
        const row = element('div', { className: 'sbpl-preview-line' });
        row.append(avatarThumbnail(
            fromCharacter ? characterAvatar : personaKey,
            fromCharacter ? characterName : personaName,
            'sbpl-preview-avatar',
            fromCharacter ? 'avatar' : 'persona',
        ));
        const copy = element('div', { className: 'sbpl-preview-copy' });
        const who = element('p', { className: 'sbpl-preview-who' });
        who.append(element('span', {
            text: (fromCharacter ? characterName : personaName) || (fromCharacter ? 'The character' : 'You'),
        }));
        if (line.note) {
            who.append(element('span', { className: 'sbpl-preview-note', text: line.note }));
        }
        copy.append(who, element('p', { className: 'sbpl-preview-text', text: line.text }));
        row.append(copy);
        list.append(row);
    }
    host.append(list);
}

/** The persona Neconyan is on, which is who a scene speaks as by default. */
export function currentPersona(context) {
    const key = String(context?.userAvatar ?? '');
    return { key, name: String(context?.name1 ?? '') || key };
}
