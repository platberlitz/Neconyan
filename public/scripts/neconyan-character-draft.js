/** Character drafts shared by assistant tools and Scratchpad review cards. */
export const CHARACTER_DRAFT_FIELDS = Object.freeze(['name', 'description', 'personality', 'scenario', 'first_mes',
    'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions']);

export function normaliseCharacterDraft(input) {
    const card = input?.character;
    if (!card || typeof card !== 'object' || Array.isArray(card)) throw new Error('The character draft needs its character fields.');
    const name = typeof card.name === 'string' ? card.name.trim() : '';
    if (!name || name.length > 200 || /[\\/\x00-\x1f]/.test(name) || /^\.+$/.test(name)) {
        throw new Error('Use a character name of 1-200 characters without path separators.');
    }
    for (const [key, value] of Object.entries(card)) {
        if (!CHARACTER_DRAFT_FIELDS.includes(key) || typeof value !== 'string' || value.length > 100000) throw new Error(`Invalid character field: ${key}`);
    }
    const characterNote = input.characterNote ?? '';
    const avatarPrompt = input.avatarPrompt ?? '';
    const alternateGreetings = input.alternateGreetings ?? [];
    if (typeof characterNote !== 'string' || characterNote.length > 100000) throw new Error('The character note must be text under 100,000 characters.');
    if (typeof avatarPrompt !== 'string' || avatarPrompt.length > 10000) throw new Error('The avatar prompt must be text under 10,000 characters.');
    if (!Array.isArray(alternateGreetings) || alternateGreetings.length > 20 || alternateGreetings.some(value => typeof value !== 'string' || value.length > 100000)) {
        throw new Error('alternateGreetings must be a list of up to 20 strings.');
    }
    return { character: { ...card, name }, characterNote, alternateGreetings: [...alternateGreetings], avatarPrompt: avatarPrompt.trim() };
}
