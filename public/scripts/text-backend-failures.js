// Notes failed requests to KoboldAI (classic), NovelAI and text completion backends in the
// App diagnostics log. It only watches: it never changes a request, a prompt or a toast.
// It imports nothing but the recorder, so the generation modules can use it without any
// module-order risk.
import { recordProviderFailure } from './app-evidence-log.js';

const ECHO_WINDOW = 16;
const ECHO_SCAN_LIMIT = 2000;
const SOURCE_SCAN_LIMIT = 400000;
const LONG_TEXT = 80;
const PROMPT_KEYS = ['prompt', 'input', 'memory', 'authors_note', 'negative_prompt', 'system_prompt'];
const MESSAGE_KEYS = ['error', 'message', 'detail', 'response', 'msg', 'reason', 'description'];
const STATUS_KEYS = ['status', 'status_code', 'statusCode', 'provider_status'];
const TEXT_REMOVED = '[text removed]';
const SERVER_ADDRESS = '[server address]';
const NO_MESSAGE = 'The backend sent no error message.';
const NOT_REACHED = 'The app server got no reply from the backend (no error message was sent).';

/** @param {unknown} value @returns {number} An HTTP status from 100 to 599, else 0 */
function httpStatus(value) {
    const code = typeof value === 'string' && /^\s*\d{3}\s*$/.test(value) ? Number(value) : value;
    return Number.isInteger(code) && code >= 100 && code <= 599 ? /** @type {number} */ (code) : 0;
}

/** @param {string} text */
function plainText(text) {
    if (!/<\s*(?:!doctype|html|head|body|title|pre|div|p)\b/i.test(text)) return text;
    return text
        .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Finds the backend's own message and status in whatever shape the server passed on.
 * @param {unknown} value A parsed body, a JSON string or plain text
 * @param {number} depth
 * @returns {{ message: string, status: number }}
 */
function dig(value, depth) {
    const none = { message: '', status: 0 };
    if (depth > 8 || value === null || value === undefined) return none;
    if (typeof value === 'string') {
        const text = value.trim();
        if (!text) return none;
        if (/^[{[]/.test(text)) {
            try {
                return dig(JSON.parse(text), depth + 1);
            } catch {
                // Not JSON after all.
            }
        }
        return { message: plainText(text), status: 0 };
    }
    if (typeof value === 'number') return none;
    if (Array.isArray(value)) {
        const parts = [];
        let status = 0;
        for (const item of value.slice(0, 3)) {
            const found = dig(item, depth + 1);
            if (found.message) parts.push(found.message);
            status ||= found.status;
        }
        return { message: parts.join('; '), status };
    }
    if (typeof value !== 'object') return none;
    const body = /** @type {Record<string, unknown>} */ (value);
    let status = 0;
    for (const key of STATUS_KEYS) {
        status = httpStatus(body[key]);
        if (status) break;
    }
    for (const key of MESSAGE_KEYS) {
        const found = dig(body[key], depth + 1);
        status ||= found.status;
        if (found.message) return { message: found.message, status };
    }
    return { message: '', status };
}

/**
 * The backend's error message and HTTP status out of an error body.
 * @param {unknown} body A parsed object, a JSON string or plain text
 * @param {number} [fromHttp] The status of the response that carried the body
 * @param {string} [fallback] Used when the body says nothing, such as the status text
 */
export function readBackendFailure(body, fromHttp = 0, fallback = '') {
    const found = dig(body, 0);
    return {
        message: found.message || String(fallback || '').trim() || NO_MESSAGE,
        status: found.status || httpStatus(fromHttp),
    };
}

/**
 * Hides where a self-hosted backend lives: URLs, IP addresses and host:port pairs.
 * @param {unknown} value
 */
export function withoutServerAddresses(value) {
    return String(value ?? '')
        .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]*/gi, SERVER_ADDRESS)
        .replace(/(^|[\s(<"'])\/\/[^\s/"'<>]+(?:\/[^\s"'<>)]*)?/g, `$1${SERVER_ADDRESS}`)
        .replace(/\[[0-9a-f:]{3,}\](?::\d{1,5})?/gi, SERVER_ADDRESS)
        .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, SERVER_ADDRESS)
        .replace(/\b(?:ENOTFOUND|EAI_AGAIN)\s+[^\s,;]+/g, match => `${match.split(/\s+/)[0]} ${SERVER_ADDRESS}`)
        .replace(/\blocalhost(?::\d{1,5})?\b/gi, SERVER_ADDRESS)
        .replace(/\b[a-z0-9_-]+(?:\.[a-z0-9_-]+)+:\d{1,5}\b/gi, SERVER_ADDRESS);
}

/**
 * Lower-cases, undoes JSON escapes and squeezes white space, so a quote of the prompt inside a
 * JSON error body still lines up with the prompt itself.
 * @param {string} text
 * @returns {{ text: string, from: number[], to: number[] }} Each kept character with its range in the original
 */
function squeeze(text) {
    let out = '';
    const from = [];
    const to = [];
    for (let i = 0; i < text.length; i++) {
        let end = i + 1;
        let char = text[i];
        if (char === '\\' && i + 1 < text.length && 'nrt"'.includes(text[i + 1])) {
            char = text[i + 1] === '"' ? '"' : ' ';
            end = i + 2;
        }
        if (/\s/.test(char)) {
            char = ' ';
            if (out.endsWith(' ')) {
                to[to.length - 1] = end;
                i = end - 1;
                continue;
            }
        }
        out += char.toLowerCase().slice(0, 1) || char;
        from.push(i);
        to.push(end);
        i = end - 1;
    }
    return { text: out, from, to };
}

/** @param {unknown} node @param {string[]} found @param {number} depth */
function collectTexts(node, found, depth) {
    if (typeof node === 'string') {
        if (node.length >= LONG_TEXT) found.push(node);
        return;
    }
    if (depth > 3 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        for (const item of node.slice(0, 50)) collectTexts(item, found, depth + 1);
        return;
    }
    for (const [key, item] of Object.entries(node)) {
        if (typeof item === 'string' && PROMPT_KEYS.includes(key) && item.trim()) found.push(item);
        else collectTexts(item, found, depth + 1);
    }
}

/**
 * Cuts out of a message every stretch that also occurs in the text that was sent or received,
 * because some backends quote the prompt in their error.
 * @param {string} message
 * @param {string[]} sources Prompt-bearing text and any reply text received so far
 */
export function withoutEchoes(message, sources) {
    const text = String(message ?? '').slice(0, ECHO_SCAN_LIMIT);
    const corpus = sources.filter(source => typeof source === 'string' && source.trim()).map(source => squeeze(source).text).join('\n').slice(0, SOURCE_SCAN_LIMIT);
    if (!text || corpus.length < ECHO_WINDOW) return text;
    const seen = new Set();
    for (let i = 0; i + ECHO_WINDOW <= corpus.length; i++) seen.add(corpus.slice(i, i + ECHO_WINDOW));
    const squeezed = squeeze(text);
    const covered = new Array(squeezed.text.length).fill(false);
    for (let i = 0; i + ECHO_WINDOW <= squeezed.text.length; i++) {
        const slice = squeezed.text.slice(i, i + ECHO_WINDOW);
        if (slice.replace(/\s/g, '').length < 8 || !seen.has(slice)) continue;
        covered.fill(true, i, i + ECHO_WINDOW);
    }
    let result = '';
    let cursor = 0;
    for (let i = 0; i < covered.length; i++) {
        if (!covered[i]) continue;
        let last = i;
        while (last + 1 < covered.length && covered[last + 1]) last++;
        result += text.slice(cursor, squeezed.from[i]) + TEXT_REMOVED;
        cursor = squeezed.to[last];
        i = last;
    }
    return result + text.slice(cursor);
}

const RECENT_REQUESTS = 5;
/** @type {{ sources: string[], received: string }[]} What the last few failed requests sent and got, newest first */
const recentRequests = [];

/**
 * Cuts out of a text any stretch that quotes what the last few failed text backend requests sent or
 * received. An error the page did not catch carries the backend's message, and some backends
 * quote the prompt in it, so the browser errors in the shared evidence go through this.
 * @param {unknown} text
 * @param {{ addresses?: 'message' | 'stack' | false }} [options] Also replace server addresses: in all of a message, or in the lines of a stack that are not frames (frames name the app's own scripts)
 */
export function withoutRecentRequestText(text, { addresses = false } = {}) {
    if (typeof text !== 'string' || !text || !recentRequests.length) return text;
    try {
        const cut = withoutEchoes(text, recentRequests.flatMap(request => [...request.sources, request.received]));
        if (addresses === 'message') return withoutServerAddresses(cut);
        if (addresses === 'stack') return cut.split('\n').map(line => (/^\s*at\s/.test(line) ? line : withoutServerAddresses(line))).join('\n');
        return cut;
    } catch {
        return text;
    }
}

/**
 * True for a request the person stopped, or one that was cut off on purpose (such as the
 * length limit), which is not a failure.
 * @param {unknown} error
 * @param {AbortSignal | null | undefined} signal
 */
export function isStoppedRequest(error, signal) {
    const named = /** @type {{ name?: unknown }} */ (error ?? {});
    return Boolean(signal?.aborted) || named.name === 'AbortError' || (Boolean(signal) && error === signal?.reason);
}

/** @param {string} kind 'kobold', 'novel' or 'text' @param {string} type The text completion type, such as 'llamacpp' */
export function backendLabel(kind, type = '') {
    if (kind === 'kobold') return 'koboldai';
    if (kind === 'novel') return 'novelai';
    const name = String(type ?? '').replace(/[^\w.-]/g, '').slice(0, 30);
    return name ? `text completion (${name})` : 'text completion';
}

/**
 * Watches one request to a KoboldAI, NovelAI or text completion backend. However many places
 * see the same failure, it makes one entry.
 * @param {{ kind: 'kobold' | 'novel' | 'text', type?: string, model?: unknown, data?: unknown, signal?: AbortSignal | null }} request
 */
export function watchTextBackend({ kind, type = '', model = '', data = null, signal = null }) {
    const sources = [];
    collectTexts(data, sources, 0);
    const sent = { sources, received: '' };
    let recorded = false;

    /** @param {string} message @param {number} status */
    const record = (message, status) => {
        if (recorded) return;
        recorded = true;
        try {
            recentRequests.unshift(sent);
            recentRequests.length = Math.min(recentRequests.length, RECENT_REQUESTS);
            const clean = withoutEchoes(withoutServerAddresses(message), [...sources, sent.received]);
            recordProviderFailure({
                provider: backendLabel(kind, type),
                model: withoutServerAddresses(model),
                status,
                message: clean,
            });
        } catch {
            // Diagnostics never get in the way of a request.
        }
    };

    const watch = {
        get recorded() {
            return recorded;
        },
        /** A response with an error status @param {Response} response @param {unknown} body */
        rejected(response, body) {
            if (recorded) return;
            const found = readBackendFailure(body, response?.status, response?.statusText);
            record(found.message, found.status);
        },
        /** An answer that came back as a normal response but carries an error @param {unknown} body */
        answered(body) {
            const error = /** @type {{ error?: unknown } | null} */ (body && typeof body === 'object' ? body : null)?.error;
            if (recorded || !error) return;
            const found = dig(body, 0);
            record(found.message || NOT_REACHED, found.status);
        },
        /** Looks at a response that is meant to be a stream, in case the server sent a JSON error instead @param {Response} response */
        async inspect(response) {
            if (recorded || !response?.ok || !/json/i.test(response.headers?.get?.('content-type') ?? '') || /event-stream/i.test(response.headers?.get?.('content-type') ?? '')) return;
            try {
                watch.answered(JSON.parse(await response.clone().text()));
            } catch {
                // Not readable: leave it to the reader.
            }
        },
        /** @param {unknown} error Whatever was thrown @param {number} [fromHttp] The status of the response it came with */
        fail(error, fromHttp = 0) {
            if (recorded || isStoppedRequest(error, signal)) return;
            if (error instanceof Error) {
                record(error.message || NO_MESSAGE, httpStatus(/** @type {{ status?: unknown }} */ (error).status) || httpStatus(fromHttp));
                return;
            }
            const found = readBackendFailure(error, fromHttp);
            record(found.message, found.status);
        },
        /** Wraps a stream reader, so a failure while reading it is noted @param {() => AsyncIterable<any>} stream */
        observe(stream) {
            return async function* observed(...args) {
                try {
                    for await (const chunk of /** @type {any} */ (stream)(...args)) {
                        if (typeof chunk?.text === 'string') sent.received = chunk.text;
                        yield chunk;
                    }
                } catch (error) {
                    watch.fail(error);
                    throw error;
                }
            };
        },
        /** Opens a request and notes it if it throws; a stream reader it returns is watched too @param {() => Promise<any>} open */
        async run(open) {
            try {
                const result = await open();
                return typeof result === 'function' ? watch.observe(result) : result;
            } catch (error) {
                watch.fail(error);
                throw error;
            }
        },
    };
    return watch;
}
