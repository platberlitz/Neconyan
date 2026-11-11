/**
 * Reading proposed changes out of a Scratchpad reply. Nothing here touches the
 * app, so it can be tested on its own.
 */
import { NOTE_TOOL_DEFINITIONS, NOTE_MUTATING_KINDS } from '../notebooks/assistant-note-tools.js';
import { normaliseCharacterDraft } from '../neconyan-character-draft.js';
import { CHARACTER_FIELDS, characterField, characterFieldName } from './character-fields.js';
import { PERSONA_FIELDS, personaDraft, personaFieldValue } from './persona-fields.js';
import { validPresetValue } from './preset-fields.js';

export const CHANGE_FENCE = 'scratchpad-change';
const FENCE_PATTERN = /```scratchpad-change[^\n]*\n([\s\S]*?)```/g;
const MAX_CHANGES = 24;

export const TEXT_FIELDS = Object.freeze(Object.fromEntries(Object.entries(CHARACTER_FIELDS).filter(([, value]) => value.type === 'text').map(([key, value]) => [key, value.label])));
export const LIST_FIELDS = Object.freeze(Object.fromEntries(Object.entries(CHARACTER_FIELDS).filter(([, value]) => ['greetings', 'tags'].includes(value.type)).map(([key, value]) => [key, value.label])));
export const GREETING_SEPARATOR = '\n\n---\n\n';

export class ScratchpadChangeError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ScratchpadChangeError';
    }
}

export function fail(message) {
    throw new ScratchpadChangeError(message);
}

function text(value, limit = 200_000) {
    return typeof value === 'string' ? value.slice(0, limit) : '';
}

function messageNumber(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    const target = String(value).trim().replace(/^#/, '');
    if (!/^\d+$/.test(target)) return null;
    const number = Number(target);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export const AGENT_FIELDS = Object.freeze(['name', 'description', 'prompt']);

export function stringList(value) {
    if (Array.isArray(value)) return value.map(item => String(item ?? '').trim()).filter(Boolean);
    if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean);
    return [];
}

/**
 * Checks one proposed change from a reply and returns a tidy copy, or throws
 * a plain message explaining why the change cannot be used.
 */
export function normaliseChange(value) {
    if (value?.type === 'creator') return normaliseScratchpadCreator(value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('This change is not a JSON object.');
    const reason = text(value.reason, 1000).trim();
    if (value.type === 'preset') {
        if (value.action !== 'replace' || typeof value.preset !== 'string' || !value.preset.trim() || value.preset.length > 300
            || !validPresetValue(value.api, value.field, value.value)) fail('This preset change needs a shared preset, a supported field and a valid value.');
        if (value.api === 'openai' && (typeof value.module !== 'string' || !value.module || value.module.length > 300)) fail('This preset change needs the exact prompt module ID.');
        return { type: 'preset', action: 'replace', api: value.api, preset: value.preset,
            ...(value.api === 'openai' ? { module: value.module } : {}), field: value.field, value: value.value, reason };
    }
    if (value.type === 'image') {
        if (value.action !== 'generate' || !['image', 'avatar', 'persona-avatar', 'persona-note-avatar'].includes(value.target)) fail('This image suggestion needs a valid action and target.');
        const personaTarget = ['persona-avatar', 'persona-note-avatar'].includes(value.target);
        if (personaTarget && (typeof value.persona !== 'string' || !value.persona.trim() || value.persona.length > 200 || value.character !== undefined)) fail('A persona avatar suggestion must name only the shared persona.');
        if (!personaTarget && value.persona !== undefined) fail('Only a persona avatar suggestion can name a persona.');
        if (value.target === 'persona-note-avatar') {
            if (typeof value.noteId !== 'string' || !value.noteId.trim() || value.noteId.length > 200) fail('A Scenario Note avatar needs its exact saved note ID.');
        } else if (value.noteId !== undefined) fail('Only a Scenario Note avatar can name a note.');
        if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 10_000) fail('Write an image prompt between 1 and 10000 characters.');
        if (value.negative !== undefined && (typeof value.negative !== 'string' || value.negative.length > 10_000)) fail('The negative image prompt must be text up to 10000 characters.');
        if (value.character !== undefined && (typeof value.character !== 'string' || !value.character.trim() || value.character.length > 200)) fail('This image suggestion needs an unambiguous shared character name.');
        if (value.target === 'avatar' && !value.character?.trim()) fail('An avatar suggestion must name a shared character.');
        return { type: 'image', action: 'generate', target: value.target, prompt: value.prompt.trim(), negative: value.negative?.trim() || '',
            ...(value.character ? { character: value.character.trim() } : {}), ...(value.persona ? { persona: value.persona.trim() } : {}),
            ...(value.target === 'persona-note-avatar' ? { noteId: value.noteId } : {}), reason };
    }
    if (value.type === 'notebook') {
        const definition = Object.values(NOTE_TOOL_DEFINITIONS).find(item => item.kind === value.action && NOTE_MUTATING_KINDS.includes(item.kind));
        if (!definition) fail('This note change has an unknown action.');
        const args = value.args;
        if (!args || typeof args !== 'object' || Array.isArray(args)) fail('This note change needs its note details.');
        const clean = {};
        for (const [key, schema] of Object.entries(definition.schema.properties)) {
            if (!Object.hasOwn(args, key)) continue;
            const item = args[key];
            if (schema.type === 'string' && (typeof item !== 'string' || item.length > 200_000)) fail(`The note change has an invalid ${key}.`);
            if (schema.type === 'integer' && (!Number.isSafeInteger(item) || item < 0)) fail(`The note change has an invalid ${key}.`);
            if (schema.type === 'object' && (!item || typeof item !== 'object' || Array.isArray(item))) fail(`The note change has an invalid ${key}.`);
            clean[key] = item;
        }
        for (const key of definition.schema.required ?? []) {
            if (!Object.hasOwn(clean, key)) fail(`The note change is missing ${key}.`);
        }
        if (!['create-note', 'publish-note-lore'].includes(value.action) && !clean.expectedRevision) fail('Read the note again before proposing a change: its revision is missing.');
        return { type: 'notebook', action: value.action, args: clean, reason };
    }
    if (value.type === 'lorebook') {
        const book = text(value.book, 300).trim();
        if (!book) fail('This lorebook change does not say which lorebook.');
        if (value.action === 'add') {
            const content = text(value.content);
            if (!content.trim()) fail('This new lorebook entry has no content.');
            return {
                type: 'lorebook', action: 'add', book, reason,
                title: text(value.title, 300).trim(),
                keys: stringList(value.keys),
                content,
                constant: value.constant === true,
            };
        }
        if (value.action === 'edit' || value.action === 'delete') {
            const uid = messageNumber(value.uid);
            if (uid === null) fail('This lorebook change does not say which entry.');
            if (value.action === 'delete') return { type: 'lorebook', action: 'delete', book, uid, reason };
            const change = { type: 'lorebook', action: 'edit', book, uid, reason };
            if (typeof value.title === 'string') change.title = text(value.title, 300).trim();
            if (value.keys !== undefined) change.keys = stringList(value.keys);
            if (typeof value.content === 'string') change.content = text(value.content);
            if (typeof value.constant === 'boolean') change.constant = value.constant;
            if (!['title', 'keys', 'content', 'constant'].some(key => key in change)) fail('This lorebook edit does not change anything.');
            return change;
        }
        fail('This lorebook change has an unknown action.');
    }
    if (value.type === 'persona' || value.type === 'persona-note') {
        if (value.action === 'create') {
            const note = value.type === 'persona-note';
            if (note && (typeof value.persona !== 'string' || !value.persona.trim() || value.persona.length > 200)) fail('A new Scenario Note needs the shared persona name.');
            try {
                return { type: value.type, action: 'create', ...personaDraft(value, { note }),
                    ...(note ? { persona: value.persona.trim() } : {}), reason };
            } catch (error) { fail(error.message); }
        }
        if (!['replace', 'edit', undefined].includes(value.action) || typeof value.persona !== 'string' || !value.persona.trim() || value.persona.length > 200) fail('This persona change needs the shared persona name and a replace action.');
        try {
            if (value.type === 'persona' && value.field === 'avatar') fail('Use a generated persona avatar suggestion to replace the portrait.');
            if (value.type === 'persona-note' && (!['name', 'description', 'avatar'].includes(value.field) || typeof value.noteId !== 'string' || !value.noteId.trim() || value.noteId.length > 200)) fail('This Scenario Note change needs an existing note ID and a supported field.');
            if (value.field === 'avatar' && value.value !== '') fail('Generate a Scenario Note avatar to replace it, or use an empty value to remove it.');
            return { type: value.type, persona: value.persona.trim(), field: value.field, value: personaFieldValue(value.field, value.value), reason,
                ...(value.type === 'persona-note' ? { noteId: value.noteId } : {}) };
        } catch (error) { fail(error.message); }
    }
    if (value.type === 'character') {
        if (value.action === 'create') {
            try {
                return { type: 'character', action: 'create', ...normaliseCharacterDraft(value), reason };
            } catch (error) { fail(error.message); }
        }
        const character = text(value.character, 200).trim();
        const field = characterFieldName(String(value.field ?? ''));
        if (!character) fail('This character change does not say which character.');
        const append = value.action === 'append' || value.action === 'add';
        if (append && field !== 'alternate_greetings') fail('Scratchpad can only append alternate greetings.');
        if (!append && ![undefined, 'replace', 'edit'].includes(value.action)) fail('This character change has an unknown action.');
        if (Object.hasOwn(TEXT_FIELDS, field)) {
            if (typeof value.value !== 'string') fail('This character change has no new text.');
            return { type: 'character', character, field, value: parseField(field, text(value.value)), reason };
        }
        if (Object.hasOwn(LIST_FIELDS, field)) {
            const list = Array.isArray(value.value)
                ? value.value.map(item => String(item ?? '')).filter(item => item.trim())
                : field === 'tags' ? stringList(value.value) : String(value.value ?? '').split(/\n\s*---\s*\n/).filter(item => item.trim());
            if (append && !list.length) fail('This addition has no new greetings.');
            return { type: 'character', character, field, value: list.slice(0, 200), reason, ...(append ? { action: 'append' } : {}) };
        }
        if (characterField(field)) {
            return { type: 'character', character, field, value: validateScalar(field, value.value), reason };
        }
        fail('Scratchpad cannot change that character field.');
    }
    if (value.type === 'agent') {
        if (![undefined, 'replace', 'edit'].includes(value.action)) fail('Scratchpad can only replace an Agent\'s name, description or prompt.');
        if (typeof value.agent !== 'string' || !value.agent.trim() || value.agent.length > 200) fail('This Agent change needs the exact ID of a shared Agent.');
        if (!AGENT_FIELDS.includes(value.field)) fail('Scratchpad can only change an Agent\'s name, description or prompt.');
        if (typeof value.value !== 'string') fail('This Agent change has no new text.');
        const next = value.field === 'name' ? text(value.value, 200).replace(/\s+/g, ' ').trim() : text(value.value);
        if (value.field === 'name' && !next) fail('An Agent needs a name.');
        return { type: 'agent', action: 'replace', agent: value.agent.trim(), field: value.field, value: next, reason,
            ...(typeof value.name === 'string' && value.name.trim() ? { name: text(value.name, 200).replace(/\s+/g, ' ').trim() } : {}) };
    }
    if (value.type === 'chat') {
        if (value.action === 'insert') {
            const after = messageNumber(value.after);
            if (after === null) fail('This new message does not say where it goes.');
            const body = text(value.text);
            if (!body.trim()) fail('This new message has no text.');
            const speaker = value.speaker === 'user' ? 'user' : 'character';
            return { type: 'chat', action: 'insert', after, speaker, name: text(value.name, 200).trim(), text: body, reason };
        }
        if (['edit', 'hide', 'unhide', 'delete'].includes(value.action)) {
            const message = messageNumber(value.message);
            if (message === null) fail('This chat change does not say which message.');
            if (value.action === 'edit') {
                const body = text(value.text);
                if (!body.trim()) fail('This message rewrite has no text.');
                return { type: 'chat', action: 'edit', message, text: body, reason };
            }
            return { type: 'chat', action: value.action, message, reason };
        }
        fail('This chat change has an unknown action.');
    }
    fail('This change has an unknown type.');
}

/**
 * Splits a finished reply into plain text and proposed changes, in order.
 */
export function splitReply(reply) {
    const source = String(reply ?? '');
    const parts = [];
    let last = 0;
    let index = 0;
    for (const match of source.matchAll(FENCE_PATTERN)) {
        if (match.index > last) parts.push({ type: 'text', text: source.slice(last, match.index) });
        last = match.index + match[0].length;
        if (index >= MAX_CHANGES) continue;
        const raw = match[1].trim();
        let change = null;
        let error = '';
        try {
            change = normaliseChange(JSON.parse(raw));
        } catch (caught) {
            error = caught instanceof ScratchpadChangeError ? caught.message : 'This change could not be read.';
        }
        parts.push({ type: 'change', index, change, error, raw });
        index += 1;
    }
    if (last < source.length) parts.push({ type: 'text', text: source.slice(last) });
    return parts;
}

export function describeChange(change) {
    if (change.type === 'preset') {
        const field = change.module ? `${change.module} / ${change.field}` : change.field;
        return `Edit preset '${change.preset}': ${field}`;
    }
    if (change.type === 'persona' && change.action === 'create') return `Create persona '${change.name}'`;
    if (change.type === 'persona-note' && change.action === 'create') return `Create Scenario Note '${change.name}' for ${change.persona}`;
    if (change.type === 'creator') return `Catelier draft: ${change.name}`;
    if (change.type === 'image') return change.target === 'persona-note-avatar' ? `New Scenario Note avatar for ${change.persona}` : change.target === 'persona-avatar' ? `New persona avatar for ${change.persona}` : change.target === 'avatar' ? `New avatar for ${change.character}` : 'Generate an image';
    if (change.type === 'persona') return `Change ${change.persona}'s persona ${PERSONA_FIELDS[change.field].toLowerCase()}`;
    if (change.type === 'persona-note') return `Change ${change.persona}'s Scenario Note ${PERSONA_FIELDS[change.field].toLowerCase()}`;
    if (change.type === 'notebook') {
        const label = Object.values(NOTE_TOOL_DEFINITIONS).find(item => item.kind === change.action)?.displayName || 'Change note';
        return `${label}${change.args.title ? ` '${change.args.title}'` : ''}`;
    }
    if (change.type === 'lorebook') {
        if (change.action === 'add') return `New lorebook entry${change.title ? ` '${change.title}'` : ''} in ${change.book}`;
        if (change.action === 'edit') return `Edit lorebook entry ${change.uid} in ${change.book}`;
        return `Delete lorebook entry ${change.uid} from ${change.book}`;
    }
    if (change.type === 'character') {
        if (change.action === 'create') return `Create character '${change.character.name}'`;
        if (change.action === 'append') return `Add alternate greetings to ${change.character}`;
        const label = characterField(change.field)?.label;
        return `Change ${change.character}'s ${label}`;
    }
    if (change.type === 'agent') return `Change Agent '${change.name || change.agent}': ${change.field}`;
    switch (change.action) {
        case 'edit': return `Rewrite message #${change.message}`;
        case 'insert': return `Add a message after #${change.after}`;
        case 'hide': return `Hide message #${change.message}`;
        case 'unhide': return `Show message #${change.message} again`;
        default: return `Delete message #${change.message}`;
    }
}

export function formatEntry(entry) {
    return [
        `Title: ${entry.title}`,
        `Keys: ${entry.keys.join(', ')}`,
        `Always active: ${entry.constant ? 'yes' : 'no'}`,
        '',
        entry.content,
    ].join('\n');
}

export function parseEntry(value, fallback) {
    const match = /^Title:([^\n]*)\nKeys:([^\n]*)\nAlways active:([^\n]*)\n\n?([\s\S]*)$/.exec(String(value ?? '').replace(/\r\n/g, '\n'));
    if (!match) return { ...fallback, content: String(value ?? '') };
    return {
        title: match[1].trim(),
        keys: stringList(match[2]),
        constant: /^\s*(yes|true|on)\s*$/i.test(match[3]),
        content: match[4],
    };
}

export function formatField(field, value) {
    field = characterFieldName(field);
    if (field === 'tags') return value.join(', ');
    if (characterField(field)?.type === 'greetings') return value.join(GREETING_SEPARATOR);
    return String(value);
}

export function parseField(field, edited) {
    field = characterFieldName(field);
    if (field === 'tags') return stringList(edited);
    if (characterField(field)?.type === 'greetings') return String(edited ?? '').split(/\n\s*---\s*\n/).map(item => item.trim()).filter(Boolean);
    if (field === 'name' && !String(edited ?? '').trim()) fail('The character name cannot be empty.');
    const type = characterField(field)?.type;
    if (type === 'number') {
        const text = String(edited ?? '').trim();
        return validateScalar(field, text ? Number(text) : NaN);
    }
    if (type === 'boolean') {
        const text = String(edited ?? '').trim();
        return validateScalar(field, text === 'true' ? true : text === 'false' ? false : text);
    }
    if (type === 'role') return validateScalar(field, String(edited ?? '').trim());
    return String(edited ?? '');
}

function validateScalar(field, value) {
    const definition = characterField(field);
    if (definition.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)
        || value < definition.min || value > definition.max || definition.integer && !Number.isInteger(value))) {
        fail(`Use ${definition.integer ? 'a whole number' : 'a number'} from ${definition.min} to ${definition.max} for ${definition.label}.`);
    }
    if (definition.type === 'boolean' && typeof value !== 'boolean') fail('Use true or false for favourite status.');
    if (definition.type === 'role' && !['system', 'user', 'assistant'].includes(value)) fail('Use system, user or assistant for the character\'s note role.');
    return value;
}
import { normaliseScratchpadCreator } from '../creator/scratchpad-draft.js';
