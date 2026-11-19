import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ARTIFACT = /^release-e2e-result-(group-\d+|files-(?:noble|jammy))-(\d+)$/;
const OUTCOMES = ['expected', 'skipped', 'unexpected', 'flaky'];
const DETAIL_LIMIT = 50;

export function readReleaseReports(directory, commit) {
    if (!fs.existsSync(directory)) return new Map();
    const latest = new Map();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const match = ARTIFACT.exec(entry.name);
        if (!entry.isDirectory() || !match) continue;
        const [, job, attemptText] = match;
        const attempt = Number(attemptText);
        // A GitHub failed-job rerun uploads only the jobs that ran again.
        if ((latest.get(job)?.attempt ?? 0) >= attempt) continue;
        latest.set(job, { attempt, name: entry.name });
    }
    const reports = new Map();
    for (const [job, { attempt, name }] of latest) {
        const report = JSON.parse(fs.readFileSync(path.join(directory, name, 'result.json'), 'utf8'));
        if (report.commit !== commit || !Array.isArray(report.tests)
            || report.tests.some(test => !OUTCOMES.includes(test.outcome))) {
            throw new Error(`Invalid browser results in ${name} for ${commit}.`);
        }
        reports.set(job, { ...report, attempt });
    }
    return reports;
}

export function inlineCode(text) {
    const line = text.replace(/\s+/g, ' ').slice(0, 300);
    const delimiter = '`'.repeat(1 + Math.max(0, ...[...line.matchAll(/`+/g)].map(match => match[0].length)));
    return `${delimiter} ${line} ${delimiter}`;
}

export function summariseReleaseReports({ jobs, reports, prepareResult, matrixResult, commit }) {
    const output = ['## Release browser results', '', `Commit: ${inlineCode(commit)}`, ''];
    if (prepareResult !== 'success') {
        output.push('Browser preflight or planning did not complete successfully. See the preparation job log.');
        return { markdown: output.join('\n') + '\n', ok: false, complete: false };
    }

    const totals = Object.fromEntries(OUTCOMES.map(key => [key, 0]));
    const details = { unexpected: [], flaky: [] };
    const missing = [];
    const errors = [];
    const rows = [];
    for (const job of jobs) {
        const report = reports.get(job);
        if (!report) {
            missing.push(job);
            continue;
        }
        const counts = Object.fromEntries(OUTCOMES.map(key => [key, 0]));
        for (const test of report.tests) {
            counts[test.outcome]++;
            totals[test.outcome]++;
            details[test.outcome]?.push({ job, ...test });
        }
        if (report.runErrors || !report.tests.length || (report.status !== 'passed' && !counts.unexpected)) {
            errors.push(job);
        }
        rows.push(`| ${job} | ${counts.expected} | ${counts.skipped} | ${counts.flaky} | ${counts.unexpected} |`);
    }

    output.push('| Job | Passed as expected | Skipped / not run | Passed on retry | Failed |', '| --- | ---: | ---: | ---: | ---: | ---: |',
        ...rows, `| **Total** | **${totals.expected}** | **${totals.skipped}** | **${totals.flaky}** | **${totals.unexpected}** |`, '');
    if (missing.length) output.push(`No Playwright result for: ${missing.join(', ')}. Check runner and server setup logs.`, '');
    if (errors.length) output.push(`Incomplete run or errors outside individual tests: ${errors.join(', ')}. Check job logs.`, '');
    if (matrixResult !== 'success') output.push('At least one browser job did not succeed. Check the jobs even if all reported tests passed.', '');

    for (const [outcome, heading] of [['unexpected', 'Failed'], ['flaky', 'Flaky (passed on retry)']]) {
        const tests = details[outcome];
        if (!tests.length) continue;
        output.push(`### ${heading} (${tests.length})`, '');
        for (const { job, file, title, project } of tests.slice(0, DETAIL_LIMIT)) {
            output.push(`- ${inlineCode(`${file} › ${title.join(' › ')}`)} (${job}${project ? `, ${inlineCode(project)}` : ''})`);
        }
        if (tests.length > DETAIL_LIMIT) output.push(`- ${tests.length - DETAIL_LIMIT} more in the result artifacts.`);
        output.push('');
    }
    output.push('See `release-e2e-diagnostics-*` for HTML reports and failed-attempt traces, and `release-e2e-result-*` for all outcomes.', '');
    const complete = jobs.length > 0 && !missing.length && !errors.length
        && (matrixResult === 'success' || (matrixResult === 'failure' && totals.unexpected > 0));
    return {
        markdown: output.join('\n'),
        complete,
        ok: complete && matrixResult === 'success' && !totals.unexpected,
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { GITHUB_SHA, RELEASE_E2E_COMMIT = GITHUB_SHA, GITHUB_STEP_SUMMARY, RELEASE_E2E_MATRIX,
        PREPARE_RESULT: prepareResult, MATRIX_RESULT: matrixResult } = process.env;
    const commit = RELEASE_E2E_COMMIT;
    const reports = readReleaseReports(process.argv[2], commit);
    const jobs = RELEASE_E2E_MATRIX ? JSON.parse(RELEASE_E2E_MATRIX).include.map(job => job.id) : [];
    const { markdown, ok } = summariseReleaseReports({ jobs, reports, prepareResult, matrixResult, commit });
    fs.appendFileSync(GITHUB_STEP_SUMMARY, markdown);
    process.exitCode = ok ? 0 : 1;
}
