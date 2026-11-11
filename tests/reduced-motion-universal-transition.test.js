import { parse } from '@adobe/css-tools';
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const stylesheets = [
    {
        name: 'Neconyan theme',
        url: new URL('../public/css/neconyan-theme.css', import.meta.url),
    },
    {
        name: 'Terminal UI',
        url: new URL('../public/scripts/extensions/third-party/Neconyan-Terminal-UI/style.css', import.meta.url),
    },
].map(stylesheet => ({
    ...stylesheet,
    source: readFileSync(fileURLToPath(stylesheet.url), 'utf8').replace(/\r\n/g, '\n'),
}));

const bareUniversalTailPattern = /(?:^|[\s>+~])\*(?:::?(?:before|after))?$/i;
const reducedMotionQueryPattern = /prefers-reduced-motion\s*:\s*reduce/i;
const timeTokenPattern = /(?<![-\w])(\d*\.?\d+)(?:ms|s)\b/gi;

function visitRules(rules, mediaStack, visitor) {
    for (const rule of rules) {
        const nextMedia = rule.type === 'media' ? [...mediaStack, rule.media] : mediaStack;
        if (rule.type === 'rule') {
            visitor(rule, nextMedia);
        }
        if (Array.isArray(rule.rules)) {
            visitRules(rule.rules, nextMedia, visitor);
        }
    }
}

function hasNonZeroTime(value) {
    for (const match of value.matchAll(timeTokenPattern)) {
        if (Number.parseFloat(match[1]) !== 0) {
            return true;
        }
    }
    return false;
}

function auditUniversalTransitions(source, sourceName) {
    const ast = parse(source, { source: sourceName });
    const violations = [];
    const matchedDurationRules = [];

    visitRules(ast.stylesheet.rules, [], (rule, mediaStack) => {
        if (!rule.selectors?.some(selector => bareUniversalTailPattern.test(selector.trim()))) {
            return;
        }

        const declarations = (rule.declarations ?? []).filter(decl => decl.type === 'declaration');
        for (const declaration of declarations) {
            const property = declaration.property.toLowerCase();
            const value = declaration.value.trim().replace(/\s+/g, ' ');

            if (property === 'transition-duration' || property === '-webkit-transition-duration') {
                matchedDurationRules.push({
                    selectors: rule.selectors,
                    mediaStack,
                    declarations,
                });
                if (value !== '0s !important') {
                    violations.push(`${rule.selectors.join(', ')}: ${declaration.property}: ${declaration.value}`);
                }
            } else if ((property === 'transition' || property === '-webkit-transition') && hasNonZeroTime(value)) {
                violations.push(`${rule.selectors.join(', ')}: ${declaration.property}: ${declaration.value}`);
            }
        }
    });

    return { violations, matchedDurationRules };
}

describe('reduced-motion universal transition guards', () => {
    for (const { name, source } of stylesheets) {
        test(`${name} never gives universal selectors a non-zero transition duration`, () => {
            const { violations, matchedDurationRules } = auditUniversalTransitions(source, name);
            expect(violations).toEqual([]);
            expect(matchedDurationRules.length).toBeGreaterThan(0);
        });
    }

    test('preserves the theme reduced-motion animation and scroll guard alongside 0s transitions', () => {
        const themeSheet = stylesheets.find(sheet => sheet.name === 'Neconyan theme');
        const { matchedDurationRules } = auditUniversalTransitions(themeSheet.source, themeSheet.name);
        const reducedMotionRule = matchedDurationRules.find(rule =>
            rule.mediaStack.some(media => reducedMotionQueryPattern.test(media))
            && rule.selectors.includes('*')
            && rule.selectors.includes('*::before')
            && rule.selectors.includes('*::after'),
        );

        expect(reducedMotionRule).toBeDefined();
        const declarationMap = new Map(
            reducedMotionRule.declarations.map(decl => [
                decl.property.toLowerCase(),
                decl.value.trim().replace(/\s+/g, ' '),
            ]),
        );
        expect(declarationMap.get('transition-duration')).toBe('0s !important');
        expect(declarationMap.get('animation-duration')).toBe('0.01ms !important');
        expect(declarationMap.get('scroll-behavior')).toBe('auto !important');
    });

    test('covers both the class-gated and media-query universal rules in Terminal UI', () => {
        const terminalSheet = stylesheets.find(sheet => sheet.name === 'Terminal UI');
        const { matchedDurationRules } = auditUniversalTransitions(terminalSheet.source, terminalSheet.name);

        expect(matchedDurationRules).toHaveLength(2);
    });
});
