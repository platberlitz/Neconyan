import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    DEFAULT_NOTE_PROFILE_ID,
    captureScopedAuthorsNotes,
    composeAuthorsNote,
    findCharacterNoteEntry,
    getActiveNoteProfileId,
    getNoteProfiles,
    getPersonaNoteEntry,
    resolveNoteProfile,
} from '../public/scripts/authors-note-profiles.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const notesSource = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'authors-note.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');

const profiled = {
    name: 'individual:Nova',
    useChara: true,
    profiles: [
        { id: 'calm', name: 'Calm', prompt: 'Slow and quiet.', position: 1 },
        { id: 'chaos', name: 'Chaos', prompt: 'Everything explodes.', position: 2 },
    ],
    activeProfile: 'calm',
    perPersona: true,
    personaProfiles: { 'sam.png': 'chaos', 'gone.png': 'deleted-profile' },
};

describe('Author\'s Note profiles', () => {
    test('a note saved before profiles reads as one Default profile', () => {
        const legacy = { name: 'individual:Nova', prompt: 'Old note', position: 2, useChara: true };

        expect(getNoteProfiles(legacy)).toEqual([{ id: DEFAULT_NOTE_PROFILE_ID, name: 'Default', prompt: 'Old note', position: 2 }]);
        expect(getActiveNoteProfileId(legacy, 'sam.png')).toBe(DEFAULT_NOTE_PROFILE_ID);
        expect(getNoteProfiles(null)).toEqual([]);
        expect(getActiveNoteProfileId(null)).toBeNull();
    });

    test('the persona pick wins only while the note remembers profiles per persona', () => {
        expect(resolveNoteProfile(profiled, 'sam.png').id).toBe('chaos');
        expect(resolveNoteProfile(profiled, 'alex.png').id).toBe('calm');
        expect(resolveNoteProfile(profiled, 'gone.png').id).toBe('calm');
        expect(resolveNoteProfile({ ...profiled, perPersona: false }, 'sam.png').id).toBe('calm');
        expect(resolveNoteProfile({ ...profiled, activeProfile: 'missing' }, 'alex.png').id).toBe('calm');
        expect(resolveNoteProfile({ ...profiled, activeProfile: 'missing', profiles: [...profiled.profiles].reverse() }, 'alex.png').id).toBe('chaos');
    });

    test('finds the character note under the key the browser saves', () => {
        const chara = [{ name: 'Old', prompt: 'legacy' }, { name: 'individual:Nova', prompt: 'current' }];

        expect(findCharacterNoteEntry(chara, 'Nova.png').prompt).toBe('current');
        expect(findCharacterNoteEntry([{ name: 'Old', prompt: 'legacy' }], 'Old.png').prompt).toBe('legacy');
        expect(findCharacterNoteEntry([{ name: 'individual:Mira.png', prompt: 'full name' }], 'Mira.png').prompt).toBe('full name');
        expect(findCharacterNoteEntry(chara, 'Absent.png')).toBeNull();
        expect(findCharacterNoteEntry(undefined, 'Nova.png')).toBeNull();
    });

    test('persona notes are looked up by the persona avatar only', () => {
        const store = { 'sam.png': { useNote: true, prompt: 'Formal speech.', position: 1 } };

        expect(getPersonaNoteEntry(store, 'sam.png')).toBe(store['sam.png']);
        expect(getPersonaNoteEntry(store, 'toString')).toBeNull();
        expect(getPersonaNoteEntry(store, '')).toBeNull();
        expect(getPersonaNoteEntry([], 'sam.png')).toBeNull();
    });

    test('captures the profile in effect for the server', () => {
        const persona = {
            useNote: true,
            profiles: [{ id: 'p1', name: 'Formal', prompt: 'Formal speech.', position: 1 }],
            activeProfile: 'p1',
        };

        expect(captureScopedAuthorsNotes(profiled, persona, 'sam.png')).toEqual({
            scoped: { useChara: true, prompt: 'Everything explodes.', position: 2 },
            persona: { useNote: true, prompt: 'Formal speech.', position: 1 },
        });
        expect(captureScopedAuthorsNotes(null, null, 'sam.png')).toEqual({ scoped: null, persona: null });
    });
});

describe('combining Author\'s Notes', () => {
    const note = (prompt, position, enabled = true) => ({ enabled, prompt, position });

    test('without character or persona notes the chat note is used as is', () => {
        expect(composeAuthorsNote('Chat', [])).toBe('Chat');
        expect(composeAuthorsNote('Chat', [note('Char', 0, false), note('Persona', 0, false)])).toBe('Chat');
    });

    test('keeps the single character note behaviour', () => {
        expect(composeAuthorsNote('Chat', [note('Char', 0)])).toBe('Char');
        expect(composeAuthorsNote('Chat', [note('Char', 1)])).toBe('Char\nChat');
        expect(composeAuthorsNote('Chat', [note('Char', 2)])).toBe('Chat\nChar');
    });

    test('mixes character and persona notes around the chat note', () => {
        expect(composeAuthorsNote('Chat', [note('Char', 1), note('Persona', 1)])).toBe('Char\nPersona\nChat');
        expect(composeAuthorsNote('Chat', [note('Char', 2), note('Persona', 1)])).toBe('Persona\nChat\nChar');
        expect(composeAuthorsNote('Chat', [note('Char', 0), note('Persona', 2)])).toBe('Char\nPersona');
        expect(composeAuthorsNote('Chat', [note('Char', 0), note('Persona', 0)])).toBe('Char\nPersona');
        expect(composeAuthorsNote('', [note('', 1), note('Persona', 2)])).toBe('Persona');
    });
});

describe('Author\'s Note panel wiring', () => {
    test('both notes have a profile picker, actions and their own switches', () => {
        for (const slot of ['chara', 'persona']) {
            expect(indexHtml).toContain(`id="extension_floating_${slot}_profile"`);
            expect(indexHtml).toContain(`id="extension_floating_${slot}"`);
            expect(indexHtml).toContain(`id="extension_floating_${slot}_token_counter"`);
            for (const action of ['new', 'rename', 'delete']) {
                expect(indexHtml).toContain(`data-an-profile-slot="${slot}" data-an-profile-action="${action}"`);
            }
        }
        expect(indexHtml).toContain('id="extension_use_floating_persona"');
        expect(indexHtml).toContain('name="extension_floating_persona_position"');
        expect(indexHtml).toContain('id="extension_floating_chara_per_persona"');
    });

    test('the browser combines notes through the shared helper and follows persona changes', () => {
        expect(notesSource).toContain('composeAuthorsNote(prompt, [getNotePart(\'chara\', charaNote), getNotePart(\'persona\', getPersonaNote())])');
        expect(notesSource).toContain('eventSource.on(event_types.PERSONA_CHANGED, onChatChanged);');
        expect(notesSource).toContain('personaAuthorsNote');
    });
});
