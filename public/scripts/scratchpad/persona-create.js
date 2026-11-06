import { default_user_avatar, getRequestHeaders, saveSettings } from '../../script.js';
import { getUserAvatars, persona_description_positions } from '../personas.js';
import { power_user } from '../power-user.js';
import { event_types, eventSource } from '../events.js';
import { getCurrentUserHandle } from '../user.js';
import { isCurrentSource } from './context.js';
import { requireSharedPersona } from './persona-changes.js';
import { personaDraft } from './persona-fields.js';

/** Creation uses the normal review, but never selects a persona or activates a note. */
export async function preparePersonaCreation(change, source, { shared, guard, key }) {
    const owner = getCurrentUserHandle();
    const note = change.type === 'persona-note';
    const check = () => {
        guard?.();
        if (getCurrentUserHandle() !== owner || !isCurrentSource(source)) throw new Error('Return to the original account and Scratchpad context before saving.');
        if (note) requireSharedPersona(source, shared, change.persona);
    };
    check();
    if (!key) throw new Error('This creation needs its original Scratchpad message.');
    // Reopening the same suggestion after a failed Saved mark must not create a duplicate.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    const id = `scratchpad-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    check();
    const avatar = `${id}.png`;
    const descriptor = () => {
        const value = power_user.persona_descriptions?.[shared.avatar];
        if (!value) throw new Error('This persona no longer exists. Ask for a fresh suggestion.');
        return value;
    };
    if (note) descriptor();
    const draft = personaDraft(change, { note });
    let committed;
    return {
        target: note ? shared.name : draft.name,
        field: note ? 'New Scenario Note' : 'New persona',
        before: '', after: JSON.stringify(draft, null, 2), editable: true,
        hint: note ? 'Edit the name and description in this JSON. The note is saved to this persona; choose where to activate it in Personas.'
            : 'Edit the name, description and title in this JSON. The new persona uses the default portrait. Your selected persona stays selected.',
        async commit(edited) {
            check();
            if (committed) return committed;
            committed = save(edited).catch(error => { committed = null; throw error; });
            return committed;
        },
    };

    async function discardPortrait() {
        if (note || getCurrentUserHandle() !== owner || Object.hasOwn(power_user.personas, avatar)) return;
        try {
            await fetch('/api/avatars/delete', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar }) });
        } catch { /* A disconnected request can be retried with the same portrait filename. */ }
    }

    async function save(edited) {
        let input;
        try { input = JSON.parse(edited); } catch { throw new Error('The draft must be valid JSON. Check its quotes and commas.'); }
        const value = personaDraft(input, { note });
        if (note ? descriptor().appendices?.some(item => item.id === id) : Object.hasOwn(power_user.personas, avatar)) return { committed: true };
        if (!note) {
            const image = await fetch(default_user_avatar);
            if (!image.ok) throw new Error('The default persona portrait could not be read.');
            const blob = await image.blob();
            check();
            const body = new FormData();
            body.append('avatar', blob, avatar);
            body.append('overwrite_name', avatar);
            const response = await fetch('/api/avatars/upload', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body });
            if (!response.ok) throw new Error('The new persona portrait could not be saved.');
            try { check(); } catch (error) { await discardPortrait(); throw error; }
        }
        const entry = note ? { id, ...value } : {
            description: value.description, title: value.title, position: persona_description_positions.IN_PROMPT,
            depth: 2, role: 0, lorebook: '', appendices: [], activeAppendices: {},
        };
        if (note) (descriptor().appendices ??= []).push(entry);
        else {
            power_user.personas[avatar] = value.name;
            power_user.persona_descriptions[avatar] = entry;
        }
        try {
            if (!await saveSettings(0, { returnResult: true })) throw new Error('The creation was not saved. Review it again before retrying.');
        } catch (error) {
            if (getCurrentUserHandle() === owner) {
                if (note) {
                    const live = power_user.persona_descriptions?.[shared.avatar];
                    if (live?.appendices) live.appendices = live.appendices.filter(item => item.id !== id);
                } else if (power_user.persona_descriptions[avatar] === entry) {
                    delete power_user.personas[avatar];
                    delete power_user.persona_descriptions[avatar];
                }
            }
            await discardPortrait();
            throw error;
        }
        let refreshFailed = false;
        try {
            check();
            await getUserAvatars();
            await eventSource.emit(note ? event_types.PERSONA_UPDATED : event_types.PERSONA_CREATED,
                note ? shared.avatar : { avatarId: avatar, name: value.name, description: value.description, title: value.title });
        } catch { refreshFailed = true; }
        return { committed: true, refreshFailed };
    }
}
