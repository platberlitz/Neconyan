import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from '@jest/globals';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const read = relativePath => readFileSync(path.join(repoRoot, relativePath), 'utf8');

const chatStyles = read('public/css/neconyan-chat-styles.css');
const deferredControls = read('public/css/desktop-response-controls.css');
const layoutSource = read('public/scripts/echo-message-layout.js');
const sleepersSource = read('public/scripts/neconyan-message-sleepers.js');
const coreSource = read('public/script.js');

const tideSection = chatStyles.slice(chatStyles.indexOf('/* --- Neconyan chat style: Tide reading layout --- */'));

function sourceSlice(start, end) {
    const from = layoutSource.indexOf(start), to = layoutSource.indexOf(end);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return layoutSource.slice(from, to).replace(/^export /gm, '');
}

describe('Tide chat stylesheet contract', () => {
    it('gates the shared narrow block by class without changing specificity', () => {
        for (const fragment of [
            '#chat .last_mes:where(:not(.nn-tide-layout)) {',
            '#chat .mes:not(.smallSysMes):where(:not(.nn-tide-layout)) .mesAvatarWrapper {',
            '#chat .last_mes:not(.smallSysMes):where(:not(.nn-tide-layout)) .mesAvatarWrapper {',
            '#chat .mes:not(.smallSysMes):where(:not(.nn-tide-layout)) .mes_block,',
            '#chat .lastInContext:where(:not(.nn-tide-layout)) .mes_block {',
            '#chat .mes:not(.smallSysMes):where(:not(.nn-tide-layout)) .ch_name .flex-container {',
            '#chat .mes:not(.smallSysMes):where(:not(.nn-tide-layout)) .mes_text {',
            'body.tidestyle #chat .mes:not(.smallSysMes):where(:not(.nn-tide-layout)) .mes_text {',
        ]) expect(chatStyles).toContain(fragment);
        // The plan's binding text is :where(:not(...)); a plain :not() would add specificity.
        expect(chatStyles).not.toMatch(/\.mes:not\(\.nn-tide-layout\)|\.last_mes:not\(\.nn-tide-layout\)/);
        expect(chatStyles).toContain('body:is(.echostyle, .whisperstyle, .hushstyle, .tidestyle) #chat .mes:where(:not(.nn-tide-layout)) .ch_name .flex-container {');
    });

    it('leaves the pinned tablet stats rule and the shared cluster rules untouched', () => {
        const pins = [
            'body:is(.echostyle, .whisperstyle, .hushstyle, .tidestyle) #chat .mes .mesAvatarWrapper .mes_stats > :is(.mesIDDisplay, .mes_timer, .tokenCounterDisplay) {',
            'body:is(.echostyle, .whisperstyle, .hushstyle, .tidestyle) #chat .mes:not(.smallSysMes):is(.last_mes, :has(.deep-swipe-right, .deep-swipe-counter)),',
            'padding-bottom: calc(var(--moonlit-sb-swipe-control-size) + (var(--moonlit-sb-swipe-edge-offset) * 2)) !important;',
            'body:is(.echostyle, .whisperstyle, .hushstyle, .ripplestyle, .tidestyle) #chat .last_mes .swipes-counter {',
        ];
        for (const pin of pins) expect(chatStyles).toContain(pin);
        expect(chatStyles.match(/body:is\(\.echostyle, \.whisperstyle, \.hushstyle, \.tidestyle\) #chat \.mes \.mesAvatarWrapper \.mes_stats > :is\(/g)).toHaveLength(1);
    });

    it('drops the dead lifts and re-scopes the pill rules to direct children', () => {
        // Only the two other styles' lifts remain; Tide's own translation is gone.
        expect(chatStyles.match(/transform: translateY\(calc\(var\(--custom-ChatAvatar\) \* \(-1 \+ 0\.325\)\)\) !important;/g)).toHaveLength(2);
        expect(chatStyles).toContain('& .mes_text > p {');
        expect(chatStyles).toContain('body.tidestyle {\n    #chat .mes_text > p {');
        expect(chatStyles).toMatch(/\n {12}> p \{\n {16}display: block;/);
        expect(chatStyles).toContain('body.echostyle,\nbody.whisperstyle,\nbody.hushstyle {\n    #chat .lastInContext .mes_block {');
        // The narrow cluster copies no longer list Tide; the all-width cluster rules cover it.
        expect(chatStyles).not.toContain('body:is(.echostyle, .whisperstyle, .hushstyle, .ripplestyle, .tidestyle) #chat .last_mes .swipeRightBlock {\n        align-items: center;\n        bottom:');
    });

    it('appends one Tide section that is important-free and stays inside the ratchet budget', () => {
        expect(tideSection).toContain('body.neconyan.tidestyle #chat .mes .mes_text > p:is(:empty, [data-nn-tide-empty]) {\n    display: none;\n}');
        expect(tideSection).toContain('body.neconyan.tidestyle #chat .mes .mes_text > :is(details, blockquote, pre, ul, ol, table, dl) + br,');
        expect(tideSection).toContain('body.neconyan.tidestyle #chat .mes .mes_text > br:has(+ :is(details, blockquote, pre, ul, ol, table, dl)) {');
        expect(tideSection).toContain('border-radius: 18px;');
        expect(tideSection).toContain('body.neconyan.big-avatars.tidestyle:not(.hideChatAvatars):not(.sbterm) #chat .mes.nn-tide-layout:not([is_user=\'true\']) .ch_name {');
        expect(tideSection).toContain('@media screen and (min-width: 769px) {');
        expect(tideSection).toContain('--moonlit-sb-swipe-control-size: 36px;');
        expect(tideSection).toContain('--moonlit-sb-swipe-counter-width: 44px;');
        expect(tideSection).not.toContain('!important');
        expect((chatStyles.match(/!important/g) ?? [])).toHaveLength(220);
        // No :has(> br) shortcut for real two-line text anywhere in the sheets.
        expect(chatStyles).not.toContain('p:has(> br)');
        expect(deferredControls).not.toContain('p:has(> br)');
    });

    it('keeps the user header compact with the same rules the assistant header uses', () => {
        // Revision 4: the user header shrink-wraps like the assistant's, instead of summing the
        // name row and the button row into one ~447px box.
        expect(tideSection).toMatch(/&\[is_user='true'\] > \.mesAvatarWrapper \{\n {12}right: var\(--nn-tide-inset\);\n {12}padding-left: 0;\n {8}\}/);
        expect(tideSection).toMatch(/&\[is_user='true'\] \.ch_name \{\n {12}flex-direction: column;\n {12}align-items: flex-end;\n {12}margin-left: auto;/);
        // The column flex container shrink-wraps to the wider of the name row and the button row.
        // Scoped to the user row: the assistant's wrapping row keeps the core width: 100%.
        expect(tideSection).toMatch(/&\[is_user='true'\] \.ch_name \.mes_buttons \{\n {12}width: auto;\n {8}\}/);
        // The padded avatar wrapper rule the reset overrides is still in the base block (line 982).
        expect(chatStyles).toContain('padding-left: 2%;');
        // Neconyan's own width: 100% rule on the message buttons is untouched.
        expect(read('public/css/neconyan.css')).toContain('.mes_buttons');
    });

    it('drops every header cutoff from the sheet (Revision 4 Option B)', () => {
        expect(chatStyles).not.toContain('nn-tide-cutoff');
        expect(chatStyles).not.toContain('nn-tide-header-bottom');
        expect(tideSection).toContain('the header never hides at the bottom bar');
        // The screenshot surface still restores the header members it keeps.
        expect(chatStyles).toContain('body.neconyan.tidestyle:not(.sbterm) #chat .sb-message-screenshot-surface .mes.nn-tide-layout :is(.mesAvatarWrapper, .ch_name, .mes_reasoning_details, .nn-tide-header-plate, .neconyan-message-sleeper) {');
    });
});

describe('Tide deferred control contract', () => {
    it('keeps the manager wrapper pill-free and side-aligned, with the container padding', () => {
        expect(deferredControls).not.toContain('nn-tide-overlay-footer');
        expect(deferredControls).not.toContain('nn-tide-reserves-footer');
        expect(deferredControls).not.toContain('--nn-tide-footer');
        // R7 round-3 C: every Tide row keeps 12px under its members.
        expect(deferredControls).toContain('body.neconyan.tidestyle[data-neconyan-chat-mode=\'roleplay\']:not(.sbterm):not(.sbstory) #chat .mes.nn-tide-layout {\n        padding-bottom: 12px !important;\n    }');
        // The relief rule that used to cancel that padding no longer names Tide.
        expect(deferredControls).toContain('body.neconyan:is(.whisperstyle, .hushstyle)[data-neconyan-chat-mode=\'roleplay\']:not(.sbterm):not(.sbstory) #chat .mes:not(.smallSysMes, [is_system=\'true\']):has(> .nn-response-controls, > .mes_block > .nn-response-controls) {');
        // In flow, hugging the cluster, aligned to the row's outer side, no pill. A user row's wrapper
        // carries the .mes_text end padding, so its box and its cluster land on the bubbles' right.
        expect(deferredControls).toContain('body.neconyan.tidestyle #chat .mes.nn-tide-layout > .mes_block > .nn-response-controls {\n        width: max-content;\n        margin-inline-end: auto;\n        justify-content: flex-start;\n    }');
        expect(deferredControls).toContain('body.neconyan.tidestyle #chat .mes.nn-tide-layout[is_user=\'true\'] > .mes_block > .nn-response-controls {\n        width: max-content;\n        margin-inline-start: auto;\n        margin-inline-end: calc(var(--mes-right-spacing) - 6px);\n        justify-content: flex-end;\n    }');
    });

    it('gives tablet Tide the same wrapper and slots as the desktop (round-3 A)', () => {
        const tablet = deferredControls.slice(deferredControls.indexOf('Owner redesign R7, round-3 fix A'), deferredControls.indexOf('Every Tide row keeps 12px'));
        expect(tablet).toContain('@media screen and (min-width: 769px) and (max-width: 1000px) {');
        expect(tablet).toContain('body.neconyan.tidestyle #chat .mes.nn-tide-layout .nn-response-controls {');
        expect(tablet).toContain('width: max-content;');
        expect(tablet).toContain('margin-inline-end: auto;');
        expect(tablet).toContain('body.neconyan.tidestyle #chat .mes.nn-tide-layout .nn-response-controls .swipeRightBlock {');
        expect(tablet).toContain('position: static !important;');
        expect(tablet).toContain('flex: 0 0 36px;');
        expect(tablet).toContain('min-width: 44px;');
        // No other style appears in the tablet block.
        expect(tablet).not.toMatch(/body\.neconyan(?![.\w])/);
    });

    it('keeps the desktop below bar and the narrow cluster on one size', () => {
        expect(deferredControls).toContain('body.neconyan:is(.hushstyle, .ripplestyle, .tidestyle)[data-neconyan-chat-mode=\'roleplay\']:not(.sbterm, .sbstory) #chat .mes.nn-response-controls-below > .nn-response-controls {');
        expect(deferredControls).toContain('body.neconyan.tidestyle.swipeAllMessages #chat .mes:not(.last_mes) .swipes-counter {\n        margin: 0 !important;\n    }');
        expect(deferredControls).toMatch(/body\.neconyan\.tidestyle\[data-neconyan-chat-mode='roleplay'\]:not\(\.sbterm, \.sbstory\) #chat \.mes:not\(\.smallSysMes, \[is_system='true'\]\) \{\n {8}\.swipes-counter \{/);
        // Tide's paint block sits at the sheet's top level, so it applies at every width.
        const topLevel = deferredControls.slice(deferredControls.indexOf('/* Tide changes only control paint'), deferredControls.indexOf('/* Ripple changes only control paint'));
        expect(topLevel).toContain('body.neconyan.tidestyle[data-neconyan-chat-mode=\'roleplay\']:not(.sbterm, .sbstory) #chat .mes:not(.smallSysMes, [is_system=\'true\']) {');
        expect(topLevel).toContain('.deep-swipe-left-outer[style*=\'pointer-events: none\']:not(.disabled, [hidden]) { opacity: 0.3 !important; pointer-events: none !important; }');
        expect(topLevel).toContain('.swipes-counter:not([hidden]) { opacity: 1 !important; }');
        expect(topLevel).toContain('line-height: 1 !important;');
        expect(deferredControls).toMatch(/\.swipes-counter \{\n {8}letter-spacing: 0;\n {4}\}/);
    });
});

describe('Tide layout script seams', () => {
    it('wires the sleepers queue, the disconnected cleanup and the focus refresh', () => {
        expect(sleepersSource).toContain('import { measureEchoMessage, clearEchoMessage, refreshEchoHeader, measureTideMessage, clearTideMessage } from \'./echo-message-layout.js\';');
        expect(sleepersSource).toContain('measureEchoMessage(item.message);\n            measureTideMessage(item.message);');
        expect(sleepersSource).toContain('clearEchoMessage(bubble.closest(\'.mes\'));\n        clearTideMessage(bubble.closest(\'.mes\'));');
        expect(sleepersSource).toContain('\'#chat > .mes > :is(.mes_block, .mesAvatarWrapper), #chat > .mes > .mes_block > :is(.mes_text, .nn-response-controls)\'');
        expect(sleepersSource).toContain('(node.matches(\'.mes, .mes_block, .mes_text, .nn-response-controls\')');
        expect(sleepersSource).toContain('if (row) requestAnimationFrame(() => refreshEchoHeader(row));');
        // R7 review: a Tide row's class/style change (a row gaining or losing .last_mes, a header
        // button or control appearing) queues the same pass for that row, and the values the pass
        // itself wrote are skipped so the observer cannot feed itself.
        expect(sleepersSource).toContain('tideHeaderObserver.observe(chat, { subtree: true, attributes: true, attributeFilter: [\'class\', \'style\', \'hidden\'], childList: true });');
        expect(sleepersSource).toContain('if (!target.matches?.(\'.mes_buttons, .nn-response-controls\')) continue;');
        expect(sleepersSource).toContain('if (![...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && !node.matches(\'.nn-tide-header-plate, .nn-tide-container\'))) continue;');
        expect(sleepersSource).toContain('!target.matches?.(\'.mes_buttons, .mes_buttons *, .nn-response-controls, .nn-response-controls *\')');
        expect(sleepersSource).toContain('measuredStyles.set(item.message, { style: item.message.getAttribute(\'style\'), className: item.message.getAttribute(\'class\') });');
        expect(sleepersSource).toContain('if (record.attributeName === \'style\' && written.style === target.getAttribute(\'style\')) continue;');
        // Pass 2 fix 2: the header watch is Tide-only, attached while Tide is active and released on
        // a style switch, so Echo and every other style behave as they do without it.
        expect(sleepersSource).toContain('const tideActive = () => document.body.classList.contains(\'tidestyle\');');
        expect(sleepersSource).toContain('if (tideActive() && !tideHeaderObserver) {');
        expect(sleepersSource).toContain('} else if (!tideActive() && tideHeaderObserver) {');
        expect(sleepersSource).toContain('tideHeaderObserver.disconnect();');
        expect(sleepersSource).toContain('chat.addEventListener(\'transitionend\', onTideHeaderTransition, true);');
        expect(sleepersSource).toContain('chat.removeEventListener(\'transitionend\', onTideHeaderTransition, true);');
        expect(sleepersSource).toContain('const onTideHeaderTransition = event => {\n        if (!tideActive()) return;');
        expect(sleepersSource).toContain('syncTideHeaderWatch();\n        for (const bubble of observedBubbles) queuePlacement(bubble.closest(\'.mes\'));');
        // Revision 4 Option B: Tide has no header cutoff, so nothing refreshes one.
        expect(sleepersSource).not.toContain('refreshTideHeader');
    });

    it('measures Tide from the two message seams and re-applies it in the export clone', () => {
        expect(coreSource).toContain('import { measureEchoMessage, measureTideMessage } from \'./scripts/echo-message-layout.js\';');
        expect(coreSource.match(/measureEchoMessage\(message\);\n {4}measureTideMessage\(message\);/)).not.toBeNull();
        expect(coreSource.match(/measureEchoMessage\(message\);\n {8}measureTideMessage\(message\);/)).not.toBeNull();
        const clone = coreSource.slice(coreSource.indexOf('// Tide\'s inert plate and cat follow'), coreSource.indexOf('// SB: bound the reflowed capture'));
        expect(clone).toContain('clonedSurface.querySelectorAll(\'.mes.nn-tide-layout:has(> .nn-tide-header-plate)\')');
        expect(clone).toContain('if (property.startsWith(\'--nn-tide-\')) descendant.style.removeProperty(property);');
        expect(clone).toContain('container.style[axis] = `var(--nn-tide-box-${axis})`');
        expect(clone).toContain('text.style.marginTop = \'var(--nn-tide-clearance, 8px)\';');
        expect(clone).toContain('plate.style[axis] = `var(--nn-tide-plate-${axis})`');
        expect(clone).toContain('cat.style.top = \'var(--nn-tide-cat-top)\'; cat.style.left = \'var(--nn-tide-cat-left)\';');
        expect(clone.match(/updateMessageSleeperPosition\(message\);/g)).toHaveLength(2);
    });

    it('exports the R7 container, surface and teardown helpers', () => {
        for (const name of ['isTideMessage', 'measureTideMessage', 'clearTideMessage', 'markTideEmptyParagraphs',
            'isTideEmptyParagraph', 'resolveTideBox', 'resolveTideSurface', 'disposeTideLayout']) {
            expect(layoutSource).toContain(`export function ${name}(`);
        }
        // Pass 2 fix 1: every property the pass writes is cleared, including the four box variables.
        expect(layoutSource).toContain('const tideProperties = [\'cat-top\', \'cat-left\', \'plate-top\', \'plate-left\', \'plate-width\', \'plate-height\', \'box-top\', \'box-left\', \'box-width\', \'box-height\', \'clearance\'];');
        // Pass 2 fix 3: a row without Tide state is left completely alone, so no other style pays a
        // class or style mutation per pass.
        expect(layoutSource).toContain('const hasLayout = message.classList.contains(\'nn-tide-layout\');');
        expect(layoutSource).toContain('if (!hasLayout && !properties.length && !plate && !container && !markers.length) return;');
        expect(layoutSource).toContain('if (hasLayout) message.classList.remove(\'nn-tide-layout\');');
        expect(layoutSource).toContain('for (const key of properties) message.style.removeProperty(key);');
        // R7 deletes the overlay footer, the underbar hiding and the header cutoff entirely.
        for (const gone of ['resolveTideEnd', 'measureTideFooter', 'clearTideFooter', 'nn-tide-underbar',
            'nn-tide-overlay-footer', 'nn-tide-reserves-footer', 'refreshTideHeader', 'nn-tide-cutoff', 'nn-tide-header-bottom']) {
            expect(layoutSource).not.toContain(gone);
        }
        // The container is the row's first child, painted behind plate and bubbles.
        expect(layoutSource).toContain('container.className = \'nn-tide-container\'');
        expect(layoutSource).toMatch(/container\.setAttribute\('aria-hidden', 'true'\); message\.prepend\(container\);/);
        expect(chatStyles).toContain('> .nn-tide-container {');
        expect(chatStyles).toContain('z-index: -2;');
        expect(chatStyles).toContain('border-radius: 22px;');
        expect(chatStyles).toContain('background: color-mix(in srgb, var(--neco-surface) 55%, transparent);');
        expect(chatStyles).toContain('--nn-tide-inset: 22px;');
        expect(chatStyles).toContain('padding-inline: var(--nn-tide-inset);');
        expect(chatStyles).toContain('right: var(--nn-tide-inset);');
        expect(tideSection).not.toContain('backdrop-filter');
    });
});

describe('Tide paragraph predicates', () => {
    const context = () => {
        const empty = sourceSlice('export function isTideEmptyParagraph', 'export function markTideEmptyParagraphs');
        const sandbox = { window: null };
        vm.runInNewContext(`${empty}\nthis.api = { isTideEmptyParagraph };`, sandbox);
        return sandbox.api;
    };

    const node = (tag) => ({ tagName: tag, nodeType: 1 });
    const textNode = (value) => ({ nodeType: 3, textContent: value });

    it('names only paragraphs that hold nothing but breaks', () => {
        const { isTideEmptyParagraph } = context();
        for (const value of [[], [node('BR')], [textNode('  ')], [textNode('\n'), node('BR')]]) {
            expect(isTideEmptyParagraph(value)).toBe(true);
        }
        for (const value of [[textNode('a'), node('BR'), textNode('b')], [textNode('Text'), node('BR')], [node('SPAN')]]) {
            expect(isTideEmptyParagraph(value)).toBe(false);
        }
    });
});
