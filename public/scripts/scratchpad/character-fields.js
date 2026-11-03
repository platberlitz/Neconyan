/** Shared field contract for proposals, card context and reviewed saves. */
export const CHARACTER_FIELDS = Object.freeze({
    name: { label: 'name', type: 'text', top: 'name' },
    description: { label: 'description', type: 'text', top: 'description' },
    personality: { label: 'personality', type: 'text', top: 'personality' },
    scenario: { label: 'scenario', type: 'text', top: 'scenario' },
    first_mes: { label: 'first message', type: 'text', top: 'first_mes' },
    mes_example: { label: 'example messages', type: 'text', top: 'mes_example' },
    creator_notes: { label: 'creator\'s notes', type: 'text', top: 'creatorcomment' },
    system_prompt: { label: 'system prompt', type: 'text' },
    post_history_instructions: { label: 'post-history instructions', type: 'text' },
    creator: { label: 'creator', type: 'text' },
    character_version: { label: 'character version', type: 'text' },
    alternate_greetings: { label: 'alternate greetings', type: 'greetings' },
    group_only_greetings: { label: 'group-only greetings', type: 'greetings' },
    tags: { label: 'tags', type: 'tags', top: 'tags' },
    'extensions.depth_prompt.prompt': { label: 'character\'s note', type: 'text', default: '' },
    'extensions.depth_prompt.depth': { label: 'character\'s note depth', type: 'number', min: 0, max: 9999, integer: true, default: 4, hint: 'Use a whole number from 0 to 9999.' },
    'extensions.depth_prompt.role': { label: 'character\'s note role', type: 'role', default: 'system', hint: 'Use system, user or assistant.' },
    'extensions.talkativeness': { label: 'talkativeness', type: 'number', min: 0, max: 1, top: 'talkativeness', default: 0.5, hint: 'Use a number from 0 to 1.' },
    'extensions.fav': { label: 'favourite status', type: 'boolean', top: 'fav', default: false, hint: 'Use true or false.' },
    'extensions.world': { label: 'linked lorebook', type: 'text', default: '', hint: 'Use the exact name of an existing lorebook, or leave empty to unlink it.' },
});

const ALIASES = Object.freeze({
    ch_name: 'name', creatorcomment: 'creator_notes',
    characterNote: 'extensions.depth_prompt.prompt', depth_prompt_prompt: 'extensions.depth_prompt.prompt',
    depth_prompt_depth: 'extensions.depth_prompt.depth', depth_prompt_role: 'extensions.depth_prompt.role',
    talkativeness: 'extensions.talkativeness', fav: 'extensions.fav', world: 'extensions.world',
});

export function characterFieldName(field) {
    return Object.hasOwn(ALIASES, field) ? ALIASES[field] : field;
}

export function characterField(field) {
    const name = characterFieldName(field);
    return Object.hasOwn(CHARACTER_FIELDS, name) ? CHARACTER_FIELDS[name] : null;
}

export function readCharacterField(character, field) {
    field = characterFieldName(field);
    const definition = characterField(field);
    if (!definition) throw new Error('Scratchpad cannot change that character field.');
    const value = field.split('.').reduce((value, key) => value?.[key], character?.data)
        ?? character?.[definition.top || field] ?? definition.default;
    if (definition.type === 'greetings' || definition.type === 'tags') return Array.isArray(value) ? value.map(String) : [];
    return value ?? '';
}

/** Only registered paths can produce a patch; siblings stay on the saved card. */
export function characterFieldPatch(field, value) {
    field = characterFieldName(field);
    const definition = characterField(field);
    if (!definition) throw new Error('Scratchpad cannot change that character field.');
    const data = field.split('.').reduceRight((value, key) => ({ [key]: value }), value);
    return { data, ...(definition.top ? { [definition.top]: value } : {}) };
}

export const CHARACTER_FIELD_INSTRUCTIONS = [
    '- Text fields: ' + Object.entries(CHARACTER_FIELDS).filter(([, value]) => value.type === 'text').map(([key]) => key).join(', ') + '.',
    '- List fields: alternate_greetings, group_only_greetings and tags (value is a list of strings).',
    '- extensions.depth_prompt.prompt is the Character\'s Note, not creator_notes. Set its depth with extensions.depth_prompt.depth (integer 0 to 9999), and its role with extensions.depth_prompt.role (system, user or assistant).',
    '- extensions.talkativeness is a number from 0 to 1; extensions.fav is true or false. extensions.world is the exact name of an existing lorebook, or an empty string to unlink it.',
    '- To change the name, target the current character name and use field name. This changes the card name without moving its file or chats. Request fresh suggestions using the new name afterwards.',
    '- Portraits use image/avatar suggestions, not character field changes. Card filenames, chat IDs and internal metadata are not editable fields.',
].join('\n');
