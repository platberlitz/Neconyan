/**
 * Reading a bug report draft out of a Scratchpad reply. The assistant writes it
 * as a fenced neconyan-bug-report JSON block; nothing here touches the page or
 * the network, so it can be tested on its own.
 */

import { uiText } from '../ui-text.js';

export const BUG_REPORT_FENCE = 'neconyan-bug-report';
const FENCE_PATTERN = /```neconyan-bug-report[^\n]*\n([\s\S]*?)```/g;
export const MAX_BUG_REPORTS = 3;
const MAX_RAW_CHARS = 32_000;
const LIMITS = Object.freeze({ title: 200, summary: 4000, expected: 2000, actual: 2000, environment: 1500, item: 1000, ref: 200 });
const MAX_ITEMS = 20;
const MAX_REFS = 24;
const SOURCE_REF = /^(?:public\/script\.js|public\/scripts\/[\w./@+-]+|src\/[\w./@+-]+)(?::\d{1,7}(?:-\d{1,7})?)?$/;

export class BugReportError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BugReportError';
    }
}

function clean(value, limit) {
    if (typeof value === 'number' || typeof value === 'boolean') value = String(value);
    if (typeof value !== 'string') return '';
    // Control characters other than tabs and line breaks never belong in a report.
    // eslint-disable-next-line no-control-regex
    return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, limit);
}

function line(value, limit) {
    return clean(value, limit * 2).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function list(value, limit, max) {
    const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : [];
    return items.map(item => line(item, limit).replace(/^(?:[-*+]|\d+[.)])\s+/, '')).filter(Boolean).slice(0, max);
}

function environmentText(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.entries(value)
            .map(([key, item]) => [line(key, 80), line(item, 300)])
            .filter(([key, item]) => key && item)
            .slice(0, MAX_ITEMS)
            .map(([key, item]) => `${key}: ${item}`)
            .join('\n')
            .slice(0, LIMITS.environment);
    }
    if (Array.isArray(value)) return list(value, 300, MAX_ITEMS).join('\n').slice(0, LIMITS.environment);
    return clean(value, LIMITS.environment);
}

export function normaliseBugReport(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BugReportError(uiText('This bug report draft is not a JSON object.'));
    const refs = list(input.sourceRefs, LIMITS.ref, MAX_REFS * 2)
        .map(ref => ref.replace(/^`+|`+$/g, ''))
        .filter(ref => SOURCE_REF.test(ref) && !ref.split('/').includes('..'));
    const report = {
        title: line(input.title, LIMITS.title),
        summary: clean(input.summary, LIMITS.summary),
        steps: list(input.steps, LIMITS.item, MAX_ITEMS),
        expected: clean(input.expected, LIMITS.expected),
        actual: clean(input.actual, LIMITS.actual),
        evidence: list(input.evidence, LIMITS.item, MAX_ITEMS),
        sourceRefs: [...new Set(refs)].slice(0, MAX_REFS),
        environment: environmentText(input.environment),
    };
    if (!report.title) throw new BugReportError(uiText('This bug report draft has no title.'));
    if (!report.summary && !report.actual) throw new BugReportError(uiText('This bug report draft does not say what went wrong.'));
    return report;
}

export function parseBugReport(raw) {
    const text = String(raw ?? '').trim();
    if (!text || text.length > MAX_RAW_CHARS) throw new BugReportError('This bug report draft could not be read.');
    let value;
    try {
        value = JSON.parse(text);
    } catch {
        throw new BugReportError('This bug report draft could not be read.');
    }
    return normaliseBugReport(value);
}

/** Splits a reply into text and bug report parts, in order. */
export function splitBugReports(text) {
    const source = String(text ?? '');
    const parts = [];
    let last = 0;
    let count = 0;
    for (const match of source.matchAll(FENCE_PATTERN)) {
        if (match.index > last) parts.push({ type: 'text', text: source.slice(last, match.index) });
        last = match.index + match[0].length;
        if (count >= MAX_BUG_REPORTS) {
            parts.push({ type: 'text', text: match[0] });
            continue;
        }
        const raw = match[1].trim();
        let report = null;
        let error = '';
        try {
            report = parseBugReport(raw);
        } catch (caught) {
            error = caught instanceof BugReportError ? caught.message : 'This bug report draft could not be read.';
        }
        parts.push({ type: 'bug-report', index: count, report, error, raw: raw.slice(0, MAX_RAW_CHARS) });
        count += 1;
    }
    if (last < source.length) parts.push({ type: 'text', text: source.slice(last) });
    return parts;
}

// Escapes text that GitHub would otherwise read as HTML, a heading or a fence.
function markdownText(value) {
    return String(value ?? '')
        .replace(/[<>]/g, character => `\\${character}`)
        .replace(/```/g, '\\`\\`\\`')
        .replace(/^(\s*)#/gm, '$1\\#');
}

function markdownLine(value) {
    return markdownText(value).replace(/\s+/g, ' ').trim();
}

function codeSpan(value) {
    const text = String(value ?? '');
    return text.includes('`') ? markdownLine(text) : `\`${text}\``;
}

/** GitHub-ready Markdown for an issue body, with the title as its first heading. */
export function bugReportMarkdown(report) {
    const sections = [`## ${markdownLine(report.title)}`];
    const add = (heading, body) => {
        if (body) sections.push(`### ${heading}\n\n${body}`);
    };
    add('Summary', markdownText(report.summary));
    add('Steps to reproduce', report.steps.map((step, index) => `${index + 1}. ${markdownLine(step)}`).join('\n'));
    add('Expected behaviour', markdownText(report.expected));
    add('Actual behaviour', markdownText(report.actual));
    add('Evidence', report.evidence.map(item => `- ${markdownLine(item)}`).join('\n'));
    add('Source references', report.sourceRefs.map(ref => `- ${codeSpan(ref)}`).join('\n'));
    add('Environment', report.environment ? report.environment.split('\n').map(item => `- ${markdownLine(item)}`).join('\n') : '');
    return `${sections.join('\n\n')}\n`;
}
