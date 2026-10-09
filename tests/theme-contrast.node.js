import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { accessibleTheme, contrastRatio } from '../public/scripts/theme-contrast.js';

test('AMOLED Black is bundled, opaque black and stable through theme conversion', () => {
    const source = JSON.parse(readFileSync(new URL('../default/content/themes/AMOLED Black.json', import.meta.url), 'utf8'));
    const index = JSON.parse(readFileSync(new URL('../default/content/index.json', import.meta.url), 'utf8'));
    assert.ok(index.some(entry => entry.filename === 'themes/AMOLED Black.json' && entry.type === 'theme'));
    const theme = accessibleTheme(source);
    for (const key of ['blur_tint_color', 'chat_tint_color', 'user_mes_blur_tint_color', 'bot_mes_blur_tint_color']) {
        assert.equal(source[key], 'rgba(0, 0, 0, 1)');
        assert.equal(theme[key], 'rgb(0, 0, 0)');
    }
    assert.equal(theme.custom_css, source.custom_css, 'the portable JSON and converted theme must apply the same CSS');
    assert.equal(theme.blur_strength, 0);
    assert.equal(theme.shadow_width, 0);
    assert.deepEqual(accessibleTheme(theme), theme);
    assert.equal(accessibleTheme({ ...source, name: 'My black theme' }).chat_tint_color, 'rgb(0, 0, 0)');
});

test('dark XP Olive is bundled with readable olive surfaces before and after conversion', () => {
    const source = JSON.parse(readFileSync(new URL('../default/content/themes/Windows XP Olive Green Dark.json', import.meta.url), 'utf8'));
    const index = JSON.parse(readFileSync(new URL('../default/content/index.json', import.meta.url), 'utf8'));
    assert.ok(index.some(entry => entry.filename === `themes/${source.name}.json` && entry.type === 'theme'));
    for (const theme of [source, accessibleTheme(source)]) {
        for (const key of ['blur_tint_color', 'chat_tint_color', 'user_mes_blur_tint_color', 'bot_mes_blur_tint_color']) {
            const [r, g, b] = theme[key].match(/[\d.]+/g).map(Number);
            assert.ok(g > r && r > b && g < 64, `${key} stays dark olive`);
            for (const text of ['main_text_color', 'italics_text_color', 'quote_text_color', 'underline_text_color']) {
                assert.ok(contrastRatio(theme[text], theme[key]) >= 4.5, `${text} on ${key}`);
            }
            assert.ok(contrastRatio(theme.border_color, theme[key]) >= 3);
        }
    }
});

test('near-black and translucent themes retain the normal accessible surface separation', () => {
    const source = JSON.parse(readFileSync(new URL('../default/content/themes/AMOLED Black.json', import.meta.url), 'utf8'));
    for (const blur_tint_color of ['rgba(1, 1, 1, 1)', 'rgba(0, 0, 0, 0.5)']) {
        const theme = accessibleTheme({ ...source, blur_tint_color });
        assert.notEqual(theme.chat_tint_color, theme.blur_tint_color);
        assert.ok(!theme.custom_css.includes('visibility: hidden'));
    }
});

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
