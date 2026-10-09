import fs from 'node:fs';

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

    function flush() {
        try {
            fs.writeFileSync(file, entries.map(entry => entry.line + (entry.done ? '' : ' in flight')).join('\n') + '\n');
        } catch {
            // The trace is best effort; a full disk must not break a request.
        }
    }

    return function requestTrace(request, response, next) {
        const started = Date.now();
        const path = String(request.originalUrl || request.url || '').split('?')[0];
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
            entry.line += ` -> ${response.statusCode}${how === 'close' && !response.writableEnded ? ' (closed)' : ''} ${Date.now() - started}ms`;
            flush();
        };
        response.once('finish', () => finish('finish'));
        response.once('close', () => finish('close'));
        next();
    };
}
