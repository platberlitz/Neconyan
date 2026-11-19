import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readReleaseReports, summariseReleaseReports } from '../scripts/release-e2e-summary.js';

const commit = 'ad91fa2';
const result = (outcome, name) => ({ outcome, file: 'fixture.e2e.js', title: ['Fixture', name], project: '' });
const report = (tests, status = 'passed', runErrors = 0) => ({ commit, status, tests, runErrors });
const summary = (reports, overrides) => summariseReleaseReports({
    jobs: ['group-1', 'group-2'],
    reports: new Map(reports),
    prepareResult: 'success',
    matrixResult: 'success',
    commit,
    ...overrides,
});

test('the action summary separates persistent failures and flaky passes across groups', () => {
    const { markdown, ok } = summary([
        ['group-1', report([result('expected', 'first try'), result('flaky', 'back `on` retry')])],
        ['group-2', report([result('skipped', 'skipped'), result('unexpected', 'still broken')], 'failed')],
    ], { matrixResult: 'failure' });
    assert.equal(ok, false);
    assert.match(markdown, /\| \*\*Total\*\* \| \*\*1\*\* \| \*\*1\*\* \| \*\*1\*\* \| \*\*1\*\* \|/);
    assert.match(markdown, /### Failed \(1\)\n\n- ` fixture.e2e.js › Fixture › still broken ` \(group-2\)/);
    assert.match(markdown, /### Flaky \(passed on retry\) \(1\)\n\n- `` fixture.e2e.js › Fixture › back `on` retry `` \(group-1\)/);
});

test('flaky passes are visible and do not fail the release check', () => {
    const { markdown, ok } = summary([
        ['group-1', report([result('flaky', 'back on retry')])],
    ], { jobs: ['group-1'] });
    assert.equal(ok, true);
    assert.match(markdown, /Flaky \(passed on retry\) \(1\)/);
});

test('missing reports, runner failures and preflight failures cannot produce a green summary', () => {
    const incomplete = summary([['group-1', report([result('expected', 'first try')], 'failed', 1)]]);
    assert.equal(incomplete.ok, false);
    assert.match(incomplete.markdown, /No Playwright result for: group-2/);
    assert.match(incomplete.markdown, /errors outside individual tests: group-1/);

    const runnerFailure = summary([['group-1', report([result('expected', 'first try')])]], {
        jobs: ['group-1'],
        matrixResult: 'failure',
    });
    assert.equal(runnerFailure.ok, false);
    assert.match(runnerFailure.markdown, /At least one browser job did not succeed/);

    const preflight = summary([], { prepareResult: 'failure', matrixResult: 'skipped' });
    assert.equal(preflight.ok, false);
    assert.match(preflight.markdown, /preflight or planning did not complete/);
});

test('failed-job reruns retain other jobs and use the latest numeric attempt for each job', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-release-reports-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    function save(name, value) {
        const artifact = path.join(root, `release-e2e-result-${name}`);
        fs.mkdirSync(artifact);
        fs.writeFileSync(path.join(artifact, 'result.json'), JSON.stringify(value));
    }
    save('group-1-2', report([result('unexpected', 'earlier')], 'failed'));
    save('group-1-10', report([result('expected', 'latest')]));
    save('group-2-1', report([result('expected', 'preserved')]));
    const reports = readReleaseReports(root, commit);
    assert.equal(reports.get('group-1').attempt, 10);
    assert.equal(reports.get('group-2').attempt, 1);
    assert.equal(summary(reports).ok, true);
    assert.throws(() => readReleaseReports(root, 'wrong-commit'), /Invalid browser results/);
});
