// Neconyan: Chatroom feed lines, shared by the card, the panel and the reply flow.
// Kept free of imports so the line rules can be tested on their own.

export const CHATROOM_REPLY_CONTEXT_ROWS = 40;
export const CHATROOM_REPLY_KEEP_ROWS = 40;
export const CHATROOM_DEFAULT_VIEWER_NAME = 'You';

const CHATROOM_TONE_RE = /^[0-9]{1,3}$/;
const CHATROOM_MESSAGE_PREFIX_RE = /^([^|\n]{1,48})\|([0-9]{1,3})\|([\s\S]+)$/;
const CHATROOM_STYLE_LINE_RE = /^(?:CHATROOM_STYLE|chatroom-style)\|/i;
const CHATROOM_END_LINE_RE = /^(?:CHATROOM_END|chatroom-end)$/i;
const CHATROOM_FEED_LINE_RE = /^(?:chatroom|chatroom-reply|chatroom-you|chatroom-poll|chatroom-option|chatroom-event)\|/i;
const CHATROOM_CONTINUATION_LINE_RE = /^(?:>|&gt;)/;
const CHATROOM_ATTACHED_LINE_RE = /^(?:chatroom-option\||>|&gt;)/i;

export const CHATROOM_FEED_PROBE_RE = /^(?:CHATROOM_STYLE|chatroom-style|CHATROOM|chatroom|chatroom-reply|chatroom-you|chatroom-poll|chatroom-option|chatroom-event)\|/im;

export function normalizeChatroomField(value = '') {
    return String(value ?? '').replaceAll('|', '/').replaceAll(/\r?\n/g, ' ').trim();
}

function normalizeChatroomTone(value = '') {
    const tone = String(value ?? '').trim();
    return CHATROOM_TONE_RE.test(tone) ? tone : '18';
}

function normalizeChatroomPercent(value = '') {
    const match = String(value ?? '').match(/[0-9]{1,3}/);
    const percent = match ? Number(match[0]) : 0;
    return String(Math.max(0, Math.min(100, percent)));
}

function normalizeChatroomMessageParts(meta = '', tone = '', message = '') {
    let nextMeta = normalizeChatroomField(meta);
    let nextTone = String(tone ?? '').trim();
    let nextMessage = String(message ?? '').trim();
    const shiftedMessage = nextMessage.match(CHATROOM_MESSAGE_PREFIX_RE);

    if (shiftedMessage) {
        const shiftedMeta = normalizeChatroomField(shiftedMessage[1]);
        const shiftedTone = shiftedMessage[2].trim();

        if (!nextMeta || nextMeta.toLowerCase() === 'meta' || /^[+-]?\d+$/.test(nextMeta)) {
            nextMeta = shiftedMeta;
        }
        if (!CHATROOM_TONE_RE.test(nextTone)) {
            nextTone = shiftedTone;
        }
        nextMessage = shiftedMessage[3].trim();
    }

    return { meta: nextMeta, tone: nextTone, message: nextMessage };
}

function normalizeChatroomPostLine(line, parts) {
    const speaker = parts[1];
    let meta = parts[2];
    let tone = parts[3];
    let messageParts = parts.slice(4);

    if (!CHATROOM_TONE_RE.test(String(tone ?? '').trim()) && CHATROOM_TONE_RE.test(String(parts[4] ?? '').trim())) {
        meta = parts[3];
        tone = parts[4];
        messageParts = parts.slice(5);
    }

    const normalized = normalizeChatroomMessageParts(meta, tone, messageParts.join('|'));
    const cleanSpeaker = normalizeChatroomField(speaker);
    const cleanMessage = normalizeChatroomField(normalized.message);

    if (!cleanSpeaker || !cleanMessage) {
        return line;
    }

    return `chatroom|${cleanSpeaker}|${normalizeChatroomField(normalized.meta)}|${normalizeChatroomTone(normalized.tone)}|${cleanMessage}`;
}

function normalizeChatroomReplyLine(line, parts) {
    if (parts.length < 6) {
        // A reply without its target still reads fine as an ordinary post.
        return parts.length >= 5 ? normalizeChatroomPostLine(line, ['chatroom', ...parts.slice(1)]) : line;
    }

    const speaker = normalizeChatroomField(parts[1]);
    const meta = normalizeChatroomField(parts[2]);
    const tone = normalizeChatroomTone(parts[3]);
    const target = normalizeChatroomField(parts[4]).replace(/^@+/, '');
    const message = normalizeChatroomField(parts.slice(5).join('|'));

    if (!speaker || !message) {
        return line;
    }
    if (!target) {
        return `chatroom|${speaker}|${meta}|${tone}|${message}`;
    }

    return `chatroom-reply|${speaker}|${meta}|${tone}|${target}|${message}`;
}

/**
 * Tidies one generated Chatroom line so the display regexes can match it.
 * Lines that are not Chatroom lines come back unchanged.
 * @param {string} line
 * @returns {string}
 */
export function normalizeChatroomGeneratedLine(line = '') {
    const trimmed = String(line ?? '').trim();

    if (CHATROOM_STYLE_LINE_RE.test(trimmed)) {
        const [, style = 'mixed'] = trimmed.split('|');
        return `chatroom-style|${normalizeChatroomField(style) || 'mixed'}`;
    }

    if (CHATROOM_END_LINE_RE.test(trimmed)) {
        return 'chatroom-end';
    }

    const kind = trimmed.match(/^(chatroom(?:-[a-z]+)?)\|/i)?.[1]?.toLowerCase();
    if (!kind) {
        return line;
    }

    const parts = trimmed.split('|');

    switch (kind) {
        case 'chatroom':
            return parts.length < 5 ? line : normalizeChatroomPostLine(line, parts);
        case 'chatroom-reply':
            return normalizeChatroomReplyLine(line, parts);
        case 'chatroom-you': {
            const name = normalizeChatroomField(parts[1]) || CHATROOM_DEFAULT_VIEWER_NAME;
            const message = normalizeChatroomField(parts.slice(2).join('|'));
            return message ? `chatroom-you|${name}|${message}` : line;
        }
        case 'chatroom-poll': {
            if (parts.length < 3) return line;
            const author = normalizeChatroomField(parts[1]);
            const question = normalizeChatroomField(parts.slice(2).join('|'));
            return author && question ? `chatroom-poll|${author}|${question}` : line;
        }
        case 'chatroom-option': {
            if (parts.length < 2) return line;
            const hasPercent = parts.length >= 3;
            const label = normalizeChatroomField((hasPercent ? parts.slice(1, -1) : parts.slice(1)).join(' / '));
            return label ? `chatroom-option|${label}|${normalizeChatroomPercent(hasPercent ? parts.at(-1) : '')}` : line;
        }
        case 'chatroom-event': {
            const text = normalizeChatroomField(parts.slice(1).join('|'));
            return text ? `chatroom-event|${text}` : line;
        }
        default:
            return line;
    }
}

/**
 * Splits Chatroom content into its style and feed rows. Greentext continuations and poll
 * options stay attached to the row above them.
 * @param {string} content
 * @returns {{ style: string, rows: string[] }}
 */
export function parseChatroomFeed(content = '') {
    const lines = String(content ?? '').replaceAll(/\r\n?/g, '\n').split('\n');
    let style = '';
    const rows = [];

    for (const rawLine of lines) {
        const line = normalizeChatroomGeneratedLine(rawLine).trim();
        if (!line) continue;

        if (CHATROOM_STYLE_LINE_RE.test(line)) {
            style ||= line.slice(line.indexOf('|') + 1).trim();
            continue;
        }
        if (CHATROOM_END_LINE_RE.test(line)) continue;

        if (CHATROOM_FEED_LINE_RE.test(line) || (rows.length > 0 && CHATROOM_CONTINUATION_LINE_RE.test(line))) {
            rows.push(line);
        }
    }

    return { style, rows };
}

function getLastRows(rows, limit) {
    if (rows.length <= limit) {
        return rows.slice();
    }

    let start = rows.length - limit;
    // Start the kept window on a whole post, not on a stray poll option or greentext line.
    while (start < rows.length && CHATROOM_ATTACHED_LINE_RE.test(rows[start])) {
        start++;
    }
    return rows.slice(start);
}

export function getChatroomViewerName(value = '') {
    const name = normalizeChatroomField(value);
    return !name || /^\{\{.*\}\}$/.test(name) ? CHATROOM_DEFAULT_VIEWER_NAME : name.slice(0, 48);
}

export function buildChatroomViewerRow(viewerName = '', viewerText = '') {
    const message = normalizeChatroomField(viewerText);
    return message ? `chatroom-you|${getChatroomViewerName(viewerName)}|${message}` : '';
}

/**
 * The feed the viewer is looking at, plus their own post, shown while the room answers.
 * @param {{ previousContent?: string, viewerName?: string, viewerText?: string, maxPreviousRows?: number }} options
 * @returns {string}
 */
export function buildChatroomPendingFeed({ previousContent = '', viewerName = '', viewerText = '', maxPreviousRows = CHATROOM_REPLY_KEEP_ROWS } = {}) {
    const previous = parseChatroomFeed(previousContent);
    const viewerRow = buildChatroomViewerRow(viewerName, viewerText);
    return [
        `chatroom-style|${previous.style || 'mixed'}`,
        ...getLastRows(previous.rows, maxPreviousRows),
        ...(viewerRow ? [viewerRow] : []),
        'chatroom-end',
    ].join('\n');
}

/**
 * Appends the viewer's post and the room's answers below the earlier feed, so a reply
 * continues the same conversation instead of replacing it.
 * @param {{ previousContent?: string, replyContent?: string, viewerName?: string, viewerText?: string, maxPreviousRows?: number }} options
 * @returns {string}
 */
export function mergeChatroomReplyFeed({ previousContent = '', replyContent = '', viewerName = '', viewerText = '', maxPreviousRows = CHATROOM_REPLY_KEEP_ROWS } = {}) {
    const previous = parseChatroomFeed(previousContent);
    const reply = parseChatroomFeed(replyContent);
    const viewerRow = buildChatroomViewerRow(viewerName, viewerText);
    const knownRows = new Set([...previous.rows, viewerRow]);
    // Earlier rows the model repeats and any post written as the viewer are dropped; the
    // viewer's own row is added here, once, in their words.
    // Poll options and greentext lines follow the row they belong to.
    const newRows = [];
    let keepAttached = false;
    for (const row of reply.rows) {
        if (CHATROOM_ATTACHED_LINE_RE.test(row)) {
            if (keepAttached) newRows.push(row);
            continue;
        }
        keepAttached = !knownRows.has(row) && !/^chatroom-you\|/i.test(row);
        if (keepAttached) newRows.push(row);
    }

    if (!newRows.some(row => !CHATROOM_ATTACHED_LINE_RE.test(row))) {
        throw new Error('The chatroom answered without any new posts. Try sending the reply again.');
    }

    return [
        `chatroom-style|${previous.style || reply.style || 'mixed'}`,
        ...getLastRows(previous.rows, maxPreviousRows),
        ...(viewerRow ? [viewerRow] : []),
        ...newRows,
        'chatroom-end',
    ].join('\n');
}

/**
 * Run options for answering a viewer reply: the current feed and the reply go to the model
 * as context, the viewer's post shows straight away, and the answer is appended to the feed.
 * @param {{ previousContent?: string, viewerName?: string, viewerText?: string }} options
 * @returns {{ extraContextSections: { title: string, content: string }[], pendingContent: string, transformContent: (content: string) => string }}
 */
export function buildChatroomReplyRunOptions({ previousContent = '', viewerName = '', viewerText = '' } = {}) {
    const name = getChatroomViewerName(viewerName);
    const text = normalizeChatroomField(viewerText);
    const previous = parseChatroomFeed(previousContent);
    const style = previous.style || 'mixed';
    const currentRows = getLastRows(previous.rows, CHATROOM_REPLY_CONTEXT_ROWS);

    const extraContextSections = [
        ...(currentRows.length ? [{ title: 'Current chatroom', content: [`chatroom-style|${style}`, ...currentRows, 'chatroom-end'].join('\n') }] : []),
        { title: 'Viewer reply', content: `${name}: ${text}` },
        {
            title: 'Chatroom reply task',
            content: [
                `${name} just posted the viewer reply above into this live chatroom, and the room sees it right away.`,
                `Continue the same feed with 3 to 6 new lines. Open with one or two chatroom-reply lines that answer ${name} directly, with ${name} in the replying-to field, and react to exactly what they said.`,
                'Then let the room carry on: other regulars can pile on, disagree, quote earlier posts, vote, start a poll, or trigger a room event when it fits.',
                `Write chatroom-style|${style} first, then only the new lines, then chatroom-end. The app adds them below the existing feed, so the posts already in [Current chatroom] stay where they are.`,
            ].join('\n'),
        },
    ];

    return {
        extraContextSections,
        pendingContent: buildChatroomPendingFeed({ previousContent, viewerName: name, viewerText: text }),
        transformContent: content => mergeChatroomReplyFeed({ previousContent, replyContent: content, viewerName: name, viewerText: text }),
    };
}
