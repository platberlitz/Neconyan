import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const css = read('public/css/neconyan.css');
const theme = read('public/css/neconyan-theme.css');
const chatStyles = read('public/css/neconyan-chat-styles.css');
const win98 = read('public/css/shell-styles/windows-98.css');
const indexHtml = read('public/index.html');
const ruleIn = (source, selector) => source.slice(source.indexOf(selector)).split('}')[0];
const rule = selector => ruleIn(css, selector);
const stats = 'body.neconyan #chat .mes .mesAvatarWrapper > .mes_stats';

describe('Message statistics share one box under the avatar', () => {
    test('The message template groups the number, timer and token count in .mes_stats', () => {
        expect(indexHtml).toMatch(/<div class="mes_stats">\s*<div class="mesIDDisplay"><\/div>\s*<div class="mes_timer"><\/div>\s*<div class="tokenCounterDisplay"><\/div>\s*<\/div>/);
    });

    test('The box is a squircle on the theme surface and hides when nothing inside is visible', () => {
        const box = rule(`${stats} {`);
        expect(box).toContain('flex-direction: column;');
        expect(box).toContain('border: 1px solid var(--neco-border);');
        expect(box).toContain('border-radius: var(--neconyan-control-radius, 10px);');
        expect(box).toContain('background: var(--neco-surface);');
        expect(box).toContain('font-variant-numeric: tabular-nums;');
        expect(box).not.toMatch(/font-weight: 700|!important/);
        expect(css).toMatch(/@supports \(corner-shape: squircle\) \{\s*body\.neconyan #chat \.mes \.mesAvatarWrapper > \.mes_stats \{[^}]*corner-shape: squircle;/);
        const empty = rule(`${stats}:not(:has(`);
        expect(empty).toContain('body:not(.no-mesIDDisplay) .mesIDDisplay, body:not(.no-timer) .mes_timer, body:not(.no-tokenCount) .tokenCounterDisplay, .reasoning-tokens-badge, .agent-transform-badge):not(:empty)))');
        expect(empty).toContain('display: none;');
    });

    test('Statistics inside the box are plain text rows, not separate boxes', () => {
        const row = rule('body.neconyan #chat .mes[mesid] .mesAvatarWrapper > .mes_stats > :is(.mesIDDisplay, .mes_timer, .tokenCounterDisplay, .reasoning-tokens-badge) {');
        expect(row).toContain('border: 0;');
        expect(row).toContain('background: none;');
        expect(row).toContain('opacity: 1;');
        expect(row).toContain('transform: none;');
        expect(rule('body.neconyan #chat .mes[mesid] .mesAvatarWrapper > .mes_stats > .mesIDDisplay {')).toContain('color: var(--neco-ink);');
        expect(theme).toContain('#chat .mes .mesAvatarWrapper .mes_stats > :is(.mes_timer, .tokenCounterDisplay):empty {');
        expect(chatStyles).toContain('#chat .mes .mesAvatarWrapper .mes_stats > :is(.mesIDDisplay, .mes_timer, .tokenCounterDisplay) {');
        expect(`${theme}\n${chatStyles}`).not.toMatch(/\.mesAvatarWrapper > :is\(\.mesIDDisplay|\.mesAvatarWrapper > \.mesIDDisplay/);
    });

    test('The agent document is the bottom row of the box with a 44px tap area and focus outline', () => {
        const selector = `${stats} > .agent-transform-badge`;
        const button = rule(`${selector} {`);
        expect(button).toContain('width: 100%;');
        expect(button).toContain('height: calc(var(--mainFontSize) * 1.5);');
        expect(button).toContain('border-top: 1px solid var(--neco-border);');
        expect(button).toContain('border-radius: 0 !important;');
        expect(button).toContain('position: relative;');
        const hitArea = rule(`${selector}::after {`);
        expect(hitArea).toContain('width: max(100%, 44px);');
        expect(hitArea).toContain('height: 44px;');
        expect(rule(`${selector}:focus-visible {`)).toContain('outline: 2px solid var(--neco-ginger);');
    });

    test('Windows 98 draws the box as a raised panel with a push button', () => {
        const prefix = ":root[data-sb-theme='windows-98'] body.neconyan:not(.sbterm) #chat .mes .mesAvatarWrapper > .mes_stats";
        const box = ruleIn(win98, `${prefix} {`);
        expect(box).toContain('border-radius: 0;');
        expect(box).toContain('box-shadow: var(--w98-raised);');
        expect(box).toContain('background: var(--w98-face);');
        expect(ruleIn(win98, `${prefix} > .agent-transform-badge {`)).toContain('box-shadow: var(--w98-raised);');
        expect(ruleIn(win98, `${prefix} > .agent-transform-badge:active {`)).toContain('box-shadow: var(--w98-sunken);');
    });
});
