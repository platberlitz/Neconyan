import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const notesSource = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'authors-note.js'), 'utf8');
const tabsSource = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'neconyan-tabs.js'), 'utf8');
const scriptSource = fs.readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');

function getFunctionSource(source, name) {
    const match = source.match(new RegExp(`(?:export\\s+)?function ${name}\\([\\s\\S]*?\\n\\}`));
    expect(match).not.toBeNull();
    return match[0];
}

// Panel refreshes must stay independent of the number of elements in the chat.
const PANEL_FUNCTIONS = [
    'loadSettings',
    'renderNoteSlot',
    'renderNoteTargetsAndSummary',
    'setNoteSlotDisabled',
    'setNotePositionCommand',
];

describe('author\'s note panel queries', () => {
    test('the panel lookup is scoped to #floatingPrompt', () => {
        expect(notesSource).toMatch(/const findInNotePanel = selector => \$\('#floatingPrompt'\)\.find\(selector\);/);
        expect(indexSource).toMatch(/<div id="floatingPrompt"[^>]*>/);
    });

    test.each(PANEL_FUNCTIONS)('%s does not scan the whole document with attribute selectors', (name) => {
        const body = getFunctionSource(notesSource, name);
        const documentWideAttributeQueries = body.match(/(?<![\w.])\$\(`[^`]*\[[^`]*`\)/g) ?? [];
        expect(documentWideAttributeQueries).toEqual([]);
    });

    test('the scoped lookups cover the position radios and profile controls', () => {
        expect(getFunctionSource(notesSource, 'renderNoteSlot')).toContain('findInNotePanel(`input[name="${slot.radioName}"]');
        expect(getFunctionSource(notesSource, 'setNoteSlotDisabled')).toContain('findInNotePanel(`[data-an-profile-slot="${slotName}"]`)');
        const loadSettings = getFunctionSource(notesSource, 'loadSettings');
        expect(loadSettings).toContain('findInNotePanel(`input[name="extension_floating_position"]');
        expect(loadSettings).toContain('findInNotePanel(`input[name="extension_default_position"]');
    });

    test('renders tabbed sections and an active-notes summary inside #floatingPrompt', () => {
        for (const tab of ['chat', 'character', 'persona', 'defaults']) {
            expect(indexSource).toContain(`data-an-tab="${tab}"`);
            expect(indexSource).toContain(`data-an-panel="${tab}"`);
        }
        expect(indexSource).toContain('id="an_in_use"');
        expect(indexSource).toContain('css/neconyan-authors-note.css');
    });

    test('every Note text field has a full screen button wired to its textarea', () => {
        const noteFields = ['prompt', 'chara', 'persona', 'default'];
        for (const slot of noteFields) {
            const id = `extension_floating_${slot}`;
            expect(indexSource).toContain(`<label for="${id}" class="an-field-label" data-i18n="Note text">Note text</label>`);
            expect(indexSource).toContain(`<button type="button" class="menu_button menu_button_icon an-note-fullscreen editor_maximize" data-for="${id}" title="Open the note in full screen" aria-label="Full screen" data-i18n="[title]Open the note in full screen;[aria-label]Full screen">`);
        }
        expect(indexSource.match(/class="menu_button menu_button_icon an-note-fullscreen editor_maximize"/g)).toHaveLength(noteFields.length);
    });

    test('wires direct Persona Author\'s Note entry points in Persona Management and the Persona Picker', () => {
        expect(indexSource).toContain('id="persona_author_note_button"');
        expect(indexSource).toContain('id="persona_author_note_open_button"');
        expect(indexSource).toContain('id="persona_author_note_status"');
        expect(notesSource).toContain('openAuthorsNotePanel(\'persona\')');
        expect(tabsSource).toContain('id: \'sb-persona-picker-authors-note-button\'');
        expect(scriptSource).toContain('\'#floatingPrompt\'');
    });
});
