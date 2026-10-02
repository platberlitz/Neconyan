import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/css/neconyan.css', import.meta.url), 'utf8');

describe('Labelled message action layout', () => {
    test('removes icon aspect ratios when actions become labelled controls', () => {
        const sizing = css.match(/body\.neconyan #chat :is\(\.neconyan-message-action, \.extraMesButtons > \*\) \{([^}]+)\}/)[1];
        expect(sizing).toContain('aspect-ratio: auto;');
        expect(sizing).toContain('block-size: auto;');
    });

    test('left-aligns wrapped labels inside the expanded action menu', () => {
        const menu = css.match(/body\.neconyan #chat \.extraMesButtons > \* \{([^}]+)\}/)[1];
        expect(menu).toContain('justify-content: flex-start;');
        expect(menu).toContain('text-align: left;');
    });
});

describe('Agent change highlights', () => {
    const baseCss = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
    test('uses theme text on solid tinted surfaces instead of pale status text', () => {
        for (const type of ['ins', 'del']) {
            const rule = baseCss.match(new RegExp(`\\.ica-transform-diff-part--${type} \\{([^}]+)\\}`))[1];
            expect(rule).toContain('color: var(--sb-contrast-strong, var(--SmartThemeBodyColor));');
            expect(rule).toContain('12%, var(--neco-surface, var(--SmartThemeBlurTintColor))');
        }
    });

    test('restricts phone history scrolling to vertical movement without disabling text selection', () => {
        const mobileCss = readFileSync(new URL('../public/css/neconyan-mobile-shell.css', import.meta.url), 'utf8');
        const rule = mobileCss.match(/body\.neconyan \.ica-transform-history \.ica-transform-diff \{([^}]+)\}/)[1];
        expect(rule).toContain('overflow-x: hidden;');
        expect(rule).toContain('overscroll-behavior-x: none;');
        expect(rule).toContain('touch-action: pan-y;');
        expect(rule).not.toContain('user-select');
    });
});
