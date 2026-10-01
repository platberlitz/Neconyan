import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'public/css/neconyan.css'), 'utf8');
const theme = fs.readFileSync(path.join(root, 'public/css/neconyan-theme.css'), 'utf8');
const chatStyles = fs.readFileSync(path.join(root, 'public/css/neconyan-chat-styles.css'), 'utf8');
const rule = selector => css.slice(css.indexOf(selector)).split('}')[0];

describe('Message statistics remain readable over chat wallpaper', () => {
    test('Number, timing and token counts use the theme surface and ink at full opacity', () => {
        const selector = 'body.neconyan #chat .mes[mesid] .mesAvatarWrapper > :is(.mesIDDisplay, .mes_timer, .tokenCounterDisplay, .reasoning-tokens-badge)';
        expect(css).toContain(selector);
        const metadata = rule(selector);
        expect(metadata).toContain('background: var(--neco-surface);');
        expect(metadata).toContain('color: var(--neco-ink);');
        expect(metadata).toContain('opacity: 1;');
        expect(metadata).toContain('font-weight: 700;');
        expect(metadata).toContain('text-shadow: none;');
        expect(metadata).toContain('max-inline-size: max(100%, 44px);');
        expect(metadata).toContain('overflow-wrap: anywhere;');
        expect(metadata).not.toMatch(/display:|!important/);
        const legacy = theme.slice(theme.indexOf('#chat .mes .mesAvatarWrapper > .mesIDDisplay {')).split('}')[0];
        expect(legacy).not.toContain('background: transparent !important;');
        expect(chatStyles).not.toMatch(/\.mesIDDisplay\s*\{\s*background: var\(--customBgColor2\) !important;/);
    });

    test('The agent document remains a readable 44px button with a visible focus outline', () => {
        const selector = 'body.neconyan #chat .mes .mesAvatarWrapper > .agent-transform-badge';
        expect(css).toContain(`${selector} {`);
        const button = rule(`${selector} {`);
        for (const dimension of ['width', 'height', 'min-width', 'min-height']) {
            expect(button).toContain(`${dimension}: 44px;`);
        }
        expect(button).toContain('background: var(--neco-surface);');
        expect(button).toContain('color: var(--neco-ink);');
        expect(button).toContain('opacity: 1;');
        expect(rule(`${selector}:hover {`)).toContain('background: var(--neco-raised);');
        expect(rule(`${selector}:focus-visible {`)).toContain('outline: 2px solid var(--neco-ginger);');
        expect(button).not.toMatch(/display:|!important/);
    });
});
