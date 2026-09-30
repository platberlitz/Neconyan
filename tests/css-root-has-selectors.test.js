import { describe, expect, test } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(repoRoot, 'public');

// A rule such as `body:has(.x) #sheld` makes Chromium re-check body's :has() state after
// every DOM insertion anywhere in the page, and then restyle thousands of elements. With
// a long chat open each clock tick, rail refresh or token label update cost 330-400ms of
// main-thread time, which delayed the first streamed words of a reply by many seconds.
// The same happens with #chat or #sheld as the anchor: every added message restyled the
// whole chat (about 0.4s). Anchor such rules on a nearer element (for example
// `#top-settings-holder:has(...) ~ #sheld` or `.mes:has(...)`) or toggle a class from script.
const ALLOWED = [
    {
        // Upstream drawer layout rule; it is only evaluated while a settings drawer is open.
        file: 'style.css',
        matches: selector => /^body:has\(\.drawer-content\.(maximized|open)\) #top-settings-holder:has\(/.test(selector),
    },
    {
        // Phones narrower than 361px only, in Conversation mode; no current iPhone is that narrow.
        file: 'css/neconyan.css',
        matches: selector => selector === 'body.neconyan.neconyan-conversation-active:not(.neconyan-home-visible):not(:has(.sb-shell-root.openDrawer, #right-nav-panel.openDrawer)) .sb-topbar-brand',
    },
    {
        // Terminal UI is opt-in; these rules are skipped unless body carries .sbterm.
        file: 'scripts/extensions/third-party/Neconyan-Terminal-UI/style.css',
        matches: selector => selector.startsWith('body.sbterm'),
    },
];

function listCssFiles(directory) {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'node_modules' && entry.name !== 'lib') files.push(...listCssFiles(fullPath));
        } else if (entry.name.endsWith('.css') && !entry.name.endsWith('.min.css')) {
            files.push(fullPath);
        }
    }
    return files.sort();
}

function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

function splitTopLevel(text, separator) {
    const parts = [];
    let depth = 0;
    let current = '';
    for (const char of text) {
        if (char === '(' || char === '[') depth++;
        if (char === ')' || char === ']') depth--;
        if (depth === 0 && separator.test(char)) {
            parts.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    parts.push(current);
    return parts.map(part => part.trim()).filter(Boolean);
}

function collectSelectors(source) {
    const selectors = [];
    const stack = [];
    let buffer = '';
    let depth = 0;
    for (const char of source) {
        if (char === '(' || char === '[') depth++;
        if (char === ')' || char === ']') depth--;
        if (depth === 0 && char === '{') {
            const prelude = buffer.trim();
            stack.push(prelude);
            if (prelude && !prelude.startsWith('@') && !stack.slice(0, -1).some(outer => /^@(keyframes|font-face|page)/i.test(outer))) {
                selectors.push(...splitTopLevel(prelude, /,/).map(selector => selector.replace(/\s+/g, ' ')));
            }
            buffer = '';
        } else if (depth === 0 && char === '}') {
            stack.pop();
            buffer = '';
        } else if (depth === 0 && char === ';') {
            buffer = '';
        } else {
            buffer += char;
        }
    }
    return selectors;
}

function isPageWideAnchor(compound) {
    const head = compound.slice(0, compound.indexOf(':has('));
    return /^(html|body|:root)(?![\w-])/.test(head) || /#(chat|sheld)(?![\w-])/.test(head);
}

function isRootAnchoredNonSubjectHas(selector) {
    const compounds = splitTopLevel(selector, /[\s>+~]/);
    return compounds.some((compound, index) => compound.includes(':has(')
        && isPageWideAnchor(compound)
        && compounds.slice(index + 1).some(later => !/^::[\w-]+/.test(later)));
}

describe('root-anchored :has() selectors', () => {
    const files = listCssFiles(publicDir);

    test('finds the shipped stylesheets', () => {
        expect(files.map(file => path.relative(publicDir, file))).toEqual(expect.arrayContaining([
            'style.css',
            'css/neconyan.css',
            'css/neconyan-calico.css',
            'css/neconyan-mobile-shell.css',
        ]));
    });

    test('no html, body, :root, #chat or #sheld :has() rule styles other elements', () => {
        const offenders = [];
        for (const file of files) {
            const relative = path.relative(publicDir, file).split(path.sep).join('/');
            for (const selector of collectSelectors(stripComments(readFileSync(file, 'utf8')))) {
                if (!isRootAnchoredNonSubjectHas(selector)) continue;
                if (ALLOWED.some(rule => rule.file === relative && rule.matches(selector))) continue;
                offenders.push(`${relative}: ${selector}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('the check recognises the patterns it guards against', () => {
        expect(isRootAnchoredNonSubjectHas('body.neconyan:has(#right-nav-panel.openDrawer) #sheld')).toBe(true);
        expect(isRootAnchoredNonSubjectHas('body:has(> #sheld[data-sbtw-mode=\'on\']) :is(#a, #b)')).toBe(true);
        expect(isRootAnchoredNonSubjectHas(':root:has(body.neconyan) .x')).toBe(true);
        expect(isRootAnchoredNonSubjectHas(':root:has(body.neconyan)')).toBe(false);
        expect(isRootAnchoredNonSubjectHas('body.neconyan:has(#bg1.cover)::before')).toBe(false);
        expect(isRootAnchoredNonSubjectHas('body.neconyan :where(#top-settings-holder):has(.openDrawer) ~ #sheld')).toBe(false);
        expect(isRootAnchoredNonSubjectHas('.popup:has(#qr--modalEditor) h3 + div')).toBe(false);
        expect(isRootAnchoredNonSubjectHas('#chat:not([data-x="true"]):not(:has(.reasoning_edit_textarea)) .mes:has(.mes_reasoning:empty) .mes_reasoning_details')).toBe(true);
        expect(isRootAnchoredNonSubjectHas('body.neconyan #sheld:has(.x) .y')).toBe(true);
        expect(isRootAnchoredNonSubjectHas('#chat:not([data-x="true"]) .mes:has(.mes_reasoning:empty):not(:has(.reasoning_edit_textarea)) .mes_reasoning_details')).toBe(false);
        expect(isRootAnchoredNonSubjectHas('#chatx:has(.a) .b')).toBe(false);
    });
});
