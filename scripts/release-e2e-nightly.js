import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RELEASE_GROUP_TOTAL } from './release-e2e-groups.js';
import { inlineCode, readReleaseReports, summariseReleaseReports } from './release-e2e-summary.js';

const DISPLAY_LIMIT = 35;
const SHA = /^[0-9a-f]{40}$/;

export function readNightlyState(file) {
    const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1 };
    if (state.version !== 1 || [state.lastTested, state.lastGreen, state.previousNight].some(run => run
        && (!SHA.test(run.commit) || !Number.isSafeInteger(run.id) || run.id < 1))
        || (state.previousNight && !Array.isArray(state.previousNight.flaky))) {
        throw new Error('Invalid nightly browser state.');
    }
    return state;
}

function testKey({ file, title, project }) {
    return createHash('sha256').update(JSON.stringify([file, title, project])).digest('hex');
}

function describeTest({ file, title, project }) {
    return inlineCode(`${file} › ${title.join(' › ')}${project ? ` (${project})` : ''}`);
}

export function measureNightlyReports(reports) {
    const files = new Map();
    for (const report of reports.values()) {
        for (const { file, outcome, attempts } of report.tests) {
            const attempt = attempts[0];
            if (outcome !== 'expected' || attempt?.status !== 'passed' || !Number.isFinite(attempt.durationMs) || attempt.durationMs <= 0) continue;
            const timing = files.get(file) || { milliseconds: 0, tests: 0 };
            timing.milliseconds += attempt.durationMs;
            timing.tests++;
            files.set(file, timing);
        }
    }
    return { files: Object.fromEntries([...files.keys()].sort().map(file => {
        const { milliseconds, tests } = files.get(file);
        return [file, { seconds: milliseconds / 1000, tests }];
    })) };
}

export function summariseNightly({ previous, run, jobs, reports, prepareResult, matrixResult, repositoryUrl, changes }) {
    const release = summariseReleaseReports({ jobs, reports, prepareResult, matrixResult, commit: run.commit });
    const full = jobs.length === RELEASE_GROUP_TOTAL && new Set(jobs).size === RELEASE_GROUP_TOTAL
        && jobs.every(id => /^group-(?:[1-9]|1\d|20)$/.test(id));
    const complete = full && release.complete;
    const tests = jobs.flatMap(id => reports.get(id)?.tests || []);
    const failed = tests.filter(test => test.outcome === 'unexpected');
    const flaky = tests.filter(test => test.outcome === 'flaky');
    const green = complete && release.ok && !flaky.length;
    const runUrl = id => `${repositoryUrl}/actions/runs/${id}`;

    // An older run can be re-run later. Its result must not replace newer state or issues.
    const current = Math.max(previous.lastTested?.id || 0, previous.previousNight?.id || 0, previous.lastGreen?.id || 0) <= run.id;
    const state = { ...previous };
    const recurring = [];
    if (current && (full || prepareResult !== 'success')) {
        if (complete) state.lastTested = run;
        if (green) {
            state.lastGreen = run;
            state.timings = measureNightlyReports(reports);
        }
        const earlier = previous.previousNight;
        if (complete && earlier && earlier.id !== run.id) {
            const priorKeys = new Set(earlier.flaky);
            for (const test of flaky) {
                const key = testKey(test);
                if (!priorKeys.has(key)) continue;
                priorKeys.delete(key);
                recurring.push({ key, title: `Flaky browser test: ${test.title.at(-1).replace(/\s+/g, ' ').slice(0, 200)}`,
                    body: `${describeTest(test)} passed only on retry in two consecutive staging nights.\n\n- [Earlier run](${runUrl(earlier.id)})\n- [Latest run](${runUrl(run.id)})\n\nSee the failed-attempt diagnostics in each run.\n` });
            }
        }
        state.previousNight = { ...run, flaky: complete ? [...new Set(flaky.map(testKey))] : [] };
    }

    const body = [
        `Latest: [staging browser run](${runUrl(run.id)}) at ${inlineCode(run.commit)}.`, '',
        green ? 'All tests passed as expected or were already skipped.'
            : complete ? `${failed.length} failed after retry; ${flaky.length} passed on retry.`
                : 'This was not a complete staging run. Check the job summary for missing groups or runner errors.', '',
    ];
    for (const [heading, matches] of [['Failed after retry', failed], ['Passed on retry', flaky]]) {
        if (!matches.length) continue;
        body.push(`### ${heading}`, '', ...matches.slice(0, DISPLAY_LIMIT).map(test => `- ${describeTest(test)}`));
        if (matches.length > DISPLAY_LIMIT) body.push(`- ${matches.length - DISPLAY_LIMIT} more in the run results.`);
        body.push('');
    }
    body.push('### Pull requests since the last clean night', '');
    if (previous.lastGreen) {
        body.push(`Baseline: [last clean run](${runUrl(previous.lastGreen.id)}) at ${inlineCode(previous.lastGreen.commit)}.`, '');
        if (changes === null) body.push('No comparable staging history is available.');
        else if (!changes.length) body.push('No staging merge commits with pull request numbers in this range.');
        else body.push(...changes.slice(0, DISPLAY_LIMIT).map(number => `- [#${number}](${repositoryUrl}/pull/${number})`),
            ...(changes.length > DISPLAY_LIMIT ? [`- [${changes.length - DISPLAY_LIMIT} more; compare commits](${repositoryUrl}/compare/${previous.lastGreen.commit}...${run.commit})`] : []));
    } else {
        body.push('No earlier clean nightly run is recorded yet.');
    }
    return { state, publish: current && (full || prepareResult !== 'success'), tracking: { body: body.join('\n') + '\n', green }, recurring };
}

export function mergedPullRequests(checkout, from, to) {
    const git = (args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    if (!SHA.test(from) || !SHA.test(to)) throw new Error('Expected commit SHAs.');
    try {
        git(['merge-base', '--is-ancestor', from, to]);
    } catch (error) {
        if (error.status === 1 || error.status === 128) return null;
        throw error;
    }
    const merges = git(['log', '--first-parent', '--format=%s', `${from}..${to}`]);
    return [...new Set([...merges.matchAll(/^(?:Merge pull request #(\d+)\b.*|.+ \(#(\d+)\))$/gm)].map(match => match[1] || match[2]))];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [results, prior, checkout, destination] = process.argv.slice(2);
    const { RELEASE_E2E_COMMIT: commit, RELEASE_E2E_MATRIX, PREPARE_RESULT: prepareResult, MATRIX_RESULT: matrixResult,
        GITHUB_RUN_ID, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_STEP_SUMMARY } = process.env;
    const previous = readNightlyState(prior);
    const run = { id: Number(GITHUB_RUN_ID), commit };
    const jobs = RELEASE_E2E_MATRIX ? JSON.parse(RELEASE_E2E_MATRIX).include.map(job => job.id) : [];
    const reports = readReleaseReports(results, commit);
    const changes = previous.lastGreen ? mergedPullRequests(checkout, previous.lastGreen.commit, commit) : [];
    const result = summariseNightly({ previous, run, jobs, reports, prepareResult, matrixResult, changes,
        repositoryUrl: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}` });
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'state.json'), JSON.stringify(result.state) + '\n');
    fs.writeFileSync(path.join(destination, 'issues.json'), JSON.stringify({ publish: result.publish, tracking: result.tracking, recurring: result.recurring }) + '\n');
    fs.appendFileSync(GITHUB_STEP_SUMMARY, `## Nightly tracking issue preview\n\n${result.tracking.body}\nRecurring flaky tests: ${result.recurring.length}.\n`);
}
