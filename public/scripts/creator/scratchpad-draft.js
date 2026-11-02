import { createCreatorDraft, TEXT_FIELDS } from './model.js';

export const CREATOR_SCRATCHPAD_INSTRUCTIONS = `Creator workspace integration: when the user wants to develop a character in Creator, collect the facts from your discussion into a private draft, not a published card.
Offer a scratchpad-change fence with {"type":"creator","action":"create","name":"Character name","dossier":"All agreed character information, unresolved questions labelled clearly","fields":{"description":"Optional drafted text","mes_example":"Interviewer: ...\\n{{char}}: ..."}}. fields is optional and accepts character text fields only. Keep macros literal. Include only information actually shared in this conversation; do not invent private notebook access. The user reviews this proposal before it creates a draft. Saving it does not publish a character, start a chat, generate an image or change a notebook. Prefer this over immediate character creation when the user asks to use Creator or keep developing the card.`;

export function normaliseScratchpadCreator(value) {
    if (value?.type !== 'creator' || value.action !== 'create') throw new Error('Creator proposals create a private draft.');
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200) throw new Error('Give this draft a name of up to 200 characters.');
    if (typeof value.dossier !== 'string' || value.dossier.length > 100000) throw new Error('Provide Dossier text of up to 100,000 characters.');
    const fields = value.fields ?? {};
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Character fields must be an object.');
    for (const [key, text] of Object.entries(fields)) {
        if (!TEXT_FIELDS.includes(key) || key === 'name' || typeof text !== 'string' || text.length > 100000) throw new Error(`Unsupported Creator field: ${key}`);
    }
    return { type: 'creator', action: 'create', name: value.name.trim(), dossier: value.dossier, fields: structuredClone(fields) };
}

export function scratchpadCreatorDraft(value, id) {
    const change = normaliseScratchpadCreator(value);
    const draft = createCreatorDraft({ id, card: { data: { ...change.fields, name: change.name } } });
    draft.dossier = change.dossier;
    draft.view.section = 'dossier';
    return draft;
}
