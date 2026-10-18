import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from '@adobe/css-tools';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// These rewrites turn a rightmost :is() selector list into the same list written
// as separate selectors. Blink can then reject each branch by its class or id
// instead of testing the rule against every element. Every branch must keep the
// exact specificity of the original selector, otherwise the cascade changes.
const REWRITES = [
    {
        file: 'public/css/neconyan.css',
        from: 'body.neconyan :is(.sb-server-card, .sb-console-log-card)',
        to: ['body.neconyan .sb-server-card', 'body.neconyan .sb-console-log-card'],
    },
    {
        file: 'public/css/neconyan.css',
        from: 'body.neconyan :is(.sb-conversation-message-name, .sb-conversation-message-text)',
        to: ['body.neconyan .sb-conversation-message-name', 'body.neconyan .sb-conversation-message-text'],
    },
    {
        file: 'public/css/neconyan.css',
        from: 'body.neconyan :is(.welcomePanel, .welcomeRecentShell)::before',
        to: ['body.neconyan .welcomePanel::before', 'body.neconyan .welcomeRecentShell::before'],
    },
    {
        file: 'public/css/neconyan.css',
        from: 'body.neconyan :is(.sb-shell-frame, .sb-shell-main, .sb-shell-nav, .sb-character-shell-nav, .sb-shell-header)',
        to: [
            'body.neconyan .sb-shell-frame',
            'body.neconyan .sb-shell-main',
            'body.neconyan .sb-shell-nav',
            'body.neconyan .sb-character-shell-nav',
            'body.neconyan .sb-shell-header',
        ],
    },
    {
        file: 'public/css/neconyan.css',
        from: 'body.neconyan :is(.neconyan-undo-action, .neconyan-undo-dismiss)',
        to: ['body.neconyan .neconyan-undo-action', 'body.neconyan .neconyan-undo-dismiss'],
    },
    {
        file: 'public/css/neconyan.css',
        from: 'body.neconyan :is(#top-bar, #sb-topbar-inner, #sb-bottom-chat-bar)::before',
        to: [
            'body.neconyan #top-bar::before',
            'body.neconyan #sb-topbar-inner::before',
            'body.neconyan #sb-bottom-chat-bar::before',
        ],
    },
    {
        file: 'public/css/neconyan.css',
        from: ':is(.deep-swipe-left-outer, .deep-swipe-right)',
        to: ['.deep-swipe-left-outer', '.deep-swipe-right'],
    },
    {
        file: 'public/css/neconyan.css',
        from: 'body.neconyan #sheld :is(.sbtw-post, .sbtw-reply):has(> .neconyan-message-sleeper)',
        to: [
            'body.neconyan #sheld .sbtw-post:has(> .neconyan-message-sleeper)',
            'body.neconyan #sheld .sbtw-reply:has(> .neconyan-message-sleeper)',
        ],
    },
    {
        file: 'public/css/neconyan-calico.css',
        from: ':root[data-neconyan-palette=\'calico\'] body.neconyan #right-nav-panel > :is(.scrollableInner, .scrollableInnerFull)',
        to: [
            ':root[data-neconyan-palette=\'calico\'] body.neconyan #right-nav-panel > .scrollableInner',
            ':root[data-neconyan-palette=\'calico\'] body.neconyan #right-nav-panel > .scrollableInnerFull',
        ],
    },
    {
        file: 'public/css/neconyan-calico.css',
        from: 'body.neconyan:not(.sbterm) #right-nav-panel #rm_print_characters_block > :is(.character_select, .group_select)',
        to: [
            'body.neconyan:not(.sbterm) #right-nav-panel #rm_print_characters_block > .character_select',
            'body.neconyan:not(.sbterm) #right-nav-panel #rm_print_characters_block > .group_select',
        ],
    },
    {
        file: 'public/css/neconyan-calico.css',
        from: ':root[data-neconyan-palette=\'calico\'] body.neconyan :is(.sb-shell-callout, .sb-theme-card, .sb-settings-group, .sb-admin-card, .sb-agent-card, .sb-character-editor-identity, .sb-character-editor-field-box)',
        to: [
            ':root[data-neconyan-palette=\'calico\'] body.neconyan .sb-shell-callout',
            ':root[data-neconyan-palette=\'calico\'] body.neconyan .sb-theme-card',
            ':root[data-neconyan-palette=\'calico\'] body.neconyan .sb-settings-group',
            ':root[data-neconyan-palette=\'calico\'] body.neconyan .sb-admin-card',
            ':root[data-neconyan-palette=\'calico\'] body.neconyan .sb-agent-card',
            ':root[data-neconyan-palette=\'calico\'] body.neconyan .sb-character-editor-identity',
            ':root[data-neconyan-palette=\'calico\'] body.neconyan .sb-character-editor-field-box',
        ],
    },
    {
        file: 'public/css/neconyan-theme.css',
        from: ':is(.menu_button, .menu_button_icon, .right_menu_button):is(.is-active, .active, .selected, .is-selected, .is-current, [aria-pressed=\'true\'], [aria-selected=\'true\'], [aria-current]):not(.disabled):not(.is-disabled):not([disabled]):not(:where(.menu_button_primary, .popup-button-ok))',
        to: [
            '.menu_button:is(.is-active, .active, .selected, .is-selected, .is-current, [aria-pressed=\'true\'], [aria-selected=\'true\'], [aria-current]):not(.disabled):not(.is-disabled):not([disabled]):not(:where(.menu_button_primary, .popup-button-ok))',
            '.menu_button_icon:is(.is-active, .active, .selected, .is-selected, .is-current, [aria-pressed=\'true\'], [aria-selected=\'true\'], [aria-current]):not(.disabled):not(.is-disabled):not([disabled]):not(:where(.menu_button_primary, .popup-button-ok))',
            '.right_menu_button:is(.is-active, .active, .selected, .is-selected, .is-current, [aria-pressed=\'true\'], [aria-selected=\'true\'], [aria-current]):not(.disabled):not(.is-disabled):not([disabled]):not(:where(.menu_button_primary, .popup-button-ok))',
        ],
    },
    {
        file: 'public/css/neconyan-theme.css',
        from: ':is(.menu_button, .menu_button_icon, .right_menu_button):is(.is-busy, [aria-busy=\'true\'])::after',
        to: [
            ':is(.menu_button, .menu_button_icon, .right_menu_button).is-busy::after',
            ':is(.menu_button, .menu_button_icon, .right_menu_button)[aria-busy=\'true\']::after',
        ],
    },
    {
        file: 'public/css/neconyan-theme.css',
        from: ':is(#openai_settings, #openai-tab-content-parameters)',
        to: ['#openai_settings', '#openai-tab-content-parameters'],
    },
    {
        file: 'public/css/neconyan-tabs.css',
        from: '#right-nav-panel:is([data-menu-type="group_create"], [data-menu-type="group_edit"]) .sb-group-editor-side-actions :is(#group_favorite_button, #rm_group_scenario)',
        to: [
            '#right-nav-panel:is([data-menu-type="group_create"], [data-menu-type="group_edit"]) .sb-group-editor-side-actions #group_favorite_button',
            '#right-nav-panel:is([data-menu-type="group_create"], [data-menu-type="group_edit"]) .sb-group-editor-side-actions #rm_group_scenario',
        ],
    },
    {
        file: 'public/style.css',
        from: 'body.hideAllSwipeButtons :is(.swipe_left, .swipe_right)',
        to: ['body.hideAllSwipeButtons .swipe_left', 'body.hideAllSwipeButtons .swipe_right'],
    },
    {
        file: 'public/css/character-group-overlay.css',
        from: '#rm_print_characters_block.group_overlay_mode_select :is(.character_select, .group_select) input.bulk_select_checkbox',
        to: [
            '#rm_print_characters_block.group_overlay_mode_select .character_select input.bulk_select_checkbox',
            '#rm_print_characters_block.group_overlay_mode_select .group_select input.bulk_select_checkbox',
        ],
    },
    {
        file: 'public/css/neconyan-menus.css',
        from: 'body.neconyan :is(#neconyan-chat-route, #neconyan-chat-link-settings)',
        to: ['body.neconyan #neconyan-chat-route', 'body.neconyan #neconyan-chat-link-settings'],
    },
    {
        file: 'public/css/neconyan-help.css',
        from: '#chat .custom-necoHelp :is(p, h3, h4, dl, dd)',
        to: ['#chat .custom-necoHelp p', '#chat .custom-necoHelp h3', '#chat .custom-necoHelp h4', '#chat .custom-necoHelp dl', '#chat .custom-necoHelp dd'],
    },
    {
        file: 'public/css/neconyan-home-compact.css',
        from: 'body.neconyan .welcomePanel--compact :is(.neconyan-home-intro, .neconyan-assistant-picker)',
        to: [
            'body.neconyan .welcomePanel--compact .neconyan-home-intro',
            'body.neconyan .welcomePanel--compact .neconyan-assistant-picker',
        ],
    },
    {
        file: 'public/css/neconyan-character-tags.css',
        from: 'body.neconyan:not(.charListGrid):not(.sbterm) #right-nav-panel #rm_print_characters_block :is(.character_name_block, .group_name_block)',
        to: [
            'body.neconyan:not(.charListGrid):not(.sbterm) #right-nav-panel #rm_print_characters_block .character_name_block',
            'body.neconyan:not(.charListGrid):not(.sbterm) #right-nav-panel #rm_print_characters_block .group_name_block',
        ],
    },
];

const normalise = selector => selector.replace(/\s+/g, ' ').replace(/"/g, '\'').trim();

function splitTopLevel(text, separator = ',') {
    const parts = [];
    let depth = 0;
    let quote = '';
    let current = '';
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (quote) {
            current += char;
            if (char === quote && text[i - 1] !== '\\') quote = '';
            continue;
        }
        if (char === '"' || char === '\'') {
            quote = char;
            current += char;
            continue;
        }
        if (char === '(' || char === '[') depth += 1;
        if (char === ')' || char === ']') depth -= 1;
        if (depth === 0 && char === separator) {
            parts.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    parts.push(current);
    return parts.map(part => part.trim()).filter(Boolean);
}

function maskStrings(selector) {
    let out = '';
    let quote = '';
    for (let i = 0; i < selector.length; i++) {
        const char = selector[i];
        if (quote) {
            out += 'x';
            if (char === quote && selector[i - 1] !== '\\') quote = '';
            continue;
        }
        if (char === '"' || char === '\'') {
            quote = char;
            out += 'x';
            continue;
        }
        out += char;
    }
    return out;
}

function findMatch(text, openIndex, open = '(', close = ')') {
    let depth = 0;
    for (let i = openIndex; i < text.length; i++) {
        if (text[i] === open) depth += 1;
        else if (text[i] === close && --depth === 0) return i;
    }
    return -1;
}

// Specificity of a selector as [id, class, type]. :is()/:not()/:has() take the
// highest-specificity argument, :where() contributes nothing, and pseudo-elements
// count as a type.
function specificity(selector) {
    const text = maskStrings(selector);
    const counts = { id: 0, cls: 0, type: 0 };
    let i = 0;
    let expectType = true;
    while (i < text.length) {
        const char = text[i];
        if (/\s|>|\+|~|,/.test(char)) {
            expectType = true;
            i += 1;
            continue;
        }
        if (char === '*') {
            expectType = false;
            i += 1;
            continue;
        }
        if (char === '#') {
            counts.id += 1;
            expectType = false;
            while (i + 1 < text.length && /[\w-]/.test(text[i + 1])) i += 1;
            i += 1;
            continue;
        }
        if (char === '.') {
            counts.cls += 1;
            expectType = false;
            while (i + 1 < text.length && /[\w-]/.test(text[i + 1])) i += 1;
            i += 1;
            continue;
        }
        if (char === '[') {
            counts.cls += 1;
            expectType = false;
            i = findMatch(text, i, '[', ']') + 1;
            continue;
        }
        if (char === ':') {
            let pseudoElement = false;
            i += 1;
            if (text[i] === ':') {
                pseudoElement = true;
                i += 1;
            }
            let name = '';
            while (i < text.length && /[\w-]/.test(text[i])) name += text[i++];
            if (text[i] === '(') {
                const end = findMatch(text, i);
                const args = splitTopLevel(text.slice(i + 1, end));
                if (!pseudoElement) {
                    if (name === 'where') {
                        // Zero specificity.
                    } else if (['is', 'not', 'has', 'matches', 'any'].includes(name)) {
                        const specifications = args.map(specificity).sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]));
                        const max = specifications[specifications.length - 1];
                        counts.id += max[0];
                        counts.cls += max[1];
                        counts.type += max[2];
                    } else {
                        counts.cls += 1;
                    }
                }
                i = end + 1;
            } else if (pseudoElement) {
                counts.type += 1;
            } else {
                counts.cls += 1;
            }
            expectType = false;
            continue;
        }
        if (/[\w-]/.test(char)) {
            while (i < text.length && /[\w-]/.test(text[i])) i += 1;
            if (expectType) counts.type += 1;
            expectType = false;
            continue;
        }
        i += 1;
    }
    return [counts.id, counts.cls, counts.type];
}

function collectSelectors(source) {
    const selectors = [];
    const visit = rules => {
        for (const rule of rules) {
            if (rule.type === 'rule' && rule.selectors) {
                selectors.push(...rule.selectors.map(normalise));
                if (rule.declarations) visit(rule.declarations.filter(node => node.type === 'rule'));
            } else if (rule.rules) {
                visit(rule.rules);
            }
        }
    };
    visit(parse(source).stylesheet.rules);
    return selectors;
}

describe('desktop CSS selector splits', () => {
    test('the specificity helper follows the cascade rules the splits rely on', () => {
        expect(specificity('body.neconyan :is(.a, .b)')).toEqual([0, 2, 1]);
        expect(specificity('body.neconyan :is(.a, #b)')).toEqual([1, 1, 1]);
        expect(specificity(':where(#b) .a')).toEqual([0, 1, 0]);
        expect(specificity(':is(.a, .b):is(.c, .d)::after')).toEqual([0, 2, 1]);
        expect(specificity(':is(.a, strong.a)')).toEqual([0, 1, 1]);
    });

    for (const rewrite of REWRITES) {
        test(`${rewrite.file} keeps the split equivalence for ${rewrite.from.slice(0, 70)}`, () => {
            const source = readFileSync(path.join(repoRoot, rewrite.file), 'utf8').replace(/\r\n/g, '\n');
            const selectors = collectSelectors(source);
            const expected = specificity(rewrite.from);
            expect(selectors).not.toContain(normalise(rewrite.from));
            for (const replacement of rewrite.to) {
                expect(selectors).toContain(normalise(replacement));
                expect(specificity(replacement)).toEqual(expected);
            }
        });
    }

    test('the character overlay import has its own cache version', () => {
        const source = readFileSync(path.join(repoRoot, 'public/style.css'), 'utf8');
        expect(source).toMatch(/@import url\(css\/character-group-overlay\.css\?v=[^\s);]+\);/);
    });
});
