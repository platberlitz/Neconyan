import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { mergedPullRequests, readNightlyState, summariseNightly } from '../scripts/release-e2e-nightly.js';

const jobs = Array.from({ length: 20 }, (_, i) => `group-${i + 1}`);
const fixture = (outcome, file = 'fixture.e2e.js', project = '') => ({
    file, title: ['Fixture', 'preserves `things`'], project, outcome,
    attempts: outcome === 'flaky' ? [{ status: 'failed', durationMs: 2500 }, { status: 'passed', durationMs: 1100 }]
        : [{ status: outcome === 'expected' ? 'passed' : outcome === 'skipped' ? 'skipped' : 'failed', durationMs: 1250 }],
});
const commit = digit => digit.repeat(40);
const repo = 'https://github.com/example/Neconyan';

function nightly(id, previous, replacements = [], overrides = {}) {
    const reports = new Map(jobs.map((job, i) => [job, { tests: [fixture('expected', `fixture-${i}.e2e.js`)], status: 'passed', runErrors: 0 }]));
    for (const [job, tests, status = 'passed'] of replacements) reports.set(job, { tests, status, runErrors: 0 });
    return summariseNightly({ run: { id, commit: commit(String(id % 10)) }, previous, reports, jobs,
        prepareResult: 'success', matrixResult: 'success', changes: [], repositoryUrl: repo, ...overrides });
}

test('a clean full run sets the skip commit, comparison baseline and measured first-attempt timings', () => {
    const result = nightly(11, { version: 1 }, [
        ['group-1', [fixture('expected'), fixture('skipped')]], ['group-2', [fixture('expected')]],
    ]);
    assert.equal(result.publish, true);
    assert.equal(result.tracking.green, true);
    assert.deepEqual(result.state.lastGreen, { id: 11, commit: commit('1') });
    assert.deepEqual(result.state.lastTested, result.state.lastGreen);
    assert.deepEqual(result.state.timings.files['fixture.e2e.js'], { seconds: 2.5, tests: 2 });
    assert.match(result.tracking.body, /No earlier clean nightly run/);
});

test('red and flaky nights keep the last clean baseline and only report matching tests on consecutive nights', () => {
    const { state: clean } = nightly(11, { version: 1 });
    const flaky = fixture('flaky', 'match.e2e.js', 'webkit');
    const { state: first, recurring: firstRecurring } = nightly(12, clean, [['group-1', [flaky]]]);
    assert.equal(firstRecurring.length, 0);
    assert.deepEqual(first.lastGreen, clean.lastGreen);
    assert.deepEqual(first.timings, clean.timings);
    const second = nightly(13, first, [
        ['group-1', [fixture('flaky', 'match.e2e.js', 'chromium'), flaky, flaky]],
        ['group-2', [fixture('unexpected', 'repeat.e2e.js')], 'failed'],
    ], { matrixResult: 'failure', changes: ['123', '124'] });
    assert.equal(second.tracking.green, false);
    assert.equal(second.state.lastTested.id, 13);
    assert.equal(second.recurring.length, 1);
    assert.match(second.recurring[0].body, /\(webkit\)/);
    assert.match(second.recurring[0].body, /actions\/runs\/12/);
    assert.match(second.recurring[0].body, /actions\/runs\/13/);
    assert.match(second.tracking.body, /\[#123\].*\/pull\/123/);
    assert.match(second.tracking.body, /`` match.e2e.js › Fixture › preserves `things` \(webkit\) ``/);
});

test('partial previews and stale reruns cannot change saved state or publish', () => {
    const { state } = nightly(13, { version: 1 });
    for (const result of [nightly(14, state, [], { jobs: ['group-1'] }), nightly(12, state)]) {
        assert.equal(result.publish, false);
        assert.deepEqual(result.state, state);
    }
    const { state: flakyState } = nightly(14, state, [['group-1', [fixture('flaky')]]]);
    assert.equal(nightly(14, flakyState, [['group-1', [fixture('flaky')]]]).recurring.length, 0);
});

test('an incomplete night can report runner trouble without saving incomplete timings or suppressing a retry', () => {
    const { state } = nightly(13, { version: 1 }, [['group-1', [fixture('flaky')]]]);
    const incomplete = nightly(14, state, [], { reports: new Map(), matrixResult: 'failure' });
    assert.equal(incomplete.publish, true);
    assert.equal(incomplete.state.lastTested.id, 13);
    assert.match(incomplete.tracking.body, /not a complete staging run/);
    assert.equal(nightly(15, incomplete.state, [['group-1', [fixture('flaky')]]]).recurring.length, 0);
    const preflight = nightly(14, state, [], { jobs: [], prepareResult: 'failure', matrixResult: 'skipped' });
    assert.equal(preflight.publish, true);
    assert.equal(preflight.state.lastTested.id, 13);
    assert.equal(nightly(15, preflight.state, [['group-1', [fixture('flaky')]]]).recurring.length, 0);
});

test('the comparison follows staging first-parent history and picks up GitHub merge and squash subjects', t => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-nightly-history-'));
    t.after(() => fs.rmSync(checkout, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', ['-C', checkout, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q', '-b', 'staging');
    git('commit', '-qm', 'base', '--allow-empty');
    const base = git('rev-parse', 'HEAD');
    git('switch', '-qc', 'topic');
    git('commit', '-qm', 'do not count a topic commit (#9)', '--allow-empty');
    const topic = git('rev-parse', 'HEAD');
    git('switch', '-q', 'staging');
    git('commit', '-qm', 'squashed feature (#10)', '--allow-empty');
    const squash = git('rev-parse', 'HEAD');
    git('merge', '--no-ff', '-qm', 'Merge pull request #11 from example/topic', 'topic');
    git('commit', '-qm', 'ordinary commit', '--allow-empty');
    const head = git('rev-parse', 'HEAD');
    assert.deepEqual(mergedPullRequests(checkout, base, head), ['11', '10']);
    assert.equal(mergedPullRequests(checkout, topic, squash), null);
    assert.equal(mergedPullRequests(checkout, commit('0'), head), null);
});

test('nightly state is optional on first run and rejects an invalid saved baseline', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-nightly-state-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'state.json');
    assert.deepEqual(readNightlyState(file), { version: 1 });
    fs.writeFileSync(file, JSON.stringify({ version: 1, lastGreen: { id: 10, commit: 'not-a-sha' } }));
    assert.throws(() => readNightlyState(file), /Invalid nightly browser state/);
});
