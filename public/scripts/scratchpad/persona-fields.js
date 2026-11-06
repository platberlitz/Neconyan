import { normalizeScenarioAvatar } from '../persona-appendix-avatar.js';

export const PERSONA_FIELDS = Object.freeze({ name: 'Name', description: 'Description', title: 'Title', avatar: 'Avatar' });

export function personaDraft(value, { note = false } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Use a JSON object for the new persona or Scenario Note.');
    return {
        name: personaFieldValue('name', value.name),
        description: personaFieldValue('description', value.description ?? ''),
        ...(!note ? { title: personaFieldValue('title', value.title ?? '') } : {}),
    };
}

export function personaFieldValue(field, value) {
    if (field === 'avatar') {
        if (value === '' || normalizeScenarioAvatar(value)) return value;
        throw new Error('Use a saved Scenario Note portrait or remove its avatar.');
    }
    if (!Object.hasOwn(PERSONA_FIELDS, field) || typeof value !== 'string' || value.length > 200_000) throw new Error('Use a supported persona field and text up to 200000 characters.');
    if (field === 'name' && (!value.trim() || value.length > 200)) throw new Error('Use a persona name between 1 and 200 characters.');
    return field === 'name' ? value.trim() : value;
}
