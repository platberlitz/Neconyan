// App evidence for Scratchpad: what Neconyan knows about its own problems, as plain text.
// The server imports this file, so it must stay free of DOM access and of imports.

export const EVIDENCE_HEADING = '## App evidence';

export const EVIDENCE_CAPS = Object.freeze({
    browserErrors: 5,
    pageEvents: 8,
    extensions: 8,
    modelFailures: 5,
    requests: 10,
    jobs: 8,
    serverCrashes: 3,
    logLines: 30,
});

const MESSAGE_LIMIT = 400;
const STACK_LINES = 6;
const STACK_LINE_LIMIT = 200;

const SECRET_NAME = '(?:[\\w.-]*(?:api[_-]?key|apikey|access[_-]?key|private[_-]?key|secret|token|passw(?:or)?d|pwd|passphrase|credential|cookie|authorization|auth|session[_-]?id|sessionid|signature)[\\w.-]*|key|sid|jwt|bearer)';
const SECRET_LINE_NAME = '(?:proxy-authorization|authorization|set-cookie|cookie|x-[\\w-]*(?:key|token|secret|auth)[\\w-]*|[\\w-]*api-key)';
// Token counts (max_tokens, prompt_tokens, token_limit) are settings and usage, not credentials.
const COUNT_NAME = '(?![\\w.-]*(?:tokens|token[_-]?(?:count|limit|budget|usage)))';
const WHOLE_VALUE_NAME = '(?:[\\w.-]*(?:passw(?:or)?d|pwd|passphrase|secret|credential)[\\w.-]*)';

const REDACTIONS = [
    // JSON parse errors quote the start of the text that failed to parse, which may be a chat or a prompt.
    [/(Unexpected [^\r\n]{0,80}?), "[^\r\n]*?"(?:\.\.\.)? is not valid JSON/gi, '$1, [text removed] is not valid JSON'],
    // Header lines carry whole lists (Cookie: a=1; b=2), so the rest of the line goes.
    [new RegExp(`(["']?)\\b(${SECRET_LINE_NAME})\\1\\s*[:=]\\s*(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\r\\n]*)`, 'gi'), '$2: [redacted]'],
    // Passwords and secrets may hold spaces, so an unquoted value runs to a separator.
    [new RegExp(`(["']?)\\b(${WHOLE_VALUE_NAME})\\1\\s*[:=]\\s*(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\r\\n,;&}"']+)`, 'gi'), '$2: [redacted]'],
    [new RegExp(`(["']?)\\b${COUNT_NAME}(${SECRET_NAME})\\1\\s*[:=]\\s*(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\s,;&}"']+)`, 'gi'), '$2: [redacted]'],
    [/\b(Bearer|Basic|Digest|Negotiate)\s+[A-Za-z0-9._~+/=-]{4,}/gi, '$1 [redacted]'],
    [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1[redacted]@'],
    [/(^|[\s(<"'])[^\s/:@"'<>]+:[^\s/@"'<>]+@(?=[\w[])/g, '$1[redacted]@'],
    [/\?(?=[\w%.~[\]-]+=)[^\s"'<>)]*/g, '?[redacted]'],
    [/(\bhttps?:\/\/[^\s#"'<>)]*)#[^\s"'<>)]*/gi, '$1#[redacted]'],
    [/\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]{2,}){1,2}/g, '[redacted]'],
    [/\b(?:sk|pk|rk|sess|gsk|hf|nvapi|pplx|xai|glpat|fw|r8)[-_][A-Za-z0-9_-]{8,}/gi, '[redacted]'],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bxox[abprs]-[A-Za-z0-9-]{8,}|\bAIza[0-9A-Za-z_-]{20,}|\bA(?:KIA|SIA)[0-9A-Z]{12,}/g, '[redacted]'],
    // Any other long unbroken run that mixes letters and digits is treated as a key.
    [/(?<![\w/.-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}(?![\w/.-])/g, '[redacted]'],
    [/[A-Za-z0-9+/]{40,}={0,2}(?![\w/.-])/g, match => (/[+/=]/.test(match) && /\d/.test(match) && /[A-Za-z]/.test(match) ? '[redacted]' : match)],
];

function crashRedact(text) {
    const redact = globalThis.NeconyanCrashDiagnostics?.redact;
    if (typeof redact !== 'function') return text;
    try {
        const out = redact(text, text.length + 64);
        return typeof out === 'string' ? out : text;
    } catch {
        return text;
    }
}

/**
 * Removes anything that looks like a credential from one piece of text.
 * @param {unknown} value
 * @param {number} [limit] Longest result, in characters
 * @returns {string}
 */
export function redactEvidenceText(value, limit = MESSAGE_LIMIT) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    let text = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
    // Bound the work, and drop the word the cut may have split in half.
    const bound = Math.max(limit, 200) * 4;
    if (text.length > bound) text = `${text.slice(0, bound).replace(/\S*$/, '')} …`;
    text = crashRedact(text);
    for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
    text = text.replace(/[ \t]+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…` : text;
}

function oneLine(value, limit = MESSAGE_LIMIT) {
    return redactEvidenceText(value, limit * 2).replace(/\s*\r?\n\s*/g, ' ').slice(0, limit);
}

function stackTop(stack) {
    if (typeof stack !== 'string') return [];
    return stack.split('\n').map(line => line.trim()).filter(Boolean).slice(0, STACK_LINES)
        .map(line => oneLine(line.replace(/^at\s+/, 'at '), STACK_LINE_LIMIT));
}

function stamp(value) {
    const time = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
    return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : '';
}

function time(value) {
    return Number.isFinite(value) ? value : (Date.parse(String(value ?? '')) || 0);
}

function newestFirst(items) {
    return (Array.isArray(items) ? items : []).filter(item => item && typeof item === 'object')
        .map((item, index) => ({ item, index })).sort((a, b) => time(b.item.at) - time(a.item.at) || a.index - b.index).map(entry => entry.item);
}

function part(heading, entries, cap, omittedElsewhere = 0) {
    const shown = entries.slice(0, cap);
    const omitted = Math.max(0, entries.length - shown.length) + Math.max(0, Math.trunc(Number(omittedElsewhere) || 0));
    if (!shown.length) return [];
    const lines = [`### ${heading}`, ...shown.flatMap(entry => entry)];
    if (omitted) lines.push(`- ${omitted} older ${omitted === 1 ? 'item was' : 'items were'} left out.`);
    return lines;
}

function withTime(at, text) {
    const when = stamp(at);
    return when ? `${when} ${text}` : text;
}

function environmentLines(environment) {
    if (!environment || typeof environment !== 'object') return [];
    const lines = [];
    const build = [environment.build, environment.branch].filter(Boolean).map(value => oneLine(value, 80));
    if (environment.version) lines.push(`- Neconyan ${oneLine(environment.version, 40)}${build.length ? ` (build ${build.join(', ')})` : ''}`);
    if (environment.runtime) lines.push(`- Server runtime: ${oneLine(environment.runtime, 80)}${environment.platform ? ` on ${oneLine(environment.platform, 80)}` : ''}`);
    if (environment.client) lines.push(`- Running as: ${oneLine(environment.client, 80)}`);
    if (typeof environment.frontendBuild === 'boolean') lines.push(`- Built frontend: ${environment.frontendBuild ? 'in use' : 'not in use (the page loads the source files)'}`);
    return lines.length ? ['### Neconyan and this device', ...lines] : [];
}

function browserErrorLines(reports) {
    const entries = newestFirst(reports.map(report => ({ ...report, at: report?.lastAt ?? report?.at })));
    return entries.map(report => {
        const error = report.error && typeof report.error === 'object' ? report.error : {};
        const where = report.context && typeof report.context === 'object' && report.context.source
            ? ` at ${oneLine(String(report.context.source).split(/[?#]/)[0], 120)}${report.context.line ? `:${Number(report.context.line) || 0}` : ''}` : '';
        const repeats = Number(report.repeats) > 1 ? ` (happened ${Math.trunc(Number(report.repeats))} times)` : '';
        const head = withTime(report.at, `${oneLine(report.kind || 'error', 60)}: ${oneLine([error.name, error.message].filter(Boolean).join(': ') || 'no message')}${where}${repeats}`);
        return [`- ${head}`, ...stackTop(error.stack).map(line => `  ${line}`)];
    });
}

function duration(value) {
    const seconds = Math.round(Number(value) / 1000);
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    if (seconds < 1) return 'under a second';
    if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
    const minutes = Math.round(seconds / 60);
    return minutes < 120 ? `${minutes} minutes` : `${Math.round(minutes / 6) / 10} hours`;
}

const KEEP_ALIVE_STATE_TEXT = Object.freeze({
    off: 'switched off',
    armed: 'on, not playing',
    playing: 'playing',
    blocked: 'blocked by the browser',
    failed: 'could not start',
    interrupted: 'stopped while the page was hidden, not by Neconyan',
    dismissed: 'paused by the user from the media notification',
    unsupported: 'not supported here',
});

function keepAliveText(keepAlive) {
    if (!keepAlive || typeof keepAlive !== 'object') return 'Stay open in the background: no record from that page';
    const parts = [KEEP_ALIVE_STATE_TEXT[keepAlive.state] || 'unknown'];
    const count = Math.trunc(Number(keepAlive.interruptions) || 0);
    if (count > 0) parts.push(`stopped ${count} time${count === 1 ? '' : 's'} on that page`);
    if (keepAlive.lastEvent && Number.isFinite(keepAlive.playedSeconds)) parts.push(`the sound reported '${oneLine(keepAlive.lastEvent, 20)}' after ${keepAlive.playedSeconds} seconds`);
    return `Stay open in the background: ${parts.join(', ')}`;
}

// A reload Neconyan started has a reason. A page that ended without closing has none, only what it was last seen doing.
function pageEventLines(records) {
    const known = ['page-reloaded-by-app', 'unclean-previous-page', 'discarded-previous-page'];
    return newestFirst(records.filter(record => known.includes(record?.kind))).map(record => {
        if (record.kind === 'page-reloaded-by-app') {
            const change = record.from && record.to ? ` (${oneLine(record.from, 40)} -> ${oneLine(record.to, 40)})` : '';
            const away = Number.isFinite(record.awayMs) && duration(record.awayMs) ? `, right after the page had been hidden for ${duration(record.awayMs)}` : '';
            return [`- ${withTime(record.at, oneLine(`${record.summary || 'Neconyan reloaded this page'}${change}${away}. Started by Neconyan, not a crash.`, 520))}`];
        }
        const page = record.previousPage && typeof record.previousPage === 'object' ? record.previousPage : null;
        const head = record.kind === 'discarded-previous-page' ? 'The browser discarded the previous page' : 'The previous page ended without closing normally';
        const parts = [];
        if (page) {
            const hiddenFor = page.hiddenAtLastSignOfLife && Number.isFinite(page.hiddenForMs) ? duration(page.hiddenForMs) : '';
            parts.push(page.hiddenAtLastSignOfLife ? `it was hidden at its last sign of life${hiddenFor ? ` (hidden for ${hiddenFor} by then)` : ''}` : 'it was visible at its last sign of life');
            const age = duration(page.lastSignOfLifeAgeMs);
            if (age) parts.push(`that was ${age} before this reopening`);
            if (page.frozenAtLastSignOfLife) parts.push('the browser had frozen it');
            parts.push(keepAliveText(page.keepAlive));
        }
        return [`- ${withTime(record.at, oneLine(`found when the page reopened: ${head}${parts.length ? `; ${parts.join('; ')}` : ''}. The cause was not recorded.`, 520))}`];
    });
}

const PAGE_EVENT_NOTE = '- A page that ended without closing leaves no cause; the browser does not say why. A page that is hidden with no keep-alive sound playing is commonly unloaded by phones to free memory, which this record cannot confirm. A reload started by Neconyan always names its reason.';

function serverCrashLines(reports) {
    return newestFirst(reports).map(report => {
        const head = withTime(report.at, `${oneLine(report.kind || 'crash', 60)}: ${oneLine([report.name, report.message].filter(Boolean).join(': ') || 'no message')}${report.version ? ` (Neconyan ${oneLine(report.version, 40)})` : ''}`);
        // Memory figures from the server's own readings and Node's fatal-error report.
        const detail = (Array.isArray(report.detail) ? report.detail : []).filter(line => typeof line === 'string' && line.trim()).slice(0, 6).map(line => `  ${oneLine(line, 400)}`);
        return [`- ${head}`, ...detail, ...stackTop(report.stack).map(line => `  ${line}`)];
    });
}

function modelFailureLines(failures) {
    return newestFirst(failures).map(failure => {
        const status = Number(failure.status) > 0 ? `HTTP ${Math.trunc(Number(failure.status))}` : 'no HTTP status';
        const who = [failure.provider, failure.model].filter(Boolean).map(value => oneLine(value, 80)).join(' / ') || 'unknown provider';
        return [`- ${withTime(failure.at, `${who}: ${status}${failure.message ? `, "${oneLine(failure.message)}"` : ''}`)}`];
    });
}

function requestLines(requests) {
    return newestFirst(requests).map(request => {
        const outcome = request.closed ? 'closed before it finished' : `status ${Math.trunc(Number(request.status) || 0)}`;
        const slow = Number(request.ms) >= 1000 ? `, took ${Math.round(Number(request.ms) / 100) / 10}s` : '';
        return [`- ${withTime(request.at, `${oneLine(request.method, 12)} ${oneLine(request.path, 120)}: ${outcome}${slow}`)}`];
    });
}

function jobLines(jobs) {
    return newestFirst(jobs).map(job => {
        const detail = [job.code ? oneLine(job.code, 80) : '', job.message ? `"${oneLine(job.message)}"` : ''].filter(Boolean).join(' ');
        const stage = job.stage ? ` at ${oneLine(job.stage, 60)}` : '';
        return [`- ${withTime(job.at, `${oneLine(job.type || 'job', 60)} ${oneLine(job.state || 'failed', 30)}${stage}${detail ? `: ${detail}` : ''}`)}`];
    });
}

function extensionLines(errors) {
    // They are kept in load order, so the last one is the newest.
    return errors.filter(error => typeof error === 'string' && error.trim()).reverse().map(error => [`- ${oneLine(error)}`]);
}

function logLines(lines) {
    return newestFirst(lines).map(line => [`- ${withTime(line.at, `${line.stream === 'stderr' ? '[stderr] ' : ''}${oneLine(line.message, 300)}`)}`]);
}

function noteLines(notes) {
    const lines = (Array.isArray(notes) ? notes : []).filter(note => typeof note === 'string' && note.trim()).slice(0, 4).map(note => `- ${oneLine(note, 200)}`);
    return lines.length ? ['### Could not be read', ...lines] : [];
}

function listOf(source, key) {
    const value = source?.[key];
    if (Array.isArray(value)) return { items: value, total: value.length };
    if (value && typeof value === 'object' && Array.isArray(value.items)) return { items: value.items, total: Math.max(value.items.length, Math.trunc(Number(value.total) || 0)) };
    return { items: [], total: 0 };
}

function section(heading, builder, source, key, cap) {
    const { items, total } = listOf(source, key);
    const entries = builder(items);
    return part(heading, entries, cap, Math.max(0, total - items.length));
}

function pageEventsSection(evidence, caps) {
    const lines = section('Page reloads and restarts in this browser', pageEventLines, evidence, 'pageEvents', caps.pageEvents ?? EVIDENCE_CAPS.pageEvents);
    return lines.length ? [...lines, PAGE_EVENT_NOTE] : [];
}

/**
 * Turns the gathered evidence into the 'App evidence' section of the shared
 * context. Each part appears only when it has something to report, newest
 * first, and says how many items the cap left out.
 * @param {object} evidence
 * @param {object} [evidence.environment] version, build, branch, runtime, platform, client, frontendBuild
 * @param {object|Array} [evidence.browserErrors] Reports from NeconyanCrashDiagnostics.getReports()
 * @param {object|Array} [evidence.pageEvents] The recoveries and reloads from NeconyanCrashDiagnostics.getReports()
 * @param {string[]} [evidence.extensionErrors] Extensions that failed to load
 * @param {object|Array} [evidence.modelFailures] Recent failed model requests
 * @param {object|Array} [evidence.requests] This account's failed or slow server requests
 * @param {object|Array} [evidence.jobs] This account's failed jobs
 * @param {object|Array} [evidence.serverCrashes] Admin only; each may carry `detail`, short lines of memory figures
 * @param {object|Array} [evidence.logLines] Admin only
 * @param {string[]} [evidence.notes] Parts that could not be read, so the reader does not mistake them for empty
 * @param {string|number} [evidence.gatheredAt] When the evidence was collected, so the reader can tell how old each item is
 * @returns {string}
 */
export function formatAppEvidence(evidence = {}, caps = EVIDENCE_CAPS) {
    const parts = [
        environmentLines(evidence.environment),
        section('Browser errors and crash reports', browserErrorLines, evidence, 'browserErrors', caps.browserErrors),
        pageEventsSection(evidence, caps),
        section('Extensions that failed to load', extensionLines, evidence, 'extensionErrors', caps.extensions),
        section('Failed model requests', modelFailureLines, evidence, 'modelFailures', caps.modelFailures),
        section('Failed or slow server requests', requestLines, evidence, 'requests', caps.requests),
        section('Failed jobs', jobLines, evidence, 'jobs', caps.jobs),
        section('Server crash reports (admin only)', serverCrashLines, evidence, 'serverCrashes', caps.serverCrashes),
        section('Recent server error and warning lines (admin only)', logLines, evidence, 'logLines', caps.logLines),
        noteLines(evidence.notes),
    ].filter(lines => lines.length);
    if (!parts.length) return '';
    const intro = 'Recorded by Neconyan itself, newest first. Credentials, chat text and prompts are removed before sharing. A part that is missing had nothing to report or is not available to this account.';
    const gathered = stamp(evidence.gatheredAt);
    return [EVIDENCE_HEADING, intro, ...(gathered ? [`Gathered at ${gathered}. Times are UTC.`] : []), ...parts.flatMap(lines => ['', ...lines])].join('\n');
}
