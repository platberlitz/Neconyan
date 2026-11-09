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

function isNoteProfile(profile) {
    return profile && typeof profile === 'object' && typeof profile.id === 'string' && profile.id;
}

function getSavedPersonaLibrary(entry, avatar) {
    const libraries = entry?.personaNoteLibraries;
    const library = libraries && !Array.isArray(libraries) && Object.hasOwn(libraries, avatar) ? libraries[avatar] : null;
    return library && Array.isArray(library.profiles) && library.profiles.some(isNoteProfile) ? library : null;
}

function getLegacyPersonaSelection(entry, avatar) {
    const mix = entry.personaActiveProfiles && Object.hasOwn(entry.personaActiveProfiles, avatar)
        ? entry.personaActiveProfiles[avatar] : undefined;
    const pick = entry.personaProfiles && Object.hasOwn(entry.personaProfiles, avatar)
        ? entry.personaProfiles[avatar] : undefined;
    return { mix: Array.isArray(mix) ? mix : undefined, pick };
}

// Old libraries were full copies of the shared list. Retain explicit persona assignments and
// anything created or edited in that library, rather than treating every inherited row as owned.
// Read-time scoping is pure: the browser and server see the same collection before the next save.
export function getNoteProfileStore(entry, personaAvatar = '') {
    if (!entry?.perPersona || !personaAvatar) return entry;
    const saved = getSavedPersonaLibrary(entry, personaAvatar);
    if (saved?.scopeVersion === 1) return saved;

    const shared = getNoteProfiles(entry);
    const { mix, pick } = getLegacyPersonaSelection(entry, personaAvatar);
    const selected = saved ? getActiveNoteProfileIds(saved) : mix ?? (pick ? [pick] : []);
    const assigned = new Set([...(mix ?? []), pick, ...selected]);
    const source = saved ? getNoteProfiles(saved) : shared;
    let profiles = source.filter(profile => {
        if (assigned.has(profile.id)) return true;
        if (!saved) return false;
        const original = shared.find(item => item.id === profile.id);
        return !original || ['name', 'prompt', 'position'].some(key => profile[key] !== original[key]);
    });
    // A new persona gets an empty editor, never another persona's text or names.
    if (!profiles.length) profiles = getNoteProfiles({ position: NOTE_POSITION.after });
    const activeProfiles = profiles.filter(profile => selected.includes(profile.id)).map(profile => profile.id);
    if (!saved && mix === undefined && !pick && profiles[0].id === DEFAULT_NOTE_PROFILE_ID) {
        activeProfiles.push(DEFAULT_NOTE_PROFILE_ID);
    }
    return {
        ...saved,
        scopeVersion: 1,
        profiles: profiles.map(profile => ({ ...profile })),
        activeProfile: profiles.find(profile => profile.id === saved?.activeProfile)?.id ?? activeProfiles[0] ?? profiles[0].id,
        activeProfiles,
        // Preserve the exact old copied rows, even if the shared originals are edited later.
        ...(saved ? { inheritedProfiles: saved.inheritedProfiles ?? source.filter(profile => !profiles.includes(profile)) } : {}),
    };
}

export function ensurePersonaNoteLibrary(entry, personaAvatar, { adoptShared = false } = {}) {
    if (!entry?.perPersona || !personaAvatar) {
        return entry;
    }
    const hasAssignments = ['personaNoteLibraries', 'personaProfiles', 'personaActiveProfiles']
        .some(key => Object.keys(entry[key] ?? {}).length);
    // Like Conversation's unscoped-data migration, first opt-in adopts existing notes once.
    const library = adoptShared && !hasAssignments ? {
        scopeVersion: 1,
        profiles: getNoteProfiles(entry).map(profile => ({ ...profile })),
        activeProfile: getActiveNoteProfileId(entry),
        activeProfiles: getActiveNoteProfileIds(entry),
    } : getNoteProfileStore(entry, personaAvatar);
    entry.personaNoteLibraries = { ...entry.personaNoteLibraries, [personaAvatar]: library };
    return library;
}

/**
 * Profiles saved on a character or persona note. Notes written before profiles existed keep their
 * text in `prompt` and `position`; they read as a single profile named Default.
 * Values are returned as stored so callers can decide how strictly to validate them.
 */
export function getNoteProfiles(entry, personaAvatar = '') {
    entry = getNoteProfileStore(entry, personaAvatar);
    if (!entry || typeof entry !== 'object') {
        return [];
    }

    if (Array.isArray(entry.profiles)) {
        const profiles = entry.profiles.filter(isNoteProfile);
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
 * The profile id in the selected collection. A persona without saved notes has an empty Default
 * profile, not the shared collection's active note.
 */
export function getActiveNoteProfileId(entry, personaAvatar = '') {
    entry = getNoteProfileStore(entry, personaAvatar);
    const profiles = getNoteProfiles(entry);
    if (!profiles.length) {
        return null;
    }

    return profiles.some(profile => profile.id === entry.activeProfile) ? entry.activeProfile : profiles[0].id;
}

export function resolveNoteProfile(entry, personaAvatar = '') {
    const id = getActiveNoteProfileId(entry, personaAvatar);
    return id ? getNoteProfiles(entry, personaAvatar).find(profile => profile.id === id) ?? null : null;
}

/**
 * The character notes switched on together, in collection order. Persona scoping and legacy
 * selections are resolved by getNoteProfileStore. An empty saved mix means none is in use.
 */
export function getActiveNoteProfileIds(entry, personaAvatar = '') {
    entry = getNoteProfileStore(entry, personaAvatar);
    const profiles = getNoteProfiles(entry);
    if (!profiles.length) {
        return [];
    }

    const inListOrder = ids => profiles.filter(profile => ids.includes(profile.id)).map(profile => profile.id);

    if (Array.isArray(entry.activeProfiles)) {
        return inListOrder(entry.activeProfiles);
    }

    return [getActiveNoteProfileId(entry)];
}

export function resolveActiveNoteProfiles(entry, personaAvatar = '') {
    const ids = getActiveNoteProfileIds(entry, personaAvatar);
    return getNoteProfiles(entry, personaAvatar).filter(profile => ids.includes(profile.id));
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
 * prompt builders validate: `scoped` for the character, `persona` for the persona. `scoped.notes`
 * holds every character note in the mix; snapshots taken before mixes existed hold a single
 * `prompt` and `position` instead.
 */
export function captureScopedAuthorsNotes(characterEntry, personaEntry, personaAvatar = '') {
    const personaProfile = resolveNoteProfile(personaEntry, personaAvatar);
    return {
        scoped: characterEntry && typeof characterEntry === 'object' ? {
            useChara: Boolean(characterEntry.useChara),
            notes: resolveActiveNoteProfiles(characterEntry, personaAvatar).map(profile => ({
                prompt: profile.prompt,
                position: profile.position,
            })),
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
