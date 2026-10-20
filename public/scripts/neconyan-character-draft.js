/** Character drafts shared by assistant tools and Scratchpad review cards. */
export const CHARACTER_DRAFT_FIELDS = Object.freeze(['name', 'description', 'personality', 'scenario', 'first_mes',
    'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions']);

const COMPATIBILITY_FIELDS = ['characterNote', 'alternateGreetings', 'alternate_greetings'];

function ownValues(object, keys) {
    return keys.filter(key => Object.hasOwn(object, key)).map(key => object[key]).filter(value => value != null);
}

function resolveOptional(values, fallback, valid, error, field) {
    // Validate every supplied value before comparing duplicates; a valid canonical value must not hide an invalid alias.
    if (values.some(value => !valid(value))) throw new Error(error);
    const first = values[0] ?? fallback;
    if (values.some(value => Array.isArray(first)
        ? value.length !== first.length || value.some((item, index) => item !== first[index])
        : value !== first)) throw new Error(`Conflicting values for ${field}.`);
    return first;
}

export function normaliseCharacterDraft(input) {
    const card = input?.character;
    if (!card || typeof card !== 'object' || Array.isArray(card)) throw new Error('The character draft needs its character fields.');
    const name = typeof card.name === 'string' ? card.name.trim() : '';
    if (!name || name.length > 200 || /[\\/\x00-\x1f]/.test(name) || /^\.+$/.test(name)) {
        throw new Error('Use a character name of 1-200 characters without path separators.');
    }
    for (const [key, value] of Object.entries(card)) {
        if (COMPATIBILITY_FIELDS.includes(key)) continue;
        if (!CHARACTER_DRAFT_FIELDS.includes(key) || typeof value !== 'string' || value.length > 100000) throw new Error(`Invalid character field: ${key}`);
    }
    const characterNote = resolveOptional([...ownValues(input, ['characterNote']), ...ownValues(card, ['characterNote'])], '',
        value => typeof value === 'string' && value.length <= 100000,
        'The character note must be text under 100,000 characters.', 'characterNote');
    const avatarPrompt = input.avatarPrompt ?? '';
    if (typeof avatarPrompt !== 'string' || avatarPrompt.length > 10000) throw new Error('The avatar prompt must be text under 10,000 characters.');
    const alternateGreetings = resolveOptional([
        ...ownValues(input, ['alternateGreetings', 'alternate_greetings']), ...ownValues(card, ['alternateGreetings', 'alternate_greetings']),
    ], [], value => Array.isArray(value) && value.length <= 20 && value.every(item => typeof item === 'string' && item.length <= 100000),
    'alternateGreetings must be a list of up to 20 strings.', 'alternateGreetings');
    const character = Object.fromEntries(Object.entries(card).filter(([key]) => CHARACTER_DRAFT_FIELDS.includes(key)));
    return { character: { ...character, name }, characterNote, alternateGreetings: [...alternateGreetings], avatarPrompt: avatarPrompt.trim() };
}
