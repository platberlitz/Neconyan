import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from '@adobe/css-tools';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(repoRoot, file), 'utf8');

const COMPACT_ROOT = ':root[data-sb-compact-mode=\'true\']';
const DESKTOP_MEDIA = '(min-width: 1001px)';
const SIZE_PROPERTIES = /^(min-|max-)?(height|width)$|^--avatar-base-|avatar-size$|^grid-template-columns$/;

function collectRules(rules, media = null, out = []) {
    for (const rule of rules) {
        if (rule.type === 'media') {
            collectRules(rule.rules, rule.media, out);
        } else if (rule.type === 'rule') {
            out.push({ media, selectors: rule.selectors, declarations: rule.declarations.filter(d => d.type === 'declaration') });
        }
    }
    return out;
}

describe('Compact Mode outside the shell', () => {
    const sheet = read('public/css/neconyan-compact-mode.css');
    const rules = collectRules(parse(sheet).stylesheet.rules);

    test('loads as a deferred stylesheet', () => {
        const html = read('public/index.html');
        expect(html).toMatch(/<link href="css\/neconyan-compact-mode\.css\?v=[^"]+" rel="preload" as="style" data-sb-deferred-style data-sb-media="all">/);
    });

    test('only applies while Compact Mode is on', () => {
        expect(rules.length).toBeGreaterThan(0);
        for (const { selectors } of rules) {
            for (const selector of selectors) {
                expect(selector.startsWith(COMPACT_ROOT)).toBe(true);
            }
        }
    });

    test('keeps phone tap targets and only shrinks controls on desktop', () => {
        for (const { media, declarations } of rules) {
            if (media === DESKTOP_MEDIA) continue;
            expect(media).toBeNull();
            for (const { property } of declarations) {
                expect(property).not.toMatch(SIZE_PROPERTIES);
            }
        }
    });

    test('tightens the chat in every chat style and leaves Kittyless spacing alone', () => {
        const sleeperSpace = rules.find(({ declarations }) => declarations.some(d => d.property === '--neconyan-sleeper-space'));
        expect(sleeperSpace.media).toBeNull();
        expect(sleeperSpace.selectors).toEqual([`${COMPACT_ROOT}:not([data-sb-kittyless='true']) body.neconyan`]);
        expect(rules.some(({ selectors }) => selectors.some(s => s.includes('img.neconyan-message-sleeper')))).toBe(true);
        expect(rules.some(({ selectors }) => selectors.some(s => s.includes('.sb-conversation-timeline')))).toBe(true);
    });

    test('does not narrow the docked settings panels on laptops', () => {
        const tabs = collectRules(parse(read('public/css/neconyan-tabs.css')).stylesheet.rules);
        const narrowing = tabs.filter(({ selectors, declarations }) =>
            selectors.some(s => s.startsWith(COMPACT_ROOT) && /#(left-nav-panel|user-settings-block)\.openDrawer/.test(s))
            && declarations.some(d => /^(min-|max-)?width$/.test(d.property)));
        expect(narrowing).toEqual([]);
    });
});
