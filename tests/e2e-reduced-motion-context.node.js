import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'acorn';

const testsDir = new URL('./', import.meta.url);

const propertyName = property => property.type === 'Property' && !property.computed
    ? (property.key.name ?? property.key.value)
    : null;

// Playwright Test has no reducedMotion fixture, so test.use({ reducedMotion }) is silently
// ignored and the page keeps prefers-reduced-motion: no-preference. It has to go through
// contextOptions (or browser.newContext / page.emulateMedia).
function findIgnoredReducedMotionUses(source) {
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
    const found = [];
    const visit = node => {
        if (!node || typeof node.type !== 'string') {
            return;
        }
        if (node.type === 'CallExpression'
            && node.callee.type === 'MemberExpression'
            && !node.callee.computed
            && node.callee.property.name === 'use'
            && node.arguments[0]?.type === 'ObjectExpression'
            && node.arguments[0].properties.some(property => propertyName(property) === 'reducedMotion')) {
            found.push(node.loc.start.line);
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) {
                value.forEach(visit);
            } else if (value && typeof value === 'object') {
                visit(value);
            }
        }
    };
    visit(ast);
    return found;
}

test('the detector flags bare reducedMotion and accepts contextOptions', () => {
    assert.deepEqual(findIgnoredReducedMotionUses([
        'test.use({ serviceWorkers: \'block\', reducedMotion: \'reduce\' });',
        'test.describe(\'phone\', () => {',
        '    test.use({',
        '        viewport: { width: 393, height: 852 },',
        '        \'reducedMotion\': \'no-preference\',',
        '    });',
        '});',
    ].join('\n')), [1, 3]);
    assert.deepEqual(findIgnoredReducedMotionUses([
        'test.use({ serviceWorkers: \'block\', contextOptions: { reducedMotion: \'reduce\' } });',
        'test.describe(\'phone\', () => {',
        '    test.use({ viewport: { width: 393, height: 852 } });',
        '});',
        'const context = await browser.newContext({ reducedMotion: \'reduce\' });',
    ].join('\n')), []);
});

test('no test file passes reducedMotion to test.use outside contextOptions', () => {
    const files = readdirSync(testsDir).filter(name => name.endsWith('.js')).sort();
    assert.ok(files.some(name => name.endsWith('.e2e.js')), 'expected Playwright files in tests/');
    const offenders = [];
    for (const name of files) {
        const source = readFileSync(new URL(name, testsDir), 'utf8');
        if (!source.includes('reducedMotion')) {
            continue;
        }
        for (const line of findIgnoredReducedMotionUses(source)) {
            offenders.push(`tests/${name}:${line}`);
        }
    }
    assert.deepEqual(offenders, [], 'use test.use({ contextOptions: { reducedMotion } }) instead');
});
