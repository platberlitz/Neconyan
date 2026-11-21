import { getStringHash } from '../macro-primitives.js';

const MAX_REFERENCES = 256;
const validId = id => typeof id === 'string' && id.length <= 200 && Boolean(id.trim());
const reference = (avatar, id) => `sn-${getStringHash(JSON.stringify([avatar, id])).toString(36)}`;

/** Keep references stable across renames and reordering. Neither duplicate IDs nor collisions get a reference. */
export function shareScenarioNotes(avatar, appendices) {
    const notes = Array.isArray(appendices) ? appendices : [];
    const byRef = new Map();
    for (const { id } of notes) {
        if (!validId(id)) continue;
        const ref = reference(avatar, id);
        byRef.set(ref, byRef.has(ref) ? null : id);
    }
    const noteRefs = Object.fromEntries([...byRef].filter(([, id]) => id !== null).slice(0, MAX_REFERENCES));
    return { noteRefs, notes: notes.map(({ id, name, description, avatar: portrait }) => {
        const ref = validId(id) ? reference(avatar, id) : '';
        return { ...(Object.hasOwn(noteRefs, ref) ? { ref } : {}), name, description, hasAvatar: Boolean(portrait) };
    }) };
}

/** Store the mapping on the reply, not in the model prompt. Undefined denotes an older reply. */
export function normaliseScenarioNoteRefs(value, avatar) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return Object.fromEntries(Object.entries(value).slice(0, MAX_REFERENCES)
        .filter(([ref, id]) => validId(id) && ref === reference(avatar, id)));
}

/** A proposal has exactly one selector. Keep exact IDs for replies from before references were introduced. */
export function scenarioNoteSelector({ noteRef, noteId }) {
    if (noteId === undefined && typeof noteRef === 'string' && /^sn-[a-z0-9]{1,11}$/.test(noteRef)) return { noteRef };
    if (noteRef === undefined && validId(noteId)) return { noteId };
    return null;
}

export function resolveScenarioNoteId(change, sharedPersona) {
    const selector = scenarioNoteSelector(change);
    if (!selector) return null;
    if (selector.noteId !== undefined) return selector.noteId;
    const refs = sharedPersona?.noteRefs;
    return refs && Object.hasOwn(refs, selector.noteRef) ? refs[selector.noteRef] : null;
}
