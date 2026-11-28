import http from 'node:http';
import { Buffer } from 'node:buffer';

/**
 * Keeps quiet event streams open through reverse proxies.
 *
 * nginx, Caddy, Cloudflare and similar proxies buffer event streams or close a connection that has
 * been silent for a while (often 60 to 100 seconds). Reasoning models and long Agent steps can stay
 * quiet for longer than that, so a streamed reply was cut off part way. An SSE comment line is
 * ignored by every event-stream parser, so writing one after a quiet spell keeps the connection
 * alive without changing the reply.
 */

export const SSE_KEEP_ALIVE_INTERVAL_MS = 15_000;
export const SSE_KEEP_ALIVE_COMMENT = ': keep-alive\n\n';

const EVENT_STREAM_PATTERN = /^text\/event-stream\b/i;
const TAIL_LENGTH = 4;

let keepAliveIntervalMs = SSE_KEEP_ALIVE_INTERVAL_MS;

/**
 * @param {unknown} value Content-Type header value
 * @returns {boolean} Whether the value names an event stream
 */
export function isEventStreamContentType(value) {
    return EVENT_STREAM_PATTERN.test(String(value ?? '').trim());
}

/**
 * Marks a response as an unbuffered, untransformed event stream.
 * An existing Content-Type is kept; nothing is changed once headers are sent.
 * @param {object} response Express or Node response
 * @param {string} [contentType] Content type to use when none is set yet
 * @returns {boolean} Whether the headers were set
 */
export function setEventStreamHeaders(response, contentType = 'text/event-stream') {
    if (!response || response.headersSent || typeof response.setHeader !== 'function') {
        return false;
    }
    if (!response.getHeader?.('content-type')) {
        response.setHeader('Content-Type', contentType);
    }
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('X-Accel-Buffering', 'no');
    return true;
}

/**
 * Whether a response writes to a real client connection. In-process captures and test doubles do
 * not, and a comment written into a capture would count as provider activity and hide a stalled
 * provider from its idle timeout.
 * @param {unknown} response Response
 * @returns {boolean}
 */
export function isClientResponse(response) {
    return response instanceof http.ServerResponse;
}

/**
 * Returns the last few characters of a written chunk, as text that keeps line endings intact.
 * @param {unknown} chunk Written chunk
 * @param {string} [encoding] Encoding of a string chunk
 * @returns {string}
 */
function chunkTail(chunk, encoding) {
    if (typeof chunk === 'string') {
        if (encoding && Buffer.isEncoding(encoding) && !/^utf-?8$/i.test(encoding)) {
            return chunkTail(Buffer.from(chunk, /** @type {BufferEncoding} */ (encoding)));
        }
        return chunk.slice(-TAIL_LENGTH);
    }
    if (chunk instanceof Uint8Array) {
        const start = Math.max(0, chunk.byteLength - TAIL_LENGTH);
        return Buffer.from(chunk.buffer, chunk.byteOffset + start, chunk.byteLength - start).toString('latin1');
    }
    return '';
}

/**
 * Whether the stream so far ends with a blank line, so a comment cannot split an event. A trailing
 * lone CR may be the first half of a CRLF, so it never counts.
 * @param {string} tail Last characters written
 * @returns {boolean}
 */
export function endsAtEventBoundary(tail) {
    if (!tail) {
        return true;
    }
    let rest;
    if (tail.endsWith('\r\n')) {
        rest = tail.slice(0, -2);
    } else if (tail.endsWith('\n')) {
        rest = tail.slice(0, -1);
    } else {
        return false;
    }
    return !rest || rest.endsWith('\n') || rest.endsWith('\r');
}

/**
 * Writes an SSE comment whenever the stream has been quiet for a full interval.
 * Call `touch` with every chunk the stream writes and `stop` on every way the stream can finish.
 * @param {object} options
 * @param {(comment: string) => void} options.write Writes the comment to the stream
 * @param {() => boolean} [options.isOpen] False once the stream can no longer take writes
 * @param {number} [options.intervalMs] Quiet time before a comment
 * @param {(callback: () => void, delay: number) => any} [options.setTimer]
 * @param {(timer: any) => void} [options.clearTimer]
 * @returns {{ touch: (chunk: unknown, encoding?: string) => void, stop: () => void, readonly stopped: boolean }}
 */
export function startSseKeepAlive({
    write,
    isOpen = () => true,
    intervalMs = keepAliveIntervalMs,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
}) {
    let timer = null;
    let stopped = false;
    let tail = '';

    const arm = () => {
        if (stopped) {
            return;
        }
        if (timer !== null) {
            clearTimer(timer);
        }
        timer = setTimer(fire, intervalMs);
        timer?.unref?.();
    };

    const stop = () => {
        if (stopped) {
            return;
        }
        stopped = true;
        if (timer !== null) {
            clearTimer(timer);
            timer = null;
        }
    };

    const remember = (chunk, encoding) => {
        const text = chunkTail(chunk, encoding);
        if (!text) {
            return false;
        }
        tail = (tail + text).slice(-TAIL_LENGTH);
        return true;
    };

    function fire() {
        timer = null;
        if (stopped) {
            return;
        }
        let open = false;
        try {
            open = isOpen();
        } catch {
            open = false;
        }
        if (!open) {
            stop();
            return;
        }
        if (endsAtEventBoundary(tail)) {
            try {
                write(SSE_KEEP_ALIVE_COMMENT);
            } catch {
                stop();
                return;
            }
            remember(SSE_KEEP_ALIVE_COMMENT);
        }
        arm();
    }

    arm();
    return {
        touch(chunk, encoding) {
            if (!stopped && remember(chunk, encoding)) {
                arm();
            }
        },
        stop,
        get stopped() {
            return stopped;
        },
    };
}

export const testExports = {
    get intervalMs() {
        return keepAliveIntervalMs;
    },
    set intervalMs(value) {
        keepAliveIntervalMs = value;
    },
};
