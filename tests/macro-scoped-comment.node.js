import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMacroEnvironment, MacroRegistry } from '../src/macros/index.js';
import { SCOPED_COMMENT_CASES } from './fixtures/macro-scoped-comment-cases.js';
import { evaluateEveryExample, installFixedClock, readExampleUsageBaseline } from './fixtures/macro-example-usage.js';

function quietly(run) {
    const warn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
        return { value: run(), warnings };
    } finally {
        console.warn = warn;
    }
}

test('the scoped comment hides its text through the server macro registry', () => {
    for (const { name, input, after } of SCOPED_COMMENT_CASES) {
        assert.equal(quietly(() => createMacroEnvironment({}).evaluate(input)).value, after, name);
    }
});

test('rows that did not change keep their output from origin/staging', () => {
    const unchanged = SCOPED_COMMENT_CASES.filter(entry => !entry.changed);
    assert.ok(unchanged.length > 10);
    for (const { name, input, before } of unchanged) {
        assert.equal(quietly(() => createMacroEnvironment({}).evaluate(input)).value, before, name);
    }
});

test('the scoped comment also hides its text under strict server capabilities', () => {
    const env = createMacroEnvironment({});
    for (const [input, output] of [
        ['A{{//}}hidden{{///}}B', 'AB'],
        ['A{{//}}First\nSecond{{///}}B', 'AB'],
        ['A{{comment}}x{{/comment}}B', 'AB'],
        ['A{{// hidden}}B', 'AB'],
        ['{{//}}{{setvar::x::1}}{{///}}[{{getvar::x}}]', '[1]'],
    ]) {
        assert.equal(quietly(() => env.evaluate(input, { strictCapabilities: true })).value, output, input);
    }
});

test('a scoped comment and an inline comment run nested macros alike', () => {
    assert.equal(createMacroEnvironment({}).evaluate('{{//}}{{setvar::x::1}}{{///}}[{{getvar::x}}]'), '[1]');
    assert.equal(createMacroEnvironment({}).evaluate('{{// {{setvar::x::1}}}}[{{getvar::x}}]'), '[1]');
});

test('a lone opener keeps its arity warning and a stray closer stays silent', () => {
    const lone = quietly(() => createMacroEnvironment({}).evaluate('A{{//}}B'));
    assert.equal(lone.value, 'AB');
    assert.equal(lone.warnings.length, 1);
    assert.match(lone.warnings[0], /expects at least 1/);
    assert.deepEqual(quietly(() => createMacroEnvironment({}).evaluate('A{{///}}B')), { value: 'AB', warnings: [] });
    assert.deepEqual(quietly(() => createMacroEnvironment({}).evaluate('A{{//}}x{{///}}B')), { value: 'AB', warnings: [] });
});

test('every registered exampleUsage evaluates exactly as it did on origin/staging', () => {
    const restore = installFixedClock();
    try {
        const actual = evaluateEveryExample({ createMacroEnvironment, MacroRegistry });
        const baseline = readExampleUsageBaseline();
        assert.equal(Object.keys(baseline).length, 58);
        assert.deepEqual(Object.keys(actual).sort(), Object.keys(baseline).sort());
        // {{random::...}} seeds itself from real entropy, so only its set of possible answers is checked.
        const random = '{{random::blonde::brown::red::black::blue}}';
        assert.ok(['blonde', 'brown', 'red', 'black', 'blue'].includes(actual[random]), actual[random]);
        const differing = Object.keys(baseline).filter(example => example !== random && actual[example] !== baseline[example]);
        assert.deepEqual(differing, []);
    } finally {
        restore();
    }
});
