import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_HIGHLIGHTS = 40;
const MAX_HIGHLIGHT_LENGTH = 600;
const MAX_CHANGES = 300;
const MAX_CHANGE_TITLE_LENGTH = 200;
const RELEASE_BRANCHES = new Set(['main', 'HEAD']);

/** @type {Map<string, {mtimeMs: number, size: number, text: string}>} */
const CHANGELOG_CACHE = new Map();

/**
 * Removes a leading 'v' so '1.6.0' and 'v1.6.0' compare equal.
 * @param {string} version Version label
 * @returns {string} Bare version
 */
function bareVersion(version) {
    return String(version || '').trim().replace(/^v/i, '');
}

/**
 * Splits a changelog into its '## version' sections, newest first.
 * @param {string} changelog Changelog markdown
 * @returns {{version: string, body: string}[]} Sections in file order
 */
export function splitChangelogSections(changelog) {
    const sections = [];
    const lines = String(changelog || '').split(/\r?\n/);
    let current = null;
    for (const line of lines) {
        const heading = /^## +(\S+)\s*$/.exec(line);
        if (heading) {
            current = { version: bareVersion(heading[1]), lines: [] };
            sections.push(current);
            continue;
        }
        current?.lines.push(line);
    }
    return sections.map(section => ({ version: section.version, body: section.lines.join('\n') }));
}

/**
 * Returns the lines of one '### Name' subsection.
 * @param {string} body Section body
 * @param {string} name Subsection title
 * @returns {string[]} Lines under that subsection
 */
function readSubsection(body, name) {
    const lines = String(body || '').split('\n');
    const start = lines.findIndex(line => line.trim().toLowerCase() === `### ${name}`.toLowerCase());
    if (start === -1) {
        return [];
    }
    const result = [];
    for (const line of lines.slice(start + 1)) {
        if (/^#{1,3} /.test(line)) {
            break;
        }
        result.push(line);
    }
    return result;
}

/**
 * Reads the bullet list under '### Highlights'. Indented lines continue the bullet above them.
 * @param {string} body Section body
 * @returns {string[]} Highlights as inline markdown
 */
export function readHighlights(body) {
    const items = [];
    for (const line of readSubsection(body, 'Highlights')) {
        const bullet = /^[-*] +(.*)$/.exec(line);
        if (bullet) {
            items.push(bullet[1].trim());
        } else if (items.length && /^\s+\S/.test(line)) {
            items[items.length - 1] = `${items[items.length - 1]} ${line.trim()}`;
        }
    }
    return items
        .filter(Boolean)
        .slice(0, MAX_HIGHLIGHTS)
        .map(item => item.slice(0, MAX_HIGHLIGHT_LENGTH));
}

/**
 * Reads the merged pull requests listed by scripts/update-changelog-merged-prs.js.
 * @param {string} body Section body
 * @returns {{number: number, date: string, title: string}[]} Merged changes, oldest first
 */
export function readMergedChanges(body) {
    const changes = [];
    for (const line of readSubsection(body, 'Merged Staging PRs')) {
        const match = /^- PR #(\d+) \((\d{4}-\d{2}-\d{2})\) `(.+)`\s*$/.exec(line);
        if (match) {
            changes.push({
                number: Number(match[1]),
                date: match[2],
                title: match[3].slice(0, MAX_CHANGE_TITLE_LENGTH),
            });
        }
    }
    return changes.slice(-MAX_CHANGES);
}

/**
 * Says whether a checkout is a staging or feature preview rather than a release.
 * Builds without git (Android, iPhone, ZIP downloads) and detached release checkouts count as releases.
 * @param {string | null | undefined} branch Branch name from git, if any
 * @returns {'preview' | 'release'} Channel
 */
export function getReleaseChannel(branch) {
    const name = String(branch || '').trim();
    return name && !RELEASE_BRANCHES.has(name) ? 'preview' : 'release';
}

/**
 * Builds the What's new summary for one version.
 * @param {string} changelog Changelog markdown
 * @param {{version: string, branch?: string | null}} options Running version and git branch
 * @returns {{version: string, channel: 'preview' | 'release', branch: string | null, highlights: string[], changes: {number: number, date: string, title: string}[], previous: {version: string, highlights: string[]} | null, digest: string}} Summary
 */
export function buildWhatsNew(changelog, { version, branch = null }) {
    const wanted = bareVersion(version);
    const sections = splitChangelogSections(changelog);
    const index = sections.findIndex(section => section.version === wanted);
    const current = index === -1 ? null : sections[index];
    const highlights = current ? readHighlights(current.body) : [];
    const changes = current ? readMergedChanges(current.body) : [];

    let previous = null;
    for (const section of sections.slice(index + 1)) {
        const previousHighlights = readHighlights(section.body);
        if (previousHighlights.length) {
            previous = { version: section.version, highlights: previousHighlights };
            break;
        }
    }

    const digest = crypto.createHash('sha256')
        .update(`${wanted}\n${highlights.join('\n')}`)
        .digest('hex')
        .slice(0, 16);

    return {
        version: wanted,
        channel: getReleaseChannel(branch),
        branch: branch ? String(branch) : null,
        highlights,
        changes,
        previous,
        digest,
    };
}

/**
 * Reads changelog.md from the server directory, re-reading only when the file changes.
 * @param {string} directory Server directory
 * @returns {string} Changelog text, or an empty string when the file is missing
 */
export function readChangelog(directory) {
    const file = path.join(directory, 'changelog.md');
    let stat;
    try {
        stat = fs.statSync(file);
    } catch {
        CHANGELOG_CACHE.delete(file);
        return '';
    }
    const cached = CHANGELOG_CACHE.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached.text;
    }
    const text = fs.readFileSync(file, 'utf8');
    CHANGELOG_CACHE.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, text });
    return text;
}
