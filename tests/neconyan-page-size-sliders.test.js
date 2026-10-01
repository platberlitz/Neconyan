import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const read = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');

describe('Page Size & Clarity sliders reach the Neconyan chat', () => {
    const powerUser = read('public/scripts/power-user.js');
    const neconyanCss = read('public/css/neconyan.css');
    const calicoCss = read('public/css/neconyan-calico.css');
    const paperCss = read('public/css/neconyan-paper-theme.css');
    const mobileShellCss = read('public/css/neconyan-mobile-shell.css');

    test('Page Width publishes a scale the reading column uses', () => {
        expect(powerUser).toMatch(/function setChatWidthProperties\(\)/);
        expect(powerUser).toMatch(/--neconyanPageWidthScale/);
        expect(neconyanCss).toMatch(/--neco-reading-width: calc\(820px \* var\(--neconyanPageWidthScale, 1\)\)/);
        expect(neconyanCss).toMatch(/calc\(\(100% - var\(--neco-reading-width\)\) \/ 2\)/);
        expect(neconyanCss).not.toMatch(/100% - 820px/);
    });

    test('apply-on-release sliders also apply on change, so keyboard input works', () => {
        for (const id of ['chat_width_slider', 'font_scale', 'line_spacing', 'message_margin_size']) {
            expect(powerUser).toContain(`$('#${id}').off('change mouseup touchend').on('change mouseup touchend'`);
        }
    });

    test('Line Spacing drives the flat message line height', () => {
        expect(powerUser).toMatch(/setProperty\('--neconyanLineSpacing'/);
        expect(neconyanCss).toMatch(/--neco-line-height: calc\(1 \+ var\(--neconyanLineSpacing, 1\.2\) \* \.54\)/);
        expect(neconyanCss).toMatch(/line-height: var\(--neco-line-height\)/);
    });

    test('Margin Size scales gutters and bubble padding on desktop and phone', () => {
        expect(neconyanCss).toMatch(/--neco-gutter: calc\(24px \* var\(--messageMarginScale, 1\)\)/);
        expect(neconyanCss).toMatch(/--neco-bubble-pad: calc\(16px \* var\(--messageMarginScale, 1\)\)/);
        expect(calicoCss).toMatch(/padding: 12px var\(--neco-bubble-pad\)/);
        expect(paperCss).toMatch(/calc\(clamp\(6px, 1\.5vw, 16px\) \* var\(--messageMarginScale, 1\)\)/);
        expect(paperCss).toMatch(/padding: 2px calc\(4px \* var\(--messageMarginScale, 1\)\) !important/);
    });

    test('Page Width is hidden on phones, where the chat already fills the screen', () => {
        expect(mobileShellCss).toMatch(/\[name="FontBlurChatWidthBlock"\] > div:has\(> #chat_width_slider\) \{\s*display: none;/);
    });
});
