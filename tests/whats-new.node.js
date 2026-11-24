import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildWhatsNew, getReleaseChannel, readChangelog, readHighlights, readMergedChanges } from '../src/whats-new.js';

const CHANGELOG = [
    '# Changelog',
    '',
    '## v1.6.0',
    '',
    '### Highlights',
    '- Open **What\'s new** from **Home layout**.',
    '- Long highlight that',
    '  carries on over a second line.',
    '',
    '### Merged Staging PRs',
    '- PR #776 (2026-11-20) `fix(settings): keep theme filters in view when pressed`',
    '- PR #780 (2026-11-21) `feat(home): add what\'s new`',
    'not a PR line',
    '',
    '### Local Commits',
    '- `fc965a8 fix(mobile): keep the composer still`',
    '',
    '## v1.5.7',
    '',
    '### Highlights',
    '- Open **Author\'s Note** from **Chat tools**.',
    '',
    '### Merged Staging PRs',
    '- PR #700 (2026-11-01) `fix(chat): older change`',
    '',
].join('\n');

test('reads highlights, joining indented continuation lines', () => {
    const body = CHANGELOG.split('## v1.5.7')[0];
    assert.deepEqual(readHighlights(body), [
        'Open **What\'s new** from **Home layout**.',
        'Long highlight that carries on over a second line.',
    ]);
});

test('reads merged pull requests and ignores other lines', () => {
    const body = CHANGELOG.split('## v1.5.7')[0];
    assert.deepEqual(readMergedChanges(body), [
        { number: 776, date: '2026-11-20', title: 'fix(settings): keep theme filters in view when pressed' },
        { number: 780, date: '2026-11-21', title: 'feat(home): add what\'s new' },
    ]);
});

test('treats staging and feature branches as previews, and main, detached or no git as releases', () => {
    assert.equal(getReleaseChannel('staging'), 'preview');
    assert.equal(getReleaseChannel('feat/home-whats-new'), 'preview');
    assert.equal(getReleaseChannel('main'), 'release');
    assert.equal(getReleaseChannel('HEAD'), 'release');
    assert.equal(getReleaseChannel(null), 'release');
    assert.equal(getReleaseChannel(''), 'release');
});

test('builds the summary for the running version with the last release behind it', () => {
    const summary = buildWhatsNew(CHANGELOG, { version: '1.6.0', branch: 'staging' });
    assert.equal(summary.version, '1.6.0');
    assert.equal(summary.channel, 'preview');
    assert.equal(summary.branch, 'staging');
    assert.equal(summary.highlights.length, 2);
    assert.equal(summary.changes.length, 2);
    assert.deepEqual(summary.previous, { version: '1.5.7', highlights: ['Open **Author\'s Note** from **Chat tools**.'] });
    assert.match(summary.digest, /^[0-9a-f]{16}$/);
});

test('falls back to the last written highlights when the running version has none yet', () => {
    const bare = CHANGELOG.replace(/### Highlights\n- Open \*\*What's new[\s\S]*?second line\.\n\n/, '');
    const summary = buildWhatsNew(bare, { version: 'v1.6.0', branch: 'staging' });
    assert.deepEqual(summary.highlights, []);
    assert.equal(summary.changes.length, 2);
    assert.equal(summary.previous?.version, '1.5.7');
});

test('a version missing from the changelog still shows the newest written highlights', () => {
    const summary = buildWhatsNew(CHANGELOG, { version: '1.7.0', branch: null });
    assert.equal(summary.channel, 'release');
    assert.deepEqual(summary.highlights, []);
    assert.deepEqual(summary.changes, []);
    assert.equal(summary.previous?.version, '1.6.0');
});

test('the digest changes when a highlight is added, so the new dot comes back', () => {
    const before = buildWhatsNew(CHANGELOG, { version: '1.6.0' }).digest;
    const after = buildWhatsNew(CHANGELOG.replace('### Merged Staging PRs', '- One more highlight.\n\n### Merged Staging PRs'), { version: '1.6.0' }).digest;
    const again = buildWhatsNew(CHANGELOG, { version: '1.6.0', branch: 'main' }).digest;
    assert.notEqual(before, after);
    assert.equal(before, again);
});

test('reads changelog.md again only when it changes, and copes when it is missing', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-whats-new-'));
    try {
        assert.equal(readChangelog(directory), '');
        const file = path.join(directory, 'changelog.md');
        fs.writeFileSync(file, '# Changelog\n');
        assert.equal(readChangelog(directory), '# Changelog\n');
        fs.writeFileSync(file, '# Changelog\n\n## v1.0.0\n');
        fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
        assert.equal(readChangelog(directory), '# Changelog\n\n## v1.0.0\n');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
