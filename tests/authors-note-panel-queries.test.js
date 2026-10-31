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

// These run on every keystroke in a note (updateSettings -> loadSettings -> renderNoteSlot,
// renderNoteTargetsAndSummary and setNoteSlotDisabled), so a document-wide attribute selector
// makes typing slower as a chat grows.
const PER_KEYSTROKE_FUNCTIONS = [
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

    test('typing still re-renders through loadSettings', () => {
        const updateSettings = getFunctionSource(notesSource, 'updateSettings');
        expect(updateSettings).toContain('loadSettings()');
    });

    test.each(PER_KEYSTROKE_FUNCTIONS)('%s does not scan the whole document with attribute selectors', (name) => {
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

    test('wires direct Persona Author\'s Note entry points in Persona Management and the Persona Picker', () => {
        expect(indexSource).toContain('id="persona_author_note_button"');
        expect(indexSource).toContain('id="persona_author_note_open_button"');
        expect(indexSource).toContain('id="persona_author_note_status"');
        expect(notesSource).toContain('openAuthorsNotePanel(\'persona\')');
        expect(tabsSource).toContain('id: \'sb-persona-picker-authors-note-button\'');
        expect(scriptSource).toContain('\'#floatingPrompt\'');
    });
});
