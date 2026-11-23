import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relative) {
    return readFileSync(path.join(repoRoot, relative), 'utf8');
}

// Editing markers live on the message element, so the reasoning and action rules no
// longer need :has() checks that were re-evaluated for every sent message.
describe('message editing state classes', () => {
    test('the message editor marks its message while it is open and clears it on every exit', () => {
        const source = read('public/script.js');
        expect(source).toContain('messageElement[0]?.classList.add(\'is_editing\');');
        expect(source).toContain('thisMesDiv.removeClass(\'is_editing\');');
        expect(source).toContain('$(div).closest(\'.mes\').removeClass(\'is_editing\');');
    });

    test('the reasoning editor marks its message while it is open and clears it on every exit', () => {
        const source = read('public/scripts/reasoning.js');
        expect(source).toContain('messageBlock.closest(\'.mes\').addClass(\'is_reasoning_editing\');');
        const clears = source.match(/messageBlock\.closest\('\.mes'\)\.removeClass\('is_reasoning_editing'\);/g) ?? [];
        expect(clears).toHaveLength(3);
    });

    test('the styles key off the classes instead of :has() for editing state', () => {
        const source = read('public/style.css');
        expect(source).toContain('.mes.is_reasoning_editing .mes_reasoning,');
        expect(source).toContain('.mes:not(.is_reasoning_editing) .mes_reasoning_actions .edit_button,');
        expect(source).toContain('.mes.is_editing.is_reasoning_editing .mes_reasoning_actions,');
        expect(source).toContain('.mes.smallSysMes:not(.is_editing) .ch_name {');
        expect(source).toContain('.mes:not(.is_editing) .mes_text.inline_media {');
        expect(source).not.toContain(':has(.reasoning_edit_textarea)');
        expect(source).not.toContain(':has(.edit_textarea)');
    });

    test('the drawer and welcome rules no longer search the whole page', () => {
        const shell = read('public/style.css');
        expect(shell).toContain('#top-settings-holder:has(.drawer-content.maximized):has(.drawer-content.openDrawer:not(.fillLeft):not(.fillRight)),');
        expect(shell).not.toContain('body:has(.drawer-content');
        const welcome = read('public/css/welcome.css');
        expect(welcome).not.toContain('mes:has(.welcomePanel)');
        expect(welcome).not.toContain('#chat:has(> .welcomePanel)');
    });
});
