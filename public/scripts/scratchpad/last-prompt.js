// 'Last prompt sent': the exact prompt Neconyan last sent to the story model for one chat, cleaned for Scratchpad.
// Dependency-free so the server can store prompts with the same cleaning and Jest can test the formatting.

export const LAST_PROMPT_HEADING = '## Last prompt sent';
export const HIDDEN_ENTRY_PLACEHOLDER = '[hidden lorebook entry omitted]';
export const IMAGE_PLACEHOLDER = '[image omitted]';
export const MEDIA_PLACEHOLDER = '[media omitted]';
/** Well inside Scratchpad's MAX_CONTEXT_BYTES, so a huge prompt still leaves room for the rest of the context. */
export const LAST_PROMPT_MAX_BYTES = 256 * 1024;
/** What one stored prompt may hold before it is cut, on either side. */
export const STORED_PROMPT_MAX_CHARS = 600_000;
const MAX_MESSAGES = 2000;
const MAX_LABEL = 120;
const TOKEN_FIELDS = Object.freeze([
    ['oaiStartTokens', 'start'], ['oaiMainTokens', 'main prompt'], ['oaiNsfwTokens', 'auxiliary prompt'], ['oaiJailbreakTokens', 'post-history instructions'],
    ['oaiImpersonateTokens', 'impersonation'], ['oaiExamplesTokens', 'examples'], ['oaiConversationTokens', 'conversation'], ['oaiBiasTokens', 'bias'],
    ['oaiNudgeTokens', 'nudge'], ['oaiPromptTokens', 'prompt'], ['oaiSystemTokens', 'system'], ['oaiTotalTokens', 'total'],
]);
const MODE_LABELS = Object.freeze({ roleplay: 'Roleplay', conversation: 'Conversation' });
const API_LABELS = Object.freeze({ openai: 'Chat Completion', textgenerationwebui: 'Text Completion', kobold: 'KoboldAI', koboldhorde: 'KoboldAI Horde', novel: 'NovelAI' });

const DATA_URI = /data:([a-z]+)\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{16,}/gi;
const LONG_BASE64 = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/=]{400,}/g;
const looksEncoded = value => /\d/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value);

// Each pattern needs a shape that ordinary prose, dialogue and lorebook text does not have: a header name, a known key prefix, a JWT,
// a password inside a URL or a secret query parameter.
const REDACTIONS = Object.freeze([
    [/^([ \t>"'-]*)((?:proxy-)?authorization|x-[a-z-]*api-?key|x-goog-api-key|api-key)(\s*:\s*)(?!\[redacted\])[^\r\n]+/gim, '$1$2$3[redacted]'],
    [/^([ \t>"'-]*)((?:set-)?cookie)(\s*:\s*)(?!\[redacted\])(?=[^\r\n]*=)[^\r\n]+/gim, '$1$2$3[redacted]'],
    [/\b(Bearer|Basic|Token)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/-]{16,}=*/g, '$1 [redacted]'],
    [/\b((?:api|access|refresh|secret|client)[-_]?(?:key|token|secret)|password|passwd)(["']?\s*[:=]\s*["']?)(?=[^\s"',;]*\d)[^\s"',;]{8,}/gi, '$1$2[redacted]'],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted JWT]'],
    [/\b((?:sk|pk|rk|gsk|hf|nvapi|pplx|xai|glpat|fw|r8|csk|sess)[-_](?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,})/g, '[redacted key]'],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted key]'],
    [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, '[redacted key]'],
    [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted key]'],
    [/\bAIza[0-9A-Za-z_-]{30,}/g, '[redacted key]'],
    [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted key]'],
    [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@'],
    [/([?&](?:key|api[-_]?key|apikey|token|access[-_]?token|auth|secret|client[-_]?secret|password|sig|signature|x-amz-signature|x-amz-credential)=)(?!\[redacted\])[^&\s#"'<>)]+/gi, '$1[redacted]'],
    [/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{40,}\b/g, '[redacted key]'],
]);

const text = value => typeof value === 'string' ? value : '';
const clipLabel = value => text(value).replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
const byteLength = value => new TextEncoder().encode(value).length;

/**
 * Replaces base64 media with a short note, so a picture sent with a message never reaches Scratchpad as text.
 * @param {string} value
 */
export function omitInlineMedia(value) {
    return text(value)
        .replace(DATA_URI, (_, kind) => String(kind).toLowerCase() === 'image' ? IMAGE_PLACEHOLDER : MEDIA_PLACEHOLDER)
        .replace(LONG_BASE64, match => looksEncoded(match) ? MEDIA_PLACEHOLDER : match);
}

/**
 * Removes credentials from prompt text and leaves everything else as it was.
 * @param {string} value
 * @returns {{ text: string, count: number }}
 */
export function redactPromptText(value) {
    let count = 0;
    let result = text(value);
    for (const [pattern, replacement] of REDACTIONS) {
        result = result.replace(pattern, (...args) => {
            count++;
            return replacement.replace(/\$(\d)/g, (_, index) => args[Number(index)] ?? '');
        });
    }
    return { text: result, count };
}

function partText(part) {
    if (typeof part === 'string') return omitInlineMedia(part);
    if (!part || typeof part !== 'object') return '';
    const type = text(part.type).toLowerCase();
    if (type === 'text' || type === 'input_text' || (!type && typeof part.text === 'string')) return omitInlineMedia(part.text);
    if (type.includes('image') || part.image_url || part.inline_data?.mime_type?.startsWith?.('image/')) return IMAGE_PLACEHOLDER;
    return MEDIA_PLACEHOLDER;
}

function contentText(content) {
    if (typeof content === 'string') return omitInlineMedia(content);
    if (Array.isArray(content)) return content.map(partText).filter(Boolean).join('\n');
    if (content && typeof content === 'object') return partText(content);
    return content === undefined || content === null ? '' : String(content);
}

function toolCallsText(calls) {
    if (!Array.isArray(calls) || !calls.length) return '';
    return calls.map(call => {
        const name = clipLabel(call?.function?.name || call?.name) || 'tool';
        const args = call?.function?.arguments ?? call?.arguments ?? call?.input;
        return `[tool call: ${name}${args === undefined ? '' : ` ${omitInlineMedia(typeof args === 'string' ? args : JSON.stringify(args))}`}]`;
    }).join('\n');
}

/**
 * The prompt as stored and shown: a string for text prompts, or messages with plain text content, media left out.
 * @param {unknown} prompt
 * @returns {string|{ role: string, name?: string, content: string }[]|null}
 */
export function normalisePromptPayload(prompt) {
    if (typeof prompt === 'string') return prompt ? omitInlineMedia(prompt) : null;
    if (!Array.isArray(prompt)) return null;
    // Past the cap, keep the opening instructions and the latest messages, with a note where the middle was.
    const head = Math.floor(MAX_MESSAGES / 10);
    const kept = prompt.length <= MAX_MESSAGES ? prompt
        : [...prompt.slice(0, head), { role: 'note', content: `[... omitted ${prompt.length - MAX_MESSAGES} messages before saving ...]` }, ...prompt.slice(head - MAX_MESSAGES)];
    const messages = kept.flatMap(message => {
        if (typeof message === 'string') return [{ role: 'user', content: omitInlineMedia(message) }];
        if (!message || typeof message !== 'object') return [];
        const role = clipLabel(message.role) || 'user';
        const name = clipLabel(message.name);
        const content = [contentText(message.content), toolCallsText(message.tool_calls)].filter(Boolean).join('\n');
        return [{ role, ...(name ? { name } : {}), content }];
    });
    return messages.length ? messages : null;
}

function promptChars(prompt) {
    return typeof prompt === 'string' ? prompt.length : prompt.reduce((sum, message) => sum + message.content.length, 0);
}

function clipStored(prompt) {
    if (promptChars(prompt) <= STORED_PROMPT_MAX_CHARS) return { prompt, clipped: false };
    if (typeof prompt === 'string') {
        const half = Math.floor(STORED_PROMPT_MAX_CHARS / 2);
        return { prompt: `${prompt.slice(0, half)}\n[... omitted ${prompt.length - half * 2} characters before saving ...]\n${prompt.slice(-half)}`, clipped: true };
    }
    const limit = Math.floor(STORED_PROMPT_MAX_CHARS / Math.max(1, prompt.length));
    return {
        prompt: prompt.map(message => message.content.length <= limit ? message
            : { ...message, content: `${message.content.slice(0, Math.floor(limit / 2))}\n[... omitted ${message.content.length - Math.floor(limit / 2) * 2} characters before saving ...]\n${message.content.slice(-Math.floor(limit / 2))}` }),
        clipped: true,
    };
}

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * One prompt record with only the fields Scratchpad shows, credentials redacted and media left out. Returns null without a prompt.
 * @param {object} input
 */
export function normalisePromptRecord(input) {
    if (!input || typeof input !== 'object') return null;
    const payload = normalisePromptPayload(input.prompt);
    if (!payload) return null;
    let redactions = finiteNumber(input.redactions);
    const redact = value => {
        const result = redactPromptText(value);
        redactions += result.count;
        return result.text;
    };
    const cleaned = typeof payload === 'string' ? redact(payload) : payload.map(message => ({ ...message, content: redact(message.content) }));
    const { prompt, clipped } = clipStored(cleaned);
    const tokens = Object.fromEntries(TOKEN_FIELDS.map(([key]) => [key, finiteNumber(input.tokens?.[key])]).filter(([, value]) => value));
    return {
        recordedAt: finiteNumber(input.recordedAt),
        origin: input.origin === 'server' ? 'server' : 'browser',
        mode: input.mode === 'conversation' ? 'conversation' : 'roleplay',
        ...Object.fromEntries(['api', 'backend', 'model', 'preset', 'speaker', 'tokenizer', 'generationType'].map(key => [key, clipLabel(input[key])]).filter(([, value]) => value)),
        ...(finiteNumber(input.contextLimit) ? { contextLimit: finiteNumber(input.contextLimit) } : {}),
        ...(finiteNumber(input.messagesCount) ? { messagesCount: finiteNumber(input.messagesCount) } : {}),
        ...(finiteNumber(input.examplesCount) ? { examplesCount: finiteNumber(input.examplesCount) } : {}),
        ...(Object.keys(tokens).length ? { tokens } : {}),
        ...(redactions ? { redactions } : {}),
        ...(clipped || input.clipped === true || (Array.isArray(input.prompt) && input.prompt.length > MAX_MESSAGES) ? { clipped: true } : {}),
        prompt,
    };
}

function hasPrompt(entry) {
    const raw = entry?.rawPrompt;
    return (typeof raw === 'string' && raw.length > 0) || (Array.isArray(raw) && raw.length > 0);
}

/**
 * The prompt this chat sent most recently. Entries carry recordedAt from now on; older saved entries have none, and the last one
 * in the list stands in for them. Background (quiet) prompts are not story prompts.
 * @param {object[]} entries itemizedPrompts for one chat
 */
export function latestItemizedPrompt(entries) {
    const candidates = (Array.isArray(entries) ? entries : []).filter(entry => hasPrompt(entry) && entry.generationType !== 'quiet');
    if (!candidates.length) return null;
    const stamped = candidates.filter(entry => finiteNumber(entry.recordedAt));
    if (!stamped.length) return candidates.at(-1);
    return stamped.reduce((latest, entry) => finiteNumber(entry.recordedAt) >= finiteNumber(latest.recordedAt) ? entry : latest);
}

/** @param {object} entry one itemizedPrompts entry */
export function itemizedPromptRecord(entry) {
    if (!hasPrompt(entry)) return null;
    return normalisePromptRecord({
        recordedAt: entry.recordedAt, origin: 'browser', mode: 'roleplay', api: entry.main_api, preset: entry.presetName,
        model: entry.model, contextLimit: entry.this_max_context, tokenizer: entry.tokenizer, messagesCount: entry.messagesCount,
        examplesCount: entry.examplesCount, generationType: entry.generationType, prompt: entry.rawPrompt,
        tokens: Object.fromEntries(TOKEN_FIELDS.map(([key]) => [key, entry[key]])),
    });
}

/**
 * The newer of the browser and server records for the open chat. A record without a time loses to one with a time.
 * @param {(object|null|undefined)[]} records
 */
export function pickLatestPrompt(records) {
    const usable = records.filter(record => record && record.prompt);
    if (!usable.length) return null;
    return usable.reduce((latest, record) => finiteNumber(record.recordedAt) > finiteNumber(latest.recordedAt) ? record : latest);
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Texts to scrub for each hidden lorebook entry: its content as written and with {{user}} and {{char}} filled in, plus each long
 * line on its own so a partly included entry is caught too.
 * @param {{ content?: string }[]} entries hidden (agentBlacklisted) entries
 * @param {((value: string) => string)|((value: string) => string)[]} [substitute] one or more ways to fill in names
 */
export function hiddenEntryNeedles(entries, substitute = []) {
    const needles = new Set();
    const substitutes = (Array.isArray(substitute) ? substitute : [substitute]).filter(item => typeof item === 'function');
    const apply = (fn, raw) => {
        try {
            return text(fn(raw)).trim();
        } catch {
            return '';
        }
    };
    for (const entry of Array.isArray(entries) ? entries : []) {
        const raw = text(entry?.content).trim();
        if (!raw) continue;
        const variants = new Set([raw, ...substitutes.map(fn => apply(fn, raw))]);
        for (const value of [...variants]) variants.add(redactPromptText(value).text);
        for (const variant of variants) {
            if (!variant) continue;
            needles.add(variant);
            for (const line of variant.split(/\r?\n/)) {
                if (line.trim().length >= 16) needles.add(line.trim());
            }
        }
    }
    return [...needles].sort((a, b) => b.length - a.length);
}

/**
 * Replaces every occurrence of a hidden entry, ignoring case and differences in whitespace.
 * @param {string} value
 * @param {string[]} needles from hiddenEntryNeedles
 * @returns {{ text: string, count: number }}
 */
export function scrubHiddenEntries(value, needles) {
    let count = 0;
    let result = text(value);
    for (const needle of needles) {
        // Whole words only at the edges, so a one-word entry does not cut that word out of longer words.
        const start = /^[\p{L}\p{N}]/u.test(needle) ? '(?<![\\p{L}\\p{N}])' : '';
        const end = /[\p{L}\p{N}]$/u.test(needle) ? '(?![\\p{L}\\p{N}])' : '';
        const pattern = new RegExp(`${start}${needle.split(/\s+/).map(escapeRegExp).join('\\s+')}${end}`, 'giu');
        result = result.replace(pattern, () => {
            count++;
            return HIDDEN_ENTRY_PLACEHOLDER;
        });
    }
    return { text: result, count };
}

function trimToBytes(body, maxBytes) {
    if (byteLength(body) <= maxBytes) return { body, omitted: 0 };
    let keep = Math.max(0, Math.floor(maxBytes / Math.max(1, byteLength(body) / body.length)) - 120);
    for (;;) {
        const headLength = Math.floor(keep * 0.4);
        const tailLength = keep - headLength;
        const omitted = body.length - headLength - tailLength;
        const trimmed = `${body.slice(0, headLength)}\n[... omitted ${omitted} characters to fit Scratchpad budget ...]\n${body.slice(body.length - tailLength)}`;
        if (byteLength(trimmed) <= maxBytes || keep === 0) return { body: trimmed, omitted };
        keep = Math.floor(keep * 0.9);
    }
}

function age(recordedAt, now) {
    const seconds = Math.max(0, Math.round((now - recordedAt) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.round(hours / 24);
    return `${days} days ago`;
}

function headerLines(record, now) {
    const lines = [];
    lines.push(record.recordedAt ? `Sent: ${new Date(record.recordedAt).toISOString()} (${age(record.recordedAt, now)})` : 'Sent: time not recorded (saved before Neconyan noted the time)');
    const api = API_LABELS[record.api] || record.api;
    lines.push(`Mode: ${[MODE_LABELS[record.mode] || 'Roleplay', api, record.backend && record.backend !== record.api ? record.backend : '', record.generationType ? `${record.generationType} request` : ''].filter(Boolean).join(', ')}`);
    const who = [record.speaker ? `Speaker: ${record.speaker}` : '', record.model ? `Model: ${record.model}` : '', record.preset ? `Preset: ${record.preset}` : ''].filter(Boolean);
    if (who.length) lines.push(who.join('; '));
    const limits = [record.contextLimit ? `Context limit: ${record.contextLimit} tokens` : '', record.tokenizer ? `Tokenizer: ${record.tokenizer}` : '',
        record.messagesCount ? `Chat messages in prompt: ${record.messagesCount}` : '', record.examplesCount ? `Example messages: ${record.examplesCount}` : ''].filter(Boolean);
    if (limits.length) lines.push(limits.join('; '));
    const tokens = TOKEN_FIELDS.filter(([key]) => record.tokens?.[key]).map(([key, label]) => `${label} ${record.tokens[key]}`);
    if (tokens.length) lines.push(`Token counts: ${tokens.join(', ')}`);
    return lines;
}

/**
 * The note shown when the open chat has not sent a prompt yet, or the prompt could not be read.
 * @param {string} [reason]
 */
export function formatMissingLastPrompt(reason = 'No prompt has been sent in this chat yet, so there is nothing to share. Send or regenerate a message, then look again.') {
    return `${LAST_PROMPT_HEADING}\n${reason}`;
}

/**
 * The 'Last prompt sent' section: a short header, then the prompt in order with roles and exact text.
 * @param {object} record from normalisePromptRecord
 * @param {{ hiddenNeedles?: string[], maxBytes?: number, now?: number }} [options]
 * @returns {{ text: string, hidden: number, redactions: number, trimmed: number }}
 */
export function formatLastPrompt(record, { hiddenNeedles = [], maxBytes = LAST_PROMPT_MAX_BYTES, now = Date.now() } = {}) {
    const normalised = record?.prompt && (typeof record.prompt === 'string' || Array.isArray(record.prompt)) ? normalisePromptRecord(record) : null;
    if (!normalised) return { text: formatMissingLastPrompt(), hidden: 0, redactions: 0, trimmed: 0 };
    let hidden = 0;
    let redactions = normalised.redactions || 0;
    const clean = value => {
        const scrubbed = scrubHiddenEntries(value, hiddenNeedles);
        hidden += scrubbed.count;
        const redacted = redactPromptText(scrubbed.text);
        redactions += redacted.count;
        return redacted.text;
    };
    const body = typeof normalised.prompt === 'string'
        ? `Prompt text (exact):\n${clean(normalised.prompt)}\n[end of prompt]`
        : normalised.prompt.map((message, index) => `### ${index + 1}. ${message.role}${message.name ? ` (name: ${message.name})` : ''}\n${clean(message.content)}`).join('\n\n');
    const lines = headerLines(normalised, now);
    if (Array.isArray(normalised.prompt)) lines.push(`Messages: ${normalised.prompt.length}`);
    const notes = [
        hidden ? 'Hidden lorebook entries were omitted.' : '',
        redactions ? `Credentials were redacted (${redactions}).` : '',
        normalised.clipped ? 'The saved prompt was longer than Neconyan keeps, so its middle was left out when it was saved.' : '',
    ];
    const headerBytes = byteLength([LAST_PROMPT_HEADING, ...lines, ...notes, 'Notes: The middle was trimmed to fit the Scratchpad budget.'].join('\n')) + 2;
    const trimmed = trimToBytes(body, Math.max(1024, maxBytes - headerBytes));
    if (trimmed.omitted) notes.push(`The middle was trimmed to fit the Scratchpad budget (${trimmed.omitted} characters left out).`);
    const noteText = notes.filter(Boolean).join(' ');
    if (noteText) lines.push(`Notes: ${noteText}`);
    // The prompt can hold its own '##' headings, so a message array closes with a plain marker.
    const end = Array.isArray(normalised.prompt) ? ['', '[end of last prompt sent]'] : [];
    return { text: [LAST_PROMPT_HEADING, ...lines, '', trimmed.body, ...end].join('\n'), hidden, redactions, trimmed: trimmed.omitted };
}
