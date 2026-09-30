import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import '../src/fetch-patch.js';
import { Jimp } from '../src/jimp.js';
import { read as readCharacterCard } from '../src/character-card-parser.js';
import { createPersonaCard, decodePersonaCard, decodePersonaImport, encodePersonaCard, normalizePersonaCard } from '../src/persona-card.js';

const image = fs.readFileSync(new URL('../public/img/user-default.png', import.meta.url));
const descriptor = {
    description: 'A traveller.\n{{user}} remembers everything. 猫',
    title: 'Night traveller',
    position: 4, depth: 7, role: 2,
    lorebook: 'The places I know',
    appendices: [{ id: 'arrival', name: 'Arrival', description: 'It is raining.' }],
    activeAppendices: { 'private-chat': ['arrival'] },
    connections: [{ type: 'character', id: 'private-character' }],
    default_persona: 'private-avatar.png',
};

describe('portable persona cards', () => {
    for (const format of ['png', 'json']) {
        test(`${format} keeps the image and portable fields, without account or chat state`, async () => {
            const card = createPersonaCard('Rin 🐈', descriptor);
            const output = encodePersonaCard(card, image, format);
            const decoded = decodePersonaCard(output, format);
            expect(decoded.card).toEqual(card);
            expect(decoded.card.data).toEqual({
                name: 'Rin 🐈', description: descriptor.description, title: descriptor.title,
                position: 4, depth: 7, role: 2, lorebook: descriptor.lorebook,
                appendices: descriptor.appendices,
            });
            const original = await Jimp.read(image);
            const imported = await Jimp.read(decoded.image);
            expect(imported.bitmap.width).toBe(original.bitmap.width);
            expect(imported.bitmap.height).toBe(original.bitmap.height);
            expect(imported.bitmap.data.equals(original.bitmap.data)).toBe(true);
            expect(output.toString()).not.toContain('private-chat');
        });
    }

    test('PNG exposes standard character fields alongside the complete persona', () => {
        const card = createPersonaCard('Rin 🐈', descriptor);
        const character = JSON.parse(readCharacterCard(encodePersonaCard(card, image, 'png')));
        expect(character.data.name).toBe('Rin 🐈');
        expect(character.data.description).toBe(descriptor.description);
        expect(character.data.extensions.neconyan_persona).toEqual(card);
    });

    test('fills optional defaults and repairs repeated note identifiers', () => {
        const card = createPersonaCard('Rin', {
            appendices: [{ id: 'same' }, { id: 'same' }, {}],
        });
        expect(card.data.position).toBe(0);
        expect(card.data.depth).toBe(2);
        expect(card.data.role).toBe(0);
        expect(new Set(card.data.appendices.map(note => note.id)).size).toBe(3);
    });

    for (const [index, card] of [
        { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Rin' } },
        { spec: 'neconyan_persona', spec_version: '2.0', data: { name: 'Rin' } },
        { spec: 'neconyan_persona', spec_version: '1.0', data: { name: '' } },
        { spec: 'neconyan_persona', spec_version: '1.0', data: { name: 'Rin', depth: -1 } },
        { spec: 'neconyan_persona', spec_version: '1.0', data: { name: 'Rin', role: 99 } },
        { spec: 'neconyan_persona', spec_version: '1.0', data: { name: 'Rin', appendices: [null] } },
    ].entries()) {
        test(`rejects malformed or unsupported metadata ${index}`, () => {
            expect(() => normalizePersonaCard(card)).toThrow();
        });
    }

    test('rejects ordinary images and JSON without an embedded avatar', () => {
        expect(() => decodePersonaCard(image, 'png')).toThrow();
        expect(() => decodePersonaCard(Buffer.from(JSON.stringify(createPersonaCard('Rin', {}))), 'json')).toThrow();
        expect(() => decodePersonaCard(Buffer.from('{'), 'json')).toThrow();
    });

    test('imports a SillyBunny library with portable descriptions and no account bindings', () => {
        const backup = {
            personas: { 'rin.png': 'Rin 🐈', 'new.png': 'New persona' },
            persona_descriptions: { 'rin.png': descriptor },
            default_persona: 'rin.png',
        };
        const imported = decodePersonaImport(Buffer.from('\uFEFF' + JSON.stringify(backup)), 'json');
        expect(imported.backup).toBe(true);
        expect(imported.cards).toEqual([
            { card: createPersonaCard('Rin 🐈', descriptor), image: null },
            { card: createPersonaCard('New persona', {}), image: null },
        ]);
        expect(JSON.stringify(imported)).not.toContain('private-chat');
        expect(JSON.stringify(imported)).not.toContain('private-character');
    });

    test.each([
        { personas: [], persona_descriptions: {} },
        { personas: {}, persona_descriptions: {} },
        { personas: { '../settings.json': 'Rin' }, persona_descriptions: {} },
        { personas: { 'rin.png': 12 }, persona_descriptions: {} },
        { personas: { 'rin.png': 'Rin' }, persona_descriptions: { 'rin.png': [] } },
        JSON.parse('{"personas":{"__proto__":"Rin"},"persona_descriptions":{}}'),
    ])('rejects malformed persona libraries before importing any entries: %j', backup => {
        expect(() => decodePersonaImport(Buffer.from(JSON.stringify(backup)), 'json')).toThrow();
    });

    test('rejects damaged UTF-8 rather than silently changing persona text', () => {
        const bytes = Buffer.concat([Buffer.from('{"personas":{"rin.png":"'), Buffer.from([0xff]), Buffer.from('"},"persona_descriptions":{}}')]);
        expect(() => decodePersonaImport(bytes, 'json')).toThrow();
    });
});
