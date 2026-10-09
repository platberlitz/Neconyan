/**
 * Reading proposed changes out of a Scratchpad reply. Nothing here touches the
 * app, so it can be tested on its own.
 */
import { NOTE_TOOL_DEFINITIONS, NOTE_MUTATING_KINDS } from '../notebooks/assistant-note-tools.js';
import { normaliseCharacterDraft } from '../neconyan-character-draft.js';

export const CHANGE_FENCE = 'scratchpad-change';
const FENCE_PATTERN = /```scratchpad-change[^\n]*\n([\s\S]*?)```/g;
const MAX_CHANGES = 24;

export const TEXT_FIELDS = Object.freeze({
    description: 'description',
    personality: 'personality',
    scenario: 'scenario',
    first_mes: 'first message',
    mes_example: 'example messages',
    creator_notes: 'creator\'s notes',
    system_prompt: 'system prompt',
    post_history_instructions: 'post-history instructions',
});
export const LIST_FIELDS = Object.freeze({
    alternate_greetings: 'alternate greetings',
    tags: 'tags',
});
export const TOP_LEVEL_FIELDS = Object.freeze({
    description: 'description',
    personality: 'personality',
    scenario: 'scenario',
    first_mes: 'first_mes',
    mes_example: 'mes_example',
    creator_notes: 'creatorcomment',
    tags: 'tags',
});
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
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('This change is not a JSON object.');
    const reason = text(value.reason, 1000).trim();
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
    if (value.type === 'character') {
        if (value.action === 'create') {
            try {
                return { type: 'character', action: 'create', ...normaliseCharacterDraft(value), reason };
            } catch (error) { fail(error.message); }
        }
        const character = text(value.character, 200).trim();
        const field = String(value.field ?? '');
        if (!character) fail('This character change does not say which character.');
        const append = value.action === 'append' || value.action === 'add';
        if (append && field !== 'alternate_greetings') fail('Scratchpad can only append alternate greetings.');
        if (!append && ![undefined, 'replace', 'edit'].includes(value.action)) fail('This character change has an unknown action.');
        if (Object.hasOwn(TEXT_FIELDS, field)) {
            if (typeof value.value !== 'string') fail('This character change has no new text.');
            return { type: 'character', character, field, value: text(value.value), reason };
        }
        if (Object.hasOwn(LIST_FIELDS, field)) {
            const list = Array.isArray(value.value)
                ? value.value.map(item => String(item ?? '')).filter(item => item.trim())
                : field === 'tags' ? stringList(value.value) : String(value.value ?? '').split(/\n\s*---\s*\n/).filter(item => item.trim());
            if (append && !list.length) fail('This addition has no new greetings.');
            return { type: 'character', character, field, value: list.slice(0, 200), reason, ...(append ? { action: 'append' } : {}) };
        }
        fail('Scratchpad cannot change that character field.');
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
        const label = TEXT_FIELDS[change.field] || LIST_FIELDS[change.field];
        return `Change ${change.character}'s ${label}`;
    }
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
    if (field === 'tags') return value.join(', ');
    if (field === 'alternate_greetings') return value.join(GREETING_SEPARATOR);
    return value;
}

export function parseField(field, edited) {
    if (field === 'tags') return stringList(edited);
    if (field === 'alternate_greetings') return String(edited ?? '').split(/\n\s*---\s*\n/).map(item => item.trim()).filter(Boolean);
    return String(edited ?? '');
}
