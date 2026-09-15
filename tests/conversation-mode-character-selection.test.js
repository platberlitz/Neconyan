import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptSource = readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8').replace(/\r\n/g, '\n');
const tabsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'neconyan-tabs.js'), 'utf8').replace(/\r\n/g, '\n');

describe('Conversation mode character selection', () => {
    test('opens the selected character card in Conversation mode', () => {
        expect(scriptSource).toContain('window.dispatchEvent(new CustomEvent(\'sb:roleplay-character-selected\'');
        expect(scriptSource).toContain('detail: { avatar: characters[this_chid]?.avatar || \'\' }');
        expect(tabsSource).toMatch(/import \{[^}]*\bcharacters\b[^}]*\bflushCharacterSaveDebounced\b[^}]*\} from '\.\.\/script\.js';/);
        expect(tabsSource).toMatch(/import \{[^}]*\bthis_chid\b[^}]*\} from '\.\.\/script\.js';/);
        expect(tabsSource).toContain('avatar: characters[this_chid]?.avatar || \'\',');
        expect(tabsSource).toContain('showToast: false,');
    });
});
