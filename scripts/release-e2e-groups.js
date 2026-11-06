#!/usr/bin/env node
// Splits the release browser suite into groups of similar running time.
//
// Playwright's --shard splits by test count, so a group that draws the slow
// files runs for over an hour while another finishes in minutes. This planner
// uses the measured time of each file instead and writes a --test-list file
// for one group. Every job computes the same plan from the same inputs.
//
//   node scripts/release-e2e-groups.js plan --list <list.json> --group <n> --total <n> [--out <file>]
//   node scripts/release-e2e-groups.js timings <log-dir>... [--out <file>]
//
// <list.json> is the output of `playwright test --list --reporter=json`, run
// from tests/. `timings` reads GitHub job logs written by the line reporter
// (one directory per run, one log per group) and refreshes the timings file.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TESTS_DIRECTORY = path.join(repoRoot, 'tests');
export const TIMINGS_PATH = path.join(TESTS_DIRECTORY, 'release-e2e-timings.json');

// crash-diagnostics.e2e.js includes a real renderer crash, which Chromium only
// reports on the Ubuntu 22.04 runner. The workflow runs group 1 there.
export const PINNED_FILES = Object.freeze({ 'crash-diagnostics.e2e.js': 1 });

// Files that share state between their tests cannot be split across groups.
const KEEP_WHOLE_SOURCE = /\bserial\b|\bbeforeAll\b|\bafterAll\b|scope:\s*['"]worker['"]/;
const TITLE_SEPARATOR = '\u203A';

/** Flattens Playwright's JSON list into { file, titles } entries in file order. */
export function collectTests(list) {
    const tests = [];
    const walk = (suite, titles) => {
        for (const spec of suite.specs || []) {
            tests.push({ file: spec.file, titles: [...titles, spec.title] });
        }
        for (const child of suite.suites || []) {
            walk(child, [...titles, child.title]);
        }
    };
    for (const fileSuite of list.suites || []) {
        walk(fileSuite, []);
    }
    if (list.errors?.length) {
        throw new Error(`Playwright could not list every test: ${list.errors.map(error => error.message).join('; ')}`);
    }
    return tests;
}

/** True when the file's source shares state between tests, so it must stay in one group. */
export function sourceKeepsFileWhole(source) {
    return KEEP_WHOLE_SOURCE.test(source);
}

// A title that the --test-list parser would read differently must not be listed one by one.
function titleIsListable(title) {
    return title !== '' && title === title.trim() && !title.includes(TITLE_SEPARATOR) && !title.includes('\n');
}

/**
 * Plans every group. Returns { groups: [{ seconds, units }], targetSeconds }.
 * A unit is a whole file, or a run of consecutive tests from one large file.
 */
export function planGroups({ tests, timings, total, keepWhole = () => false, pinned = PINNED_FILES }) {
    if (!Number.isInteger(total) || total < 1) {
        throw new Error(`The group total must be a positive whole number, not ${total}.`);
    }

    const files = new Map();
    for (const test of tests) {
        if (!files.has(test.file)) files.set(test.file, []);
        files.get(test.file).push(test);
    }

    const measured = Object.values(timings.files || {});
    const measuredSeconds = measured.reduce((sum, file) => sum + file.seconds, 0);
    const measuredTests = measured.reduce((sum, file) => sum + file.tests, 0);
    const defaultTestSeconds = measuredTests ? measuredSeconds / measuredTests : 15;

    const estimates = new Map();
    for (const [file, fileTests] of files) {
        const timing = timings.files?.[file];
        const perTest = timing && timing.tests > 0 ? timing.seconds / timing.tests : defaultTestSeconds;
        estimates.set(file, perTest * fileTests.length);
    }

    const totalSeconds = [...estimates.values()].reduce((sum, seconds) => sum + seconds, 0);
    const targetSeconds = totalSeconds / total;
    // Large files are cut into pieces of about half a group so the pieces pack evenly.
    const pieceSeconds = targetSeconds / 2;

    const units = [];
    for (const [file, fileTests] of files) {
        const seconds = estimates.get(file);
        const splittable = seconds > targetSeconds
            && fileTests.length > 1
            && !(file in pinned)
            && !keepWhole(file)
            && fileTests.every(test => test.titles.every(titleIsListable));
        if (!splittable) {
            units.push({ file, tests: fileTests, seconds, whole: true });
            continue;
        }
        const pieces = Math.min(fileTests.length, Math.ceil(seconds / pieceSeconds));
        for (let piece = 0; piece < pieces; piece++) {
            const start = Math.floor(piece * fileTests.length / pieces);
            const end = Math.floor((piece + 1) * fileTests.length / pieces);
            const pieceTests = fileTests.slice(start, end);
            units.push({ file, tests: pieceTests, seconds: seconds * pieceTests.length / fileTests.length, whole: false, piece: piece + 1, pieces });
        }
    }

    const groups = Array.from({ length: total }, () => ({ seconds: 0, units: [] }));
    const place = (unit, index) => {
        groups[index].units.push(unit);
        groups[index].seconds += unit.seconds;
    };

    for (const [file, group] of Object.entries(pinned)) {
        if (group < 1 || group > total) {
            throw new Error(`${file} is pinned to group ${group}, outside 1-${total}.`);
        }
    }

    const byFile = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.piece || 0) - (b.piece || 0));
    const free = [];
    for (const unit of units) {
        if (unit.file in pinned) place(unit, pinned[unit.file] - 1);
        else free.push(unit);
    }

    // Longest first, each into the group with the least work so far.
    free.sort((a, b) => b.seconds - a.seconds || byFile(a, b));
    for (const unit of free) {
        let lightest = 0;
        for (let index = 1; index < groups.length; index++) {
            if (groups[index].seconds < groups[lightest].seconds) lightest = index;
        }
        place(unit, lightest);
    }

    for (const group of groups) group.units.sort(byFile);

    const assigned = groups.reduce((sum, group) => sum + group.units.reduce((count, unit) => count + unit.tests.length, 0), 0);
    if (assigned !== tests.length) {
        throw new Error(`The plan covers ${assigned} of ${tests.length} tests.`);
    }

    return { groups, targetSeconds };
}

/** The --test-list lines for one group. */
export function testListLines(group) {
    const lines = [];
    for (const unit of group.units) {
        if (unit.whole) {
            lines.push(unit.file);
            continue;
        }
        for (const test of unit.tests) {
            lines.push([unit.file, ...test.titles].join(` ${TITLE_SEPARATOR} `));
        }
    }
    return lines;
}

export function describePlan({ groups }) {
    return groups.map((group, index) => {
        const tests = group.units.reduce((count, unit) => count + unit.tests.length, 0);
        const pieces = group.units.filter(unit => !unit.whole).map(unit => `${unit.file} (part ${unit.piece} of ${unit.pieces})`);
        const minutes = (group.seconds / 60).toFixed(1);
        return `Group ${index + 1}: about ${minutes} min, ${group.units.filter(unit => unit.whole).length} files, ${tests} tests${pieces.length ? `, plus ${pieces.join(', ')}` : ''}`;
    }).join('\n');
}

/**
 * Reads line-reporter job logs ("<ISO time> [n/N] file:line:col › title") and
 * returns { files: { [file]: { seconds, tests } } }, averaged over the runs.
 */
export function measureLogs(runs) {
    const start = /^(\S+Z) .*?\[(\d+)\/(\d+)\](?: \[[^\]]+\])? (\S+\.e2e\.js):\d+:\d+ › /;
    const finish = /^(\S+Z) .*\d+ (?:passed|failed)\b/;
    const totals = new Map();

    for (const logs of runs) {
        const runFiles = new Map();
        for (const text of logs) {
            const events = [];
            let end = null;
            for (const rawLine of text.split('\n')) {
                const line = rawLine.replace(/\u001b\[[0-9;]*m/g, '');
                const started = line.match(start);
                if (started) events.push({ time: Date.parse(started[1]), file: started[4] });
                const ended = events.length ? line.match(finish) : null;
                if (ended) end = Date.parse(ended[1]);
            }
            events.forEach((event, index) => {
                const next = index + 1 < events.length ? events[index + 1].time : (end ?? event.time);
                const entry = runFiles.get(event.file) || { seconds: 0, tests: 0 };
                entry.seconds += Math.max(0, (next - event.time) / 1000);
                entry.tests += 1;
                runFiles.set(event.file, entry);
            });
        }
        for (const [file, entry] of runFiles) {
            const total = totals.get(file) || { seconds: 0, tests: 0, runs: 0 };
            total.seconds += entry.seconds;
            total.tests += entry.tests;
            total.runs += 1;
            totals.set(file, total);
        }
    }

    const files = {};
    for (const file of [...totals.keys()].sort()) {
        const total = totals.get(file);
        files[file] = { seconds: Math.round(total.seconds / total.runs), tests: Math.round(total.tests / total.runs) };
    }
    return { files };
}

function readOption(args, name) {
    const index = args.indexOf(name);
    if (index === -1) return undefined;
    const value = args[index + 1];
    args.splice(index, 2);
    return value;
}

function main(argv) {
    const args = [...argv];
    const command = args.shift();

    if (command === 'plan') {
        const listPath = readOption(args, '--list');
        const group = Number(readOption(args, '--group'));
        const total = Number(readOption(args, '--total'));
        const out = readOption(args, '--out');
        if (!listPath || !Number.isInteger(group) || group < 1 || group > total) {
            throw new Error('Usage: plan --list <list.json> --group <n> --total <n> [--out <file>]');
        }
        const tests = collectTests(JSON.parse(fs.readFileSync(listPath, 'utf8')));
        const timings = JSON.parse(fs.readFileSync(TIMINGS_PATH, 'utf8'));
        const keepWhole = file => sourceKeepsFileWhole(fs.readFileSync(path.join(TESTS_DIRECTORY, file), 'utf8'));
        const plan = planGroups({ tests, timings, total, keepWhole });
        console.log(describePlan(plan));
        const lines = testListLines(plan.groups[group - 1]);
        if (out) {
            fs.writeFileSync(out, `${lines.join('\n')}\n`);
            console.log(`Wrote ${lines.length} lines for group ${group} to ${out}.`);
        } else {
            console.log(lines.join('\n'));
        }
        return;
    }

    if (command === 'timings') {
        const out = readOption(args, '--out') || TIMINGS_PATH;
        if (!args.length) throw new Error('Usage: timings <log-dir>... [--out <file>]');
        const runs = args.map(directory => fs.readdirSync(directory)
            .filter(name => name.endsWith('.log'))
            .map(name => fs.readFileSync(path.join(directory, name), 'utf8')));
        const measured = measureLogs(runs);
        fs.writeFileSync(out, `${JSON.stringify(measured, null, 4)}\n`);
        console.log(`Wrote timings for ${Object.keys(measured.files).length} files to ${out}.`);
        return;
    }

    throw new Error('Usage: release-e2e-groups.js plan|timings ...');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}
