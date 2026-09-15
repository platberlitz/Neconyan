/**
 * Request guards and error shaping for every plugin route.
 *
 * Two host behaviours drive this file:
 *
 * 1. Neconyan's `express.json({ limit: '500mb' })` and the global
 *    `multer(...).single('avatar')` both run BEFORE plugin routes are mounted
 *    (src/server-main.js:115 and :450). We cannot lower those, so we reject
 *    oversized and non-JSON bodies ourselves.
 * 2. An unhandled rejection anywhere in the process calls exitProcess()
 *    (src/server-main.js:518-537), i.e. one stray async throw in this plugin
 *    takes down the whole app. Every handler therefore goes through wrap().
 */

import { MAX_REQUEST_BYTES } from '../shared/schema.js';

export const LOG_TAG = 'BotSearcher';

/** Raised by http.js. Lives here so guards.js and http.js do not import each other. */
export class UpstreamError extends Error {
    constructor(code, detail) {
        super(code);
        this.name = 'UpstreamError';
        this.code = code;
        this.detail = detail;
    }
}

/**
 * Upstream failure codes the client may see verbatim, because each maps to a
 * distinct, actionable message. Anything else collapses to 'upstream_failed' so
 * an internal detail cannot leak through an error string.
 */
export const SAFE_UPSTREAM_CODES = new Set(['timeout', 'too_large', 'http_error', 'bad_json', 'unsafe_json']);

/**
 * Wraps an async route handler so nothing can escape as an unhandled rejection.
 * This is the only error path: express error middleware would never run, because
 * nothing here calls next(error).
 *
 * @param {(request: any, response: any) => unknown} handler
 * @returns {(request: any, response: any) => void}
 */
export function wrap(handler) {
    return function wrapped(request, response) {
        const disconnected = new AbortController();
        const abort = () => disconnected.abort(new UpstreamError('aborted'));
        const close = () => {
            if (!response.writableFinished) {
                abort();
            }
        };
        request.sbbsSignal = disconnected.signal;
        request.once?.('aborted', abort);
        response.once?.('close', close);
        if (request.aborted || response.destroyed) {
            abort();
        }
        Promise.resolve()
            .then(() => {
                request.sbbsSignal.throwIfAborted();
                return handler(request, response);
            })
            .catch((error) => {
                try {
                    if (request.sbbsSignal.aborted || response.destroyed) {
                        return;
                    }
                    if (error instanceof UpstreamError) {
                        // Log the detail, send only the classification.
                        console.warn(`[${LOG_TAG}] upstream ${error.code}:`, error.detail ?? '');
                        const code = SAFE_UPSTREAM_CODES.has(error.code) ? error.code : 'upstream_failed';
                        if (!response.headersSent) {
                            response.status(502).json({ error: code });
                        }
                        return;
                    }

                    console.error(`[${LOG_TAG}] ${request.method} ${request.path}:`, error?.message ?? error);
                    if (response.headersSent) {
                        response.destroy();
                    } else {
                        // Never echo an upstream body back to the client.
                        response.status(500).json({ error: 'internal_error' });
                    }
                } catch {
                    // Deliberately swallowed: rethrowing here would kill the server.
                }
            })
            .finally(() => {
                request.off?.('aborted', abort);
                response.off?.('close', close);
            });
    };
}

/**
 * Builds a guard that rejects anything which is not a JSON object body within
 * `maxBytes`. Also rejects multipart, which the global multer would otherwise
 * spool to disk.
 *
 * The limit is a parameter because /ingest carries a source's raw response
 * rather than a few query fields. Every other route keeps the small cap: a
 * per-route limit is the point, not an inconvenience.
 *
 * @param {number} maxBytes
 */
export function jsonGuardWithLimit(maxBytes) {
    return function guard(request, response, next) {
        const contentType = String(request.headers['content-type'] ?? '').toLowerCase();

        if (!contentType.startsWith('application/json')) {
            response.status(415).json({ error: 'unsupported_media_type' });
            return;
        }

        const declaredLength = Number(request.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
            response.status(413).json({ error: 'payload_too_large' });
            return;
        }

        const body = request.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            response.status(400).json({ error: 'bad_request' });
            return;
        }

        // Content-Length can be absent or describe compressed bytes. The host
        // already parsed the body, so also enforce the limit on its actual data.
        let length;
        try {
            length = Buffer.byteLength(JSON.stringify(body), 'utf8');
        } catch {
            response.status(400).json({ error: 'bad_request' });
            return;
        }
        if (length > maxBytes) {
            response.status(413).json({ error: 'payload_too_large' });
            return;
        }

        next();
    };
}

/** The default guard, used by every route that takes a small envelope. */
export const jsonGuard = jsonGuardWithLimit(MAX_REQUEST_BYTES);

/**
 * Reads a raw `application/octet-stream` body into `request.rawBody`.
 *
 * The host's parsers cannot help here: express.json and express.urlencoded only
 * claim their own content types and multer only claims multipart, so an
 * octet-stream body reaches plugin routes unread (src/server-main.js:119-120,
 * :454). Reading it here rather than importing express keeps the plugin's
 * production dependencies unchanged, and lets the cap be enforced while the
 * bytes arrive instead of after.
 *
 * @param {number} maxBytes
 */
export function rawGuard(maxBytes) {
    return function guard(request, response, next) {
        const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
        if (!contentType.startsWith('application/octet-stream')) {
            response.status(415).json({ error: 'unsupported_media_type' });
            return;
        }

        const declaredLength = Number(request.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
            response.status(413).json({ error: 'payload_too_large' });
            return;
        }

        const chunks = [];
        let total = 0;
        let settled = false;

        const stop = (status, code) => {
            if (settled) {
                return;
            }
            settled = true;
            request.removeListener('data', onData);
            request.removeListener('end', onEnd);
            request.removeListener('error', onError);
            request.pause?.();
            response.status(status).json({ error: code });
        };

        function onData(chunk) {
            total += chunk.length;
            // Enforced as bytes arrive: a lying Content-Length must not be able
            // to buy an unbounded allocation.
            if (total > maxBytes) {
                stop(413, 'payload_too_large');
                return;
            }
            chunks.push(chunk);
        }

        function onEnd() {
            if (settled) {
                return;
            }
            settled = true;
            request.rawBody = Buffer.concat(chunks, total);
            if (request.rawBody.length === 0) {
                response.status(400).json({ error: 'bad_request' });
                return;
            }
            next();
        }

        function onError() {
            stop(400, 'bad_request');
        }

        request.on('data', onData);
        request.on('end', onEnd);
        request.on('error', onError);
    };
}

/**
 * Sends a machine-readable error. Never includes upstream text.
 * @param {any} response
 * @param {number} status
 * @param {string} code
 * @param {Record<string, unknown>} [extra]
 */
export function fail(response, status, code, extra) {
    if (response.headersSent) {
        return;
    }
    response.status(status).json({ error: code, ...(extra ?? {}) });
}
