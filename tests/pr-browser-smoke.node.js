import assert from 'node:assert/strict';
import test from 'node:test';
import { planPrBrowserTests } from '../scripts/pr-browser-smoke.js';

const smoke = ['catline-icons.e2e.js', 'neconyan-conversation-empty.e2e.js', 'mobile-app-layout.e2e.js'];
function plan({ changed = [], files = [], timings = {}, readSource = () => '' } = {}) {
    return planPrBrowserTests({
        changedPaths: changed,
        tests: [...smoke, ...files].map(file => ({ file })),
        timings: { files: timings },
        readSource,
    });
}

test('always runs the smoke files once, including the mobile layout check on CSS-only changes', () => {
    assert.deepEqual(plan({ changed: ['public/css/neconyan-mobile-shell.css', 'tests/helper.js'] }), {
        files: smoke, selected: [], deferred: [],
    });
    assert.deepEqual(plan({ changed: smoke.map(file => `tests/${file}`) }), {
        files: smoke, selected: [], deferred: [],
    });
});

test('adds whole changed files in budget order and scales a timing by the current test count', () => {
    const summary = plan({
        changed: ['tests/m/e2e.e2e.js', 'tests/old.e2e.js', 'tests/short.e2e.js', 'tests/short.e2e.js', 'tests/new.e2e.js'],
        files: ['m/e2e.e2e.js', 'old.e2e.js', 'short.e2e.js', 'new.e2e.js', 'm/e2e.e2e.js'],
        timings: { 'm/e2e.e2e.js': { seconds: 50, tests: 1 }, 'old.e2e.js': { seconds: 250, tests: 1 }, 'short.e2e.js': { seconds: 8, tests: 1 } },
    });
    assert.deepEqual(summary.files, [...smoke, 'short.e2e.js', 'new.e2e.js']);
    assert.deepEqual(summary.selected.map(({ seconds }) => seconds), [10, 25]);
    assert.deepEqual(summary.deferred.map(({ file }) => file), ['m/e2e.e2e.js', 'old.e2e.js']);
    assert.match(summary.deferred[0].reason, /100s/);
});

test('reports special fixtures and unlisted files instead of silently miscounting them', () => {
    const files = ['crash-diagnostics.e2e.js', 'mewmory.e2e.js', 'edge.e2e.js', 'a\nb.e2e.js'];
    const summary = plan({
        changed: [...files, 'unlisted.e2e.js'].map(file => `tests/${file}`),
        files,
        readSource: file => file === 'edge.e2e.js' ? 'chromium.launch({ channel: "msedge" })' : '',
    });
    assert.deepEqual(summary.files, smoke);
    assert.equal(summary.deferred.length, 5);
    assert.match(summary.deferred.find(({ file }) => file === 'unlisted.e2e.js').reason, /no tests listed/);
    assert.match(summary.deferred.find(({ file }) => file === 'edge.e2e.js').reason, /separate browser/);
});

test('fails closed if a required smoke file disappears from the inventory', () => {
    assert.throws(() => planPrBrowserTests({ tests: [], changedPaths: [], timings: {} }), /Required smoke test file not found/);
});
