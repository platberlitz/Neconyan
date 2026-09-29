// Shared by the browser Author's Note panel and the server prompt builders, so both pick the same
// profile and combine notes in the same order. Keep this module free of imports.

export const NOTE_POSITION = Object.freeze({
    replace: 0,
    before: 1,
    after: 2,
});

export const DEFAULT_NOTE_PROFILE_ID = 'default';

export function isValidNotePosition(value) {
    return Object.values(NOTE_POSITION).includes(Number(value));
}

/**
 * Profiles saved on a character or persona note. Notes written before profiles existed keep their
 * text in `prompt` and `position`; they read as a single profile named Default.
 * Values are returned as stored so callers can decide how strictly to validate them.
 */
export function getNoteProfiles(entry) {
    if (!entry || typeof entry !== 'object') {
        return [];
    }

    if (Array.isArray(entry.profiles)) {
        const profiles = entry.profiles.filter(profile => profile && typeof profile === 'object' && typeof profile.id === 'string' && profile.id);
        if (profiles.length) {
            return profiles;
        }
    }

    return [{
        id: DEFAULT_NOTE_PROFILE_ID,
        name: 'Default',
        prompt: entry.prompt ?? '',
        position: entry.position ?? NOTE_POSITION.replace,
    }];
}

/**
 * The profile id in effect. With `perPersona` on, the pick saved for the persona wins; otherwise,
 * or when that persona has no pick yet, the note's shared active profile is used.
 */
export function getActiveNoteProfileId(entry, personaAvatar = '') {
    const profiles = getNoteProfiles(entry);
    if (!profiles.length) {
        return null;
    }

    const personaPick = entry.perPersona && personaAvatar && entry.personaProfiles && typeof entry.personaProfiles === 'object'
        ? entry.personaProfiles[personaAvatar]
        : undefined;

    for (const id of [personaPick, entry.activeProfile]) {
        if (id && profiles.some(profile => profile.id === id)) {
            return id;
        }
    }

    return profiles[0].id;
}

export function resolveNoteProfile(entry, personaAvatar = '') {
    const id = getActiveNoteProfileId(entry, personaAvatar);
    return id ? getNoteProfiles(entry).find(profile => profile.id === id) ?? null : null;
}

/**
 * The saved note for a solo character. The browser keys notes by the avatar file name without its
 * extension (`individual:Name`); older saves used the bare name.
 */
export function findCharacterNoteEntry(chara, avatar) {
    if (!Array.isArray(chara) || !avatar) {
        return null;
    }

    const stem = String(avatar).replace(/\.[^/.]+$/, '');
    for (const name of [`individual:${stem}`, `individual:${avatar}`, stem]) {
        const entry = chara.find(item => item?.name === name);
        if (entry) {
            return entry;
        }
    }

    return null;
}

export function getPersonaNoteEntry(store, personaAvatar) {
    if (!store || typeof store !== 'object' || Array.isArray(store) || !personaAvatar || !Object.hasOwn(store, personaAvatar)) {
        return null;
    }

    const entry = store[personaAvatar];
    return entry && typeof entry === 'object' ? entry : null;
}

/**
 * Snapshot of the character and persona notes in effect for one reply, in the shape the server
 * prompt builders validate: `scoped` for the character, `persona` for the persona.
 */
export function captureScopedAuthorsNotes(characterEntry, personaEntry, personaAvatar = '') {
    const characterProfile = resolveNoteProfile(characterEntry, personaAvatar);
    const personaProfile = resolveNoteProfile(personaEntry, personaAvatar);
    return {
        scoped: characterEntry && characterProfile ? {
            useChara: Boolean(characterEntry.useChara),
            prompt: characterProfile.prompt,
            position: characterProfile.position,
        } : null,
        persona: personaEntry && personaProfile ? {
            useNote: Boolean(personaEntry.useNote),
            prompt: personaProfile.prompt,
            position: personaProfile.position,
        } : null,
    };
}

/**
 * Combines the chat Author's Note with any enabled character and persona notes. Top notes go
 * above and bottom notes below, character first; if any enabled note replaces, the chat note is
 * dropped and the replacing notes take its place.
 * @param {string} base The chat Author's Note text.
 * @param {{ enabled: boolean, prompt: string, position: number }[]} notes In order: character, persona.
 */
export function composeAuthorsNote(base, notes) {
    const active = (Array.isArray(notes) ? notes : []).filter(note => note?.enabled);
    const before = [];
    const replace = [];
    const after = [];

    for (const note of active) {
        const position = Number(note.position);
        const target = position === NOTE_POSITION.before ? before : position === NOTE_POSITION.after ? after : replace;
        target.push(String(note.prompt ?? ''));
    }

    const middle = replace.length ? replace : [String(base ?? '')];
    return [...before, ...middle, ...after].filter(Boolean).join('\n');
}
