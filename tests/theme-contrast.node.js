import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { accessibleTheme, contrastRatio } from '../public/scripts/theme-contrast.js';

test('every shipped theme except Calico Dark has AA text and control colour contrast after conversion', () => {
    const root = new URL('../default/content/themes/', import.meta.url);
    for (const file of readdirSync(root).filter(name => name.endsWith('.json'))) {
        const source = JSON.parse(readFileSync(new URL(file, root), 'utf8'));
        const theme = accessibleTheme(source);
        if (source.name === 'Neconyan Calico Dark') {
            assert.equal(theme, source);
            continue;
        }
        for (const background of ['blur_tint_color', 'chat_tint_color', 'user_mes_blur_tint_color', 'bot_mes_blur_tint_color']) {
            for (const foreground of ['main_text_color', 'italics_text_color', 'underline_text_color', 'quote_text_color', 'border_color']) {
                const minimum = foreground === 'border_color' ? 3 : 4.5;
                assert.ok(contrastRatio(theme[foreground], theme[background]) >= minimum, `${file}: ${foreground} on ${background}`);
            }
        }
        assert.deepEqual(accessibleTheme(theme), theme, `${file}: repeated loads must be stable`);
        assert.equal(source.custom_css, JSON.parse(readFileSync(new URL(file, root), 'utf8')).custom_css);
    }
});
