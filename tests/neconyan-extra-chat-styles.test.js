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
const companionStyleSource = read('public/scripts/extensions/in-chat-agents/style.css');

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

    it('gives swipe controls their own footer row instead of covering the last lines of text', () => {
        expect(chatStylesSource).toContain('body:is(.echostyle, .whisperstyle, .hushstyle, .tidestyle) #chat .mes:not(.smallSysMes):is(.last_mes, :has(.deep-swipe-right, .deep-swipe-counter)),');
        expect(chatStylesSource).toContain('body.ripplestyle #chat .mes:not(.smallSysMes):has(> .mes_block > .ica--companion-ledger):is(.last_mes, :has(.deep-swipe-right, .deep-swipe-counter)),');
        // Notes and Compact's full-width box get the footer row on every screen size, not only phones.
        expect(chatStylesSource).toContain('body:is(.flatchat, .documentstyle):not(.sbterm, .nnchat-messenger) #chat .mes:not(.smallSysMes):is(:has(> .mes_block > .ica--companion-ledger), body.nnchat-compact *):is(.last_mes, :has(.deep-swipe-right)),');
        expect(chatStylesSource).toContain('padding-bottom: calc(var(--moonlit-sb-swipe-control-size) + (var(--moonlit-sb-swipe-edge-offset) * 2)) !important;');
        const narrowFooter = chatStylesSource.match(/@media screen and \(max-width: 1000px\) \{\s*body:is\(\.flatchat:not\(\.nnchat\), \.bubblechat, \.documentstyle, \.nnchat-script, \.nnchat-storybook\)[^]*?\n\}/);
        expect(narrowFooter).not.toBeNull();
        expect(narrowFooter[0]).toContain('padding-bottom: calc(var(--sb-message-icon-size, 30px) + 6px) !important;');
        expect(narrowFooter[0]).toMatch(/\.swipeRightBlock \{\s*flex-direction: row-reverse;/);
        // Only the right arrow joins the cluster; a relative left arrow falls into the header on desktop.
        expect(chatStylesSource).toMatch(/\.tidestyle\) #chat \.last_mes \.swipe_right \{\s*position: relative !important;/);
        expect(chatStylesSource).not.toMatch(/#chat \.last_mes :is\(\.swipe_left, \.swipe_right\) \{[^}]*position: relative/);
    });

    it('keeps Echo-family headers readable', () => {
        expect(chatStylesSource).toContain('--custom-EchoAvatarMobileWidth: 30%;');
        expect(chatStylesSource).toContain('--custom-EchoAvatarMobileHeight: 140px;');
        expect(chatStylesSource).not.toContain('var(--custom-EchoAvatarMobileWidth, 22%) !important');
        expect(chatStylesSource).toContain('mask-composite: intersect;');
        expect(chatStylesSource).not.toContain('border-right: 3.5px solid var(--SmartThemeBodyColor);');
        expect(chatStylesSource).toMatch(/\.tidestyle\) #chat \.mes:not\(\.smallSysMes\) \.mes_block \.ch_name \{\s*align-items: flex-start;/);
        expect(chatStylesSource).toMatch(/body:is\(\.whisperstyle, \.hushstyle\) #chat \.mes\[is_user="true"\]:not\(\.smallSysMes\) \.mesAvatarWrapper \{\s*flex-direction: row;/);
        // The general outline on the user's own messages would be a second frame inside these cards.
        expect(chatStylesSource).toMatch(/body:is\(\.echostyle, \.whisperstyle, \.hushstyle, \.tidestyle\) #chat \.mes\[is_user="true"\]:not\(\.smallSysMes\) \.mes_block \{\s*border: 0;/);
    });

    it('puts Echo and Tide headers and controls on solid plates over the wallpaper', () => {
        expect(chatStylesSource).toMatch(/body:is\(\.echostyle, \.tidestyle\) #chat \.mes:not\(\.smallSysMes\) \{\s*--moonlit-sb-header-plate: color-mix\(in oklch, var\(--neco-surface\) 90%, transparent\);/);
        expect(chatStylesSource).toMatch(/body:is\(\.echostyle, \.tidestyle\) #chat \.mes:not\(\.smallSysMes\) \.ch_name \.alignItemsBaseline \{[^}]*background: var\(--moonlit-sb-header-plate\);/);
        expect(chatStylesSource).toMatch(/body:is\(\.echostyle, \.tidestyle\) #chat \.mes:not\(\.smallSysMes\) \.mes_buttons \.neconyan-message-action:not\(:hover, :focus-visible\) \{\s*background: var\(--moonlit-sb-header-plate\);/);
        expect(chatStylesSource).toMatch(/body:is\(\.echostyle, \.tidestyle\) #chat \.mes:not\(\.smallSysMes\) :is\(\.swipes-counter, [^{]*\{[^}]*background-color: var\(--moonlit-sb-header-plate\);/);
    });

    it('widens the Compact avatar column only while the stats box shows', () => {
        expect(chatStylesSource).toMatch(/\.nnchat-compact:not\(\.sbterm\) #chat \.mes:not\(\.smallSysMes\):has\(> \.mesAvatarWrapper > \.mes_stats > :is\([^{]*\.mesAvatarWrapper \{\s*min-inline-size: calc\(var\(--mainFontSize\) \* 3\.4\);/);
    });

    it('moves Echo-family names past a showing stats box on wide screens', () => {
        expect(chatStylesSource).toContain('margin-left: calc(var(--custom-echo-avatar) + 8px + var(--moonlit-sb-stats-room, 0px));');
        expect(chatStylesSource).toMatch(/\.tidestyle\) #chat \.mes:not\(\.smallSysMes\):has\(> \.mesAvatarWrapper > \.mes_stats > :is\([^{]*\.mes_timer[^{]*\{\s*--moonlit-sb-stats-room: calc\(var\(--mainFontSize\) \* 3\.4 \+ 4px\);/);
    });

    it('keeps Companion Notes inside Echo and Tide messages', () => {
        expect(chatStylesSource).toMatch(/body\.echostyle #chat \.mes:not\(\.smallSysMes\) \.mes_text \+ \.ica--companion-ledger \{[^}]*background-color: var\(--moonlit-sb-bot-message-bg\);/);
        expect(chatStylesSource).toMatch(/body\.echostyle #chat \.mes:not\(\.smallSysMes\) \.mes_text:has\(\+ \.ica--companion-ledger\) \{[^}]*margin-bottom: 0;/);
        expect(chatStylesSource).toMatch(/body\.tidestyle #chat \.mes:not\(\.smallSysMes\) \.ica--companion-ledger > \.ica--companion-card \{\s*background: var\(--moonlit-sb-bot-message-bg\);/);
        expect(chatStylesSource).toMatch(/body\.tidestyle #chat \.mes\[is_user="true"\]:not\(\.smallSysMes\) \.ica--companion-ledger \{\s*clear: both;\s*margin-inline-start: auto;/);
    });

    it('lets Companion Note headers wrap instead of cutting the title short', () => {
        expect(companionStyleSource).toMatch(/\.ica--companion-summary \{\s*display: flex;\s*flex-wrap: wrap;/);
        expect(companionStyleSource).toMatch(/\.ica--companion-actions \{[^}]*margin-left: auto;/);
    });

    it('sets Storybook text flush left on phones', () => {
        expect(chatStylesSource).toMatch(/nnchat-storybook:not\(\.sbterm\) #chat \.mes \.mes_text \{\s*text-align: start;/);
    });

    it('shows the Deep Swipe counter only on messages that got Deep Swipe arrows', () => {
        expect(deepSwipeSource).toContain('body:not(.swipeAllMessages) .mes:not(.last_mes):has(.deep-swipe-right) .swipeRightBlock .swipes-counter {');
    });

    it('lets Deep Swipe keep message borders and shadows that chat styles rely on', () => {
        const idleRule = deepSwipeSource.match(/\.mes \.mes_text,\s*\.mes \.mes_block\s*\{([^}]*)\}/);
        expect(idleRule).not.toBeNull();
        expect(idleRule[1]).toContain('outline: none');
        expect(idleRule[1]).not.toMatch(/border:\s*none/);
        expect(idleRule[1]).not.toMatch(/box-shadow:\s*none/);
    });
});
