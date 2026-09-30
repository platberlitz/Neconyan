import { Buffer } from 'node:buffer';
import sanitize from 'sanitize-filename';
import { read as readCharacterCard, write as writeCharacterCard } from './character-card-parser.js';

const SPEC = 'neconyan_persona';
const VERSION = '1.0';
export const MAX_PERSONA_CARD_BYTES = 20 * 1024 * 1024;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, fallback = '') {
    if (value === undefined) return fallback;
    if (typeof value !== 'string') throw new Error('Invalid persona text.');
    return value;
}

function integer(value, fallback, allowed) {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || !allowed(value)) throw new Error('Invalid persona prompt settings.');
    return value;
}

/** Keep portable content only; chat selections and character connections belong to the account. */
export function normalizePersonaCard(card) {
    if (!isObject(card) || card.spec !== SPEC || card.spec_version !== VERSION || !isObject(card.data)) {
        throw new Error('Not a supported persona card.');
    }
    const data = card.data;
    const name = text(data.name).trim();
    if (!name) throw new Error('The persona needs a name.');
    if (data.appendices !== undefined && !Array.isArray(data.appendices)) throw new Error('Invalid scenario notes.');
    const ids = new Set();
    const appendices = (data.appendices ?? []).map((note, index) => {
        if (!isObject(note)) throw new Error('Invalid scenario note.');
        let id = text(note.id, `note-${index + 1}`);
        if (!id || ids.has(id)) id = `note-${index + 1}-${ids.size}`;
        while (ids.has(id)) id += '-copy';
        ids.add(id);
        return { id, name: text(note.name), description: text(note.description) };
    });
    return {
        spec: SPEC,
        spec_version: VERSION,
        data: {
            name,
            description: text(data.description),
            title: text(data.title),
            position: integer(data.position, 0, value => [0, 1, 2, 3, 4, 9].includes(value)),
            depth: integer(data.depth, 2, value => value >= 0 && value <= 9999),
            role: integer(data.role, 0, value => [0, 1, 2].includes(value)),
            lorebook: text(data.lorebook),
            appendices,
        },
    };
}

export function createPersonaCard(name, descriptor) {
    return normalizePersonaCard({ spec: SPEC, spec_version: VERSION, data: { ...descriptor, name } });
}

/** Use the existing PNG card format, with the complete persona in its extension field. */
export function encodePersonaCard(card, image, format) {
    const portable = normalizePersonaCard(card);
    if (format === 'json') {
        return Buffer.from(JSON.stringify({ ...portable, avatar: `data:image/png;base64,${image.toString('base64')}` }, null, 2));
    }
    if (format !== 'png') throw new Error('Unsupported persona card format.');
    return writeCharacterCard(image, JSON.stringify({
        data: {
            name: portable.data.name,
            description: portable.data.description,
            personality: '', scenario: '', first_mes: '', mes_example: '',
            creator_notes: '', system_prompt: '', post_history_instructions: '',
            alternate_greetings: [], tags: [], creator: '', character_version: '',
            extensions: { neconyan_persona: portable },
        },
    }));
}

export function decodePersonaCard(buffer, format) {
    if (buffer.length > MAX_PERSONA_CARD_BYTES) throw new Error('Persona card is too large.');
    if (format === 'png') {
        const metadata = JSON.parse(readCharacterCard(buffer));
        return { card: normalizePersonaCard(metadata?.data?.extensions?.neconyan_persona), image: buffer };
    }
    if (format !== 'json') throw new Error('Unsupported persona card format.');
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
    const card = normalizePersonaCard(data);
    if (typeof data.avatar !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(data.avatar)) {
        throw new Error('The persona card needs an embedded PNG avatar.');
    }
    return { card, image: Buffer.from(data.avatar.split(',')[1], 'base64') };
}

/** SillyTavern and SillyBunny persona backups contain a library, without image bytes. */
export function decodePersonaImport(buffer, format) {
    if (buffer.length > MAX_PERSONA_CARD_BYTES) throw new Error('Persona card is too large.');
    if (format === 'json') {
        const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
        if (isObject(data) && data.spec === undefined && Object.hasOwn(data, 'personas')) {
            if (!isObject(data.personas) || !isObject(data.persona_descriptions)) throw new Error('Invalid persona backup.');
            const names = Object.entries(data.personas);
            if (!names.length || names.length > 1000) throw new Error('A persona backup must contain between 1 and 1000 personas.');
            for (const key of new Set([...Object.keys(data.personas), ...Object.keys(data.persona_descriptions)])) {
                if (!key || key !== sanitize(key) || ['.', '..', '__proto__', 'constructor', 'prototype'].includes(key)) {
                    throw new Error('Invalid persona avatar filename.');
                }
                if (Object.hasOwn(data.persona_descriptions, key) && !isObject(data.persona_descriptions[key])) throw new Error('Invalid persona description.');
            }
            return { backup: true, cards: names.map(([key, name]) => ({
                card: createPersonaCard(name, data.persona_descriptions[key] ?? {}), image: null,
            })) };
        }
    }
    return { backup: false, cards: [decodePersonaCard(buffer, format)] };
}
