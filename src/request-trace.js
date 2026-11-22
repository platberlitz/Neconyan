import fs from 'node:fs';

let snapshot = () => [];
export function getRecentRequests() { return snapshot(); }

const FINISHED_REQUEST_LIMIT = 300;
/** @type {{ at: number, method: string, path: string, bytes: number, status: number, ms: number, closed: boolean, long: boolean, handle: string }[]} */
const finishedRequests = [];

function recordFinishedRequest(entry) {
    finishedRequests.push(entry);
    if (finishedRequests.length > FINISHED_REQUEST_LIMIT) finishedRequests.splice(0, finishedRequests.length - FINISHED_REQUEST_LIMIT);
}

// Replies that stream or wait on a model are slow by design, so they never count as slow requests.
function isLongRunningResponse(path, response) {
    const type = String(response.getHeader?.('content-type') || '');
    return type.includes('text/event-stream') || /\/generate$/.test(path) || path.startsWith('/api/resumable-generations');
}

/**
 * Finished API requests with the account that made them, newest first. Only the
 * method, operation, size, status and timing are kept, never a URL or a body.
 * The account handle is for filtering by the caller and must not be sent on.
 */
export function getRecentRequestEntries() {
    return finishedRequests.map(entry => ({ ...entry })).reverse();
}
const API_CATEGORIES = new Set(('resumable-generations users moving-ui images quick-replies avatars themes openai google anthropic tokenizers presets secrets novelai extensions assets files characters chats groups worldinfo notebooks scratchpad stats backgrounds sprites content settings horde vector translate extra search account-search backends openrouter nanogpt speech azure minimax data-maid backups image-metadata server-admin in-chat-agents neconyan-conversation chat-navigation mewmory jobs meower labs operations roleplay').split(' '));

// Keep API operation names, never filenames, chat ids, query strings or user routes.
export function diagnosticRequestPath(url) {
    const backend = String(url || '').match(/^\/api\/backends\/(chat-completions|text-completions)\/(generate|status|models)(?:\?|$)/);
    if (backend) return `/api/backends/${backend[1]}/${backend[2]}`;
    const match = String(url || '').match(/^\/api\/([a-z-]+)(?:\/([a-z-]+))?(?:\/|\?|$)/);
    if (match && !API_CATEGORIES.has(match[1])) return '/api/[path omitted]';
    const operation = match?.[2];
    const known = /^(?:get|save|list|delete|create|update|status|generate|import|export|upload|download|search|logs|crash-reports|all|abort|cancel|stop|start|settings)$/;
    return match ? `/api/${match[1]}${operation ? '/' + (known.test(operation) ? operation : '[operation omitted]') : ''}` : '/[non-api path omitted]';
}

/**
 * Keeps a short, plain-text record of the most recent requests on disk so that a
 * crash which takes the whole process down can still be matched to the request
 * that was in flight. The Android launcher reads this file after a restart; it
 * never holds message text, only method, path, size, status and timing.
 *
 * @param {string} file Where to write the trace
 * @param {object} [options]
 * @param {number} [options.limit] How many requests to keep
 * @returns {import('express').RequestHandler}
 */
export function createRequestTrace(file, { limit = 30 } = {}) {
    /** @type {{ started: number, line: string, done: boolean }[]} */
    const entries = [];
    snapshot = () => entries.map(entry => entry.line + (entry.done ? '' : ' in flight'));

    function flush() {
        if (!file) return;
        try {
            fs.writeFileSync(file, snapshot().join('\n') + '\n', { mode: 0o600 });
        } catch {
            // The trace is best effort; a full disk must not break a request.
        }
    }

    return function requestTrace(request, response, next) {
        // The trace exists to explain an interrupted API operation after a crash.
        // Styling and script requests cannot cause one, and writing them costs two
        // blocking file writes each on Android.
        if (!String(request.originalUrl || request.url || '').startsWith('/api/')) return next();
        const started = Date.now();
        const path = diagnosticRequestPath(request.originalUrl || request.url);
        const bytes = Number(request.headers['content-length']) || 0;
        const entry = {
            started,
            line: `${new Date(started).toISOString()} ${request.method} ${path} ${bytes}B`,
            done: false,
        };
        entries.push(entry);
        if (entries.length > limit) entries.splice(0, entries.length - limit);
        flush();
        let finished = false;
        const finish = (how) => {
            if (finished) return;
            finished = true;
            entry.done = true;
            const closed = how === 'close' && !response.writableEnded;
            const elapsed = Date.now() - started;
            entry.line += ` -> ${response.statusCode}${closed ? ' (closed)' : ''} ${elapsed}ms`;
            recordFinishedRequest({
                at: started,
                method: String(request.method || ''),
                path,
                bytes,
                status: response.statusCode,
                ms: elapsed,
                closed,
                long: isLongRunningResponse(path, response),
                handle: typeof request.user?.profile?.handle === 'string' ? request.user.profile.handle : '',
            });
            flush();
        };
        response.once('finish', () => finish('finish'));
        response.once('close', () => finish('close'));
        next();
    };
}
