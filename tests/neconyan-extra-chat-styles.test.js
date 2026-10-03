import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from '@jest/globals';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const read = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');

const indexHtml = read('public/index.html');
const powerUserSource = read('public/scripts/power-user.js');
const chatStylesSource = read('public/css/neconyan-chat-styles.css');
const paperThemeSource = read('public/css/neconyan-paper-theme.css');
const deepSwipeSource = read('public/scripts/extensions/third-party/Neconyan-Deep-Swipe/style.css');

const EXTRA_STYLES = [
    { value: 8, key: 'MESSENGER', label: 'Messenger', className: 'nnchat-messenger' },
    { value: 9, key: 'NOTEBOOK', label: 'Notebook', className: 'nnchat-notebook' },
    { value: 10, key: 'SCREENPLAY', label: 'Screenplay', className: 'nnchat-script' },
    { value: 11, key: 'COMPACT', label: 'Compact', className: 'nnchat-compact' },
    { value: 12, key: 'STORYBOOK', label: 'Storybook', className: 'nnchat-storybook' },
];

describe('extra Neconyan chat styles', () => {
    it.each(EXTRA_STYLES)('offers $label in the Chat Style picker and maps it onto the flat layout', ({ value, key, label, className }) => {
        expect(indexHtml).toContain(`<option value="${value}" data-i18n="${label}">${label}</option>`);
        expect(powerUserSource).toContain(`${key}: ${value},`);
        expect(powerUserSource).toContain(`[chat_styles.${key}]: 'flatchat nnchat ${className}',`);
        expect(chatStylesSource).toContain(`.${className}:not(.sbterm) #chat`);
    });

    it('keeps the default flat message tint off the newer styles so they can draw their own blocks', () => {
        expect(chatStylesSource).toContain(':not(.tidestyle):not(.nnchat) #chat .mes:not(.smallSysMes) .mes_block');
        expect(chatStylesSource).toContain(':not(.tidestyle):not(.nnchat) #chat .mes[is_user="true"]:not(.smallSysMes) .mes_block');
    });

    it('stops the phone paper card from wrapping the newer styles without raising selector weight', () => {
        for (const selector of [
            ':where(body:not(.nnchat)) .mes {',
            ':where(body:not(.nnchat)) .mes[is_user=\'true\'] {',
            ':where(body:not(.nnchat)) .mes[is_user=\'false\'] {',
            ':where(body:not(.nnchat)) .mes::after {',
            ':where(body:not(.nnchat)) .mes .mes_block {',
            ':where(body:not(.nnchat)) .mes .mes_text {',
        ]) {
            expect(paperThemeSource).toContain(selector);
        }
    });

    it('keeps Messenger avatars at the top and swipe controls under the bubble', () => {
        expect(chatStylesSource).toMatch(/nnchat-messenger:not\(\.sbterm\) #chat \.mes \{\s*align-items: flex-start;/);
        expect(chatStylesSource).toContain(':is(.last_mes, :has(.deep-swipe-counter, .assistant-swipe-arrow))');
        expect(chatStylesSource).toMatch(/nnchat-messenger:not\(\.sbterm\) #chat \.mes\[is_user='true'\] \.swipeRightBlock \{\s*right: calc\(var\(--avatar-base-width\) \+ 10px\);/);
        expect(chatStylesSource).toMatch(/nnchat-messenger:not\(\.sbterm\) #chat \.mes:not\(\[is_user='true'\]\) :is\(\.swipe_left, \.deep-swipe-left-outer\) \{\s*left: calc\(var\(--avatar-base-width\) \+ 10px\);/);
    });

    it('gives Screenplay, Compact and Storybook real user message surfaces', () => {
        expect(chatStylesSource).toMatch(/nnchat-script[^}]+\.mes_block \{[^}]*border: 1px solid var\(--neco-border\);/);
        expect(chatStylesSource).toMatch(/nnchat-compact[^}]+\.mes_block \{[^}]*border: 1px solid var\(--neco-border\);/);
        expect(chatStylesSource).toMatch(/nnchat-storybook:not\(\.sbterm\) #chat \.mes:not\(\.smallSysMes\)\[is_user='true'\] \.mes_block \{[^}]*background: color-mix/);
    });

    it('positions the cats from the actual message block instead of estimated avatar offsets', () => {
        expect(chatStylesSource).toContain('top: var(--nnchat-sleeper-top, -41px)');
        expect(chatStylesSource).toContain('left: var(--nnchat-sleeper-left, 0px)');
        const source = read('public/scripts/neconyan-message-sleepers.js');
        expect(source).toContain('new ResizeObserver');
        expect(source).toContain('bubble.getBoundingClientRect()');
        expect(source).toContain('bubbleSizes.unobserve(bubble)');
        const placement = vm.runInNewContext(source.slice(source.indexOf('function sleeperPlacement('), source.indexOf('\nconst pending')) + '\nsleeperPlacement');
        const message = { top: 100, left: 20 };
        const bubble = { top: 112, left: 80, right: 400 };
        expect(placement(message, bubble, false)).toEqual({ top: -29, left: 43 });
        expect(placement(message, bubble, true)).toEqual({ top: -29, left: 301 });
    });

    it('keeps sleeping cats above the phone Ripple portrait without changing their placement', () => {
        const catRule = read('public/css/neconyan-calico.css').match(/body\.neconyan img\.neconyan-message-sleeper \{([^}]*)\}/);
        expect(catRule).not.toBeNull();
        expect(catRule[1]).toContain('z-index: 3;');
        expect(catRule[1]).toContain('top: -41px; left: -17px;');
        expect(catRule[1]).toContain('width: 96px; height: 77px;');
    });

    it('lets Deep Swipe keep message borders and shadows that chat styles rely on', () => {
        const idleRule = deepSwipeSource.match(/\.mes \.mes_text,\s*\.mes \.mes_block\s*\{([^}]*)\}/);
        expect(idleRule).not.toBeNull();
        expect(idleRule[1]).toContain('outline: none');
        expect(idleRule[1]).not.toMatch(/border:\s*none/);
        expect(idleRule[1]).not.toMatch(/box-shadow:\s*none/);
    });
});
