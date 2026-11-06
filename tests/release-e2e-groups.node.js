import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
    PINNED_FILES,
    TESTS_DIRECTORY,
    TIMINGS_PATH,
    collectTests,
    measureLogs,
    planGroups,
    sourceKeepsFileWhole,
    testListLines,
} from '../scripts/release-e2e-groups.js';

function listOf(files) {
    return {
        suites: Object.entries(files).map(([file, count]) => ({
            title: file,
            file,
            specs: [],
            suites: [{
                title: 'suite',
                file,
                specs: Array.from({ length: count }, (_, index) => ({ title: `case ${index + 1}`, file })),
            }],
        })),
        errors: [],
    };
}

const files = {
    'crash-diagnostics.e2e.js': 2,
    'huge.e2e.js': 40,
    'serial-huge.e2e.js': 10,
    'small-a.e2e.js': 3,
    'small-b.e2e.js': 5,
    'new-file.e2e.js': 4,
};
const timings = {
    files: {
        'crash-diagnostics.e2e.js': { seconds: 20, tests: 2 },
        'huge.e2e.js': { seconds: 2000, tests: 40 },
        'serial-huge.e2e.js': { seconds: 900, tests: 10 },
        'small-a.e2e.js': { seconds: 60, tests: 3 },
        'small-b.e2e.js': { seconds: 100, tests: 5 },
        'gone.e2e.js': { seconds: 500, tests: 5 },
    },
};
const tests = collectTests(listOf(files));
const keepWhole = file => file === 'serial-huge.e2e.js';

function keyOf(item) {
    return `${item.file}|${item.titles.join('|')}`;
}

test('every listed test lands in exactly one group', () => {
    const plan = planGroups({ tests, timings, total: 4, keepWhole });
    const seen = plan.groups.flatMap(group => group.units.flatMap(unit => unit.tests.map(keyOf)));
    assert.equal(seen.length, tests.length);
    assert.deepEqual(new Set(seen), new Set(tests.map(keyOf)));
});

test('the plan is the same every time it is computed', () => {
    const first = planGroups({ tests, timings, total: 4, keepWhole });
    const second = planGroups({ tests: [...tests], timings, total: 4, keepWhole });
    assert.deepEqual(first.groups.map(testListLines), second.groups.map(testListLines));
});

test('the crash diagnostics file stays in group 1, which runs on Ubuntu 22.04', () => {
    assert.deepEqual(PINNED_FILES, { 'crash-diagnostics.e2e.js': 1 });
    const plan = planGroups({ tests, timings, total: 4, keepWhole });
    assert.ok(testListLines(plan.groups[0]).includes('crash-diagnostics.e2e.js'));
    const workflow = fs.readFileSync(path.join(TESTS_DIRECTORY, '..', '.github', 'workflows', 'release-e2e.yml'), 'utf8');
    assert.match(workflow, /runs-on: \$\{\{ matrix\.shard == 1 && 'ubuntu-22\.04' \|\| 'ubuntu-24\.04' \}\}/);
    assert.match(workflow, /RELEASE_E2E_SHARD_TOTAL: 20\n/);
    assert.match(workflow, /--test-list="\$RUNNER_TEMP\/e2e-group\.txt"/);
});

test('a long file is cut into consecutive pieces, a file that shares state is not', () => {
    const plan = planGroups({ tests, timings, total: 4, keepWhole });
    const units = plan.groups.flatMap(group => group.units);
    const huge = units.filter(unit => unit.file === 'huge.e2e.js').sort((a, b) => a.piece - b.piece);
    assert.ok(huge.length > 1);
    assert.deepEqual(huge.flatMap(unit => unit.tests.map(item => item.titles[1])), Array.from({ length: 40 }, (_, index) => `case ${index + 1}`));
    const serial = units.filter(unit => unit.file === 'serial-huge.e2e.js');
    assert.equal(serial.length, 1);
    assert.equal(serial[0].whole, true);
});

test('groups come out close to the same length', () => {
    const plan = planGroups({ tests, timings, total: 4, keepWhole });
    const lengths = plan.groups.map(group => group.seconds);
    // The serial file (900 s) is the largest piece that cannot move, so it sets the floor.
    assert.ok(Math.max(...lengths) <= 900 + 1, lengths.join(', '));
    assert.ok(Math.min(...lengths) >= plan.targetSeconds * 0.6, lengths.join(', '));
});

test('a file without timings still gets planned, at the average time per test', () => {
    const plan = planGroups({ tests, timings, total: 4, keepWhole });
    const unit = plan.groups.flatMap(group => group.units).find(item => item.file === 'new-file.e2e.js');
    assert.ok(unit);
    const measured = Object.values(timings.files);
    const perTest = measured.reduce((sum, item) => sum + item.seconds, 0) / measured.reduce((sum, item) => sum + item.tests, 0);
    assert.equal(Math.round(unit.seconds), Math.round(perTest * 4));
});

test('test-list lines name whole files or full title paths', () => {
    const plan = planGroups({ tests, timings, total: 4, keepWhole });
    const lines = plan.groups.flatMap(testListLines);
    assert.ok(lines.includes('small-a.e2e.js'));
    assert.ok(lines.includes('huge.e2e.js \u203A suite \u203A case 1'));
    assert.ok(!lines.includes('huge.e2e.js'));
});

test('a title the test-list parser would misread keeps its file whole', () => {
    const odd = collectTests(listOf({ 'huge.e2e.js': 40 }));
    odd[3].titles[1] = 'a \u203A b';
    const plan = planGroups({ tests: odd, timings, total: 4 });
    const units = plan.groups.flatMap(group => group.units).filter(unit => unit.file === 'huge.e2e.js');
    assert.equal(units.length, 1);
    assert.equal(units[0].whole, true);
});

test('a listing error stops the plan instead of dropping tests', () => {
    assert.throws(() => collectTests({ suites: [], errors: [{ message: 'SyntaxError in broken.e2e.js' }] }), /broken\.e2e\.js/);
});

test('line-reporter logs become per-file timings averaged over runs', () => {
    const esc = '\u001b[2m';
    const log = [
        `2026-11-05T10:00:00.000Z ${esc}[1/3]\u001b[22m a.e2e.js:10:5 \u203A first`,
        '2026-11-05T10:00:30.000Z [2/3] a.e2e.js:20:5 \u203A second',
        '2026-11-05T10:01:00.000Z [3/3] frontend/b.e2e.js:5:1 \u203A only',
        '2026-11-05T10:03:00.000Z   3 passed (3.0m)',
    ].join('\n');
    const secondRun = [
        '2026-11-06T10:00:00.000Z [1/1] a.e2e.js:10:5 \u203A first',
        '2026-11-06T10:02:00.000Z   1 failed',
    ].join('\n');
    assert.deepEqual(measureLogs([[log], [secondRun]]), {
        files: {
            'a.e2e.js': { seconds: 90, tests: 2 },
            'frontend/b.e2e.js': { seconds: 120, tests: 1 },
        },
    });
});

test('the committed timings cover the pinned file and read as whole seconds', () => {
    const committed = JSON.parse(fs.readFileSync(TIMINGS_PATH, 'utf8'));
    assert.ok(committed.files['crash-diagnostics.e2e.js']);
    for (const [file, entry] of Object.entries(committed.files)) {
        assert.match(file, /\.e2e\.js$/);
        assert.ok(Number.isInteger(entry.seconds) && entry.seconds >= 0, file);
        assert.ok(Number.isInteger(entry.tests) && entry.tests > 0, file);
    }
});

test('files that share state between tests are recognised from their source', () => {
    assert.equal(sourceKeepsFileWhole('test.describe.configure({ mode: \'serial\' });'), true);
    assert.equal(sourceKeepsFileWhole('test.beforeAll(async () => {});'), true);
    assert.equal(sourceKeepsFileWhole('}, { scope: \'worker\' }],'), true);
    assert.equal(sourceKeepsFileWhole('test(\'plain\', async ({ page }) => {});'), false);
    for (const file of ['shell-style-persistence.e2e.js', 'pages-before-app.e2e.js']) {
        assert.equal(sourceKeepsFileWhole(fs.readFileSync(path.join(TESTS_DIRECTORY, file), 'utf8')), true, file);
    }
});
