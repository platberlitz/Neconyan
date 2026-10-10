import { parse } from '@adobe/css-tools';
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../public/css/neconyan-conversation.css', import.meta.url)), 'utf8');
const ast = parse(css, { source: 'neconyan-conversation.css' });

function findMediaRule(predicate) {
    return ast.stylesheet.rules.find(rule => rule.type === 'media' && predicate(rule.media));
}

function getDeclarations(media, selector) {
    const rule = media.rules.find(candidate => candidate.type === 'rule' && candidate.selectors.includes(selector));
    expect(rule).toBeDefined();
    return Object.fromEntries(rule.declarations
        .filter(declaration => declaration.type === 'declaration')
        .map(declaration => [declaration.property, declaration.value]));
}

function getRuleDeclarations(selector) {
    const rule = ast.stylesheet.rules.find(candidate => candidate.type === 'rule' && candidate.selectors.includes(selector));
    expect(rule).toBeDefined();
    return Object.fromEntries(rule.declarations
        .filter(declaration => declaration.type === 'declaration')
        .map(declaration => [declaration.property, declaration.value]));
}

describe('Conversation mobile controls', () => {
    test('44px touch targets apply to coarse pointers and the 1000px project mobile breakpoint', () => {
        const media = findMediaRule(query => query.includes('pointer: coarse') && query.includes('max-width: 1000px'));
        expect(media).toBeDefined();
        // Comma-separated query: either condition alone is sufficient.
        expect(media.media).toMatch(/\(pointer: coarse\)\s*,\s*\(max-width: 1000px\)/);

        expect(getDeclarations(media, '.sb-conversation-selfie-action')).toMatchObject({
            'min-block-size': 'var(--sb-mobile-touch-target, 44px)',
        });
        expect(getDeclarations(media, '.sb-conversation-reply-cancel')).toMatchObject({
            'inline-size': 'var(--sb-mobile-touch-target, 44px)',
            'block-size': 'var(--sb-mobile-touch-target, 44px)',
            'min-inline-size': 'var(--sb-mobile-touch-target, 44px)',
            'min-block-size': 'var(--sb-mobile-touch-target, 44px)',
        });
    });

    test('touch-target sizing is not confined to the 768px phone breakpoint', () => {
        const phoneMedia = findMediaRule(query => query.includes('max-width: 768px') && !query.includes('pointer: coarse'));
        expect(phoneMedia).toBeDefined();
        const phoneSelectors = phoneMedia.rules
            .filter(rule => rule.type === 'rule')
            .flatMap(rule => rule.selectors);
        expect(phoneSelectors).not.toContain('.sb-conversation-selfie-action');
        expect(phoneSelectors).not.toContain('.sb-conversation-reply-cancel');
    });

    test('edit controls override the base button color with semantic states', () => {
        expect(getRuleDeclarations('.sb-conversation-message-edit-save.menu_button')).toMatchObject({
            '--sb-conversation-edit-action-color': 'var(--sb-color-success)',
        });
        expect(getRuleDeclarations('.sb-conversation-message-edit-cancel.menu_button')).toMatchObject({
            '--sb-conversation-edit-action-color': 'var(--sb-color-warning)',
        });
        expect(getRuleDeclarations('.sb-conversation-message-edit-delete.menu_button')).toMatchObject({
            '--sb-conversation-edit-action-color': 'var(--sb-color-danger)',
        });
    });

    test('edit controls layer their tint over the themeable button background', () => {
        // Themes may define --sb-button-bg as a gradient, which color-mix() rejects outright,
        // so it has to stay its own background layer rather than become a mix operand.
        const selectors = [
            '.sb-conversation-message-edit-control.menu_button',
            '.sb-conversation-message-edit-control.menu_button:hover',
        ];

        for (const selector of selectors) {
            const background = getRuleDeclarations(selector).background;
            expect(background).toContain('var(--sb-button-bg)');
            expect(background.trim().endsWith('var(--sb-button-bg)')).toBe(true);
        }
    });
});

describe('Conversation messenger grouping styles', () => {
    const topLevelRules = ast.stylesheet.rules.filter(rule => rule.type === 'rule');
    const findRule = fragment => topLevelRules.find(rule => rule.selectors.some(selector => selector.includes(fragment)));
    const declarationsOf = rule => Object.fromEntries(rule.declarations
        .filter(declaration => declaration.type === 'declaration')
        .map(declaration => [declaration.property, declaration.value]));

    test('day labels render as a chip from the data attribute', () => {
        const rule = findRule('[data-sb-day-label]::before');
        expect(rule).toBeDefined();
        expect(declarationsOf(rule).content).toBe('attr(data-sb-day-label)');
    });

    test('only the last message of a run keeps its avatar', () => {
        const rule = findRule('[data-sb-run=\'middle\']) > .sb-conversation-message-avatar');
        expect(rule).toBeDefined();
        expect(rule.selectors.join(' ')).toContain('[data-sb-run=\'start\']');
        expect(rule.selectors.join(' ')).not.toContain('[data-sb-run=\'end\']');
        expect(declarationsOf(rule).visibility).toBe('hidden');
    });

    test('messenger rules leave the Windows 98 and XP shells alone', () => {
        const runRules = topLevelRules.filter(rule => rule.selectors.some(selector => selector.includes('[data-sb-run=')));
        expect(runRules.length).toBeGreaterThan(0);
        for (const rule of runRules) {
            for (const selector of rule.selectors) {
                expect(selector).toContain(':not([data-sb-theme=\'windows-98\'])');
                expect(selector).toContain(':not([data-sb-theme=\'windows-xp\'])');
            }
        }
    });
});
