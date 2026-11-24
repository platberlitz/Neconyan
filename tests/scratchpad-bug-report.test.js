import { describe, expect, test } from '@jest/globals';
import { BUG_REPORT_FENCE, MAX_BUG_REPORTS, bugReportMarkdown, normaliseBugReport, parseBugReport, splitBugReports } from '../public/scripts/scratchpad/bug-report.js';

const VALID = {
    title: 'Scratchpad stops on Checking Neconyan source code',
    summary: 'The reply never starts after the source lookup.',
    steps: ['1. Open General Scratchpad', '- Turn on Neconyan source code', 'Send a question'],
    expected: 'The reply arrives.',
    actual: 'The preview stays on the lookup stage.',
    evidence: ['TypeError: x is undefined at stageLabel'],
    sourceRefs: ['`public/scripts/scratchpad/index.js:1760`', 'src/scratchpad/jobs.js:300-320', 'src/scratchpad/jobs.js:300-320', '../config.yaml', 'public/scripts/../../secrets.json', 'data/default-user/settings.json', 'public/script.js'],
    environment: { Browser: 'Firefox 140', Mode: 'General Scratchpad' },
};

function fence(value) {
    return `\`\`\`${BUG_REPORT_FENCE}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n\`\`\``;
}

describe('Scratchpad bug report drafts', () => {
    test('a valid draft keeps its fields and drops unsafe source references', () => {
        const report = parseBugReport(JSON.stringify(VALID));
        expect(report).toEqual({
            title: VALID.title,
            summary: VALID.summary,
            steps: ['Open General Scratchpad', 'Turn on Neconyan source code', 'Send a question'],
            expected: VALID.expected,
            actual: VALID.actual,
            evidence: VALID.evidence,
            sourceRefs: ['public/scripts/scratchpad/index.js:1760', 'src/scratchpad/jobs.js:300-320', 'public/script.js'],
            environment: 'Browser: Firefox 140\nMode: General Scratchpad',
        });
    });

    test('malformed drafts give a plain reason instead of a card', () => {
        expect(() => parseBugReport('{ title: nope')).toThrow('This bug report draft could not be read.');
        expect(() => parseBugReport('')).toThrow('This bug report draft could not be read.');
        expect(() => parseBugReport('x'.repeat(32_001))).toThrow('This bug report draft could not be read.');
        expect(() => parseBugReport('[1, 2]')).toThrow('This bug report draft is not a JSON object.');
        expect(() => parseBugReport('{"summary": "Broken"}')).toThrow('This bug report draft has no title.');
        expect(() => parseBugReport('{"title": "Broken"}')).toThrow('This bug report draft does not say what went wrong.');
        expect(() => normaliseBugReport(null)).toThrow('This bug report draft is not a JSON object.');
    });

    test('a reply splits into text and bug report parts in order', () => {
        const reply = `Here is the cause.\n\n${fence(VALID)}\n\nAnd a broken one:\n${fence('{ nope')}\nDone.`;
        const parts = splitBugReports(reply);
        expect(parts.map(part => part.type)).toEqual(['text', 'bug-report', 'text', 'bug-report', 'text']);
        expect(parts[0].text).toBe('Here is the cause.\n\n');
        expect(parts[1]).toMatchObject({ index: 0, error: '' });
        expect(parts[1].report.title).toBe(VALID.title);
        expect(parts[3]).toMatchObject({ index: 1, report: null, error: 'This bug report draft could not be read.', raw: '{ nope' });
        expect(parts.at(-1).text).toBe('\nDone.');
        expect(splitBugReports('No report here.')).toEqual([{ type: 'text', text: 'No report here.' }]);
        expect(splitBugReports('```json\n{"title": "x", "actual": "y"}\n```')).toEqual([{ type: 'text', text: '```json\n{"title": "x", "actual": "y"}\n```' }]);
    });

    test(`only the first ${MAX_BUG_REPORTS} drafts become cards`, () => {
        const reply = Array.from({ length: MAX_BUG_REPORTS + 1 }, (_, index) => fence({ ...VALID, title: `Report ${index}` })).join('\n');
        const parts = splitBugReports(reply);
        expect(parts.filter(part => part.type === 'bug-report')).toHaveLength(MAX_BUG_REPORTS);
        expect(parts.at(-1)).toEqual({ type: 'text', text: fence({ ...VALID, title: `Report ${MAX_BUG_REPORTS}` }) });
    });

    test('HTML and control characters stay plain text', () => {
        const report = parseBugReport(JSON.stringify({
            title: '<img src=x onerror=alert(1)>\u0007 Broken',
            summary: '<script>alert(1)</script>',
            actual: '```html\n<b>bold</b>\n```\n# Not a heading',
            steps: ['<a href="javascript:alert(1)">click</a>'],
        }));
        expect(report.title).toBe('<img src=x onerror=alert(1)> Broken');
        const markdown = bugReportMarkdown(report);
        expect(markdown).not.toMatch(/(?<!\\)<(?:img|script|a|b)\b/);
        expect(markdown).toContain('## \\<img src=x onerror=alert(1)\\> Broken');
        expect(markdown).toContain('\\<script\\>alert(1)\\</script\\>');
        expect(markdown).toContain('\\`\\`\\`html');
        expect(markdown).toContain('\\# Not a heading');
        expect(markdown).not.toContain('```');
    });

    test('the copied Markdown is ready for a GitHub issue', () => {
        const markdown = bugReportMarkdown(parseBugReport(JSON.stringify(VALID)));
        expect(markdown).toBe([
            `## ${VALID.title}`,
            '',
            '### Summary',
            '',
            VALID.summary,
            '',
            '### Steps to reproduce',
            '',
            '1. Open General Scratchpad',
            '2. Turn on Neconyan source code',
            '3. Send a question',
            '',
            '### Expected behaviour',
            '',
            VALID.expected,
            '',
            '### Actual behaviour',
            '',
            VALID.actual,
            '',
            '### Evidence',
            '',
            '- TypeError: x is undefined at stageLabel',
            '',
            '### Source references',
            '',
            '- `public/scripts/scratchpad/index.js:1760`',
            '- `src/scratchpad/jobs.js:300-320`',
            '- `public/script.js`',
            '',
            '### Environment',
            '',
            '- Browser: Firefox 140',
            '- Mode: General Scratchpad',
            '',
        ].join('\n'));
        const minimal = bugReportMarkdown(parseBugReport('{"title": "Short", "actual": "It broke."}'));
        expect(minimal).toBe('## Short\n\n### Actual behaviour\n\nIt broke.\n');
    });
});
