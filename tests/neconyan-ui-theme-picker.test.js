import { describe, expect, test } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { deriveUiThemePreview } from '../public/scripts/neconyan-ui-theme-picker.js';
import { contrastRatio } from '../public/scripts/theme-contrast.js';

const directory = new URL('../default/content/themes/', import.meta.url);
const themes = readdirSync(directory).filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(new URL(name, directory), 'utf8')));

describe('automatic UI theme previews', () => {
    test('every bundled theme has a usable palette and tone', () => {
        expect(themes.length).toBeGreaterThan(180);
        for (const theme of themes) {
            const preview = deriveUiThemePreview(theme);
            for (const field of ['surface', 'chat', 'ink', 'accent', 'secondary']) {
                expect(preview[field]).toMatch(/^(?:rgba?\(|#[a-f\d]+)/i);
            }
            expect(['dark', 'light']).toContain(preview.tone);
        }
    });

    test.each([
        ['Neconyan Calico Dark', 'dark'], ['Neconyan Calico', 'light'], ['AMOLED Black', 'dark'],
    ])('%s has the expected tone', (name, tone) => {
        expect(deriveUiThemePreview(themes.find(theme => theme.name === name)).tone).toBe(tone);
    });

    test('AMOLED surfaces remain black', () => {
        const preview = deriveUiThemePreview(themes.find(theme => theme.name === 'AMOLED Black'));
        expect(preview.surface).toBe('rgb(0, 0, 0)');
        expect(preview.chat).toBe('rgb(0, 0, 0)');
    });

    test('arbitrary imported colours are resolved without mutating the theme', () => {
        const theme = Object.freeze({
            name: 'My imported palette', blur_tint_color: 'rgba(20, 40, 60, 0.2)',
            main_text_color: 'rgb(20, 30, 40)', quote_text_color: 'rgb(50, 60, 70)',
            underline_text_color: 'rgb(60, 70, 80)', border_color: 'rgb(50, 50, 50)',
        });
        const preview = deriveUiThemePreview(theme);
        expect(preview.surface).toBe('rgb(20, 25, 28)');
        expect(preview.tone).toBe('dark');
        expect(contrastRatio(preview.ink, preview.chat)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(preview.accent, preview.chat)).toBeGreaterThanOrEqual(4.5);
        const changed = deriveUiThemePreview({ ...theme, blur_tint_color: 'rgb(250, 245, 240)' });
        expect(changed.tone).toBe('light');
        expect(changed.surface).not.toBe(preview.surface);
    });
});
