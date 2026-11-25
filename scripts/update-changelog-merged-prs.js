#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const changelogPath = path.join(repoRoot, 'changelog.md');
const packagePath = path.join(repoRoot, 'package.json');
const fragmentsDirName = 'changelog.d';
const fragmentsPath = path.join(repoRoot, fragmentsDirName);

const mergedPrHeading = '### Merged Staging PRs';
const highlightsHeading = '### Highlights';
const stagingBranch = 'staging';
const recentPrLimit = 1000;

function printHelp() {
    console.log(`Usage: node scripts/update-changelog-merged-prs.js [--pr <number>] [--pr <number>] [--version <version>] [--dry-run]

Adds merged staging pull requests to the current changelog version section.
Moves each changelog.d/<branch-name>.md line into that section's Highlights and
removes the file. Also records staging PRs that an earlier run missed, found
through gh pr list.

Options:
  --pr <number>       Pull request number to record. Can be repeated or comma-separated.
                      Defaults to merged PRs found in the GitHub event payload.
  --version <version> Changelog version heading to update. Defaults to package.json version.
  --dry-run           Report whether changelog.md would change without writing or removing anything.
  --help              Show this help text.
`);
}

function parseArgs(argv) {
    const options = {
        dryRun: false,
        help: false,
        prNumbers: [],
        version: undefined,
    };

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];

        if (arg === '--dry-run') {
            options.dryRun = true;
            continue;
        }

        if (arg === '--help' || arg === '-h') {
            options.help = true;
            continue;
        }

        if (arg === '--pr') {
            const value = readArgValue(argv, ++index, arg);
            options.prNumbers.push(...value.split(','));
            continue;
        }

        if (arg === '--version') {
            options.version = readArgValue(argv, ++index, arg);
            continue;
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    const eventPrNumbers = readEventPrNumbers();
    if (!options.prNumbers.length && eventPrNumbers.length) {
        options.prNumbers.push(...eventPrNumbers);
    }

    return options;
}

function readArgValue(argv, index, flag) {
    const value = argv[index];
    if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${flag}`);
    }

    return value;
}

function readEventPrNumbers() {
    const prNumbers = [];

    if (process.env.CHANGELOG_PR_NUMBER) {
        prNumbers.push(...process.env.CHANGELOG_PR_NUMBER.split(','));
    }

    if (!process.env.GITHUB_EVENT_PATH || !fs.existsSync(process.env.GITHUB_EVENT_PATH)) {
        return prNumbers;
    }

    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));

    if (event.pull_request?.number) {
        prNumbers.push(String(event.pull_request.number));
    }

    const commits = [...(event.commits || [])];
    if (event.head_commit) {
        commits.push(event.head_commit);
    }

    for (const commit of commits) {
        prNumbers.push(...extractMergedPrNumbers(commit.message));
    }

    return prNumbers;
}

export function extractMergedPrNumbers(message) {
    const numbers = new Set();
    const text = String(message || '');

    for (const match of text.matchAll(/^Merge pull request #(\d+)\b/gm)) {
        numbers.add(match[1]);
    }

    const [subject = ''] = text.split(/\r?\n/, 1);
    const squashMatch = /\(#(\d+)\)\s*$/.exec(subject);
    if (squashMatch) {
        numbers.add(squashMatch[1]);
    }

    return [...numbers];
}

function normalizePrNumbers(values) {
    const numbers = new Set();

    for (const value of values) {
        const trimmed = String(value).trim();
        if (!trimmed) {
            continue;
        }

        const number = Number.parseInt(trimmed, 10);
        if (!Number.isInteger(number) || number <= 0 || String(number) !== trimmed) {
            throw new Error(`Invalid pull request number: ${value}`);
        }

        numbers.add(number);
    }

    return [...numbers];
}

function readPackageVersion() {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (!pkg.version) {
        throw new Error('package.json does not define a version.');
    }

    return pkg.version;
}

function normalizeVersion(value) {
    const version = String(value).trim();
    return version.startsWith('v') ? version : `v${version}`;
}

function runGhJson(args) {
    try {
        const output = execFileSync('gh', args, {
            cwd: repoRoot,
            encoding: 'utf8',
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        return JSON.parse(output);
    } catch (error) {
        const stderr = error.stderr?.toString().trim();
        const detail = stderr ? `: ${stderr}` : '';
        throw new Error(`Failed to read pull request metadata with gh${detail}`);
    }
}

function fetchPullRequest(number) {
    return runGhJson([
        'pr',
        'view',
        String(number),
        '--json',
        'number,title,mergedAt,baseRefName,mergeCommit,url',
    ]);
}

function filterMergedStagingPrs(prs) {
    return prs.filter((pr) => {
        if (!pr.mergedAt) {
            console.log(`Skipping PR #${pr.number}: it has not been merged.`);
            return false;
        }

        if (pr.baseRefName !== stagingBranch) {
            console.log(`Skipping PR #${pr.number}: base branch is ${pr.baseRefName}, not ${stagingBranch}.`);
            return false;
        }

        return true;
    });
}

function escapeInlineCode(value) {
    return String(value).replace(/`/g, '\'').replace(/\s+/g, ' ').trim();
}

function formatPrEntry(pr) {
    const date = pr.mergedAt.slice(0, 10);
    return `- PR #${pr.number} (${date}) \`${escapeInlineCode(pr.title)}\``;
}

function parseVersionNumbers(value) {
    const match = /^v?(\d+(?:\.\d+)*)$/.exec(String(value).trim());
    return match ? match[1].split('.').map(Number) : null;
}

function compareVersionNumbers(left, right) {
    const length = Math.max(left.length, right.length);

    for (let index = 0; index < length; index++) {
        const difference = (left[index] || 0) - (right[index] || 0);
        if (difference !== 0) {
            return difference < 0 ? -1 : 1;
        }
    }

    return 0;
}

function findCurrentVersionHeading(changelog, version) {
    const headingPattern = /(^|\r?\n)## ([^\r\n]+)\r?\n/g;
    const currentNumbers = parseVersionNumbers(version);

    for (const match of changelog.matchAll(headingPattern)) {
        const heading = match[2].trim();
        const headingNumbers = parseVersionNumbers(heading);

        // The current block sits above the newest released section. Older legacy
        // sections further down the file can repeat a version number.
        if (currentNumbers && headingNumbers && compareVersionNumbers(headingNumbers, currentNumbers) < 0) {
            return null;
        }

        if (heading === version) {
            return match;
        }
    }

    return null;
}

function mergePrLines(existingText, prs) {
    const byNumber = new Map();

    for (const line of existingText.split(/\r?\n/)) {
        const trimmed = line.trim();
        const match = /^- PR #(\d+)\b/.exec(trimmed);

        if (match) {
            byNumber.set(Number(match[1]), trimmed);
        }
    }

    for (const pr of prs) {
        const number = Number(pr.number);
        if (!byNumber.has(number)) {
            byNumber.set(number, formatPrEntry(pr));
        }
    }

    return [...byNumber.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, line]) => line);
}

function collapseWhitespace(value) {
    return String(value).replace(/\s+/g, ' ').trim();
}

// Finds the bullet list under '### Highlights' in a version block. Like What's new,
// the heading is matched in any case and the list ends at the next heading of level 1 to 3.
function findHighlightsList(block) {
    const heading = /(^|\n)### Highlights[ \t]*\r?\n/i.exec(block);
    if (!heading) {
        return null;
    }

    const start = heading.index + heading[0].length;
    const next = /(^|\n)#{1,3} /.exec(block.slice(start));
    const end = next ? start + next.index + next[1].length : block.length;

    return { eol: heading[0].endsWith('\r\n') ? '\r\n' : '\n', start, end };
}

// Returns the offset just after the last bullet of a list and its continuation lines.
function findListAppendOffset(text) {
    let offset = 0;
    let appendAt = 0;
    let inBullet = false;

    for (const line of text.split('\n')) {
        const lineEnd = offset + line.length + 1;
        const content = line.replace(/\r$/, '');

        if (/^[-*] +/.test(content)) {
            inBullet = true;
            appendAt = lineEnd;
        } else if (inBullet && /^\s+\S/.test(content)) {
            appendAt = lineEnd;
        } else if (content.trim()) {
            inBullet = false;
        }

        offset = lineEnd;
    }

    return Math.min(appendAt, text.length);
}

function readHighlightBullets(block) {
    const list = findHighlightsList(block);
    const items = [];

    if (!list) {
        return items;
    }

    for (const line of block.slice(list.start, list.end).split(/\r?\n/)) {
        const bullet = /^[-*] +(.*)$/.exec(line);
        if (bullet) {
            items.push(bullet[1]);
        } else if (items.length && /^\s+\S/.test(line)) {
            items[items.length - 1] += ` ${line}`;
        }
    }

    return items.map(collapseWhitespace);
}

function insertHighlights(block, lines) {
    if (!lines.length) {
        return block;
    }

    const list = findHighlightsList(block);

    if (list) {
        const text = block.slice(list.start, list.end);
        const at = findListAppendOffset(text);
        const bullets = lines.map((line) => `- ${line}`).join(list.eol);
        const insertion = at > 0 && text[at - 1] !== '\n' ? `${list.eol}${bullets}` : `${bullets}${list.eol}`;
        const insertAt = list.start + at;
        return block.slice(0, insertAt) + insertion + block.slice(insertAt);
    }

    const section = `${highlightsHeading}\n${lines.map((line) => `- ${line}`).join('\n')}\n`;
    const firstHeading = /(^|\n)### /.exec(block);

    if (firstHeading) {
        const insertAt = firstHeading.index + firstHeading[1].length;
        return `${block.slice(0, insertAt)}${section}\n${block.slice(insertAt)}`;
    }

    return `${block.replace(/\s*$/, '\n\n')}${section}`;
}

function updateVersionBlock(block, prs, highlights = []) {
    const withHighlights = insertHighlights(block, highlights);
    const sectionPattern = /(^|\n)### Merged Staging PRs\r?\n([\s\S]*?)(?=\r?\n### |\r?\n## |$)/;
    const match = sectionPattern.exec(withHighlights);

    if (match) {
        const nextLines = mergePrLines(match[2], prs);
        const replacement = `${mergedPrHeading}\n${nextLines.join('\n')}\n`;
        const start = match.index + match[1].length;
        return withHighlights.slice(0, start) + replacement + withHighlights.slice(match.index + match[0].length);
    }

    // Lines for Highlights alone do not need an empty Merged Staging PRs section.
    if (!prs.length && highlights.length) {
        return withHighlights;
    }

    const entries = mergePrLines('', prs);
    const section = `${mergedPrHeading}\n${entries.join('\n')}\n\n`;
    const localCommits = /(^|\n)### Local Commits/.exec(withHighlights);

    if (localCommits) {
        const insertAt = localCommits.index + localCommits[1].length;
        return withHighlights.slice(0, insertAt) + section + withHighlights.slice(insertAt);
    }

    return `${withHighlights.replace(/\s*$/, '\n\n')}${section}`;
}

function createVersionBlock(version, prs, highlights = []) {
    const parts = [`## ${version}`];

    if (highlights.length) {
        parts.push(`${highlightsHeading}\n${highlights.map((line) => `- ${line}`).join('\n')}`);
    }

    if (prs.length || !highlights.length) {
        const entries = mergePrLines('', prs);
        parts.push(`${mergedPrHeading}\n${entries.join('\n')}`);
    }

    return `${parts.join('\n\n')}\n`;
}

function insertMissingVersionBlock(changelog, version, prs, highlights = []) {
    const block = `${createVersionBlock(version, prs, highlights)}\n`;
    const titleMatch = /^# Changelog\r?\n/.exec(changelog);

    if (!titleMatch) {
        return `${block}${changelog.replace(/^\s*/, '')}`;
    }

    const insertAt = titleMatch[0].length;
    const rest = changelog.slice(insertAt).replace(/^\r?\n/, '');
    return `${changelog.slice(0, insertAt)}\n${block}${rest}`;
}

function locateVersionBlock(changelog, version) {
    const versionHeadingMatch = findCurrentVersionHeading(changelog, version);

    if (!versionHeadingMatch) {
        return null;
    }

    const versionStart = versionHeadingMatch.index + versionHeadingMatch[1].length;
    const versionHeadingEnd = versionStart + versionHeadingMatch[0].length - versionHeadingMatch[1].length;
    const nextVersionMatch = /\r?\n## /.exec(changelog.slice(versionHeadingEnd));
    const versionEnd = nextVersionMatch ? versionHeadingEnd + nextVersionMatch.index : changelog.length;

    return { versionStart, versionEnd, block: changelog.slice(versionStart, versionEnd) };
}

// Drops lines already in the current version's Highlights, and repeats within the list.
export function findNewHighlights(changelog, version, lines) {
    const located = locateVersionBlock(changelog, version);
    const seen = new Set(located ? readHighlightBullets(located.block) : []);
    const fresh = [];

    for (const line of lines) {
        const key = collapseWhitespace(line);
        if (!seen.has(key)) {
            seen.add(key);
            fresh.push(line);
        }
    }

    return fresh;
}

export function updateChangelog(changelog, version, prs, highlights = []) {
    const located = locateVersionBlock(changelog, version);
    const lines = findNewHighlights(changelog, version, highlights);

    if (!located) {
        return insertMissingVersionBlock(changelog, version, prs, lines);
    }

    const updatedBlock = updateVersionBlock(located.block, prs, lines);

    return changelog.slice(0, located.versionStart) + updatedBlock + changelog.slice(located.versionEnd);
}

// Turns the text of a fragment file into one line for Highlights. An empty result means the file holds nothing.
export function normaliseFragment(text) {
    const flat = String(text)
        .replace(/^\uFEFF/, '')
        .replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ')
        .trim();

    return flat.replace(/^[-*] /, '').trim();
}

function readFragments() {
    if (!fs.existsSync(fragmentsPath)) {
        return [];
    }

    return fs.readdirSync(fragmentsPath, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => entry.name)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .map((name) => ({
            file: `${fragmentsDirName}/${name}`,
            text: normaliseFragment(fs.readFileSync(path.join(fragmentsPath, name), 'utf8')),
        }));
}

// git rm stages the deletion, so the workflow's commit step includes it with changelog.md.
function removeFragments(files) {
    if (!files.length) {
        return;
    }

    try {
        execFileSync('git', ['--literal-pathspecs', 'rm', '-q', '-f', '--ignore-unmatch', '--', ...files], {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (error) {
        const stderr = error.stderr?.toString().trim();
        console.warn(`Warning: could not remove ${fragmentsDirName} files${stderr ? `: ${stderr}` : '.'}`);
    }
}

function collectPrLines(section) {
    const entries = [];

    for (const match of section.matchAll(/^- PR #(\d+) \((\d{4}-\d{2}-\d{2})\)/gm)) {
        entries.push({ number: Number(match[1]), date: match[2] });
    }

    return entries;
}

// The anchor is the first section below the current version's heading that lists PRs
// (the first such section in the file when the current heading is missing).
export function findRestoreWindow(changelog, version) {
    const current = findCurrentVersionHeading(changelog, version);
    const currentStart = current ? current.index + current[1].length : -1;
    const headings = [...changelog.matchAll(/^## [^\r\n]*/gm)]
        .filter((match) => match.index > currentStart);

    for (let index = 0; index < headings.length; index++) {
        const end = index + 1 < headings.length ? headings[index + 1].index : changelog.length;
        const entries = collectPrLines(changelog.slice(headings[index].index, end));

        if (entries.length) {
            return {
                heading: headings[index][0].slice(3).trim(),
                highestNumber: Math.max(...entries.map((entry) => entry.number)),
                since: entries.map((entry) => entry.date).reduce((newest, date) => (date > newest ? date : newest)),
            };
        }
    }

    return null;
}

export function selectRestorablePrs(prs, changelog, highestNumber) {
    const recorded = new Set(collectPrLines(changelog).map((entry) => entry.number));

    return prs
        .filter((pr) => pr.mergedAt
            && pr.baseRefName === stagingBranch
            && Number(pr.number) > highestNumber
            && !recorded.has(Number(pr.number)))
        .sort((left, right) => Number(left.number) - Number(right.number));
}

function listRecentMergedPrs(since) {
    try {
        const prs = runGhJson([
            'pr',
            'list',
            '--base',
            stagingBranch,
            '--state',
            'merged',
            '--search',
            `merged:>=${since}`,
            '--limit',
            String(recentPrLimit),
            '--json',
            'number,title,mergedAt,baseRefName',
        ]);

        if (prs.length >= recentPrLimit) {
            console.warn(`Warning: gh returned ${recentPrLimit} merged PRs, so the list may be cut short.`);
        }

        return prs;
    } catch (error) {
        console.warn(`Warning: could not list recent merged PRs, so none were recovered. ${error instanceof Error ? error.message : String(error)}`);
        return [];
    }
}

function recoverMissedPrs(changelog, version) {
    const window = findRestoreWindow(changelog, version);

    if (!window) {
        console.log('No earlier section lists merged PRs, so nothing was recovered.');
        return [];
    }

    const restored = selectRestorablePrs(listRecentMergedPrs(window.since), changelog, window.highestNumber);
    if (restored.length) {
        console.log(`Recovering ${restored.length} merged PR(s) missing since ${window.heading}: ${restored.map((pr) => `#${pr.number}`).join(', ')}.`);
    }

    return restored;
}

function main() {
    try {
        const options = parseArgs(process.argv.slice(2));

        if (options.help) {
            printHelp();
            return;
        }

        const prNumbers = normalizePrNumbers(options.prNumbers);
        const version = normalizeVersion(options.version || readPackageVersion());
        const changelog = fs.readFileSync(changelogPath, 'utf8');
        const pushPrs = filterMergedStagingPrs(prNumbers.map(fetchPullRequest));
        const pushNumbers = new Set(pushPrs.map((pr) => Number(pr.number)));
        const recoveredPrs = recoverMissedPrs(changelog, version)
            .filter((pr) => !pushNumbers.has(Number(pr.number)));
        const prs = [...pushPrs, ...recoveredPrs];

        const fragments = readFragments();
        const highlights = findNewHighlights(changelog, version, fragments.map((fragment) => fragment.text).filter(Boolean));
        const fragmentFiles = fragments.map((fragment) => fragment.file);

        if (!prs.length && !highlights.length) {
            console.log('No merged staging pull requests or highlights to record.');
        } else {
            const updated = updateChangelog(changelog, version, prs, highlights);

            if (updated === changelog) {
                console.log('changelog.md already contains the merged pull request entries.');
            } else if (options.dryRun) {
                console.log('changelog.md would be updated.');
            } else {
                fs.writeFileSync(changelogPath, updated);
                console.log(`Updated changelog.md ${version} merged PR entries.`);
            }
        }

        if (options.dryRun) {
            if (fragmentFiles.length) {
                console.log(`Would remove ${fragmentFiles.length} file(s) from ${fragmentsDirName}.`);
            }
            return;
        }

        removeFragments(fragmentFiles);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
