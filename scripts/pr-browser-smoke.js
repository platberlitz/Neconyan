import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTests, PINNED_FILES, TESTS_DIRECTORY, testListNeedsEdge, TIMINGS_PATH } from './release-e2e-groups.js';
import { inlineCode } from './release-e2e-summary.js';

const SMOKE_FILES = ['catline-icons.e2e.js', 'neconyan-conversation-empty.e2e.js', 'mobile-app-layout.e2e.js'];
const CHANGED_FILE_BUDGET_SECONDS = 120;
const UNKNOWN_SECONDS_PER_TEST = 25;

export function planPrBrowserTests({ tests, changedPaths, timings, readSource }) {
    const counts = new Map();
    for (const { file } of tests) counts.set(file, (counts.get(file) ?? 0) + 1);
    for (const file of SMOKE_FILES) {
        if (!counts.has(file)) throw new Error(`Required smoke test file not found: ${file}`);
    }

    const changed = [...new Set(changedPaths
        .filter(file => file.startsWith('tests/') && file.endsWith('.e2e.js'))
        .map(file => file.slice('tests/'.length)))].sort();
    const candidates = [];
    const deferred = [];
    for (const file of changed) {
        if (SMOKE_FILES.includes(file)) continue;
        if (!counts.has(file)) {
            deferred.push({ file, reason: 'no tests listed by Playwright' });
        } else if (file.includes('\n') || file.includes('\r') || file.includes(' › ') || file !== file.trim()) {
            deferred.push({ file, reason: 'path cannot be represented in a Playwright test list' });
        } else if (Object.hasOwn(PINNED_FILES, file) || file === 'mewmory.e2e.js' || testListNeedsEdge([file], readSource)) {
            deferred.push({ file, reason: 'requires a separate browser, runner or fixture' });
        } else {
            const timing = timings.files?.[file];
            const perTest = timing?.seconds > 0 && timing.tests > 0 ? timing.seconds / timing.tests : UNKNOWN_SECONDS_PER_TEST;
            candidates.push({ file, seconds: Math.ceil(Math.max(10, perTest * counts.get(file))) });
        }
    }

    let remaining = CHANGED_FILE_BUDGET_SECONDS;
    const selected = [];
    for (const candidate of candidates.sort((a, b) => a.seconds - b.seconds)) {
        if (candidate.seconds <= remaining) {
            remaining -= candidate.seconds;
            selected.push(candidate);
        } else {
            deferred.push({ file: candidate.file, reason: `about ${candidate.seconds}s, over the remaining PR time budget` });
        }
    }
    return { files: [...SMOKE_FILES, ...selected.map(item => item.file)], selected, deferred };
}

function describePlan({ files, selected, deferred }) {
    return ['## PR browser coverage', '',
        ...files.map(file => {
            const changed = selected.find(item => item.file === file);
            return `- ${inlineCode(file)} (${changed ? `changed, about ${changed.seconds}s` : 'smoke set'})`;
        }), '',
        ...(deferred.length ? [
            '### Changed files not run here', '',
            ...deferred.map(({ file, reason }) => `- ${inlineCode(file)} (${reason})`), '',
            'Use a focused release-browser dispatch on the PR branch for files that need longer or another browser. The Mewmory suite uses its own disposable provider fixture.', '',
        ] : []),
        'This check does not replace nightly or release browser coverage.', '',
    ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [, , listFile, changesFile, outputFile] = process.argv;
    const plan = planPrBrowserTests({
        tests: collectTests(JSON.parse(fs.readFileSync(listFile, 'utf8'))),
        changedPaths: fs.readFileSync(changesFile, 'utf8').split('\0'),
        timings: JSON.parse(fs.readFileSync(TIMINGS_PATH, 'utf8')),
        readSource: file => fs.readFileSync(path.join(TESTS_DIRECTORY, file), 'utf8'),
    });
    fs.writeFileSync(outputFile, plan.files.join('\n') + '\n');
    const markdown = describePlan(plan);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');
    console.log(markdown);
}
