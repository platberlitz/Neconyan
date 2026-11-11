import { saveSettings, setUserName } from '../../script.js';
import { getUserAvatar, getUserAvatars, setPersonaDescription, user_avatar } from '../personas.js';
import { h } from '../notebooks/dom.js';
import { normalizeScenarioAvatar } from '../persona-appendix-avatar.js';
import { power_user } from '../power-user.js';
import { event_types, eventSource } from '../events.js';
import { getCurrentUserHandle } from '../user.js';
import { sourcePersona, isCurrentSource } from './context.js';
import { PERSONA_FIELDS, personaFieldValue } from './persona-fields.js';

export function requireSharedPersona(source, shared, name) {
    const current = sourcePersona(source);
    if (!isCurrentSource(source) || !shared || current?.avatar !== shared.avatar || current.name !== shared.name
        || name.trim().toLowerCase() !== shared.name.toLowerCase()) {
        throw new Error('Keep the original persona selected and shared. Ask again if it has been renamed.');
    }
}

const SAVE_ATTEMPTS = 4;

/** Only a Roleplay chat reads its persona from the saved settings; General and Conversation send it with the request. */
export function needsSavedPersonaSelection(source, connectionsSaved) {
    return source?.kind === 'roleplay' && !connectionsSaved;
}

/** Retries like the connection save: a temporary state such as a settings conflict or response-length override clears. */
export async function saveSelectedPersona() {
    for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt += 1) {
        try {
            if (await saveSettings(0, { returnResult: true })) return true;
        } catch {
            // A failed attempt is retried below.
        }
        if (attempt < SAVE_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, Math.min(1500, 250 * attempt)));
    }
    return false;
}

export async function preparePersonaChange(change, source, shared, guard) {
    const owner = getCurrentUserHandle();
    const check = () => {
        guard();
        if (getCurrentUserHandle() !== owner) throw new Error('The account changed. Reopen the persona review.');
        requireSharedPersona(source, shared, change.persona);
    };
    check();
    const note = change.type === 'persona-note';
    const findNote = () => {
        const matches = (power_user.persona_descriptions?.[shared.avatar]?.appendices || []).filter(item => item.id === change.noteId);
        if (matches.length !== 1) throw new Error('This Scenario Note no longer exists or its ID is ambiguous. Ask for a fresh suggestion.');
        return matches[0];
    };
    const noteName = note ? findNote().name : '';
    const read = () => note ? findNote()[change.field] || '' : change.field === 'name' ? power_user.personas[shared.avatar] : power_user.persona_descriptions?.[shared.avatar]?.[change.field] || '';
    const before = read();
    const avatar = note && change.field === 'avatar';
    if (!note && change.field === 'avatar') throw new Error('Use a persona avatar review to replace the portrait.');
    const picture = (label, value) => h('figure', {}, h('figcaption', { text: label }), h('img', { src: normalizeScenarioAvatar(value) || getUserAvatar(shared.avatar), alt: label }));
    return { target: note ? `${shared.name}: ${noteName}` : shared.name, field: `${note ? 'Scenario Note' : 'Persona'} ${PERSONA_FIELDS[change.field].toLowerCase()}`, before, after: change.value, editable: !avatar,
        ...(avatar ? { visual: h('div', { class: 'scratchpad-avatar-review' }, picture('Current avatar', before), picture(change.value ? 'Proposed avatar' : 'Persona avatar (fallback)', change.value)) } : {}),
        hint: note ? 'This changes the saved Scenario Note in every chat using it. Its activation in each chat is kept.' : 'This changes the saved persona across chats. Chat-specific additions and connections are kept.',
        async commit(edited) {
            check();
            if (read() !== before) throw new Error('This persona changed while the review was open. Ask for a fresh suggestion.');
            const value = personaFieldValue(change.field, edited);
            const write = value => {
                if (note) {
                    if (avatar && !value) delete findNote().avatar;
                    else findNote()[change.field] = value;
                } else if (change.field === 'name') power_user.personas[shared.avatar] = value;
                else {
                    power_user.persona_descriptions ??= {};
                    power_user.persona_descriptions[shared.avatar] ??= {};
                    power_user.persona_descriptions[shared.avatar][change.field] = value;
                }
                if (shared.avatar === user_avatar) {
                    if (!note && change.field === 'name') setUserName(value, { toastPersonaNameChange: false });
                    setPersonaDescription();
                }
            };
            try {
                write(value);
                if (!await saveSettings(0, { returnResult: true })) throw new Error('The persona was not saved. Reload and review it again.');
            } catch (error) {
                try {
                    if (getCurrentUserHandle() === owner && read() === value) write(before);
                } catch { /* A deleted note or changed account must not be recreated by rollback. */ }
                throw error;
            }
            let refreshFailed = false;
            try { await getUserAvatars(); await eventSource.emit(event_types.PERSONA_UPDATED, shared.avatar); } catch { refreshFailed = true; }
            return { committed: true, refreshFailed };
        } };
}
