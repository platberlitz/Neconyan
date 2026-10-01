import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');

const indexHtml = read('index.html');
const backgroundsJs = read('scripts/backgrounds.js');
const neconyanCss = read('css/neconyan.css');
const calicoCss = read('css/neconyan-calico.css');
const tabsCss = read('css/neconyan-tabs.css');
const mobileShellCss = read('css/neconyan-mobile-shell.css');

const CAT_WALLPAPER_STYLES = ['windows-aero', 'cozy-warm', 'hypr-glow', 'macos-minimal', 'slate-flat', 'clean-minimal'];

function ruleBody(css, selectorPattern) {
    const match = css.match(new RegExp(`${selectorPattern}\\s*\\{([^}]+)\\}`));
    expect(match).not.toBeNull();
    return match[1];
}

describe('avatar cat ears', () => {
    test('roleplay and Conversation avatar frames let the ears overflow the theme clip', () => {
        const frame = ruleBody(calicoCss, 'body\\.neconyan\\.flatchat:not\\(\\.sbterm\\) #chat \\.mes \\.avatar,\\s*body\\.neconyan:not\\(\\.sbterm\\) \\.sb-conversation-message-avatar');
        expect(frame).toContain('overflow: visible !important;');
    });

    test('the picture keeps its rounded corners without relying on overflow clipping', () => {
        expect(calicoCss).toMatch(/body\.neconyan\.flatchat:not\(\.sbterm\) #chat \.mes \.avatar > img,\s*body\.neconyan:not\(\.sbterm\) \.sb-conversation-message-avatar img \{ border-radius: 14px; \}/);
    });
});

describe('Conversation avatar alignment', () => {
    test('avatars sit level with the middle of their bubble', () => {
        expect(ruleBody(neconyanCss, 'body\\.neconyan #sheld \\.sb-conversation-message\\[data-message-id\\]')).toContain('align-items: center;');
    });

    test('the sleeping-cat space above a bubble is matched on the avatar', () => {
        const avatar = ruleBody(neconyanCss, '\\.sb-conversation-message:has\\(> \\.sb-conversation-message-bubble > \\.neconyan-message-sleeper\\) > \\.sb-conversation-message-avatar');
        expect(avatar).toContain('margin-top: var(--neconyan-sleeper-space, 44px);');
    });
});

describe('touch-friendly bottom chat bar', () => {
    const sizes = css => [...css.matchAll(/--sb-bottom-chat-mobile-button-size: clamp\((\d+)px, calc\((\d+)px \* var\(--sb-bottom-bar-scale\)\), (\d+)px\);/g)]
        .map(([, min, base, max]) => ({ min: Number(min), base: Number(base), max: Number(max) }));

    test('buttons start at a touch-sized 40px and still follow the Bottom Bar Size setting', () => {
        const all = [...sizes(tabsCss), ...sizes(mobileShellCss)];
        expect(all.length).toBeGreaterThanOrEqual(3);
        for (const { min, base, max } of all) {
            expect(base).toBeGreaterThanOrEqual(40);
            expect(min).toBeLessThan(base * 0.8);
            expect(max).toBeGreaterThanOrEqual(base * 1.2);
        }
    });

    test('icons grow with the button and an overflowing secondary row can scroll back to its first icon', () => {
        expect(tabsCss).toContain('font-size: calc(var(--sb-bottom-chat-mobile-button-size) * 0.42);');
        expect(tabsCss).toMatch(/\n {4}\.sb-bottom-chat-management-actions \{\s*width: max-content;\s*margin-inline: auto;\s*\}/);
    });
});

describe('Background Position', () => {
    test('the Backgrounds drawer offers a position picker beside fitting', () => {
        const header = indexHtml.slice(indexHtml.indexOf('id="background_fitting"'), indexHtml.indexOf('id="auto_background"'));
        expect(header).toContain('<select id="background_position"');
        for (const value of ['auto', 'center', 'left', 'right', 'top', 'bottom']) {
            expect(header).toContain(`<option value="${value}"`);
        }
    });

    test('the chosen position is saved and published as a root attribute and variable', () => {
        expect(backgroundsJs).toContain('export function setBackgroundPosition(position)');
        expect(backgroundsJs).toMatch(/position: 'auto'/);
        expect(backgroundsJs).toContain('root.dataset.sbBgPosition');
        expect(backgroundsJs).toContain("'--sb-bg-position'");
        expect(backgroundsJs).toContain("$('#background_position').on('input'");
    });

    test('a chosen position moves both uploaded backgrounds and the built-in wallpaper', () => {
        expect(neconyanCss).toMatch(/:root\[data-sb-bg-position\] #bg1,\s*:root\[data-sb-bg-position\] body\.neconyan::before \{ background-position: var\(--sb-bg-position\) !important; \}/);
    });

    test.each(CAT_WALLPAPER_STYLES)('%s keeps its sleeping cat in view on narrow screens by default', style => {
        const css = read(`css/shell-styles/${style}.css`);
        expect(css).toContain('--neconyan-wallpaper-focus: 100% 50%;');
        expect(calicoCss).toContain('var(--neconyan-wallpaper-focus, 50% 50%) / cover');
    });
});
