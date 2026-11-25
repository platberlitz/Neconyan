import { describe, expect, test } from '@jest/globals';

import {
    extractMergedPrNumbers,
    findNewHighlights,
    findRestoreWindow,
    normaliseFragment,
    selectRestorablePrs,
    updateChangelog,
} from '../scripts/update-changelog-merged-prs.js';
import { buildWhatsNew } from '../src/whats-new.js';

describe('update changelog merged PR extraction', () => {
    test('extracts classic merge commit pull request numbers', () => {
        expect(extractMergedPrNumbers('Merge pull request #305 from owner/branch')).toEqual(['305']);
    });

    test('extracts squash merge pull request numbers from commit subjects', () => {
        expect(extractMergedPrNumbers('fix: close release readiness regressions (#306)')).toEqual(['306']);
    });

    test('ignores pull-request-shaped references outside the subject line', () => {
        expect(extractMergedPrNumbers('fix: release polish\n\nRefs cleanup note (#999)')).toEqual([]);
    });

    test('deduplicates pull request numbers found through multiple merge styles', () => {
        expect(extractMergedPrNumbers('Merge pull request #306 from owner/branch\nfix: close release readiness regressions (#306)')).toEqual(['306']);
    });
});

describe('update changelog merged PR entries', () => {
    const mergedPr = {
        number: 321,
        title: 'fix: unblock changelog sync',
        mergedAt: '2026-06-04T12:34:56Z',
    };

    test('keeps hand-written highlights when it rewrites the merged PR list', () => {
        const changelog = [
            '# Changelog',
            '',
            '## v1.6.4',
            '',
            '### Highlights',
            '- Open **What\'s new** from Home.',
            '  It carries on here.',
            '',
            '### Merged Staging PRs',
            '- PR #320 (2026-06-03) `fix: older change`',
            '',
            '## v1.6.2',
            '',
            '### Highlights',
            '- Older highlight.',
            '',
        ].join('\n');

        const updated = updateChangelog(changelog, 'v1.6.4', [mergedPr]);

        expect(updated).toContain('### Highlights\n- Open **What\'s new** from Home.\n  It carries on here.\n\n### Merged Staging PRs\n');
        expect(updated).toContain('- PR #321 (2026-06-04) `fix: unblock changelog sync`');
        expect(updated).toContain('## v1.6.2\n\n### Highlights\n- Older highlight.\n');
    });

    test('creates a missing package version section at the top of the changelog', () => {
        const changelog = '# Changelog\n\n## v1.6.2\n\n### Fixed\n- Existing entry.\n';

        expect(updateChangelog(changelog, 'v1.6.4', [mergedPr])).toBe(
            '# Changelog\n\n## v1.6.4\n\n### Merged Staging PRs\n- PR #321 (2026-06-04) `fix: unblock changelog sync`\n\n## v1.6.2\n\n### Fixed\n- Existing entry.\n',
        );
    });

    test('ignores a legacy section with the same version below an older release', () => {
        const changelog = [
            '# Changelog',
            '',
            '## v1.4.1',
            '',
            '### Fixed',
            '- Existing entry.',
            '',
            '## v1.5.0',
            '',
            '### Merged Staging PRs',
            '- PR #300 (2026-01-01) `legacy entry`',
            '',
        ].join('\n');

        expect(updateChangelog(changelog, 'v1.5.0', [mergedPr])).toBe([
            '# Changelog',
            '',
            '## v1.5.0',
            '',
            '### Merged Staging PRs',
            '- PR #321 (2026-06-04) `fix: unblock changelog sync`',
            '',
            '## v1.4.1',
            '',
            '### Fixed',
            '- Existing entry.',
            '',
            '## v1.5.0',
            '',
            '### Merged Staging PRs',
            '- PR #300 (2026-01-01) `legacy entry`',
            '',
        ].join('\n'));
    });

    test('updates an existing top section for the current version in place', () => {
        const changelog = [
            '# Changelog',
            '',
            '## v1.5.0',
            '',
            '### Merged Staging PRs',
            '- PR #300 (2026-01-01) `legacy entry`',
            '',
            '## v1.4.1',
            '',
            '### Fixed',
            '- Existing entry.',
            '',
        ].join('\n');

        expect(updateChangelog(changelog, 'v1.5.0', [mergedPr])).toBe([
            '# Changelog',
            '',
            '## v1.5.0',
            '',
            '### Merged Staging PRs',
            '- PR #300 (2026-01-01) `legacy entry`',
            '- PR #321 (2026-06-04) `fix: unblock changelog sync`',
            '',
            '## v1.4.1',
            '',
            '### Fixed',
            '- Existing entry.',
            '',
        ].join('\n'));
    });

    test('inserts a new current section above a stale unreleased section', () => {
        const changelog = [
            '# Changelog',
            '',
            '## v1.4.2',
            '',
            '### Merged Staging PRs',
            '- PR #310 (2026-01-01) `stale entry`',
            '',
            '## v1.4.1',
            '',
            '### Highlights',
            '- Existing entry.',
            '',
        ].join('\n');

        expect(updateChangelog(changelog, 'v1.5.0', [mergedPr])).toBe([
            '# Changelog',
            '',
            '## v1.5.0',
            '',
            '### Merged Staging PRs',
            '- PR #321 (2026-06-04) `fix: unblock changelog sync`',
            '',
            '## v1.4.2',
            '',
            '### Merged Staging PRs',
            '- PR #310 (2026-01-01) `stale entry`',
            '',
            '## v1.4.1',
            '',
            '### Highlights',
            '- Existing entry.',
            '',
        ].join('\n'));
    });

    test('compares four-part versions numerically when locating the current section', () => {
        const changelog = '# Changelog\n\n## v1.4.1\n\n### Fixed\n- Existing entry.\n';

        expect(updateChangelog(changelog, 'v1.4.1.1', [mergedPr])).toBe(
            '# Changelog\n\n## v1.4.1.1\n\n### Merged Staging PRs\n- PR #321 (2026-06-04) `fix: unblock changelog sync`\n\n## v1.4.1\n\n### Fixed\n- Existing entry.\n',
        );
    });
});

describe('update changelog fragments', () => {
    const mergedPr = {
        number: 321,
        title: 'fix: unblock changelog sync',
        mergedAt: '2026-06-04T12:34:56Z',
    };
    const base = [
        '# Changelog',
        '',
        '## v1.6.0',
        '',
        '### Highlights',
        '- First line.',
        '  Continued.',
        '',
        '### Merged Staging PRs',
        '- PR #320 (2026-06-03) `fix: older change`',
        '',
        '## v1.5.7',
        '',
        '### Highlights',
        '- Older line.',
        '',
        '### Merged Staging PRs',
        '- PR #300 (2026-05-01) `old`',
        '',
    ].join('\n');

    describe('normaliseFragment', () => {
        test.each([
            ['- Bullet text.', 'Bullet text.'],
            ['* Star bullet.', 'Star bullet.'],
            ['Plain text.\n', 'Plain text.'],
            ['Line one.\r\nLine two.\r\n', 'Line one. Line two.'],
            ['Tabs\t\tand   spaces.', 'Tabs and spaces.'],
            ['\uFEFFWith a BOM.', 'With a BOM.'],
            ['# big', '# big'],
            ['## v9.9.9', '## v9.9.9'],
            ['<!-- hidden', '<!-- hidden'],
            ['-no space', '-no space'],
            ['   \n\t\r\n  ', ''],
            ['', ''],
        ])('turns %j into %j', (text, expected) => {
            expect(normaliseFragment(text)).toBe(expected);
        });

        test('keeps a very long line whole', () => {
            const text = 'a'.repeat(5000);

            expect(normaliseFragment(text)).toBe(text);
        });

        test('strips control characters', () => {
            expect(normaliseFragment('One\u0000two\u0085three')).toBe('One two three');
        });
    });

    describe('highlights', () => {
        test('give the same result as before when none are passed', () => {
            expect(updateChangelog(base, 'v1.6.0', [mergedPr], [])).toBe(updateChangelog(base, 'v1.6.0', [mergedPr]));
        });

        test('are appended after the last bullet and its continuation lines', () => {
            const updated = updateChangelog(base, 'v1.6.0', [], ['New line.']);

            expect(updated).toContain('### Highlights\n- First line.\n  Continued.\n- New line.\n\n### Merged Staging PRs\n- PR #320');
            expect(updated).toContain('## v1.5.7\n\n### Highlights\n- Older line.\n');
        });

        test('keep their order and leave the PR list working', () => {
            const updated = updateChangelog(base, 'v1.6.0', [mergedPr], ['Second.', 'Third.']);

            expect(updated).toContain('  Continued.\n- Second.\n- Third.\n\n### Merged Staging PRs\n- PR #320 (2026-06-03) `fix: older change`\n- PR #321');
        });

        test('keep every line when one ends in the Merged Staging PRs heading text', () => {
            const updated = updateChangelog(base, 'v1.6.0', [mergedPr], ['Odd ending ### Merged Staging PRs', 'Second line.']);
            const whatsNew = buildWhatsNew(updated, { version: '1.6.0' });

            expect(updated.match(/^### Merged Staging PRs$/gm)).toHaveLength(2);
            expect(whatsNew.highlights).toEqual([
                'First line. Continued.',
                'Odd ending ### Merged Staging PRs',
                'Second line.',
            ]);
            expect(whatsNew.changes.map((change) => change.number)).toEqual([320, 321]);
        });

        test('keep every line when one ends in the Local Commits heading text', () => {
            const changelog = '# Changelog\n\n## v1.6.0\n\n### Highlights\n- Kept.\n\n### Local Commits\n- abc123 local\n';
            const updated = updateChangelog(changelog, 'v1.6.0', [mergedPr], ['Ends in ### Local Commits']);

            expect(updated).toBe('# Changelog\n\n## v1.6.0\n\n### Highlights\n- Kept.\n- Ends in ### Local Commits\n\n### Merged Staging PRs\n- PR #321 (2026-06-04) `fix: unblock changelog sync`\n\n### Local Commits\n- abc123 local\n');
        });

        test('create a Highlights section above Merged Staging PRs', () => {
            const changelog = '# Changelog\n\n## v1.6.0\n\n### Merged Staging PRs\n- PR #320 (2026-06-03) `fix: older change`\n\n## v1.5.7\n\n### Fixed\n- Old.\n';

            expect(updateChangelog(changelog, 'v1.6.0', [mergedPr], ['New line.'])).toBe(
                '# Changelog\n\n## v1.6.0\n\n### Highlights\n- New line.\n\n### Merged Staging PRs\n- PR #320 (2026-06-03) `fix: older change`\n- PR #321 (2026-06-04) `fix: unblock changelog sync`\n\n## v1.5.7\n\n### Fixed\n- Old.\n',
            );
        });

        test('create a Highlights section in a block that only has a heading', () => {
            const changelog = '# Changelog\n\n## v1.6.0\n\n## v1.5.7\n\n### Fixed\n- Old.\n';

            expect(updateChangelog(changelog, 'v1.6.0', [], ['New line.'])).toBe(
                '# Changelog\n\n## v1.6.0\n\n### Highlights\n- New line.\n\n## v1.5.7\n\n### Fixed\n- Old.\n',
            );
        });

        test('create the version section with Highlights above Merged Staging PRs', () => {
            const changelog = '# Changelog\n\n## v1.5.7\n\n### Fixed\n- Old.\n';

            expect(updateChangelog(changelog, 'v1.6.0', [mergedPr], ['New line.'])).toBe(
                '# Changelog\n\n## v1.6.0\n\n### Highlights\n- New line.\n\n### Merged Staging PRs\n- PR #321 (2026-06-04) `fix: unblock changelog sync`\n\n## v1.5.7\n\n### Fixed\n- Old.\n',
            );
        });

        test('add no empty Merged Staging PRs section when there are no PRs', () => {
            const changelog = '# Changelog\n\n## v1.6.0\n\n### Highlights\n- Kept.\n\n## v1.5.7\n\n### Fixed\n- Old.\n';

            expect(updateChangelog(changelog, 'v1.6.0', [], ['New line.'])).toBe(
                '# Changelog\n\n## v1.6.0\n\n### Highlights\n- Kept.\n- New line.\n\n## v1.5.7\n\n### Fixed\n- Old.\n',
            );
            expect(updateChangelog('# Changelog\n\n## v1.5.7\n\n### Fixed\n- Old.\n', 'v1.6.0', [], ['New line.'])).toBe(
                '# Changelog\n\n## v1.6.0\n\n### Highlights\n- New line.\n\n## v1.5.7\n\n### Fixed\n- Old.\n',
            );
        });

        test('skip a line already in the current Highlights but add one only found in an older version', () => {
            const updated = updateChangelog(base, 'v1.6.0', [], ['First line.   Continued.', 'Older line.']);

            expect(updated).toContain('  Continued.\n- Older line.\n\n### Merged Staging PRs');
            expect(updated.match(/- First line\./g)).toHaveLength(1);
            expect(updated.match(/- Older line\./g)).toHaveLength(2);
        });

        test('skip a repeat within the same run', () => {
            expect(findNewHighlights(base, 'v1.6.0', ['A.', 'A.', 'B.'])).toEqual(['A.', 'B.']);
            expect(findNewHighlights(base, 'v1.6.0', ['First line. Continued.'])).toEqual([]);
        });

        test('find a lower-case Highlights heading', () => {
            const changelog = '# Changelog\n\n## v1.6.0\n\n### highlights\n- Kept.\n\n### Merged Staging PRs\n- PR #320 (2026-06-03) `fix: older change`\n';
            const updated = updateChangelog(changelog, 'v1.6.0', [], ['New line.']);

            expect(updated).toContain('### highlights\n- Kept.\n- New line.\n\n### Merged Staging PRs');
            expect(updated.match(/### highlights/gi)).toHaveLength(1);
        });

        test('are appended in a CRLF changelog', () => {
            const changelog = base.replace(/\n/g, '\r\n');
            const updated = updateChangelog(changelog, 'v1.6.0', [], ['New line.']);

            expect(updated).toContain('  Continued.\r\n- New line.\r\n\r\n### Merged Staging PRs');
        });

        test('feed What\'s new with the new line and the new PR', () => {
            const updated = updateChangelog(base, 'v1.6.0', [mergedPr], ['New line.']);
            const whatsNew = buildWhatsNew(updated, { version: '1.6.0' });

            expect(whatsNew.highlights).toEqual(['First line. Continued.', 'New line.']);
            expect(whatsNew.changes.map((change) => change.number)).toEqual([320, 321]);
            expect(whatsNew.previous.highlights).toEqual(['Older line.']);
        });
    });

    describe('recovery', () => {
        const recorded = (extra = []) => [
            '# Changelog',
            '',
            ...extra,
            '## v1.6.0',
            '',
            '### Merged Staging PRs',
            '- PR #400 (2026-06-01) `b`',
            '- PR #410 (2026-06-05) `c`',
            '',
            '## v1.5.7',
            '',
            '### Merged Staging PRs',
            '- PR #300 (2026-05-01) `d`',
            '',
        ].join('\n');

        test('anchors on the first section below the current heading that lists PRs', () => {
            const changelog = recorded(['## v1.6.1', '', '### Merged Staging PRs', '- PR #500 (2026-06-10) `a`', '']);

            expect(findRestoreWindow(changelog, 'v1.6.1')).toEqual({ heading: 'v1.6.0', highestNumber: 410, since: '2026-06-05' });
        });

        test('skips a section without PR lines', () => {
            const changelog = '# Changelog\n\n## v1.6.1\n\n### Highlights\n- A.\n\n## v1.6.0\n\n### Fixed\n- B.\n\n## v1.5.7\n\n### Merged Staging PRs\n- PR #300 (2026-05-01) `d`\n- PR #305 (2026-05-03) `e`\n';

            expect(findRestoreWindow(changelog, 'v1.6.1')).toEqual({ heading: 'v1.5.7', highestNumber: 305, since: '2026-05-03' });
        });

        test('ignores a newer hotfix section above the current one', () => {
            const changelog = recorded(['## v1.6.2', '', '### Merged Staging PRs', '- PR #600 (2026-06-20) `hotfix`', '', '## v1.6.1', '', '### Merged Staging PRs', '- PR #500 (2026-06-10) `a`', '']);

            expect(findRestoreWindow(changelog, 'v1.6.1')).toEqual({ heading: 'v1.6.0', highestNumber: 410, since: '2026-06-05' });
        });

        test('uses the first section in the file when the current heading is missing', () => {
            expect(findRestoreWindow(recorded(), 'v1.7.0')).toEqual({ heading: 'v1.6.0', highestNumber: 410, since: '2026-06-05' });
        });

        test('finds no anchor when no section lists PRs', () => {
            expect(findRestoreWindow('# Changelog\n\n## v1.6.0\n\n### Fixed\n- A.\n', 'v1.6.0')).toBeNull();
        });

        test('keeps only unrecorded merged staging PRs above the anchor number', () => {
            const changelog = recorded(['## v1.6.1', '', '### Merged Staging PRs', '- PR #500 (2026-06-10) `a`', '']);
            const pr = (number, extra = {}) => ({ number, title: `t${number}`, mergedAt: '2026-06-06T00:00:00Z', baseRefName: 'staging', ...extra });

            const selected = selectRestorablePrs([
                pr(420),
                pr(405),
                pr(410),
                pr(411),
                pr(412, { baseRefName: 'main' }),
                pr(413, { mergedAt: null }),
                pr(500),
                pr(300),
            ], changelog, 410);

            expect(selected.map((entry) => entry.number)).toEqual([411, 420]);
        });
    });
});
