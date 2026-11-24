import { t } from '../i18n.js';
import { h } from '../notebooks/dom.js';
import { copyText } from '../utils.js';
import { bugReportMarkdown } from './bug-report.js';

const SOURCE_FILE = /^(.+):(\d{1,7})-(\d{1,7})$/;

/** The Neconyan source files the server read before this reply, as a closed disclosure. */
export function renderSourceLookup(message) {
    const lookup = message?.sourceLookup;
    if (!lookup || typeof lookup !== 'object') return null;
    const files = (Array.isArray(lookup.files) ? lookup.files : [])
        .filter(file => typeof file === 'string' && SOURCE_FILE.test(file))
        .slice(0, 24);
    const note = typeof lookup.note === 'string' ? lookup.note.slice(0, 300) : '';
    if (!files.length && !note) return null;
    const details = h('details', { class: 'scratchpad-web-sources scratchpad-sources scratchpad-source-lookup' },
        h('summary', { class: 'scratchpad-web-summary', text: t`Source files checked (${files.length})` }));
    const body = h('div', { class: 'scratchpad-web-source-body' });
    if (files.length) {
        const list = h('ol', { class: 'scratchpad-web-source-list scratchpad-source-list scratchpad-source-files' });
        for (const file of files) {
            const [, path, start, end] = SOURCE_FILE.exec(file);
            list.append(h('li', {},
                h('code', { class: 'scratchpad-source-path', 'data-i18n-ignore': '', text: path }),
                h('small', { class: 'scratchpad-web-url', text: start === end ? t`Line ${start}` : t`Lines ${start} to ${end}` })));
        }
        body.append(list);
    }
    if (note) body.append(h('p', { class: 'scratchpad-muted scratchpad-source-note', 'data-i18n-ignore': '', text: note }));
    body.append(h('p', { class: 'scratchpad-muted', text: t`Read-only. The assistant can't change Neconyan's code.` }));
    details.append(body);
    return details;
}

async function copyReport(text) {
    try {
        await copyText(text);
        toastr.success(t`Bug report copied.`);
    } catch {
        toastr.warning(t`Copying is not available here.`);
    }
}

function section(label, content) {
    return content ? h('div', { class: 'scratchpad-bug-section' }, h('div', { class: 'scratchpad-bug-label', text: label }), content) : null;
}

function paragraph(text) {
    return text ? h('p', { 'data-i18n-ignore': '', text }) : null;
}

function itemList(tag, items) {
    if (!items.length) return null;
    const list = h(tag, { 'data-i18n-ignore': '' });
    for (const item of items) list.append(h('li', { text: item }));
    return list;
}

/** A read-only bug report draft card. Nothing is sent anywhere; the user copies it. */
export function renderBugReportCard(part) {
    if (!part?.report) {
        return h('div', { class: 'scratchpad-bug-report is-invalid' },
            h('div', { class: 'scratchpad-bug-title' },
                h('i', { class: 'fa-solid fa-bug', 'aria-hidden': 'true' }),
                h('span', { text: t`Bug report draft` })),
            h('p', { class: 'scratchpad-muted', role: 'status', text: part?.error || t`This bug report draft could not be read.` }),
            part?.raw ? h('pre', { class: 'scratchpad-bug-raw', 'data-i18n-ignore': '' }, h('code', { text: part.raw.slice(0, 4000) })) : null);
    }
    const { report } = part;
    const markdown = bugReportMarkdown(report);
    const environment = report.environment ? report.environment.split('\n').filter(Boolean) : [];
    const card = h('section', { class: 'scratchpad-bug-report', 'aria-label': t`Bug report draft` },
        h('div', { class: 'scratchpad-bug-title' },
            h('i', { class: 'fa-solid fa-bug', 'aria-hidden': 'true' }),
            h('span', { text: t`Bug report draft` })),
        h('p', { class: 'scratchpad-bug-heading', 'data-i18n-ignore': '', text: report.title }),
        section(t`Summary`, paragraph(report.summary)),
        section(t`Steps to reproduce`, itemList('ol', report.steps)),
        section(t`Expected`, paragraph(report.expected)),
        section(t`Actual`, paragraph(report.actual)),
        section(t`Evidence`, itemList('ul', report.evidence)),
        section(t`Source references`, itemList('ul', report.sourceRefs)),
        section(t`Environment`, itemList('ul', environment)),
        h('div', { class: 'scratchpad-bug-actions' },
            h('button', { type: 'button', class: 'menu_button scratchpad-bug-copy', onclick: () => void copyReport(markdown) },
                h('i', { class: 'fa-solid fa-copy', 'aria-hidden': 'true' }),
                h('span', { text: t`Copy bug report` }))),
        h('p', { class: 'scratchpad-muted scratchpad-bug-note', text: t`Copies GitHub-ready Markdown. Nothing is submitted automatically; paste it into a new issue yourself.` }));
    return card;
}
